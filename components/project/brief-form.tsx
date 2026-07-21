"use client";

import { Fragment, useMemo, useState } from "react";
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
import { IAB_SPECS, getIABFormatById } from "@/lib/iab/specs";
import type { Project, ProjectFormat } from "@/lib/types";

type SoporteRow = {
  key: string;
  id?: string;
  nombre_soporte: string;
  iab_format: string;
  url_destino: string;
  versiones: number;
};

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
    nombre_soporte: "",
    iab_format: IAB_SPECS[0].id,
    url_destino: "",
    versiones: 1,
  };
}

function analizarSoporte(row: SoporteRow): Incidencia[] {
  const incidencias: Incidencia[] = [];

  if (!row.nombre_soporte.trim()) {
    incidencias.push({ nivel: "critico", mensaje: "Falta el nombre del soporte." });
  }

  const spec = getIABFormatById(row.iab_format);
  if (!spec) {
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
    mensaje: `${spec.ancho}x${spec.alto}px · máx ${spec.pesoMaximoKB}KB · zona segura ${spec.zonaSeguraPx}px.`,
  });

  return incidencias;
}

export function BriefForm({
  project,
  formats,
}: {
  project: Project;
  formats: ProjectFormat[];
}) {
  const [cliente, setCliente] = useState(project.cliente ?? "");
  const [producto, setProducto] = useState(project.producto ?? "");
  const [objetivo, setObjetivo] = useState(project.objetivo ?? "");
  const [fechaInicio, setFechaInicio] = useState(project.fecha_inicio ?? "");
  const [fechaFin, setFechaFin] = useState(project.fecha_fin ?? "");
  const [presupuesto, setPresupuesto] = useState(
    project.presupuesto != null ? String(project.presupuesto) : "",
  );

  const [rows, setRows] = useState<SoporteRow[]>(
    formats.length > 0
      ? formats.map((f) => ({
          key: f.id,
          id: f.id,
          nombre_soporte: f.nombre_soporte,
          iab_format: f.iab_format,
          url_destino: f.url_destino ?? "",
          versiones: f.versiones,
        }))
      : [newRow()],
  );

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
    setRows((prev) => [...prev, newRow()]);
  }

  function removeRow(key: string) {
    setRows((prev) => (prev.length > 1 ? prev.filter((r) => r.key !== key) : prev));
    setAnalisis(null);
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
          <CardTitle>Soportes del plan</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre soporte</TableHead>
                <TableHead>Formato IAB</TableHead>
                <TableHead>URL destino</TableHead>
                <TableHead className="w-28">Versiones</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const rowAnalisis = analisis?.find((a) => a.key === row.key);
                return (
                  <Fragment key={row.key}>
                    <TableRow>
                      <TableCell>
                        <Input
                          value={row.nombre_soporte}
                          onChange={(e) => updateRow(row.key, { nombre_soporte: e.target.value })}
                          placeholder="Ej. Home – Marca Blanca"
                        />
                      </TableCell>
                      <TableCell>
                        <Select
                          value={row.iab_format}
                          onValueChange={(value) =>
                            value && updateRow(row.key, { iab_format: value })
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {IAB_SPECS.map((spec) => (
                              <SelectItem key={spec.id} value={spec.id}>
                                {spec.nombre} ({spec.ancho}x{spec.alto})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
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
                        <TableCell colSpan={5}>
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
              + Añadir soporte
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
