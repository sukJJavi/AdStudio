export type SplitCopy = {
  claim: string | null;
  subclaim: string | null;
  disclaimer: string | null;
};

/**
 * `adstudio_formats.copy` es un único campo de texto libre (ver Bloque 1).
 * Convención: línea 1 = claim, línea 2 = subclaim, línea 3 = disclaimer.
 * El CTA reutiliza el claim (línea 1) — "botón con texto del copy" (Bloque 2).
 */
export function splitCopy(copy: string | null): SplitCopy {
  if (!copy) return { claim: null, subclaim: null, disclaimer: null };
  const lines = copy
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    claim: lines[0] ?? null,
    subclaim: lines[1] ?? null,
    disclaimer: lines[2] ?? null,
  };
}
