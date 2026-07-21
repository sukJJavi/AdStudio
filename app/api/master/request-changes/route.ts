import { NextRequest, NextResponse } from "next/server";
import { requestMasterChanges } from "@/lib/approval";

export async function POST(req: NextRequest) {
  const { token, comments } = (await req.json()) as { token?: string; comments?: string };

  if (!token) {
    return NextResponse.json({ error: "token es obligatorio" }, { status: 400 });
  }
  if (!comments?.trim()) {
    return NextResponse.json({ error: "Escribe un comentario antes de enviar." }, { status: 400 });
  }

  const result = await requestMasterChanges(token, comments.trim());

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
