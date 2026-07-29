export type FormatLevel = "nivel1" | "nivel2";

/**
 * Clasifica un formato destino frente al master según cuánto se aleja su
 * ratio de aspecto — determina si la adaptación puede resolverse con un
 * escalado geométrico puro (Nivel 1, ver lib/render/geometric-scale-adaptation.ts)
 * o necesita el pipeline completo de FLUX + Claude Vision con revisión manual
 * por chat (Nivel 2, ver trigger/render-adaptations.ts y lib/adaptation-refine.ts).
 * Reutilizado también en lib/production.ts para mostrar el nivel en la UI.
 */
export function classifyFormat(
  masterWidth: number,
  masterHeight: number,
  targetWidth: number,
  targetHeight: number,
): FormatLevel {
  const masterRatio = masterWidth / masterHeight;
  const targetRatio = targetWidth / targetHeight;
  const ratioDiff = Math.abs(masterRatio - targetRatio) / masterRatio;
  return ratioDiff < 0.35 ? "nivel1" : "nivel2";
}
