import { task, metadata } from "@trigger.dev/sdk/v3";
import { createTriggerSupabaseClient } from "@/lib/supabase/trigger-client";
import { getIABFormatById, type IABFormat } from "@/lib/iab/specs";
import { fontFamilyStack } from "@/lib/fonts";
import { splitCopy } from "@/lib/render/copy";
import { pickLargestBy, selectClassifiedAssets, downloadAsset } from "@/lib/render/assets";
import { loadGoogleFontWithFallback } from "@/lib/render/font-loader";
import { renderBannerToPng } from "@/lib/render/jpg-renderer";
import { renderFallbackFromFrame } from "@/lib/render/fallback-composite";
import { generateHtml5Master } from "@/lib/render/html5-generator";
import { saveHtml5Master } from "@/lib/render/html5-cache";
import { readAnimationGuideText } from "@/lib/render/animation-guide";
import { exportBufferFor, exportFilenameFor } from "@/lib/render/export-format";
import { buildZipBuffer, type ZipFileEntry } from "@/lib/export/zip";
import type { ProjectAsset, ProjectFormat, TextLayerMetadata } from "@/lib/types";
import type { SupabaseClient } from "@supabase/supabase-js";

type RenderMasterPayload = {
  projectId: string;
  iabFormatId?: string;
  isPrimary?: boolean;
};

function toBase64(buffer: Buffer | null): string | undefined {
  return buffer ? buffer.toString("base64") : undefined;
}

/** `adstudio_assets.metadata.filename` — nombre de fichero asignado en trigger/analyze-psd.ts. */
function assetFilename(asset: ProjectAsset): string | null {
  const filename = (asset.metadata as TextLayerMetadata | undefined)?.filename;
  return typeof filename === "string" && filename.trim() ? filename : null;
}

/**
 * Genera y sube el master (JPG/PNG/HTML5 + ZIP) de un único formato, a
 * partir del subconjunto de capas (`assets`) que le corresponde. Con un
 * único PSD en el proyecto, `assets` es simplemente `allAssets` y el
 * resultado sube a `{project_id}/master/{iab_format}...` como siempre. Con
 * varios PSDs (Bloque 11), cada formato con `source_psd_id` llama a esto
 * con solo sus propias capas y sube a `{project_id}/masters/{format_id}/...`.
 */
