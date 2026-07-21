import { NextRequest, NextResponse } from "next/server";
import { triggerMasterGeneration } from "@/lib/master";
import { requireProjectOwnership } from "@/lib/authorization";

export async function POST(req: NextRequest) {
  const { projectId, iabFormatId, isPrimary } = (await req.json()) as {
    projectId?: string;
    iabFormatId?: string;
    isPrimary?: boolean;
  };

  if (!projectId) {
    return NextResponse.json({ error: "projectId es obligatorio" }, { status: 400 });
  }

  const auth = await requireProjectOwnership(projectId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const result = await triggerMasterGeneration(projectId, { iabFormatId, isPrimary });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ jobId: result.runId, status: "generating" });
}
