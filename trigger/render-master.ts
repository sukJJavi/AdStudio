import { task, metadata } from "@trigger.dev/sdk/v3";
import { createTriggerSupabaseClient } from "@/lib/supabase/trigger-client";
import { fontFamilyStack } from "@/lib/fonts";
import { splitCopy } from "@/lib/render/copy";
import { selectClassifiedAssets, downloadAsset } from "@/lib/render/assets";
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
 * Dimensiones del canvas de un PSD concreto (Bloque 15 — cada PSD es un
 * master independiente): primero su propia metadata (psdWidth/psdHeight, ver
 * trigger/analyze-psd.ts), con fallback a las dimensiones a nivel proyecto
 * (psd_width/psd_height) para PSDs analizados antes de que existiera ese
 * campo por-asset. `null` si no hay ninguna de las dos.
 */
function psdDimensions(
  psdAsset: ProjectAsset,
  project: { psd_width: number | null; psd_height: number | null },
): { ancho: number; alto: number } | null {
  const metadata = psdAsset.metadata as { psdWidth?: number | null; psdHeight?: number | null } | undefined;
  const ancho = metadata?.psdWidth ?? project.psd_width ?? null;
  const alto = metadata?.psdHeight ?? project.psd_height ?? null;
  return ancho && alto ? { ancho, alto } : null;
}

/** Identificador sintético (no un IAB real) para un master sin formato del plan asociado explícitamente. */
function syntheticIabFormat(psdAsset: ProjectAsset, dims: { ancho: number; alto: number }): string {
  return `custom_${dims.ancho}x${dims.alto}_${psdAsset.id.slice(0, 8)}`;
}

/**
 * Genera y sube el master (JPG/PNG/HTML5 + ZIP) de un único PSD, a partir del
 * subconjunto de capas (`assets`) que le corresponde. Bloque 15: cada PSD
 * subido es un master independiente, identificado por `sourcePsdId` — ya no
 * hay un único "master del proyecto"; `isPrimary` solo decide cuál de todos
 * alimenta `adstudio_projects.master_html` (preview principal, chat de
 * cambios del master y link de aprobación al cliente, que siguen operando a
 * nivel de proyecto, ver CLAUDE.md).
 */
