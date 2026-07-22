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
console.log("Canvas inicializado");

type AnalyzePsdPayload = {
  projectId: string;
};

function layerTypeOf(layer: Layer): string {
  return layer.text ? "texto" : "imagen";
}

type FrameContext = { frame: number | null; persistent: boolean };

/**
 * Detecta si el nombre de una carpeta del PSD marca un frame ("Frame 0",
 * "f0", "fr1", "F2"...) o la carpeta "Persistente"/"Persistent" — ver
 * `app/guide/psd/page.tsx` para la convención de nombrado que se le pide
 * al usuario. Si no matchea ninguno de los dos patrones, devuelve null
 * (la carpeta no aporta contexto de frame, p. ej. una subcarpeta de
 * organización interna como "textos").
 */
function detectFrameFromFolderName(name: string | undefined): FrameContext | null {
  if (!name) return null;
  if (/persistente|persistent/i.test(name)) return { frame: null, persistent: true };
  const match = name.match(/\bf(?:rame|r)?[\s_-]*?(\d+)\b/i);
  if (match) return { frame: Number(match[1]), persistent: false };
  return null;
}

type FlattenedLayer = { layer: Layer; frame: number | null; persistent: boolean };

/**
 * Aplana el árbol de capas del PSD en orden original: las carpetas
 * (`layer.children`) no generan asset propio, solo aportan contexto de
 * frame a las capas que contienen (heredado por las subcarpetas que no
 * matchean ningún patrón de frame). Capas sueltas fuera de cualquier
 * carpeta de frame quedan con frame=null, persistent=false — el usuario
 * las clasifica manualmente en el editor de capas.
 */
function flattenLayers(layers: Layer[], inherited: FrameContext, out: FlattenedLayer[]): void {
  for (const layer of layers) {
    if (layer.children) {
      flattenLayers(layer.children, detectFrameFromFolderName(layer.name) ?? inherited, out);
      continue;
    }
    out.push({ layer, frame: inherited.frame, persistent: inherited.persistent });
  }
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

/**
 * Nombres reservados para clasificaciones persistentes (presentes en todos los
 * frames) — usados por el HTML5 generado por Claude (ver lib/render/html5-generator.ts)
 * para referenciar assets por rol sin depender del frame.
 */
const PERSISTENT_FILENAMES: Partial<Record<string, string>> = {
  fondo: "background",
  logo: "logo",
  cta: "cta",
  disclaimer: "legal",
};

function sanitizeFilenameBase(name: string): string {
  const sanitized = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "");
  return sanitized || "layer";
}

/**
 * Nombre base (sin ".png" ni índice de desambiguación) del PNG exportado de una
 * capa, según su clasificación/frame — ver Bloque HTML5 en CLAUDE.md:
 * - persistente con rol reservado (fondo/logo/cta/disclaimer) -> nombre fijo
 * - con frame -> `f{N}_{classification}`
 * - "desconocido" -> nombre original de la capa del PSD, saneado
 * - resto (persistente sin rol reservado, o sin frame ni persistent) -> classification tal cual
 */
function baseFilenameFor(params: {
  classification: string;
  frame: number | null;
  persistent: boolean;
  layerName: string;
}): string {
  const { classification, frame, persistent, layerName } = params;

  if (classification === "desconocido") {
    return sanitizeFilenameBase(layerName);
  }

  if (persistent) {
    return PERSISTENT_FILENAMES[classification] ?? classification;
  }

  if (frame != null) {
    return `f${frame}_${classification}`;
  }

  return classification;
}

