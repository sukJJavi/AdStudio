"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Html5ChangeChat } from "@/components/project/html5-change-chat";
import type { MasterChangeEntry } from "@/lib/master";

/**
 * Vista de revisión de un borrador de adaptación Nivel 2 (ver
 * trigger/render-adaptations.ts:classifyFormat) — mismo patrón que
 * components/project/master-view.tsx (iframe + chat de cambios), pero
 * parametrizado por formatId sobre /api/production/refine en vez del master
 * principal.
 */
export function AdaptationReviewView({
  projectId,
  formatId,
  nombreSoporte,
  width,
  height,
  initialChanges,
}: {
  projectId: string;
  formatId: string;
  nombreSoporte: string;
  width: number;
  height: number;
  initialChanges: MasterChangeEntry[];
}) {
  const [previewNonce, setPreviewNonce] = useState(0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Revisión de borrador — {nombreSoporte}</h1>
        <p className="text-sm text-muted-foreground">
          Adaptación Nivel 2 ({width}×{height}px) — solicita cambios por chat antes de darla por definitiva.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="border-[#232935] bg-[#12161F]">
          <CardHeader>
            <CardTitle className="font-display">Borrador</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-start gap-4 bg-[#070A0F] p-4">
              <div
                className="max-h-[70vh] max-w-full border border-[#232935]"
                style={{ borderRadius: 0, overflow: "hidden" }}
              >
                <iframe
                  src={`/api/preview/${projectId}/adaptation/${formatId}${previewNonce > 0 ? `?v=${previewNonce}` : ""}`}
                  width={width}
                  height={height}
                  style={{ border: 0, display: "block", borderRadius: 0 }}
                  title="Preview del borrador de adaptación (HTML5)"
                />
              </div>
            </div>
            <p className="mt-3 text-xs text-[#9AA3B2]">
              El iframe solo verifica estructura y animación — los assets (PNG/JPG) se sirven vía
              /api/preview, no reflejan todavía el ZIP final.
            </p>
          </CardContent>
        </Card>

        <Html5ChangeChat
          projectId={projectId}
          formatId={formatId}
          endpoint="/api/production/refine"
          initialChanges={initialChanges}
          onApplied={() => setPreviewNonce((n) => n + 1)}
        />
      </div>
    </div>
  );
}
