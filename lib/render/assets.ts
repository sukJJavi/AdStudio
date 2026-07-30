import type { SupabaseClient } from "@supabase/supabase-js";
import { exportBufferFor, exportFilenameFor } from "@/lib/render/export-format";
import type { ProjectAsset, TextLayerMetadata } from "@/lib/types";

/** layer_type usados por trigger/analyze-psd.ts para capas extraídas del PSD. */
export const PSD_LAYER_TYPES = new Set(["texto", "grupo", "imagen"]);

export function pickLargestBy<T>(items: T[], area: (item: T) => number): T[] {
  return [...items].sort((a, b) => area(b) - area(a));
}

function assetArea(asset: ProjectAsset): number {
  return (asset.width ?? 0) * (asset.height ?? 0);
}

/**
 * Capas del PSD clasificadas y utilizables para componer el canvas (fondo,
 * imagen_principal, logo, ...), ordenadas por área descendente cuando hay
 * varias con la misma clasificación.
 */
export function selectClassifiedAssets(assets: ProjectAsset[]): {
  byClassification: (cls: string) => ProjectAsset | null;
} {
  const classified = pickLargestBy(
    assets.filter(
      (a): a is ProjectAsset =>
        a.layer_type != null &&
        PSD_LAYER_TYPES.has(a.layer_type) &&
        a.classification != null &&
        a.classification !== "desconocido",
    ),
    assetArea,
  );

  return {
    byClassification: (cls: string) => classified.find((a) => a.classification === cls) ?? null,
  };
}

export async function downloadAsset(
  supabase: SupabaseClient,
  filePath: string | null,
): Promise<Buffer | null> {
  if (!filePath) return null;
  const { data, error } = await supabase.storage.from("adstudio-projects").download(filePath);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

function assetFilename(asset: ProjectAsset): string | null {
  const filename = (asset.metadata as TextLayerMetadata | undefined)?.filename;
  return typeof filename === "string" && filename.trim() ? filename : null;
}

/**
 * Descarga y exporta (PNG u JPG según `export_as_jpg`) los assets utilizables
 * de un HTML5, indexados por el nombre de fichero "lógico" que referencia el
 * HTML (`src="background.jpg"`) — mismo patrón repetido en
 * trigger/render-master.ts y trigger/render-adaptations.ts para construir el
 * ZIP, reutilizado también para regenerar el fallback.jpg tras un refine (ver
 * lib/master.ts:refineMasterHtml y lib/adaptation-refine.ts).
 */
export async function downloadAssetBuffers(
  assets: ProjectAsset[],
  supabase: SupabaseClient,
): Promise<Map<string, Buffer>> {
  const entries = (
    await Promise.all(
      assets
        .filter((a) => !a.discarded)
        .flatMap((a) => {
          const pngFilename = assetFilename(a);
          return pngFilename && a.file_path ? [{ asset: a, pngFilename }] : [];
        })
        .map(async ({ asset, pngFilename }) => {
          const buffer = await downloadAsset(supabase, asset.file_path);
          if (!buffer) return null;
          const exported = await exportBufferFor(buffer, !!asset.export_as_jpg);
          return { filename: exportFilenameFor(pngFilename, !!asset.export_as_jpg), buffer: exported };
        }),
    )
  ).filter((entry): entry is { filename: string; buffer: Buffer } => entry != null);

  return new Map(entries.map((entry) => [entry.filename, entry.buffer]));
}
