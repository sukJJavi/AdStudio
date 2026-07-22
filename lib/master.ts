import { randomUUID } from "crypto";
import { tasks, runs } from "@trigger.dev/sdk/v3";
import { createSessionSupabaseClient } from "@/lib/supabase/server-session";
import { getIABFormatById, type IABFormat } from "@/lib/iab/specs";
import { unblockedFormats } from "@/lib/iab/incident-analyzer";
import { createClaudeClient } from "@/lib/claude/client";
import type { ChangeType, MasterRecord, Project, ProjectFormat, Tier } from "@/lib/types";

const SIGNED_URL_TTL_SECONDS = 600;

/** Ordena los formatos del proyecto por área de canvas descendente, descartando IDs IAB desconocidos. */
export function rankFormatsByArea(
  formats: ProjectFormat[],
): { format: ProjectFormat; spec: IABFormat }[] {
  return formats
    .map((format) => ({ format, spec: getIABFormatById(format.iab_format) }))
    .filter((x): x is { format: ProjectFormat; spec: IABFormat } => x.spec != null)
    .sort((a, b) => b.spec.ancho * b.spec.alto - a.spec.ancho * a.spec.alto);
}

export type TriggerMasterResult =
  | { ok: true; runId: string }
  | { ok: false; status: 400 | 404 | 429; error: string };

export async function triggerMasterGeneration(
  projectId: string,
  options?: { iabFormatId?: string; isPrimary?: boolean },
): Promise<TriggerMasterResult> {
  const supabase = await createSessionSupabaseClient();

  const { data: project, error: projectError } = await supabase
    .from("adstudio_projects")
    .select("status")
    .eq("id", projectId)
    .single();

  if (projectError || !project) {
    return { ok: false, status: 404, error: "Proyecto no encontrado." };
  }

  if (project.status === "master_generating") {
    return { ok: false, status: 429, error: "Job already running" };
  }

  const { data: formats, error: formatsError } = await supabase
    .from("adstudio_formats")
    .select("*")
    .eq("project_id", projectId);

  if (formatsError || !formats || formats.length === 0) {
    return { ok: false, status: 400, error: "El proyecto no tiene formatos definidos en el brief." };
  }

  const unblocked = unblockedFormats(formats as ProjectFormat[]);

  if (unblocked.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "Todos los formatos del plan están bloqueados por incidencias críticas.",
    };
  }

  if (options?.iabFormatId && !unblocked.some((f) => f.iab_format === options.iabFormatId)) {
    return {
      ok: false,
      status: 400,
      error: "El formato indicado no existe o está bloqueado por incidencias críticas.",
    };
  }

  const iabFormatId = options?.iabFormatId ?? rankFormatsByArea(unblocked)[0]?.format.iab_format;

  const handle = await tasks.trigger("render-master", {
    projectId,
    iabFormatId,
    isPrimary: options?.isPrimary ?? true,
  });

  await supabase
    .from("adstudio_projects")
    .update({ status: "master_generating", master_run_id: handle.id })
    .eq("id", projectId);

  return { ok: true, runId: handle.id };
}

export type MasterWithUrls = {
  id: string;
  iabFormat: string;
  width: number;
  height: number;
  jpgSizeBytes: number | null;
  isPrimary: boolean;
  jpgUrl: string | null;
  pngUrl: string | null;
  createdAt: string;
};

export type MasterStatusResponse = {
  projectStatus: Project["status"];
  step: string | null;
  progress: number | null;
  masters: MasterWithUrls[];
  /**
   * true si `adstudio_projects.master_html` tiene contenido — el iframe de preview
   * lo sirve vía `/api/preview/[projectId]` (no signed URL: Supabase Storage añade
   * `Content-Disposition: attachment` a las signed URLs, forzando la descarga en
   * vez de renderizar el HTML en el iframe).
   */
  hasHtml5: boolean;
  /** Peso de `{project_id}/master/master.zip`, para mostrar junto al preview. */
  zipSizeBytes: number | null;
};

