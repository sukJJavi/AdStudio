import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { authorizePreviewRequest, previewUnauthorizedResponse, tokenQuerySuffix } from "@/lib/preview-auth";

export const runtime = "nodejs";

/**
 * Sirve el HTML5 de una adaptación concreta (formatId = adstudio_formats.id)
 * para el iframe de preview en components/project/delivery-view.tsx. Público,
 * sin sesión — mismo criterio que app/api/preview/[projectId]/route.ts (el
 * master).
 *
 * Bloque 15: todo formato adaptado (match exacto con su master-base, Nivel 1
 * o Nivel 2, ver trigger/render-adaptations.ts) sube su HTML5 al mismo sitio,
 * `{projectId}/adaptations/{iab_format}/index.html` — ya no hay una ruta
 * distinta para formatos con `source_psd_id` propio (esos ahora se procesan
 * igual que el resto, copiando el master de su PSD asignado).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; formatId: string }> },
) {
  const { projectId, formatId } = await params;

  if (!(await authorizePreviewRequest(req, projectId))) {
    return previewUnauthorizedResponse();
  }

  const supabase = createServerSupabaseClient();

  const { data: format, error: formatError } = await supabase
    .from("adstudio_formats")
    .select("iab_format")
    .eq("id", formatId)
    .eq("project_id", projectId)
    .single();

  if (formatError || !format) {
    return new NextResponse("Formato no encontrado.", { status: 404 });
  }

  const htmlPath = `${projectId}/adaptations/${format.iab_format}/index.html`;

  const { data, error } = await supabase.storage.from("adstudio-projects").download(htmlPath);

  if (error || !data) {
    return new NextResponse("Todavía no hay HTML5 generado para este formato.", { status: 404 });
  }

  const rawHtml = await data.text();

  // Mismo reescrito que app/api/preview/[projectId]/route.ts, pero apuntando
  // a los assets propios de esta adaptación (ver assets/[filename]/route.ts).
  const assetQuery = tokenQuerySuffix(req);
  const html = rawHtml.replace(
    /src="([^"]+\.(png|jpg|jpeg|gif))"/gi,
    `src="/api/preview/${projectId}/adaptation/${formatId}/assets/$1${assetQuery}"`,
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
