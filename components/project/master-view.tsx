"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { MasterStatusResponse } from "@/lib/master";

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
}: {
  projectId: string;
  cliente: string;
  producto: string | null;
  initialStatus: MasterStatusResponse;
  formatsSummary: { ready: number; blocked: number };
  hasUnblockedFormat: boolean;
  secondLargestFormat: { iabFormat: string; nombreSoporte: string } | null;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [generating, setGenerating] = useState(false);
  const [generatingVariant, setGeneratingVariant] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  const [sendingApproval, setSendingApproval] = useState(false);
  const [approvalUrl, setApprovalUrl] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);

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
              <div className="max-h-[70vh] overflow-auto rounded-md border border-border">
                {primaryMaster.jpgUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={primaryMaster.jpgUrl} alt="Preview del master" className="block" />
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {primaryMaster.width}×{primaryMaster.height}px
                {primaryMaster.jpgSizeBytes != null ? ` · ${formatBytes(primaryMaster.jpgSizeBytes)}` : ""}
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
