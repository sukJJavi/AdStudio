import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createSessionSupabaseClient } from "@/lib/supabase/server-session";
import type { Project } from "@/lib/types";

function fallbackProject(id: string): Project {
  return {
    id,
    user_id: "",
    cliente: "Cliente sin datos",
    producto: null,
    objetivo: null,
    fecha_inicio: null,
    fecha_fin: null,
    presupuesto: null,
    status: "draft",
    tier: "starter",
    notes: null,
    master_run_id: null,
    font_primary: "Inter",
    font_secondary: null,
    master_html: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export async function getProject(id: string): Promise<Project> {
  try {
    const supabase = await createSessionSupabaseClient();
    const { data, error } = await supabase
      .from("adstudio_projects")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !data) return fallbackProject(id);
    return data as Project;
  } catch {
    return fallbackProject(id);
  }
}

export async function updateProjectStatus(id: string, status: Project["status"]) {
  const supabase = createServerSupabaseClient();
  return supabase.from("adstudio_projects").update({ status }).eq("id", id);
}
