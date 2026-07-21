import { GSAP_CDN_URL, buildGsapAnimationScript } from "@/lib/animation/gsap-preset";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * `adstudio_formats.copy` es un único campo de texto libre (ver Bloque 1).
 * Convención: línea 1 = claim, línea 2 = subclaim, línea 3 = disclaimer.
 * El CTA reutiliza el claim (línea 1) — "botón con texto del copy" (Bloque 2).
 */
export function splitCopy(copy: string | null): {
  claim: string | null;
  subclaim: string | null;
  disclaimer: string | null;
} {
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

export type CanvasLayout = {
  width: number;
  height: number;
  safeZonePx: number;
  backgroundSrc: string | null;
  mainImageSrc: string | null;
  mainImageMaxWidthPct: number;
  mainImageMaxHeightPct: number;
  logoSrc: string | null;
  logoWidthPx: number;
  logoHeightPx: number;
  claim: string | null;
  claimFontSizePx: number;
  claimTopPx: number;
  subclaim: string | null;
  subclaimFontSizePx: number;
  subclaimTopPx: number;
  cta: string | null;
  ctaFontSizePx: number;
  ctaHeightPx: number;
  ctaPaddingHorizontalPx: number;
  disclaimer: string | null;
  /** Stack CSS completo, p. ej. `"Montserrat", Arial, Helvetica, sans-serif`. */
  fontFamily: string;
  /** URL de Google Fonts a importar, o null si no hay tipografía web que cargar. */
  googleFontImportUrl: string | null;
  /** Si es true, incluye GSAP + el timeline de animación por defecto. Si es false, los elementos quedan en su estado final estático. */
  animated: boolean;
};

export function buildCanvasHtml(layout: CanvasLayout): string {
  const {
    width,
    height,
    safeZonePx: safe,
    backgroundSrc,
    mainImageSrc,
    mainImageMaxWidthPct,
    mainImageMaxHeightPct,
    logoSrc,
    logoWidthPx,
    logoHeightPx,
    claim,
    claimFontSizePx,
    claimTopPx,
    subclaim,
    subclaimFontSizePx,
    subclaimTopPx,
    cta,
    ctaFontSizePx,
    ctaHeightPx,
    ctaPaddingHorizontalPx,
    disclaimer,
    fontFamily,
    googleFontImportUrl,
    animated,
  } = layout;

  const fontImportStyle = googleFontImportUrl ? `<style>@import url('${googleFontImportUrl}');</style>` : "";

  const initialAnimationState = animated
    ? `
  .background, .main-image { opacity: 0; }
  .claim { opacity: 0; }
  .subclaim { opacity: 0; }
  .cta { opacity: 0; }
`
    : "";

  const animationScripts = animated
    ? `<script src="${GSAP_CDN_URL}"></script>
<script>${buildGsapAnimationScript()}</script>`
    : "";

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
${fontImportStyle}
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
  .canvas {
    position: relative;
    width: ${width}px;
    height: ${height}px;
    background-color: #FFFFFF;
    font-family: Arial, Helvetica, sans-serif;
  }
  .background { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .main-image {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    max-width: ${mainImageMaxWidthPct}%;
    max-height: ${mainImageMaxHeightPct}%;
    object-fit: contain;
  }
  .logo {
    position: absolute;
    top: ${safe}px;
    left: ${safe}px;
    width: ${logoWidthPx}px;
    height: auto;
    max-height: ${logoHeightPx}px;
    object-fit: contain;
  }
  .claim {
    position: absolute;
    top: ${claimTopPx}px;
    left: ${safe}px;
    right: ${safe}px;
    font-family: ${fontFamily};
    font-weight: bold;
    font-size: ${claimFontSizePx}px;
    line-height: 1.1;
    color: #111111;
    text-shadow: 0 1px 3px rgba(255,255,255,0.6);
  }
  .subclaim {
    position: absolute;
    top: ${subclaimTopPx}px;
    left: ${safe}px;
    right: ${safe}px;
    font-family: ${fontFamily};
    font-weight: normal;
    font-size: ${subclaimFontSizePx}px;
    color: #333333;
  }
  .cta {
    position: absolute;
    bottom: ${safe}px;
    right: ${safe}px;
    background: #000000;
    color: #FFFFFF;
    font-family: ${fontFamily};
    font-size: ${ctaFontSizePx}px;
    font-weight: bold;
    height: ${ctaHeightPx}px;
    line-height: ${ctaHeightPx}px;
    padding: 0 ${ctaPaddingHorizontalPx}px;
    border-radius: 4px;
    white-space: nowrap;
  }
  .disclaimer {
    position: absolute;
    bottom: ${safe}px;
    left: ${safe}px;
    max-width: 55%;
    font-size: 10px;
    color: #555555;
  }
${initialAnimationState}
</style>
</head>
<body>
  <div class="canvas">
    ${backgroundSrc ? `<img class="background" src="${backgroundSrc}" alt="" />` : ""}
    ${mainImageSrc ? `<img class="main-image" src="${mainImageSrc}" alt="" />` : ""}
    ${logoSrc ? `<img class="logo" src="${logoSrc}" alt="" />` : ""}
    ${claim ? `<div class="claim">${escapeHtml(claim)}</div>` : ""}
    ${subclaim ? `<div class="subclaim">${escapeHtml(subclaim)}</div>` : ""}
    ${cta ? `<div class="cta">${escapeHtml(cta)}</div>` : ""}
    ${disclaimer ? `<div class="disclaimer">${escapeHtml(disclaimer)}</div>` : ""}
  </div>
${animationScripts}
</body>
</html>`;
}
