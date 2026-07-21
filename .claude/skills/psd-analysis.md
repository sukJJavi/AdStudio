# Análisis de PSD en AdStudio

## Flujo

1. **ag-psd extrae capas** (`trigger/analyze-psd.ts`, job `analyze-psd`): descarga el PSD desde `adstudio-projects` storage con el cliente service-role, `readPsd(buffer, { skipLayerImageData: true, skipCompositeImageData: true })` para no cargar píxeles en esta fase, itera `psd.children` y crea una fila en `adstudio_assets` por capa (`layer_name`, `layer_type` derivado de si es texto/grupo/imagen, `width`/`height` desde `left/top/right/bottom`, `dpi` desde `psd.imageResources.resolutionInfo.horizontalResolution`).
2. **Aplanar cada capa**: para clasificar con Vision hace falta un raster por capa. Releer el PSD sin `skipLayerImageData`/`skipCompositeImageData` (o reabrir solo la capa concreta) y usar Sharp para exportar cada capa a PNG/JPG, subiéndolo a storage (`{project_id}/layers/{asset_id}.png`) y guardando la ruta en `adstudio_assets.file_path`.
3. **Claude Vision clasifica**: por cada capa aplanada, llamar a Claude (wrapper en `lib/claude/`, modelo `claude-sonnet-4-6`) pasando la imagen y pidiendo una de las clasificaciones cerradas de abajo. No dejar que el modelo invente categorías nuevas — si no encaja en ninguna, `desconocido`.
4. **Guardar en `adstudio_assets`**: `update` de la fila de la capa con `classification` (uno de los valores cerrados) y `quality_score` calculado (ver abajo). El job debe reportar progreso por paso siguiendo el patrón de [[trigger]] (`metadata.set("step", ...)` en extracción / aplanado / clasificación, no solo inicio y fin).

## Clasificaciones posibles (cerradas)

`logo` · `imagen_principal` · `claim` · `subclaim` · `cta` · `disclaimer` · `fondo` · `decorativo` · `desconocido`

Estos valores son el vocabulario fijo de `adstudio_assets.classification`. No añadir valores nuevos sin actualizar este archivo y cualquier UI que renderice el campo (p. ej. `components/incident-report`).

Guía rápida de qué es cada uno:
- `logo` — marca del anunciante.
- `imagen_principal` — imagen/producto protagonista de la pieza.
- `claim` — titular/mensaje principal (texto grande).
- `subclaim` — texto secundario de apoyo al claim.
- `cta` — call to action ("Compra ya", flecha, botón).
- `disclaimer` — legal/condiciones, texto pequeño.
- `fondo` — capa de fondo, color o imagen de base.
- `decorativo` — elementos gráficos sin función de contenido (formas, líneas, brillos).
- `desconocido` — no se pudo clasificar con confianza; requiere revisión manual (incidencia 🟡 por defecto).

## Cálculo de `quality_score`

Se calcula por capa/asset una vez se conoce su `dpi`, sus dimensiones reales (`width`/`height` en px, ya guardadas por el job de extracción) y el formato IAB más grande de los formatos del proyecto (`adstudio_formats.iab_format` → resolver contra `lib/iab/specs.ts::getIABFormatById`, tomar el de mayor `ancho*alto`).

Idea del score (0–1, penaliza cuando el asset se queda corto para el mayor formato a producir):

- **Factor de resolución**: `min(1, (width * height) / (formatoMax.ancho * formatoMax.alto))`. Un asset más pequeño que el formato más grande del plan escala mal → penaliza proporcionalmente.
- **Factor de DPI**: `dpi >= 72` → 1; por debajo, `dpi / 72` (72dpi es el mínimo aceptable para pantalla; no exigir 300dpi de impresión).
- `quality_score = factorResolucion * factorDPI`, redondeado a 2 decimales.

Umbrales de incidencia sobre `quality_score` (ver [[iab]] para los niveles):
- `>= 0.8` → sin incidencia.
- `0.5–0.79` → 🟡 ATENCIÓN (el asset puede pixelarse en formatos grandes).
- `< 0.5` → 🔴 CRÍTICO solo si esa capa es imprescindible en un formato concreto (p. ej. `imagen_principal` o `logo`); si es `decorativo`/`fondo`, degradar a 🟡.

No bloquear el proyecto completo por un asset con `quality_score` bajo — la incidencia crítica bloquea únicamente los formatos donde ese asset se usa a tamaño insuficiente.
