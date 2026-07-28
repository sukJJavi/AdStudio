import type { SupabaseClient } from "@supabase/supabase-js";

type FontAssetMetadata = { fontName?: string };
type FontAsset = { file_path: string | null; metadata: FontAssetMetadata | null };

/**
 * Palabras clave de peso/estilo del fontName pedido — p. ej.
 * 'FranklinGothicATF-BoldItalic' -> ['bold', 'italic']. Sin ninguna palabra
 * clave reconocida se asume 'regular', para no hacer match con un weight
 * distinto (p. ej. no confundir el Regular pedido con el Bold subido).
 */
function extractWeightKeywords(fontName: string): string[] {
  const lower = fontName.toLowerCase();
  const keywords: string[] = [];
  if (lower.includes("bold")) keywords.push("bold");
  if (lower.includes("italic") || lower.includes("oblique")) keywords.push("italic");
  if (lower.includes("light")) keywords.push("light");
  if (lower.includes("regular") || keywords.length === 0) keywords.push("regular");
  return keywords;
}

function familyKeywordOf(fontName: string): string {
  return fontName.toLowerCase().split("-")[0]?.trim() ?? "";
}

/**
 * Resuelve qué tipografía custom del cliente usar para renderizar un texto
 * (ver lib/render/text-png-renderer.ts): busca entre las fuentes subidas en
 * Upload (adstudio_assets.layer_type='font', ver components/project/upload-zones.tsx)
 * la que mejor coincide con `fontName` (el detectado en el PSD, metadata.fontName
 * de la capa de texto) y descarga su archivo desde Storage.
 *
 * La coincidencia va en dos pasadas para no confundir pesos/estilos cuando el
 * cliente sube varias variantes de la misma familia (Regular/Bold/Italic):
 * 1. familia Y weight/estilo (extractWeightKeywords) coinciden.
 * 2. si no hay ninguna, cae a coincidencia solo por familia.
 * 3. si tampoco, cae a la primera fuente subida como mejor esfuerzo — un
 *    proyecto con una sola fuente propia normalmente la quiere para todos
 *    los textos.
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
  const typedFonts = fonts as FontAsset[];

  const familyKeyword = familyKeywordOf(fontName);
  const requestedKeywords = extractWeightKeywords(fontName);

  const match =
    typedFonts.find((f) => {
      const uploadedName = (f.metadata?.fontName ?? "").toLowerCase();
      if (!uploadedName) return false;
      const familyMatch = familyKeyword ? uploadedName.includes(familyKeyword) : false;
      const weightMatch = requestedKeywords.every((kw) => uploadedName.includes(kw));
      return familyMatch && weightMatch;
    }) ??
    typedFonts.find((f) => {
      const uploadedName = (f.metadata?.fontName ?? "").toLowerCase();
      return !!uploadedName && !!familyKeyword && uploadedName.includes(familyKeyword);
    }) ??
    typedFonts[0];

  if (!match.file_path) return null;

  const { data, error } = await supabase.storage.from("adstudio-projects").download(match.file_path);

  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}
