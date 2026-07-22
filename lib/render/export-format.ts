import sharp from "sharp";

/**
 * Nombre de fichero "lógico" del asset en el HTML5/ZIP: el PNG original en
 * Storage (fuente única, ver trigger/analyze-psd.ts) nunca cambia de nombre ni
 * de formato, pero si el usuario activó `export_as_jpg` en el editor de capas
 * el fichero que entra en el ZIP (y la referencia en el HTML5 de Claude) debe
 * llevar extensión .jpg.
 */
export function exportFilenameFor(pngFilename: string, exportAsJpg: boolean): string {
  if (!exportAsJpg) return pngFilename;
  return pngFilename.replace(/\.png$/i, ".jpg");
}

/**
 * Convierte el PNG original a JPG calidad 85 si `export_as_jpg` está activo;
 * si no, devuelve el buffer PNG tal cual. Se aplica solo al construir el ZIP
 * (trigger/render-master.ts, trigger/render-adaptations.ts) — el PNG en
 * Storage se mantiene siempre como fuente para el thumbnail del editor y
 * futuras conversiones.
 */
export async function exportBufferFor(pngBuffer: Buffer, exportAsJpg: boolean): Promise<Buffer> {
  if (!exportAsJpg) return pngBuffer;
  return sharp(pngBuffer).jpeg({ quality: 85 }).toBuffer();
}
