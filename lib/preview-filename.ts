/**
 * Rechaza un `filename` de ruta dinámica (app/api/preview/**\/assets/[filename]) que intente
 * escapar de la carpeta esperada en Storage — tanto en crudo como URL-encoded, por si el
 * runtime deja pasar algún segmento sin decodificar del todo.
 */
export function isUnsafeFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  return (
    filename.includes("..") ||
    filename.includes("/") ||
    filename.includes("\\") ||
    lower.includes("%2e%2e") ||
    lower.includes("%2f") ||
    lower.includes("%5c")
  );
}
