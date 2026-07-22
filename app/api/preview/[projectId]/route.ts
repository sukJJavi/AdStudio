import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Sirve el HTML5 del master directamente desde `adstudio_projects.master_html`
 * (no una signed URL de Storage: Supabase añade `Content-Disposition: attachment`
 * a las signed URLs, así que el navegador descarga el archivo en vez de
 * renderizarlo dentro del iframe de preview). Público, sin sesión — igual que
 * el link de aprobación (app/approve/[token]), pensado para cargarse en un
 * iframe desde components/project/master-view.tsx y app/approve/[token]/page.tsx.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  const supabase = createServerSupabaseClient();

  const { data: project, error } = await supabase
    .from("adstudio_projects")
    .select("master_html")
    .eq("id", projectId)
    .single();

  if (error || !project) {
    return new NextResponse("Proyecto no encontrado.", { status: 404 });
  }

  if (!project.master_html) {
    return new NextResponse("Todavía no hay HTML5 de master generado.", { status: 404 });
  }

  return new NextResponse(project.master_html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": "inline",
      "X-Frame-Options": "SAMEORIGIN",
    },
  });
}
