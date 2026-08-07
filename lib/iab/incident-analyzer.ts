import type { SupabaseClient } from "@supabase/supabase-js";
import { getIABFormatById } from "@/lib/iab/specs";
import { ratioDistance } from "@/lib/render/format-level";
import type { Incidencia, Project, ProjectAsset, ProjectFormat } from "@/lib/types";

/**
 * Umbrales de quality_score (escala 0-1, ver .claude/skills/psd-analysis.md):
 * - >= QUALITY_OK: sin incidencia relacionada con calidad.
 * - [QUALITY_CRITICO, QUALITY_OK): ATENCIÓN (MEDIUM_QUALITY_MAIN_IMAGE) para imagen_principal.
 * - < QUALITY_CRITICO: ATENCIÓN (LOW_QUALITY_MAIN_IMAGE) para imagen_principal, solo si su área
 *   supera MAIN_IMAGE_AREA_RATIO del canvas y su layer_name no matchea LOGO_LIKE_NAME_PATTERN
 *   (evita falsos positivos de logos/iconos mal clasificados por Claude Vision) — nunca bloquea
 *   el formato.
 */
const QUALITY_OK = 0.8;
const QUALITY_CRITICO = 0.5;

/** Un asset desconocido que ocupa más de este % del canvas del formato genera ATENCIÓN. */
const UNKNOWN_LAYER_AREA_RATIO = 0.1;

/** layer_type usados por trigger/analyze-psd.ts para capas extraídas del PSD (no para los archivos originales). */
const PSD_LAYER_TYPES = new Set(["texto", "grupo", "imagen"]);

/** LOW_QUALITY_MAIN_IMAGE solo aplica si la capa ocupa más de este % del área total del canvas. */
const MAIN_IMAGE_AREA_RATIO = 0.3;

/**
 * Palabras que, si aparecen en layer_name, excluyen la capa de LOW_QUALITY_MAIN_IMAGE:
 * suelen ser logos/iconos mal clasificados como imagen_principal por Claude Vision,
 * no imágenes fotográficas cuya baja resolución sea relevante.
 */
const LOGO_LIKE_NAME_PATTERN = /logo|logotype|brand|icon|icono|mark/i;

export type FormatDerivedStatus = "ready" | "warning" | "blocked";

export function deriveFormatStatus(incidencias: Incidencia[]): FormatDerivedStatus {
  if (incidencias.some((i) => i.level === "critico")) return "blocked";
  if (incidencias.length > 0) return "warning";
  return "ready";
}

/** Formatos sin incidencias críticas — los únicos que se pueden usar como master o producir. */
export function unblockedFormats(formats: ProjectFormat[]): ProjectFormat[] {
  return formats.filter((f) => deriveFormatStatus(f.incidencias ?? []) !== "blocked");
}

export type AnalysisFormatStatus = {
  id: string;
  nombreSoporte: string;
  iabFormat: string;
  ancho: number | null;
  alto: number | null;
  incidencias: Incidencia[];
  derivedStatus: FormatDerivedStatus;
};

export type AnalysisSummary = { ready: number; warning: number; blocked: number };

export type AnalysisStatusResponse = {
  projectStatus: Project["status"];
  formats: AnalysisFormatStatus[];
  summary: AnalysisSummary;
};

export function toAnalysisFormatStatus(format: ProjectFormat): AnalysisFormatStatus {
  const spec = getIABFormatById(format.iab_format);
  const incidencias = format.incidencias ?? [];
  return {
    id: format.id,
    nombreSoporte: format.nombre_soporte,
    iabFormat: format.iab_format,
    ancho: spec?.ancho ?? null,
    alto: spec?.alto ?? null,
    incidencias,
    derivedStatus: deriveFormatStatus(incidencias),
  };
}

export function summarizeFormatStatuses(formats: AnalysisFormatStatus[]): AnalysisSummary {
  return formats.reduce<AnalysisSummary>(
    (acc, format) => {
      acc[format.derivedStatus] += 1;
      return acc;
    },
    { ready: 0, warning: 0, blocked: 0 },
  );
}

