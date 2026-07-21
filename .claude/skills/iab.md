# Reglas IAB LEAN en AdStudio

Fuente de verdad de los 15 formatos: `lib/iab/specs.ts`, array `IAB_SPECS` (`IABFormat`: `id`, `nombre`, `ancho`, `alto`, `pesoMaximoKB`, `zonaSeguraPx`, `notas`). Helpers: `getIABFormatById(id)`, `validateFormatWeight(id, pesoKB)`. Cualquier validación de peso/dimensiones/zona segura debe pasar por estos specs, no hardcodear números en componentes o jobs.

Formatos actuales: `medium-rectangle` (300x250), `leaderboard` (728x90), `wide-skyscraper` (160x600), `skyscraper` (120x600), `half-page` (300x600), `billboard` (970x250), `super-leaderboard` (970x90), `square` (250x250), `small-square` (200x200), `button` (125x125), `mobile-banner` (320x50), `mobile-large-banner` (320x100), `mobile-interstitial` (320x480), `vertical-banner` (240x400), `full-banner` (468x60).

## Reglas LEAN (aplicar siempre, sin excepción por formato)

- **Peso**: máx 150KB para el HTML5 (`pesoMaximoKB` en el spec, hoy 150 para los 15 formatos). El JPG de respaldo no tiene límite de peso.
- **Animación**: máx 15s de duración total, máx 3 loops, nunca autoplay con sonido.
- **Zona segura**: 10px interiores en todos los formatos (`zonaSeguraPx`), ningún elemento de contenido (texto, CTA, logo) puede invadirla.
- **Entrega**: siempre HTML5 + JPG de respaldo, nunca solo uno de los dos.

Validar con `validateFormatWeight(id, pesoKB)` antes de marcar un formato como listo para entrega; si devuelve `false`, es incidencia de peso.

## Niveles de incidencia

- 🟢 **AVISO** — produce igual, calidad aceptable. No bloquea nada. Ejemplo: asset con `quality_score` ligeramente por debajo del ideal pero usable.
- 🟡 **ATENCIÓN** — produce igual, pero el resultado puede no ser óptimo. Ejemplo: peso cerca del límite tras optimizar, asset `desconocido` sin impacto crítico, `quality_score` 0.5–0.79.
- 🔴 **CRÍTICO** — bloquea ese formato concreto, nunca el proyecto completo. Ejemplo: excede `pesoMaximoKB` tras optimizar, animación > 15s o > 3 loops, elemento de contenido invadiendo la zona segura, asset imprescindible (`logo`/`imagen_principal`/`cta`) con `quality_score < 0.5` para ese tamaño.

Las incidencias se guardan en `adstudio_formats.incidencias` (jsonb) por formato afectado — nunca cambiar `adstudio_projects.status` a un estado bloqueante por una incidencia crítica aislada; el resto de formatos del proyecto deben poder seguir produciéndose y entregándose.
