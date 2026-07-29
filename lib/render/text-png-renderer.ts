import { createCanvas, registerFont, type CanvasRenderingContext2D as NodeCanvasRenderingContext2D } from "canvas";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";

export interface TextRenderOptions {
  /** El text_content de la capa. */
  text: string;
  /** TTF/OTF de la fuente (ver lib/render/font-resolver.ts). */
  fontBuffer: Buffer;
  /** Nombre para registrar en canvas. */
  fontName: string;
  /** fontSize de Photoshop (metadata.fontSize de la capa). */
  sourceFontSize: number;
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

const registeredFontFamilies = new Set<string>();

function wrapText(
  ctx: NodeCanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  // Respeta saltos de línea existentes del text_content.
  const paragraphs = text.split("\n");
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    const words = paragraph.split(" ");
    let currentLine = "";

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const metrics = ctx.measureText(testLine);

      if (metrics.width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    lines.push(currentLine);
  }

  return lines;
}

/**
 * Renderiza una capa de texto como PNG con la tipografía custom del cliente,
 * escalando fontSize y área disponible del PSD master al formato destino —
 * usado en trigger/render-adaptations.ts para sustituir el PNG de texto del
 * master cuando hay una fuente propia resuelta (ver lib/render/font-resolver.ts).
 */
export async function renderTextAsPng(opts: TextRenderOptions): Promise<Buffer> {
  // 1. Escala uniforme master -> formato destino, basada en la altura (igual
  // criterio que el resto del pipeline de adaptaciones: un único factor de
  // escala evita deformar el texto si el formato destino cambia de ratio).
  const scaleFactor = opts.targetHeight / opts.sourcePsdHeight;
  let fontSize = Math.round(opts.sourceFontSize * scaleFactor);
  fontSize = Math.max(8, Math.min(fontSize, 200)); // clamp

  // 2. Área disponible en el formato destino — bounds del master escalados.
  const areaWidth = Math.max(1, Math.round(opts.sourceLayerBounds.width * scaleFactor));
  const areaHeight = Math.max(1, Math.round(opts.sourceLayerBounds.height * scaleFactor));

  // 3. Registrar la fuente en node-canvas — necesita un path real en disco.
  // El family name debe ser simple: un fontName tal cual viene de Photoshop
  // (p. ej. "FranklinGothicATF-BoldItalic") incluye guiones/sufijos de peso
  // que ctx.font no resuelve como family — normalizado a "Franklin Gothic ATF".
  const familyName = opts.fontName
    .split("-")[0]
    .replace(/([A-Z])/g, " $1")
    .trim();

  const fontFormatHint = opts.fontBuffer.subarray(0, 4).toString("hex") === "774f4646" ? "woff" : "ttf";
  const tmpFontPath = path.join(os.tmpdir(), `adstudio_font_${randomUUID()}.${fontFormatHint}`);
  fs.writeFileSync(tmpFontPath, opts.fontBuffer);

  console.log("Registering font:", {
    family: familyName,
    path: tmpFontPath,
    exists: fs.existsSync(tmpFontPath),
    size: fs.statSync(tmpFontPath).size,
  });

  try {
    // registerFont no soporta reemplazar una familia ya registrada — cada
    // fuente custom se registra una única vez por proceso (worker de
    // Trigger.dev), identificada por su family name normalizado.
    if (!registeredFontFamilies.has(familyName)) {
      registerFont(tmpFontPath, { family: familyName });
      registeredFontFamilies.add(familyName);
      console.log("Font registered successfully:", familyName);
    }
  } catch (err) {
    // Si el registro falla (formato no soportado, ya registrada, etc.),
    // continúa: canvas cae a la fuente por defecto en vez de reventar el render.
    console.error("Font registration error:", familyName, err);
  }

  // 4. Crear canvas y renderizar texto. El archivo temporal se borra DESPUÉS
  // de toBuffer(): node-canvas resuelve la fuente registrada de forma lazy al
  // renderizar el texto, no en el momento de registerFont() — borrarlo antes
  // dejaba la fuente sin datos que leer y el texto salía en blanco.
  const canvas = createCanvas(areaWidth, areaHeight);
  const ctx = canvas.getContext("2d");

  ctx.clearRect(0, 0, areaWidth, areaHeight);
  ctx.fillStyle = opts.textColor ?? "#FFFFFF";
  ctx.textBaseline = "top";

  let finalFontSize = fontSize;
  ctx.font = `bold ${finalFontSize}px "${familyName}"`;
  let lines = wrapText(ctx, opts.text, areaWidth);

  // Si el texto no cabe con el fontSize calculado, reducir hasta que quepa.
  while (lines.length * (finalFontSize * 1.2) > areaHeight && finalFontSize > 8) {
    finalFontSize -= 2;
    ctx.font = `bold ${finalFontSize}px "${familyName}"`;
    lines = wrapText(ctx, opts.text, areaWidth);
  }

  console.log("Rendering text:", {
    text: opts.text.substring(0, 30),
    font: ctx.font,
    areaWidth,
    areaHeight,
    fontSize: finalFontSize,
  });

  const lineHeight = finalFontSize * 1.2;
  lines.forEach((line, i) => {
    ctx.fillText(line, 0, i * lineHeight);
  });

  // node-canvas en Linux (Trigger.dev) a veces no puede rasterizar una fuente
  // TTF custom y la renderiza como tofu (glifos vacíos) sin lanzar error — se
  // detecta comprobando si algún pixel no-alpha tiene contenido real; si no,
  // se re-renderiza con la fuente del sistema para que el texto sea legible.
  const imageData = ctx.getImageData(0, 0, areaWidth, areaHeight);
  const hasContent = imageData.data.some((val, i) => i % 4 !== 3 && val > 0);

  if (!hasContent) {
    console.warn("Font rendered as tofu, falling back to system font:", familyName);
    ctx.clearRect(0, 0, areaWidth, areaHeight);
    ctx.fillStyle = opts.textColor ?? "#FFFFFF";
    ctx.textBaseline = "top";
    ctx.font = `bold ${finalFontSize}px sans-serif`;
    lines.forEach((line, i) => {
      ctx.fillText(line, 0, i * lineHeight);
    });
  }

  const buffer = canvas.toBuffer("image/png");

  // Limpiar DESPUÉS de toBuffer().
  try {
    fs.unlinkSync(tmpFontPath);
  } catch {
    // Best-effort: el archivo temporal ya no hace falta una vez rasterizado el PNG.
  }

  return buffer;
}