async function renderOneMaster(params: {
  projectId: string;
  format: ProjectFormat;
  spec: IABFormat;
  assets: ProjectAsset[];
  fontPrimary: string;
  isPrimary: boolean;
  supabase: SupabaseClient;
  /** Carpeta de Storage donde subir: 'master' (flujo de un único PSD) o 'masters/{format.id}' (multi-PSD). */
  storageFolder: string;
}): Promise<void> {
  const { projectId, format, spec, assets, fontPrimary, isPrimary, supabase, storageFolder } = params;

  const { byClassification } = selectClassifiedAssets(assets);

  const fondoAsset = byClassification("fondo");
  const imagenPrincipalAsset = byClassification("imagen_principal");
  const logoAsset = byClassification("logo");

  const [fondoBuffer, imagenPrincipalBuffer, logoBuffer, fontRegular, fontBold] = await Promise.all([
    downloadAsset(supabase, fondoAsset?.file_path ?? null),
    downloadAsset(supabase, imagenPrincipalAsset?.file_path ?? null),
    downloadAsset(supabase, logoAsset?.file_path ?? null),
    // Fix 3: nunca bloquea el render — si la tipografía detectada del PSD no
    // existe en Google Fonts, cae a Inter (ver lib/render/font-loader.ts).
    loadGoogleFontWithFallback(fontPrimary, 400),
    loadGoogleFontWithFallback(fontPrimary, 700),
  ]);

  const logoAspectRatio =
    logoAsset?.width && logoAsset?.height && logoAsset.height > 0 ? logoAsset.width / logoAsset.height : null;

  const { claim, subclaim, disclaimer } = splitCopy(format.copy ?? null);
  const fontFamily = fontFamilyStack(fontPrimary);

  const bannerElements = {
    width: spec.ancho,
    height: spec.alto,
    backgroundColor: "#FFFFFF",
    backgroundImageBase64: toBase64(fondoBuffer),
    logoBase64: toBase64(logoBuffer),
    logoAspectRatio,
    mainImageBase64: toBase64(imagenPrincipalBuffer),
    claim,
    subclaim,
    cta: claim,
    disclaimer,
    fontFamily,
    fontBase64: fontRegular.toString("base64"),
    fontBoldBase64: fontBold.toString("base64"),
  };

  const [jpgBuffer, pngBuffer] = await Promise.all([
    // Fix 2: el fallback.jpg se compone con las capas reales del último frame
    // que contiene el CTA (+ persistentes), no un render de Satori desde cero.
    renderFallbackFromFrame(projectId, { width: spec.ancho, height: spec.alto }, assets, supabase),
    renderBannerToPng(bannerElements),
  ]);

  const animationGuide = await readAnimationGuideText(assets, supabase);
  const clickTagUrl = format.url_destino ?? "";

  const { html, assetFilenames } = await generateHtml5Master(
    projectId,
    { width: spec.ancho, height: spec.alto, iabFormat: format.iab_format },
    assets,
    animationGuide,
    clickTagUrl,
    supabase,
  );

  await saveHtml5Master(projectId, html, supabase);

  // Fix 3: el nombre "lógico" (con la extensión correcta) es la clave — el PNG
  // original en Storage nunca cambia de nombre/formato; la conversión a JPG
  // (si export_as_jpg) ocurre aquí, al construir el ZIP.
  const filenameToAsset = new Map<string, ProjectAsset>();
  for (const asset of assets) {
    const pngFilename = assetFilename(asset);
    if (!pngFilename || !asset.file_path) continue;
    filenameToAsset.set(exportFilenameFor(pngFilename, !!asset.export_as_jpg), asset);
  }

  const pngEntries = (
    await Promise.all(
      assetFilenames.map(async (filename) => {
        const asset = filenameToAsset.get(filename);
        if (!asset?.file_path) return null;
        const buffer = await downloadAsset(supabase, asset.file_path);
        if (!buffer) return null;
        const exported = await exportBufferFor(buffer, !!asset.export_as_jpg);
        return { filename, buffer: exported };
      }),
    )
  ).filter((entry): entry is { filename: string; buffer: Buffer } => entry != null);

  const zipEntries: ZipFileEntry[] = [
    { path: "index.html", content: html },
    ...pngEntries.map((entry) => ({ path: entry.filename, content: entry.buffer })),
    { path: "fallback.jpg", content: jpgBuffer },
  ];

  const zipBuffer = await buildZipBuffer(zipEntries);

  const basePath = `${projectId}/${storageFolder}/${format.iab_format}`;
  const folder = `${projectId}/${storageFolder}`;
  // El HTML5 ya NO se sirve desde Storage (las signed URLs de Supabase Storage
  // añaden `Content-Disposition: attachment`, forzando la descarga en vez de
  // renderizar en el iframe) — se sirve desde adstudio_projects.master_html
  // (ver saveHtml5Master arriba) vía app/api/preview/[projectId]/route.ts.
  // Aquí solo queda el `.html` suelto por formato, para quien descargue del
  // Storage directamente fuera de la app.
  const htmlBuffer = Buffer.from(html, "utf-8");

  await Promise.all([
    supabase.storage
      .from("adstudio-projects")
      .upload(`${basePath}.jpg`, jpgBuffer, { contentType: "image/jpeg", upsert: true }),
    supabase.storage
      .from("adstudio-projects")
      .upload(`${basePath}.png`, pngBuffer, { contentType: "image/png", upsert: true }),
    supabase.storage
      .from("adstudio-projects")
      .upload(`${basePath}.html`, htmlBuffer, { contentType: "text/html", upsert: true }),
    supabase.storage
      .from("adstudio-projects")
      .upload(`${folder}/master.zip`, zipBuffer, {
        contentType: "application/zip",
        upsert: true,
      }),
  ]);

  if (isPrimary) {
    await supabase.from("adstudio_masters").update({ is_primary: false }).eq("project_id", projectId);
  }

  await supabase.from("adstudio_masters").upsert(
    {
      project_id: projectId,
      iab_format: format.iab_format,
      format_id: format.id,
      jpg_path: `${basePath}.jpg`,
      png_path: `${basePath}.png`,
      width: spec.ancho,
      height: spec.alto,
      jpg_size_bytes: jpgBuffer.byteLength,
      is_primary: isPrimary,
    },
    { onConflict: "project_id,iab_format" },
  );

  // Con PSD propio (multi-PSD), este formato ya está producido — no pasa por
  // trigger/render-adaptations.ts (ver cropTargets ahí).
  if (format.source_psd_id) {
    await supabase.from("adstudio_formats").update({ status: "ready" }).eq("id", format.id);
  }
}

