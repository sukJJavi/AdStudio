import { createSessionSupabaseClient } from "@/lib/supabase/server-session";
import type { ProjectAsset } from "@/lib/types";

const THUMBNAIL_SIGNED_URL_TTL_SECONDS = 3600;

/** Extensiones de archivos originales (Excel, guía de animación en texto) — nunca son capas del PSD. */
const NON_PSD_EXTENSIONS = [".xlsx", ".xls", ".txt"];

function isNonPsdFile(filePath: string | null): boolean {
  if (!filePath) return false;
  const lower = filePath.toLowerCase();
  return NON_PSD_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export type ProjectLayer = ProjectAsset & { thumbnailUrl: string | null };

/** Capas del editor de capas: no descartadas, extraídas del PSD (sin Excel/guía de animación), ordenadas por z_index, con signed URL de thumbnail. */
export async function getProjectLayers(projectId: string): Promise<ProjectLayer[]> {
  const supabase = await createSessionSupabaseClient();

  const { data, error } = await supabase
    .from("adstudio_assets")
    .select("*")
    .eq("project_id", projectId)
    .eq("discarded", false)
    .order("z_index", { ascending: true });

  if (error || !data) return [];

  // Fix 1: excluye el Excel de adaptaciones y la guía de animación en texto —
  // solo se muestran assets extraídos del PSD (imagen/texto/grupo con su PNG/JPG).
  const assets = (data as ProjectAsset[]).filter((asset) => !isNonPsdFile(asset.file_path));

  return Promise.all(
    assets.map(async (asset) => {
      if (!asset.file_path) return { ...asset, thumbnailUrl: null };
      const { data: signed, error: signError } = await supabase.storage
        .from("adstudio-projects")
        .createSignedUrl(asset.file_path, THUMBNAIL_SIGNED_URL_TTL_SECONDS);
      // Fix 4: log de diagnóstico — confirma que la signed URL se genera (o el
      // motivo por el que no) para cada thumbnail del preview del editor de capas.
      console.log("Signed URL de capa:", { assetId: asset.id, filePath: asset.file_path, url: signed?.signedUrl, error: signError });
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
