import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createSessionSupabaseClient } from "@/lib/supabase/server-session";
import { requireProjectOwnership } from "@/lib/authorization";
import { AdaptationRefineError, refineAdaptationHtml } from "@/lib/adaptation-refine";

export async function POST(req: NextRequest) {
  const { projectId, formatId, changeDescription } = (await req.json()) as {
    projectId?: string;
    formatId?: string;
    changeDescription?: string;
  };

  if (!projectId || !formatId || !changeDescription?.trim()) {
    return NextResponse.json(
      { error: "projectId, formatId y changeDescription son obligatorios" },
      { status: 400 },
    );
  }

  const auth = await requireProjectOwnership(projectId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const supabase = await createSessionSupabaseClient();

  try {
    const result = await refineAdaptationHtml(projectId, formatId, changeDescription.trim(), auth.userId, supabase);
    // refineAdaptationHtml solo devuelve { html } — el registro en
    // adstudio_changes ya se hace ahí, pero el id real no se propaga fuera de
    // esa función; se construye un entry equivalente para el historial del
    // chat (mismo patrón de mejor esfuerzo que lib/master.ts:refineMasterHtml
    // usa cuando el insert en adstudio_changes falla).
    return NextResponse.json({
      success: true,
      html: result.html,
      change: { id: randomUUID(), description: changeDescription.trim(), requestedAt: new Date().toISOString() },
    });
  } catch (err) {
    if (err instanceof AdaptationRefineError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("Error refinando adaptación:", err);
    return NextResponse.json({ error: "Error inesperado al aplicar el cambio." }, { status: 500 });
  }
}
