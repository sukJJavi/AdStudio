import { NextRequest, NextResponse } from "next/server";
import { requireProjectOwnership } from "@/lib/authorization";
import { getProjectLayers } from "@/lib/layers";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  const auth = await requireProjectOwnership(projectId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const layers = await getProjectLayers(projectId);

  return NextResponse.json({ layers });
}
