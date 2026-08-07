"use client";

import { useEffect, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Html5ChangeChat } from "@/components/project/html5-change-chat";
import type { MasterChangeEntry, MasterStatusResponse, MasterWithUrls } from "@/lib/master";

const STEP_LABELS: Record<string, string> = {
  "leyendo-assets": "Leyendo capas del PSD...",
  "seleccionando-formato": "Seleccionando formato de canvas...",
  "construyendo-html": "Construyendo el HTML5 del master...",
  renderizando: "Renderizando JPG y PNG...",
  "subiendo-archivos": "Subiendo archivos...",
  completado: "Completado",
};

const MAX_PREVIEW_WIDTH = 400;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Escalado del iframe manteniendo proporción, tope MAX_PREVIEW_WIDTH de ancho — mismo patrón que delivery-view.tsx. */
function scaledDimensions(width: number, height: number): { width: number; height: number; scale: number } {
  const scale = Math.min(1, MAX_PREVIEW_WIDTH / width);
  return { width: Math.round(width * scale), height: Math.round(height * scale), scale };
}

/**
 * Tarjeta de un master (uno por PSD subido, ver trigger/render-master.ts) —
 * mismo patrón visual que PieceCard en delivery-view.tsx. Bloque 15: ya no
 * hay distinción "master principal" vs "otros" — todos se muestran igual,
 * cada uno con su propio preview y chat de cambios independientes.
 */
function MasterCard({
  projectId,
  master,
  psdName,
  regenerateNonce,
  initialChanges,
}: {
  projectId: string;
  master: MasterWithUrls;
  psdName: string;
  /** Bump global tras "Regenerar todos los masters" — fuerza recarga de TODOS los iframes. */
  regenerateNonce: number;
  /** Historial de cambios real solo para el master primario (adstudio_changes no tiene columna por-PSD, ver lib/master.ts). */
  initialChanges: MasterChangeEntry[];
}) {
  const [chatOpen, setChatOpen] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  const { width: boxWidth, height: boxHeight, scale } = scaledDimensions(master.width, master.height);
  const previewUrl = master.sourcePsdId
    ? `/api/preview/${projectId}/master/${master.sourcePsdId}`
    : `/api/preview/${projectId}`;
  const nonce = regenerateNonce + reloadNonce;
  const iframeSrc = nonce > 0 ? `${previewUrl}?v=${nonce}` : previewUrl;

  return (
    <Card>
      <CardContent className="space-y-2 pt-4">
        <div
          className="relative overflow-hidden rounded-md border border-border bg-[#070A0F]"
          style={{ width: boxWidth, height: boxHeight }}
        >
          <iframe
            src={iframeSrc}
            title={`Preview del master — ${psdName}`}
            style={{
              width: master.width,
              height: master.height,
              border: 0,
              transform: `scale(${scale})`,
              transformOrigin: "0 0",
              pointerEvents: "none",
            }}
          />
          {/* Overlay clicable: abre el HTML5 a tamaño real en una pestaña nueva. */}
          <button
            type="button"
            aria-label={`Abrir master ${psdName} a tamaño real`}
            onClick={() => window.open(previewUrl, "_blank", "noopener,noreferrer")}
            className="absolute inset-0 cursor-zoom-in bg-transparent"
          />
        </div>
        <p className="text-sm font-medium">{psdName}</p>
        <p className="text-xs text-muted-foreground">
          {master.width}×{master.height}px
          {master.jpgSizeBytes != null ? ` · ${formatBytes(master.jpgSizeBytes)}` : ""}
        </p>
        <Button variant="outline" size="sm" className="w-full" onClick={() => setChatOpen((v) => !v)}>
          {chatOpen ? "Ocultar chat de cambios" : "Ajustar este master"}
        </Button>
        {master.zipUrl && (
          <a
            href={master.zipUrl}
            download
            className={buttonVariants({ variant: "outline", size: "sm", className: "w-full" })}
          >
            Descargar master (ZIP)
          </a>
        )}
        {chatOpen && (
          <Html5ChangeChat
            projectId={projectId}
            endpoint="/api/master/refine"
            extraBody={{ sourcePsdId: master.sourcePsdId }}
            initialChanges={master.isPrimary ? initialChanges : []}
            onApplied={() => setReloadNonce((n) => n + 1)}
          />
        )}
      </CardContent>
    </Card>
  );
}