export async function getMasterStatus(projectId: string): Promise<MasterStatusResponse | null> {
  const supabase = await createSessionSupabaseClient();

  const { data: project, error: projectError } = await supabase
    .from("adstudio_projects")
    .select("status, master_run_id, master_html")
    .eq("id", projectId)
    .single();

  if (projectError || !project) return null;

  const { data: masterRows } = await supabase
    .from("adstudio_masters")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });

  const masters: MasterWithUrls[] = await Promise.all(
    ((masterRows ?? []) as MasterRecord[]).map(async (m) => {
      const [jpgSigned, pngSigned] = await Promise.all([
        supabase.storage.from("adstudio-projects").createSignedUrl(m.jpg_path, SIGNED_URL_TTL_SECONDS),
        supabase.storage.from("adstudio-projects").createSignedUrl(m.png_path, SIGNED_URL_TTL_SECONDS),
      ]);
      return {
        id: m.id,
        iabFormat: m.iab_format,
        width: m.width,
        height: m.height,
        jpgSizeBytes: m.jpg_size_bytes,
        isPrimary: m.is_primary,
        jpgUrl: jpgSigned.data?.signedUrl ?? null,
        pngUrl: pngSigned.data?.signedUrl ?? null,
        createdAt: m.created_at,
      };
    }),
  );

  let step: string | null = null;
  let progress: number | null = null;

  if (project.status === "master_generating" && project.master_run_id) {
    try {
      const run = await runs.retrieve(project.master_run_id);
      const metadata = run.metadata as Record<string, unknown> | undefined;
      step = typeof metadata?.step === "string" ? metadata.step : null;
      progress = typeof metadata?.progress === "number" ? metadata.progress : null;
    } catch {
      // El run puede no estar disponible todavía (creado hace un instante) o
      // haber expirado del histórico de Trigger.dev; no bloquea la respuesta.
    }
  }

  const { data: masterFolderList } = await supabase.storage.from("adstudio-projects").list(`${projectId}/master`);
  const zipSizeBytes = masterFolderList?.find((f) => f.name === "master.zip")?.metadata?.size ?? null;

  return {
    projectStatus: project.status,
    step,
    progress,
    masters,
    hasHtml5: !!project.master_html,
    zipSizeBytes,
  };
}

/** Rondas de cambios disponibles por tier — ver "Tiers y límites" en CLAUDE.md. `null` = ilimitado. */
const TIER_ROUNDS_LIMIT: Record<Tier, number | null> = {
  starter: 1,
  studio: 3,
  agency: null,
};

/** Tipos de cambio permitidos por tier — ver "Tipos de cambio" en CLAUDE.md. */
const TIER_ALLOWED_CHANGE_TYPES: Record<Tier, ChangeType[]> = {
  starter: ["A", "B"],
  studio: ["A", "B", "C"],
  agency: ["A", "B", "C", "D", "E"],
};

/** El chat de cambios sobre el master (app/api/master/refine) siempre es un cambio tipo C (revisión de master). */
const REFINE_CHANGE_TYPE: ChangeType = "C";

const REFINE_SYSTEM_PROMPT = `Eres un experto en producción de publicidad digital HTML5.
Recibes el código HTML5 de un banner publicitario y una descripción de un cambio a aplicar.
Devuelve SOLO el HTML completo modificado, sin explicaciones, sin markdown, comenzando con <!doctype html>.
Modifica ÚNICAMENTE lo que se pide. No cambies nada más.`;

/** Quita el fence ```html ... ``` si Claude lo añade a pesar de la instrucción de no hacerlo. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

export type MasterChangeEntry = {
  id: string;
  description: string | null;
  requestedAt: string;
};

/** Historial de cambios aplicados sobre el master (tipo C), más recientes primero. */
export async function getMasterChanges(projectId: string): Promise<MasterChangeEntry[]> {
  const supabase = await createSessionSupabaseClient();

  const { data } = await supabase
    .from("adstudio_changes")
    .select("id, description, requested_at")
    .eq("project_id", projectId)
    .eq("type", REFINE_CHANGE_TYPE)
    .order("requested_at", { ascending: false });

  return (data ?? []).map((row) => ({
    id: row.id as string,
    description: row.description as string | null,
    requestedAt: row.requested_at as string,
  }));
}

