import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import { createClaudeClient } from "@/lib/claude/client";
import { exportFilenameFor } from "@/lib/render/export-format";
import { renderInlinedHtmlToImage } from "@/lib/render/browserless-renderer";
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
- IMPORTANTE: todos los src de assets deben usar rutas relativas simples (src="background.jpg", src="logo.png"). NO uses rutas absolutas, NO uses file://, NO uses ./ Solo el nombre del archivo sin ningún prefijo de ruta.
- Expón una función global window.goToEnd() que detenga la animación y muestre todos los elementos en su estado final visible (el frame donde todo el contenido es legible: claim, subclaim, CTA y logo todos visibles). Si el timeline usa un loop, expón también window.stopLoop() para detenerlo. Esto se usa para generar el fallback estático — no se ejecuta durante la reproducción normal.

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

/**
 * Quita el fence ```html ... ``` si Claude lo añade a pesar de la instrucción
 * de no hacerlo. Exportado: lo reutiliza lib/adaptation-refine.ts (chat de
 * cambios sobre una adaptación, "hermana" de lib/master.ts:refineMasterHtml).
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

/**
 * Fix 9: garantiza el borde del #ad aunque Claude no lo incluya (el prompt lo
 * pide, pero no hay forma de asegurar el cumplimiento de un LLM) — añade
 * `border`/`box-sizing` a la regla `#ad { ... }` solo si no están ya presentes.
 */
export function ensureAdBorder(html: string): string {
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
export function sanitizeHtml(html: string): string {
  return html
    .replace(/#ad\s+img\s*\{[^}]*width\s*:\s*100%[^}]*\}/gi, "")
    .replace(/#ad\s+img\s*\{[^}]*height\s*:\s*100%[^}]*\}/gi, "")
    .replace(/\.layer\s*\{[^}]*width\s*:\s*100%[^}]*height\s*:\s*100%[^}]*\}/gi, "");
}

/**
 * El HTML se sirve tanto desde `/api/preview/...` como, tras descomprimir el
 * ZIP de entrega, abierto directamente como `file://` en local — ahí el
 * navegador bloquea ("Unsafe attempt to load URL file://...") cualquier
 * `src` que no sea un nombre de fichero suelto. El prompt ya pide rutas
 * relativas simples, pero un LLM no lo garantiza: esto limpia cualquier
 * prefijo de ruta (absoluta, `file://`, `./`, `../`) que se haya colado,
 * dejando solo el nombre del archivo.
 */
