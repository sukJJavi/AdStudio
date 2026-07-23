"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import type { ProjectAsset } from "@/lib/types";

type PendingFile = {
  name: string;
  size: number;
  status: "uploading" | "registering" | "analyzing" | "error";
  progress: number;
  error?: string;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9.\-_]/g, "_");
}

function storageUploadError(responseText: string, status: number): string {
  try {
    const parsed = JSON.parse(responseText);
    if (typeof parsed?.message === "string") return parsed.message;
  } catch {
    // Respuesta no es JSON, se usa el mensaje genérico de abajo.
  }
  return `Error al subir el archivo (${status}).`;
}

// Supabase Storage no expone progreso nativo en su SDK, así que se sube con
// XMLHttpRequest directo a la API REST para poder leer xhr.upload.progress.
function uploadWithProgress(
  file: File,
  filePath: string,
  accessToken: string,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(storageUploadError(xhr.responseText, xhr.status)));
    });

    xhr.addEventListener("error", () => reject(new Error("Error de red al subir el archivo.")));

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const url = `${supabaseUrl}/storage/v1/object/adstudio-projects/${filePath}`;

    xhr.open("POST", url);
    xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);
    xhr.setRequestHeader("apikey", anonKey);
    xhr.setRequestHeader("x-upsert", "false");
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");

    xhr.send(file);
  });
}

/**
 * Sube el archivo directamente al bucket de Supabase Storage desde el
 * browser (evita el límite de ~4.5MB de las API routes de Vercel) y luego
 * registra el asset en BBDD vía POST JSON a /api/upload.
 */
async function uploadAsset(
  projectId: string,
  type: "psd" | "excel" | "animation",
  file: File,
  onProgress: (percent: number) => void,
): Promise<{ ok: true; analysisTriggered: boolean } | { ok: false; error: string }> {
  const supabase = createBrowserSupabaseClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    return { ok: false, error: "Sesión expirada. Recarga la página e inicia sesión de nuevo." };
  }

  const filePath = `${projectId}/${type}/${Date.now()}-${sanitizeFilename(file.name)}`;

  try {
    await uploadWithProgress(file, filePath, session.access_token, onProgress);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Error al subir el archivo." };
  }

  const res = await fetch("/api/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      filePath,
      fileType: type,
      fileName: file.name,
      fileSize: file.size,
    }),
  });
  const data = await res.json();

  if (!res.ok) return { ok: false, error: data.error ?? "Error al registrar el archivo." };
  return { ok: true, analysisTriggered: !!data.analysisTriggered };
}

async function deleteAsset(assetId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`/api/upload/${assetId}`, { method: "DELETE" });
  const data = await res.json();

  if (!res.ok) return { ok: false, error: data.error ?? "No se pudo eliminar el archivo." };
  return { ok: true };
}

async function uploadAnimationText(
  projectId: string,
  text: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const formData = new FormData();
  formData.append("projectId", projectId);
  formData.append("type", "animation");
  formData.append("text", text);

  const res = await fetch("/api/upload", { method: "POST", body: formData });
  const data = await res.json();

  if (!res.ok) return { ok: false, error: data.error ?? "Error al guardar la guía." };
  return { ok: true };
}

async function tryGeneratePsdThumbnail(file: File): Promise<string | null> {
  try {
    const { readPsd } = await import("ag-psd");
    const buffer = await file.arrayBuffer();
    const psd = readPsd(buffer, { skipLayerImageData: true, skipThumbnail: false });
    if (!psd.canvas) return null;
    return (psd.canvas as HTMLCanvasElement).toDataURL("image/png");
  } catch {
    return null;
  }
}

function DropArea({
  label,
  hint,
  onFiles,
  disabled,
}: {
  label: string;
  hint: string;
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (disabled) return;
        onFiles(Array.from(e.dataTransfer.files));
      }}
      className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-8 text-center text-sm transition-colors ${
        disabled
          ? "cursor-not-allowed opacity-50"
          : dragOver
            ? "border-primary bg-primary/5"
            : "border-border hover:border-primary/50"
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        disabled={disabled}
        onChange={(e) => {
          if (e.target.files) onFiles(Array.from(e.target.files));
          e.target.value = "";
        }}
      />
      <span className="font-medium">{label}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </div>
  );
}

function pendingStatusLabel(p: PendingFile): string {
  if (p.status === "error") return p.error ?? "Error";
  if (p.status === "uploading") return `Subiendo... ${p.progress}%`;
  if (p.status === "registering") return "Subido, registrando...";
  if (p.status === "analyzing") return "Analizando...";
  return "";
}

