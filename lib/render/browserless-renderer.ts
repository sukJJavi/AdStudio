import puppeteer from "puppeteer-core";

/**
 * Renderiza el HTML5 del master como imagen PNG conectando por WebSocket a un
 * navegador remoto de Browserless (browserless.io): referencia visual real de
 * cómo se ve la pieza (animación incluida, en el frame inicial) para Claude
 * Vision y para Replicate FLUX — ver trigger/render-adaptations.ts (Opción A:
 * Browserless + FLUX + Claude).
 *
 * En vez de servir el HTML inline (`page.setContent()`), navega a
 * `/api/preview/[projectId]` — la misma ruta pública que ya usa el iframe del
 * master (components/project/master-view.tsx) — porque esa ruta reescribe los
 * `src` de los assets a `/api/preview/[projectId]/assets/[filename]`
 * (Storage real). Con `setContent()` esos `src` relativos no resuelven a nada
 * (no hay origen detrás de un HTML inline), así que el screenshot salía sin
 * imágenes.
 */
export async function renderHtmlToImage(projectId: string, width: number, height: number): Promise<Buffer> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    throw new Error("NEXT_PUBLIC_APP_URL no está configurada — necesaria para que Browserless navegue al preview.");
  }

  const url = `${appUrl}/api/preview/${projectId}`;

  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_API_KEY}`,
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    // Esperar a que las imágenes carguen (los <img src="..."> del HTML del
    // master apuntan a Storage vía /api/preview/.../assets/..., no están
    // garantizadas por networkidle2 si tardan más que el resto de la red).
    await page.evaluate(() => {
      return Promise.all(
        Array.from(document.images)
          .filter((img) => !img.complete)
          .map(
            (img) =>
              new Promise((resolve) => {
                img.onload = img.onerror = resolve;
              }),
          ),
      );
    });

    const screenshot = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width, height },
    });

    return Buffer.from(screenshot);
  } finally {
    // Con Browserless, close() (no disconnect()) es lo que termina la sesión
    // remota y libera el slot de concurrencia — dejarla abierta cuenta como
    // uso facturable hasta que expire por timeout.
    await browser.close();
  }
}
