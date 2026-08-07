"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { DropArea } from "@/components/project/drop-area";
import { uploadAssetToStorage } from "@/lib/client-upload";
import { IAB_SPECS, getIABFormatById, resolveFormatDimensions } from "@/lib/iab/specs";
import type { MediaPlanExcludedEntry, Project, ProjectAsset, ProjectFormat } from "@/lib/types";

type SoporteRow = {
  key: string;
  id?: string;
  nombre_soporte: string;
  iab_format: string;
  url_destino: string;
  versiones: number;
  peso_max_kb: string;
  is_master: boolean;
  /** Medios/plataformas del plan que necesitan este tamaño (ver trigger/parse-media-plan.ts). */
  soportes: string[];
  /** PSD propio de este formato (id de adstudio_assets con layer_type='psd') cuando el proyecto tiene varios PSDs. */
  source_psd_id: string | null;
  /** Override manual del master-base asignado por ratio (null = automático) — ver trigger/render-adaptations.ts:assignMasterToFormat. */
  master_base_psd_id: string | null;
};

/** nombre_soporte pasa a ser siempre el tamaño (ver trigger/parse-media-plan.ts) — se deriva del iab_format, no se edita a mano. */
function nombreSoporteFor(iabFormat: string): string {
  const dims = resolveFormatDimensions(iabFormat);
  return dims ? `${dims.ancho}x${dims.alto}` : iabFormat;
}

function formatToRow(f: ProjectFormat): SoporteRow {
  return {
    key: f.id,
    id: f.id,
    nombre_soporte: f.nombre_soporte,
    iab_format: f.iab_format,
    url_destino: f.url_destino ?? "",
    versiones: f.versiones,
    peso_max_kb: f.peso_max_kb != null ? String(f.peso_max_kb) : "",
    is_master: f.is_master,
    soportes: Array.isArray(f.soportes) ? f.soportes : [],
    source_psd_id: f.source_psd_id ?? null,
    master_base_psd_id: f.master_base_psd_id ?? null,
  };
}

function formatArea(iabFormat: string): number {
  const dims = resolveFormatDimensions(iabFormat);
  return dims ? dims.ancho * dims.alto : 0;
}

/** Si ninguna fila está marcada como master, marca la de mayor área por defecto (el usuario puede cambiarlo). */
function withDefaultMaster(rows: SoporteRow[]): SoporteRow[] {
  if (rows.length === 0 || rows.some((r) => r.is_master)) return rows;
  const largestKey = [...rows].sort((a, b) => formatArea(b.iab_format) - formatArea(a.iab_format))[0]?.key;
  return rows.map((r) => ({ ...r, is_master: r.key === largestKey }));
}

type Incidencia = {
  nivel: "aviso" | "atencion" | "critico";
  mensaje: string;
};

type AnalisisRow = {
  key: string;
  incidencias: Incidencia[];
};

const NIVEL_ICON: Record<Incidencia["nivel"], string> = {
  aviso: "🟢",
  atencion: "🟡",
  critico: "🔴",
};

function newRow(): SoporteRow {
  return {
    key: crypto.randomUUID(),
    nombre_soporte: nombreSoporteFor(IAB_SPECS[0].id),
    iab_format: IAB_SPECS[0].id,
    url_destino: "",
    versiones: 1,
    peso_max_kb: "",
    is_master: false,
    soportes: [],
    source_psd_id: null,
    master_base_psd_id: null,
  };
}

