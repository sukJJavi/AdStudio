"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DeliveryPiece, DeliveryZipInfo } from "@/lib/delivery";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DeliveryView({
  pieces,
  zip,
}: {
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
                {piece.fallbackJpgUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={piece.fallbackJpgUrl}
                    alt={piece.nombreSoporte}
                    className="w-full rounded-md border border-border"
                  />
                )}
                <p className="text-sm font-medium">{piece.nombreSoporte}</p>
                <p className="text-xs text-muted-foreground">
                  {piece.iabFormat} · {piece.width}×{piece.height}px
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
