import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { downloadAsset } from "@/lib/render/assets";
import type { ProjectAsset } from "@/lib/types";

/** Calidades a probar en orden hasta bajar de TARGET_MAX_BYTES. */
const QUALITY_STEPS = [85, 75, 65, 55];
const TARGET_MAX_BYTES = 50 * 1024;

/**
 * Compone el fallback.jpg a partir de las capas reales del último frame que
 * contiene el CTA (persistentes + las de ese frame, ordenadas por z_index),
 * en vez de re-renderizar el banner desde cero con Satori — así el JPG de
 * respaldo se parece al banner real. Reduce calidad (85→75→65→55) hasta
 * bajar de 50KB; si ni con la calidad más baja lo consigue, devuelve esa.
 */
export async function renderFallbackFromFrame(params: {
  assets: ProjectAsset[];
  width: number;
  height: number;
  supabase: SupabaseClient;
}): Promise<Buffer> {
  const { assets, width, height, supabase } = params;

  const ctaFrames = assets
    .filter((a) => a.classification === "cta" && !a.discarded)
    .flatMap((a) => a.frames ?? []);
  const targetFrame = ctaFrames.length > 0 ? Math.max(...ctaFrames) : null;

  const layers = assets
    .filter(
      (a) =>
        !a.discarded &&
        a.file_path &&
        a.layer_bounds &&
        (a.persistent || (targetFrame != null && (a.frames ?? []).includes(targetFrame))),
    )
    .sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0));

  const layerBuffers = await Promise.all(
    layers.map(async (layer) => ({ layer, buffer: await downloadAsset(supabase, layer.file_path) })),
  );

  const composite: { input: Buffer; top: number; left: number }[] = [];

  for (const { layer, buffer } of layerBuffers) {
    const bounds = layer.layer_bounds;
    if (!buffer || !bounds) continue;

    // Recorta cada capa al área visible dentro del canvas — sharp exige que la
    // imagen a compositar quepa dentro del lienzo, y algunas capas del PSD son
    // mayores que el canvas o se salen de sus bordes. `extract()` exige enteros,
    // de ahí los Math.round (layer_bounds puede traer valores no enteros).
    const srcX = Math.round(Math.max(0, -bounds.x)); // offset dentro del PNG de la capa
    const srcY = Math.round(Math.max(0, -bounds.y));
    const dstX = Math.round(Math.max(0, bounds.x)); // posición en el canvas
    const dstY = Math.round(Math.max(0, bounds.y));

    const visibleWidth = Math.floor(Math.min(bounds.width - srcX, width - dstX));
    const visibleHeight = Math.floor(Math.min(bounds.height - srcY, height - dstY));

    if (visibleWidth <= 0 || visibleHeight <= 0) continue;

    const croppedBuffer = await sharp(buffer)
      .extract({ left: srcX, top: srcY, width: visibleWidth, height: visibleHeight })
      .png()
      .toBuffer();

    composite.push({ input: croppedBuffer, top: dstY, left: dstX });
  }

  let lastBuffer: Buffer | null = null;

  for (const quality of QUALITY_STEPS) {
    lastBuffer = await sharp({
      create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .composite(composite)
      .jpeg({ quality })
      .toBuffer();

    if (lastBuffer.byteLength <= TARGET_MAX_BYTES) {
      return lastBuffer;
    }
  }

  return lastBuffer as Buffer;
}
