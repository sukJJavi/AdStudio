import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { triggerAnalysis } from "@/lib/analysis";
import { requireProjectOwnership } from "@/lib/authorization";

export const runtime = "nodejs";

const LIMITS: Record<AssetKind, { extensions: string[]; maxBytes: number }> = {
  psd: { extensions: [".psd"], maxBytes: 100 * 1024 * 1024 },
  excel: { extensions: [".xlsx", ".xls"], maxBytes: 10 * 1024 * 1024 },
  animation: { extensions: [".pdf", ".txt"], maxBytes: 20 * 1024 * 1024 },
};

type AssetKind = "psd" | "excel" | "animation";

function isAssetKind(value: string | null): value is AssetKind {
  return value === "psd" || value === "excel" || value === "animation";
}

function extensionOf(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx === -1 ? "" : filename.slice(idx).toLowerCase();
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9.\-_]/g, "_");
}

export async function POST(req: NextRequest) {
  const formData = await req.formData();

  const projectId = formData.get("projectId");
  const typeRaw = formData.get("type");
  const file = formData.get("file");
  const text = formData.get("text");

  if (typeof projectId !== "string" || !projectId) {
    return NextResponse.json({ error: "projectId es obligatorio" }, { status: 400 });
  }
  const type = typeof typeRaw === "string" ? typeRaw : null;
  if (!isAssetKind(type)) {
    return NextResponse.json({ error: "type debe ser psd, excel o animation" }, { status: 400 });
  }

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

  const { data: asset, error: insertError } = await supabase
    .from("adstudio_assets")
    .insert({
      project_id: projectId,
      layer_name: uploadFile.name,
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
    return NextResponse.json(
      { error: insertError?.message ?? "No se pudo registrar el archivo." },
      { status: 500 },
    );
  }

  const { data: assets, error: assetsError } = await supabase
    .from("adstudio_assets")
    .select("id, layer_type")
    .eq("project_id", projectId);

  console.log("Assets en proyecto:", assets);
  if (assetsError) {
    console.error("Error leyendo assets del proyecto tras el upload:", assetsError);
  }

  const hasPsd = (assets ?? []).some((a) => a.layer_type === "psd");
  const hasExcel = (assets ?? []).some((a) => a.layer_type === "excel");

  console.log("¿Hay PSD?", hasPsd);
  console.log("¿Hay Excel?", hasExcel);

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
    console.log("Disparando análisis...");
    try {
      const result = await triggerAnalysis(projectId);
      analysisTriggered = result.ok;
      if (!result.ok) {
        // "Job already running" (429) es esperable si ya hay un análisis en curso —
        // no es un fallo real, solo no hace falta lanzar otro.
        console.log("triggerAnalysis no lanzó un job nuevo:", result.status, result.error);
        if (result.status !== 429) analysisError = result.error;
      }
    } catch (error) {
      // Un fallo al hablar con Trigger.dev (p. ej. TRIGGER_SECRET_KEY mal configurada)
      // no debe tirar abajo la respuesta del upload, que ya se completó con éxito.
      console.error("triggerAnalysis lanzó una excepción:", error);
      analysisError = error instanceof Error ? error.message : "Error desconocido al lanzar el análisis.";
    }
  }

  return NextResponse.json({ asset, analysisTriggered, analysisError }, { status: 201 });
}
