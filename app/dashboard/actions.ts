"use server";

import { redirect } from "next/navigation";
import { createSessionSupabaseClient } from "@/lib/supabase/server-session";

export async function createBlankProject() {
  const supabase = await createSessionSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: project, error } = await supabase
    .from("adstudio_projects")
    .insert({
      user_id: user.id,
      cliente: "",
      status: "draft",
      tier: "starter",
    })
    .select("id")
    .single();

  if (error || !project) {
    throw new Error(error?.message ?? "No se pudo crear el proyecto.");
  }

  redirect(`/project/${project.id}/brief`);
}
