export type FormatLevel = "nivel1" | "nivel2";

/**
 * Distancia perceptual entre dos ratios de aspecto — el logaritmo hace la
 * métrica simétrica (2:1 y 1:2 quedan igual de lejos de 1:1) y captura mejor
 * la cercanía "de forma" que una diferencia relativa lineal, que sobrepondera
 * los ratios ultra-anchos (bug previo: un 300x250 casi cuadrado se asignaba a
 * un master 728x90 en vez de al 300x600, porque |ratioA-ratioB|/ratioA no
 * refleja que 250:300 se parece mucho más a 600:300 que a 90:728).
 */
export function ratioDistance(ratioA: number, ratioB: number): number {
  return Math.abs(Math.log(ratioA) - Math.log(ratioB));
}

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
  return ratioDistance(masterRatio, targetRatio) < 0.4 ? "nivel1" : "nivel2";
}
