"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DeliveryPiece, DeliveryZipInfo } from "@/lib/delivery";

const MAX_PREVIEW_WIDTH = 400;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Escalado del iframe manteniendo proporción, tope MAX_PREVIEW_WIDTH de ancho en el grid. */
function scaledDimensions(width: number | null, height: number | null): { width: number; height: number; scale: number } {
  const nativeWidth = width ?? 300;
  const nativeHeight = height ?? 250;
  const scale = Math.min(1, MAX_PREVIEW_WIDTH / nativeWidth);
  return { width: Math.round(nativeWidth * scale), height: Math.round(nativeHeight * scale), scale };
}

function PiecePreview({ projectId, piece }: { projectId: string; piece: DeliveryPiece }) {
  const nativeWidth = piece.width ?? 300;
  const nativeHeight = piece.height ?? 250;
  const { width: boxWidth, height: boxHeight, scale } = scaledDimensions(piece.width, piece.height);
  const previewUrl = `/api/preview/${projectId}/adaptation/${piece.id}`;

  return (
    <div
      className="relative overflow-hidden rounded-md border border-border bg-[#070A0F]"
      style={{ width: boxWidth, height: boxHeight }}
    >
      <iframe
        src={previewUrl}
        title={`Preview HTML5 — ${piece.nombreSoporte}`}
        style={{
          width: nativeWidth,
          height: nativeHeight,
          border: 0,
          transform: `scale(${scale})`,
          transformOrigin: "0 0",
          pointerEvents: "none",
        }}
      />
      {/* Overlay clicable: abre el HTML5 a tamaño real en una pestaña nueva en vez de interactuar con el iframe escalado. */}
      <button
        type="button"
        aria-label={`Abrir ${piece.nombreSoporte} a tamaño real`}
        onClick={() => window.open(previewUrl, "_blank", "noopener,noreferrer")}
        className="absolute inset-0 cursor-zoom-in bg-transparent"
      />
    </div>
  );
}

export function DeliveryView({
  projectId,
  pieces,
  zip,
}: {
  projectId: string;
  pieces: DeliveryPiece[];
  zip: DeliveryZipInfo | null;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  async function handleCopyLink() {
    if (!zip?.downloadUrl) return;
    setCopyError(null);

    try {
      await navigator.clipboard.writeText(zip.downloadUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      setCopyError("No se pudo copiar el link. Cópialo manualmente desde el botón de descarga.");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Entrega</h1>
        <p className="text-sm text-muted-foreground">
          {pieces.length} pieza{pieces.length === 1 ? "" : "s"} · {pieces.length} formato
          {pieces.length === 1 ? "" : "s"}
          {zip?.sizeBytes != null ? ` · ${formatBytes(zip.sizeBytes)} el ZIP` : ""}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Descarga</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={!zip?.downloadUrl} render={<a href={zip?.downloadUrl ?? undefined} download />}>
              Descargar ZIP
            </Button>
            <Button variant="outline" disabled={!zip?.downloadUrl} onClick={handleCopyLink}>
              {copied ? "Link copiado" : "Copiar link de preview"}
            </Button>
          </div>
          {!zip && <p className="text-sm text-muted-foreground">El ZIP todavía no está listo.</p>}
          {copyError && <p className="text-sm text-destructive">{copyError}</p>}
        </CardContent>
      </Card>

      {pieces.length === 0 ? (
        <p className="text-sm text-muted-foreground">Todavía no hay piezas producidas.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {pieces.map((piece) => (
            <Card key={piece.id}>
              <CardContent className="space-y-2 pt-4">
                <PiecePreview projectId={projectId} piece={piece} />
                <p className="text-sm font-medium">{piece.nombreSoporte}</p>
                <p className="text-xs text-muted-foreground">
                  {piece.iabFormat} · {piece.width}×{piece.height}px
                  {piece.jpgSizeBytes != null ? ` · ${formatBytes(piece.jpgSizeBytes)}` : ""}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
