/**
 * User-Agent de un Safari antiguo sin soporte WOFF2 conocido por Google —
 * al no reconocer un navegador moderno, la API css2 de Google Fonts devuelve
 * el fallback en TTF/OTF en vez de WOFF2. Satori solo soporta TTF/OTF/WOFF
 * (no WOFF2), así que hace falta este truco para poder pasarle la fuente.
 * Mismo User-Agent que usa el propio playground oficial de Satori para esto.
 */
const LEGACY_USER_AGENT =
  "Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8; de-at) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1";

/**
 * Descarga el archivo real (TTF/OTF) de una Google Font para pasarlo a Satori
 * (`fonts: [{ data, ... }]` en `renderBannerToJpg`). Satori no acepta fuentes
 * por URL — necesita los bytes.
 */
export async function loadGoogleFont(family: string, weight: 400 | 700 = 400): Promise<Buffer> {
  const familyParam = family.trim().replace(/\s+/g, "+");
  const cssUrl = `https://fonts.googleapis.com/css2?family=${familyParam}:wght@${weight}&display=swap`;

  const cssResponse = await fetch(cssUrl, { headers: { "User-Agent": LEGACY_USER_AGENT } });
  if (!cssResponse.ok) {
    throw new Error(`No se pudo resolver Google Fonts para "${family}" (${cssResponse.status}).`);
  }
  const css = await cssResponse.text();

  const match = css.match(/src: url\((.+?)\) format\('(truetype|opentype)'\)/);
  if (!match) {
    throw new Error(
      `No se encontró una fuente TTF/OTF para "${family}" (peso ${weight}) en la respuesta de Google Fonts.`,
    );
  }

  const fontResponse = await fetch(match[1]);
  if (!fontResponse.ok) {
    throw new Error(`No se pudo descargar el archivo de "${family}" (${fontResponse.status}).`);
  }

  return Buffer.from(await fontResponse.arrayBuffer());
}

const FALLBACK_FONT = "Inter";

/**
 * Igual que `loadGoogleFont`, pero nunca bloquea el render: la tipografía
 * detectada en el PSD puede no existir en Google Fonts (o no coincidir
 * exactamente con su nombre real), y eso no debe tirar abajo el job — las
 * capas de texto se exportan como PNG (ver trigger/analyze-psd.ts), así que
 * la tipografía real del PSD no afecta al render del fallback.jpg/png; el
 * único uso de esta fuente es el claim/subclaim/CTA que compone Satori.
 */
export async function loadGoogleFontWithFallback(family: string, weight: 400 | 700 = 400): Promise<Buffer> {
  try {
    return await loadGoogleFont(family, weight);
  } catch (error) {
    console.error(`No se pudo cargar la fuente "${family}" (peso ${weight}), usando fallback Inter:`, error);
    if (family === FALLBACK_FONT) throw error;
    return loadGoogleFont(FALLBACK_FONT, weight);
  }
}
