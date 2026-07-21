import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getAuthenticatedUserId } from "@/lib/supabase/auth";
import { getIABFormatById } from "@/lib/iab/specs";
import { requireProjectOwnership } from "@/lib/authorization";

type BriefFormatInput = {
  id?: string;
  nombre_soporte: string;
  iab_format: string;
  url_destino?: string | null;
  versiones: number;
};

type BriefPayload = {
  project: {
    id?: string;
    cliente: string;
    producto?: string | null;
    objetivo?: string | null;
    fecha_inicio?: string | null;
    fecha_fin?: string | null;
    presupuesto?: number | null;
  };
  formats: BriefFormatInput[];
};

function validatePayload(payload: BriefPayload): string | null {
  if (!payload.project?.cliente?.trim()) return "El cliente es obligatorio.";
  if (!Array.isArray(payload.formats)) return "El listado de soportes es inválido.";

  for (const format of payload.formats) {
    if (!format.nombre_soporte?.trim()) return "Cada soporte necesita un nombre.";
    if (!getIABFormatById(format.iab_format)) {
      return `Formato IAB desconocido: ${format.iab_format}`;
    }
    if (!format.versiones || format.versiones < 1) {
      return `El soporte "${format.nombre_soporte}" necesita al menos 1 versión.`;
    }
  }
  return null;
}

export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "projectId es obligatorio" }, { status: 400 });
  }

  const auth = await requireProjectOwnership(projectId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const supabase = createServerSupabaseClient();

  const [{ data: project, error: projectError }, { data: formats, error: formatsError }] =
    await Promise.all([
      supabase.from("adstudio_projects").select("*").eq("id", projectId).single(),
      supabase.from("adstudio_formats").select("*").eq("project_id", projectId),
    ]);

  if (projectError) {
    return NextResponse.json({ error: projectError.message }, { status: 404 });
  }
  if (formatsError) {
    return NextResponse.json({ error: formatsError.message }, { status: 500 });
  }

  return NextResponse.json({ project, formats: formats ?? [] });
}

export async function POST(req: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "No autenticado." }, { status: 401 });
  }

  const payload = (await req.json()) as BriefPayload;

  const validationError = validatePayload(payload);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();

  const { data: project, error: projectError } = await supabase
    .from("adstudio_projects")
    .insert({
      user_id: userId,
      cliente: payload.project.cliente,
      producto: payload.project.producto ?? null,
      objetivo: payload.project.objetivo ?? null,
      fecha_inicio: payload.project.fecha_inicio ?? null,
      fecha_fin: payload.project.fecha_fin ?? null,
      presupuesto: payload.project.presupuesto ?? null,
      status: "draft",
      tier: "starter",
    })
    .select()
    .single();

  if (projectError || !project) {
    return NextResponse.json(
      { error: projectError?.message ?? "No se pudo crear el proyecto" },
      { status: 500 },
    );
  }

  if (payload.formats.length > 0) {
    const { error: formatsError } = await supabase.from("adstudio_formats").insert(
      payload.formats.map((f) => ({
        project_id: project.id,
        nombre_soporte: f.nombre_soporte,
        iab_format: f.iab_format,
        url_destino: f.url_destino ?? null,
        versiones: f.versiones,
        status: "pending",
      })),
    );

    if (formatsError) {
      return NextResponse.json({ error: formatsError.message }, { status: 500 });
    }
  }

  return NextResponse.json({ project }, { status: 201 });
}

export async function PUT(req: NextRequest) {
  const payload = (await req.json()) as BriefPayload;

  if (!payload.project.id) {
    return NextResponse.json({ error: "project.id es obligatorio" }, { status: 400 });
  }

  const auth = await requireProjectOwnership(payload.project.id);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const validationError = validatePayload(payload);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();

  const { data: project, error: projectError } = await supabase
    .from("adstudio_projects")
    .update({
      cliente: payload.project.cliente,
      producto: payload.project.producto ?? null,
      objetivo: payload.project.objetivo ?? null,
      fecha_inicio: payload.project.fecha_inicio ?? null,
      fecha_fin: payload.project.fecha_fin ?? null,
      presupuesto: payload.project.presupuesto ?? null,
    })
    .eq("id", payload.project.id)
    .select()
    .single();

  if (projectError || !project) {
    return NextResponse.json(
      { error: projectError?.message ?? "No se pudo actualizar el proyecto" },
      { status: 500 },
    );
  }

  await supabase.from("adstudio_formats").delete().eq("project_id", payload.project.id);

  if (payload.formats.length > 0) {
    const { error: formatsError } = await supabase.from("adstudio_formats").insert(
      payload.formats.map((f) => ({
        project_id: payload.project.id,
        nombre_soporte: f.nombre_soporte,
        iab_format: f.iab_format,
        url_destino: f.url_destino ?? null,
        versiones: f.versiones,
        status: "pending",
      })),
    );

    if (formatsError) {
      return NextResponse.json({ error: formatsError.message }, { status: 500 });
    }
  }

  return NextResponse.json({ project });
}

export async function DELETE(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "projectId es obligatorio" }, { status: 400 });
  }

  const auth = await requireProjectOwnership(projectId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const supabase = createServerSupabaseClient();

  await supabase.from("adstudio_formats").delete().eq("project_id", projectId);
  const { error } = await supabase.from("adstudio_projects").delete().eq("id", projectId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
