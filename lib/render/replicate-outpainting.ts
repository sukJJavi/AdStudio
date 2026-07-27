import sharp from "sharp";
import Replicate from "replicate";

const replicate = new Replicate({ auth: process.env.REPLICATE_API_KEY! });

async function uploadImageToReplicate(
  buffer: Buffer,
  mimeType: string,
  filename: string = "image.png",
): Promise<string> {
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
 * Genera una imagen adaptada a un nuevo formato IAB a partir del render del
 * master (Opción A: Browserless + FLUX + Claude, ver
 * trigger/render-adaptations.ts). Con proporción similar (< 15% de diferencia)
 * usa FLUX Redux (variación/reencuadre); con proporción muy distinta compone
 * un canvas del tamaño destino con el master centrado y usa FLUX Fill
 * (outpainting) para extender el resto.
 */
export async function outpaintToFormat(
  masterImageBuffer: Buffer,
  masterWidth: number,
  masterHeight: number,
  targetWidth: number,
  targetHeight: number,
): Promise<Buffer> {
  console.log(
    "Replicate auth presente:",
    !!process.env.REPLICATE_API_KEY,
    "longitud:",
    process.env.REPLICATE_API_KEY?.length,
  );

  const aspectRatio = `${targetWidth}:${targetHeight}`;

  const sourceRatio = masterWidth / masterHeight;
  const targetRatio = targetWidth / targetHeight;
  const ratioDiff = Math.abs(sourceRatio - targetRatio) / sourceRatio;

  let output: string[];

  if (ratioDiff < 0.15) {
    // Ratio similar: FLUX Redux reencuadra/varía manteniendo la composición.
    // redux_image va como data URI: la URL de /v1/files solo es accesible
    // para el modelo durante la propia predicción de la subida, no sirve aquí.
    const masterBase64 = `data:image/png;base64,${masterImageBuffer.toString("base64")}`;

    try {
      output = (await replicate.run("black-forest-labs/flux-redux-dev", {
        input: {
          redux_image: masterBase64,
          aspect_ratio: aspectRatio,
          num_inference_steps: 25,
          guidance_scale: 3.5,
        },
      })) as string[];
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Replicate failed: ${message}`);
    }
  } else {
    // Ratio muy diferente: canvas del tamaño destino con el master centrado,
    // FLUX Fill extiende (outpainting) el resto.
    const canvasBuffer = await sharp({
      create: {
        width: targetWidth,
        height: targetHeight,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite([
        {
          input: await sharp(masterImageBuffer)
            .resize(Math.min(masterWidth, targetWidth), Math.min(masterHeight, targetHeight), { fit: "inside" })
            .toBuffer(),
          gravity: "center",
        },
      ])
      .png()
      .toBuffer();

    // flux-fill-dev no acepta base64 directamente: mantiene el upload a
    // /v1/files y usa la URL del archivo.
    const imageUrl = await uploadImageToReplicate(canvasBuffer, "image/png");
    console.log("Image URL subida a Replicate:", imageUrl.substring(0, 50));

    try {
      output = (await replicate.run("black-forest-labs/flux-fill-dev", {
        input: {
          image: imageUrl,
          prompt: "advertising banner background, same style and colors as the original image, professional, seamless extension",
          num_inference_steps: 28,
          guidance_scale: 30,
          strength: 0.85,
          output_format: "png",
        },
      })) as string[];
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Replicate failed: ${message}`);
    }
  }

  const resultUrl = Array.isArray(output) ? output[0] : output;
  const imageResponse = await fetch(resultUrl as string);
  return Buffer.from(await imageResponse.arrayBuffer());
}