export type RefineMasterResult =
  | { ok: true; change: MasterChangeEntry }
  | { ok: false; status: 400 | 403 | 404 | 502; error: string };

/**
 * Aplica un cambio en lenguaje natural sobre el HTML5 del master vía Claude
 * (chat de cambios, "Opción A" — ver components/project/master-view.tsx).
 * Sobreescribe `adstudio_projects.master_html` y registra el cambio como tipo
 * 'C' (revisión de master) en adstudio_changes.
 */
export async function refineMasterHtml(projectId: string, changeDescription: string): Promise<RefineMasterResult> {
  const supabase = await createSessionSupabaseClient();

  const { data: project, error: projectError } = await supabase
    .from("adstudio_projects")
    .select("master_html, user_id")
    .eq("id", projectId)
    .single();

  if (projectError || !project) {
    return { ok: false, status: 404, error: "Proyecto no encontrado." };
  }

  if (!project.master_html) {
    return { ok: false, status: 400, error: "Todavía no hay un master generado para aplicar cambios." };
  }

  // El tier/rondas autoritativo es la suscripción DEL USUARIO AUTENTICADO
  // (adstudio_subscriptions), no `adstudio_projects.tier` — ese campo es solo
  // un snapshot tomado al crear el proyecto y no se actualiza si el usuario
  // cambia de plan después. Bug previo: se leía ese snapshot y quedaba
  // desincronizado con la suscripción real del usuario.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const userId = user?.id ?? (project.user_id as string);
  console.log("User ID:", userId);

  const { data: subscription, error: subscriptionError } = await supabase
    .from("adstudio_subscriptions")
    .select("tier, rounds_limit")
    .eq("user_id", userId)
    .maybeSingle();

  console.log("Subscription query result:", { data: subscription, error: subscriptionError });
  console.log("Tier check:", subscription?.tier);

  // Sin fila de suscripción (p. ej. cuentas antiguas o el registro del trial
  // todavía no se creó) -> no bloquear con 403: usar los límites por defecto
  // del tier 'starter' en vez de tratar al usuario como sin acceso. El 403
  // por plan solo debe darse si SÍ hay suscripción y su tier no incluye esto.
  const tier = (subscription?.tier as Tier | undefined) ?? "starter";
  const roundsLimit = subscription ? subscription.rounds_limit : TIER_ROUNDS_LIMIT.starter;

  if (!TIER_ALLOWED_CHANGE_TYPES[tier].includes(REFINE_CHANGE_TYPE)) {
    return {
      ok: false,
      status: 403,
      error: "Tu plan no incluye cambios de revisión de master. Mejora tu plan para usar esta función.",
    };
  }

  const { count: changesCount } = await supabase
    .from("adstudio_changes")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("type", REFINE_CHANGE_TYPE);

  console.log("Rounds check:", roundsLimit, "changes used:", changesCount);

  if (roundsLimit != null && (changesCount ?? 0) >= roundsLimit) {
    return {
      ok: false,
      status: 403,
      error: `Has agotado las ${roundsLimit} ronda${roundsLimit === 1 ? "" : "s"} de cambios de tu plan.`,
    };
  }

  const client = createClaudeClient();
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8000,
    system: REFINE_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `HTML actual:\n${project.master_html}\n\nCambio a aplicar: ${changeDescription}`,
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
  const html = stripCodeFence(raw);

  if (!html) {
    return { ok: false, status: 502, error: "Claude no devolvió un HTML válido." };
  }

  await supabase.from("adstudio_projects").update({ master_html: html }).eq("id", projectId);

  const { data: changeRow, error: changeError } = await supabase
    .from("adstudio_changes")
    .insert({
      project_id: projectId,
      type: REFINE_CHANGE_TYPE,
      description: changeDescription,
      status: "completed",
    })
    .select("id, description, requested_at")
    .single();

  if (changeError || !changeRow) {
    console.error("Error insertando adstudio_changes:", changeError);
    return {
      ok: true,
      change: { id: randomUUID(), description: changeDescription, requestedAt: new Date().toISOString() },
    };
  }

  return {
    ok: true,
    change: {
      id: changeRow.id as string,
      description: changeRow.description as string | null,
      requestedAt: changeRow.requested_at as string,
    },
  };
}
