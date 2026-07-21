/** 20 Google Fonts más usadas en publicidad display, para el selector de tipografía del master. */
export const GOOGLE_FONTS = [
  "Inter",
  "Montserrat",
  "Roboto",
  "Open Sans",
  "Lato",
  "Poppins",
  "Raleway",
  "Oswald",
  "Playfair Display",
  "Nunito",
  "Source Sans Pro",
  "PT Sans",
  "Ubuntu",
  "Barlow",
  "DM Sans",
  "Plus Jakarta Sans",
  "Outfit",
  "Syne",
  "Space Grotesk",
  "Bricolage Grotesque",
] as const;

export const DEFAULT_FONT = "Inter";

/**
 * URL de Google Fonts (familia normal + bold) para `@import`/`<link>`.
 * Funciona igual para fuentes fuera de la lista (p. ej. una detectada del PSD
 * que no sea una Google Font real) — en ese caso Google Fonts devuelve una
 * hoja vacía y el navegador cae al fallback Arial declarado en el font-stack.
 */
export function googleFontUrl(fontName: string): string {
  const family = fontName.trim().replace(/\s+/g, "+");
  return `https://fonts.googleapis.com/css2?family=${family}:wght@400;700&display=swap`;
}

/** font-family CSS con fallback a Arial/sans-serif si la Google Font no carga. */
export function fontFamilyStack(fontName: string): string {
  return `"${fontName}", Arial, Helvetica, sans-serif`;
}
