import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Sirve el HTML5 de una adaptación concreta (formatId = adstudio_formats.id)
 * para el iframe de preview en components/project/delivery-view.tsx. Público,
 * sin sesión — mismo criterio que app/api/preview/[projectId]/route.ts (el
 * master).
 *
 * Dos orígenes posibles en Storage según cómo se produjo el formato:
 * - Con `source_psd_id` propio (Bloque 11, ver trigger/render-master.ts): su
 *   propio HTML5, subido a `{projectId}/masters/{formatId}/{iab_format}.html`.
 * - Sin `source_psd_id` (adaptado desde el master con FLUX + Claude Vision,
 *   ver trigger/render-adaptations.ts): `{projectId}/adaptations/{iab_format}/index.html`.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; formatId: string }> },
) {
  const { projectId, formatId } = await params;

  const supabase = createServerSupabaseClient();

  const { data: format, error: formatError } = await supabase
    .from("adstudio_formats")
    .select("iab_format, source_psd_id")
    .eq("id", formatId)
    .eq("project_id", projectId)
    .single();

  if (formatError || !format) {
    return new NextResponse("Formato no encontrado.", { status: 404 });
  }

  const htmlPath = format.source_psd_id
    ? `${projectId}/masters/${formatId}/${format.iab_format}.html`
    : `${projectId}/adaptations/${format.iab_format}/index.html`;

  const { data, error } = await supabase.storage.from("adstudio-projects").download(htmlPath);

  if (error || !data) {
    return new NextResponse("Todavía no hay HTML5 generado para este formato.", { status: 404 });
  }

  const rawHtml = await data.text();

  // Mismo reescrito que app/api/preview/[projectId]/route.ts, pero apuntando
  // a los assets propios de esta adaptación (ver assets/[filename]/route.ts).
  const html = rawHtml.replace(
    /src="([^"]+\.(png|jpg|jpeg|gif))"/gi,
    `src="/api/preview/${projectId}/adaptation/${formatId}/assets/$1"`,
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
