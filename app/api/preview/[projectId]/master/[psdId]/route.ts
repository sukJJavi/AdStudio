import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Sirve el HTML5 de un master concreto (Bloque 15 — cada PSD subido genera
 * su propio master independiente, ver trigger/render-master.ts), identificado
 * por `psdId` (adstudio_assets.id con layer_type='psd'). "Hermana" de
 * app/api/preview/[projectId]/route.ts (el master primario, servido desde
 * `adstudio_projects.master_html`) pero lee `adstudio_masters.html` por
 * `source_psd_id` — necesario para poder previsualizar/editar por chat
 * cualquier master del proyecto, no solo el primario. Público, sin sesión,
 * mismo criterio que el resto de rutas de preview.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; psdId: string }> },
) {
  const { projectId, psdId } = await params;

  const supabase = createServerSupabaseClient();

  const { data: master, error } = await supabase
    .from("adstudio_masters")
    .select("html")
    .eq("project_id", projectId)
    .eq("source_psd_id", psdId)
    .maybeSingle();

  if (error || !master?.html) {
    return new NextResponse("Todavía no hay HTML5 de master generado para este PSD.", { status: 404 });
  }

  // Reutiliza la ruta genérica de assets del proyecto (ya sirve por filename,
  // sin distinguir de qué PSD proviene — los nombres son únicos a nivel
  // proyecto, ver trigger/analyze-psd.ts:uniqueFilename).
  const html = master.html.replace(
    /src="([^"]+\.(png|jpg|jpeg|gif))"/gi,
    `src="/api/preview/${projectId}/assets/$1"`,
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
