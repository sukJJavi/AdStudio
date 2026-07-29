import puppeteer from "puppeteer-core";

function browserlessEndpoint(): string {
  const token = process.env.BROWSERLESS_API_KEY;
  if (!token) throw new Error("BROWSERLESS_API_KEY no configurada");
  return `wss://production-sfo.browserless.io?token=${token}`;
}

export interface TextRenderOptions {
  /** El text_content de la capa. */
  text: string;
  /** TTF/OTF de la fuente (ver lib/render/font-resolver.ts). */
  fontBuffer: Buffer;
  /** Nombre para registrar en canvas. */
  fontName: string;
  /** fontSize de Photoshop (metadata.fontSize de la capa). */
  sourceFontSize: number;
  /** Ancho del PSD master (adstudio_projects.psd_width). */
  sourcePsdWidth: number;
  /** Altura del PSD master (adstudio_projects.psd_height). */
  sourcePsdHeight: number;
  /** Ancho del formato destino. */
  targetWidth: number;
  /** Alto del formato destino. */
  targetHeight: number;
  /** Posición de la capa en el master (adstudio_assets.layer_bounds). */
  sourceLayerBounds: { x: number; y: number; width: number; height: number };
  /** Color del texto extraído del PSD (rgb(...) o hex), default blanco. */
  textColor?: string;
}

/**
 * Renderiza una capa de texto como PNG con la tipografía custom del cliente,
 * escalando fontSize y área disponible del PSD master al formato destino —
 * usado en trigger/render-adaptations.ts para sustituir el PNG de texto del
 * master cuando hay una fuente propia resuelta (ver lib/render/font-resolver.ts).
 *
 * Renderiza vía Browserless (Chrome remoto) en vez de node-canvas: node-canvas
 * en Linux (worker de Trigger.dev) no rasteriza fuentes TTF/OTF custom de
 * forma fiable y produce tofu; un navegador real con @font-face + data URI sí.
 */
export async function renderTextAsPng(opts: TextRenderOptions): Promise<Buffer> {
  // 1. Escala master -> formato destino. Escalar solo por altura deforma el
  // texto cuando el master es vertical y el destino horizontal (p. ej.
  // 1080x1920 -> 728x90): la altura se reduce muchísimo más que el ancho y el
  // fontSize resultante es ilegible. En ese caso se usa la media geométrica de
  // los factores de ancho y alto, que no exagera en ninguna dirección.
  const scaleX = opts.targetWidth / opts.sourcePsdWidth;
  const scaleY = opts.targetHeight / opts.sourcePsdHeight;

  const sourceIsVertical = opts.sourcePsdHeight > opts.sourcePsdWidth;
  const targetIsVertical = opts.targetHeight > opts.targetWidth;
  const scaleFactor = sourceIsVertical !== targetIsVertical ? Math.sqrt(scaleX * scaleY) : scaleY;

  const areaWidth = Math.max(20, Math.round(opts.sourceLayerBounds.width * scaleX));
  const areaHeight = Math.max(20, Math.round(opts.sourceLayerBounds.height * scaleY));
  const fontSize = Math.max(8, Math.min(Math.round(opts.sourceFontSize * scaleFactor), 120));

  // 2. Convertir fuente a base64 para inyectarla como @font-face inline — sin
  // esto Chrome no tiene forma de resolver la fuente custom (no hay origen
  // público detrás de un setContent() con un archivo temporal en disco).
  const fontBase64 = opts.fontBuffer.toString("base64");
  const fontFamily = opts.fontName
    .split("-")[0]
    .replace(/([A-Z])/g, " $1")
    .trim();

  // 3. HTML con el texto y la fuente inyectada.
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  @font-face {
    font-family: '${fontFamily}';
    src: url('data:font/truetype;base64,${fontBase64}') format('truetype');
    font-weight: bold;
    font-style: normal;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: ${areaWidth}px;
    height: ${areaHeight}px;
    overflow: hidden;
    background: transparent;
  }
  #text {
    width: ${areaWidth}px;
    font-family: '${fontFamily}', sans-serif;
    font-size: ${fontSize}px;
    font-weight: bold;
    color: ${opts.textColor ?? "#FFFFFF"};
    line-height: 1.15;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
</head>
<body>
<div id="text">${opts.text.replace(/\n/g, "<br>")}</div>
</body>
</html>`;

  // 4. Renderizar con Browserless.
  const browser = await puppeteer.connect({ browserWSEndpoint: browserlessEndpoint() });

  try {
    const page = await browser.newPage();
    await page.setViewport({
      width: areaWidth,
      height: areaHeight,
      deviceScaleFactor: 2, // mejor calidad
    });

    await page.setContent(html, { waitUntil: "load" });

    // Esperar a que la fuente cargue.
    await page.evaluateHandle("document.fonts.ready");

    const screenshot = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: areaWidth, height: areaHeight },
      omitBackground: true, // fondo transparente — necesario para compositar sobre el resto del banner
    });

    await page.close();
    return Buffer.from(screenshot);
  } finally {
    // Con Browserless, close() (no disconnect()) es lo que termina la sesión
    // remota y libera el slot de concurrencia.
    await browser.close();
  }
}
