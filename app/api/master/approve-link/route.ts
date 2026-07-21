import { NextRequest, NextResponse } from "next/server";
import { createApprovalLink } from "@/lib/approval";
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

  const result = await createApprovalLink(projectId, req.nextUrl.origin);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({ token: result.token, url: result.url });
}
