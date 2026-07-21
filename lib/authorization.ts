import { createSessionSupabaseClient } from "@/lib/supabase/server-session";

export type ProjectAuthFailure =
  | { ok: false; status: 401; error: "Unauthorized" }
  | { ok: false; status: 403; error: "Forbidden" };

export type ProjectAuthSuccess = { ok: true; userId: string };

export type ProjectAuthResult = ProjectAuthSuccess | ProjectAuthFailure;

/**
 * Guardia de autorización para cualquier API route que reciba un projectId:
 * exige sesión y que el proyecto pertenezca al usuario autenticado, antes de
 * cualquier operación. 401 si no hay sesión; 403 tanto si el proyecto no
 * existe como si es de otro usuario (mismo código en ambos casos para no
 * filtrar si el id existe). Usar siempre al principio del handler, antes de
 * llamar a la lógica de negocio.
 */
export async function requireProjectOwnership(projectId: string): Promise<ProjectAuthResult> {
  const supabase = await createSessionSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  const { data: project } = await supabase
    .from("adstudio_projects")
    .select("id")
    .eq("id", projectId)
    .eq("user_id", user.id)
    .single();

  if (!project) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  return { ok: true, userId: user.id };
}
