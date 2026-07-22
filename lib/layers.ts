import { createSessionSupabaseClient } from "@/lib/supabase/server-session";
import type { ProjectAsset } from "@/lib/types";

const THUMBNAIL_SIGNED_URL_TTL_SECONDS = 3600;

export type ProjectLayer = ProjectAsset & { thumbnailUrl: string | null };

/** Capas del editor de capas: no descartadas, ordenadas por z_index, con signed URL de thumbnail. */
export async function getProjectLayers(projectId: string): Promise<ProjectLayer[]> {
  const supabase = await createSessionSupabaseClient();

  const { data, error } = await supabase
    .from("adstudio_assets")
    .select("*")
    .eq("project_id", projectId)
    .eq("discarded", false)
    .order("z_index", { ascending: true });

  if (error || !data) return [];

  const assets = data as ProjectAsset[];

  return Promise.all(
    assets.map(async (asset) => {
      if (!asset.file_path) return { ...asset, thumbnailUrl: null };
      const { data: signed } = await supabase.storage
        .from("adstudio-projects")
        .createSignedUrl(asset.file_path, THUMBNAIL_SIGNED_URL_TTL_SECONDS);
      return { ...asset, thumbnailUrl: signed?.signedUrl ?? null };
    }),
  );
}

export type LayerPatchableField =
  | "classification"
  | "frame"
  | "frames"
  | "persistent"
  | "discarded"
  | "z_index"
  | "text_content";

export const LAYER_PATCHABLE_FIELDS: LayerPatchableField[] = [
  "classification",
  "frame",
  "frames",
  "persistent",
  "discarded",
  "z_index",
  "text_content",
];

/** Capas listas para continuar al master: no hay ninguna sin frames asignados y sin marcar persistente. */
export function hasUnassignedLayers(
  layers: Pick<ProjectAsset, "frames" | "persistent" | "discarded">[],
): boolean {
  return layers.some((l) => !l.discarded && !l.persistent && (l.frames ?? []).length === 0);
}