function PendingFileRow({ file, icon }: { file: PendingFile; icon: string }) {
  return (
    <li className="flex flex-col gap-1 rounded-md border border-border p-2 text-sm">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded bg-muted text-xs">{icon}</span>
        <span className="flex-1 truncate">{file.name}</span>
        <span className="text-xs text-muted-foreground">{formatBytes(file.size)}</span>
        <span className={`text-xs ${file.status === "error" ? "text-red-600" : "text-muted-foreground"}`}>
          {pendingStatusLabel(file)}
        </span>
      </div>
      {file.status !== "error" && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all duration-200"
            style={{ width: `${file.status === "uploading" ? file.progress : 100}%` }}
          />
        </div>
      )}
    </li>
  );
}

export function UploadZones({
  projectId,
  initialAssets,
}: {
  projectId: string;
  initialAssets: ProjectAsset[];
}) {
  const router = useRouter();

  const psdAssets = initialAssets.filter((a) => a.layer_type === "psd");
  const excelAssets = initialAssets.filter((a) => a.layer_type === "excel");
  const animationAssets = initialAssets.filter((a) => a.layer_type === "animation");

  const [pendingPsd, setPendingPsd] = useState<PendingFile[]>([]);
  const [pendingExcel, setPendingExcel] = useState<PendingFile[]>([]);
  const [pendingAnimation, setPendingAnimation] = useState<PendingFile[]>([]);

  const [psdThumbnails, setPsdThumbnails] = useState<Record<string, string>>({});
  const [excelPreview, setExcelPreview] = useState<{
    columns: string[];
    rows: string[][];
  } | null>(null);

  const [animationText, setAnimationText] = useState("");
  const [savingText, setSavingText] = useState(false);
  const [textSaved, setTextSaved] = useState(false);

  const [analizando, setAnalizando] = useState(false);
  const [analizarError, setAnalizarError] = useState<string | null>(null);

  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});

  const puedeAnalizar = psdAssets.length > 0 && excelAssets.length > 0;

  async function handleDelete(assetId: string) {
    setDeleteErrors((prev) => {
      const rest = { ...prev };
      delete rest[assetId];
      return rest;
    });
    setRemovingIds((prev) => new Set(prev).add(assetId));

    const result = await deleteAsset(assetId);
    if (result.ok) {
      // Deja que la animación de salida termine antes de refrescar los datos del servidor.
      setTimeout(() => router.refresh(), 200);
    } else {
      setRemovingIds((prev) => {
        const next = new Set(prev);
        next.delete(assetId);
        return next;
      });
      setDeleteErrors((prev) => ({ ...prev, [assetId]: result.error }));
    }
  }

  async function handlePsdFiles(files: File[]) {
    const slotsLeft = 2 - (psdAssets.length + pendingPsd.length);
    const toUpload = files.slice(0, Math.max(slotsLeft, 0));

    for (const file of toUpload) {
      if (!file.name.toLowerCase().endsWith(".psd")) {
        setPendingPsd((prev) => [
          ...prev,
          { name: file.name, size: file.size, status: "error", progress: 0, error: "Solo se aceptan archivos .psd" },
        ]);
        continue;
      }
      if (file.size > 100 * 1024 * 1024) {
        setPendingPsd((prev) => [
          ...prev,
          { name: file.name, size: file.size, status: "error", progress: 0, error: "Supera el máximo de 100MB" },
        ]);
        continue;
      }

      setPendingPsd((prev) => [
        ...prev,
        { name: file.name, size: file.size, status: "uploading", progress: 0 },
      ]);

      tryGeneratePsdThumbnail(file).then((thumb) => {
        if (thumb) setPsdThumbnails((prev) => ({ ...prev, [file.name]: thumb }));
      });

      const result = await uploadAsset(projectId, "psd", file, (percent) => {
        setPendingPsd((prev) =>
          prev.map((p) =>
            p.name === file.name
              ? { ...p, progress: percent, status: percent >= 100 ? "registering" : "uploading" }
              : p,
          ),
        );
      });

      if (result.ok) {
        if (result.analysisTriggered) {
          setPendingPsd((prev) =>
            prev.map((p) => (p.name === file.name ? { ...p, status: "analyzing" } : p)),
          );
          setTimeout(() => {
            setPendingPsd((prev) => prev.filter((p) => p.name !== file.name));
            router.refresh();
          }, 800);
        } else {
          setPendingPsd((prev) => prev.filter((p) => p.name !== file.name));
          router.refresh();
        }
      } else {
        setPendingPsd((prev) =>
          prev.map((p) => (p.name === file.name ? { ...p, status: "error", error: result.error } : p)),
        );
      }
    }
  }

  async function handleExcelFiles(files: File[]) {
    const file = files[0];
    if (!file) return;

    const ext = file.name.toLowerCase();
    if (!ext.endsWith(".xlsx") && !ext.endsWith(".xls")) {
      setPendingExcel([
        { name: file.name, size: file.size, status: "error", progress: 0, error: "Solo se aceptan .xlsx o .xls" },
      ]);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setPendingExcel([
        { name: file.name, size: file.size, status: "error", progress: 0, error: "Supera el máximo de 10MB" },
      ]);
      return;
    }

    setPendingExcel([{ name: file.name, size: file.size, status: "uploading", progress: 0 }]);
    setExcelPreview(null);

    try {
      const XLSX = await import("xlsx");
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array" });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<string[]>(firstSheet, { header: 1 });
      const columns = (rows[0] ?? []).map((c) => String(c ?? ""));
      const previewRows = rows.slice(1, 4).map((r) => (r ?? []).map((c) => String(c ?? "")));
      setExcelPreview({ columns, rows: previewRows });
    } catch {
      // Preview best-effort; si falla igualmente subimos el archivo.
    }

    const result = await uploadAsset(projectId, "excel", file, (percent) => {
      setPendingExcel((prev) =>
        prev.map((p) =>
          p.name === file.name
            ? { ...p, progress: percent, status: percent >= 100 ? "registering" : "uploading" }
            : p,
        ),
      );
    });

    if (result.ok) {
      if (result.analysisTriggered) {
        setPendingExcel((prev) => prev.map((p) => (p.name === file.name ? { ...p, status: "analyzing" } : p)));
        setTimeout(() => {
          setPendingExcel([]);
          router.refresh();
        }, 800);
      } else {
        setPendingExcel([]);
        router.refresh();
      }
    } else {
      setPendingExcel((prev) =>
        prev.map((p) => (p.name === file.name ? { ...p, status: "error", error: result.error } : p)),
      );
    }
  }

  async function handleAnimationFiles(files: File[]) {
    const file = files[0];
    if (!file) return;

    const ext = file.name.toLowerCase();
    if (!ext.endsWith(".pdf") && !ext.endsWith(".txt")) {
      setPendingAnimation([
        { name: file.name, size: file.size, status: "error", progress: 0, error: "Solo se aceptan .pdf o .txt" },
      ]);
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setPendingAnimation([
        { name: file.name, size: file.size, status: "error", progress: 0, error: "Supera el máximo de 20MB" },
      ]);
      return;
    }

    setPendingAnimation([{ name: file.name, size: file.size, status: "uploading", progress: 0 }]);

    const result = await uploadAsset(projectId, "animation", file, (percent) => {
      setPendingAnimation((prev) =>
        prev.map((p) =>
          p.name === file.name
            ? { ...p, progress: percent, status: percent >= 100 ? "registering" : "uploading" }
            : p,
        ),
      );
    });

    if (result.ok) {
      setPendingAnimation([]);
      router.refresh();
    } else {
      setPendingAnimation((prev) =>
        prev.map((p) => (p.name === file.name ? { ...p, status: "error", error: result.error } : p)),
      );
    }
  }

  async function handleGuardarTexto() {
    if (!animationText.trim()) return;
    setSavingText(true);
    setTextSaved(false);

    const result = await uploadAnimationText(projectId, animationText.trim());
    setSavingText(false);
    if (result.ok) {
      setTextSaved(true);
      setAnimationText("");
      router.refresh();
    }
  }

  async function handleAnalizar() {
    setAnalizando(true);
    setAnalizarError(null);

    try {
      const res = await fetch("/api/analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const data = await res.json();

      if (!res.ok) {
        setAnalizarError(data.error ?? "No se pudo lanzar el análisis.");
        setAnalizando(false);
        return;
      }

      router.push(`/project/${projectId}/analysis?status=en-progreso`);
    } catch {
      setAnalizarError("Error de red al lanzar el análisis.");
      setAnalizando(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Zona A — PSD(s)</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <a
            href="/guide/psd"
            target="_blank"
            rel="noopener noreferrer"
            className="w-fit text-xs text-primary underline underline-offset-2 hover:no-underline"
          >
            ¿Cómo preparar tu PSD?
          </a>
          <DropArea
            label="Arrastra 1 o 2 archivos .psd"
            hint="Máximo 100MB cada uno"
            onFiles={handlePsdFiles}
            disabled={psdAssets.length + pendingPsd.length >= 2}
          />
          <ul className="flex flex-col gap-2">
            {psdAssets.map((asset) => (
              <li
                key={asset.id}
                className={`flex items-center gap-3 rounded-md border border-border p-2 text-sm transition-all duration-200 ${
                  removingIds.has(asset.id) ? "-translate-x-2 opacity-0" : "opacity-100"
                }`}
              >
                {psdThumbnails[asset.layer_name ?? ""] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={psdThumbnails[asset.layer_name ?? ""]}
                    alt=""
                    className="h-10 w-10 rounded object-cover"
                  />
                ) : (
                  <span className="flex h-10 w-10 items-center justify-center rounded bg-muted text-xs">
                    PSD
                  </span>
                )}
                <span className="flex-1 truncate">{asset.layer_name}</span>
                {deleteErrors[asset.id] ? (
                  <span className="text-xs text-red-600">{deleteErrors[asset.id]}</span>
                ) : (
                  <span className="text-xs text-green-600">subido</span>
                )}
                <button
                  type="button"
                  aria-label="Eliminar archivo"
                  disabled={removingIds.has(asset.id)}
                  onClick={() => handleDelete(asset.id)}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-red-600 disabled:opacity-50"
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            ))}
            {pendingPsd.map((p) => (
              <PendingFileRow key={p.name} file={p} icon="PSD" />
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Zona B — Excel de adaptaciones</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <DropArea
            label="Arrastra el Excel de adaptaciones"
            hint=".xlsx o .xls · máximo 10MB"
            onFiles={handleExcelFiles}
            disabled={excelAssets.length + pendingExcel.length >= 1}
          />
          <ul className="flex flex-col gap-2">
            {excelAssets.map((asset) => (
              <li
                key={asset.id}
                className={`flex items-center gap-3 rounded-md border border-border p-2 text-sm transition-all duration-200 ${
                  removingIds.has(asset.id) ? "-translate-x-2 opacity-0" : "opacity-100"
                }`}
              >
                <span className="flex h-10 w-10 items-center justify-center rounded bg-muted text-xs">
                  XLS
                </span>
                <span className="flex-1 truncate">{asset.layer_name}</span>
                {deleteErrors[asset.id] ? (
                  <span className="text-xs text-red-600">{deleteErrors[asset.id]}</span>
                ) : (
                  <span className="text-xs text-green-600">subido</span>
                )}
                <button
                  type="button"
                  aria-label="Eliminar archivo"
                  disabled={removingIds.has(asset.id)}
                  onClick={() => handleDelete(asset.id)}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-red-600 disabled:opacity-50"
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            ))}
            {pendingExcel.map((p) => (
              <PendingFileRow key={p.name} file={p} icon="XLS" />
            ))}
          </ul>

          {excelPreview && (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50">
                  <tr>
                    {excelPreview.columns.map((col, i) => (
                      <th key={i} className="px-2 py-1 text-left font-medium">
                        {col || `Columna ${i + 1}`}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {excelPreview.rows.map((row, i) => (
                    <tr key={i} className="border-t border-border">
                      {row.map((cell, j) => (
                        <td key={j} className="px-2 py-1">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Zona C — Guía de animación</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Opcional — si no hay guía se aplicará preset de animación estándar IAB.
          </p>
          <DropArea
            label="Arrastra un PDF o TXT"
            hint="Guía de animación del cliente"
            onFiles={handleAnimationFiles}
          />
          <div className="flex flex-col gap-2">
            <Textarea
              placeholder="O pega aquí una URL o descripción libre de la animación deseada..."
              value={animationText}
              onChange={(e) => setAnimationText(e.target.value)}
            />
            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!animationText.trim() || savingText}
                onClick={handleGuardarTexto}
              >
                {savingText ? "Guardando..." : "Guardar guía de texto"}
              </Button>
              {textSaved && <span className="text-xs text-green-600">Guardada.</span>}
            </div>
          </div>

          <ul className="flex flex-col gap-2">
            {animationAssets.map((asset) => (
              <li
                key={asset.id}
                className={`flex items-center gap-3 rounded-md border border-border p-2 text-sm transition-all duration-200 ${
                  removingIds.has(asset.id) ? "-translate-x-2 opacity-0" : "opacity-100"
                }`}
              >
                <span className="flex h-10 w-10 items-center justify-center rounded bg-muted text-xs">
                  DOC
                </span>
                <span className="flex-1 truncate">{asset.layer_name}</span>
                {deleteErrors[asset.id] ? (
                  <span className="text-xs text-red-600">{deleteErrors[asset.id]}</span>
                ) : (
                  <span className="text-xs text-green-600">subido</span>
                )}
                <button
                  type="button"
                  aria-label="Eliminar archivo"
                  disabled={removingIds.has(asset.id)}
                  onClick={() => handleDelete(asset.id)}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-red-600 disabled:opacity-50"
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            ))}
            {pendingAnimation.map((p) => (
              <PendingFileRow key={p.name} file={p} icon="DOC" />
            ))}
          </ul>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        {puedeAnalizar && (
          <Button onClick={handleAnalizar} disabled={analizando}>
            {analizando ? "Lanzando análisis..." : "Analizar material"}
          </Button>
        )}
        {!puedeAnalizar && (
          <p className="text-sm text-muted-foreground">
            Sube al menos un PSD y el Excel de adaptaciones para poder analizar.
          </p>
        )}
        {analizarError && <span className="text-sm text-red-600">{analizarError}</span>}
      </div>
    </div>
  );
}
