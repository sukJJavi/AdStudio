import { createSessionSupabaseClient } from "@/lib/supabase/server-session";
import type { ProjectAsset, TextLayerMetadata } from "@/lib/types";

/** Extensiones de archivos originales (Excel, guía de animación en texto) — nunca son capas del PSD. */
const NON_PSD_EXTENSIONS = [".xlsx", ".xls", ".txt"];

function isNonPsdFile(filePath: string | null): boolean {
  if (!filePath) return false;
  const lower = filePath.toLowerCase();
  return NON_PSD_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export type ProjectLayer = ProjectAsset & { thumbnailUrl: string | null };

/**
 * Capas del editor de capas: no descartadas, extraídas del PSD (sin Excel/guía de
 * animación), ordenadas por z_index. El thumbnail se sirve vía
 * `/api/preview/[projectId]/assets/[filename]` (misma ruta que usa el preview del
 * master) en vez de signed URLs de Storage: evita expiraciones/errores de firma y
 * reutiliza el fallback jpg→png ya implementado ahí.
 */
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

  return assets.map((asset) => {
    const filename = (asset.metadata as TextLayerMetadata | undefined)?.filename;
    const thumbnailUrl =
      typeof filename === "string" && filename.trim()
        ? `/api/preview/${projectId}/assets/${filename}`
        : null;
    return { ...asset, thumbnailUrl };
  });
}

export type LayerPatchableField =
  | "classification"
  | "frame"
  | "frames"
  | "persistent"
  | "discarded"
  | "z_index"
  | "text_content"
  | "export_as_jpg";

export const LAYER_PATCHABLE_FIELDS: LayerPatchableField[] = [
  "classification",
  "frame",
  "frames",
  "persistent",
  "discarded",
  "z_index",
  "text_content",
  "export_as_jpg",
];

/** Capas listas para continuar al master: no hay ninguna sin frames asignados y sin marcar persistente. */
export function hasUnassignedLayers(
  layers: Pick<ProjectAsset, "frames" | "persistent" | "discarded">[],
): boolean {
  return layers.some((l) => !l.discarded && !l.persistent && (l.frames ?? []).length === 0);
}
