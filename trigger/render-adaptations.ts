import { task, metadata } from "@trigger.dev/sdk/v3";
import sharp from "sharp";
import { createTriggerSupabaseClient } from "@/lib/supabase/trigger-client";
import { getIABFormatById, type IABFormat } from "@/lib/iab/specs";
import { unblockedFormats } from "@/lib/iab/incident-analyzer";
import { downloadAsset, pickLargestBy } from "@/lib/render/assets";
import { adaptHtml5WithVision } from "@/lib/render/html5-generator";
import { getHtml5Master } from "@/lib/render/html5-cache";
import { renderHtmlToImage } from "@/lib/render/browserless-renderer";
import { outpaintToFormat } from "@/lib/render/replicate-outpainting";
import { exportBufferFor, exportFilenameFor } from "@/lib/render/export-format";
import {
  buildManifestJson,
  buildZipBuffer,
  campaignSlug,
  pieceFoldersFor,
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

/**
 * Clasificaciones cuyo PNG queda reemplazado por el background outpainted en
 * el ZIP de cada adaptación (mismo criterio que BACKGROUND_CLASSIFICATIONS en
 * lib/render/html5-generator.ts).
 */
const BACKGROUND_CLASSIFICATIONS = new Set(["fondo", "imagen_principal"]);

/**
 * Opción A — adaptaciones profesionales: Browserless (render real del master)
 * + Replicate FLUX (outpainting del background) + Claude Vision
 * (posicionamiento del resto de assets). Reemplaza el reescalado mecánico y
 * la adaptación solo-con-Claude anteriores.
 */
export const renderAdaptations = task({
  id: "render-adaptations",
  // Cada formato cuesta ~20-30s (Replicate + Claude); con 7 formatos el job
  // puede tardar 3-4 minutos, por encima del maxDuration global de
  // trigger.config.ts (300s) — se sube a 10 minutos para este job en concreto.
  maxDuration: 600,
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

    const allFormatsWithSpec = pickLargestBy(
      ((allFormats ?? []) as ProjectFormat[])
        .map((format) => ({ format, spec: getIABFormatById(format.iab_format) }))
        .filter((x): x is { format: ProjectFormat; spec: IABFormat } => x.spec != null),
      (x) => x.spec.ancho * x.spec.alto,
    );

    // El formato master no se "adapta" a sí mismo — se excluye del loop de
    // abajo y su render (Browserless) sirve de referencia visual para Claude
    // y de imagen base para el outpainting de FLUX. Mismo criterio que
    // lib/master.ts / trigger/render-master.ts: el marcado is_master, o el de
    // mayor área si ninguno lo está (planes creados antes de ese campo).
    const masterEntry = allFormatsWithSpec.find((x) => x.format.is_master) ?? allFormatsWithSpec[0];

    if (!masterEntry) {
      throw new Error("El proyecto no tiene formatos con especificación IAB válida.");
    }

    const formatsToProduce = unblockedFormats((allFormats ?? []) as ProjectFormat[])
      .filter((format) => format.id !== masterEntry.format.id)
      .map((format) => ({ format, spec: getIABFormatById(format.iab_format) }))
      .filter((x): x is { format: ProjectFormat; spec: IABFormat } => x.spec != null);

    if (formatsToProduce.length === 0) {
      throw new Error("No hay formatos disponibles para producir (todos bloqueados, sin especificación IAB, o es el master).");
    }

    const allAssets = (assets ?? []) as ProjectAsset[];

    metadata.set("step", "descargando-assets-del-master");
    metadata.set("progress", 0.05);

    // Los assets (PNG/JPG) son los mismos del master en todos los formatos: se
    // descargan una única vez. Los clasificados fondo/imagen_principal se
    // sustituyen por el background outpainted en el ZIP de cada adaptación
    // (backgroundFilenames más abajo); el resto (texto/logo/CTA/decorativo) se
    // reutiliza tal cual. El PNG original en Storage nunca cambia; la
    // conversión a JPG (export_as_jpg) se aplica aquí, igual que en
    // trigger/render-master.ts.
    const pngEntries = (
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

    // Claude Vision recibe estos mismos buffers como imágenes (assetBuffers,
    // ver adaptHtml5WithVision) — no se vuelven a descargar por formato.
    const assetBuffers = new Map(pngEntries.map((entry) => [entry.filename, entry.buffer]));

    const backgroundFilenames = new Set(
      allAssets
        .filter((a) => !a.discarded && BACKGROUND_CLASSIFICATIONS.has(a.classification ?? ""))
        .flatMap((a) => {
          const filename = assetFilename(a);
          return filename ? [exportFilenameFor(filename, !!a.export_as_jpg)] : [];
        }),
    );
    const nonBackgroundPngEntries = pngEntries.filter((entry) => !backgroundFilenames.has(entry.filename));

    metadata.set("step", "renderizando-master-con-browserless");
    metadata.set("progress", 0.1);

    // El master no cambia entre formatos: se renderiza UNA VEZ con
    // Browserless (no dentro del loop) y se reutiliza como referencia visual
    // para Claude y como imagen base para el outpainting de cada formato.
    console.log("Renderizando master con Browserless...");
    const masterRendered = await renderHtmlToImage(masterHtml, masterEntry.spec.ancho, masterEntry.spec.alto);

    const zipEntries: ZipFileEntry[] = [];
    const manifestPieces: ManifestPieceEntry[] = [];
    const total = formatsToProduce.length;
    let producedCount = 0;

    for (let i = 0; i < formatsToProduce.length; i++) {
      const { format, spec } = formatsToProduce[i];
      const n = i + 1;
      const stepLabel = `Adaptando ${format.nombre_soporte} ${spec.ancho}x${spec.alto} (${n} de ${total})`;

      metadata.set("step", stepLabel);
      metadata.set("current", n);
      metadata.set("total", total);
      metadata.set("progress", i / total);

      await supabase.from("adstudio_formats").update({ status: "producing" }).eq("id", format.id);

      try {
        console.log(`Formato ${n}/${total}: outpainting con FLUX...`);
        const outpainted = await outpaintToFormat(
          masterRendered,
          masterEntry.spec.ancho,
          masterEntry.spec.alto,
          spec.ancho,
          spec.alto,
        );

        // background.jpg / fallback.jpg: el outpainted ya es una imagen
        // correcta del formato (no hace falta componer capas con sharp).
        const backgroundJpg = await sharp(outpainted).jpeg({ quality: 85 }).toBuffer();

        console.log(`Formato ${n}/${total}: generando HTML5...`);
        const adaptedHtml = await adaptHtml5WithVision(
          masterHtml,
          masterRendered,
          { width: masterEntry.spec.ancho, height: masterEntry.spec.alto },
          outpainted,
          allAssets,
          assetBuffers,
          { width: spec.ancho, height: spec.alto, iabFormat: format.iab_format },
        );

        const basePath = `${payload.projectId}/adaptations/${format.iab_format}`;

        await Promise.all([
          supabase.storage
            .from("adstudio-projects")
            .upload(`${basePath}/index.html`, adaptedHtml, { contentType: "text/html", upsert: true }),
          supabase.storage
            .from("adstudio-projects")
            .upload(`${basePath}/background.jpg`, backgroundJpg, { contentType: "image/jpeg", upsert: true }),
          supabase.storage
            .from("adstudio-projects")
            .upload(`${basePath}/fallback.jpg`, backgroundJpg, { contentType: "image/jpeg", upsert: true }),
        ]);

        // "ready" (no "producido"): es el valor de FormatStatus que ya
        // consume el resto de la UI (p. ej. production-view.tsx cuenta
        // producedCount por status === "ready") — introducir un literal
        // nuevo rompería esas vistas sin aportar nada.
        await supabase.from("adstudio_formats").update({ status: "ready" }).eq("id", format.id);

        // La pieza se genera UNA SOLA VEZ arriba; aquí solo se copian esos
        // mismos buffers a la carpeta de cada medio que necesita este tamaño
        // (adstudio_formats.soportes — dedupe por tamaño, no por soporte+tamaño).
        const pieceFolders = pieceFoldersFor(format);
        for (const pieceFolder of pieceFolders) {
          zipEntries.push({ path: `${pieceFolder}/index.html`, content: adaptedHtml });
          zipEntries.push({ path: `${pieceFolder}/background.jpg`, content: backgroundJpg });
          for (const png of nonBackgroundPngEntries) {
            zipEntries.push({ path: `${pieceFolder}/${png.filename}`, content: png.buffer });
          }
          zipEntries.push({ path: `${pieceFolder}/fallback.jpg`, content: backgroundJpg });
        }

        manifestPieces.push({
          nombreSoporte: format.nombre_soporte,
          iabFormat: format.iab_format,
          width: spec.ancho,
          height: spec.alto,
          jpgSizeBytes: backgroundJpg.byteLength,
          htmlSizeBytes: Buffer.byteLength(adaptedHtml, "utf8"),
          incidencias: format.incidencias ?? [],
          soportes: format.soportes ?? [],
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