/** Añade índice de desambiguación (`_2`, `_3`, ...) si el nombre base ya se usó en el proyecto. */
function uniqueFilename(base: string, usedCounts: Map<string, number>, ext: "png" | "jpg" = "png"): string {
  const count = (usedCounts.get(base) ?? 0) + 1;
  usedCounts.set(base, count);
  return count === 1 ? `${base}.${ext}` : `${base}_${count}.${ext}`;
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
    // Único por proyecto (no por PSD): dos PSDs subidos al mismo proyecto comparten
    // carpeta de Storage `{project_id}/layers/`, así que sus nombres no pueden chocar.
    const usedFilenames = new Map<string, number>();

    type InsertedRow = { id: string; layer: Layer; frame: number | null; persistent: boolean; dpi: number | null };
    // Combinado entre todos los PSDs del proyecto: "la capa de mayor área del proyecto"
    // (fix 1 de fondo-como-JPG) se calcula sobre el total, no por archivo.
    const allInsertedRows: InsertedRow[] = [];

    for (const psdAsset of psdAssets ?? []) {
      if (!psdAsset.file_path) continue;

      const { data: file, error } = await supabase.storage
        .from("adstudio-projects")
        .download(psdAsset.file_path);

      if (error || !file) continue;

      metadata.set("step", "extrayendo-capas");
      metadata.set("progress", 0.2);

      const buffer = Buffer.from(await file.arrayBuffer());
      console.log("PSD descargado, tamaño:", buffer.byteLength);

      let psd: ReturnType<typeof readPsd>;
      try {
        psd = readPsd(buffer, {
          skipCompositeImageData: true,
          skipThumbnail: true,
          useImageData: true,
          throwForMissingFeatures: false,
        });
      } catch (error) {
        console.error(`No se pudo leer el PSD ${psdAsset.file_path}:`, error);
        await supabase.from("adstudio_assets").update({ status: "error" }).eq("id", psdAsset.id);
        continue;
      }

      console.log("PSD leído:", {
        width: psd.width,
        height: psd.height,
        children: psd.children?.length ?? 0,
      });

      const dpi = psd.imageResources?.resolutionInfo?.horizontalResolution ?? null;

      const flattened: FlattenedLayer[] = [];
      flattenLayers(psd.children ?? [], { frame: null, persistent: false }, flattened);

      console.log("Capas encontradas tras flatten:", flattened.length);

      for (let z = 0; z < flattened.length; z++) {
        const { layer, frame, persistent } = flattened[z];

        console.log("Capa:", {
          name: layer.name,
          hidden: layer.hidden,
          isGroup: !!layer.children,
          hasImage: !!layer.imageData,
          bounds: {
            left: layer.left,
            top: layer.top,
            right: layer.right,
            bottom: layer.bottom,
          },
        });
        const width = layer.right != null && layer.left != null ? layer.right - layer.left : null;
        const height = layer.bottom != null && layer.top != null ? layer.bottom - layer.top : null;
        const layerBounds =
          width != null && height != null && layer.left != null && layer.top != null
            ? { x: layer.left, y: layer.top, width, height }
            : null;
        const hidden = layer.hidden === true;

        console.log("Intentando insertar capa:", {
          name: layer.name,
          classification: "pending",
          project_id: payload.projectId,
        });

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
            // Las capas ocultas del PSD se detectan pero se descartan
            // automáticamente (ver app/guide/psd/page.tsx).
            status: hidden ? "processed" : "processing",
            frame,
            persistent,
            discarded: hidden,
            z_index: z,
            blend_mode: layer.blendMode ?? null,
            opacity: (layer.opacity ?? 255) / 255,
            layer_bounds: layerBounds,
            text_content: layer.text?.text ?? null,
          })
          .select()
          .single();

        console.log("Resultado insert:", { data: inserted, error: insertError });

        if (insertError) {
          console.error("Error insertando capa:", insertError);
          throw new Error(`Insert failed: ${insertError.message}`);
        }

        if (!insertError && inserted) {
          layersExtracted += 1;
          // Las capas ocultas no se aplanan a PNG ni se clasifican con Claude Vision.
          if (!hidden) allInsertedRows.push({ id: inserted.id as string, layer, frame, persistent, dpi });
        }
      }
    }

    metadata.set("step", "aplanando-capas");
    metadata.set("progress", 0.5);

    const flattenable = allInsertedRows.filter(({ layer }) => layer.imageData);

    // "La capa de mayor área del proyecto" (fix 1 background-como-JPG): se trata como
    // imagen de fondo aunque Claude Vision no la haya clasificado como 'fondo'.
    let largestAreaAssetId: string | null = null;
    let largestArea = -1;
    for (const { id, layer } of flattenable) {
      const imageData = layer.imageData!;
      const area = imageData.width * imageData.height;
      if (area > largestArea) {
        largestArea = area;
        largestAreaAssetId = id;
      }
    }

    for (let i = 0; i < flattenable.length; i++) {
      const { id: assetId, layer, frame, persistent, dpi } = flattenable[i];
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

      // Las capas de texto no pasan por Claude Vision: ya tenemos su fuente,
      // tamaño y contenido real extraídos directamente del PSD.
      const textMetadata = extractTextMetadata(layer);
      const classification = textMetadata ? "texto" : await classifyLayerImage(pngBuffer);

      // Fix 1: fondo/imagen de mayor área -> JPG calidad 85 (background.jpg) en vez de PNG.
      const isBackgroundLayer = classification === "fondo" || assetId === largestAreaAssetId;

      const filenameBase = isBackgroundLayer
        ? "background"
        : baseFilenameFor({ classification, frame, persistent, layerName: layer.name ?? "capa" });
      const filename = uniqueFilename(filenameBase, usedFilenames, isBackgroundLayer ? "jpg" : "png");

      const exportBuffer = isBackgroundLayer
        ? await sharp(pixelBuffer, {
            raw: { width: imageData.width, height: imageData.height, channels: 4 },
          })
            .jpeg({ quality: 85 })
            .toBuffer()
        : pngBuffer;
      const contentType = isBackgroundLayer ? "image/jpeg" : "image/png";

      const storagePath = `${payload.projectId}/layers/${filename}`;
      const { error: uploadError } = await supabase.storage
        .from("adstudio-projects")
        .upload(storagePath, exportBuffer, { contentType, upsert: true });

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
          metadata: { ...(textMetadata ?? {}), filename },
          status: "processed",
        })
        .eq("id", assetId);

      layersClassified += 1;
    }

    // Capas sin datos de imagen (p. ej. capas vectoriales/de ajuste) quedan extraídas pero sin clasificar.
    const unflattenable = allInsertedRows.filter(({ layer }) => !layer.imageData);
    if (unflattenable.length > 0) {
      await supabase
        .from("adstudio_assets")
        .update({ status: "processed" })
        .in(
          "id",
          unflattenable.map(({ id }) => id),
        );
    }

    metadata.set("step", "generando-informe-incidencias");
    metadata.set("progress", 0.95);

    await analyzeProjectIncidents(payload.projectId, supabase);

    await supabase
      .from("adstudio_projects")
      .update({ status: "analysis" })
      .eq("id", payload.projectId);

    metadata.set("step", "completado");
    metadata.set("progress", 1);

    return { projectId: payload.projectId, layersExtracted, layersClassified };
  },
});
