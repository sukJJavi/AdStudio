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

  const ctaAssets = assets.filter((a) => a.classification === "cta" && !a.discarded && a.frame != null);
  const targetFrame = ctaAssets.length > 0 ? Math.max(...ctaAssets.map((a) => a.frame as number)) : null;

  const layers = assets
    .filter(
      (a) =>
        !a.discarded &&
        a.file_path &&
        a.layer_bounds &&
        (a.persistent || (targetFrame != null && a.frame === targetFrame)),
    )
    .sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0));

  const layerBuffers = await Promise.all(
    layers.map(async (layer) => ({ layer, buffer: await downloadAsset(supabase, layer.file_path) })),
  );

  const composite = layerBuffers.flatMap(({ layer, buffer }) => {
    if (!buffer || !layer.layer_bounds) return [];
    const top = Math.max(0, layer.layer_bounds.y);
    const left = Math.max(0, layer.layer_bounds.x);
    if (left >= width || top >= height) return [];
    return [{ input: buffer, top, left }];
  });

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
