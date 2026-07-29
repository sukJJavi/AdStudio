import sharp from "sharp";
import type { ProjectAsset, TextLayerMetadata } from "@/lib/types";

/** Clasificaciones que se benefician de un resize adicional con Sharp — el resto de PNGs se reutiliza tal cual. */
const BACKGROUND_CLASSIFICATIONS = new Set(["fondo", "imagen_principal"]);

function assetFilename(asset: ProjectAsset): string | null {
  const filename = (asset.metadata as TextLayerMetadata | undefined)?.filename;
  return typeof filename === "string" && filename.trim() ? filename : null;
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
  let html = masterHtml.replace(/<style>([\s\S]*?)<\/style>/i, (_match, css: string) => {
    return `<style>${scaleCssRules(css, scaleX, scaleY)}</style>`;
  });

  // 2. Forzar el tamaño exacto del #ad al formato destino — el paso anterior
  // ya lo reescala proporcionalmente, pero el redondeo por regla puede
  // desviarse un par de px del target exacto.
  html = html
    .replace(/(#ad\s*\{[^}]*?width\s*:\s*)-?\d+(?:\.\d+)?px/i, `$1${targetFormat.width}px`)
    .replace(/(#ad\s*\{[^}]*?height\s*:\s*)-?\d+(?:\.\d+)?px/i, `$1${targetFormat.height}px`);

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

  return { html, assetBuffers: scaledBuffers };
}
