import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { authorizePreviewRequest, previewUnauthorizedResponse } from "@/lib/preview-auth";
import { isUnsafeFilename } from "@/lib/preview-filename";

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
 * Sirve los PNG/JPG de una adaptación concreta (Storage:
 * `{projectId}/adaptations/{formatId}/{filename}`, subidos en
 * trigger/render-adaptations.ts junto al fondo/imagen_principal ya
 * reencuadrados con FLUX para ese formato) para el HTML5 servido por
 * app/api/preview/[projectId]/adaptation/[formatId]/route.ts. Público, sin
 * sesión — mismo criterio que app/api/preview/[projectId]/assets/[filename]/route.ts.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; formatId: string; filename: string }> },
) {
  const { projectId, formatId, filename } = await params;

  if (isUnsafeFilename(filename)) {
    return new NextResponse("Nombre de archivo inválido.", { status: 400 });
  }

  if (!(await authorizePreviewRequest(req, projectId))) {
    return previewUnauthorizedResponse();
  }

  const supabase = createServerSupabaseClient();
  const isJpg = filename.toLowerCase().endsWith(".jpg");
  const storagePath = `${projectId}/adaptations/${formatId}/${filename}`;

  const { data } = await supabase.storage.from("adstudio-projects").download(storagePath);

  if (data) {
    return new NextResponse(await data.arrayBuffer(), {
      status: 200,
      headers: {
        "Content-Type": contentTypeFor(filename),
        "Content-Disposition": "inline",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  // Fix: el ZIP puede referenciar `imagen_principal.jpg` (export_as_jpg) cuando en Storage
  // solo se subió el PNG de esa adaptación — convertimos al vuelo en vez de 404.
  if (isJpg) {
    const pngPath = storagePath.replace(/\.jpg$/i, ".png");
    const { data: pngData } = await supabase.storage.from("adstudio-projects").download(pngPath);

    if (pngData) {
      const pngBuffer = Buffer.from(await pngData.arrayBuffer());
      const jpgBuffer = await sharp(pngBuffer).jpeg({ quality: 85 }).toBuffer();

      return new NextResponse(jpgBuffer, {
        status: 200,
        headers: {
          "Content-Type": "image/jpeg",
          "Content-Disposition": "inline",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }
  }

  // Piezas producidas antes de que esta ruta persistiera assets por formato
  // (o capas que no cambian entre formatos): caen al asset original del
  // master — no será la versión reencuadrada con FLUX, pero evita un 404.
  // El storagePath real está namespaced por source_psd_id (ver
  // trigger/analyze-psd.ts), así que se resuelve por metadata.filename en vez
  // de reconstruir la ruta a mano.
  const { data: originalAsset } = await supabase
    .from("adstudio_assets")
    .select("file_path")
    .eq("project_id", projectId)
    .eq("metadata->>filename", filename)
    .not("file_path", "is", null)
    .limit(1)
    .maybeSingle();

  const fallbackPath = originalAsset?.file_path ?? `${projectId}/layers/${filename}`;
  const { data: fallbackData } = await supabase.storage.from("adstudio-projects").download(fallbackPath);

  if (fallbackData) {
    return new NextResponse(await fallbackData.arrayBuffer(), {
      status: 200,
      headers: {
        "Content-Type": contentTypeFor(filename),
        "Content-Disposition": "inline",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  return new NextResponse("Asset no encontrado.", { status: 404 });
}
