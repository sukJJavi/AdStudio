"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FormatIncidentCard } from "@/components/incident-report/format-incident-card";
import type { AnalysisStatusResponse } from "@/lib/iab/incident-analyzer";

/** Estados previos a que exista siquiera un análisis en curso o terminado. */
const PENDING_STATUSES = new Set(["draft", "upload"]);

export function AnalysisView({
  projectId,
  initialData,
}: {
  projectId: string;
  initialData: AnalysisStatusResponse;
}) {
  const router = useRouter();
  const [data, setData] = useState(initialData);
  const [triggering, setTriggering] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  useEffect(() => {
    if (data.projectStatus !== "analyzing") return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/analysis/status/${projectId}`, { cache: "no-store" });
        if (!res.ok) return;
        const next = (await res.json()) as AnalysisStatusResponse;
        setData(next);
      } catch {
        // Reintenta en el próximo tick del polling.
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [data.projectStatus, projectId]);

  const isPending = PENDING_STATUSES.has(data.projectStatus);
  const isAnalyzing = data.projectStatus === "analyzing";
  const isCompleted = !isPending && !isAnalyzing;
  const hasAnyIncidencia = data.formats.some((f) => f.incidencias.length > 0);
  const hasReadyFormat = data.formats.some((f) => f.derivedStatus !== "blocked");

  async function handleAnalizar() {
    setTriggering(true);
    setTriggerError(null);

    try {
      const res = await fetch("/api/analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const resData = await res.json();

      if (!res.ok) {
        setTriggerError(resData.error ?? "No se pudo lanzar el análisis.");
        return;
      }

      setData((prev) => ({ ...prev, projectStatus: "analyzing" }));
    } catch {
      setTriggerError("Error de red al lanzar el análisis.");
    } finally {
      setTriggering(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm">
        {isPending && <span className="font-medium">Análisis pendiente</span>}
        {isAnalyzing && (
          <>
            <span className="h-2 w-2 animate-pulse rounded-full bg-primary" aria-hidden />
            <span className="font-medium">Analizando material...</span>
          </>
        )}
        {isCompleted && <span className="font-medium">Análisis completado</span>}
      </div>

      {isPending && (
        <p className="text-sm text-muted-foreground">
          Todavía no se ha analizado el material de este proyecto. Sube al menos un PSD y el
          Excel de adaptaciones desde la fase de Upload, o lánzalo manualmente aquí.
        </p>
      )}

      {isCompleted && !hasAnyIncidencia && data.formats.length > 0 && (
        <p className="text-sm text-green-600">✅ Todo correcto — no se detectaron incidencias.</p>
      )}

      {isCompleted && data.formats.length > 0 && (
        <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
          <span>🟢 {data.summary.ready} listos</span>
          <span>🟡 {data.summary.warning} con avisos</span>
          <span>🔴 {data.summary.blocked} bloqueados</span>
        </div>
      )}

      {isCompleted &&
        (data.formats.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Este proyecto todavía no tiene formatos definidos en el brief.
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {data.formats.map((format) => (
              <FormatIncidentCard key={format.id} format={format} />
            ))}
          </div>
        ))}

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={handleAnalizar} disabled={triggering || isAnalyzing} variant={isPending ? "default" : "outline"}>
          {triggering ? "Lanzando..." : isAnalyzing ? "Analizando..." : "Analizar material"}
        </Button>

        {isCompleted && (
          <Button disabled={!hasReadyFormat} onClick={() => router.push(`/project/${projectId}/master`)}>
            Continuar al master
          </Button>
        )}
      </div>

      {triggerError && <p className="text-sm text-destructive">{triggerError}</p>}
    </div>
  );
}
