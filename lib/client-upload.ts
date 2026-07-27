"use client";

import { createBrowserSupabaseClient } from "@/lib/supabase/client";

export function sanitizeFilename(filename: string): string {
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
export function uploadWithProgress(
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

export type UploadAssetResult =
  | { ok: true; analysisTriggered: boolean }
  | { ok: false; error: string };

/**
 * Sube el archivo directamente al bucket de Supabase Storage desde el
 * browser (evita el límite de ~4.5MB de las API routes de Vercel) y luego
 * registra el asset en BBDD vía POST JSON a /api/upload. Compartido entre
 * el upload de PSD/animación (components/project/upload-zones.tsx) y el
 * del Excel del plan de medios (components/project/brief-form.tsx).
 */
export async function uploadAssetToStorage(
  projectId: string,
  type: "psd" | "excel" | "animation",
  file: File,
  onProgress: (percent: number) => void,
): Promise<UploadAssetResult> {
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
