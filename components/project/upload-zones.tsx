"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { uploadAssetToStorage } from "@/lib/client-upload";
import { DropArea, formatBytes } from "@/components/project/drop-area";
import type { ProjectAsset } from "@/lib/types";

type PendingFile = {
  name: string;
  size: number;
  status: "uploading" | "registering" | "analyzing" | "error";
  progress: number;
  error?: string;
};

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

const FONT_EXTENSIONS = [".ttf", ".otf", ".woff", ".woff2"];
const FONT_MAX_BYTES = 5 * 1024 * 1024;

/** Nombre sin extensión y formato detectado, para adstudio_assets.metadata (ver lib/render/font-resolver.ts). */
function fontMetadataFor(file: File): { fontName: string; fileSize: number; format: string } {
  const dot = file.name.lastIndexOf(".");
  const fontName = dot === -1 ? file.name : file.name.slice(0, dot);
  const format = dot === -1 ? "" : file.name.slice(dot + 1).toLowerCase();
  return { fontName, fileSize: file.size, format };
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
  const animationAssets = initialAssets.filter((a) => a.layer_type === "animation");
  const fontAssets = initialAssets.filter((a) => a.layer_type === "font");

  const [pendingPsd, setPendingPsd] = useState<PendingFile[]>([]);
  const [pendingAnimation, setPendingAnimation] = useState<PendingFile[]>([]);
  const [pendingFonts, setPendingFonts] = useState<PendingFile[]>([]);

  const [psdThumbnails, setPsdThumbnails] = useState<Record<string, string>>({});

  const [animationText, setAnimationText] = useState("");
  const [savingText, setSavingText] = useState(false);
  const [textSaved, setTextSaved] = useState(false);

  const [analizando, setAnalizando] = useState(false);
  const [analizarError, setAnalizarError] = useState<string | null>(null);

  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});

  // El Excel del plan de medios es opcional (ver lib/analysis.ts) — solo hace
  // falta al menos un PSD subido para poder lanzar el análisis.
  const puedeAnalizar = psdAssets.length > 0;

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
    for (const file of files) {
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

      const result = await uploadAssetToStorage(projectId, "psd", file, (percent) => {
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

    const result = await uploadAssetToStorage(projectId, "animation", file, (percent) => {
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

  async function handleFontFiles(files: File[]) {
    for (const file of files) {
      const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
      if (!FONT_EXTENSIONS.includes(ext)) {
        setPendingFonts((prev) => [
          ...prev,
          {
            name: file.name,
            size: file.size,
            status: "error",
            progress: 0,
            error: "Solo se aceptan .ttf, .otf, .woff o .woff2",
          },
        ]);
        continue;
      }
      if (file.size > FONT_MAX_BYTES) {
        setPendingFonts((prev) => [
          ...prev,
          { name: file.name, size: file.size, status: "error", progress: 0, error: "Supera el máximo de 5MB" },
        ]);
        continue;
      }

      setPendingFonts((prev) => [...prev, { name: file.name, size: file.size, status: "uploading", progress: 0 }]);

      const result = await uploadAssetToStorage(
        projectId,
        "font",
        file,
        (percent) => {
          setPendingFonts((prev) =>
            prev.map((p) =>
              p.name === file.name
                ? { ...p, progress: percent, status: percent >= 100 ? "registering" : "uploading" }
                : p,
            ),
          );
        },
        fontMetadataFor(file),
      );

      if (result.ok) {
        setPendingFonts((prev) => prev.filter((p) => p.name !== file.name));
        router.refresh();
      } else {
        setPendingFonts((prev) =>
          prev.map((p) => (p.name === file.name ? { ...p, status: "error", error: result.error } : p)),
        );
      }
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
            label="Arrastra tus archivos .psd"
            hint="Máximo 100MB cada uno"
            onFiles={handlePsdFiles}
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
          <CardTitle>Zona B — Guía de animación</CardTitle>
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

      <Card>
        <CardHeader>
          <CardTitle>Zona D — Tipografías del cliente</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Tipografías custom (opcional) — necesarias para adaptar textos correctamente.
          </p>
          <DropArea
            label="Arrastra los archivos de fuente (Regular, Bold, Italic...)"
            hint=".ttf, .otf, .woff o .woff2 · máximo 5MB cada uno"
            onFiles={handleFontFiles}
          />
          <ul className="flex flex-col gap-2">
            {fontAssets.map((asset) => {
              const meta = asset.metadata as { fontName?: string; fileSize?: number; format?: string } | undefined;
              return (
                <li
                  key={asset.id}
                  className={`flex items-center gap-3 rounded-md border border-border p-2 text-sm transition-all duration-200 ${
                    removingIds.has(asset.id) ? "-translate-x-2 opacity-0" : "opacity-100"
                  }`}
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded bg-muted text-xs">
                    {(meta?.format ?? "").toUpperCase() || "FNT"}
                  </span>
                  <span className="flex-1 truncate">{meta?.fontName ?? asset.layer_name}</span>
                  {meta?.fileSize != null && (
                    <span className="text-xs text-muted-foreground">{formatBytes(meta.fileSize)}</span>
                  )}
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
              );
            })}
            {pendingFonts.map((p) => (
              <PendingFileRow key={p.name} file={p} icon="FNT" />
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
          <p className="text-sm text-muted-foreground">Sube al menos un PSD para poder analizar.</p>
        )}
        {analizarError && <span className="text-sm text-red-600">{analizarError}</span>}
      </div>
    </div>
  );
}
