import { tasks } from "@trigger.dev/sdk/v3";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export type TriggerAnalysisResult =
  | { ok: true; runId: string }
  | { ok: false; status: 400 | 404 | 429; error: string };

export async function triggerAnalysis(projectId: string): Promise<TriggerAnalysisResult> {
  const supabase = createServerSupabaseClient();

  const { data: project, error: projectError } = await supabase
    .from("adstudio_projects")
    .select("status")
    .eq("id", projectId)
    .single();

  if (projectError || !project) {
    return { ok: false, status: 404, error: "Proyecto no encontrado." };
  }

  if (project.status === "analyzing") {
    return { ok: false, status: 429, error: "Job already running" };
  }

  // El Excel del plan de medios es opcional (solo aporta el import automático
  // de formatos, ver lib/media-plan.ts) — el análisis del PSD no debe
  // esperarlo ni requerirlo, basta con que el usuario tenga al menos un
  // formato en la tabla del brief (añadido a mano o vía Excel).
  const { count: psdCount } = await supabase
    .from("adstudio_assets")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("layer_type", "psd");

  if (!psdCount) {
    return {
      ok: false,
      status: 400,
      error: "Se necesita al menos un PSD subido para analizar.",
    };
  }

  await supabase
    .from("adstudio_projects")
    .update({ status: "analyzing" })
    .eq("id", projectId);

  const handle = await tasks.trigger("analyze-psd", { projectId });

  return { ok: true, runId: handle.id };
}
