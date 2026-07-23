import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { triggerAnalysis } from "@/lib/analysis";
import { requireProjectOwnership } from "@/lib/authorization";

export const runtime = "nodejs";

type AssetKind = "psd" | "excel" | "animation";

const LIMITS: Record<AssetKind, { extensions: string[]; maxBytes: number }> = {
  psd: { extensions: [".psd"], maxBytes: 100 * 1024 * 1024 },
  excel: { extensions: [".xlsx", ".xls"], maxBytes: 10 * 1024 * 1024 },
  animation: { extensions: [".pdf", ".txt"], maxBytes: 20 * 1024 * 1024 },
};

function isAssetKind(value: unknown): value is AssetKind {
  return value === "psd" || value === "excel" || value === "animation";
}

function extensionOf(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx === -1 ? "" : filename.slice(idx).toLowerCase();
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9.\-_]/g, "_");
}

type RegisterResult =
  | { ok: true; asset: unknown; analysisTriggered: boolean; analysisError: string | null }
  | { ok: false; error: string };

/**
 * Inserta el asset en BBDD (el archivo ya está en Storage, subido antes de
 * llamar a esta función) y dispara el análisis si ya hay PSD + Excel.
 * Compartido entre el handler JSON (upload directo desde el browser) y el
 * handler multipart (compatibilidad / guía de animación en texto).
 */
async function registerAssetAndMaybeTriggerAnalysis(
  projectId: string,
  type: AssetKind,
  fileName: string,
  storagePath: string,
): Promise<RegisterResult> {
  const supabase = createServerSupabaseClient();

  const { data: asset, error: insertError } = await supabase
    .from("adstudio_assets")
    .insert({
      project_id: projectId,
      layer_name: fileName,
      layer_type: type,
      classification: null,
      width: null,
      height: null,
      dpi: null,
      file_path: storagePath,
      quality_score: null,
      status: "uploaded",
    })
    .select()
    .single();

  if (insertError || !asset) {
    return { ok: false, error: insertError?.message ?? "No se pudo registrar el archivo." };
  }

  const { data: assets, error: assetsError } = await supabase
    .from("adstudio_assets")
    .select("id, layer_type")
    .eq("project_id", projectId);

  if (assetsError) {
    console.error("Error leyendo assets del proyecto tras el upload:", assetsError);
  }

  const hasPsd = (assets ?? []).some((a) => a.layer_type === "psd");
  const hasExcel = (assets ?? []).some((a) => a.layer_type === "excel");

  // Misma query que el rate limiting de triggerAnalysis (lib/analysis.ts): si dos
  // uploads (PSD y Excel) llegan por separado y el análisis ya está en curso,
  // evita lanzar un segundo job.
  const { data: projectStatusRow } = await supabase
    .from("adstudio_projects")
    .select("status")
    .eq("id", projectId)
    .single();

  const alreadyAnalyzing = projectStatusRow?.status === "analyzing";

  let analysisTriggered = false;
  let analysisError: string | null = null;

  if (hasPsd && hasExcel && !alreadyAnalyzing) {
    try {
      const result = await triggerAnalysis(projectId);
      analysisTriggered = result.ok;
      if (!result.ok) {
        // "Job already running" (429) es esperable si ya hay un análisis en curso —
        // no es un fallo real, solo no hace falta lanzar otro.
        if (result.status !== 429) analysisError = result.error;
      }
    } catch (error) {
      // Un fallo al hablar con Trigger.dev (p. ej. TRIGGER_SECRET_KEY mal configurada)
      // no debe tirar abajo la respuesta del upload, que ya se completó con éxito.
      console.error("triggerAnalysis lanzó una excepción:", error);
      analysisError = error instanceof Error ? error.message : "Error desconocido al lanzar el análisis.";
    }
  }

  return { ok: true, asset, analysisTriggered, analysisError };
}

/**
 * Registra en BBDD un archivo subido directamente a Supabase Storage desde el
 * browser (ver components/project/upload-zones.tsx). No recibe ni procesa
 * ningún archivo, solo metadata: el upload ya ocurrió antes de esta llamada.
 */
