import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { ProjectAsset } from "@/lib/types";

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

type SupabaseServerClient = ReturnType<typeof createServerSupabaseClient>;

export async function downloadAsset(
  supabase: SupabaseServerClient,
  filePath: string | null,
): Promise<Buffer | null> {
  if (!filePath) return null;
  const { data, error } = await supabase.storage.from("adstudio-projects").download(filePath);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

export async function toDataUri(
  supabase: SupabaseServerClient,
  filePath: string | null,
): Promise<string | null> {
  const buffer = await downloadAsset(supabase, filePath);
  if (!buffer) return null;
  return `data:image/png;base64,${buffer.toString("base64")}`;
}
