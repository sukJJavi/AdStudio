import { NextRequest, NextResponse } from "next/server";
import { requireProjectOwnership } from "@/lib/authorization";
import { createSessionSupabaseClient } from "@/lib/supabase/server-session";
import { analyzeProjectIncidents, toAnalysisFormatStatus } from "@/lib/iab/incident-analyzer";
import type { ProjectFormat } from "@/lib/types";

/**
 * Recalcula adstudio_formats.incidencias con el estado actual de adstudio_assets
 * (clasificaciones corregidas en el editor de capas) antes de dejar avanzar al master.
 * El análisis inicial del PSD deja incidencias potencialmente obsoletas si el usuario
 * reclasifica capas después: este endpoint las sobreescribe con el dato fresco.
 */
export async function POST(req: NextRequest) {
  const { projectId } = (await req.json()) as { projectId?: string };

  if (!projectId) {
    return NextResponse.json({ error: "projectId es obligatorio" }, { status: 400 });
  }

  const auth = await requireProjectOwnership(projectId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const supabase = await createSessionSupabaseClient();
  await analyzeProjectIncidents(projectId, supabase);

  const { data, error } = await supabase
    .from("adstudio_formats")
    .select("*")
    .eq("project_id", projectId);

  if (error || !data) {
    return NextResponse.json({ error: "No se pudieron leer las incidencias recalculadas" }, { status: 500 });
  }

  const formats = (data as ProjectFormat[]).map(toAnalysisFormatStatus);
  const hasCritical = formats.some((f) => f.derivedStatus === "blocked");

  return NextResponse.json({ formats, hasCritical });
}
