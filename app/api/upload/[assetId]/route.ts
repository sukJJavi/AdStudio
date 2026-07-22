import { NextRequest, NextResponse } from "next/server";
import { createSessionSupabaseClient } from "@/lib/supabase/server-session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requireProjectOwnership } from "@/lib/authorization";

export const runtime = "nodejs";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ assetId: string }> },
) {
  const { assetId } = await params;

  const sessionSupabase = await createSessionSupabaseClient();

  const { data: asset } = await sessionSupabase
    .from("adstudio_assets")
    .select("id, project_id, layer_type, file_path")
    .eq("id", assetId)
    .single();

  if (!asset) {
    return NextResponse.json({ error: "Archivo no encontrado" }, { status: 404 });
  }

  const auth = await requireProjectOwnership(asset.project_id as string);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const supabase = createServerSupabaseClient();

  if (asset.file_path) {
    await supabase.storage.from("adstudio-projects").remove([asset.file_path as string]);
  }

  const { error: deleteError } = await supabase.from("adstudio_assets").delete().eq("id", assetId);

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  if (asset.layer_type === "psd") {
    const { count: remainingPsd } = await supabase
      .from("adstudio_assets")
      .select("id", { count: "exact", head: true })
      .eq("project_id", asset.project_id as string)
      .eq("layer_type", "psd");

    if (!remainingPsd) {
      await supabase
        .from("adstudio_projects")
        .update({ status: "draft" })
        .eq("id", asset.project_id as string);
    }
  }

  return NextResponse.json({ ok: true });
}
