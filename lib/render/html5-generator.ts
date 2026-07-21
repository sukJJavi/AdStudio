import { GSAP_CDN_URL, buildGsapAnimationScript } from "@/lib/animation/gsap-preset";
import { computeBannerLayout } from "@/lib/render/layout";

export type Html5BannerParams = {
  width: number;
  height: number;
  backgroundColor: string;
  backgroundImageBase64?: string | null;
  logoBase64?: string | null;
  logoAspectRatio?: number | null;
  mainImageBase64?: string | null;
  claim?: string | null;
  subclaim?: string | null;
  cta?: string | null;
  disclaimer?: string | null;
  fontFamily: string;
  googleFontImportUrl: string;
  /** JPG ya renderizado con Satori (`renderBannerToJpg`), en base64, para el `<noscript>`. */
  fallbackJpgBase64: string;
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function imgSrc(base64: string | null | undefined): string | null {
  return base64 ? `data:image/png;base64,${base64}` : null;
}

/**
 * Genera el HTML5 animado como string — autocontenido (assets embebidos en
 * base64, el peso de la propia plantilla sin contar esos assets se mantiene
 * muy por debajo del límite IAB LEAN de 150KB), con GSAP cargado desde CDN y
 * un `<noscript>` con el JPG de respaldo. No renderiza nada (no hay
 * Puppeteer ni ningún motor headless implicado) — es puro string building.
 */
export function generateHtml5(params: Html5BannerParams): string {
  const {
    width,
    height,
    backgroundColor,
    backgroundImageBase64,
    logoBase64,
    logoAspectRatio,
    mainImageBase64,
    claim,
    subclaim,
    cta,
    disclaimer,
    fontFamily,
    googleFontImportUrl,
    fallbackJpgBase64,
  } = params;

  const layout = computeBannerLayout({ width, height, hasLogo: !!logoBase64, logoAspectRatio });

  const backgroundSrc = imgSrc(backgroundImageBase64);
  const mainImageSrc = imgSrc(mainImageBase64);
  const logoSrc = imgSrc(logoBase64);

  const mainImageTop = Math.round((height - layout.mainImageBoxHeightPx) / 2);
  const mainImageLeft = Math.round((width - layout.mainImageBoxWidthPx) / 2);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>@import url('${googleFontImportUrl}');</style>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
  .canvas {
    position: relative;
    width: ${width}px;
    height: ${height}px;
    background-color: ${backgroundColor};
    font-family: Arial, Helvetica, sans-serif;
  }
  .background {
    position: absolute; inset: 0; width: 100%; height: 100%;
    object-fit: cover; opacity: 0;
  }
  .main-image {
    position: absolute;
    top: ${mainImageTop}px;
    left: ${mainImageLeft}px;
    width: ${layout.mainImageBoxWidthPx}px;
    height: ${layout.mainImageBoxHeightPx}px;
    object-fit: contain;
    opacity: 0;
  }
  .logo {
    position: absolute;
    top: ${layout.safeZonePx}px;
    left: ${layout.safeZonePx}px;
    width: ${layout.logoWidthPx}px;
    height: ${layout.logoHeightPx}px;
    object-fit: contain;
  }
  .claim {
    position: absolute;
    top: ${layout.claimTopPx}px;
    left: ${layout.safeZonePx}px;
    right: ${layout.safeZonePx}px;
    font-family: "${fontFamily}", Arial, Helvetica, sans-serif;
    font-weight: bold;
    font-size: ${layout.claimFontSizePx}px;
    line-height: 1.1;
    color: #111111;
    text-shadow: 0 1px 3px rgba(255,255,255,0.6);
    opacity: 0;
    transform: translateY(20px);
  }
  .subclaim {
    position: absolute;
    top: ${layout.subclaimTopPx}px;
    left: ${layout.safeZonePx}px;
    right: ${layout.safeZonePx}px;
    font-family: "${fontFamily}", Arial, Helvetica, sans-serif;
    font-weight: normal;
    font-size: ${layout.subclaimFontSizePx}px;
    color: #333333;
    opacity: 0;
  }
  .cta {
    position: absolute;
    bottom: ${layout.safeZonePx}px;
    right: ${layout.safeZonePx}px;
    background: #000000;
    color: #FFFFFF;
    font-family: "${fontFamily}", Arial, Helvetica, sans-serif;
    font-weight: bold;
    font-size: ${layout.ctaFontSizePx}px;
    height: ${layout.ctaHeightPx}px;
    line-height: ${layout.ctaHeightPx}px;
    padding: 0 ${layout.ctaPaddingHorizontalPx}px;
    border-radius: 4px;
    white-space: nowrap;
    opacity: 0;
    transform: scale(0.8);
  }
  .disclaimer {
    position: absolute;
    bottom: ${layout.safeZonePx}px;
    left: ${layout.safeZonePx}px;
    max-width: 55%;
    font-size: ${layout.disclaimerFontSizePx}px;
    color: #555555;
  }
  noscript img { display: block; width: ${width}px; height: ${height}px; }
</style>
</head>
<body>
  <noscript>
    <img src="data:image/jpeg;base64,${fallbackJpgBase64}" width="${width}" height="${height}" alt="" />
  </noscript>
  <div class="canvas">
    ${backgroundSrc ? `<img class="background" src="${backgroundSrc}" alt="" />` : ""}
    ${mainImageSrc ? `<img class="main-image" src="${mainImageSrc}" alt="" />` : ""}
    ${logoSrc ? `<img class="logo" src="${logoSrc}" alt="" />` : ""}
    ${claim ? `<div class="claim">${escapeHtml(claim)}</div>` : ""}
    ${subclaim ? `<div class="subclaim">${escapeHtml(subclaim)}</div>` : ""}
    ${cta ? `<div class="cta">${escapeHtml(cta)}</div>` : ""}
    ${disclaimer ? `<div class="disclaimer">${escapeHtml(disclaimer)}</div>` : ""}
  </div>
  <script src="${GSAP_CDN_URL}"></script>
  <script>${buildGsapAnimationScript()}</script>
</body>
</html>`;
}
