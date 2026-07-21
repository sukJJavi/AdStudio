"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ProductionStatusResponse } from "@/lib/production";

const STATUS_ICON: Record<string, string> = {
  blocked: "🔴",
  pending: "⚪",
  producing: "🟡",
  ready: "✅",
  incident: "⚠️",
};

export function ProductionView({
  projectId,
  initialStatus,
}: {
  projectId: string;
  initialStatus: ProductionStatusResponse;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isProducing = status.projectStatus === "producing";
  const isDone = status.projectStatus === "delivery_ready";

  useEffect(() => {
    if (status.projectStatus !== "producing") return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/production/status/${projectId}`, { cache: "no-store" });
        if (!res.ok) return;
        const next = (await res.json()) as ProductionStatusResponse;
        setStatus(next);
      } catch {
        // Reintenta en el próximo tick del polling.
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [status.projectStatus, projectId]);

  async function handleStart() {
    setStarting(true);
    setError(null);

    try {
      const res = await fetch("/api/production/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "No se pudo iniciar la producción.");
        return;
      }

      setStatus((prev) => ({ ...prev, projectStatus: "producing" }));
    } catch {
      setError("Error de red al iniciar la producción.");
    } finally {
      setStarting(false);
    }
  }

  const producedCount = status.formats.filter((f) => f.status === "ready").length;
  const producibleFormats = status.formats.filter((f) => f.status !== "blocked");
  const blockedFormats = status.formats.filter((f) => f.status === "blocked");
  const progressPct = status.progress != null ? Math.round(status.progress * 100) : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Producción de adaptaciones</h1>
        <p className="text-sm text-muted-foreground">
          Genera el HTML5 animado + JPG de respaldo para cada formato del plan.
        </p>
      </div>

      {status.projectStatus === "approved" && (
        <Card>
          <CardHeader>
            <CardTitle>Iniciar producción de adaptaciones</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button onClick={handleStart} disabled={starting || producibleFormats.length === 0}>
              {starting ? "Lanzando..." : "Iniciar producción de adaptaciones"}
            </Button>
            {error && <p className="text-sm text-destructive">{error}</p>}

            <div>
              <p className="mb-2 text-sm font-medium">
                Se producirán {producibleFormats.length} formato{producibleFormats.length === 1 ? "" : "s"}:
              </p>
              <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
                {producibleFormats.map((f) => (
                  <li key={f.id} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
                    <span>{f.nombreSoporte}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {f.width}×{f.height}
                    </span>
                  </li>
                ))}
              </ul>
              {blockedFormats.length > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {blockedFormats.length} formato{blockedFormats.length === 1 ? "" : "s"} bloqueado
                  {blockedFormats.length === 1 ? "" : "s"} por incidencias críticas no se producirá
                  {blockedFormats.length === 1 ? "" : "n"}.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {(isProducing || isDone) && (
        <Card>
          <CardHeader>
            <CardTitle>{isDone ? "Producción completada" : "Produciendo..."}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${isDone ? 100 : progressPct}%` }}
                />
              </div>
              {isProducing && status.step && <p className="text-sm text-muted-foreground">{status.step}...</p>}
              {isDone && (
                <p className="text-sm text-green-600">
                  {producedCount} adaptaci{producedCount === 1 ? "ón" : "ones"} producida
                  {producedCount === 1 ? "" : "s"} correctamente.
                </p>
              )}
            </div>

            <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
              {status.formats.map((f) => (
                <li
                  key={f.id}
                  className={cn(
                    "flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5",
                    f.status === "producing" && "border-primary",
                  )}
                >
                  <span aria-hidden>{STATUS_ICON[f.status] ?? "⚪"}</span>
                  <span>{f.nombreSoporte}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {f.width}×{f.height}
                  </span>
                </li>
              ))}
            </ul>

            {isDone && (
              <Button onClick={() => router.push(`/project/${projectId}/delivery`)}>Ir a entrega</Button>
            )}
          </CardContent>
        </Card>
      )}

      {!["approved", "producing", "delivery_ready"].includes(status.projectStatus) && (
        <p className="text-sm text-muted-foreground">
          El master todavía no ha sido aprobado por el cliente. Vuelve a esta página cuando lo apruebe.
        </p>
      )}
    </div>
  );
}
