import { createClaudeClient } from "@/lib/claude/client";

/**
 * Vocabulario cerrado de clasificación de capas — ver .claude/skills/psd-analysis.md.
 * No añadir valores nuevos aquí sin actualizar ese documento y la UI que renderiza
 * el campo (components/incident-report).
 */
export const LAYER_CLASSIFICATIONS = [
  "logo",
  "imagen_principal",
  "claim",
  "subclaim",
  "cta",
  "disclaimer",
  "fondo",
  "decorativo",
  "desconocido",
] as const;

export type LayerClassification = (typeof LAYER_CLASSIFICATIONS)[number];

const CLASSIFICATION_PROMPT = `Eres un técnico de producción publicitaria. Clasifica este elemento visual en exactamente una de estas categorías:
logo | imagen_principal | claim | subclaim | cta | disclaimer | fondo | decorativo | desconocido
Responde SOLO con la categoría, sin explicación.`;

function isLayerClassification(value: string): value is LayerClassification {
  return (LAYER_CLASSIFICATIONS as readonly string[]).includes(value);
}

/**
 * Clasifica una capa aplanada a PNG usando Claude Vision.
 * Si el modelo devuelve algo fuera del vocabulario cerrado, se degrada a "desconocido".
 */
export async function classifyLayerImage(pngBuffer: Buffer): Promise<LayerClassification> {
  const client = createClaudeClient();

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 20,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: pngBuffer.toString("base64"),
            },
          },
          { type: "text", text: CLASSIFICATION_PROMPT },
        ],
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const raw = textBlock && textBlock.type === "text" ? textBlock.text.trim().toLowerCase() : "";

  return isLayerClassification(raw) ? raw : "desconocido";
}
