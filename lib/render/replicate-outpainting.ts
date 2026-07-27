import Replicate from "replicate";
import { createClaudeClient } from "../claude/client";

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_KEY!,
});

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

  // 3. FLUX Kontext adapta la imagen al nuevo formato.
  try {
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
        aspect_ratio: `${targetWidth}:${targetHeight}`,
        output_format: "png",
        safety_tolerance: 6,
      },
    });

    const resultUrl = Array.isArray(output) ? output[0] : (output as unknown as string);
    const imageResponse = await fetch(resultUrl);
    if (!imageResponse.ok) {
      throw new Error(`Download failed: ${imageResponse.status}`);
    }
    return Buffer.from(await imageResponse.arrayBuffer());
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Replicate adaptImageAsset failed: ${message}`);
  }
}
