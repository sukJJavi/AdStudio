import { tasks } from "@trigger.dev/sdk/v3";
import { createSessionSupabaseClient } from "@/lib/supabase/server-session";
import { getIABFormatById } from "@/lib/iab/specs";
import { deriveFormatStatus } from "@/lib/iab/incident-analyzer";
import type { FormatStatus, Project, ProjectFormat } from "@/lib/types";

export type TriggerProductionResult =
  | { ok: true; runId: string }
  | { ok: false; status: 400 | 404 | 429; error: string };

export async function triggerProduction(projectId: string): Promise<TriggerProductionResult> {
  const supabase = await createSessionSupabaseClient();

  const { data: project, error: projectError } = await supabase
    .from("adstudio_projects")
    .select("status")
    .eq("id", projectId)
    .single();

  if (projectError || !project) {
    return { ok: false, status: 404, error: "Proyecto no encontrado." };
  }

  if (project.status === "producing") {
    return { ok: false, status: 429, error: "Job already running" };
  }

  if (project.status !== "approved") {
    return {
      ok: false,
      status: 400,
      error: "El master todavía no ha sido aprobado por el cliente.",
    };
  }

  const handle = await tasks.trigger("render-adaptations", { projectId });

  await supabase.from("adstudio_projects").update({ status: "producing" }).eq("id", projectId);

  return { ok: true, runId: handle.id };
}

export type ProductionFormatStatus = {
  id: string;
  nombreSoporte: string;
  iabFormat: string;
  width: number | null;
  height: number | null;
  status: FormatStatus | "blocked";
};

export type ProductionStatusResponse = {
  projectStatus: Project["status"];
  step: string | null;
  current: number | null;
  total: number | null;
  progress: number | null;
  formats: ProductionFormatStatus[];
};

export async function getProductionStatus(projectId: string): Promise<ProductionStatusResponse | null> {
  const supabase = await createSessionSupabaseClient();

  const { data: project, error: projectError } = await supabase
    .from("adstudio_projects")
    .select("status")
    .eq("id", projectId)
    .single();

  if (projectError || !project) return null;

  const { data: formats } = await supabase.from("adstudio_formats").select("*").eq("project_id", projectId);

  const formatsWithStatus: ProductionFormatStatus[] = ((formats ?? []) as ProjectFormat[]).map((format) => {
    const spec = getIABFormatById(format.iab_format);
    const blocked = deriveFormatStatus(format.incidencias ?? []) === "blocked";
    return {
      id: format.id,
      nombreSoporte: format.nombre_soporte,
      iabFormat: format.iab_format,
      width: spec?.ancho ?? null,
      height: spec?.alto ?? null,
      status: blocked ? "blocked" : format.status,
    };
  });

  const toProduce = formatsWithStatus.filter((f) => f.status !== "blocked");
  const total = toProduce.length;
  const producedCount = toProduce.filter((f) => f.status === "ready").length;
  const currentIndex = toProduce.findIndex((f) => f.status === "producing");
  const current = currentIndex >= 0 ? toProduce[currentIndex] : null;

  const step =
    current && current.width != null && current.height != null
      ? `Produciendo ${current.nombreSoporte} ${current.width}x${current.height} (${currentIndex + 1} de ${total})`
      : null;

  return {
    projectStatus: project.status,
    step,
    current: current ? currentIndex + 1 : producedCount,
    total: total > 0 ? total : null,
    progress: total > 0 ? producedCount / total : null,
    formats: formatsWithStatus,
  };
}
