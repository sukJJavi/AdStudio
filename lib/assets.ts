import { createSessionSupabaseClient } from "@/lib/supabase/server-session";
import type { ProjectAsset } from "@/lib/types";

export async function getProjectAssets(projectId: string): Promise<ProjectAsset[]> {
  try {
    const supabase = await createSessionSupabaseClient();
    const { data, error } = await supabase
      .from("adstudio_assets")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true });

    if (error || !data) return [];
    return data as ProjectAsset[];
  } catch {
    return [];
  }
}
