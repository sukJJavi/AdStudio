import chromium from "@sparticuz/chromium";
import puppeteer, { type Browser } from "puppeteer-core";

/**
 * Lanza Chromium vía `@sparticuz/chromium` + `puppeteer-core` — el paquete
 * `puppeteer` (con su propio Chromium completo) no es viable en el entorno
 * serverless de Vercel/Trigger.dev por tamaño; este combo usa el binario
 * comprimido de `@sparticuz/chromium`, pensado para ese entorno.
 *
 * `chromium.defaultViewport`/`chromium.headless` no existen en la versión
 * instalada (v149) — el patrón vigente de la librería (ver su README) es
 * `headless: "shell"` + `puppeteer.defaultArgs({ args: chromium.args, headless: "shell" })`.
 * No hace falta pasar `defaultViewport` aquí: cada render llama a
 * `page.setViewport()` con las dimensiones exactas del canvas antes de
 * capturar, así que el viewport de lanzamiento es irrelevante.
 *
 * Llamar siempre dentro de un try/finally y cerrar el browser devuelto en
 * el finally, para no dejar procesos de Chromium huérfanos si el job falla
 * a mitad de un render.
 */
export async function launchBrowser(): Promise<Browser> {
  return puppeteer.launch({
    args: await puppeteer.defaultArgs({ args: chromium.args, headless: "shell" }),
    executablePath: await chromium.executablePath(),
    headless: "shell",
  });
}
