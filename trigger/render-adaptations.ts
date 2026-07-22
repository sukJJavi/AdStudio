import { task, metadata } from "@trigger.dev/sdk/v3";
import { createTriggerSupabaseClient } from "@/lib/supabase/trigger-client";
import { getIABFormatById, type IABFormat } from "@/lib/iab/specs";
import { unblockedFormats } from "@/lib/iab/incident-analyzer";
import { downloadAsset } from "@/lib/render/assets";
import { adaptHtml5ToFormat } from "@/lib/render/html5-generator";
import { getHtml5Master } from "@/lib/render/html5-cache";
import { renderFallbackFromFrame } from "@/lib/render/fallback-composite";
import { exportBufferFor, exportFilenameFor } from "@/lib/render/export-format";
import {
  buildManifestJson,
  buildZipBuffer,
  campaignSlug,
  sanitizePathSegment,
  type ManifestPieceEntry,
  type ZipFileEntry,
} from "@/lib/export/zip";
import type { ProjectAsset, ProjectFormat, TextLayerMetadata } from "@/lib/types";

type RenderAdaptationsPayload = {
  projectId: string;
};

/** `adstudio_assets.metadata.filename` — nombre de fichero asignado en trigger/analyze-psd.ts. */
function assetFilename(asset: ProjectAsset): string | null {
  const filename = (asset.metadata as TextLayerMetadata | undefined)?.filename;
  return typeof filename === "string" && filename.trim() ? filename : null;
}

export const renderAdaptations = task({
  id: "render-adaptations",
  run: async (payload: RenderAdaptationsPayload) => {
    const supabase = createTriggerSupabaseClient();

    metadata.set("step", "leyendo-datos-del-proyecto");
    metadata.set("progress", 0);

    const [{ data: allFormats }, { data: assets }, { data: project }] = await Promise.all([
      supabase.from("adstudio_formats").select("*").eq("project_id", payload.projectId),
      supabase.from("adstudio_assets").select("*").eq("project_id", payload.projectId),
      supabase.from("adstudio_projects").select("cliente, producto").eq("id", payload.projectId).single(),
    ]);

    if (!project) {
      throw new Error("Proyecto no encontrado.");
    }

    const masterHtml = await getHtml5Master(payload.projectId, supabase);
    if (!masterHtml) {
      throw new Error("No hay HTML5 de master generado. Genera el master antes de producir adaptaciones.");
    }

    const formatsToProduce = unblockedFormats((allFormats ?? []) as ProjectFormat[])
      .map((format) => ({ format, spec: getIABFormatById(format.iab_format) }))
      .filter((x): x is { format: ProjectFormat; spec: IABFormat } => x.spec != null);

    if (formatsToProduce.length === 0) {
      throw new Error("No hay formatos disponibles para producir (todos bloqueados o sin especificación IAB).");
    }

    const allAssets = (assets ?? []) as ProjectAsset[];

    metadata.set("step", "descargando-pngs-del-master");
    metadata.set("progress", 0.05);

    // Los PNGs del master (por ahora, sin escalado por formato — ver adaptHtml5ToFormat)
    // se descargan una única vez y se reutilizan en el ZIP de cada formato. Fix 3:
    // el PNG original en Storage nunca cambia — la conversión a JPG (export_as_jpg)
    // se aplica aquí, al construir el ZIP, igual que en trigger/render-master.ts.
    const masterPngEntries = (
      await Promise.all(
        allAssets
          .filter((a) => !a.discarded)
          .flatMap((a) => {
            const pngFilename = assetFilename(a);
            return pngFilename && a.file_path ? [{ asset: a, pngFilename }] : [];
          })
          .map(async ({ asset, pngFilename }) => {
            const buffer = await downloadAsset(supabase, asset.file_path);
            if (!buffer) return null;
            const exported = await exportBufferFor(buffer, !!asset.export_as_jpg);
            return { filename: exportFilenameFor(pngFilename, !!asset.export_as_jpg), buffer: exported };
          }),
      )
    ).filter((entry): entry is { filename: string; buffer: Buffer } => entry != null);

    const zipEntries: ZipFileEntry[] = [];
    const manifestPieces: ManifestPieceEntry[] = [];
    const total = formatsToProduce.length;
    let producedCount = 0;

    for (let i = 0; i < formatsToProduce.length; i++) {
      const { format, spec } = formatsToProduce[i];
      const stepLabel = `Produciendo ${format.nombre_soporte} ${spec.ancho}x${spec.alto} (${i + 1} de ${total})`;

      metadata.set("step", stepLabel);
      metadata.set("current", i + 1);
      metadata.set("total", total);
      metadata.set("progress", i / total);

      await supabase.from("adstudio_formats").update({ status: "producing" }).eq("id", format.id);

      try {
        const adaptedHtml = adaptHtml5ToFormat(masterHtml, {
          width: spec.ancho,
          height: spec.alto,
          iabFormat: format.iab_format,
        });

        // Fix 2: el fallback.jpg se compone con las capas reales del frame del
        // CTA (+ persistentes), no un render de Satori desde cero.
        const fallbackJpg = await renderFallbackFromFrame(
          payload.projectId,
          { width: spec.ancho, height: spec.alto },
          allAssets,
          supabase,
        );

        const basePath = `${payload.projectId}/adaptations/${format.iab_format}`;

        await Promise.all([
          supabase.storage
            .from("adstudio-projects")
            .upload(`${basePath}/index.html`, adaptedHtml, { contentType: "text/html", upsert: true }),
          supabase.storage
            .from("adstudio-projects")
            .upload(`${basePath}/fallback.jpg`, fallbackJpg, { contentType: "image/jpeg", upsert: true }),
        ]);

        await supabase.from("adstudio_formats").update({ status: "ready" }).eq("id", format.id);

        const pieceFolder = `${sanitizePathSegment(format.nombre_soporte)}_${format.iab_format}`;
        zipEntries.push({ path: `${pieceFolder}/index.html`, content: adaptedHtml });
        for (const png of masterPngEntries) {
          zipEntries.push({ path: `${pieceFolder}/${png.filename}`, content: png.buffer });
        }
        zipEntries.push({ path: `${pieceFolder}/fallback.jpg`, content: fallbackJpg });

        manifestPieces.push({
          nombreSoporte: format.nombre_soporte,
          iabFormat: format.iab_format,
          width: spec.ancho,
          height: spec.alto,
          jpgSizeBytes: fallbackJpg.byteLength,
          htmlSizeBytes: Buffer.byteLength(adaptedHtml, "utf8"),
          incidencias: format.incidencias ?? [],
        });

        producedCount += 1;
      } catch (formatError) {
        // Un formato con error no debe tirar abajo el resto de la producción.
        await supabase.from("adstudio_formats").update({ status: "incident" }).eq("id", format.id);
        console.error(`Error produciendo ${format.iab_format}:`, formatError);
      }
    }

    if (producedCount === 0) {
      throw new Error("Ningún formato se produjo correctamente.");
    }

    metadata.set("step", "generando-zip");
    metadata.set("progress", 0.95);

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
    const zipPath = `${payload.projectId}/delivery/${folderName}_adaptaciones.zip`;

    await supabase.storage
      .from("adstudio-projects")
      .upload(zipPath, zipBuffer, { contentType: "application/zip", upsert: true });

    metadata.set("step", "completado");
    metadata.set("progress", 1);

    await supabase.from("adstudio_projects").update({ status: "delivery_ready" }).eq("id", payload.projectId);

    return { projectId: payload.projectId, produced: producedCount, total };
  },
});
