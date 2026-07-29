import sharp from "sharp";
import { inlineAssetsAsDataUrls } from "@/lib/render/html5-generator";
import { renderInlinedHtmlToImage } from "@/lib/render/browserless-renderer";

const TARGET_MAX_BYTES = 50 * 1024;

/**
 * Fallback.jpg de una adaptación (Nivel 1 o Nivel 2, ver
 * trigger/render-adaptations.ts) como screenshot real del HTML5 final —
 * garantiza que el JPG de respaldo coincide exactamente con la pieza
 * entregada, en vez de una composición manual con Sharp que puede
 * desviarse del layout real (posiciones/escalas ya resueltas en el HTML).
 *
 * Mismo mecanismo que lib/render/html5-generator.ts:refineHtml5WithVisualFeedback
 * (inlineAssetsAsDataUrls + renderInlinedHtmlToImage): el HTML no tiene un
 * origen público detrás con `page.setContent()`, así que los `src` deben
 * inlinearse como data URIs antes de renderizar.
 */
export async function renderAdaptationFallbackJpg(
  html: string,
  format: { width: number; height: number },
  assetBuffers: Map<string, Buffer>,
): Promise<Buffer> {
  const inlinedHtml = inlineAssetsAsDataUrls(html, assetBuffers);
  const screenshot = await renderInlinedHtmlToImage(inlinedHtml, format.width, format.height);

  let quality = 85;
  let result: Buffer;

  do {
    result = await sharp(screenshot).jpeg({ quality }).toBuffer();
    quality -= 10;
  } while (result.byteLength > TARGET_MAX_BYTES && quality > 30);

  return result;
}