async function handleJsonRegister(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const projectId = body?.projectId;
  const filePath = body?.filePath;
  const fileType = body?.fileType;
  const fileName = body?.fileName;
  const fileSize = body?.fileSize;

  if (typeof projectId !== "string" || !projectId) {
    return NextResponse.json({ error: "projectId es obligatorio" }, { status: 400 });
  }
  if (!isAssetKind(fileType)) {
    return NextResponse.json({ error: "fileType debe ser psd, excel o animation" }, { status: 400 });
  }
  if (typeof filePath !== "string" || !filePath) {
    return NextResponse.json({ error: "filePath es obligatorio" }, { status: 400 });
  }
  if (typeof fileName !== "string" || !fileName) {
    return NextResponse.json({ error: "fileName es obligatorio" }, { status: 400 });
  }
  if (typeof fileSize !== "number" || fileSize <= 0) {
    return NextResponse.json({ error: "fileSize es obligatorio" }, { status: 400 });
  }

  const auth = await requireProjectOwnership(projectId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  // filePath lo construye el cliente antes de subir; se valida que apunte a la
  // carpeta del proyecto/tipo indicados para no registrar una ruta ajena.
  if (!filePath.startsWith(`${projectId}/${fileType}/`)) {
    return NextResponse.json(
      { error: "filePath no corresponde al proyecto o tipo indicado." },
      { status: 400 },
    );
  }

  const limits = LIMITS[fileType];
  const ext = extensionOf(fileName);

  if (!limits.extensions.includes(ext)) {
    return NextResponse.json(
      { error: `Extensión no permitida para ${fileType}: ${ext || "desconocida"}` },
      { status: 400 },
    );
  }
  if (fileSize > limits.maxBytes) {
    return NextResponse.json(
      { error: `El archivo supera el tamaño máximo de ${limits.maxBytes / (1024 * 1024)}MB.` },
      { status: 400 },
    );
  }

  const result = await registerAssetAndMaybeTriggerAnalysis(projectId, fileType, fileName, filePath);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json(
    { asset: result.asset, analysisTriggered: result.analysisTriggered, analysisError: result.analysisError },
    { status: 201 },
  );
}

/**
 * Handler multipart legacy: sube el archivo desde el servidor (límite de
 * ~4.5MB en Vercel) y lo registra. Se mantiene por compatibilidad y porque la
 * guía de animación en texto libre (sin archivo real) sigue pasando por aquí.
 */
async function handleMultipartUpload(req: NextRequest) {
  const formData = await req.formData();

  const projectId = formData.get("projectId");
  const typeRaw = formData.get("type");
  const file = formData.get("file");
  const text = formData.get("text");

  if (typeof projectId !== "string" || !projectId) {
    return NextResponse.json({ error: "projectId es obligatorio" }, { status: 400 });
  }
  if (!isAssetKind(typeRaw)) {
    return NextResponse.json({ error: "type debe ser psd, excel o animation" }, { status: 400 });
  }
  const type = typeRaw;

  const auth = await requireProjectOwnership(projectId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const supabase = createServerSupabaseClient();

  let uploadFile: File;

  if (file instanceof File) {
    uploadFile = file;
  } else if (type === "animation" && typeof text === "string" && text.trim()) {
    uploadFile = new File([text], "guia-animacion.txt", { type: "text/plain" });
  } else {
    return NextResponse.json(
      { error: "Se requiere un archivo (o texto para la guía de animación)." },
      { status: 400 },
    );
  }

  const limits = LIMITS[type];
  const ext = extensionOf(uploadFile.name);

  if (!limits.extensions.includes(ext)) {
    return NextResponse.json(
      { error: `Extensión no permitida para ${type}: ${ext || "desconocida"}` },
      { status: 400 },
    );
  }
  if (uploadFile.size > limits.maxBytes) {
    return NextResponse.json(
      { error: `El archivo supera el tamaño máximo de ${limits.maxBytes / (1024 * 1024)}MB.` },
      { status: 400 },
    );
  }

  const storagePath = `${projectId}/${type}/${Date.now()}-${sanitizeFilename(uploadFile.name)}`;

  const { error: uploadError } = await supabase.storage
    .from("adstudio-projects")
    .upload(storagePath, uploadFile, {
      contentType: uploadFile.type || "application/octet-stream",
      upsert: false,
    });

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  const result = await registerAssetAndMaybeTriggerAnalysis(projectId, type, uploadFile.name, storagePath);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json(
    { asset: result.asset, analysisTriggered: result.analysisTriggered, analysisError: result.analysisError },
    { status: 201 },
  );
}

export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return handleJsonRegister(req);
  }

  return handleMultipartUpload(req);
}
