import { task, metadata } from "@trigger.dev/sdk/v3";
import * as XLSX from "xlsx";
import { createTriggerSupabaseClient } from "@/lib/supabase/trigger-client";
import { resolveFormatDimensions } from "@/lib/iab/specs";
import type { MediaPlanExcludedEntry } from "@/lib/types";

type ParseMediaPlanPayload = {
  projectId: string;
};

/**
 * El Excel de un plan de medios de agencia no es una tabla simple: trae
 * cabeceras, notas y bloques por soporte antes de llegar a la tabla real.
 * Estas constantes describen cómo reconocerla e interpretarla sin asumir una
 * posición fija de filas/columnas.
 */

/** Palabras que delatan la fila de cabecera de la tabla principal del plan. */
const HEADER_INDICATORS = ["formato", "tamano", "soporte", "plataforma"];

/** Tipos de formato que AdStudio puede producir (banners estáticos/HTML5). */
const PRODUCIBLE_TYPE_PATTERN = /estandar|standard|banner|display/i;

/** Palabras que delatan un formato que AdStudio no produce, aunque tenga dimensiones WxH. */
const NON_PRODUCIBLE_PATTERN = /video|audio|social|stories|reels|mp4|mp3|:15|:20|:30/i;

/** '300x250' / '300X250' → medium-rectangle, etc. Cualquier tamaño no listado se guarda como '{W}x{H}' (custom). */
const SIZE_TO_IAB_FORMAT: Record<string, string> = {
  "300x250": "medium-rectangle",
  "728x90": "leaderboard",
  "300x600": "half-page",
  "320x480": "mobile-interstitial",
  "160x600": "wide-skyscraper",
  "970x250": "billboard",
  "320x50": "mobile-banner",
};

const DIACRITICS_PATTERN = new RegExp("[̀-ͯ]", "g");

function normalize(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(DIACRITICS_PATTERN, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function cellText(value: unknown): string {
  return String(value ?? "").trim();
}

type SheetRows = unknown[][];

type HeaderLocation = { sheetName: string; rows: SheetRows; rowIndex: number };

/**
 * Recorre todas las hojas buscando la fila que contiene el header de la tabla
 * principal: la que matchea más palabras indicadoras ("Formato", "Tamaño",
 * "Soporte", "Plataforma"). Solo se buscan las primeras 40 filas de cada hoja
 * — el resto de bloques de agencia (notas, condiciones) no llevan tablas.
 */
function findHeaderRow(workbook: XLSX.WorkBook): HeaderLocation | null {
  let best: (HeaderLocation & { score: number }) | null = null;

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: false });

    for (let rowIndex = 0; rowIndex < Math.min(rows.length, 40); rowIndex++) {
      const row = rows[rowIndex];
      const normalizedCells = row.map(normalize).filter(Boolean);
      const score = HEADER_INDICATORS.filter((indicator) =>
        normalizedCells.some((cell) => cell.includes(indicator)),
      ).length;

      if (score > 0 && (!best || score > best.score)) {
        best = { sheetName, rows, rowIndex, score };
      }
    }
  }

  if (!best) return null;
  return { sheetName: best.sheetName, rows: best.rows, rowIndex: best.rowIndex };
}

type ColumnMap = { index: number; normalized: string }[];

function buildColumnMap(headerRow: unknown[]): ColumnMap {
  return headerRow.map((cell, index) => ({ index, normalized: normalize(cell) })).filter((c) => c.normalized);
}

function resolveColumnExact(columns: ColumnMap, candidates: string[]): number | undefined {
  for (const candidate of candidates) {
    const match = columns.find((c) => c.normalized === candidate || c.normalized.replace(/[^a-z0-9]/g, "") === candidate.replace(/[^a-z0-9]/g, ""));
    if (match) return match.index;
  }
  return undefined;
}

function resolveColumnAll(columns: ColumnMap, requiredWords: string[]): number | undefined {
  const match = columns.find((c) => requiredWords.every((word) => c.normalized.includes(word)));
  return match?.index;
}

