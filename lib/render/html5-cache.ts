import type { SupabaseClient } from "@supabase/supabase-js";

/** Cachea el HTML5 del master (generado una única vez por Claude) en `adstudio_projects.master_html`. */
export async function saveHtml5Master(projectId: string, html: string, supabase: SupabaseClient): Promise<void> {
  await supabase.from("adstudio_projects").update({ master_html: html }).eq("id", projectId);
}

/** Lee el HTML5 del master cacheado — null si el master todavía no se ha generado. */
export async function getHtml5Master(projectId: string, supabase: SupabaseClient): Promise<string | null> {
  const { data } = await supabase
    .from("adstudio_projects")
    .select("master_html")
    .eq("id", projectId)
    .single();

  return data?.master_html ?? null;
}
