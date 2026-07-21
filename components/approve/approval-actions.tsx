"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type Mode = "idle" | "requesting-changes" | "approved" | "changes-sent";

export function ApprovalActions({ token }: { token: string }) {
  const [mode, setMode] = useState<Mode>("idle");
  const [comments, setComments] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleApprove() {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/master/approve", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "No se pudo aprobar el master.");
        return;
      }

      setMode("approved");
    } catch {
      setError("Error de red al aprobar el master.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSendChanges() {
    if (!comments.trim()) return;
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/master/request-changes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, comments: comments.trim() }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "No se pudieron enviar los comentarios.");
        return;
      }

      setMode("changes-sent");
    } catch {
      setError("Error de red al enviar los comentarios.");
    } finally {
      setBusy(false);
    }
  }

  if (mode === "approved") {
    return <p className="text-sm text-green-600">Master aprobado. El equipo comenzará las adaptaciones.</p>;
  }

  if (mode === "changes-sent") {
    return <p className="text-sm text-green-600">Tus comentarios han sido enviados.</p>;
  }

  return (
    <div className="space-y-3">
      {mode === "idle" && (
        <div className="flex flex-wrap gap-3">
          <Button onClick={handleApprove} disabled={busy}>
            {busy ? "Aprobando..." : "Aprobar master"}
          </Button>
          <Button variant="outline" onClick={() => setMode("requesting-changes")} disabled={busy}>
            Solicitar cambios
          </Button>
        </div>
      )}

      {mode === "requesting-changes" && (
        <div className="space-y-3">
          <Textarea
            placeholder="Describe los cambios que necesitas..."
            value={comments}
            onChange={(e) => setComments(e.target.value)}
          />
          <div className="flex flex-wrap gap-3">
            <Button onClick={handleSendChanges} disabled={busy || !comments.trim()}>
              {busy ? "Enviando..." : "Enviar comentarios"}
            </Button>
            <Button variant="ghost" onClick={() => setMode("idle")} disabled={busy}>
              Cancelar
            </Button>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
