import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProjectAsset } from "@/lib/types";

/**
 * Lee el contenido de la guía de animación (layer_type='animation') para pasarlo
 * a generateHtml5Master. Solo se leen guías de texto plano (.txt, incluida la
 * URL/descripción libre guardada como texto vía app/api/upload) — un PDF se
 * detecta (cuenta para el incidente NO_ANIMATION_GUIDE) pero no se parsea todavía.
 */
export async function readAnimationGuideText(
  assets: ProjectAsset[],
  supabase: SupabaseClient,
): Promise<string | null> {
  const guideAsset = assets.find((a) => a.layer_type === "animation" && a.file_path);
  if (!guideAsset?.file_path || !guideAsset.file_path.toLowerCase().endsWith(".txt")) return null;

  const { data, error } = await supabase.storage.from("adstudio-projects").download(guideAsset.file_path);
  if (error || !data) return null;

  return Buffer.from(await data.arrayBuffer()).toString("utf-8");
}
