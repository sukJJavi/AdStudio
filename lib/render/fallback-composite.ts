import sharp, { type OverlayOptions } from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProjectAsset, TextLayerMetadata } from "@/lib/types";

const TARGET_MAX_BYTES = 50 * 1024;

function filenameOf(layer: ProjectAsset): string | null {
  return (layer.metadata as TextLayerMetadata | undefined)?.filename ?? null;
}

/**
 * Compone el fallback.jpg a partir de las capas reales del frame del CTA
 * (persistentes + capas de ese frame, ordenadas por z_index). Nunca
 * re-renderiza el banner desde cero con Satori, así que el JPG de respaldo se
 * parece al banner real. Reduce calidad (85→75→...→30) hasta bajar de 50KB;
 * si ni con la calidad más baja lo consigue, devuelve esa.
 *
 * `assetOverrides` (asset.id → buffer PNG): capas ya adaptadas a `format`
 * fuera de esta función (p. ej. fondo/imagen_principal adaptados con FLUX
 * Kontext por formato en trigger/render-adaptations.ts) — ya vienen al
 * tamaño exacto del formato destino, así que se usan tal cual como capa de
 * fondo del canvas completo en vez de recortarse por layer_bounds del master.
 */
export async function renderFallbackFromFrame(
  projectId: string,
  format: { width: number; height: number },
  assets: ProjectAsset[],
  supabase: SupabaseClient,
  assetOverrides?: Map<string, Buffer>,
): Promise<Buffer> {
  // 1. Buscar la capa CTA para saber qué frame usar.
  const ctaAsset = assets.find(
    (a) => !a.discarded && a.classification === "cta" && a.frames && a.frames.length > 0,
  );
  const ctaFrame = ctaAsset ? Math.max(...(ctaAsset.frames ?? [])) : null;

  console.log("Fallback: CTA frame detectado:", ctaFrame);

  // Seleccionar capas: persistentes + frame del CTA.
  const fallbackLayers = assets
    .filter((a) => {
      if (a.discarded) return false;
      if (a.persistent) return true;
      if (ctaFrame !== null && a.frames?.includes(ctaFrame)) return true;
      return false;
    })
    .sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0));

  console.log(
    "Fallback: capas seleccionadas:",
    fallbackLayers.map((l) => ({
      name: l.layer_name,
      id: l.id,
      hasOverride: assetOverrides?.has(l.id) ?? false,
      filename: filenameOf(l),
    })),
  );

  // 2. Descargar o usar override para cada capa.
  const compositeInputs: OverlayOptions[] = [];

  for (const layer of fallbackLayers) {
    const bounds = layer.layer_bounds;
    if (!bounds) {
      console.log("Fallback: sin bounds, skip:", layer.layer_name);
      continue;
    }

    // Obtener buffer: override primero, luego Storage.
    let rawBuffer: Buffer | null = null;

    if (assetOverrides?.has(layer.id)) {
      rawBuffer = assetOverrides.get(layer.id)!;
      console.log("Fallback: usando override para:", layer.layer_name);
    } else {
      // Usa el file_path real del asset (namespaced por source_psd_id, ver
      // trigger/analyze-psd.ts) en vez de reconstruirlo desde el filename.
      const storagePath = layer.file_path;
      if (!storagePath) {
        console.log("Fallback: sin file_path, skip:", layer.layer_name);
        continue;
      }
      console.log("Fallback: descargando:", storagePath);

      const { data, error } = await supabase.storage.from("adstudio-projects").download(storagePath);

      if (error || !data) {
        console.log("Fallback: error descargando:", storagePath, error?.message);
        continue;
      }
      rawBuffer = Buffer.from(await data.arrayBuffer());
    }

    if (!rawBuffer) continue;

    // 3. Calcular área visible en el canvas.
    const srcX = Math.max(0, Math.round(-bounds.x));
    const srcY = Math.max(0, Math.round(-bounds.y));
    const dstX = Math.max(0, Math.round(bounds.x));
    const dstY = Math.max(0, Math.round(bounds.y));

    const visibleW = Math.min(Math.round(bounds.width) - srcX, format.width - dstX);
    const visibleH = Math.min(Math.round(bounds.height) - srcY, format.height - dstY);

    if (visibleW <= 0 || visibleH <= 0) {
      console.log("Fallback: sin área visible, skip:", layer.layer_name);
      continue;
    }

    try {
      // Si el buffer viene de un override de FLUX, ya tiene las dimensiones
      // del formato destino — usarlo directamente sin extract.
      let croppedBuffer: Buffer;

      if (assetOverrides?.has(layer.id)) {
        // Override de FLUX: redimensionar al canvas completo.
        croppedBuffer = await sharp(rawBuffer)
          .resize(format.width, format.height, { fit: "cover" })
          .png()
          .toBuffer();

        compositeInputs.push({
          input: croppedBuffer,
          top: 0,
          left: 0,
        });
      } else {
        // Asset normal del master: recortar al área visible.
        const meta = await sharp(rawBuffer).metadata();
        const imgW = meta.width ?? bounds.width;
        const imgH = meta.height ?? bounds.height;

        const extractLeft = Math.min(srcX, imgW - 1);
        const extractTop = Math.min(srcY, imgH - 1);
        const extractW = Math.min(visibleW, imgW - extractLeft);
        const extractH = Math.min(visibleH, imgH - extractTop);

        if (extractW <= 0 || extractH <= 0) continue;

        croppedBuffer = await sharp(rawBuffer)
          .extract({
            left: Math.round(extractLeft),
            top: Math.round(extractTop),
            width: Math.round(extractW),
            height: Math.round(extractH),
          })
          .png()
          .toBuffer();

        compositeInputs.push({
          input: croppedBuffer,
          top: dstY,
          left: dstX,
        });
      }

      console.log("Fallback: capa añadida OK:", layer.layer_name);
    } catch (err) {
      console.error(
        "Fallback: error procesando capa:",
        layer.layer_name,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 4. Componer sobre canvas negro.
  console.log("Fallback: componiendo", compositeInputs.length, "capas");

  let quality = 85;
  let result: Buffer;

  do {
    result = await sharp({
      create: {
        width: format.width,
        height: format.height,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .composite(compositeInputs)
      .jpeg({ quality })
      .toBuffer();

    quality -= 10;
  } while (result.length > TARGET_MAX_BYTES && quality > 30);

  console.log("Fallback: generado, tamaño:", result.length, "bytes");
  return result;
}
