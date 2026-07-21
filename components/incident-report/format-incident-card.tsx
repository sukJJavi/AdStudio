"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { AnalysisFormatStatus } from "@/lib/iab/incident-analyzer";
import type { Incidencia, IncidenciaLevel } from "@/lib/types";

const LEVEL_ICON: Record<IncidenciaLevel, string> = {
  critico: "🔴",
  atencion: "🟡",
  aviso: "🟢",
};

const STATUS_BADGE: Record<
  AnalysisFormatStatus["derivedStatus"],
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  ready: { label: "Listo", variant: "default" },
  warning: { label: "Con avisos", variant: "secondary" },
  blocked: { label: "Bloqueado", variant: "destructive" },
};

function IncidenciaRow({ incidencia, showDetail }: { incidencia: Incidencia; showDetail: boolean }) {
  return (
    <li className="flex items-start gap-2">
      <span aria-hidden>{LEVEL_ICON[incidencia.level]}</span>
      <span>
        {incidencia.message}
        {showDetail && (
          <span className="ml-1 text-xs text-muted-foreground">
            ({incidencia.code}
            {incidencia.asset_id ? ` · asset ${incidencia.asset_id.slice(0, 8)}` : ""})
          </span>
        )}
      </span>
    </li>
  );
}

export function FormatIncidentCard({ format }: { format: AnalysisFormatStatus }) {
  const [showDetail, setShowDetail] = useState(false);
  const badge = STATUS_BADGE[format.derivedStatus];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle>{format.nombreSoporte}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {format.ancho && format.alto ? `${format.ancho}×${format.alto}px` : format.iabFormat}
          </p>
        </div>
        <Badge variant={badge.variant} className={cn(format.derivedStatus === "blocked" && "shrink-0")}>
          {badge.label}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        {format.incidencias.length > 0 ? (
          <ul className="space-y-1.5 text-sm">
            {format.incidencias.map((incidencia, index) => (
              <IncidenciaRow
                key={`${incidencia.code}-${index}`}
                incidencia={incidencia}
                showDetail={showDetail}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Sin incidencias.</p>
        )}

        {format.derivedStatus === "blocked" && (
          <Button variant="outline" size="sm" onClick={() => setShowDetail((v) => !v)}>
            {showDetail ? "Ocultar detalle" : "Ver detalle de incidencias"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
