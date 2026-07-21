import { NextRequest, NextResponse } from "next/server";
import { createSessionSupabaseClient } from "@/lib/supabase/server-session";
import { summarizeFormatStatuses, toAnalysisFormatStatus } from "@/lib/iab/incident-analyzer";
import type { AnalysisStatusResponse } from "@/lib/iab/incident-analyzer";
import type { ProjectFormat } from "@/lib/types";
import { requireProjectOwnership } from "@/lib/authorization";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  const auth = await requireProjectOwnership(projectId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const supabase = await createSessionSupabaseClient();

  const [{ data: project, error: projectError }, { data: formats, error: formatsError }] = await Promise.all([
    supabase.from("adstudio_projects").select("status").eq("id", projectId).single(),
    supabase.from("adstudio_formats").select("*").eq("project_id", projectId),
  ]);

  if (projectError || !project) {
    return NextResponse.json({ error: "Proyecto no encontrado." }, { status: 404 });
  }
  if (formatsError || !formats) {
    return NextResponse.json({ error: "No se pudieron leer los formatos." }, { status: 500 });
  }

  const formatStatuses = (formats as ProjectFormat[]).map(toAnalysisFormatStatus);

  const response: AnalysisStatusResponse = {
    projectStatus: project.status,
    formats: formatStatuses,
    summary: summarizeFormatStatuses(formatStatuses),
  };

  return NextResponse.json(response);
}
