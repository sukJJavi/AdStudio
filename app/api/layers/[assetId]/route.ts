import { NextRequest, NextResponse } from "next/server";
import { createSessionSupabaseClient } from "@/lib/supabase/server-session";
import { requireProjectOwnership } from "@/lib/authorization";
import { LAYER_PATCHABLE_FIELDS, type LayerPatchableField } from "@/lib/layers";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ assetId: string }> },
) {
  const { assetId } = await params;
  const body = (await req.json()) as Partial<Record<LayerPatchableField, unknown>>;

  const supabase = await createSessionSupabaseClient();

  const { data: asset } = await supabase
    .from("adstudio_assets")
    .select("id, project_id")
    .eq("id", assetId)
    .single();

  if (!asset) {
    return NextResponse.json({ error: "Capa no encontrada" }, { status: 404 });
  }

  const auth = await requireProjectOwnership(asset.project_id as string);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const update: Partial<Record<LayerPatchableField, unknown>> = {};
  for (const field of LAYER_PATCHABLE_FIELDS) {
    if (field in body) update[field] = body[field];
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "No hay campos válidos para actualizar" }, { status: 400 });
  }

  // "Persistente" desde el select de frame implica frame=null (mutuamente excluyentes).
  if (update.persistent === true) update.frame = null;

  const { data: updated, error } = await supabase
    .from("adstudio_assets")
    .update(update)
    .eq("id", assetId)
    .select()
    .single();

  if (error || !updated) {
    return NextResponse.json({ error: error?.message ?? "No se pudo actualizar la capa." }, { status: 400 });
  }

  return NextResponse.json({ layer: updated });
}
