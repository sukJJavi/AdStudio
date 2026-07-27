/**
 * Renderiza un HTML5 como imagen PNG usando Browserless (browserless.io):
 * referencia visual real de cómo se ve la pieza (animación incluida, en el
 * frame inicial) para Claude Vision y para Replicate FLUX — ver
 * trigger/render-adaptations.ts (Opción A: Browserless + FLUX + Claude).
 */
export async function renderHtmlToImage(html: string, width: number, height: number): Promise<Buffer> {
  const response = await fetch(
    `https://production-sfo.browserless.io/screenshot?token=${process.env.BROWSERLESS_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: `data:text/html,${encodeURIComponent(html)}`,
        options: {
          type: "png",
          clip: { x: 0, y: 0, width, height },
        },
        setViewport: { width, height },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Browserless error: ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}
