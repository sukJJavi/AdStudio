"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FormatIncidentCard } from "@/components/incident-report/format-incident-card";
import type { AnalysisStatusResponse } from "@/lib/iab/incident-analyzer";

export function AnalysisView({
  projectId,
  initialData,
}: {
  projectId: string;
  initialData: AnalysisStatusResponse;
}) {
  const router = useRouter();
  const [data, setData] = useState(initialData);

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

  const isAnalyzing = data.projectStatus === "analyzing";
  const hasReadyFormat = data.formats.some((f) => f.derivedStatus !== "blocked");

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm">
        {isAnalyzing ? (
          <>
            <span className="h-2 w-2 animate-pulse rounded-full bg-primary" aria-hidden />
            <span className="font-medium">Analizando material...</span>
          </>
        ) : (
          <span className="font-medium">Análisis completado</span>
        )}
      </div>

      <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
        <span>🟢 {data.summary.ready} listos</span>
        <span>🟡 {data.summary.warning} con avisos</span>
        <span>🔴 {data.summary.blocked} bloqueados</span>
      </div>

      {data.formats.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Este proyecto todavía no tiene formatos definidos en el brief.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {data.formats.map((format) => (
            <FormatIncidentCard key={format.id} format={format} />
          ))}
        </div>
      )}

      <Button
        disabled={!hasReadyFormat}
        onClick={() => router.push(`/project/${projectId}/master`)}
      >
        Continuar al master
      </Button>
    </div>
  );
}