export const renderMaster = task({
  id: "render-master",
  run: async (payload: RenderMasterPayload) => {
    const supabase = createTriggerSupabaseClient();

    metadata.set("step", "leyendo-assets");
    metadata.set("progress", 0);

    const [{ data: assets }, { data: formats }, { data: project }] = await Promise.all([
      supabase.from("adstudio_assets").select("*").eq("project_id", payload.projectId),
      supabase.from("adstudio_formats").select("*").eq("project_id", payload.projectId),
      supabase.from("adstudio_projects").select("font_primary").eq("id", payload.projectId).single(),
    ]);

    const allAssets = (assets ?? []) as ProjectAsset[];
    const allFormats = (formats ?? []) as ProjectFormat[];
    const fontPrimary = project?.font_primary ?? "Inter";

    metadata.set("step", "seleccionando-formato");
    metadata.set("progress", 0.1);

    // Bloque 11: formatos con PSD propio (proyecto con varios PSDs
    // independientes) — cada uno genera su propio master a partir solo de
    // sus capas. Si el caller pide un formato explícito (variante manual
    // desde master-view.tsx) se respeta esa petición puntual en vez de
    // regenerar todos los masters con PSD.
    const formatsWithPsd = allFormats.filter((f) => f.source_psd_id);

    if (!payload.iabFormatId && formatsWithPsd.length > 1) {
      let producedAny = false;
      for (let i = 0; i < formatsWithPsd.length; i++) {
        const format = formatsWithPsd[i];
        const spec = getIABFormatById(format.iab_format);
        if (!spec) continue;

        metadata.set("step", `generando-master-${format.iab_format}`);
        metadata.set("progress", i / formatsWithPsd.length);

        const scopedAssets = allAssets.filter((a) => a.source_psd_id === format.source_psd_id);

        await renderOneMaster({
          projectId: payload.projectId,
          format,
          spec,
          assets: scopedAssets,
          fontPrimary,
          isPrimary: format.is_master,
          supabase,
          storageFolder: `masters/${format.id}`,
        });
        producedAny = true;
      }

      if (!producedAny) {
        throw new Error("Ninguno de los formatos con PSD propio tiene especificación IAB válida.");
      }

      metadata.set("step", "completado");
      metadata.set("progress", 1);

      await supabase
        .from("adstudio_projects")
        .update({ status: "master_ready", master_run_id: null })
        .eq("id", payload.projectId);

      return { projectId: payload.projectId, iabFormat: formatsWithPsd.map((f) => f.iab_format).join(",") };
    }

    // Caso actual (un único PSD, o generación puntual de un formato/variante
    // concreto pedida por payload.iabFormatId): comportamiento idéntico al de
    // antes de Bloque 11.
    const formatsWithSpec = pickLargestBy(
      allFormats
        .map((format) => ({ format, spec: getIABFormatById(format.iab_format) }))
        .filter((x): x is { format: ProjectFormat; spec: IABFormat } => x.spec != null),
      (x) => x.spec.ancho * x.spec.alto,
    );

    // El formato master es el marcado explícitamente por el usuario en el brief
    // (adstudio_formats.is_master, ver app/project/[id]/brief) — solo si ninguno
    // está marcado (planes creados antes de este campo) se cae al de mayor área.
    const masterFlagged = formatsWithSpec.find((x) => x.format.is_master);
    const selected = payload.iabFormatId
      ? (formatsWithSpec.find((x) => x.format.iab_format === payload.iabFormatId) ?? formatsWithSpec[0])
      : (masterFlagged ?? formatsWithSpec[0]);

    if (!selected) {
      throw new Error("El proyecto no tiene formatos con especificación IAB válida.");
    }

    const { format, spec } = selected;

    // Si este formato tiene un PSD propio (único PSD del proyecto asociado a
    // él, o generación puntual de un formato con PSD), sus capas son las que
    // comparten ese source_psd_id; si no, se usan todas (comportamiento
    // histórico de un único PSD sin asociar explícitamente).
    const scopedAssets = format.source_psd_id
      ? allAssets.filter((a) => a.source_psd_id === format.source_psd_id)
      : allAssets;

    metadata.set("step", "descargando-assets-y-fuente");
    metadata.set("progress", 0.25);

    await renderOneMaster({
      projectId: payload.projectId,
      format,
      spec,
      assets: scopedAssets,
      fontPrimary,
      isPrimary: payload.isPrimary ?? false,
      supabase,
      storageFolder: "master",
    });

    metadata.set("step", "completado");
    metadata.set("progress", 1);

    await supabase
      .from("adstudio_projects")
      .update({ status: "master_ready", master_run_id: null })
      .eq("id", payload.projectId);

    return { projectId: payload.projectId, iabFormat: format.iab_format };
  },
});
