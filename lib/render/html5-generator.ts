import type { SupabaseClient } from "@supabase/supabase-js";
import { createClaudeClient } from "@/lib/claude/client";
import { exportFilenameFor } from "@/lib/render/export-format";
import type { LayerBounds, ProjectAsset, TextLayerMetadata } from "@/lib/types";

export type Html5FormatSpec = { width: number; height: number; iabFormat: string };

const SYSTEM_PROMPT = `REGLA ABSOLUTA: NUNCA escribas '#ad img { width: 100%; height: 100% }' ni ninguna regla CSS global que afecte a todos los elementos img o div dentro de #ad. CADA elemento tiene su propio CSS con posición y dimensiones exactas en píxeles. Una regla global DESTRUYE el posicionamiento.

Eres un experto en producción de publicidad digital con 20 años de experiencia generando piezas HTML5 para campañas de display IAB.

Recibes la estructura de capas de un banner publicitario y generas el HTML5 de producción profesional.

REGLAS DE PRODUCCIÓN:
- Cada asset es un PNG del tamaño exacto del canvas posicionado con position:absolute, top:0, left:0, width:100%, height:100%
- El fondo del #ad es siempre negro (#000)
- El #ad lleva siempre border: 1px solid #000000; y box-sizing: border-box; en su CSS
- Siempre incluye clickTag como variable JS global
- La capa de clickthrough es un div transparente position:absolute que cubre el 100% del ad, z-index máximo, con onclick='window.open(window.clickTag)'
- La animación se infiere del orden de frames y nombres de capas. Si hay guía de animación, úsala.
- Usa CSS transitions + setTimeout para la animación, NO librerías externas
- El timeline debe ser un array de objetos ejecutable con la función startTimeline estándar IAB
- Máximo 15 segundos de animación, máximo 3 loops
- Incluye función loopea() para el loop automático
- Assets referenciados por filename, nunca en base64
- Compatible con Google Display Network, Xandr, The Trade Desk
- Los PNG con canal alpha (logos, textos, elementos decorativos) NUNCA llevan background-color ni background en su CSS. Solo las capas clasificadas como 'fondo' o 'background' pueden tener color de fondo.
- Las capas de background que son más anchas que el canvas (como imágenes panorámicas de 1250px en un canvas de 300px) deben tener overflow:visible en el #ad y la animación de desplazamiento debe modificar la propiedad left/transform. El #ad debe tener overflow:hidden para contener todo.

Ejemplo de background panorámico que se desplaza:
#ad { overflow: hidden; }
#background { position:absolute; width:1250px; left:-475px; transition: left 0.8s ease; }
Para ir al frame 2: background.style.left = '-775px'

FORMATO DE RESPUESTA:
Devuelve SOLO el HTML completo, sin explicaciones, sin bloques de código markdown, comenzando con <!doctype html>`;

type Html5AssetDescriptor = {
  filename: string;
  classification: string | null;
  frames: number[];
  persistent: boolean;
  layer_bounds: LayerBounds | null;
  text_content: string | null;
  opacity: number | null;
  blend_mode: string | null;
};

function assetFilename(asset: ProjectAsset): string | null {
  const filename = (asset.metadata as TextLayerMetadata | undefined)?.filename;
  return typeof filename === "string" && filename.trim() ? filename : null;
}

function toAssetDescriptor(asset: ProjectAsset, pngFilename: string): Html5AssetDescriptor {
  return {
    // Fix 2: el HTML debe referenciar el nombre con la extensión correcta
    // ("background.jpg" o "imagen_principal.png") según export_as_jpg.
    filename: exportFilenameFor(pngFilename, !!asset.export_as_jpg),
    classification: asset.classification,
    frames: asset.frames ?? [],
    persistent: asset.persistent,
    layer_bounds: asset.layer_bounds,
    text_content: asset.text_content,
    opacity: asset.opacity,
    blend_mode: asset.blend_mode,
  };
}

/** Assets utilizables por el HTML5: no descartados y ya aplanados a PNG (con filename asignado), ordenados por z_index. */
function usableAssetDescriptors(assets: ProjectAsset[]): Html5AssetDescriptor[] {
  return assets
    .filter((a) => !a.discarded)
    .sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0))
    .flatMap((a) => {
      const filename = assetFilename(a);
      return filename ? [toAssetDescriptor(a, filename)] : [];
    });
}

/** Quita el fence ```html ... ``` si Claude lo añade a pesar de la instrucción de no hacerlo. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

/**
 * Fix 9: garantiza el borde del #ad aunque Claude no lo incluya (el prompt lo
 * pide, pero no hay forma de asegurar el cumplimiento de un LLM) — añade
 * `border`/`box-sizing` a la regla `#ad { ... }` solo si no están ya presentes.
 */
function ensureAdBorder(html: string): string {
  return html.replace(/(#ad\s*\{)([^}]*)(\})/i, (_match, open: string, body: string, close: string) => {
    let updatedBody = body;
    if (!/border\s*:/i.test(updatedBody)) updatedBody += " border: 1px solid #000000;";
    if (!/box-sizing\s*:/i.test(updatedBody)) updatedBody += " box-sizing: border-box;";
    return `${open}${updatedBody}${close}`;
  });
}