function analizarSoporte(row: SoporteRow): Incidencia[] {
  const incidencias: Incidencia[] = [];

  if (!row.nombre_soporte.trim()) {
    incidencias.push({ nivel: "critico", mensaje: "Falta el nombre del soporte." });
  }

  const spec = getIABFormatById(row.iab_format);
  const dimensiones = resolveFormatDimensions(row.iab_format);
  if (!dimensiones) {
    incidencias.push({ nivel: "critico", mensaje: "Formato IAB no reconocido." });
    return incidencias;
  }

  if (!row.url_destino.trim()) {
    incidencias.push({ nivel: "atencion", mensaje: "Sin URL de destino, el soporte no será clicable." });
  }

  if (!row.versiones || row.versiones < 1) {
    incidencias.push({ nivel: "critico", mensaje: "Debe tener al menos 1 versión." });
  } else if (row.versiones > 10) {
    incidencias.push({
      nivel: "atencion",
      mensaje: `${row.versiones} versiones es un volumen alto, revisar capacidad del tier.`,
    });
  }

  incidencias.push({
    nivel: "aviso",
    mensaje: spec
      ? `${spec.ancho}x${spec.alto}px · máx ${spec.pesoMaximoKB}KB · zona segura ${spec.zonaSeguraPx}px.`
      : `${dimensiones.ancho}x${dimensiones.alto}px (formato custom, fuera del catálogo IAB).`,
  });

  return incidencias;
}