function resolveColumnIncludes(columns: ColumnMap, word: string): number | undefined {
  const match = columns.find((c) => c.normalized.includes(word));
  return match?.index;
}

type ParsedRow = {
  soporte: string;
  plataforma: string;
  tamano: string;
  tipoFormato: string;
  peso: string;
};

function parsePesoKb(raw: string): number | null {
  const match = raw.match(/(\d+(?:[.,]\d+)?)/);
  if (!match) return null;
  return Math.round(Number(match[1].replace(",", ".")));
}

function exclusionReason(label: string): string {
  const normalized = normalize(label);
  if (/video|mp4|:1[0-9]|:2[0-9]|:3[0-9]/.test(normalized)) return "No compatible (formato de video)";
  if (/audio|mp3/.test(normalized)) return "No compatible (formato de audio)";
  if (/social|stories|reels/.test(normalized)) return "No compatible (formato social)";
  return "No compatible (formato no soportado por AdStudio)";
}

export const parseMediaPlan = task({
  id: "parse-media-plan",
  run: async (payload: ParseMediaPlanPayload) => {
    const supabase = createTriggerSupabaseClient();

    metadata.set("step", "descargando-excel");
    metadata.set("progress", 0);

    const { data: excelAssets } = await supabase
      .from("adstudio_assets")
      .select("*")
      .eq("project_id", payload.projectId)
      .eq("layer_type", "excel")
      .order("created_at", { ascending: false })
      .limit(1);

    const excelAsset = excelAssets?.[0];
    if (!excelAsset?.file_path || !excelAsset.file_path.includes("/excel/")) {
      return { projectId: payload.projectId, producedFormats: 0, excludedRows: 0, error: "No hay Excel subido." };
    }

    const { data: file, error: downloadError } = await supabase.storage
      .from("adstudio-projects")
      .download(excelAsset.file_path);

    if (downloadError || !file) {
      return { projectId: payload.projectId, producedFormats: 0, excludedRows: 0, error: "No se pudo descargar el Excel." };
    }

    metadata.set("step", "buscando-tabla-del-plan");
    metadata.set("progress", 0.2);

    const buffer = Buffer.from(await file.arrayBuffer());
    const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });

    const headerLocation = findHeaderRow(workbook);
    if (!headerLocation) {
      return { projectId: payload.projectId, producedFormats: 0, excludedRows: 0, error: "No se encontró la tabla del plan en el Excel." };
    }

    const columns = buildColumnMap(headerLocation.rows[headerLocation.rowIndex]);

    const soporteIdx = resolveColumnExact(columns, ["soporte detalle"]) ?? resolveColumnExact(columns, ["soporte"]);
    const plataformaIdx = resolveColumnExact(columns, ["plataforma"]) ?? resolveColumnExact(columns, ["proveedor"]);
    const tipoFormatoIdx = resolveColumnAll(columns, ["tipo", "formato"]);
    const tamanoIdx =
      resolveColumnAll(columns, ["tamano", "duracion"]) ??
      resolveColumnExact(columns, ["tamano"]) ??
      resolveColumnExact(columns, ["formato"]);
    const pesoIdx = resolveColumnIncludes(columns, "peso");

    metadata.set("step", "parseando-filas");
    metadata.set("progress", 0.4);

    type ProducibleEntry = { nombreSoporte: string; iabFormat: string; pesoMaxKb: number | null };
    const producible = new Map<string, ProducibleEntry>();
    const excluded = new Map<string, MediaPlanExcludedEntry>();

    for (let rowIndex = headerLocation.rowIndex + 1; rowIndex < headerLocation.rows.length; rowIndex++) {
      const row = headerLocation.rows[rowIndex];

      const parsed: ParsedRow = {
        soporte: cellText(soporteIdx != null ? row[soporteIdx] : ""),
        plataforma: cellText(plataformaIdx != null ? row[plataformaIdx] : ""),
        tamano: cellText(tamanoIdx != null ? row[tamanoIdx] : ""),
        tipoFormato: cellText(tipoFormatoIdx != null ? row[tipoFormatoIdx] : ""),
        peso: cellText(pesoIdx != null ? row[pesoIdx] : ""),
      };

      // Fila en blanco (separador entre bloques del plan) — nada que registrar.
      if (!parsed.soporte && !parsed.tamano && !parsed.tipoFormato) continue;

      const sizeMatch = parsed.tamano.match(/(\d+)\s*[xX]\s*(\d+)/);
      const isProducibleType = PRODUCIBLE_TYPE_PATTERN.test(normalize(parsed.tipoFormato));
      const hasNonProducibleHint = NON_PRODUCIBLE_PATTERN.test(
        normalize(`${parsed.tamano} ${parsed.tipoFormato} ${parsed.soporte}`),
      );

      const isProducible = isProducibleType && !!sizeMatch && !hasNonProducibleHint;

      if (!isProducible) {
        const label = parsed.tamano || parsed.tipoFormato || parsed.soporte;
        const reason = exclusionReason(`${parsed.tamano} ${parsed.tipoFormato} ${parsed.soporte}`);
        excluded.set(`${label}__${reason}`, { soporte: label, motivo: reason });
        continue;
      }

      const [, w, h] = sizeMatch;
      const sizeKey = `${w}x${h}`;
      const iabFormat = SIZE_TO_IAB_FORMAT[sizeKey] ?? sizeKey;
      const nombreSoporte =
        parsed.plataforma && parsed.soporte
          ? `${parsed.plataforma} - ${parsed.soporte}`
          : parsed.soporte || parsed.plataforma || sizeKey;
      const pesoMaxKb = parsePesoKb(parsed.peso);

      const dedupKey = `${nombreSoporte}__${iabFormat}`;
      const existing = producible.get(dedupKey);
      if (!existing) {
        producible.set(dedupKey, { nombreSoporte, iabFormat, pesoMaxKb });
      } else if (existing.pesoMaxKb == null && pesoMaxKb != null) {
        existing.pesoMaxKb = pesoMaxKb;
      }
    }

    metadata.set("step", "guardando-formatos");
    metadata.set("progress", 0.8);

    const { data: existingFormats } = await supabase
      .from("adstudio_formats")
      .select("id, nombre_soporte, iab_format")
      .eq("project_id", payload.projectId);

    for (const entry of producible.values()) {
      const match = (existingFormats ?? []).find(
        (f) => f.nombre_soporte === entry.nombreSoporte && f.iab_format === entry.iabFormat,
      );

      // Comprueba que el iab_format catalogado o custom "WxH" tenga dimensiones
      // resolubles antes de guardar — descarta cualquier tamaño mal parseado.
      if (!resolveFormatDimensions(entry.iabFormat)) continue;

      if (match) {
        // No se pisan url_destino/versiones/status: son campos que el usuario
        // puede haber editado a mano en el brief tras la primera importación.
        await supabase
          .from("adstudio_formats")
          .update({ peso_max_kb: entry.pesoMaxKb })
          .eq("id", match.id);
      } else {
        await supabase.from("adstudio_formats").insert({
          project_id: payload.projectId,
          nombre_soporte: entry.nombreSoporte,
          iab_format: entry.iabFormat,
          url_destino: null,
          versiones: 1,
          status: "pending",
          incidencias: [],
          peso_max_kb: entry.pesoMaxKb,
        });
      }
    }

    await supabase
      .from("adstudio_projects")
      .update({ media_plan_excluded: Array.from(excluded.values()) })
      .eq("id", payload.projectId);

    metadata.set("step", "completado");
    metadata.set("progress", 1);

    return {
      projectId: payload.projectId,
      producedFormats: producible.size,
      excludedRows: excluded.size,
    };
  },
});
