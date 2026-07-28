import { createSessionSupabaseClient } from "@/lib/supabase/server-session";

export type ApprovalStatus =
  | { state: "none" }
  | {
      state: "pending" | "approved" | "changes_requested";
      token: string;
      expiresAt: string | null;
      approvedAt: string | null;
    };

/**
 * Estado del link de aprobación más reciente del proyecto, para mostrarlo de
 * forma permanente en app/project/[id]/master (components/project/master-view.tsx,
 * vía lib/master.ts:getMasterStatus) y como indicador en el header del proyecto
 * (components/project/project-header.tsx, vía app/project/[id]/layout.tsx).
 * Requiere sesión — la propiedad del proyecto la garantiza RLS.
 *
 * Separado de lib/approval.ts (que importa lib/master.ts para el email de
 * "master listo") para evitar un ciclo de imports: lib/master.ts necesita
 * este estado dentro de getMasterStatus.
 *
 * "changes_requested" se infiere de `adstudio_projects.notes` (comentarios del
 * cliente al pedir cambios, ver lib/approval.ts:requestMasterChanges) estando
 * el token todavía sin aprobar — no hay un estado explícito de "rechazado" en
 * el esquema, así que si se regenera el master sin limpiar `notes` el
 * indicador puede quedar desactualizado hasta la siguiente ronda de aprobación.
 */
export async function getApprovalStatus(projectId: string): Promise<ApprovalStatus> {
  const supabase = await createSessionSupabaseClient();

  const [{ data: tokenRow }, { data: project }] = await Promise.all([
    supabase
      .from("adstudio_approval_tokens")
      .select("token, expires_at, approved_at")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.from("adstudio_projects").select("notes").eq("id", projectId).single(),
  ]);

  if (!tokenRow) return { state: "none" };

  const state = tokenRow.approved_at ? "approved" : project?.notes?.trim() ? "changes_requested" : "pending";

  return {
    state,
    token: tokenRow.token as string,
    expiresAt: tokenRow.expires_at as string | null,
    approvedAt: tokenRow.approved_at as string | null,
  };
}
