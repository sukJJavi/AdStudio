import { tasks } from "@trigger.dev/sdk/v3";

export type TriggerMediaPlanParseResult = { ok: true; runId: string } | { ok: false; error: string };

/**
 * Dispara trigger/parse-media-plan.ts al subir un Excel de plan de medios.
 * A diferencia de triggerAnalysis (lib/analysis.ts), no depende de que también
 * haya un PSD: el parsing del Excel es independiente y solo puebla
 * adstudio_formats para que el usuario los revise en el brief.
 */
export async function triggerMediaPlanParse(projectId: string): Promise<TriggerMediaPlanParseResult> {
  try {
    const handle = await tasks.trigger("parse-media-plan", { projectId });
    return { ok: true, runId: handle.id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Error desconocido al lanzar el parsing del Excel." };
  }
}
