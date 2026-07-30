import { NextRequest, NextResponse } from "next/server";
import { refineMasterHtml } from "@/lib/master";
import { requireProjectOwnership } from "@/lib/authorization";

export async function POST(req: NextRequest) {
  const { projectId, changeDescription, sourcePsdId } = (await req.json()) as {
    projectId?: string;
    changeDescription?: string;
    /** Bloque 15: refina un master concreto (uno por PSD) en vez del primario — ver components/project/master-view.tsx. */
    sourcePsdId?: string | null;
  };

  if (!projectId || !changeDescription?.trim()) {
    return NextResponse.json({ error: "projectId y changeDescription son obligatorios" }, { status: 400 });
  }

  const auth = await requireProjectOwnership(projectId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const result = await refineMasterHtml(projectId, changeDescription.trim(), sourcePsdId ?? null);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ success: true, change: result.change });
}
