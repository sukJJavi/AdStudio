import Replicate from "replicate";
import sharp from "sharp";
import { createClaudeClient } from "../claude/client";

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_KEY!,
});

const KONTEXT_ASPECT_RATIOS = [
  { ratio: "21:9", w: 21, h: 9 },
  { ratio: "16:9", w: 16, h: 9 },
  { ratio: "4:3", w: 4, h: 3 },
  { ratio: "3:2", w: 3, h: 2 },
  { ratio: "1:1", w: 1, h: 1 },
  { ratio: "2:3", w: 2, h: 3 },
  { ratio: "3:4", w: 3, h: 4 },
  { ratio: "9:16", w: 9, h: 16 },
  { ratio: "9:21", w: 9, h: 21 },
];

/**
 * flux-kontext-pro solo acepta aspect ratios predefinidos; los formatos IAB
 * casi nunca encajan exactos, así que se busca el más cercano y luego se
 * recorta al tamaño exacto con Sharp tras la generación.
 */
function closestAspectRatio(targetW: number, targetH: number): string {
  const targetRatio = targetW / targetH;
  let closest = KONTEXT_ASPECT_RATIOS[0];
  let minDiff = Infinity;
  for (const ar of KONTEXT_ASPECT_RATIOS) {
    const diff = Math.abs(ar.w / ar.h - targetRatio);
    if (diff < minDiff) {
      minDiff = diff;
      closest = ar;
    }
  }
  return closest.ratio;
}

async function uploadImageToReplicate(buffer: Buffer, mimeType: string, filename: string = "image.png"): Promise<string> {
  try {
    const formData = new FormData();
    const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
    formData.append("content", blob, filename);

    const response = await fetch("https://api.replicate.com/v1/files", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.REPLICATE_API_KEY}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Upload failed: ${response.status} - ${text}`);
    }

    const data = (await response.json()) as { urls: { get: string } };
    return data.urls.get;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Replicate failed: ${message}`);
  }
}

/**
 * Adapta una capa de imagen individual (background, imagen_principal) a un
 * nuevo formato IAB con FLUX Kontext: mantiene el sujeto principal visible y
 * deja espacio libre para el resto de assets (texto, logo, CTA), que Claude
 * Vision posiciona por encima en trigger/render-adaptations.ts.
 */
export async function adaptImageAsset(
  imageBuffer: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Promise<Buffer> {
  // 1. Claude Vision identifica el sujeto principal.
  let subjectDescription = "main visual subject";
  try {
    const visionResponse = await createClaudeClient().messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: imageBuffer.toString("base64"),
              },
            },
            {
              type: "text",
              text: "Describe in 10 words max the main subject of this image. Focus on people, products or key visual elements.",
            },
          ],
        },
      ],
    });
    if (visionResponse.content[0].type === "text") {
      subjectDescription = visionResponse.content[0].text;
    }
  } catch {
    // Si Claude Vision falla, continúa con descripción genérica.
  }

  console.log("Subject detected:", subjectDescription);
  console.log("Adapting asset:", `${sourceWidth}x${sourceHeight} → ${targetWidth}x${targetHeight}`);

  // 2. Sube imagen a Replicate.
  const imageUrl = await uploadImageToReplicate(imageBuffer, "image/png", "asset.png");

  // 3. FLUX Kontext adapta la imagen al ratio predefinido más cercano.
  try {
    const aspectRatio = closestAspectRatio(targetWidth, targetHeight);

    const output = await replicate.run("black-forest-labs/flux-kontext-pro", {
      input: {
        input_image: imageUrl,
        prompt: `Reframe this advertising image from ${sourceWidth}x${sourceHeight}px
to ${targetWidth}x${targetHeight}px.
Main subject: ${subjectDescription}.
Keep the main subject clearly visible and well-framed.
Leave negative space for text overlay on sides or bottom.
Maintain original colors, lighting and atmosphere.
No text generation. No watermarks.`,
        aspect_ratio: aspectRatio,
        output_format: "png",
        safety_tolerance: 6,
      },
    });

    const resultUrl = Array.isArray(output) ? output[0] : (output as unknown as string);
    const imageResponse = await fetch(resultUrl);
    if (!imageResponse.ok) {
      throw new Error(`Download failed: ${imageResponse.status}`);
    }
    const fluxBuffer = Buffer.from(await imageResponse.arrayBuffer());

    // 4. Recorta/redimensiona al tamaño exacto del formato IAB.
    return await sharp(fluxBuffer)
      .resize(targetWidth, targetHeight, {
        fit: "cover",
        position: "centre",
      })
      .png()
      .toBuffer();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Replicate adaptImageAsset failed: ${message}`);
  }
}
