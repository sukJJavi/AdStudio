/**
 * Preset de animación GSAP por defecto (cuando el proyecto no trae guía de
 * animación propia). Referencia las clases usadas por lib/render/html5-generator.ts.
 *
 * Frame 1 (0-2s):  fade in fondo + imagen principal
 * Frame 2 (2-4s):  slide up claim desde bottom + 20px
 * Frame 3 (4-5s):  fade in subclaim
 * Frame 4 (5-6s):  pop in CTA (scale 0.8 → 1 con bounce)
 * Frame 5 (6-15s): hold estático
 * Loop: vuelve a Frame 1, máx 3 loops (repeat: 2 = 1 pase + 2 repeticiones) — IAB LEAN.
 */
export const GSAP_CDN_URL = "https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/gsap.min.js";

export function buildGsapAnimationScript(): string {
  return `
document.addEventListener('DOMContentLoaded', function () {
  if (typeof gsap === 'undefined') return;
  var tl = gsap.timeline({ repeat: 2 });
  tl.set('.background, .main-image', { opacity: 0 })
    .set('.claim', { opacity: 0, y: 20 })
    .set('.subclaim', { opacity: 0 })
    .set('.cta', { opacity: 0, scale: 0.8, transformOrigin: 'center' })
    .to('.background, .main-image', { opacity: 1, duration: 2 }, 0)
    .to('.claim', { opacity: 1, y: 0, duration: 2 }, 2)
    .to('.subclaim', { opacity: 1, duration: 1 }, 4)
    .to('.cta', { opacity: 1, scale: 1, duration: 1, ease: 'back.out(1.7)' }, 5)
    .to({}, { duration: 9 }, 6);
});
`.trim();
}
