import { createSessionSupabaseClient } from "@/lib/supabase/server-session";
import type { ProjectFormat } from "@/lib/types";

export async function getProjectFormats(projectId: string): Promise<ProjectFormat[]> {
  try {
    const supabase = await createSessionSupabaseClient();
    const { data, error } = await supabase
      .from("adstudio_formats")
      .select("*")
      .eq("project_id", projectId);

    if (error || !data) return [];
    return data as ProjectFormat[];
  } catch {
    return [];
  }
}
