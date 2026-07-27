import { ZipArchive, type ArchiverError } from "archiver";
import type { Incidencia } from "@/lib/types";

export type ZipFileEntry = { path: string; content: Buffer | string };

/** Construye el ZIP en memoria (sin tocar disco) a partir de una lista de entradas. */
export async function buildZipBuffer(entries: ZipFileEntry[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const chunks: Buffer[] = [];

    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("warning", (err: ArchiverError) => {
      if (err.code !== "ENOENT") reject(err);
    });
    archive.on("error", reject);

    for (const entry of entries) {
      archive.append(entry.content, { name: entry.path });
    }

    void archive.finalize();
  });
}

export function sanitizePathSegment(text: string): string {
  return text.trim().replace(/[^a-zA-Z0-9._-]+/g, "_");
}

/** `{cliente}_{producto}` (o solo `{cliente}` si no hay producto), saneado para nombre de fichero/carpeta. */
export function campaignSlug(cliente: string, producto: string | null): string {
  const clienteSlug = sanitizePathSegment(cliente);
  return producto ? `${clienteSlug}_${sanitizePathSegment(producto)}` : clienteSlug;
}

/**
 * Carpetas del ZIP para una pieza (Bloque 10 — dedupe de adstudio_formats por
 * tamaño, no por soporte): una por cada medio en `soportes[]`, o `nombre_soporte`
 * (el tamaño) si no hay ningún medio asignado todavía. La pieza (HTML/PNGs/JPG)
 * se genera una única vez en trigger/render-adaptations.ts y sus buffers se
 * copian a cada una de estas carpetas, no se regeneran.
 */
export function pieceFoldersFor(format: {
  nombre_soporte: string;
  iab_format: string;
  soportes?: string[] | null;
}): string[] {
  const medios = format.soportes && format.soportes.length > 0 ? format.soportes : [format.nombre_soporte];
  return medios.map((medio) => `${sanitizePathSegment(medio)}/${format.iab_format}`);
}

export type ManifestPieceEntry = {
  nombreSoporte: string;
  iabFormat: string;
  width: number;
  height: number;
  jpgSizeBytes: number;
  htmlSizeBytes: number;
  incidencias: Incidencia[];
  /** Medios/carpetas del ZIP que llevan esta pieza (ver pieceFoldersFor). */
  soportes: string[];
};

/** manifest.json en la raíz del ZIP: dimensiones, peso, versión, fecha, incidencias por pieza. */
export function buildManifestJson(params: {
  cliente: string;
  producto: string | null;
  generatedAt: string;
  pieces: ManifestPieceEntry[];
}): string {
  return JSON.stringify(
    {
      cliente: params.cliente,
      producto: params.producto,
      generatedAt: params.generatedAt,
      version: 1,
      pieces: params.pieces,
    },
    null,
    2,
  );
}
