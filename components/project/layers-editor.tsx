"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ProjectLayer } from "@/lib/layers";
import { LAYER_CLASSIFICATIONS, type LayerClassification } from "@/lib/types";

const FRAME_OPTIONS = [0, 1, 2, 3, 4];

const CLASSIFICATION_LABELS: Record<LayerClassification, string> = {
  fondo: "Fondo",
  imagen_principal: "Imagen principal",
  logo: "Logo",
  claim: "Claim",
  subclaim: "Subclaim",
  cta: "CTA",
  disclaimer: "Disclaimer",
  decorativo: "Decorativo",
  texto: "Texto",
  desconocido: "Desconocido",
};

// Colores pedidos para el editor de capas; "disclaimer" no viene en ese listado
// (viene del vocabulario cerrado de .claude/skills/psd-analysis.md) así que se
// le asigna un color propio para no dejarlo sin badge.
const CLASSIFICATION_COLORS: Record<LayerClassification, string> = {
  fondo: "bg-gray-200 text-gray-800",
  imagen_principal: "bg-blue-200 text-blue-800",
  logo: "bg-green-200 text-green-800",
  claim: "bg-yellow-200 text-yellow-800",
  subclaim: "bg-orange-200 text-orange-800",
  cta: "bg-red-200 text-red-800",
  disclaimer: "bg-slate-200 text-slate-800",
  decorativo: "bg-purple-200 text-purple-800",
  texto: "bg-cyan-200 text-cyan-800",
  desconocido: "bg-red-950 text-red-100",
};

function needsFrameFor(layer: Pick<ProjectLayer, "frames" | "persistent">): boolean {
  return !layer.persistent && (layer.frames ?? []).length === 0;
}

