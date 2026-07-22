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
import { buildZipBuffer, type ZipFileEntry } from "@/lib/export/zip";
import type { ProjectAsset, ProjectFormat, TextLayerMetadata } from "@/lib/types";

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
    const { byClassification } = selectClassifiedAssets(allAssets);

    metadata.set("step", "seleccionando-formato");
    metadata.set("progress", 0.1);

    const formatsWithSpec = pickLargestBy(
      ((formats ?? []) as ProjectFormat[])
        .map((format) => ({ format, spec: getIABFormatById(format.iab_format) }))
        .filter((x): x is { format: ProjectFormat; spec: IABFormat } => x.spec != null),
      (x) => x.spec.ancho * x.spec.alto,
    );

    const selected = payload.iabFormatId
      ? (formatsWithSpec.find((x) => x.format.iab_format === payload.iabFormatId) ?? formatsWithSpec[0])
      : formatsWithSpec[0];

    if (!selected) {
      throw new Error("El proyecto no tiene formatos con especificación IAB válida.");
    }

    const { format, spec } = selected;
    const fontPrimary = project?.font_primary ?? "Inter";

    metadata.set("step", "descargando-assets-y-fuente");
    metadata.set("progress", 0.25);

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

    metadata.set("step", "renderizando-jpg");
    metadata.set("progress", 0.45);

    const [jpgBuffer, pngBuffer] = await Promise.all([
      // Fix 2: el fallback.jpg se compone con las capas reales del último frame
      // que contiene el CTA (+ persistentes), no un render de Satori desde cero.
      renderFallbackFromFrame({ assets: allAssets, width: spec.ancho, height: spec.alto, supabase }),
      renderBannerToPng(bannerElements),
    ]);

    metadata.set("step", "generando-html5");
    metadata.set("progress", 0.6);

    const animationGuide = await readAnimationGuideText(allAssets, supabase);
    const clickTagUrl = format.url_destino ?? "";

    const { html, assetFilenames } = await generateHtml5Master(
      payload.projectId,
      { width: spec.ancho, height: spec.alto, iabFormat: format.iab_format },
      allAssets,
      animationGuide,
      clickTagUrl,
      supabase,
    );

    await saveHtml5Master(payload.projectId, html, supabase);

    metadata.set("step", "empaquetando-zip");
    metadata.set("progress", 0.8);

    const filenameToPath = new Map<string, string>();
    for (const asset of allAssets) {
      const filename = assetFilename(asset);
      if (filename && asset.file_path) filenameToPath.set(filename, asset.file_path);
    }

    const pngEntries = (
      await Promise.all(
        assetFilenames.map(async (filename) => {
          const path = filenameToPath.get(filename) ?? null;
          const buffer = await downloadAsset(supabase, path);
          return buffer ? { filename, buffer } : null;
        }),
      )
    ).filter((entry): entry is { filename: string; buffer: Buffer } => entry != null);

    const zipEntries: ZipFileEntry[] = [
      { path: "index.html", content: html },
      ...pngEntries.map((entry) => ({ path: entry.filename, content: entry.buffer })),
      { path: "fallback.jpg", content: jpgBuffer },
    ];

    const zipBuffer = await buildZipBuffer(zipEntries);

    metadata.set("step", "subiendo-archivos");
    metadata.set("progress", 0.9);

    const basePath = `${payload.projectId}/master/${format.iab_format}`;
    const masterFolder = `${payload.projectId}/master`;
    // Fix 5: sube el HTML como Buffer con contentType explícito — algunos backends
    // de Storage no infieren bien el Content-Type de un string plano y el iframe
    // del preview termina descargando/mostrando el código fuente en vez de renderizarlo.
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
      // Ruta estable (independiente del iab_format elegido como master) para el
      // preview en iframe de app/project/[id]/master — junto a las mismas capas
      // PNG/JPG que referencia por filename relativo, para que cargue sin roturas.
      supabase.storage
        .from("adstudio-projects")
        .upload(`${masterFolder}/index.html`, htmlBuffer, { contentType: "text/html", upsert: true }),
      ...pngEntries.map((entry) =>
        supabase.storage
          .from("adstudio-projects")
          .upload(`${masterFolder}/${entry.filename}`, entry.buffer, {
            contentType: entry.filename.toLowerCase().endsWith(".jpg") ? "image/jpeg" : "image/png",
            upsert: true,
          }),
      ),
      supabase.storage
        .from("adstudio-projects")
        .upload(`${masterFolder}/master.zip`, zipBuffer, {
          contentType: "application/zip",
          upsert: true,
        }),
    ]);

    const isPrimary = payload.isPrimary ?? false;

    if (isPrimary) {
      await supabase
        .from("adstudio_masters")
        .update({ is_primary: false })
        .eq("project_id", payload.projectId);
    }

    await supabase.from("adstudio_masters").upsert(
      {
        project_id: payload.projectId,
        iab_format: format.iab_format,
        jpg_path: `${basePath}.jpg`,
        png_path: `${basePath}.png`,
        width: spec.ancho,
        height: spec.alto,
        jpg_size_bytes: jpgBuffer.byteLength,
        is_primary: isPrimary,
      },
      { onConflict: "project_id,iab_format" },
    );

    metadata.set("step", "completado");
    metadata.set("progress", 1);

    await supabase
      .from("adstudio_projects")
      .update({ status: "master_ready", master_run_id: null })
      .eq("id", payload.projectId);

    return { projectId: payload.projectId, iabFormat: format.iab_format };
  },
});