export function BriefForm({
  project,
  formats,
  excelAsset,
  psdAssets,
}: {
  project: Project;
  formats: ProjectFormat[];
  excelAsset: ProjectAsset | null;
  psdAssets: ProjectAsset[];
}) {
  const router = useRouter();
  const [excludedFromMediaPlan, setExcludedFromMediaPlan] = useState<MediaPlanExcludedEntry[]>(
    project.media_plan_excluded ?? [],
  );
  const [currentExcelAsset, setCurrentExcelAsset] = useState<ProjectAsset | null>(excelAsset);
  const [excelUpload, setExcelUpload] = useState<{ name: string; progress: number; status: "uploading" | "registering"; error?: string } | null>(
    null,
  );
  const [parsingFormats, setParsingFormats] = useState(false);
  const [excelDeleting, setExcelDeleting] = useState(false);

  // router.refresh() tras subir/borrar el Excel vuelve a ejecutar el server
  // component (brief/page.tsx) y pasa un `excelAsset` nuevo — sincroniza el
  // estado local con la fuente de verdad del servidor en vez de duplicarlo.
  useEffect(() => setCurrentExcelAsset(excelAsset), [excelAsset]);

  const [cliente, setCliente] = useState(project.cliente ?? "");
  const [producto, setProducto] = useState(project.producto ?? "");
  const [objetivo, setObjetivo] = useState(project.objetivo ?? "");
  const [fechaInicio, setFechaInicio] = useState(project.fecha_inicio ?? "");
  const [fechaFin, setFechaFin] = useState(project.fecha_fin ?? "");
  const [presupuesto, setPresupuesto] = useState(
    project.presupuesto != null ? String(project.presupuesto) : "",
  );

  const [rows, setRows] = useState<SoporteRow[]>(
    withDefaultMaster(formats.length > 0 ? formats.map(formatToRow) : [newRow()]),
  );

  // Con un único PSD subido, se asocia automáticamente al formato master —
  // el usuario solo elige manualmente cuando hay varios PSDs (ver sección
  // "Material por formato" más abajo).
  useEffect(() => {
    if (psdAssets.length !== 1) return;
    const psdId = psdAssets[0].id;
    setRows((prev) => {
      if (prev.some((r) => r.source_psd_id === psdId)) return prev;
      const masterKey = (prev.find((r) => r.is_master) ?? prev[0])?.key;
      if (!masterKey) return prev;
      return prev.map((r) => (r.key === masterKey ? { ...r, source_psd_id: psdId } : r));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [psdAssets.length]);

  async function assignPsdToFormat(psdId: string, targetKey: string) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.key === targetKey) return { ...r, source_psd_id: psdId };
        // Un PSD solo puede estar asociado a un formato a la vez.
        if (r.source_psd_id === psdId) return { ...r, source_psd_id: null };
        return r;
      }),
    );

    const targetRow = rows.find((r) => r.key === targetKey);
    if (targetRow?.id) {
      await fetch(`/api/brief/formats/${targetRow.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_psd_id: psdId }),
      }).catch(() => {
        // Best-effort: si falla, "Guardar brief" vuelve a mandar la asociación actual.
      });
    }
  }

  /** Bloque 15: override manual del master-base de un formato (null = automático por ratio, ver assignMasterToFormat). */
  async function setMasterBasePsd(targetKey: string, psdId: string | null) {
    updateRow(targetKey, { master_base_psd_id: psdId });

    const targetRow = rows.find((r) => r.key === targetKey);
    if (targetRow?.id) {
      await fetch(`/api/brief/formats/${targetRow.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ master_base_psd_id: psdId }),
      }).catch(() => {
        // Best-effort: si falla, "Guardar brief" vuelve a mandar el valor actual.
      });
    }
  }

  const [analisis, setAnalisis] = useState<AnalisisRow[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);

  const isExisting = project.id !== undefined && formats.length >= 0 && project.cliente !== "Cliente sin datos";

  const totalCriticos = useMemo(() => {
    if (!analisis) return 0;
    return analisis.reduce(
      (acc, r) => acc + r.incidencias.filter((i) => i.nivel === "critico").length,
      0,
    );
  }, [analisis]);

  function updateRow(key: string, patch: Partial<SoporteRow>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setAnalisis(null);
  }

  function addRow() {
    setRows((prev) => withDefaultMaster([...prev, newRow()]));
  }

  function removeRow(key: string) {
    setRows((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((r) => r.key !== key);
      // Si se eliminó el formato master, hace falta recalcular el default (withDefaultMaster
      // no reacciona si ninguna fila quedó marcada tras quitar la que sí lo estaba).
      return withDefaultMaster(next);
    });
    setAnalisis(null);
  }

  function addSoporte(key: string, medio: string) {
    setRows((prev) =>
      prev.map((r) => (r.key === key && !r.soportes.includes(medio) ? { ...r, soportes: [...r.soportes, medio] } : r)),
    );
  }

  function removeSoporte(key: string, index: number) {
    setRows((prev) =>
      prev.map((r) => (r.key === key ? { ...r, soportes: r.soportes.filter((_, i) => i !== index) } : r)),
    );
  }

  function handleAnalizar() {
    const resultado = rows.map((row) => ({
      key: row.key,
      incidencias: analizarSoporte(row),
    }));
    setAnalisis(resultado);
  }

  async function handleGuardar() {
    setSaving(true);
    setSaveError(null);
    setSaveOk(false);

    const payload = {
      project: {
        id: project.id,
        cliente,
        producto: producto || null,
        objetivo: objetivo || null,
        fecha_inicio: fechaInicio || null,
        fecha_fin: fechaFin || null,
        presupuesto: presupuesto ? Number(presupuesto) : null,
      },
      formats: rows.map((r) => ({
        id: r.id,
        nombre_soporte: r.nombre_soporte,
        iab_format: r.iab_format,
        url_destino: r.url_destino || null,
        versiones: Number(r.versiones) || 1,
        peso_max_kb: r.peso_max_kb.trim() ? Number(r.peso_max_kb) : null,
        is_master: r.is_master,
        soportes: r.soportes,
        source_psd_id: r.source_psd_id,
        master_base_psd_id: r.master_base_psd_id,
      })),
    };

    try {
      const res = await fetch("/api/brief", {
        method: isExisting ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!res.ok) {
        setSaveError(data.error ?? "No se pudo guardar el brief.");
      } else {
        setSaveOk(true);
      }
    } catch {
      setSaveError("Error de red al guardar el brief.");
    } finally {
      setSaving(false);
    }
  }

  /**
   * parse-media-plan.ts (trigger/parse-media-plan.ts) corre en background tras el
   * upload — no hay endpoint de status para ese job, así que se hace polling
   * best-effort de /api/brief hasta ver más formatos o agotar los intentos.
   *
   * El job hace un upsert fila a fila (ver trigger/parse-media-plan.ts), así que
   * el recuento de formatos cambia progresivamente mientras corre — pararse en
   * el primer cambio respecto a baselineCount capturaba una foto a mitad (p. ej.
   * 1 de 7 formatos) y se quedaba ahí. Por eso hace falta ver el mismo recuento
   * en dos lecturas consecutivas (~2.5s aparte) antes de darlo por terminado.
   */
  async function pollForParsedFormats(baselineCount: number) {
    const maxAttempts = 12;
    let previousCount: number | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      try {
        const res = await fetch(`/api/brief?projectId=${project.id}`, { cache: "no-store" });
        if (!res.ok) continue;
        const data = await res.json();
        const freshFormats = (data.formats ?? []) as ProjectFormat[];
        const freshExcluded = (data.project?.media_plan_excluded ?? []) as MediaPlanExcludedEntry[];

        const changedFromBaseline = freshFormats.length !== baselineCount;
        const stableSincePreviousPoll = previousCount === freshFormats.length;
        const isLastAttempt = attempt === maxAttempts - 1;

        if (changedFromBaseline && (stableSincePreviousPoll || isLastAttempt)) {
          setRows(withDefaultMaster(freshFormats.length > 0 ? freshFormats.map(formatToRow) : rows));
          setExcludedFromMediaPlan(freshExcluded);
          return;
        }

        previousCount = freshFormats.length;
      } catch {
        // Reintenta en el siguiente tick.
      }
    }
  }

  async function handleExcelFiles(files: File[]) {
    const file = files[0];
    if (!file) return;

    const ext = file.name.toLowerCase();
    if (!ext.endsWith(".xlsx") && !ext.endsWith(".xls")) {
      setExcelUpload({ name: file.name, progress: 0, status: "uploading", error: "Solo se aceptan .xlsx o .xls" });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setExcelUpload({ name: file.name, progress: 0, status: "uploading", error: "Supera el máximo de 10MB" });
      return;
    }

    setExcelUpload({ name: file.name, progress: 0, status: "uploading" });

    const baselineCount = rows.filter((r) => r.id).length;

    const result = await uploadAssetToStorage(project.id, "excel", file, (percent) => {
      setExcelUpload((prev) =>
        prev ? { ...prev, progress: percent, status: percent >= 100 ? "registering" : "uploading" } : prev,
      );
    });

    if (!result.ok) {
      setExcelUpload({ name: file.name, progress: 0, status: "uploading", error: result.error });
      return;
    }

    setExcelUpload(null);
    setParsingFormats(true);
    await pollForParsedFormats(baselineCount);
    setParsingFormats(false);
    router.refresh();
  }

  async function handleDeleteExcel() {
    if (!currentExcelAsset) return;
    setExcelDeleting(true);
    try {
      const res = await fetch(`/api/upload/${currentExcelAsset.id}`, { method: "DELETE" });
      if (res.ok) {
        setCurrentExcelAsset(null);
        router.refresh();
      }
    } finally {
      setExcelDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Datos de campaña</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cliente">Cliente</Label>
            <Input id="cliente" value={cliente} onChange={(e) => setCliente(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="producto">Producto</Label>
            <Input id="producto" value={producto} onChange={(e) => setProducto(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="presupuesto">Presupuesto (€)</Label>
            <Input
              id="presupuesto"
              type="number"
              min={0}
              value={presupuesto}
              onChange={(e) => setPresupuesto(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fecha-inicio">Fecha inicio</Label>
            <Input
              id="fecha-inicio"
              type="date"
              value={fechaInicio}
              onChange={(e) => setFechaInicio(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fecha-fin">Fecha fin</Label>
            <Input
              id="fecha-fin"
              type="date"
              value={fechaFin}
              onChange={(e) => setFechaFin(e.target.value)}
            />
          </div>
          <div className="col-span-2 flex flex-col gap-1.5">
            <Label htmlFor="objetivo">Objetivo de campaña</Label>
            <Textarea
              id="objetivo"
              value={objetivo}
              onChange={(e) => setObjetivo(e.target.value)}
              placeholder="Ej. Awareness de lanzamiento de producto, generación de tráfico..."
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Excel del plan de medios</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Opcional — al subirlo se detectan automáticamente los formatos del plan en la tabla de abajo
            (puedes corregirlos antes de guardar). Sin Excel, añade los formatos a mano con
            &quot;+ Añadir formato manualmente&quot;.
          </p>
          <DropArea
            label="Arrastra el Excel del plan de medios"
            hint=".xlsx o .xls · máximo 10MB"
            onFiles={handleExcelFiles}
            disabled={!!currentExcelAsset || !!excelUpload}
          />

          {currentExcelAsset && (
            <div className="flex items-center gap-3 rounded-md border border-border p-2 text-sm">
              <span className="flex h-10 w-10 items-center justify-center rounded bg-muted text-xs">XLS</span>
              <span className="flex-1 truncate">{currentExcelAsset.layer_name}</span>
              <span className="text-xs text-green-600">subido</span>
              <button
                type="button"
                aria-label="Eliminar Excel"
                disabled={excelDeleting}
                onClick={handleDeleteExcel}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-red-600 disabled:opacity-50"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {excelUpload && (
            <div className="flex flex-col gap-1 rounded-md border border-border p-2 text-sm">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded bg-muted text-xs">XLS</span>
                <span className="flex-1 truncate">{excelUpload.name}</span>
                <span className={`text-xs ${excelUpload.error ? "text-red-600" : "text-muted-foreground"}`}>
                  {excelUpload.error ??
                    (excelUpload.status === "registering"
                      ? "Subido, registrando..."
                      : `Subiendo... ${excelUpload.progress}%`)}
                </span>
              </div>
              {!excelUpload.error && (
                <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-200"
                    style={{ width: `${excelUpload.status === "registering" ? 100 : excelUpload.progress}%` }}
                  />
                </div>
              )}
            </div>
          )}

          {parsingFormats && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
              Detectando formatos del plan...
            </p>
          )}
        </CardContent>
      </Card>

      {psdAssets.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Material por formato</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              Este proyecto tiene varios PSDs subidos. Asocia cada uno al formato del plan que produce — se
              generará su propio HTML5 a partir de ese PSD, en vez de adaptarse desde el master.
            </p>
            {psdAssets.map((psd) => {
              const assignedRow = rows.find((r) => r.source_psd_id === psd.id);
              return (
                <div key={psd.id} className="flex items-center gap-3 rounded-md border border-border p-2 text-sm">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted text-[10px]">
                    PSD
                  </span>
                  <span className="flex-1 truncate">{psd.layer_name}</span>
                  <Select
                    value={assignedRow?.key ?? ""}
                    onValueChange={(value) => value && assignPsdToFormat(psd.id, value)}
                  >
                    <SelectTrigger className="w-64">
                      <SelectValue placeholder="¿A qué formato corresponde?" />
                    </SelectTrigger>
                    <SelectContent>
                      {rows.map((row) => (
                        <SelectItem key={row.key} value={row.key}>
                          {row.nombre_soporte || row.iab_format}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Soportes del plan</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Soporte</TableHead>
                <TableHead>Formato IAB</TableHead>
                <TableHead>Dimensiones</TableHead>
                {psdAssets.length > 1 && <TableHead>Master base</TableHead>}
                <TableHead className="w-24">Peso máx (KB)</TableHead>
                <TableHead>URL destino</TableHead>
                <TableHead className="w-28">Versiones</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const rowAnalisis = analisis?.find((a) => a.key === row.key);
                const dimensiones = resolveFormatDimensions(row.iab_format);
                const isCustomFormat = !getIABFormatById(row.iab_format);
                return (
                  <Fragment key={row.key}>
                    <TableRow>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1">
                          {row.soportes.map((medio, i) => (
                            <Badge key={i} variant="secondary" className="gap-1 font-normal">
                              {medio}
                              <button
                                type="button"
                                aria-label={`Quitar ${medio}`}
                                onClick={() => removeSoporte(row.key, i)}
                                className="hover:text-destructive"
                              >
                                ×
                              </button>
                            </Badge>
                          ))}
                          <input
                            type="text"
                            placeholder="+ medio"
                            className="w-20 rounded-md border border-input bg-transparent px-1.5 py-0.5 text-xs"
                            onKeyDown={(e) => {
                              const value = e.currentTarget.value.trim();
                              if (e.key === "Enter" && value) {
                                addSoporte(row.key, value);
                                e.currentTarget.value = "";
                              }
                            }}
                          />
                        </div>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={row.iab_format}
                          onValueChange={(value) =>
                            value &&
                            updateRow(row.key, { iab_format: value, nombre_soporte: nombreSoporteFor(value) })
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {isCustomFormat && dimensiones && (
                              <SelectItem value={row.iab_format}>
                                Custom ({dimensiones.ancho}x{dimensiones.alto})
                              </SelectItem>
                            )}
                            {IAB_SPECS.map((spec) => (
                              <SelectItem key={spec.id} value={spec.id}>
                                {spec.nombre} ({spec.ancho}x{spec.alto})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {dimensiones ? `${dimensiones.ancho}x${dimensiones.alto}px` : "—"}
                      </TableCell>
                      {psdAssets.length > 1 && (
                        <TableCell>
                          <Select
                            value={row.master_base_psd_id ?? "auto"}
                            onValueChange={(value) => setMasterBasePsd(row.key, value === "auto" ? null : value)}
                          >
                            <SelectTrigger className="w-40">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="auto">Automático (más cercano)</SelectItem>
                              {psdAssets.map((psd) => (
                                <SelectItem key={psd.id} value={psd.id}>
                                  {psd.layer_name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                      )}
                      <TableCell>
                        <Input
                          type="number"
                          min={0}
                          value={row.peso_max_kb}
                          onChange={(e) => updateRow(row.key, { peso_max_kb: e.target.value })}
                          placeholder="Ej. 150"
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          value={row.url_destino}
                          onChange={(e) => updateRow(row.key, { url_destino: e.target.value })}
                          placeholder="https://..."
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          min={1}
                          value={row.versiones}
                          onChange={(e) =>
                            updateRow(row.key, { versiones: Number(e.target.value) })
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeRow(row.key)}
                        >
                          ✕
                        </Button>
                      </TableCell>
                    </TableRow>
                    {rowAnalisis && rowAnalisis.incidencias.length > 0 && (
                      <TableRow className="bg-muted/40">
                        <TableCell colSpan={psdAssets.length > 1 ? 8 : 7}>
                          <ul className="flex flex-col gap-1 text-sm">
                            {rowAnalisis.incidencias.map((inc, i) => (
                              <li key={i}>
                                {NIVEL_ICON[inc.nivel]} {inc.mensaje}
                              </li>
                            ))}
                          </ul>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>

          <div className="flex items-center justify-between">
            <Button type="button" variant="outline" size="sm" onClick={addRow}>
              + Añadir formato manualmente
            </Button>
            <Button type="button" onClick={handleAnalizar}>
              Analizar formatos
            </Button>
          </div>

          {analisis && (
            <p className="text-sm text-muted-foreground">
              {totalCriticos > 0
                ? `🔴 ${totalCriticos} incidencia(s) crítica(s) detectada(s). Corrígelas antes de continuar.`
                : "Sin incidencias críticas. Puedes guardar el brief."}
            </p>
          )}

        </CardContent>
      </Card>

      {excludedFromMediaPlan.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Formatos no producibles por AdStudio</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              Detectados en el Excel del plan de medios pero fuera del alcance de AdStudio (vídeo, audio,
              social...). No se generan como soportes, pero se listan aquí para que sepas qué había en el
              plan.
            </p>
            <ul className="flex flex-wrap gap-2">
              {excludedFromMediaPlan.map((entry, i) => (
                <li key={i}>
                  <Badge variant="secondary" className="font-normal">
                    {entry.soporte} — {entry.motivo}
                  </Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {formats.length === 0 && !currentExcelAsset && (
        <p className="text-sm text-[#F5C46B]">
          Añade al menos un formato al plan de medios (subiendo el Excel o con &quot;+ Añadir formato
          manualmente&quot;) antes de guardar.
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button onClick={handleGuardar} disabled={saving}>
          {saving ? "Guardando..." : "Guardar brief"}
        </Button>
        {saveOk && <span className="text-sm text-green-600">Brief guardado correctamente.</span>}
        {saveError && <span className="text-sm text-red-600">{saveError}</span>}
      </div>
    </div>
  );
}
