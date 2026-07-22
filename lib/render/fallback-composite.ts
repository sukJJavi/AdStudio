import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProjectAsset, TextLayerMetadata } from "@/lib/types";

const TARGET_MAX_BYTES = 50 * 1024;

function sanitizeLayerName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "_");
}

/**
 * Nombre del PNG original en Storage para una capa: `metadata.filename` con la
 * extensión normalizada a `.png` (el `.jpg` solo existe en el ZIP cuando
 * `export_as_jpg`, ver lib/render/export-format.ts — en Storage siempre está
 * el PNG). Si falta `metadata.filename` (asset sin metadata seteado
 * correctamente), cae a `layer_name` saneado + `.png`.
 */
function pngFilenameFor(layer: Pick<ProjectAsset, "metadata" | "layer_name">): string | null {
  const metadataFilename = (layer.metadata as TextLayerMetadata | undefined)?.filename ?? null;

  if (metadataFilename) {
    return metadataFilename.replace(/\.jpg$/i, ".png");
  }

  if (layer.layer_name) {
    return `${sanitizeLayerName(layer.layer_name)}.png`;
  }

  return null;
}

/**
 * Compone el fallback.jpg a partir de las capas reales del frame del CTA
 * (persistentes + capas de ese frame, ordenadas por z_index) — o, si no hay
 * ninguna capa clasificada como CTA, del último frame disponible. Nunca
 * re-renderiza el banner desde cero con Satori, así que el JPG de respaldo
 * se parece al banner real. Reduce calidad (85→75→...→30) hasta bajar de
 * 50KB; si ni con la calidad más baja lo consigue, devuelve esa.
 */
export async function renderFallbackFromFrame(
  projectId: string,
  format: { width: number; height: number },
  assets: ProjectAsset[],
  supabase: SupabaseClient,
): Promise<Buffer> {
  // 1. Encontrar el frame del CTA.
  const ctaAsset = assets.find(
    (a) => a.classification === "cta" && !a.discarded && a.frames && a.frames.length > 0,
  );

  const ctaFrame = ctaAsset ? Math.max(...(ctaAsset.frames as number[])) : null;

  // 2. Seleccionar capas para el fallback: persistentes + capas del frame del
  // CTA. Si no hay CTA, usar todas las capas del último frame.
  const fallbackLayers = assets
    .filter((a) => !a.discarded)
    .filter((a) => {
      if (a.persistent) return true;
      if (ctaFrame !== null && a.frames?.includes(ctaFrame)) return true;
      if (ctaFrame === null && a.frames && a.frames.length > 0) {
        return a.frames.includes(Math.max(...a.frames));
      }
      return false;
    })
    .sort((a, b) => a.z_index - b.z_index);

  console.log(
    "Fallback layers:",
    fallbackLayers.map((l) => ({
      name: l.layer_name,
      classification: l.classification,
      persistent: l.persistent,
      frames: l.frames,
      export_as_jpg: l.export_as_jpg,
    })),
  );

  // 3. Componer con sharp — canvas negro base.
  const composite: { input: Buffer; top: number; left: number }[] = [];

  for (const layer of fallbackLayers) {
    // Descargar PNG original de Storage (siempre PNG para composición): el
    // fichero convertido a JPG por export_as_jpg solo existe en el ZIP, no en
    // Storage — ver lib/render/export-format.ts.
    const pngFilename = pngFilenameFor(layer);
    if (!pngFilename) {
      console.error("Capa sin metadata.filename ni layer_name, no se puede componer:", {
        id: layer.id,
        layer_name: layer.layer_name,
      });
      continue;
    }

    const storagePath = `${projectId}/layers/${pngFilename}`;

    console.log("Intentando descargar:", storagePath);
    const { data, error } = await supabase.storage.from("adstudio-projects").download(storagePath);
    console.log("Resultado:", { ok: !!data, error: error?.message });

    if (error || !data) {
      console.error("Error descargando layer, se omite del fallback pero se sigue con el resto:", {
        storagePath,
        error,
      });
      continue;
    }

    const layerBuffer = Buffer.from(await data.arrayBuffer());
    const bounds = layer.layer_bounds;
    if (!bounds) continue;

    // Calcular intersección visible con el canvas.
    const srcX = Math.max(0, -bounds.x);
    const srcY = Math.max(0, -bounds.y);
    const dstX = Math.max(0, bounds.x);
    const dstY = Math.max(0, bounds.y);

    const visibleWidth = Math.min(bounds.width - srcX, format.width - dstX);
    const visibleHeight = Math.min(bounds.height - srcY, format.height - dstY);

    if (visibleWidth <= 0 || visibleHeight <= 0) continue;

    const croppedBuffer = await sharp(layerBuffer)
      .extract({
        left: Math.round(srcX),
        top: Math.round(srcY),
        width: Math.round(visibleWidth),
        height: Math.round(visibleHeight),
      })
      .png()
      .toBuffer();

    composite.push({
      input: croppedBuffer,
      top: Math.round(dstY),
      left: Math.round(dstX),
    });
  }

  // 4. Exportar como JPG < 50KB.
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
      .composite(composite)
      .jpeg({ quality })
      .toBuffer();

    quality -= 10;
  } while (result.byteLength > TARGET_MAX_BYTES && quality > 30);

  return result;
}
