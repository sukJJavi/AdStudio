/**
 * Nombres reservados para clasificaciones persistentes (presentes en todos los
 * frames) — usados por el HTML5 generado por Claude (ver lib/render/html5-generator.ts)
 * para referenciar assets por rol sin depender del frame.
 */
export const PERSISTENT_FILENAMES: Partial<Record<string, string>> = {
  fondo: "background",
  logo: "logo",
  cta: "cta",
  disclaimer: "legal",
};

export function sanitizeFilenameBase(name: string): string {
  const sanitized = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "");
  return sanitized || "layer";
}

/**
 * Nombre base (sin ".png" ni índice de desambiguación) del PNG exportado de una
 * capa, según su clasificación/frame — ver Bloque HTML5 en CLAUDE.md:
 * - persistente con rol reservado (fondo/logo/cta/disclaimer) -> nombre fijo
 * - con frame -> `f{N}_{classification}`
 * - "desconocido" -> nombre original de la capa del PSD, saneado
 * - resto (persistente sin rol reservado, o sin frame ni persistent) -> classification tal cual
 *
 * Usado en trigger/analyze-psd.ts (asignación inicial) y en
 * app/api/layers/asset/[assetId]/route.ts (renombrado al cambiar classification).
 */
export function baseFilenameFor(params: {
  classification: string;
  frame: number | null;
  persistent: boolean;
  layerName: string;
}): string {
  const { classification, frame, persistent, layerName } = params;

  if (classification === "desconocido") {
    return sanitizeFilenameBase(layerName);
  }

  if (persistent) {
    return PERSISTENT_FILENAMES[classification] ?? classification;
  }

  if (frame != null) {
    return `f${frame}_${classification}`;
  }

  return classification;
}

/**
 * Añade índice de desambiguación (`_2`, `_3`, ...) si el nombre base ya se usó
 * en el proyecto. Siempre `.png` — la decisión de exportar como JPG es del
 * usuario (`adstudio_assets.export_as_jpg`) y se aplica en el momento de
 * construir el ZIP (trigger/render-master.ts, trigger/render-adaptations.ts),
 * no aquí.
 */
export function uniqueFilename(base: string, usedCounts: Map<string, number>): string {
  const count = (usedCounts.get(base) ?? 0) + 1;
  usedCounts.set(base, count);
  return count === 1 ? `${base}.png` : `${base}_${count}.png`;
}
