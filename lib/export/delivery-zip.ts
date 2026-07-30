import type { SupabaseClient } from "@supabase/supabase-js";
import { getIABFormatById } from "@/lib/iab/specs";
import { downloadAsset } from "@/lib/render/assets";
import {
  buildManifestJson,
  buildZipBuffer,
  campaignSlug,
  pieceFoldersFor,
  type ManifestPieceEntry,
  type ZipFileEntry,
} from "@/lib/export/zip";
import type { ProjectFormat } from "@/lib/types";

/**
 * Reconstruye `{projectId}/delivery/{folderName}_adaptaciones.zip` leyendo el
 * estado ACTUAL de Storage para cada formato — a diferencia del ZIP que arma
 * trigger/render-adaptations.ts (con los buffers en memoria de ese momento de
 * producción, nunca más actualizado), este lee el html/fallback.jpg vigentes,
 * que ya reflejan cualquier cambio aplicado por el chat de refinamiento (ver
 * lib/adaptation-refine.ts:refineAdaptationHtml). Se llama tras cada cambio
 * para que el ZIP descargable/compartido no se quede desincronizado del
 * preview. Best-effort: nunca lanza — un fallo aquí no debe deshacer el
 * cambio de HTML ya guardado.
 */
export async function rebuildDeliveryZip(projectId: string, supabase: SupabaseClient): Promise<void> {
  try {
    const [{ data: project }, { data: formats }] = await Promise.all([
      supabase.from("adstudio_projects").select("cliente, producto").eq("id", projectId).single(),
      supabase.from("adstudio_formats").select("*").eq("project_id", projectId).eq("status", "ready"),
    ]);

    if (!project) return;

    const readyFormats = (formats ?? []) as ProjectFormat[];
    const zipEntries: ZipFileEntry[] = [];
    const manifestPieces: ManifestPieceEntry[] = [];

    for (const format of readyFormats) {
      const spec = getIABFormatById(format.iab_format);
      if (!spec) continue;

      // Bloque 11: formatos con PSD propio suben su html/fallback a
      // masters/{format.id}/ (ver trigger/render-master.ts), el resto a
      // adaptations/{iab_format}/ (ver trigger/render-adaptations.ts) — mismas
      // rutas que ya sirve app/api/preview/[projectId]/adaptation/[formatId].
      const htmlPath = format.source_psd_id
        ? `${projectId}/masters/${format.id}/${format.iab_format}.html`
        : `${projectId}/adaptations/${format.iab_format}/index.html`;
      const fallbackPath = format.source_psd_id
        ? `${projectId}/masters/${format.id}/${format.iab_format}.jpg`
        : `${projectId}/adaptations/${format.iab_format}/fallback.jpg`;
      // Los PNG/JPG sueltos de cada pieza se persisten aquí para el iframe de
      // preview (ver trigger/render-adaptations.ts) — ya son los assets
      // correctos (fondo/imagen_principal reencuadrado con FLUX si aplica).
      const assetsFolder = `${projectId}/adaptations/${format.id}`;

      const [htmlBuffer, fallbackBuffer] = await Promise.all([
        downloadAsset(supabase, htmlPath),
        downloadAsset(supabase, fallbackPath),
      ]);

      if (!htmlBuffer || !fallbackBuffer) continue;

      const html = htmlBuffer.toString("utf-8");

      const { data: assetListing } = await supabase.storage.from("adstudio-projects").list(assetsFolder);
      const assetEntries = (
        await Promise.all(
          (assetListing ?? [])
            .filter((f) => /\.(png|jpe?g)$/i.test(f.name))
            .map(async (f) => {
              const buffer = await downloadAsset(supabase, `${assetsFolder}/${f.name}`);
              return buffer ? { filename: f.name, buffer } : null;
            }),
        )
      ).filter((entry): entry is { filename: string; buffer: Buffer } => entry != null);

      const pieceFolders = pieceFoldersFor(format);
      for (const pieceFolder of pieceFolders) {
        zipEntries.push({ path: `${pieceFolder}/index.html`, content: html });
        for (const asset of assetEntries) {
          zipEntries.push({ path: `${pieceFolder}/${asset.filename}`, content: asset.buffer });
        }
        zipEntries.push({ path: `${pieceFolder}/fallback.jpg`, content: fallbackBuffer });
      }

      manifestPieces.push({
        nombreSoporte: format.nombre_soporte,
        iabFormat: format.iab_format,
        width: spec.ancho,
        height: spec.alto,
        jpgSizeBytes: fallbackBuffer.byteLength,
        htmlSizeBytes: Buffer.byteLength(html, "utf8"),
        incidencias: format.incidencias ?? [],
        soportes: format.soportes ?? [],
      });
    }

    if (manifestPieces.length === 0) return;

    const generatedAt = new Date().toISOString();
    const manifestJson = buildManifestJson({
      cliente: project.cliente,
      producto: project.producto,
      generatedAt,
      pieces: manifestPieces,
    });

    const folderName = campaignSlug(project.cliente, project.producto);
    const scopedEntries: ZipFileEntry[] = [
      { path: `${folderName}/manifest.json`, content: manifestJson },
      ...zipEntries.map((entry) => ({ path: `${folderName}/${entry.path}`, content: entry.content })),
    ];

    const zipBuffer = await buildZipBuffer(scopedEntries);
    const zipPath = `${projectId}/delivery/${folderName}_adaptaciones.zip`;

    await supabase.storage.from("adstudio-projects").upload(zipPath, zipBuffer, {
      contentType: "application/zip",
      upsert: true,
    });
  } catch (err) {
    console.error("No se pudo reconstruir el ZIP de entrega:", err);
  }
}