/**
 * Elimina reglas CSS globales que Claude a veces añade a pesar de la instrucción
 * del prompt (p.ej. `#ad img { width: 100%; height: 100% }`): sobrescriben el
 * posicionamiento absoluto en px de cada capa individual y rompen el layout.
 */
function sanitizeHtml(html: string): string {
  return html
    .replace(/#ad\s+img\s*\{[^}]*width\s*:\s*100%[^}]*\}/gi, "")
    .replace(/#ad\s+img\s*\{[^}]*height\s*:\s*100%[^}]*\}/gi, "")
    .replace(/\.layer\s*\{[^}]*width\s*:\s*100%[^}]*height\s*:\s*100%[^}]*\}/gi, "");
}

/**
 * Genera el HTML5 de producción de un banner llamando a Claude UNA VEZ por
 * proyecto (el master, ver trigger/render-master.ts). Las adaptaciones a otros
 * formatos parten de este HTML pero hacen su propia llamada a Claude —
 * `adaptHtml5ToFormatWithClaude`, una por formato — para recomponer el layout
 * en vez de reescalar mecánicamente (ver trigger/render-adaptations.ts).
 */
export async function generateHtml5Master(
  projectId: string,
  masterFormat: Html5FormatSpec,
  assets: ProjectAsset[],
  animationGuide: string | null,
  clickTagUrl: string,
  supabase: SupabaseClient,
): Promise<{ html: string; assetFilenames: string[] }> {
  void projectId;
  void supabase;

  const descriptors = usableAssetDescriptors(assets);

  const userMessage = [
    `Canvas: ${masterFormat.width}x${masterFormat.height}px`,
    `Assets ordenados por z_index (JSON):`,
    JSON.stringify(descriptors, null, 2),
    `Guía de animación: ${
      animationGuide?.trim() ||
      "No hay guía — infiere animación profesional del orden de frames y clasificación de capas"
    }`,
    `clickTag: ${clickTagUrl}`,
  ].join("\n\n");

  const client = createClaudeClient();
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";

  const html = ensureAdBorder(sanitizeHtml(stripCodeFence(raw)));

  return { html, assetFilenames: descriptors.map((d) => d.filename) };
}

/**
 * System prompt de la adaptación (trigger/render-adaptations.ts): a diferencia
 * de generateHtml5Master, aquí Claude recibe el HTML5 completo del master y
 * debe recomponer el layout para el nuevo formato, no solo reescalar el
 * canvas — un banner de 300x600 no funciona con un resize mecánico a 728x90.
 */
function buildAdaptSystemPrompt(targetWidth: number, targetHeight: number): string {
  return `Eres un productor experto en publicidad digital HTML5 con 20 años de experiencia adaptando campañas de display IAB.

Recibes el HTML5 de un banner master y debes adaptarlo a un nuevo formato manteniendo la identidad visual y la animación, pero recomponiendo el layout para que funcione en las nuevas dimensiones.

REGLAS:
- Usa exactamente los mismos filenames de assets que el master
- Mantén la misma animación y timing del master
- Recompón el layout: posiciones, tamaños, jerarquía visual
- El texto debe ser legible en el nuevo formato
- Respeta las zonas seguras IAB (10px mínimo)
- El #ad debe tener exactamente ${targetWidth}x${targetHeight}px
- border: 1px solid #000 en el #ad siempre
- clickTag idéntico al master
- NUNCA uses reglas CSS globales como '#ad img{width:100%}'

Devuelve SOLO el HTML completo sin explicaciones ni bloques markdown, empezando con <!doctype html>`;
}

/** Líneas `filename: WxH` para el user message de la adaptación — mismo criterio de filename que el master (usableAssetDescriptors, con exportFilenameFor aplicado). */
function assetDimensionLines(assets: ProjectAsset[]): string[] {
  return usableAssetDescriptors(assets)
    .filter((d) => d.layer_bounds != null)
    .map((d) => `${d.filename}: ${d.layer_bounds!.width}x${d.layer_bounds!.height}px`);
}

/**
 * Adapta el HTML5 del master a otro formato IAB con una llamada a Claude por
 * formato (trigger/render-adaptations.ts): a diferencia del reescalado
 * mecánico anterior, Claude recompone el layout completo — necesario porque
 * un master de 300x600 no cabe razonablemente en, por ejemplo, 728x90 con
 * solo cambiar las dimensiones del `#ad`. Los assets (PNG/JPG) son los mismos
 * del master; Claude decide cómo posicionarlos, no se recortan ni regeneran.
 */
export async function adaptHtml5ToFormatWithClaude(
  masterHtml: string,
  assets: ProjectAsset[],
  targetFormat: Html5FormatSpec,
): Promise<string> {
  const userMessage = [
    "Master HTML:",
    masterHtml,
    "",
    "Assets disponibles (filename → dimensiones reales):",
    assetDimensionLines(assets).join("\n"),
    "",
    `Adapta este banner a ${targetFormat.width}x${targetFormat.height}px.`,
    "Toma las decisiones creativas que necesites para que la pieza funcione correctamente en este formato.",
  ].join("\n");

  const client = createClaudeClient();
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8000,
    system: buildAdaptSystemPrompt(targetFormat.width, targetFormat.height),
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";

  return ensureAdBorder(sanitizeHtml(stripCodeFence(raw)));
}
