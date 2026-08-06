import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { authorizePreviewRequest, previewUnauthorizedResponse, tokenQuerySuffix } from "@/lib/preview-auth";

export const runtime = "nodejs";

/**
 * Sirve el HTML5 del master directamente desde `adstudio_projects.master_html`
 * (no una signed URL de Storage: Supabase añade `Content-Disposition: attachment`
 * a las signed URLs, así que el navegador descarga el archivo en vez de
 * renderizarlo dentro del iframe de preview). Requiere sesión propietaria O un
 * `?token=` de aprobación vigente — igual que el link de aprobación
 * (app/approve/[token]), pensado para cargarse en un iframe desde
 * components/project/master-view.tsx y app/approve/[token]/page.tsx.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  if (!(await authorizePreviewRequest(req, projectId))) {
    return previewUnauthorizedResponse();
  }

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

  // El HTML de Claude referencia sus assets por filename relativo (src="background.jpg"),
  // que no resuelve dentro de este iframe — reescribe esas rutas para que pasen por
  // app/api/preview/[projectId]/assets/[filename]/route.ts, que sirve el PNG/JPG real
  // desde Storage.
  const assetQuery = tokenQuerySuffix(req);
  const html = project.master_html.replace(
    /src="([^"]+\.(png|jpg|jpeg|gif))"/gi,
    `src="/api/preview/${projectId}/assets/$1${assetQuery}"`,
  );

  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": "inline",
      "X-Frame-Options": "SAMEORIGIN",
    },
  });
}