export function MasterView({
  projectId,
  cliente,
  producto,
  initialStatus,
  formatsSummary,
  hasUnblockedFormat,
  initialChanges,
  psdNamesById = {},
}: {
  projectId: string;
  cliente: string;
  producto: string | null;
  initialStatus: MasterStatusResponse;
  formatsSummary: { ready: number; blocked: number };
  hasUnblockedFormat: boolean;
  initialChanges: MasterChangeEntry[];
  /** PSD (adstudio_assets.id) -> layer_name, para etiquetar cada tarjeta del grid. */
  psdNamesById?: Record<string, string>;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  const [regenerating, setRegenerating] = useState(false);
  const [regenerateNonce, setRegenerateNonce] = useState(0);

  const [sendingApproval, setSendingApproval] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [approvalCopied, setApprovalCopied] = useState(false);
  // El origin solo existe en el navegador — se resuelve tras montar para no
  // desincronizar el render de servidor/cliente (hydration mismatch).
  const [origin, setOrigin] = useState<string | null>(null);
  useEffect(() => setOrigin(window.location.origin), []);

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

  /** Generación inicial — sin iabFormatId, trigger/render-master.ts genera UN master por cada PSD subido. */
  async function handleGenerate() {
    setGenerating(true);
    setGenError(null);

    try {
      const res = await fetch("/api/master/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, isPrimary: true }),
      });
      const data = await res.json();

      if (!res.ok) {
        setGenError(data.error ?? "No se pudo lanzar la generación de los masters.");
        setGenerating(false);
        return;
      }

      setStatus((prev) => ({ ...prev, projectStatus: "master_generating" }));
    } catch {
      setGenError("Error de red al lanzar la generación de los masters.");
    } finally {
      setGenerating(false);
    }
  }

  /**
   * Regenera TODOS los masters (uno por PSD). A diferencia de handleGenerate,
   * no toca `status.projectStatus` mientras regenera: los masters ya
   * generados se mantienen visibles y solo al terminar se refresca el status
   * y se fuerza la recarga de todos los iframes con el nonce.
   */
  async function handleRegenerateAll() {
    setRegenerating(true);
    setGenError(null);

    try {
      const res = await fetch("/api/master/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, isPrimary: true }),
      });
      const data = await res.json();

      if (!res.ok) {
        setGenError(data.error ?? "No se pudieron regenerar los masters.");
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

      setRegenerateNonce((n) => n + 1);
    } catch {
      setGenError("Error de red al regenerar los masters.");
    } finally {
      setRegenerating(false);
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">
          Master — {cliente}
          {producto ? ` · ${producto}` : ""}
        </h1>
        <p className="text-sm text-muted-foreground">
          Previsualiza y aprueba los masters antes de lanzar la producción de adaptaciones.
        </p>
      </div>

      {!hasMaster && !isGenerating && (
        <Card>
          <CardHeader>
            <CardTitle>Generar masters</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {formatsSummary.ready} formato{formatsSummary.ready === 1 ? "" : "s"} listo
              {formatsSummary.ready === 1 ? "" : "s"} · {formatsSummary.blocked} bloqueado
              {formatsSummary.blocked === 1 ? "" : "s"}
            </p>
            {hasUnblockedFormat ? (
              <Button onClick={handleGenerate} disabled={generating}>
                {generating ? "Lanzando..." : "Generar masters"}
              </Button>
            ) : (
              <p className="text-sm text-destructive">
                Todos los formatos del plan están bloqueados por incidencias críticas. Resuelve el análisis antes
                de generar los masters.
              </p>
            )}
            {genError && <p className="text-sm text-destructive">{genError}</p>}
          </CardContent>
        </Card>
      )}

      {isGenerating && (
        <Card>
          <CardHeader>
            <CardTitle>Generando masters...</CardTitle>
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

      {hasMaster && !isGenerating && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={handleRegenerateAll} disabled={regenerating}>
              {regenerating ? "Regenerando..." : "Regenerar todos los masters"}
            </Button>
            {genError && <p className="text-sm text-destructive">{genError}</p>}
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {status.masters.map((master) => (
              <MasterCard
                key={master.id}
                projectId={projectId}
                master={master}
                psdName={
                  (master.sourcePsdId && psdNamesById[master.sourcePsdId]) || master.iabFormat
                }
                regenerateNonce={regenerateNonce}
                initialChanges={initialChanges}
              />
            ))}
          </div>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Enviar al cliente para aprobación</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            El enlace de aprobación muestra todos los masters del proyecto juntos para que el cliente apruebe el
            conjunto.
          </p>

          {status.approval.state === "none" && (
            <>
              <Button onClick={handleSendApproval} disabled={sendingApproval || !hasMaster}>
                {sendingApproval ? "Generando..." : "Generar link"}
              </Button>
              {!hasMaster && (
                <p className="text-xs text-muted-foreground">Genera los masters antes de crear el link.</p>
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

                <Button variant="outline" size="sm" onClick={handleSendApproval} disabled={sendingApproval}>
                  {sendingApproval ? "Generando..." : "Generar nuevo link"}
                </Button>
              </>
            );
          })()}

          {approvalError && <p className="text-sm text-destructive">{approvalError}</p>}
          {status.projectStatus === "approved" && (
            <p className="text-sm text-[#34C759]">El cliente ya aprobó los masters.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
