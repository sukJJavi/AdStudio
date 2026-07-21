import { task, metadata } from "@trigger.dev/sdk/v3";
import { createCanvas, createImageData } from "canvas";
import { readPsd, initializeCanvas } from "ag-psd";
import type { Layer } from "ag-psd";
import sharp from "sharp";
import { createTriggerSupabaseClient } from "@/lib/supabase/trigger-client";
import { classifyLayerImage } from "@/lib/claude/vision";
import { getIABFormatById } from "@/lib/iab/specs";
import { analyzeProjectIncidents } from "@/lib/iab/incident-analyzer";

// ag-psd necesita Canvas incluso con `useImageData: true`: el decodificador de
// capas (createImageDataBitDepth) llama a createCanvas/createImageData de forma
// incondicional para construir el buffer de píxeles antes de exponerlo como
// imageData plano. Node no trae Canvas nativo, así que hay que inicializarlo
// con el paquete `canvas` antes de cualquier readPsd().
// `canvas`'s `Canvas` no implementa la interfaz completa de `HTMLCanvasElement`
// (falta captureStream, toBlob, etc., irrelevantes para el uso que hace ag-psd
// de él como superficie de pintura 2D), de ahí el cast acotado a la firma que
// initializeCanvas espera.
initializeCanvas(
  createCanvas as unknown as (width: number, height: number) => HTMLCanvasElement,
  createImageData as unknown as (width: number, height: number) => ImageData,
);

type AnalyzePsdPayload = {
  projectId: string;
};

function layerTypeOf(layer: Layer): string {
  return layer.text ? "texto" : layer.children ? "grupo" : "imagen";
}

type TextLayerMetadata = { fontName: string | null; fontSize: number | null; content: string | null };

/**
 * ag-psd expone el nombre de la fuente en `layer.text.style.font.name`
 * (no en `style.fontName` directamente — `font` es un objeto `{ name, ... }`).
 */
function extractTextMetadata(layer: Layer): TextLayerMetadata | null {
  if (!layer.text) return null;
  return {
    fontName: layer.text.style?.font?.name ?? null,
    fontSize: layer.text.style?.fontSize ?? null,
    content: layer.text.text ?? null,
  };
}

/** dpi >= 72 -> 1, por debajo -> dpi/72 (72dpi es el mínimo aceptable para pantalla). */
function dpiFactor(dpi: number | null): number {
  if (!dpi || dpi <= 0) return 1;
  return Math.min(1, dpi / 72);
}

/** Penaliza un asset más pequeño que el mayor formato IAB del plan del proyecto. */
function resolutionFactor(width: number, height: number, formatoMaxArea: number | null): number {
  if (!formatoMaxArea || formatoMaxArea <= 0) return 1;
  return Math.min(1, (width * height) / formatoMaxArea);
}

