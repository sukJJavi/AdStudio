"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Html5ChangeChat } from "@/components/project/html5-change-chat";
import { cn } from "@/lib/utils";
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
  formatLabelsByIabFormat = {},
}: {
  projectId: string;
  cliente: string;
  producto: string | null;
  initialStatus: MasterStatusResponse;
  formatsSummary: { ready: number; blocked: number };
  hasUnblockedFormat: boolean;
  secondLargestFormat: { iabFormat: string; nombreSoporte: string } | null;
  initialChanges: MasterChangeEntry[];
  /** Bloque 11: nombre de soporte y si tiene PSD propio, por iab_format — para etiquetar variantes multi-PSD. */
  formatLabelsByIabFormat?: Record<string, { nombreSoporte: string; ownPsd: boolean }>;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [generating, setGenerating] = useState(false);
  const [generatingVariant, setGeneratingVariant] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  const [regeneratingMaster, setRegeneratingMaster] = useState(false);

  const [sendingApproval, setSendingApproval] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [approvalCopied, setApprovalCopied] = useState(false);
  // El origin solo existe en el navegador — se resuelve tras montar para no
  // desincronizar el render de servidor/cliente (hydration mismatch).
  const [origin, setOrigin] = useState<string | null>(null);
  useEffect(() => setOrigin(window.location.origin), []);

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

  /**
   * A diferencia de handleGenerate, no toca `status.projectStatus` mientras regenera:
   * el master ya generado se mantiene visible (el usuario ve el botón "Regenerando..."
   * sin que la vista salte a la tarjeta de progreso de la primera generación) y solo
   * al terminar se refresca el status y se fuerza la recarga del iframe con el nonce.
   */
  async function handleRegenerateMaster() {
    setRegeneratingMaster(true);
    setGenError(null);

    try {
      const res = await fetch("/api/master/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, isPrimary: true }),
      });
      const data = await res.json();

      if (!res.ok) {
        setGenError(data.error ?? "No se pudo regenerar el master.");
        return;
      }

      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const statusRes = await fetch(`/api/master/status/${projectId}`, { cache: "no-store" });
        if (!statusRes.ok) continue;
        const next = (await statusRes.json()) as MasterStatusResponse;
        if (next.projectStatus === "master_generating") continue;
        setStatus(next);
        break;
      }

      setPreviewNonce((n) => n + 1);
    } catch {
      setGenError("Error de red al regenerar el master.");
    } finally {
      setRegeneratingMaster(false);
    }
  }

  async function handleSendApproval() {
    setSendingApproval(true);
    setApprovalError(null);

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

      // El endpoint solo devuelve { token, url } — se recarga el status
      // completo para tener expiresAt/approvedAt y que la sección
      // permanente de abajo (Enlace de aprobación del cliente) se actualice.
      try {
        const statusRes = await fetch(`/api/master/status/${projectId}`, { cache: "no-store" });
        if (statusRes.ok) setStatus(await statusRes.json());
      } catch {
        // Best-effort: si falla, el próximo refresh del status lo recoge.
      }
    } catch {
      setApprovalError("Error de red al enviar el master.");
    } finally {
      setSendingApproval(false);
    }
  }

  async function handleCopyApprovalUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setApprovalCopied(true);
      setTimeout(() => setApprovalCopied(false), 3000);
    } catch {
      // Best-effort: si falla el clipboard, el usuario puede seleccionar el texto a mano.
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

      <Card>
        <CardHeader>
          <CardTitle>Enlace de aprobación del cliente</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {status.approval.state === "none" && (
            <>
              <p className="text-sm text-muted-foreground">
                Todavía no se ha generado un enlace de aprobación para este proyecto.
              </p>
              <Button onClick={handleSendApproval} disabled={sendingApproval || !hasMaster}>
                {sendingApproval ? "Generando..." : "Generar link"}
              </Button>
              {!hasMaster && (
                <p className="text-xs text-muted-foreground">Genera el master antes de crear el link.</p>
              )}
            </>
          )}

          {status.approval.state !== "none" && (() => {
            const approval = status.approval;
            const approvalUrl = origin ? `${origin}/approve/${approval.token}` : null;
            return (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {approval.state === "approved" && (
                    <Badge className="bg-[#34C759] text-white">Aprobado ✓</Badge>
                  )}
                  {approval.state === "pending" && <Badge variant="secondary">Pendiente de aprobación</Badge>}
                  {approval.state === "changes_requested" && (
                    <Badge className="bg-[#FF8A8A] text-black">Cambios solicitados</Badge>
                  )}
                  {approval.state === "approved" && approval.approvedAt && (
                    <span className="text-xs text-muted-foreground">
                      Aprobado el {new Date(approval.approvedAt).toLocaleString()}
                    </span>
                  )}
                  {approval.expiresAt && (
                    <span className="text-xs text-muted-foreground">
                      · Expira el {new Date(approval.expiresAt).toLocaleString()}
                    </span>
                  )}
                </div>

                {approvalUrl && (
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="break-all rounded bg-muted px-2 py-1 text-xs">{approvalUrl}</code>
                    <Button variant="outline" size="sm" onClick={() => handleCopyApprovalUrl(approvalUrl)}>
                      {approvalCopied ? "Copiado" : "Copiar"}
                    </Button>
                  </div>
                )}
              </>
            );
          })()}

          {status.approval.state !== "none" && (
            <Button variant="outline" size="sm" onClick={handleSendApproval} disabled={sendingApproval}>
              {sendingApproval ? "Generando..." : "Generar nuevo link"}
            </Button>
          )}

          {approvalError && <p className="text-sm text-destructive">{approvalError}</p>}
        </CardContent>
      </Card>

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
          <div className={cn("grid gap-4", status.hasHtml5 ? "lg:grid-cols-2" : "grid-cols-1")}>
            <Card className="border-[#232935] bg-[#12161F]">
              <CardHeader>
                <CardTitle className="font-display">Master</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {status.hasHtml5 ? (
                  <div className="flex flex-wrap items-start gap-4 bg-[#070A0F] p-4">
                    <div
                      className="max-h-[70vh] max-w-full border border-[#232935]"
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
                          className="w-32 border border-[#232935]"
                        />
                        <p className="text-xs text-[#9AA3B2]">
                          JPG alternativo
                          {primaryMaster.jpgSizeBytes != null ? ` (${formatBytes(primaryMaster.jpgSizeBytes)})` : ""}
                        </p>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="max-h-[70vh] overflow-auto border border-[#232935] bg-[#070A0F] p-4">
                    {primaryMaster.jpgUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={primaryMaster.jpgUrl} alt="Preview del master" className="block" />
                    )}
                  </div>
                )}
                {status.hasHtml5 && (
                  <p className="text-xs text-[#9AA3B2]">
                    El iframe solo verifica estructura y animación — los assets (PNG/JPG) no cargan aquí
                    porque se referencian por nombre de fichero relativo. Descarga el ZIP para ver el
                    banner completo.
                  </p>
                )}
                <p className="font-mono text-sm text-[#9AA3B2]">
                  {primaryMaster.width}×{primaryMaster.height}px
                  {status.zipSizeBytes != null ? ` · ZIP ${formatBytes(status.zipSizeBytes)}` : ""}
                </p>

                <div className="flex flex-wrap items-center gap-3">
                  {secondLargestFormat && !variantAlreadyExists && (
                    <Button
                      variant="outline"
                      disabled={generatingVariant || regeneratingMaster}
                      onClick={() => handleGenerate(secondLargestFormat.iabFormat, false)}
                    >
                      {generatingVariant
                        ? "Lanzando..."
                        : `Generar segunda variante (${secondLargestFormat.nombreSoporte})`}
                    </Button>
                  )}

                  <Button variant="secondary" onClick={handleRegenerateMaster} disabled={regeneratingMaster}>
                    {regeneratingMaster ? "Regenerando..." : "Regenerar master"}
                  </Button>

                  <Button onClick={handleSendApproval} disabled={sendingApproval || regeneratingMaster}>
                    {sendingApproval ? "Enviando..." : "Enviar al cliente para aprobación"}
                  </Button>
                </div>

                {genError && <p className="text-sm text-destructive">{genError}</p>}
                {status.projectStatus === "approved" && (
                  <p className="text-sm text-[#34C759]">El cliente ya aprobó este master.</p>
                )}
              </CardContent>
            </Card>

            {status.hasHtml5 && (
              <Html5ChangeChat
                projectId={projectId}
                endpoint="/api/master/refine"
                initialChanges={initialChanges}
                disabled={regeneratingMaster}
                onApplied={() => {
                  // El iframe apunta siempre a /api/preview/[projectId] — el HTML ya
                  // se actualizó en el servidor, así que solo hace falta forzar que
                  // el navegador vuelva a pedirlo en vez de servir la copia cacheada.
                  setPreviewNonce((n) => n + 1);
                }}
              />
            )}
          </div>

          {otherMasters.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>
                  {otherMasters.some((v) => formatLabelsByIabFormat[v.iabFormat]?.ownPsd)
                    ? "Otros masters (uno por PSD)"
                    : "Otras variantes"}
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                {otherMasters.map((variant) => {
                  const label = formatLabelsByIabFormat[variant.iabFormat];
                  return (
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
                        {label?.nombreSoporte ?? variant.iabFormat} · {variant.width}×{variant.height}px
                        {variant.jpgSizeBytes != null ? ` · ${formatBytes(variant.jpgSizeBytes)}` : ""}
                        {label?.ownPsd ? " · PSD propio" : ""}
                      </p>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
