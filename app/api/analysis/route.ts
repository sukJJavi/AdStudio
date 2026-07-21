import { NextRequest, NextResponse } from "next/server";
import { triggerAnalysis } from "@/lib/analysis";
import { requireProjectOwnership } from "@/lib/authorization";

export async function POST(req: NextRequest) {
  const { projectId } = (await req.json()) as { projectId?: string };

  if (!projectId) {
    return NextResponse.json({ error: "projectId es obligatorio" }, { status: 400 });
  }

  const auth = await requireProjectOwnership(projectId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const result = await triggerAnalysis(projectId);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(result);
}
