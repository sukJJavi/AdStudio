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
 * Sirve los PNG/JPG de las capas del proyecto (Storage: `{projectId}/layers/{filename}`)
 * para que el HTML5 servido por app/api/preview/[projectId]/route.ts pueda cargar sus
 * `src="..."` relativos reescritos a esta ruta. Requiere sesión propietaria O un
 * `?token=` de aprobación vigente — mismo criterio que el resto del preview (ver ese
 * route.ts).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; filename: string }> },
) {
  const { projectId, filename } = await params;

  if (isUnsafeFilename(filename)) {
    return new NextResponse("Nombre de archivo inválido.", { status: 400 });
  }

  if (!(await authorizePreviewRequest(req, projectId))) {
    return previewUnauthorizedResponse();
  }

  const supabase = createServerSupabaseClient();
  const isJpg = filename.endsWith(".jpg");

  // El storagePath real está namespaced por source_psd_id (ver
  // trigger/analyze-psd.ts), así que se resuelve por metadata.filename en vez
  // de reconstruir la ruta a mano. Si no hay asset registrado (archivo subido
  // antes de este cambio), cae a la ruta plana histórica.
  const { data: originalAsset } = await supabase
    .from("adstudio_assets")
    .select("file_path")
    .eq("project_id", projectId)
    .eq("metadata->>filename", filename)
    .not("file_path", "is", null)
    .limit(1)
    .maybeSingle();

  const storagePath = originalAsset?.file_path ?? `${projectId}/layers/${filename}`;

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
  // solo se subió el PNG original de la capa — convertimos al vuelo en vez de 404.
  if (isJpg) {
    const pngPath = storagePath.replace(/\.jpg$/, ".png");
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

  return new NextResponse("Asset no encontrado.", { status: 404 });
}
