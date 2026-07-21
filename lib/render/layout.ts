/**
 * Cálculo de proporciones del banner, compartido entre `jpg-renderer.ts`
 * (Satori) y `html5-generator.ts` (HTML animado), para que ambos productos
 * de una misma pieza tengan exactamente la misma jerarquía visual.
 *
 * Fórmulas (Bloque 3): logo máx. 20% del ancho, imagen principal máx. 55%
 * del área del canvas, claim proporcional a `sqrt(área)` (base 16px en
 * 300x250), CTA con altura fija 32px y padding horizontal 12px, zona segura
 * IAB de 10px en todos los lados.
 */

const SAFE_ZONE_PX = 10;
const CLAIM_BASE_FONT_SIZE_PX = 16;
const CLAIM_BASE_AREA = 300 * 250;
const MAIN_IMAGE_AREA_RATIO = 0.55;
const CTA_HEIGHT_PX = 32;
const CTA_PADDING_HORIZONTAL_PX = 12;
const CTA_FONT_SIZE_PX = 13;
const DISCLAIMER_FONT_SIZE_PX = 10;
/** Ancho/alto asumido para el logo cuando no se conoce su aspect ratio real. */
const DEFAULT_LOGO_ASPECT_RATIO = 2.5;

export type BannerLayout = {
  safeZonePx: number;
  logoWidthPx: number;
  logoHeightPx: number;
  mainImageBoxWidthPx: number;
  mainImageBoxHeightPx: number;
  claimTopPx: number;
  claimFontSizePx: number;
  subclaimTopPx: number;
  subclaimFontSizePx: number;
  ctaHeightPx: number;
  ctaPaddingHorizontalPx: number;
  ctaFontSizePx: number;
  disclaimerFontSizePx: number;
};

export function computeBannerLayout(params: {
  width: number;
  height: number;
  hasLogo: boolean;
  logoAspectRatio?: number | null;
}): BannerLayout {
  const { width, height, hasLogo, logoAspectRatio } = params;
  const area = width * height;

  const logoWidthPx = Math.round(width * 0.2);
  const aspectRatio = logoAspectRatio && logoAspectRatio > 0 ? logoAspectRatio : DEFAULT_LOGO_ASPECT_RATIO;
  const logoHeightPx = Math.round(logoWidthPx / aspectRatio);

  const claimFontSizePx = Math.min(
    64,
    Math.max(10, Math.round(CLAIM_BASE_FONT_SIZE_PX * Math.sqrt(area / CLAIM_BASE_AREA))),
  );
  const subclaimFontSizePx = Math.max(9, Math.round(claimFontSizePx * 0.55));

  const claimTopPx = hasLogo ? SAFE_ZONE_PX + logoHeightPx + SAFE_ZONE_PX : SAFE_ZONE_PX;
  const subclaimTopPx = claimTopPx + claimFontSizePx + 6;

  const mainImageBoxScale = Math.sqrt(MAIN_IMAGE_AREA_RATIO);

  return {
    safeZonePx: SAFE_ZONE_PX,
    logoWidthPx,
    logoHeightPx,
    mainImageBoxWidthPx: Math.round(width * mainImageBoxScale),
    mainImageBoxHeightPx: Math.round(height * mainImageBoxScale),
    claimTopPx,
    claimFontSizePx,
    subclaimTopPx,
    subclaimFontSizePx,
    ctaHeightPx: CTA_HEIGHT_PX,
    ctaPaddingHorizontalPx: CTA_PADDING_HORIZONTAL_PX,
    ctaFontSizePx: CTA_FONT_SIZE_PX,
    disclaimerFontSizePx: DISCLAIMER_FONT_SIZE_PX,
  };
}