async function renderOneMaster(params: {
  projectId: string;
  sourcePsdId: string;
  spec: { ancho: number; alto: number };
  iabFormat: string;
  copy: string | null;
  clickTagUrl: string;
  /** id real de adstudio_formats cuyo status marcar 'ready' al terminar — null si no hay un formato del plan asociado explícitamente a este PSD. */
  driverFormatId: string | null;
  assets: ProjectAsset[];
  fontPrimary: string;
  isPrimary: boolean;
  supabase: SupabaseClient;
}): Promise<void> {
  const {
    projectId,
    sourcePsdId,
    spec,
    iabFormat,
    copy,
    clickTagUrl,
    driverFormatId,
    assets,
    fontPrimary,
    isPrimary,
    supabase,
  } = params;

  const storageFolder = `masters/${sourcePsdId}`;

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

  const { claim, subclaim, disclaimer } = splitCopy(copy);
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

  const { html, assetFilenames } = await generateHtml5Master(
    projectId,
    { width: spec.ancho, height: spec.alto, iabFormat },
    assets,
    animationGuide,
    clickTagUrl,
    supabase,
  );

  // El master primario alimenta adstudio_projects.master_html — preview
  // principal (/api/preview/[projectId]), chat de cambios (lib/master.ts:
  // refineMasterHtml) y link de aprobación al cliente siguen operando a nivel
  // de proyecto sobre ESTE master. El resto de PSDs guarda su HTML solo en su
  // propia fila de adstudio_masters (ver más abajo), sin tocar este campo.
  if (isPrimary) {
    await saveHtml5Master(projectId, html, supabase);
  }

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

  const basePath = `${projectId}/${storageFolder}/${iabFormat}`;
  const folder = `${projectId}/${storageFolder}`;
  // El HTML5 ya NO se sirve desde Storage (las signed URLs de Supabase Storage
  // añaden `Content-Disposition: attachment`, forzando la descarga en vez de
  // renderizar en el iframe) — el master primario se sirve desde
  // adstudio_projects.master_html (ver saveHtml5Master arriba); todos (incluido
  // el primario) también quedan en adstudio_masters.html para su propio preview
  // por PSD (app/api/preview/[projectId]/master/[psdId]). Aquí solo queda el
  // `.html` suelto por PSD, para quien descargue del Storage directamente.
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
      iab_format: iabFormat,
      format_id: driverFormatId,
      source_psd_id: sourcePsdId,
      jpg_path: `${basePath}.jpg`,
      png_path: `${basePath}.png`,
      width: spec.ancho,
      height: spec.alto,
      jpg_size_bytes: jpgBuffer.byteLength,
      is_primary: isPrimary,
      html,
      status: "ready",
    },
    { onConflict: "project_id,source_psd_id" },
  );

  if (driverFormatId) {
    await supabase.from("adstudio_formats").update({ status: "ready" }).eq("id", driverFormatId);
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
      supabase
        .from("adstudio_projects")
        .select("font_primary, psd_width, psd_height")
        .eq("id", payload.projectId)
        .single(),
    ]);

    const allAssets = (assets ?? []) as ProjectAsset[];
    const allFormats = (formats ?? []) as ProjectFormat[];
    const fontPrimary = project?.font_primary ?? "Inter";
    const projectPsdDims = { psd_width: project?.psd_width ?? null, psd_height: project?.psd_height ?? null };

    const psdAssets = allAssets.filter((a) => a.layer_type === "psd");

    if (psdAssets.length === 0) {
      throw new Error("El proyecto no tiene ningún PSD subido.");
    }

    console.log(
      "PSDs encontrados para master:",
      psdAssets.map((p) => ({
        id: p.id,
        name: p.layer_name,
        width: (p.metadata as TextLayerMetadata | undefined)?.psdWidth,
        height: (p.metadata as TextLayerMetadata | undefined)?.psdHeight,
      })),
    );

    metadata.set("step", "seleccionando-formato");
    metadata.set("progress", 0.1);

    // Regeneración puntual de UN master concreto — "Regenerar master" /
    // "Generar segunda variante" en components/project/master-view.tsx.
    // payload.iabFormatId identifica el adstudio_formats.iab_format a
    // regenerar; su PSD asociado (source_psd_id) es el master-base, o el
    // primer PSD subido si no tiene ninguno asociado explícitamente.
    if (payload.iabFormatId) {
      const format = allFormats.find((f) => f.iab_format === payload.iabFormatId);
      if (!format) {
        throw new Error("El formato indicado no existe en este proyecto.");
      }

      const psdAsset = (format.source_psd_id && psdAssets.find((p) => p.id === format.source_psd_id)) || psdAssets[0];
      const dims = psdDimensions(psdAsset, projectPsdDims);

      if (!dims) {
        throw new Error("No se pudieron determinar las dimensiones del PSD para este formato.");
      }

      const scopedAssets = allAssets.filter((a) => a.source_psd_id === psdAsset.id);

      metadata.set("step", "descargando-assets-y-fuente");
      metadata.set("progress", 0.25);

      await renderOneMaster({
        projectId: payload.projectId,
        sourcePsdId: psdAsset.id,
        spec: dims,
        iabFormat: format.iab_format,
        copy: format.copy,
        clickTagUrl: format.url_destino ?? "",
        driverFormatId: format.id,
        assets: scopedAssets,
        fontPrimary,
        isPrimary: payload.isPrimary ?? false,
        supabase,
      });

      metadata.set("step", "completado");
      metadata.set("progress", 1);

      await supabase
        .from("adstudio_projects")
        .update({ status: "master_ready", master_run_id: null })
        .eq("id", payload.projectId);

      return { projectId: payload.projectId, iabFormat: format.iab_format };
    }

    // Generación completa: un master INDEPENDIENTE por cada PSD subido
    // (Bloque 15) — ya no solo el marcado is_master o el de mayor área.
    const masterFormat = allFormats.find((f) => f.is_master) ?? null;
    const primaryPsdId =
      (masterFormat?.source_psd_id && psdAssets.some((p) => p.id === masterFormat.source_psd_id)
        ? masterFormat.source_psd_id
        : null) ?? psdAssets[0].id;

    let producedAny = false;

    for (let i = 0; i < psdAssets.length; i++) {
      const psdAsset = psdAssets[i];

      console.log(`Generando master para PSD ${psdAsset.layer_name} (${i + 1}/${psdAssets.length})`);

      metadata.set("step", `generando-master-psd-${i + 1}-de-${psdAssets.length}`);
      metadata.set("progress", i / psdAssets.length);

      const dims = psdDimensions(psdAsset, projectPsdDims);
      if (!dims) {
        console.error(`No se pudieron determinar las dimensiones del PSD ${psdAsset.id}, se omite su master.`);
        continue;
      }

      // El "formato conductor" (driver) de este PSD es el que el usuario
      // asoció explícitamente en el brief (Bloque 11) — aporta copy/clickTag/
      // nombre IAB real. Sin asociación explícita, el master se genera igual
      // (Bloque 15: cada PSD es un master, tenga o no un formato del plan
      // vinculado), con copy vacío y un identificador sintético.
      const driverFormat = allFormats.find((f) => f.source_psd_id === psdAsset.id) ?? null;
      const iabFormat = driverFormat?.iab_format ?? syntheticIabFormat(psdAsset, dims);
      const scopedAssets = allAssets.filter((a) => a.source_psd_id === psdAsset.id && !a.discarded);

      if (scopedAssets.length === 0) {
        console.warn(`El PSD ${psdAsset.layer_name} (${psdAsset.id}) no tiene capas no descartadas, se omite su master.`);
        continue;
      }

      await renderOneMaster({
        projectId: payload.projectId,
        sourcePsdId: psdAsset.id,
        spec: dims,
        iabFormat,
        copy: driverFormat?.copy ?? null,
        clickTagUrl: driverFormat?.url_destino ?? "",
        driverFormatId: driverFormat?.id ?? null,
        assets: scopedAssets,
        fontPrimary,
        isPrimary: psdAsset.id === primaryPsdId,
        supabase,
      });

      producedAny = true;
    }

    if (!producedAny) {
      throw new Error("Ningún PSD del proyecto tiene dimensiones válidas para generar su master.");
    }

    metadata.set("step", "completado");
    metadata.set("progress", 1);

    await supabase
      .from("adstudio_projects")
      .update({ status: "master_ready", master_run_id: null })
      .eq("id", payload.projectId);

    return { projectId: payload.projectId, psds: psdAssets.length };
  },
});