function buildIncidenciasForFormat(
  format: ProjectFormat,
  psdLayers: ProjectAsset[],
  hasAnimationGuide: boolean,
  hasNoUsableLayers: boolean,
  hasParseError: boolean,
): Incidencia[] {
  const incidencias: Incidencia[] = [];
  const spec = getIABFormatById(format.iab_format);
  const hasImagenPrincipal = psdLayers.some((a) => a.classification === "imagen_principal");

  // 🔴 CRÍTICO
  // Única razón para bloquear un formato: no hay nada renderizable en el PSD.

  if (hasParseError) {
    incidencias.push({
      level: "critico",
      code: "PSD_PARSE_ERROR",
      message: "No se pudo leer el PSD: el archivo está dañado o usa un formato no soportado.",
      format_id: format.id,
    });
  }

  if (hasNoUsableLayers) {
    incidencias.push({
      level: "critico",
      code: "NO_USABLE_LAYERS",
      message: "El PSD no tiene ninguna capa utilizable (todas descartadas o vacío).",
      format_id: format.id,
    });
  }

  // 🟡 ATENCIÓN

  if (!hasImagenPrincipal) {
    incidencias.push({
      level: "atencion",
      code: "MISSING_MAIN_IMAGE",
      message:
        "No se detectó ninguna capa clasificada como imagen principal en el PSD. Puede asignarse manualmente en el editor de capas.",
      format_id: format.id,
    });
  }

  if (!format.copy || !format.copy.trim()) {
    incidencias.push({
      level: "atencion",
      code: "MISSING_COPY",
      message: `El formato "${format.nombre_soporte}" no tiene copy asignado. Puede asignarse desde las capas de texto detectadas en el editor de capas.`,
      format_id: format.id,
    });
  }

  for (const asset of psdLayers) {
    const isMainImageOverAreaThreshold =
      asset.classification === "imagen_principal" &&
      spec &&
      asset.layer_bounds &&
      !LOGO_LIKE_NAME_PATTERN.test(asset.layer_name ?? "") &&
      (() => {
        const canvasArea = spec.ancho * spec.alto;
        const assetArea = asset.layer_bounds!.width * asset.layer_bounds!.height;
        return canvasArea > 0 && assetArea / canvasArea > MAIN_IMAGE_AREA_RATIO;
      })();

    if (
      isMainImageOverAreaThreshold &&
      typeof asset.quality_score === "number" &&
      asset.quality_score < QUALITY_CRITICO
    ) {
      incidencias.push({
        level: "atencion",
        code: "LOW_QUALITY_MAIN_IMAGE",
        message: `La capa "${asset.layer_name ?? "sin nombre"}" (imagen_principal) tiene una resolución insuficiente (score ${asset.quality_score}) para el formato "${format.nombre_soporte}".`,
        format_id: format.id,
        asset_id: asset.id,
      });
    }

    if (
      asset.classification === "imagen_principal" &&
      typeof asset.quality_score === "number" &&
      asset.quality_score >= QUALITY_CRITICO &&
      asset.quality_score < QUALITY_OK
    ) {
      incidencias.push({
        level: "atencion",
        code: "MEDIUM_QUALITY_MAIN_IMAGE",
        message: `La imagen principal "${asset.layer_name ?? "sin nombre"}" tiene calidad media (score ${asset.quality_score}); el resultado puede no ser óptimo.`,
        format_id: format.id,
        asset_id: asset.id,
      });
    }

    if (
      asset.classification === "desconocido" &&
      spec &&
      typeof asset.width === "number" &&
      typeof asset.height === "number"
    ) {
      const canvasArea = spec.ancho * spec.alto;
      const assetArea = asset.width * asset.height;
      if (canvasArea > 0 && assetArea / canvasArea > UNKNOWN_LAYER_AREA_RATIO) {
        incidencias.push({
          level: "atencion",
          code: "UNKNOWN_LARGE_LAYER",
          message: `La capa "${asset.layer_name ?? "sin nombre"}" no se pudo clasificar y ocupa más del ${Math.round(UNKNOWN_LAYER_AREA_RATIO * 100)}% del canvas de "${format.nombre_soporte}".`,
          format_id: format.id,
          asset_id: asset.id,
        });
      }
    }
  }

  if (spec && format.copy && format.copy.length > spec.copyMaxLength) {
    incidencias.push({
      level: "atencion",
      code: "COPY_EXCEEDS_LIMIT",
      message: `El copy de "${format.nombre_soporte}" tiene ${format.copy.length} caracteres, por encima del límite recomendado de ${spec.copyMaxLength}.`,
      format_id: format.id,
    });
  }

  // 🟢 AVISO

  if (!hasAnimationGuide) {
    incidencias.push({
      level: "aviso",
      code: "NO_ANIMATION_GUIDE",
      message: "No se subió guía de animación: se usará el preset estándar.",
      format_id: format.id,
    });
  }

  incidencias.push({
    level: "aviso",
    code: "FONTS_NOT_DETECTED",
    message: "Tipografías no detectadas en el PSD: se usará la tipografía de fallback.",
    format_id: format.id,
  });

  return incidencias;
}

