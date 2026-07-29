"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import type { MasterChangeEntry } from "@/lib/master";

/**
 * Chat de cambios en lenguaje natural sobre un HTML5 (master principal o
 * adaptación Nivel 2) — extraído de components/project/master-view.tsx para
 * reutilizarse también en la revisión de adaptaciones
 * (app/project/[id]/production/[formatId]). `formatId` null = master
 * principal (POST a `endpoint` sin formatId); no-null = adaptación concreta.
 */
export function Html5ChangeChat({
  projectId,
  formatId = null,
  endpoint,
  initialChanges,
  onApplied,
  disabled = false,
}: {
  projectId: string;
  formatId?: string | null;
  endpoint: string;
  initialChanges: MasterChangeEntry[];
  /** Se llama tras aplicar un cambio con éxito — el caller decide qué refrescar (p. ej. forzar recarga del iframe). */
  onApplied?: () => void;
  disabled?: boolean;
}) {
  const [changeText, setChangeText] = useState("");
  const [changes, setChanges] = useState<MasterChangeEntry[]>(initialChanges);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleApply() {
    if (!changeText.trim()) return;

    setApplying(true);
    setError(null);

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          ...(formatId ? { formatId } : {}),
          changeDescription: changeText.trim(),
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "No se pudo aplicar el cambio.");
        return;
      }

      setChanges((prev) => [data.change as MasterChangeEntry, ...prev]);
      setChangeText("");
      onApplied?.();
    } catch {
      setError("Error de red al aplicar el cambio.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Card className="border-[#232935] bg-[#12161F]">
      <CardHeader>
        <CardTitle className="font-display">Solicitar cambio</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          placeholder={
            "Describe el cambio que quieres aplicar...\n" +
            'Ej: "El background se mueve demasiado rápido, ponlo a 1.2s"\n' +
            'Ej: "El texto del frame 2 debería aparecer 500ms más tarde"\n' +
            'Ej: "El CTA debería quedarse visible en el último frame"'
          }
          value={changeText}
          onChange={(e) => setChangeText(e.target.value)}
          rows={4}
          className="border-[#2E3644] bg-[#12161F] focus-visible:border-[#2E80FF]"
        />
        <Button onClick={handleApply} disabled={applying || !changeText.trim() || disabled}>
          {applying ? "Aplicando..." : "Aplicar cambio"}
        </Button>
        {error && <p className="text-sm text-destructive">{error}</p>}

        {changes.length > 0 && (
          <div className="space-y-2 pt-2">
            <p className="font-mono text-xs uppercase tracking-wide text-[#5D6675]">Historial de cambios</p>
            <ul className="space-y-1.5">
              {changes.map((change) => (
                <li key={change.id} className="rounded-md border border-[#232935] bg-[#171C27] p-2 text-xs">
                  <p className="text-[#34C759]">{change.description}</p>
                  <p className="font-mono text-[#5D6675]">{new Date(change.requestedAt).toLocaleString()}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
