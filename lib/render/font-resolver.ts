import type { SupabaseClient } from "@supabase/supabase-js";

type FontAssetMetadata = { fontName?: string };

/**
 * Resuelve qué tipografía custom del cliente usar para renderizar un texto
 * (ver lib/render/text-png-renderer.ts): busca entre las fuentes subidas en
 * Upload (adstudio_assets.layer_type='font', ver components/project/upload-zones.tsx)
 * la que mejor coincide con `fontName` (el detectado en el PSD, metadata.fontName
 * de la capa de texto) y descarga su archivo desde Storage.
 *
 * La coincidencia es deliberadamente laxa (substring en cualquier dirección,
 * comparando solo la primera palabra antes de un guion — p. ej. "Montserrat-Bold"
 * -> "montserrat") porque el nombre de fuente que expone ag-psd rara vez es
 * idéntico al nombre de archivo que sube el cliente. Si no hay ninguna
 * coincidencia pero SÍ hay fuentes subidas, cae a la primera como mejor
 * esfuerzo — un proyecto con una sola fuente propia normalmente la quiere
 * para todos los textos.
 */
export async function resolveProjectFont(
  projectId: string,
  fontName: string,
  supabase: SupabaseClient,
): Promise<Buffer | null> {
  const { data: fonts } = await supabase
    .from("adstudio_assets")
    .select("file_path, metadata")
    .eq("project_id", projectId)
    .eq("layer_type", "font");

  if (!fonts || fonts.length === 0) return null;

  const requestedName = fontName.toLowerCase();
  const requestedKeyword = requestedName.split("-")[0]?.trim();

  const match =
    fonts.find((f) => {
      const uploadedName = ((f.metadata as FontAssetMetadata | null)?.fontName ?? "").toLowerCase();
      if (!uploadedName) return false;
      return (
        (requestedKeyword && uploadedName.includes(requestedKeyword)) || requestedName.includes(uploadedName)
      );
    }) ?? fonts[0];

  if (!match.file_path) return null;

  const { data, error } = await supabase.storage.from("adstudio-projects").download(match.file_path);

  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}