/** Dimensiones del PSD (Bloque 15) desde su propia metadata — ver trigger/analyze-psd.ts. */
function psdDimsFromAsset(psdAsset: ProjectAsset): { ancho: number; alto: number } | null {
  const meta = psdAsset.metadata as { psdWidth?: number | null; psdHeight?: number | null } | undefined;
  return meta?.psdWidth && meta?.psdHeight ? { ancho: meta.psdWidth, alto: meta.psdHeight } : null;
}

/**
 * PSD-base de un formato del plan, con el mismo criterio de prioridad que
 * trigger/render-adaptations.ts#assignMasterToFormat: override manual
 * (master_base_psd_id) > asociación histórica (source_psd_id) > más cercano
 * por ratio de aspecto (distancia logarítmica). Con un único PSD en el
 * proyecto, siempre es ese — comportamiento histórico sin cambios.
 */
function resolvePsdIdForFormat(format: ProjectFormat, psdAssets: ProjectAsset[]): string | null {
  if (psdAssets.length === 0) return null;
  if (psdAssets.length === 1) return psdAssets[0].id;

  const override = format.master_base_psd_id ?? format.source_psd_id ?? null;
  if (override && psdAssets.some((p) => p.id === override)) return override;

  const spec = getIABFormatById(format.iab_format);
  if (!spec) return psdAssets[0].id;
  const formatRatio = spec.ancho / spec.alto;

  let closest: ProjectAsset | null = null;
  let minDist = Infinity;
  for (const psd of psdAssets) {
    const dims = psdDimsFromAsset(psd);
    if (!dims) continue;
    const dist = ratioDistance(dims.ancho / dims.alto, formatRatio);
    if (dist < minDist) {
      minDist = dist;
      closest = psd;
    }
  }
  return closest?.id ?? psdAssets[0].id;
}

/**
 * Cruza adstudio_assets + adstudio_formats del proyecto, genera las incidencias
 * de cada formato y las persiste en adstudio_formats.incidencias.
 * Se invoca desde el job de Trigger.dev (sin sesión de usuario): el cliente
 * Supabase se recibe por parámetro (creado con `createTriggerSupabaseClient`)
 * en vez de crearse aquí, porque `lib/supabase/server.ts` falla por WebSocket
 * en el runtime de Trigger.dev.
 *
 * Bloque 15 — multi-PSD: cada formato se evalúa SOLO contra las capas de su
 * PSD-base (resolvePsdIdForFormat), nunca contra el pool combinado de todos
 * los PSDs del proyecto. Antes, un PSD con error de parseo o sin capas
 * utilizables bloqueaba (NO_USABLE_LAYERS/PSD_PARSE_ERROR) TODOS los formatos
 * del proyecto, incluidos los de otros PSDs sanos.
 */
export async function analyzeProjectIncidents(
  projectId: string,
  supabase: SupabaseClient,
): Promise<void> {
  const [{ data: assets, error: assetsError }, { data: formats, error: formatsError }] = await Promise.all([
    supabase.from("adstudio_assets").select("*").eq("project_id", projectId),
    supabase.from("adstudio_formats").select("*").eq("project_id", projectId),
  ]);

  if (assetsError || formatsError || !formats) return;

  const allAssets = (assets ?? []) as ProjectAsset[];
  const psdAssets = allAssets.filter((a) => a.layer_type === "psd");
  const psdLayers = allAssets.filter((a) => a.layer_type != null && PSD_LAYER_TYPES.has(a.layer_type));
  const hasAnimationGuide = allAssets.some((a) => a.layer_type === "animation");

  await Promise.all(
    (formats as ProjectFormat[]).map((format) => {
      const psdId = resolvePsdIdForFormat(format, psdAssets);
      const scopedPsdLayers = psdId ? psdLayers.filter((a) => a.source_psd_id === psdId) : psdLayers;
      const hasNoUsableLayers = scopedPsdLayers.filter((a) => !a.discarded).length === 0;
      const hasParseError = psdId
        ? psdAssets.some((p) => p.id === psdId && p.status === "error")
        : psdAssets.some((p) => p.status === "error");

      const incidencias = buildIncidenciasForFormat(
        format,
        scopedPsdLayers,
        hasAnimationGuide,
        hasNoUsableLayers,
        hasParseError,
      );
      return supabase.from("adstudio_formats").update({ incidencias }).eq("id", format.id);
    }),
  );
}
