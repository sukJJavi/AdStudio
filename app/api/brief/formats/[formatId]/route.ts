import { NextRequest, NextResponse } from "next/server";
import { createSessionSupabaseClient } from "@/lib/supabase/server-session";
import { requireProjectOwnership } from "@/lib/authorization";

type PatchFormatBody = {
  source_psd_id?: string | null;
};

/**
 * Asocia un PSD subido (adstudio_assets con layer_type='psd') al formato del
 * plan que produce — ver "Material por formato" en components/project/brief-form.tsx.
 * Un formato con source_psd_id se produce directamente desde ese PSD en
 * trigger/render-master.ts y ya no se adapta desde el master con FLUX.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ formatId: string }> },
) {
  const { formatId } = await params;
  const body = (await req.json()) as PatchFormatBody;

  if (!("source_psd_id" in body)) {
    return NextResponse.json({ error: "No hay campos válidos para actualizar" }, { status: 400 });
  }

  const supabase = await createSessionSupabaseClient();

  const { data: format } = await supabase
    .from("adstudio_formats")
    .select("id, project_id")
    .eq("id", formatId)
    .single();

  if (!format) {
    return NextResponse.json({ error: "Formato no encontrado" }, { status: 404 });
  }

  const auth = await requireProjectOwnership(format.project_id as string);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  if (body.source_psd_id) {
    const { data: psdAsset } = await supabase
      .from("adstudio_assets")
      .select("id")
      .eq("id", body.source_psd_id)
      .eq("project_id", format.project_id)
      .eq("layer_type", "psd")
      .single();

    if (!psdAsset) {
      return NextResponse.json({ error: "El PSD indicado no existe en este proyecto." }, { status: 400 });
    }
  }

  const { data: updated, error } = await supabase
    .from("adstudio_formats")
    .update({ source_psd_id: body.source_psd_id ?? null })
    .eq("id", formatId)
    .select()
    .single();

  if (error || !updated) {
    return NextResponse.json({ error: error?.message ?? "No se pudo actualizar el formato." }, { status: 400 });
  }

  return NextResponse.json({ format: updated });
}
