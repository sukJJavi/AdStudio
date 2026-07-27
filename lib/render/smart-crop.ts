import sharp from "sharp";
import { createClaudeClient } from "@/lib/claude/client";

export type SmartCropResult = {
  buffer: Buffer;
  cropBox: { x: number; y: number; width: number; height: number };
};

/**
 * Diferencia de proporción a partir de la cual un resize directo distorsiona
 * demasiado el contenido y hace falta reencuadrar (ver smartCrop más abajo).
 */
const RATIO_DIFF_THRESHOLD = 0.2;

/**
 * Cache en memoria durante la ejecución del job (trigger/render-adaptations.ts
 * procesa 5-10 formatos por proyecto, y varios comparten la misma proporción
 * origen→destino): evita llamar a Claude Vision más de una vez por combinación
 * de dimensiones. Clave deliberadamente basada solo en dimensiones (no en el
 * contenido de la imagen) — asume que, dentro de una misma ejecución, la
 * imagen_principal y el fondo del proyecto no comparten exactamente las mismas
 * dimensiones de origen; si lo hicieran, compartirían crop, que es la
 * limitación aceptada a cambio de no tener que hashear el buffer en cada llamada.
 */
const cropCache = new Map<string, SmartCropResult>();

function cacheKey(sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number): string {
  return `${sourceWidth}x${sourceHeight}_to_${targetWidth}x${targetHeight}`;
}

type ClaudeCropBox = { x: number; y: number; width: number; height: number };

function centerCropFallback(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): ClaudeCropBox {
  const targetAspect = targetWidth / targetHeight;
  const sourceRatio = sourceWidth / sourceHeight;

  if (targetAspect > sourceRatio) {
    // Más ancho que la fuente: recortar altura.
    const newHeight = Math.round(sourceWidth / targetAspect);
    return { x: 0, y: Math.round((sourceHeight - newHeight) / 2), width: sourceWidth, height: newHeight };
  }

  // Más alto que la fuente: recortar ancho.
  const newWidth = Math.round(sourceHeight * targetAspect);
  return { x: Math.round((sourceWidth - newWidth) / 2), y: 0, width: newWidth, height: sourceHeight };
}

function isValidCropBox(
  box: Partial<ClaudeCropBox> | null | undefined,
  sourceWidth: number,
  sourceHeight: number,
): box is ClaudeCropBox {
  return (
    !!box &&
    typeof box.x === "number" &&
    typeof box.y === "number" &&
    typeof box.width === "number" &&
    typeof box.height === "number" &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.width > 0 &&
    box.height > 0 &&
    box.x + box.width <= sourceWidth &&
    box.y + box.height <= sourceHeight
  );
}

/**
 * Pide a Claude Vision la zona de interés (producto, persona, elemento clave)
 * de una imagen para recortarla a un formato de proporción muy distinta. Si
 * Claude no responde un JSON válido (o el recorte no encaja en la imagen),
 * se degrada a un center crop calculado localmente.
 */
async function detectCropBox(
  imageBuffer: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Promise<ClaudeCropBox> {
  const client = createClaudeClient();

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: imageBuffer.toString("base64") },
          },
          {
            type: "text",
            text: `Esta imagen es ${sourceWidth}x${sourceHeight}px.
Necesito recortarla para un banner de ${targetWidth}x${targetHeight}px.
Identifica la zona de interés principal (producto, persona, elemento clave).
Responde SOLO con un JSON sin explicaciones:
{"x": número, "y": número, "width": número, "height": número}
Donde x,y,width,height definen el recorte óptimo en píxeles
de la imagen original que mejor representa el contenido
para el formato destino. El recorte debe tener la misma
proporción que ${targetWidth}x${targetHeight}.`,
          },
        ],
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";

  try {
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim()) as Partial<ClaudeCropBox>;
    if (isValidCropBox(parsed, sourceWidth, sourceHeight)) return parsed;
  } catch {
    // Claude no devolvió JSON parseable — cae al center crop de abajo.
  }

  return centerCropFallback(sourceWidth, sourceHeight, targetWidth, targetHeight);
}

/**
 * Reencuadra una imagen para un formato de proporción muy distinta a la
 * original. Con proporciones similares (< RATIO_DIFF_THRESHOLD de diferencia)
 * hace un resize/cover directo sin gastar una llamada a Claude — un simple
 * `cover` ya queda bien y no vale la pena el coste ni la latencia.
 */
export async function smartCrop(
  imageBuffer: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Promise<SmartCropResult> {
  const key = cacheKey(sourceWidth, sourceHeight, targetWidth, targetHeight);
  const cached = cropCache.get(key);
  if (cached) return cached;

  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = targetWidth / targetHeight;
  const ratioDiff = Math.abs(sourceRatio - targetRatio) / sourceRatio;
  const usedClaude = ratioDiff >= RATIO_DIFF_THRESHOLD;

  let result: SmartCropResult;

  if (!usedClaude) {
    const resized = await sharp(imageBuffer)
      .resize(targetWidth, targetHeight, { fit: "cover", position: "center" })
      .png()
      .toBuffer();
    result = { buffer: resized, cropBox: { x: 0, y: 0, width: sourceWidth, height: sourceHeight } };
  } else {
    const cropBox = await detectCropBox(imageBuffer, sourceWidth, sourceHeight, targetWidth, targetHeight);
    const buffer = await sharp(imageBuffer)
      .extract({
        left: Math.round(cropBox.x),
        top: Math.round(cropBox.y),
        width: Math.round(cropBox.width),
        height: Math.round(cropBox.height),
      })
      .resize(targetWidth, targetHeight)
      .png()
      .toBuffer();
    result = { buffer, cropBox };
  }

  console.log("Smart crop:", {
    from: `${sourceWidth}x${sourceHeight}`,
    to: `${targetWidth}x${targetHeight}`,
    ratioDiff: ratioDiff.toFixed(2),
    usedClaude,
    cropBox: result.cropBox,
  });

  cropCache.set(key, result);
  return result;
}
