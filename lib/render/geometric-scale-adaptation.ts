import sharp from "sharp";
import type { ProjectAsset, TextLayerMetadata } from "@/lib/types";

/** Clasificaciones que se benefician de un resize adicional con Sharp — el resto de PNGs se reutiliza tal cual. */
const BACKGROUND_CLASSIFICATIONS = new Set(["fondo", "imagen_principal"]);

function assetFilename(asset: ProjectAsset): string | null {
  const filename = (asset.metadata as TextLayerMetadata | undefined)?.filename;
  return typeof filename === "string" && filename.trim() ? filename : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Reescala en el propio CSS las reglas `top`/`left`/`width`/`height` en px de
 * cada selector del bloque `<style>`, multiplicando por el factor de escala
 * que corresponda a cada eje.
 */
function scaleCssRules(css: string, scaleX: number, scaleY: number): string {
  return css
    .replace(/\b(top|height)\s*:\s*(-?\d+(?:\.\d+)?)px/gi, (_match, prop: string, value: string) => {
      return `${prop}: ${Math.round(parseFloat(value) * scaleY)}px`;
    })
    .replace(/\b(left|width)\s*:\s*(-?\d+(?:\.\d+)?)px/gi, (_match, prop: string, value: string) => {
      return `${prop}: ${Math.round(parseFloat(value) * scaleX)}px`;
    });
}

/** Extrae los bloques `selector { body }` de un `<style>` — solo para logging de depuración, no altera el escalado. */
function extractRuleBlocks(css: string): { selector: string; body: string }[] {
  const blocks: { selector: string; body: string }[] = [];
  const regex = /([#.][\w-]+)\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(css))) {
    blocks.push({ selector: match[1], body: match[2].trim() });
  }
  return blocks;
}

/** `object-fit` según classification: fondo/imagen_principal rellenan recortando (cover), el resto nunca se deforma (contain). */
function objectFitFor(classification: string | null): "cover" | "contain" {
  return classification && BACKGROUND_CLASSIFICATIONS.has(classification) ? "cover" : "contain";
}

/**
 * El escalado geométrico (scaleCssRules) cambia el ratio del contenedor de
 * cada asset sin tocar el PNG en sí — un PNG cuyo contenido fue pensado para
 * el ratio del master se deforma si su caja pasa a tener un ratio distinto.
 * Añade `object-fit` a la regla CSS del selector de cada `<img>` (localizado
 * por su `src`, que referencia el filename real del asset) según su
 * classification: `cover` para fondo/imagen_principal (rellena recortando lo
 * que sobre), `contain` para el resto (nunca deforma, aunque queden márgenes).
 */
function addObjectFitRules(html: string, assets: ProjectAsset[]): string {
  let result = html;

  for (const asset of assets) {
    if (asset.discarded) continue;
    const filename = assetFilename(asset);
    if (!filename) continue;

    // El HTML puede referenciar el .png original o su exportación a .jpg
    // (export_as_jpg, ver lib/render/export-format.ts) — se busca cualquiera.
    const filenameAlt = filename.toLowerCase().endsWith(".png")
      ? filename.replace(/\.png$/i, ".jpg")
      : filename.replace(/\.jpe?g$/i, ".png");

    const imgTagMatch =
      result.match(new RegExp(`<img[^>]*\\bsrc=["']${escapeRegExp(filename)}["'][^>]*>`, "i")) ??
      result.match(new RegExp(`<img[^>]*\\bsrc=["']${escapeRegExp(filenameAlt)}["'][^>]*>`, "i"));

    const id = imgTagMatch?.[0].match(/\bid=["']([^"']+)["']/i)?.[1];
    if (!id) continue;

    const objectFit = objectFitFor(asset.classification);
    const ruleRegex = new RegExp(`(#${escapeRegExp(id)}\\s*\\{)([^}]*)(\\})`, "i");

    result = result.replace(ruleRegex, (_match, open: string, body: string, close: string) => {
      if (/object-fit\s*:/i.test(body)) return `${open}${body}${close}`;
      return `${open}${body} object-fit: ${objectFit};${close}`;
    });
  }

  return result;
}

/**
 * Nivel 1 — adaptación automática por escalado geométrico puro (ver
 * classifyFormat en lib/render/format-level.ts): toma el HTML5 del master tal
 * cual y multiplica cada regla de posición/tamaño en px del `<style>` por el
 * factor de escala ancho/alto correspondiente. Determinista, sin llamadas a
 * Claude ni a FLUX — debe funcionar siempre.
 *
 * Los PNGs se reutilizan sin modificar (el navegador ya los escala
 * visualmente al redimensionar su contenedor vía CSS); opcionalmente se
 * reescala también con Sharp (sin FLUX, solo resize) el fondo/imagen_principal
 * para mayor nitidez al nuevo tamaño que ocupará en el layout.
 */
export async function generateNivel1Adaptation(
  projectId: string,
  masterHtml: string,
  masterFormat: { width: number; height: number },
  targetFormat: { width: number; height: number },
  assets: ProjectAsset[],
  assetBuffers: Map<string, Buffer>,
): Promise<{ html: string; assetBuffers: Map<string, Buffer> }> {
  void projectId;

  const scaleX = targetFormat.width / masterFormat.width;
  const scaleY = targetFormat.height / masterFormat.height;

  // 1. Reescalar las reglas de posición/tamaño del <style> del master.
  const cssBefore = masterHtml.match(/<style>([\s\S]*?)<\/style>/i)?.[1] ?? "";
  const cssAfter = scaleCssRules(cssBefore, scaleX, scaleY);

  const beforeBlocks = extractRuleBlocks(cssBefore);
  const afterBlocks = extractRuleBlocks(cssAfter);
  console.log(
    "Nivel1 CSS rules found:",
    beforeBlocks.map((b, i) => ({ selector: b.selector, before: b.body, after: afterBlocks[i]?.body })),
  );

  let html = masterHtml.replace(/<style>([\s\S]*?)<\/style>/i, () => `<style>${cssAfter}</style>`);

  // 2. Forzar el tamaño exacto del #ad al formato destino — el paso anterior
  // ya lo reescala proporcionalmente, pero el redondeo por regla puede
  // desviarse un par de px del target exacto.
  html = html
    .replace(/(#ad\s*\{[^}]*?width\s*:\s*)-?\d+(?:\.\d+)?px/i, `$1${targetFormat.width}px`)
    .replace(/(#ad\s*\{[^}]*?height\s*:\s*)-?\d+(?:\.\d+)?px/i, `$1${targetFormat.height}px`);

  // 2b. object-fit por asset — evita que un PNG pensado para el ratio del
  // master se deforme cuando su caja pasa a tener el ratio del formato
  // destino (ver addObjectFitRules).
  html = addObjectFitRules(html, assets);

  // 3. Assets: se reutilizan tal cual, salvo fondo/imagen_principal, que se
  // reescala con Sharp (sin FLUX) al tamaño que le corresponde en el nuevo
  // layout — mayor nitidez que dejar que el navegador lo escale vía CSS.
  const scaledBuffers = new Map(assetBuffers);

  const backgroundAssets = assets.filter(
    (a) => !a.discarded && BACKGROUND_CLASSIFICATIONS.has(a.classification ?? "") && a.layer_bounds,
  );

  for (const asset of backgroundAssets) {
    const filename = assetFilename(asset);
    const original = filename ? assetBuffers.get(filename) : undefined;
    if (!filename || !original || !asset.layer_bounds) continue;

    const newWidth = Math.max(1, Math.round(asset.layer_bounds.width * scaleX));
    const newHeight = Math.max(1, Math.round(asset.layer_bounds.height * scaleY));

    try {
      const resized = await sharp(original).resize(newWidth, newHeight, { fit: "cover" }).toBuffer();
      scaledBuffers.set(filename, resized);
    } catch (err) {
      // Best-effort: si el resize falla, se mantiene el PNG original del master.
      console.error(`Nivel1: no se pudo reescalar "${filename}":`, err);
    }
  }

  console.log(
    "Nivel1 img srcs:",
    [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]),
  );

  return { html, assetBuffers: scaledBuffers };
}
