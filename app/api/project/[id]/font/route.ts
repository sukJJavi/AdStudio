import { NextRequest, NextResponse } from "next/server";
import { createSessionSupabaseClient } from "@/lib/supabase/server-session";
import { requireProjectOwnership } from "@/lib/authorization";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { font_primary } = (await req.json()) as { font_primary?: string };

  if (!font_primary?.trim()) {
    return NextResponse.json({ error: "font_primary es obligatorio" }, { status: 400 });
  }

  const auth = await requireProjectOwnership(id);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const supabase = await createSessionSupabaseClient();

  const { data: project, error } = await supabase
    .from("adstudio_projects")
    .update({ font_primary: font_primary.trim() })
    .eq("id", id)
    .select("id, font_primary")
    .single();

  if (error || !project) {
    return NextResponse.json({ error: error?.message ?? "No se pudo actualizar el proyecto." }, { status: 400 });
  }

  return NextResponse.json({ project });
}
