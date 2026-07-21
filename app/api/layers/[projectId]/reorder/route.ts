import { NextRequest, NextResponse } from "next/server";
import { createSessionSupabaseClient } from "@/lib/supabase/server-session";
import { requireProjectOwnership } from "@/lib/authorization";

type ReorderEntry = { id: string; z_index: number };

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const { order } = (await req.json()) as { order?: ReorderEntry[] };

  if (!Array.isArray(order) || order.length === 0) {
    return NextResponse.json({ error: "order es obligatorio" }, { status: 400 });
  }

  const auth = await requireProjectOwnership(projectId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const supabase = await createSessionSupabaseClient();

  const results = await Promise.all(
    order.map(({ id, z_index }) =>
      supabase.from("adstudio_assets").update({ z_index }).eq("id", id).eq("project_id", projectId),
    ),
  );

  const failed = results.find((r) => r.error);
  if (failed) {
    return NextResponse.json({ error: failed.error?.message ?? "No se pudo reordenar." }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