function sanitizeAssetPaths(html: string): string {
  return html
    .replace(/src="[^"]*\/([^"/]+\.(png|jpg|jpeg|gif))"/gi, 'src="$1"')
    .replace(/src='[^']*\/([^'/]+\.(png|jpg|jpeg|gif))'/gi, "src='$1'");
}

/**
 * Genera el HTML5 de producción de un banner llamando a Claude UNA VEZ por
 * proyecto (el master, ver trigger/render-master.ts). Las adaptaciones a otros
 * formatos parten de este HTML pero hacen su propia llamada a Claude Vision —
 * `adaptHtml5WithVision`, una por formato — para recomponer el layout sobre
 * un background generado con Replicate FLUX en vez de reescalar mecánicamente
 * (Opción A: Browserless + FLUX + Claude, ver trigger/render-adaptations.ts).
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

  const html = sanitizeAssetPaths(ensureAdBorder(sanitizeHtml(stripCodeFence(raw))));

  return { html, assetFilenames: descriptors.map((d) => d.filename) };
}

type AdaptContentBlock = Anthropic.Messages.TextBlockParam | Anthropic.Messages.ImageBlockParam;

function textContentBlock(text: string): AdaptContentBlock {
  return { type: "text", text };
}

/** `.jpg`/`.jpeg` → image/jpeg, cualquier otra cosa (siempre `.png` en la práctica) → image/png. */
function imageMediaTypeFor(filename: string): "image/jpeg" | "image/png" {
  return /\.jpe?g$/i.test(filename) ? "image/jpeg" : "image/png";
}

function imageContentBlock(mediaType: "image/jpeg" | "image/png", buffer: Buffer): AdaptContentBlock {
  return { type: "image", source: { type: "base64", media_type: mediaType, data: buffer.toString("base64") } };
}

/**
 * Adapta el HTML5 del master a otro formato IAB — Opción A: Browserless
 * (render real del master) + Replicate FLUX Kontext (reencuadre por asset de
 * fondo/imagen_principal) + Claude Vision (posicionamiento de todos los
 * assets), ver trigger/render-adaptations.ts. `assetBuffers` ya trae, para
 * fondo/imagen_principal, el PNG adaptado a `targetFormat` (en vez del
 * original del master) — Claude ve el master renderizado de verdad y cada
 * asset suelto (ya adaptado o no) para componer el layout con criterio
 * visual, sin distinguir background de primer plano.
 */
export async function adaptHtml5WithVision(
  masterHtml: string,
  masterRendered: Buffer,
  masterFormat: { width: number; height: number },
  assets: ProjectAsset[],
  assetBuffers: Map<string, Buffer>,
  targetFormat: Html5FormatSpec,
): Promise<string> {
  const usableAssets = assets.filter((a) => !a.discarded);

  const assetImageBlocks: AdaptContentBlock[] = usableAssets.flatMap((asset) => {
    const filename = assetFilename(asset);
    if (!filename) return [];
    const buffer = assetBuffers.get(filename);
    if (!buffer) return [];
    return [
      textContentBlock(`${filename} — clasificación: ${asset.classification ?? "desconocido"}`),
      imageContentBlock(imageMediaTypeFor(filename), buffer),
    ];
  });

  const instructions = [
    "HTML del master (referencia de animación y estructura):",
    masterHtml,
    "",
    `Genera el HTML5 para ${targetFormat.width}x${targetFormat.height}px.`,
    "Cada asset adjunto ya viene con su nombre de fichero — compón el layout con todos ellos (fondo/imagen_principal incluidos), con criterio profesional.",
    "Mantén la animación del master adaptada al nuevo formato.",
    "Respeta las zonas seguras IAB (10px mínimo), mantén el mismo clickTag que el master, y el #ad con border: 1px solid #000 y exactamente " +
      `${targetFormat.width}x${targetFormat.height}px.`,
    "NUNCA uses reglas CSS globales como '#ad img{width:100%}'.",
    "IMPORTANTE: todos los src de assets deben usar rutas relativas simples (src=\"background.jpg\", src=\"logo.png\"). NO uses rutas absolutas, NO uses file://, NO uses ./ Solo el nombre del archivo sin ningún prefijo de ruta.",
    "Expón una función global window.goToEnd() que detenga la animación y muestre todos los elementos en su estado final visible (claim, subclaim, CTA y logo todos visibles). Si hay loop, expón también window.stopLoop(). Se usa para generar el fallback estático.",
    "Devuelve SOLO el HTML completo comenzando con <!doctype html>",
  ].join("\n");

  const content: AdaptContentBlock[] = [
    textContentBlock(
      `Eres un productor experto en publicidad digital HTML5.\nAquí tienes el banner master original (${masterFormat.width}x${masterFormat.height}px):`,
    ),
    imageContentBlock("image/png", masterRendered),
    textContentBlock("Assets a posicionar (algunos ya vienen reencuadrados al nuevo formato):"),
    ...assetImageBlocks,
    textContentBlock(instructions),
  ];

  const client = createClaudeClient();
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    // Los HTMLs de adaptación son más largos que los del master: Claude
    // reescribe el CSS completo por formato, y con 4096 el HTML salía
    // truncado en formatos grandes/complejos.
    max_tokens: 8192,
    messages: [{ role: "user", content }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";

  return sanitizeAssetPaths(ensureAdBorder(sanitizeHtml(stripCodeFence(raw))));
}

type VisualEvaluation = { hasProblems: boolean; issues: string[] };

function parseVisualEvaluation(text: string): VisualEvaluation {
  try {
    const parsed = JSON.parse(text.replace(/```json|```/gi, "").trim());
    const issues = Array.isArray(parsed.issues) ? parsed.issues.filter((i: unknown) => typeof i === "string") : [];
    return { hasProblems: !!parsed.hasProblems, issues };
  } catch {
    return { hasProblems: false, issues: [] };
  }
}

/**
 * Sustituye los `src="filename"` del HTML por data URIs base64 a partir de
 * `assetBuffers` — necesario para renderizar con `page.setContent()`
 * (renderInlinedHtmlToImage), que no tiene origen público detrás y por tanto
 * no puede resolver rutas relativas a Storage. Exportado: lo reutiliza
 * trigger/render-adaptations.ts para el fallback.jpg (screenshot real del
 * HTML final, ver lib/render/adaptation-fallback.ts).
 */
export function inlineAssetsAsDataUrls(html: string, assetBuffers: Map<string, Buffer>): string {
  let inlined = html;
  for (const [filename, buffer] of assetBuffers) {
    const dataUrl = `data:${imageMediaTypeFor(filename)};base64,${buffer.toString("base64")}`;
    inlined = inlined.replaceAll(`src="${filename}"`, `src="${dataUrl}"`).replaceAll(`src='${filename}'`, `src='${dataUrl}'`);
  }
  return inlined;
}

/**
 * Loop de feedback visual sobre el HTML5 ya adaptado a un formato (ver
 * adaptHtml5WithVision / trigger/render-adaptations.ts): renderiza el HTML con
 * Browserless (assets inlineados como base64 — ver inlineAssetsAsDataUrls),
 * Claude Vision evalúa si hay problemas evidentes de layout (texto fuera del
 * banner, elementos solapados/cortados, áreas vacías) y, si los hay, Claude
 * corrige el HTML manteniendo animación y elementos correctos. Hasta
 * `maxIterations` rondas; termina antes si una evaluación no reporta
 * problemas. Coste aproximado por formato: ~$0.01 evaluación + ~$0.06 por
 * corrección aplicada.
 */
export async function refineHtml5WithVisualFeedback(
  html: string,
  format: Html5FormatSpec,
  assetBuffers: Map<string, Buffer>,
  maxIterations: number = 2,
): Promise<string> {
  const client = createClaudeClient();
  let currentHtml = html;

  for (let i = 0; i < maxIterations; i++) {
    const inlinedHtml = inlineAssetsAsDataUrls(currentHtml, assetBuffers);
    const renderedBuffer = await renderInlinedHtmlToImage(inlinedHtml, format.width, format.height);

    const evaluationResponse = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: [
            textContentBlock(
              [
                `Evalúa este banner publicitario de ${format.width}x${format.height}px como productor experto.`,
                "¿Hay problemas evidentes de layout? (texto fuera del banner, elementos solapados, texto ilegible, elementos cortados, áreas negras donde debería haber contenido)",
                'Responde SOLO con JSON: {"hasProblems": boolean, "issues": string[]}',
              ].join("\n"),
            ),
            imageContentBlock("image/png", renderedBuffer),
          ],
        },
      ],
    });

    const evalBlock = evaluationResponse.content.find((block) => block.type === "text");
    const evaluation = parseVisualEvaluation(evalBlock && evalBlock.type === "text" ? evalBlock.text : "{}");

    console.log(`Visual feedback iteración ${i + 1}/${maxIterations} (${format.iabFormat}):`, evaluation);

    if (!evaluation.hasProblems || evaluation.issues.length === 0) break;
    if (i === maxIterations - 1) break;

    const fixResponse = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      messages: [
        {
          role: "user",
          content: [
            textContentBlock(
              `Eres un productor experto en HTML5 publicitario. Este banner de ${format.width}x${format.height}px tiene estos problemas:`,
            ),
            imageContentBlock("image/png", renderedBuffer),
            textContentBlock(
              [
                `Problemas detectados: ${evaluation.issues.join(", ")}`,
                "",
                "HTML actual:",
                currentHtml,
                "",
                "Corrige SOLO los problemas mencionados. No cambies la animación ni elementos que están bien.",
                "Devuelve SOLO el HTML completo corregido comenzando con <!doctype html>",
              ].join("\n"),
            ),
          ],
        },
      ],
    });

    const fixBlock = fixResponse.content.find((block) => block.type === "text");
    const fixedHtml = fixBlock && fixBlock.type === "text" ? fixBlock.text : currentHtml;

    currentHtml = sanitizeAssetPaths(ensureAdBorder(sanitizeHtml(stripCodeFence(fixedHtml))));
  }

  return currentHtml;
}
