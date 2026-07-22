"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import type { MasterChangeEntry, MasterStatusResponse } from "@/lib/master";

const STEP_LABELS: Record<string, string> = {
  "leyendo-assets": "Leyendo capas del PSD...",
  "seleccionando-formato": "Seleccionando formato de canvas...",
  "construyendo-html": "Construyendo el HTML5 del master...",
  renderizando: "Renderizando JPG y PNG...",
  "subiendo-archivos": "Subiendo archivos...",
  completado: "Completado",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MasterView({
  projectId,
  cliente,
  producto,
  initialStatus,
  formatsSummary,
  hasUnblockedFormat,
  secondLargestFormat,
  initialChanges,
}: {
  projectId: string;
  cliente: string;
  producto: string | null;
  initialStatus: MasterStatusResponse;
  formatsSummary: { ready: number; blocked: number };
  hasUnblockedFormat: boolean;
  secondLargestFormat: { iabFormat: string; nombreSoporte: string } | null;
  initialChanges: MasterChangeEntry[];
}) {
  const [status, setStatus] = useState(initialStatus);
  const [generating, setGenerating] = useState(false);
  const [generatingVariant, setGeneratingVariant] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  const [sendingApproval, setSendingApproval] = useState(false);
  const [approvalUrl, setApprovalUrl] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  const [changeText, setChangeText] = useState("");
  const [changes, setChanges] = useState<MasterChangeEntry[]>(initialChanges);
  const [applyingChange, setApplyingChange] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);

  const isGenerating = status.projectStatus === "master_generating";
  const hasMaster = status.masters.length > 0;

  useEffect(() => {
    if (status.projectStatus !== "master_generating") return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/master/status/${projectId}`, { cache: "no-store" });
        if (!res.ok) return;
        const next = (await res.json()) as MasterStatusResponse;
        setStatus(next);
      } catch {
        // Reintenta en el próximo tick del polling.
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [status.projectStatus, projectId]);

  async function handleGenerate(iabFormatId?: string, isPrimary = true) {
    const setBusy = isPrimary ? setGenerating : setGeneratingVariant;
    setBusy(true);
    setGenError(null);

    try {
      const res = await fetch("/api/master/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, iabFormatId, isPrimary }),
      });
      const data = await res.json();

      if (!res.ok) {
        setGenError(data.error ?? "No se pudo lanzar la generación del master.");
        setBusy(false);
        return;
      }

      setStatus((prev) => ({ ...prev, projectStatus: "master_generating" }));
    } catch {
      setGenError("Error de red al lanzar la generación del master.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSendApproval() {
    setSendingApproval(true);
    setApprovalError(null);
    setApprovalUrl(null);

    try {
      const res = await fetch("/api/master/approve-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const data = await res.json();

      if (!res.ok) {
        setApprovalError(data.error ?? "No se pudo enviar el master para aprobación.");
        return;
      }

      setApprovalUrl(data.url as string);
    } catch {
      setApprovalError("Error de red al enviar el master.");
    } finally {
      setSendingApproval(false);
    }
  }

  async function handleApplyChange() {
    if (!changeText.trim()) return;

    setApplyingChange(true);
    setChangeError(null);

    try {
      const res = await fetch("/api/master/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, changeDescription: changeText.trim() }),
      });
      const data = await res.json();

      if (!res.ok) {
        setChangeError(data.error ?? "No se pudo aplicar el cambio.");
        return;
      }

      setChanges((prev) => [data.change as MasterChangeEntry, ...prev]);
      setChangeText("");
      // El iframe apunta siempre a /api/preview/[projectId] — el HTML ya se
      // actualizó en el servidor, así que solo hace falta forzar que el
      // navegador vuelva a pedirlo en vez de servir la copia cacheada.
      setPreviewNonce((n) => n + 1);
    } catch {
      setChangeError("Error de red al aplicar el cambio.");
    } finally {
      setApplyingChange(false);
    }
  }

  const primaryMaster = status.masters.find((m) => m.isPrimary) ?? status.masters[0] ?? null;
  const otherMasters = status.masters.filter((m) => m.id !== primaryMaster?.id);
  const variantAlreadyExists =
    secondLargestFormat != null && status.masters.some((m) => m.iabFormat === secondLargestFormat.iabFormat);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">
          Master — {cliente}
          {producto ? ` · ${producto}` : ""}
        </h1>
        <p className="text-sm text-muted-foreground">
          Previsualiza y aprueba el master antes de lanzar la producción de adaptaciones.
        </p>
      </div>

      {!hasMaster && !isGenerating && (
        <Card>
          <CardHeader>
            <CardTitle>Generar master</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {formatsSummary.ready} formato{formatsSummary.ready === 1 ? "" : "s"} listo
              {formatsSummary.ready === 1 ? "" : "s"} · {formatsSummary.blocked} bloqueado
              {formatsSummary.blocked === 1 ? "" : "s"}
            </p>
            {hasUnblockedFormat ? (
              <Button onClick={() => handleGenerate()} disabled={generating}>
                {generating ? "Lanzando..." : "Generar master"}
              </Button>
            ) : (
              <p className="text-sm text-destructive">
                Todos los formatos del plan están bloqueados por incidencias críticas. Resuelve el análisis antes
                de generar el master.
              </p>
            )}
            {genError && <p className="text-sm text-destructive">{genError}</p>}
          </CardContent>
        </Card>
      )}

      {isGenerating && (
        <Card>
          <CardHeader>
            <CardTitle>Generando master...</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${Math.round((status.progress ?? 0) * 100)}%` }}
              />
            </div>
            <p className="text-sm text-muted-foreground">
              {status.step ? (STEP_LABELS[status.step] ?? status.step) : "Preparando..."}
            </p>
          </CardContent>
        </Card>
      )}

      {hasMaster && !isGenerating && primaryMaster && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Master</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {status.hasHtml5 ? (
                <div className="flex flex-wrap items-start gap-4">
                  <div
                    className="max-h-[70vh] max-w-full border border-border"
                    style={{ borderRadius: 0, overflow: "hidden" }}
                  >
                    <iframe
                      src={`/api/preview/${projectId}${previewNonce > 0 ? `?v=${previewNonce}` : ""}`}
                      width={primaryMaster.width}
                      height={primaryMaster.height}
                      style={{ border: 0, display: "block", borderRadius: 0 }}
                      title="Preview del master (HTML5)"
                    />
                  </div>
                  {primaryMaster.jpgUrl && (
                    <div className="flex flex-col items-start gap-1">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={primaryMaster.jpgUrl}
                        alt="Fallback JPG del master"
                        className="w-32 rounded-md border border-border"
                      />
                      <p className="text-xs text-muted-foreground">
                        JPG alternativo
                        {primaryMaster.jpgSizeBytes != null ? ` (${formatBytes(primaryMaster.jpgSizeBytes)})` : ""}
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="max-h-[70vh] overflow-auto rounded-md border border-border">
                  {primaryMaster.jpgUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={primaryMaster.jpgUrl} alt="Preview del master" className="block" />
                  )}
                </div>
              )}
              {status.hasHtml5 && (
                <p className="text-xs text-muted-foreground">
                  El iframe solo verifica estructura y animación — los assets (PNG/JPG) no cargan aquí
                  porque se referencian por nombre de fichero relativo. Descarga el ZIP para ver el
                  banner completo.
                </p>
              )}
              <p className="text-sm text-muted-foreground">
                {primaryMaster.width}×{primaryMaster.height}px
                {status.zipSizeBytes != null ? ` · ZIP ${formatBytes(status.zipSizeBytes)}` : ""}
              </p>

              <div className="flex flex-wrap items-center gap-3">
                {secondLargestFormat && !variantAlreadyExists && (
                  <Button
                    variant="outline"
                    disabled={generatingVariant}
                    onClick={() => handleGenerate(secondLargestFormat.iabFormat, false)}
                  >
                    {generatingVariant
                      ? "Lanzando..."
                      : `Generar segunda variante (${secondLargestFormat.nombreSoporte})`}
                  </Button>
                )}

                <Button onClick={handleSendApproval} disabled={sendingApproval}>
                  {sendingApproval ? "Enviando..." : "Enviar al cliente para aprobación"}
                </Button>
              </div>

              {genError && <p className="text-sm text-destructive">{genError}</p>}
              {approvalError && <p className="text-sm text-destructive">{approvalError}</p>}
              {approvalUrl && (
                <p className="text-sm text-green-600">
                  Enviado. Link de aprobación: <span className="break-all">{approvalUrl}</span>
                </p>
              )}
              {status.projectStatus === "approved" && (
                <p className="text-sm text-green-600">El cliente ya aprobó este master.</p>
              )}
            </CardContent>
          </Card>

          {status.hasHtml5 && (
            <Card>
              <CardHeader>
                <CardTitle>Solicitar cambio</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Textarea
                  placeholder={
                    'Describe el cambio que quieres aplicar...\n' +
                    'Ej: "El background se mueve demasiado rápido, ponlo a 1.2s"\n' +
                    'Ej: "El texto del frame 2 debería aparecer 500ms más tarde"\n' +
                    'Ej: "El CTA debería quedarse visible en el último frame"'
                  }
                  value={changeText}
                  onChange={(e) => setChangeText(e.target.value)}
                  rows={4}
                />
                <Button onClick={handleApplyChange} disabled={applyingChange || !changeText.trim()}>
                  {applyingChange ? "Aplicando..." : "Aplicar cambio"}
                </Button>
                {changeError && <p className="text-sm text-destructive">{changeError}</p>}

                {changes.length > 0 && (
                  <div className="space-y-2 pt-2">
                    <p className="text-xs font-medium text-muted-foreground">Historial de cambios</p>
                    <ul className="space-y-1.5">
                      {changes.map((change) => (
                        <li key={change.id} className="rounded-md border border-border p-2 text-xs">
                          <p>{change.description}</p>
                          <p className="text-muted-foreground">
                            {new Date(change.requestedAt).toLocaleString()}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {otherMasters.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Otras variantes</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                {otherMasters.map((variant) => (
                  <div key={variant.id} className="space-y-2">
                    {variant.jpgUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={variant.jpgUrl}
                        alt={`Variante ${variant.iabFormat}`}
                        className="w-full rounded-md border border-border"
                      />
                    )}
                    <p className="text-xs text-muted-foreground">
                      {variant.iabFormat} · {variant.width}×{variant.height}px
                      {variant.jpgSizeBytes != null ? ` · ${formatBytes(variant.jpgSizeBytes)}` : ""}
                    </p>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
