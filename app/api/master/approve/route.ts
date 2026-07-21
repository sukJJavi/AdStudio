import { NextRequest, NextResponse } from "next/server";
import { approveMaster } from "@/lib/approval";

export async function PUT(req: NextRequest) {
  const { token } = (await req.json()) as { token?: string };

  if (!token) {
    return NextResponse.json({ error: "token es obligatorio" }, { status: 400 });
  }

  const result = await approveMaster(token);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
