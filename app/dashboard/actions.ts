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

  const { data, error } = await supabase
    .from("adstudio_projects")
    .insert({
      user_id: user.id,
      cliente: "",
      status: "draft",
      tier: "starter",
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  if (!data?.id) {
    throw new Error("No se pudo crear el proyecto: el insert no devolvió un id.");
  }

  redirect(`/project/${data.id}/brief`);
}
