import type { SupabaseClient } from "@supabase/supabase-js";
import { createClaudeClient } from "@/lib/claude/client";
import { exportFilenameFor } from "@/lib/render/export-format";
import type { LayerBounds, ProjectAsset, TextLayerMetadata } from "@/lib/types";

export type Html5FormatSpec = { width: number; height: number; iabFormat: string };

const SYSTEM_PROMPT = `Eres un experto en producción de publicidad digital con 20 años de experiencia generando piezas HTML5 para campañas de display IAB.

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
 * Genera el HTML5 de producción de un banner llamando a Claude UNA SOLA VEZ por
 * proyecto (el master). Las adaptaciones a otros formatos reutilizan este mismo
 * HTML vía `adaptHtml5ToFormat`, sin volver a llamar a Claude — ver
 * trigger/render-master.ts y trigger/render-adaptations.ts.
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

  const html = ensureAdBorder(stripCodeFence(raw));

  return { html, assetFilenames: descriptors.map((d) => d.filename) };
}

/**
 * Adapta el HTML5 master a otro formato IAB sin volver a llamar a Claude:
 * solo reemplaza las dimensiones del `#ad` y el meta `ad.size`. Los PNGs
 * referenciados son los mismos del master (se resolverá el escalado por
 * formato en una iteración posterior).
 */
export function adaptHtml5ToFormat(masterHtml: string, targetFormat: Html5FormatSpec): string {
  let html = masterHtml.replace(/(#ad\s*\{)([^}]*)(\})/i, (_match, open: string, body: string, close: string) => {
    const updatedBody = body
      .replace(/width\s*:\s*\d+px/i, `width: ${targetFormat.width}px`)
      .replace(/height\s*:\s*\d+px/i, `height: ${targetFormat.height}px`);
    return `${open}${updatedBody}${close}`;
  });

  html = html.replace(/<meta([^>]*name=["']ad\.size["'][^>]*)>/i, (_match, attrs: string) => {
    const updatedAttrs = attrs
      .replace(/width=\d+/i, `width=${targetFormat.width}`)
      .replace(/height=\d+/i, `height=${targetFormat.height}`);
    return `<meta${updatedAttrs}>`;
  });

  return html;
}
