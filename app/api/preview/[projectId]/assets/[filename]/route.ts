import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
};

function contentTypeFor(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Sirve los PNG/JPG de las capas del proyecto (Storage: `{projectId}/layers/{filename}`)
 * para que el HTML5 servido por app/api/preview/[projectId]/route.ts pueda cargar sus
 * `src="..."` relativos reescritos a esta ruta. Público, sin sesión — mismo criterio
 * que el resto del preview (ver ese route.ts).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; filename: string }> },
) {
  const { projectId, filename } = await params;

  const supabase = createServerSupabaseClient();

  const { data, error } = await supabase.storage
    .from("adstudio-projects")
    .download(`${projectId}/layers/${filename}`);

  if (error || !data) {
    return new NextResponse("Asset no encontrado.", { status: 404 });
  }

  return new NextResponse(await data.arrayBuffer(), {
    status: 200,
    headers: {
      "Content-Type": contentTypeFor(filename),
      "Content-Disposition": "inline",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