async function patchLayer(id: string, body: Record<string, unknown>) {
  const res = await fetch(`/api/layers/asset/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { ok: res.ok, error: data.error as string | undefined };
}

export function LayersEditor({
  projectId,
  initialLayers,
  canvasWidth,
  canvasHeight,
  hasCriticalIncidents,
}: {
  projectId: string;
  initialLayers: ProjectLayer[];
  canvasWidth: number;
  canvasHeight: number;
  hasCriticalIncidents: boolean;
}) {
  const router = useRouter();
  const [layers, setLayers] = useState<ProjectLayer[]>(initialLayers);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [previewFrame, setPreviewFrame] = useState<number | "all">("all");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);

  const sorted = useMemo(() => [...layers].sort((a, b) => a.z_index - b.z_index), [layers]);

  function updateLayer(id: string, patch: Partial<ProjectLayer>) {
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
    setDirty((prev) => new Set(prev).add(id));
  }

  function toggleFrame(layer: ProjectLayer, frameValue: number) {
    const current = layer.frames ?? [];
    const nextFrames = current.includes(frameValue)
      ? current.filter((f) => f !== frameValue)
      : [...current, frameValue].sort((a, b) => a - b);
    // Marcar cualquier frame desmarca "Persistente" (mutuamente excluyentes).
    updateLayer(layer.id, { frames: nextFrames, persistent: false });
  }

  function togglePersistent(layer: ProjectLayer) {
    const next = !layer.persistent;
    // Marcar "Persistente" desmarca todos los frames (mutuamente excluyentes).
    updateLayer(layer.id, { persistent: next, frames: next ? [] : layer.frames });
  }

  async function handleDiscard(id: string) {
    setRemoving((prev) => new Set(prev).add(id));
    await patchLayer(id, { discarded: true });
    setTimeout(() => {
      setLayers((prev) => prev.filter((l) => l.id !== id));
      setDirty((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setRemoving((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 250);
  }

  function handleDrop(targetId: string) {
    if (!draggedId || draggedId === targetId) {
      setDraggedId(null);
      return;
    }

    const order = [...sorted];
    const fromIndex = order.findIndex((l) => l.id === draggedId);
    const toIndex = order.findIndex((l) => l.id === targetId);
    if (fromIndex === -1 || toIndex === -1) {
      setDraggedId(null);
      return;
    }

    const [moved] = order.splice(fromIndex, 1);
    order.splice(toIndex, 0, moved);
    const reindexed = order.map((l, i) => ({ ...l, z_index: i }));

    setLayers((prev) => {
      const byId = new Map(reindexed.map((l) => [l.id, l]));
      return prev.map((l) => byId.get(l.id) ?? l);
    });
    setDraggedId(null);

    fetch(`/api/layers/project/${projectId}/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: reindexed.map((l) => ({ id: l.id, z_index: l.z_index })) }),
    }).catch(() => {
      // Best-effort: si falla, el próximo drag/drop o guardado vuelve a mandar el orden actual.
    });
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);

    try {
      const ids = Array.from(dirty);
      const results = await Promise.all(
        ids.map((id) => {
          const layer = layers.find((l) => l.id === id);
          if (!layer) return Promise.resolve({ ok: true, error: undefined });
          return patchLayer(id, {
            classification: layer.classification,
            frames: layer.frames ?? [],
            persistent: layer.persistent,
            text_content: layer.text_content,
            z_index: layer.z_index,
          });
        }),
      );

      const failed = results.find((r) => !r.ok);
      if (failed) {
        setSaveError(failed.error ?? "No se pudieron guardar algunos cambios.");
        return;
      }

      setDirty(new Set());
      router.refresh();
    } catch {
      setSaveError("Error de red al guardar los cambios.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRegenerar() {
    setRegenerating(true);
    try {
      const res = await fetch("/api/analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      if (res.ok) router.push(`/project/${projectId}/analysis`);
    } finally {
      setRegenerating(false);
    }
  }

  const visible = sorted.filter((l) => !l.discarded);
  const unassigned = visible.filter((l) => needsFrameFor(l));
  const usedFrames = Array.from(new Set(visible.flatMap((l) => l.frames ?? []))).sort((a, b) => a - b);

  const canContinue = unassigned.length === 0 && visible.length > 0 && !hasCriticalIncidents;

  const previewLayers = visible.filter((l) =>
    previewFrame === "all" ? true : l.persistent || (l.frames ?? []).includes(previewFrame),
  );

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <div className="flex w-full flex-col gap-3 lg:w-[40%]">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Capas ({visible.length})</h2>
          {unassigned.length > 0 && (
            <span className="text-xs text-amber-700">{unassigned.length} sin frame</span>
          )}
        </div>

        <ul className="flex flex-col gap-2">
          {sorted
            .filter((l) => !l.discarded)
            .map((layer) => {
              const classification = layer.classification as LayerClassification | null;
              const showTextField = classification === "texto" || !!layer.text_content;
              const needsFrame = needsFrameFor(layer);
              const layerFrames = layer.frames ?? [];

              return (
                <li
                  key={layer.id}
                  draggable
                  onDragStart={() => setDraggedId(layer.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => handleDrop(layer.id)}
                  className={cn(
                    "flex gap-3 rounded-md border border-border p-2 transition-all",
                    needsFrame && "border-amber-300 bg-amber-50",
                    removing.has(layer.id) && "opacity-0 scale-95",
                  )}
                >
                  <span
                    className="mt-1 cursor-grab select-none text-muted-foreground"
                    title="Arrastra para reordenar"
                  >
                    ⠿
                  </span>

                  <div className="flex flex-col items-center gap-1">
                    {layer.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={layer.thumbnailUrl}
                        alt=""
                        className="h-12 w-12 rounded border border-border object-cover"
                      />
                    ) : (
                      <div className="flex h-12 w-12 items-center justify-center rounded border border-dashed border-border bg-muted text-center text-[9px] text-muted-foreground">
                        {layer.layer_name ?? "?"}
                      </div>
                    )}
                    <span className="text-[10px] text-muted-foreground">
                      {Math.round((layer.opacity ?? 1) * 100)}% · {layer.blend_mode ?? "normal"}
                    </span>
                  </div>

                  <div className="flex flex-1 flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium" title={layer.layer_name ?? ""}>
                        {layer.layer_name ?? "capa sin nombre"}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleDiscard(layer.id)}
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                        title="Descartar capa"
                      >
                        🗑
                      </button>
                    </div>

                    {classification && (
                      <Badge className={cn("w-fit", CLASSIFICATION_COLORS[classification])}>
                        {CLASSIFICATION_LABELS[classification] ?? classification}
                      </Badge>
                    )}

                    <select
                      className="w-full rounded-md border border-input bg-transparent px-1.5 py-1 text-xs"
                      value={classification ?? ""}
                      onChange={(e) => updateLayer(layer.id, { classification: e.target.value })}
                    >
                      <option value="" disabled>
                        Sin clasificar
                      </option>
                      {LAYER_CLASSIFICATIONS.map((c) => (
                        <option key={c} value={c}>
                          {CLASSIFICATION_LABELS[c]}
                        </option>
                      ))}
                    </select>

                    <div
                      className={cn(
                        "flex flex-wrap gap-x-3 gap-y-1 rounded-md border border-input px-1.5 py-1 text-xs",
                        needsFrame && "border-amber-400",
                      )}
                    >
                      <label className="flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={layer.persistent}
                          onChange={() => togglePersistent(layer)}
                        />
                        Persistente
                      </label>
                      {FRAME_OPTIONS.map((f) => (
                        <label key={f} className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={layerFrames.includes(f)}
                            onChange={() => toggleFrame(layer, f)}
                          />
                          Frame {f}
                        </label>
                      ))}
                    </div>

                    {showTextField && (
                      <input
                        type="text"
                        className="rounded-md border border-input bg-transparent px-1.5 py-1 text-xs"
                        value={layer.text_content ?? ""}
                        placeholder="Contenido de texto..."
                        onChange={(e) => updateLayer(layer.id, { text_content: e.target.value })}
                      />
                    )}

                    {needsFrame && (
                      <span className="text-[10px] font-medium text-amber-700">⚠ Sin frame asignado</span>
                    )}
                  </div>
                </li>
              );
            })}
        </ul>

        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Button onClick={handleSave} disabled={saving || dirty.size === 0}>
            {saving ? "Guardando..." : `Guardar cambios${dirty.size > 0 ? ` (${dirty.size})` : ""}`}
          </Button>
          <Button variant="outline" onClick={handleRegenerar} disabled={regenerating}>
            {regenerating ? "Lanzando..." : "Regenerar análisis"}
          </Button>
          <Button
            disabled={!canContinue}
            onClick={() => router.push(`/project/${projectId}/master`)}
          >
            Continuar al master
          </Button>
        </div>
        {saveError && <p className="text-sm text-destructive">{saveError}</p>}
        {!canContinue && visible.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {unassigned.length > 0
              ? `${unassigned.length} capa${unassigned.length === 1 ? "" : "s"} sin frame asignado — asigna frame o marca como persistente todas las capas antes de continuar.`
              : hasCriticalIncidents
                ? "Hay incidencias críticas pendientes — regenera el análisis tras reclasificar."
                : ""}
          </p>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1 text-sm">
          <span className="mr-1 text-muted-foreground">Ver:</span>
          <Button
            size="sm"
            variant={previewFrame === "all" ? "default" : "outline"}
            onClick={() => setPreviewFrame("all")}
          >
            Todo
          </Button>
          {usedFrames.map((f) => (
            <Button
              key={f}
              size="sm"
              variant={previewFrame === f ? "default" : "outline"}
              onClick={() => setPreviewFrame(f)}
            >
              Frame {f}
            </Button>
          ))}
        </div>

        <div className="max-w-full overflow-auto rounded-lg border border-border">
          <div
            style={{
              position: "relative",
              width: canvasWidth,
              height: canvasHeight,
              background: "#000",
              overflow: "hidden",
            }}
          >
            {previewLayers.length === 0 && (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Sin capas para este frame.
              </div>
            )}
            {previewLayers.map((layer) =>
              layer.thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={layer.id}
                  src={layer.thumbnailUrl}
                  alt=""
                  style={{
                    position: "absolute",
                    left: Math.max(0, layer.layer_bounds?.x ?? 0),
                    top: Math.max(0, layer.layer_bounds?.y ?? 0),
                    width: layer.layer_bounds?.width ?? "100%",
                    height: layer.layer_bounds?.height ?? "100%",
                    opacity: layer.opacity ?? 1,
                    zIndex: layer.z_index,
                  }}
                />
              ) : (
                <div
                  key={layer.id}
                  className="flex items-center justify-center bg-muted/60 text-center text-[10px] text-muted-foreground"
                  style={{
                    position: "absolute",
                    left: Math.max(0, layer.layer_bounds?.x ?? 0),
                    top: Math.max(0, layer.layer_bounds?.y ?? 0),
                    width: layer.layer_bounds?.width ?? "100%",
                    height: layer.layer_bounds?.height ?? "100%",
                    opacity: layer.opacity ?? 1,
                    zIndex: layer.z_index,
                  }}
                >
                  {layer.layer_name}
                </div>
              ),
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
