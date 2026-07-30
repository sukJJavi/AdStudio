import type { SupabaseClient } from "@supabase/supabase-js";
import { createClaudeClient } from "@/lib/claude/client";
import { ensureAdBorder, sanitizeHtml, stripCodeFence } from "@/lib/render/html5-generator";
import { REFINE_SYSTEM_PROMPT, TIER_ALLOWED_CHANGE_TYPES, TIER_ROUNDS_LIMIT, type MasterChangeEntry } from "@/lib/master";
import { downloadAsset } from "@/lib/render/assets";
import { exportFilenameFor } from "@/lib/render/export-format";
import { renderAdaptationFallbackJpg } from "@/lib/render/adaptation-fallback";
import type { ChangeType, ProjectAsset, TextLayerMetadata, Tier } from "@/lib/types";

/** El chat de cambios sobre una adaptación siempre es un cambio tipo C (revisión), igual que sobre el master principal. */
const REFINE_CHANGE_TYPE: ChangeType = "C";

export class AdaptationRefineError extends Error {
  status: 400 | 403 | 404 | 502;

  constructor(status: 400 | 403 | 404 | 502, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Regenera el fallback.jpg de un borrador Nivel 2 tras un cambio por chat —
 * "hermana" de lib/master.ts:regenerateMasterFallback. Los assets se
 * descargan de `{projectId}/adaptations/{formatId}/{filename}` (no del PSD
 * original): esa carpeta ya tiene, por formato, el fondo/imagen_principal
 * reencuadrado con FLUX que persiste trigger/render-adaptations.ts — usar el
 * PSD original perdería ese reencuadre. Best-effort: un fallo aquí no debe
 * deshacer el cambio de HTML ya guardado.
 */
async function regenerateAdaptationFallback(
  projectId: string,
  formatId: string,
  iabFormat: string,
  width: number,
  height: number,
  html: string,
  supabase: SupabaseClient,
): Promise<void> {
  try {
    const { data: assetRows } = await supabase.from("adstudio_assets").select("*").eq("project_id", projectId);
    const allAssets = (assetRows ?? []) as ProjectAsset[];

    const assetBuffers = new Map<string, Buffer>();
    for (const asset of allAssets) {
      if (asset.discarded) continue;
      const filename = (asset.metadata as TextLayerMetadata | undefined)?.filename;
      if (!filename) continue;
      const exported = exportFilenameFor(filename, !!asset.export_as_jpg);
      const buffer = await downloadAsset(supabase, `${projectId}/adaptations/${formatId}/${exported}`);
      if (buffer) assetBuffers.set(exported, buffer);
    }

    const fallbackJpg = await renderAdaptationFallbackJpg(html, { width, height }, assetBuffers);
    const fallbackPath = `${projectId}/adaptations/${iabFormat}/fallback.jpg`;

    await Promise.all([
      supabase.storage
        .from("adstudio-projects")
        .upload(fallbackPath, fallbackJpg, { contentType: "image/jpeg", upsert: true }),
      supabase.from("adstudio_masters").update({ jpg_size_bytes: fallbackJpg.byteLength }).eq("project_id", projectId).eq("format_id", formatId),
    ]);
  } catch (err) {
    console.error("No se pudo regenerar fallback.jpg tras refineAdaptationHtml:", err);
  }
}

/**
 * "Hermana" de lib/master.ts:refineMasterHtml — misma lógica de tier/rondas y
 * llamada a Claude, pero aplicada al borrador de una adaptación Nivel 2
 * (adstudio_masters, status='draft', ver trigger/render-adaptations.ts) en
 * vez de a adstudio_projects.master_html. Además de actualizar la fila,
 * re-sube el HTML a Storage en la misma ruta que ya sirve
 * app/api/preview/[projectId]/adaptation/[formatId] — si no, el iframe de
 * revisión seguiría mostrando el HTML anterior al cambio.
 */
export async function refineAdaptationHtml(
  projectId: string,
  formatId: string,
  changeDescription: string,
  userId: string,
  supabase: SupabaseClient,
): Promise<{ html: string }> {
  const { data: masterRow, error: masterError } = await supabase
    .from("adstudio_masters")
    .select("id, html, iab_format, width, height")
    .eq("project_id", projectId)
    .eq("format_id", formatId)
    .maybeSingle();

  if (masterError || !masterRow || !masterRow.html) {
    throw new AdaptationRefineError(404, "Todavía no hay un borrador generado para este formato.");
  }

  const { data: subscription } = await supabase
    .from("adstudio_subscriptions")
    .select("tier, rounds_limit")
    .eq("user_id", userId)
    .maybeSingle();

  const tier = (subscription?.tier as Tier | undefined) ?? "starter";
  const roundsLimit = subscription ? subscription.rounds_limit : TIER_ROUNDS_LIMIT.starter;

  if (!TIER_ALLOWED_CHANGE_TYPES[tier].includes(REFINE_CHANGE_TYPE)) {
    throw new AdaptationRefineError(
      403,
      "Tu plan no incluye cambios de revisión de adaptaciones. Mejora tu plan para usar esta función.",
    );
  }

  const { count: changesCount } = await supabase
    .from("adstudio_changes")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("format_id", formatId)
    .eq("type", REFINE_CHANGE_TYPE);

  if (roundsLimit != null && (changesCount ?? 0) >= roundsLimit) {
    throw new AdaptationRefineError(
      403,
      `Has agotado las ${roundsLimit} ronda${roundsLimit === 1 ? "" : "s"} de cambios de tu plan.`,
    );
  }

  const client = createClaudeClient();
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8000,
    system: REFINE_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `HTML actual:\n${masterRow.html}\n\nCambio a aplicar: ${changeDescription}`,
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
  const html = ensureAdBorder(sanitizeHtml(stripCodeFence(raw)));

  if (!html) {
    throw new AdaptationRefineError(502, "Claude no devolvió un HTML válido.");
  }

  await supabase.from("adstudio_masters").update({ html }).eq("id", masterRow.id);

  // El iframe de revisión (app/api/preview/[projectId]/adaptation/[formatId])
  // sirve el index.html de Storage, no la fila de adstudio_masters — hay que
  // mantener ambos en sync o el cambio no se vería reflejado en el preview.
  await supabase.storage
    .from("adstudio-projects")
    .upload(`${projectId}/adaptations/${masterRow.iab_format}/index.html`, html, {
      contentType: "text/html",
      upsert: true,
    });

  await regenerateAdaptationFallback(
    projectId,
    formatId,
    masterRow.iab_format as string,
    masterRow.width as number,
    masterRow.height as number,
    html,
    supabase,
  );

  await supabase.from("adstudio_changes").insert({
    project_id: projectId,
    format_id: formatId,
    type: REFINE_CHANGE_TYPE,
    description: changeDescription,
    status: "completed",
  });

  return { html };
}

/** Historial de cambios aplicados sobre el borrador de una adaptación, más recientes primero. */
export async function getAdaptationChanges(
  projectId: string,
  formatId: string,
  supabase: SupabaseClient,
): Promise<MasterChangeEntry[]> {
  const { data } = await supabase
    .from("adstudio_changes")
    .select("id, description, requested_at")
    .eq("project_id", projectId)
    .eq("format_id", formatId)
    .eq("type", REFINE_CHANGE_TYPE)
    .order("requested_at", { ascending: false });

  return (data ?? []).map((row) => ({
    id: row.id as string,
    description: row.description as string | null,
    requestedAt: row.requested_at as string,
  }));
}

export type AdaptationDraft = { html: string; width: number; height: number } | null;

/** Borrador Nivel 2 de un formato (ver trigger/render-adaptations.ts) — null si el formato es Nivel 1 o todavía no se produjo. */
export async function getAdaptationDraft(
  projectId: string,
  formatId: string,
  supabase: SupabaseClient,
): Promise<AdaptationDraft> {
  const { data } = await supabase
    .from("adstudio_masters")
    .select("html, width, height")
    .eq("project_id", projectId)
    .eq("format_id", formatId)
    .eq("status", "draft")
    .maybeSingle();

  if (!data?.html) return null;

  return { html: data.html, width: data.width, height: data.height };
}
