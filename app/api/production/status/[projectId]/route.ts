import { NextRequest, NextResponse } from "next/server";
import { getProductionStatus } from "@/lib/production";
import { requireProjectOwnership } from "@/lib/authorization";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  const auth = await requireProjectOwnership(projectId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const status = await getProductionStatus(projectId);

  if (!status) {
    return NextResponse.json({ error: "Proyecto no encontrado." }, { status: 404 });
  }

  return NextResponse.json(status);
}