export const analyzePsd = task({
  id: "analyze-psd",
  run: async (payload: AnalyzePsdPayload) => {
    const supabase = createTriggerSupabaseClient();

    metadata.set("step", "descargando-psd");
    metadata.set("progress", 0);

    const { data: psdAssets } = await supabase
      .from("adstudio_assets")
      .select("*")
      .eq("project_id", payload.projectId)
      .eq("layer_type", "psd");

    const { data: projectFormats } = await supabase
      .from("adstudio_formats")
      .select("iab_format")
      .eq("project_id", payload.projectId);

    const formatoMaxArea = (projectFormats ?? []).reduce<number | null>((max, f) => {
      const spec = getIABFormatById(f.iab_format);
      if (!spec) return max;
      const area = spec.ancho * spec.alto;
      return max === null || area > max ? area : max;
    }, null);

    let layersExtracted = 0;
    let layersClassified = 0;

    for (const psdAsset of psdAssets ?? []) {
      if (!psdAsset.file_path) continue;

      const { data: file, error } = await supabase.storage
        .from("adstudio-projects")
        .download(psdAsset.file_path);

      if (error || !file) continue;

      metadata.set("step", "extrayendo-capas");
      metadata.set("progress", 0.2);

      const buffer = Buffer.from(await file.arrayBuffer());
      const psd = readPsd(buffer, {
        skipCompositeImageData: true,
        skipThumbnail: true,
        useImageData: true,
        throwForMissingFeatures: false,
      });

      const dpi = psd.imageResources?.resolutionInfo?.horizontalResolution ?? null;
      const layers = psd.children ?? [];

      const insertedRows: { id: string; layer: Layer }[] = [];

      for (const layer of layers) {
        const width = layer.right != null && layer.left != null ? layer.right - layer.left : null;
        const height = layer.bottom != null && layer.top != null ? layer.bottom - layer.top : null;

        const { data: inserted, error: insertError } = await supabase
          .from("adstudio_assets")
          .insert({
            project_id: payload.projectId,
            layer_name: layer.name ?? "capa sin nombre",
            layer_type: layerTypeOf(layer),
            classification: null,
            width,
            height,
            dpi,
            file_path: null,
            quality_score: null,
            status: "processing",
          })
          .select()
          .single();

        if (!insertError && inserted) {
          insertedRows.push({ id: inserted.id as string, layer });
          layersExtracted += 1;
        }
      }

      metadata.set("step", "aplanando-capas");
      metadata.set("progress", 0.5);

      const flattenable = insertedRows.filter(({ layer }) => layer.imageData);

      for (let i = 0; i < flattenable.length; i++) {
        const { id: assetId, layer } = flattenable[i];
        const imageData = layer.imageData!;

        metadata.set("step", "clasificando-con-claude");
        metadata.set("progress", 0.5 + 0.4 * (i / Math.max(flattenable.length, 1)));

        const pixelBuffer = Buffer.from(
          imageData.data.buffer,
          imageData.data.byteOffset,
          imageData.data.byteLength,
        );

        const pngBuffer = await sharp(pixelBuffer, {
          raw: { width: imageData.width, height: imageData.height, channels: 4 },
        })
          .png()
          .toBuffer();

        const storagePath = `${payload.projectId}/layers/${assetId}.png`;
        const { error: uploadError } = await supabase.storage
          .from("adstudio-projects")
          .upload(storagePath, pngBuffer, { contentType: "image/png", upsert: true });

        // Las capas de texto no pasan por Claude Vision: ya tenemos su fuente,
        // tamaño y contenido real extraídos directamente del PSD.
        const textMetadata = extractTextMetadata(layer);
        const classification = textMetadata ? "texto" : await classifyLayerImage(pngBuffer);

        const width = imageData.width;
        const height = imageData.height;
        const qualityScore =
          Math.round(resolutionFactor(width, height, formatoMaxArea) * dpiFactor(dpi) * 100) / 100;

        await supabase
          .from("adstudio_assets")
          .update({
            classification,
            quality_score: qualityScore,
            width,
            height,
            dpi,
            file_path: uploadError ? null : storagePath,
            metadata: textMetadata ?? {},
            status: "processed",
          })
          .eq("id", assetId);

        layersClassified += 1;
      }

      // Capas sin datos de imagen (p. ej. grupos) quedan extraídas pero sin clasificar.
      const unflattenable = insertedRows.filter(({ layer }) => !layer.imageData);
      if (unflattenable.length > 0) {
        await supabase
          .from("adstudio_assets")
          .update({ status: "processed" })
          .in(
            "id",
            unflattenable.map(({ id }) => id),
          );
      }
    }

    metadata.set("step", "generando-informe-incidencias");
    metadata.set("progress", 0.95);

    await analyzeProjectIncidents(payload.projectId);

    await supabase
      .from("adstudio_projects")
      .update({ status: "analysis" })
      .eq("id", payload.projectId);

    metadata.set("step", "completado");
    metadata.set("progress", 1);

    return { projectId: payload.projectId, layersExtracted, layersClassified };
  },
});
