import { createSessionSupabaseClient } from "@/lib/supabase/server-session";
import { getIABFormatById } from "@/lib/iab/specs";
import { campaignSlug } from "@/lib/export/zip";
import { getAdaptationChanges } from "@/lib/adaptation-refine";
import type { MasterChangeEntry } from "@/lib/master";
import type { Project, ProjectFormat } from "@/lib/types";

const PIECE_SIGNED_URL_TTL_SECONDS = 600;
/** "Copiar link de preview" del ZIP — signed URL de 7 días. */
const ZIP_SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

export type DeliveryPiece = {
  id: string;
  nombreSoporte: string;
  iabFormat: string;
  width: number | null;
  height: number | null;
  fallbackJpgUrl: string | null;
  jpgSizeBytes: number | null;
  /** Historial de cambios del chat de refinamiento (`/api/production/refine`) — ver components/project/delivery-view.tsx. */
  initialChanges: MasterChangeEntry[];
};

export type DeliveryZipInfo = {
  path: string;
  downloadUrl: string | null;
  sizeBytes: number | null;
};

export type DeliveryInfo = {
  projectId: string;
  projectStatus: Project["status"];
  pieces: DeliveryPiece[];
  zip: DeliveryZipInfo | null;
};

export async function getDeliveryInfo(projectId: string): Promise<DeliveryInfo | null> {
  const supabase = await createSessionSupabaseClient();

  const { data: project, error: projectError } = await supabase
    .from("adstudio_projects")
    .select("status, cliente, producto")
    .eq("id", projectId)
    .single();

  if (projectError || !project) return null;

  const { data: formats } = await supabase
    .from("adstudio_formats")
    .select("*")
    .eq("project_id", projectId)
    .eq("status", "ready");

  const pieces: DeliveryPiece[] = await Promise.all(
    ((formats ?? []) as ProjectFormat[]).map(async (format) => {
      const spec = getIABFormatById(format.iab_format);
      // Bloque 15: todo formato adaptado (match exacto, Nivel 1 o Nivel 2)
      // sube su fallback.jpg al mismo sitio, adaptations/{iab_format}/ (ver
      // trigger/render-adaptations.ts) — ya no hay una carpeta distinta para
      // formatos con PSD propio.
      const folder = `${projectId}/adaptations/${format.iab_format}`;
      const path = `${folder}/fallback.jpg`;

      const [{ data: signed }, { data: listing }] = await Promise.all([
        supabase.storage.from("adstudio-projects").createSignedUrl(path, PIECE_SIGNED_URL_TTL_SECONDS),
        supabase.storage.from("adstudio-projects").list(folder),
      ]);

      const jpgSizeBytes = listing?.find((f) => f.name === "fallback.jpg")?.metadata?.size ?? null;

      // Chat de refinamiento por pieza (Bloque 14) — disponible tanto para
      // Nivel 1 como Nivel 2 (ver trigger/render-adaptations.ts), no solo
      // Nivel 2 como antes.
      const initialChanges = await getAdaptationChanges(projectId, format.id, supabase);

      return {
        id: format.id,
        nombreSoporte: format.nombre_soporte,
        iabFormat: format.iab_format,
        width: spec?.ancho ?? null,
        height: spec?.alto ?? null,
        fallbackJpgUrl: signed?.signedUrl ?? null,
        jpgSizeBytes,
        initialChanges,
      };
    }),
  );

  const folderName = campaignSlug(project.cliente, project.producto);
  const zipFileName = `${folderName}_adaptaciones.zip`;
  const zipPath = `${projectId}/delivery/${zipFileName}`;

  const { data: zipList } = await supabase.storage.from("adstudio-projects").list(`${projectId}/delivery`);
  const zipFile = zipList?.find((f) => f.name === zipFileName);

  let zip: DeliveryZipInfo | null = null;
  if (zipFile) {
    const { data: signed } = await supabase.storage
      .from("adstudio-projects")
      .createSignedUrl(zipPath, ZIP_SIGNED_URL_TTL_SECONDS);

    zip = {
      path: zipPath,
      downloadUrl: signed?.signedUrl ?? null,
      sizeBytes: zipFile.metadata?.size ?? null,
    };
  }

  return { projectId, projectStatus: project.status, pieces, zip };
}
