import { tasks, runs } from "@trigger.dev/sdk/v3";
import { createSessionSupabaseClient } from "@/lib/supabase/server-session";
import { getIABFormatById, type IABFormat } from "@/lib/iab/specs";
import { unblockedFormats } from "@/lib/iab/incident-analyzer";
import type { MasterRecord, Project, ProjectFormat } from "@/lib/types";

const SIGNED_URL_TTL_SECONDS = 600;
/** Preview del HTML5 del master en iframe — ver components/project/master-view.tsx. */
const HTML5_SIGNED_URL_TTL_SECONDS = 60 * 60;

/** Ordena los formatos del proyecto por área de canvas descendente, descartando IDs IAB desconocidos. */
export function rankFormatsByArea(
  formats: ProjectFormat[],
): { format: ProjectFormat; spec: IABFormat }[] {
  return formats
    .map((format) => ({ format, spec: getIABFormatById(format.iab_format) }))
    .filter((x): x is { format: ProjectFormat; spec: IABFormat } => x.spec != null)
    .sort((a, b) => b.spec.ancho * b.spec.alto - a.spec.ancho * a.spec.alto);
}

export type TriggerMasterResult =
  | { ok: true; runId: string }
  | { ok: false; status: 400 | 404 | 429; error: string };

export async function triggerMasterGeneration(
  projectId: string,
  options?: { iabFormatId?: string; isPrimary?: boolean },
): Promise<TriggerMasterResult> {
  const supabase = await createSessionSupabaseClient();

  const { data: project, error: projectError } = await supabase
    .from("adstudio_projects")
    .select("status")
    .eq("id", projectId)
    .single();

  if (projectError || !project) {
    return { ok: false, status: 404, error: "Proyecto no encontrado." };
  }

  if (project.status === "master_generating") {
    return { ok: false, status: 429, error: "Job already running" };
  }

  const { data: formats, error: formatsError } = await supabase
    .from("adstudio_formats")
    .select("*")
    .eq("project_id", projectId);

  if (formatsError || !formats || formats.length === 0) {
    return { ok: false, status: 400, error: "El proyecto no tiene formatos definidos en el brief." };
  }

  const unblocked = unblockedFormats(formats as ProjectFormat[]);

  if (unblocked.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "Todos los formatos del plan están bloqueados por incidencias críticas.",
    };
  }

  if (options?.iabFormatId && !unblocked.some((f) => f.iab_format === options.iabFormatId)) {
    return {
      ok: false,
      status: 400,
      error: "El formato indicado no existe o está bloqueado por incidencias críticas.",
    };
  }

  const iabFormatId = options?.iabFormatId ?? rankFormatsByArea(unblocked)[0]?.format.iab_format;

  const handle = await tasks.trigger("render-master", {
    projectId,
    iabFormatId,
    isPrimary: options?.isPrimary ?? true,
  });

  await supabase
    .from("adstudio_projects")
    .update({ status: "master_generating", master_run_id: handle.id })
    .eq("id", projectId);

  return { ok: true, runId: handle.id };
}

export type MasterWithUrls = {
  id: string;
  iabFormat: string;
  width: number;
  height: number;
  jpgSizeBytes: number | null;
  isPrimary: boolean;
  jpgUrl: string | null;
  pngUrl: string | null;
  createdAt: string;
};

export type MasterStatusResponse = {
  projectStatus: Project["status"];
  step: string | null;
  progress: number | null;
  masters: MasterWithUrls[];
  /** Signed URL de `{project_id}/master/index.html` (el HTML5 generado por Claude) para el iframe de preview. */
  html5Url: string | null;
  /** Peso de `{project_id}/master/master.zip`, para mostrar junto al preview. */
  zipSizeBytes: number | null;
};

export async function getMasterStatus(projectId: string): Promise<MasterStatusResponse | null> {
  const supabase = await createSessionSupabaseClient();

  const { data: project, error: projectError } = await supabase
    .from("adstudio_projects")
    .select("status, master_run_id")
    .eq("id", projectId)
    .single();

  if (projectError || !project) return null;

  const { data: masterRows } = await supabase
    .from("adstudio_masters")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });

  const masters: MasterWithUrls[] = await Promise.all(
    ((masterRows ?? []) as MasterRecord[]).map(async (m) => {
      const [jpgSigned, pngSigned] = await Promise.all([
        supabase.storage.from("adstudio-projects").createSignedUrl(m.jpg_path, SIGNED_URL_TTL_SECONDS),
        supabase.storage.from("adstudio-projects").createSignedUrl(m.png_path, SIGNED_URL_TTL_SECONDS),
      ]);
      return {
        id: m.id,
        iabFormat: m.iab_format,
        width: m.width,
        height: m.height,
        jpgSizeBytes: m.jpg_size_bytes,
        isPrimary: m.is_primary,
        jpgUrl: jpgSigned.data?.signedUrl ?? null,
        pngUrl: pngSigned.data?.signedUrl ?? null,
        createdAt: m.created_at,
      };
    }),
  );

  let step: string | null = null;
  let progress: number | null = null;

  if (project.status === "master_generating" && project.master_run_id) {
    try {
      const run = await runs.retrieve(project.master_run_id);
      const metadata = run.metadata as Record<string, unknown> | undefined;
      step = typeof metadata?.step === "string" ? metadata.step : null;
      progress = typeof metadata?.progress === "number" ? metadata.progress : null;
    } catch {
      // El run puede no estar disponible todavía (creado hace un instante) o
      // haber expirado del histórico de Trigger.dev; no bloquea la respuesta.
    }
  }

  const { data: masterFolderList } = await supabase.storage.from("adstudio-projects").list(`${projectId}/master`);

  let html5Url: string | null = null;
  if (masterFolderList?.some((f) => f.name === "index.html")) {
    const { data: signed } = await supabase.storage
      .from("adstudio-projects")
      .createSignedUrl(`${projectId}/master/index.html`, HTML5_SIGNED_URL_TTL_SECONDS);
    html5Url = signed?.signedUrl ?? null;
  }

  const zipSizeBytes = masterFolderList?.find((f) => f.name === "master.zip")?.metadata?.size ?? null;

  return { projectStatus: project.status, step, progress, masters, html5Url, zipSizeBytes };
}
