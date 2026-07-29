import { task, metadata } from "@trigger.dev/sdk/v3";
import sharp from "sharp";
import { createTriggerSupabaseClient } from "@/lib/supabase/trigger-client";
import { getIABFormatById, type IABFormat } from "@/lib/iab/specs";
import { unblockedFormats } from "@/lib/iab/incident-analyzer";
import { downloadAsset, pickLargestBy } from "@/lib/render/assets";
import { adaptHtml5WithVision, refineHtml5WithVisualFeedback } from "@/lib/render/html5-generator";
import { getHtml5Master } from "@/lib/render/html5-cache";
import { renderHtmlToImage } from "@/lib/render/browserless-renderer";
import { adaptImageAsset } from "@/lib/render/replicate-outpainting";
import { renderFallbackFromFrame } from "@/lib/render/fallback-composite";
import { exportBufferFor, exportFilenameFor } from "@/lib/render/export-format";
import { resolveProjectFont } from "@/lib/render/font-resolver";
import { renderTextAsPng } from "@/lib/render/text-png-renderer";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `adstudio_assets.metadata.filename` — nombre de fichero asignado en trigger/analyze-psd.ts. */
function assetFilename(asset: ProjectAsset): string | null {
  const filename = (asset.metadata as TextLayerMetadata | undefined)?.filename;
  return typeof filename === "string" && filename.trim() ? filename : null;
}

function contentTypeForFilename(filename: string): string {
  return filename.toLowerCase().endsWith(".jpg") || filename.toLowerCase().endsWith(".jpeg")
    ? "image/jpeg"
    : "image/png";
}

/**
 * Opción A — adaptaciones profesionales: Browserless (render real del master)
 * + Replicate FLUX Kontext (reencuadre por asset de fondo/imagen_principal) +
 * Claude Vision (posicionamiento de todos los assets, ya reencuadrados o no).
 * Reemplaza el reescalado mecánico y la adaptación solo-con-Claude anteriores.
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
      supabase
        .from("adstudio_projects")
        .select("cliente, producto, psd_width, psd_height")
        .eq("id", payload.projectId)
        .single(),
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

    // Bloque 11: los formatos con PSD propio ya se produjeron directamente en
    // trigger/render-master.ts (su propio HTML5 a partir de su PSD) — no se
    // adaptan desde el master con FLUX, solo se copian al ZIP de entrega
    // (ver formatsWithOwnPsd más abajo).
    const formatsToProduce = unblockedFormats((allFormats ?? []) as ProjectFormat[])
      .filter((format) => format.id !== masterEntry.format.id && !format.source_psd_id)
      .map((format) => ({ format, spec: getIABFormatById(format.iab_format) }))
      .filter((x): x is { format: ProjectFormat; spec: IABFormat } => x.spec != null);

    const formatsWithOwnPsd = unblockedFormats((allFormats ?? []) as ProjectFormat[])
      .filter((format) => format.id !== masterEntry.format.id && !!format.source_psd_id)
      .map((format) => ({ format, spec: getIABFormatById(format.iab_format) }))
      .filter((x): x is { format: ProjectFormat; spec: IABFormat } => x.spec != null);

    if (formatsToProduce.length === 0 && formatsWithOwnPsd.length === 0) {
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

    // Assets que se reencuadran por formato con FLUX Kontext antes de pasarlos
    // a Claude Vision (ver loop más abajo) — el resto se reutiliza tal cual.
    // Reencuadre con FLUX Kontext solo para la capa que el usuario marcó
    // explícitamente como JPG (toggle en el editor de capas) — decisión
    // explícita del usuario en vez de inferir "es fondo" por classification,
    // y el umbral de área descarta capas JPG pequeñas (p. ej. un logo) que no
    // tiene sentido reencuadrar.
    const cropTargets = allAssets.filter(
      (a) =>
        !a.discarded &&
        a.export_as_jpg === true &&
        a.layer_bounds &&
        a.layer_bounds.width * a.layer_bounds.height >= 10000,
    );

    const zipEntries: ZipFileEntry[] = [];
    const manifestPieces: ManifestPieceEntry[] = [];
    const total = formatsToProduce.length;
    let producedCount = 0;

    // El master no cambia entre formatos: se renderiza UNA VEZ con
    // Browserless (no dentro del loop) y se reutiliza como referencia visual
    // para Claude y como imagen base para el outpainting de cada formato.
    // Solo hace falta si hay algún formato que SÍ se adapta con FLUX/Claude
    // (formatsToProduce) — un proyecto donde todos los formatos tienen PSD
    // propio no necesita este render.
    let masterRendered: Buffer | null = null;
    if (formatsToProduce.length > 0) {
      metadata.set("step", "renderizando-master-con-browserless");
      metadata.set("progress", 0.1);
      console.log("Renderizando master con Browserless...");
      masterRendered = await renderHtmlToImage(payload.projectId, masterEntry.spec.ancho, masterEntry.spec.alto);
    }

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
        console.log(`Formato ${n}/${total}: reencuadrando assets con FLUX Kontext...`);

        // Clon por formato: los buffers adaptados no deben filtrarse al resto
        // de formatos ni al Map global (assetBuffers).
        const formatAssetBuffers = new Map(assetBuffers);
        // asset.id -> PNG ya adaptado, para renderFallbackFromFrame (evita
        // descargar de Storage el original para estas capas).
        const fallbackOverrides = new Map<string, Buffer>();

        for (let cropIndex = 0; cropIndex < cropTargets.length; cropIndex++) {
          const asset = cropTargets[cropIndex];

          // Espaciar llamadas a Replicate cuando hay más de un cropTarget en
          // este formato — evita el rate limiting de la API de Replicate.
          if (cropIndex > 0) {
            await sleep(10_000);
          }

          const pngFilename = assetFilename(asset);
          if (!pngFilename || !asset.file_path) continue;

          // Siempre desde el PNG original en Storage (nunca del buffer ya
          // convertido a JPG en assetBuffers) — adaptImageAsset asume PNG.
          const originalBuffer = await downloadAsset(supabase, asset.file_path);
          if (!originalBuffer) continue;

          const { width: srcWidth, height: srcHeight } = await sharp(originalBuffer).metadata();
          if (!srcWidth || !srcHeight) continue;

          const adaptedPng = await adaptImageAsset(originalBuffer, srcWidth, srcHeight, spec.ancho, spec.alto);
          const adaptedExported = await exportBufferFor(adaptedPng, !!asset.export_as_jpg);

          formatAssetBuffers.set(exportFilenameFor(pngFilename, !!asset.export_as_jpg), adaptedExported);
          fallbackOverrides.set(asset.id, adaptedPng);
        }

        // Tipografías custom del cliente (adstudio_assets.layer_type='font',
        // ver components/project/upload-zones.tsx): si hay una fuente propia
        // resuelta para esta capa de texto, se re-renderiza su PNG escalado
        // al formato destino en vez de reutilizar el PNG del master tal cual.
        // Solo sustituye formatAssetBuffers (lo que ve Claude Vision y lo que
        // se empaqueta en el ZIP de esta pieza) — el fallback.jpg sigue
        // componiéndose con el PNG original del master (renderFallbackFromFrame
        // usa los layer_bounds del master tal cual, sin reescalar).
        const textAssets = allAssets.filter(
          (a) => !a.discarded && a.classification === "texto" && (a.text_content ?? "").trim(),
        );

        for (const asset of textAssets) {
          const pngFilename = assetFilename(asset);
          const meta = asset.metadata as TextLayerMetadata | undefined;
          const fontName = meta?.fontName;
          if (!pngFilename || !fontName || !asset.layer_bounds) continue;

          try {
            const fontBuffer = await resolveProjectFont(payload.projectId, fontName, supabase);
            if (!fontBuffer) continue;

            const textPng = await renderTextAsPng({
              text: asset.text_content ?? "",
              fontBuffer,
              fontName,
              sourceFontSize: meta?.fontSize ?? 100,
              sourcePsdWidth: project.psd_width ?? masterEntry.spec.ancho,
              sourcePsdHeight: project.psd_height ?? masterEntry.spec.alto,
              targetWidth: spec.ancho,
              targetHeight: spec.alto,
              sourceLayerBounds: asset.layer_bounds,
              textColor: meta?.textColor ?? undefined,
            });

            formatAssetBuffers.set(exportFilenameFor(pngFilename, !!asset.export_as_jpg), textPng);
          } catch (textError) {
            // Un fallo renderizando una capa de texto no debe tirar abajo el
            // formato completo — se mantiene el PNG del master para esa capa.
            console.error(`No se pudo renderizar texto custom para "${asset.layer_name}":`, textError);
          }
        }

        // Verificación: formatAssetBuffers debe incluir el fondo/imagen_principal
        // ya reencuadrado con FLUX (sobreescrito arriba) — un filename ausente
        // aquí es la causa típica de un ZIP sin imagen de fondo para ese formato.
        console.log("Assets en ZIP para", format.iab_format, ":", Array.from(formatAssetBuffers.keys()));

        console.log(`Formato ${n}/${total}: generando HTML5...`);
        const adaptedHtml = await adaptHtml5WithVision(
          masterHtml,
          masterRendered!,
          { width: masterEntry.spec.ancho, height: masterEntry.spec.alto },
          allAssets,
          formatAssetBuffers,
          { width: spec.ancho, height: spec.alto, iabFormat: format.iab_format },
        );

        console.log(`Formato ${n}/${total}: refinando con feedback visual...`);
        // Desactivado temporalmente (maxIterations: 0) — el loop de feedback
        // visual tiene un bug pendiente de arreglar. El código queda intacto
        // para reactivarlo subiendo maxIterations cuando esté resuelto.
        const refinedHtml = await refineHtml5WithVisualFeedback(
          adaptedHtml,
          { width: spec.ancho, height: spec.alto, iabFormat: format.iab_format },
          formatAssetBuffers,
          0,
        );

        console.log(`Formato ${n}/${total}: componiendo fallback.jpg...`);
        const fallbackJpg = await renderFallbackFromFrame(
          payload.projectId,
          { width: spec.ancho, height: spec.alto },
          allAssets,
          supabase,
          fallbackOverrides,
        );

        const basePath = `${payload.projectId}/adaptations/${format.iab_format}`;

        await Promise.all([
          supabase.storage
            .from("adstudio-projects")
            .upload(`${basePath}/index.html`, refinedHtml, { contentType: "text/html", upsert: true }),
          supabase.storage
            .from("adstudio-projects")
            .upload(`${basePath}/fallback.jpg`, fallbackJpg, { contentType: "image/jpeg", upsert: true }),
        ]);

        // "ready" (no "producido"): es el valor de FormatStatus que ya
        // consume el resto de la UI (p. ej. production-view.tsx cuenta
        // producedCount por status === "ready") — introducir un literal
        // nuevo rompería esas vistas sin aportar nada.
        await supabase.from("adstudio_formats").update({ status: "ready" }).eq("id", format.id);

        // La pieza se genera UNA SOLA VEZ arriba; aquí solo se copian esos
        // mismos buffers a la carpeta de cada medio que necesita este tamaño
        // (adstudio_formats.soportes — dedupe por tamaño, no por soporte+tamaño).
        const formatPngEntries = pngEntries.map((entry) => ({
          filename: entry.filename,
          buffer: formatAssetBuffers.get(entry.filename) ?? entry.buffer,
        }));

        // Assets del formato (incluye fondo/imagen_principal ya reencuadrados
        // con FLUX, que solo existían en memoria) — persistidos por format.id
        // para que app/api/preview/[projectId]/adaptation/[formatId] pueda
        // servirlos en el iframe de app/project/[id]/delivery.
        await Promise.all(
          formatPngEntries.map((png) =>
            supabase.storage
              .from("adstudio-projects")
              .upload(`${payload.projectId}/adaptations/${format.id}/${png.filename}`, png.buffer, {
                contentType: contentTypeForFilename(png.filename),
                upsert: true,
              }),
          ),
        );

        const pieceFolders = pieceFoldersFor(format);
        for (const pieceFolder of pieceFolders) {
          zipEntries.push({ path: `${pieceFolder}/index.html`, content: refinedHtml });
          for (const png of formatPngEntries) {
            zipEntries.push({ path: `${pieceFolder}/${png.filename}`, content: png.buffer });
          }
          zipEntries.push({ path: `${pieceFolder}/fallback.jpg`, content: fallbackJpg });
        }

        manifestPieces.push({
          nombreSoporte: format.nombre_soporte,
          iabFormat: format.iab_format,
          width: spec.ancho,
          height: spec.alto,
          jpgSizeBytes: fallbackJpg.byteLength,
          htmlSizeBytes: Buffer.byteLength(refinedHtml, "utf8"),
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

    // Bloque 11: formatos con PSD propio — ya se generaron en
    // trigger/render-master.ts (index.html + fallback.jpg propios a partir de
    // sus capas), aquí solo se copian al ZIP de entrega, sin FLUX ni Claude.
    for (const { format, spec } of formatsWithOwnPsd) {
      try {
        const basePath = `${payload.projectId}/masters/${format.id}/${format.iab_format}`;

        const [htmlBuffer, fallbackJpg] = await Promise.all([
          downloadAsset(supabase, `${basePath}.html`),
          downloadAsset(supabase, `${basePath}.jpg`),
        ]);

        if (!htmlBuffer || !fallbackJpg) {
          throw new Error("El master de este formato todavía no se ha generado.");
        }

        const ownHtml = htmlBuffer.toString("utf-8");

        const ownPngEntries = (
          await Promise.all(
            allAssets
              .filter((a) => !a.discarded && a.source_psd_id === format.source_psd_id)
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

        // Mismo criterio que formatPngEntries arriba: persistidos por
        // format.id para el iframe de preview de adaptaciones.
        await Promise.all(
          ownPngEntries.map((png) =>
            supabase.storage
              .from("adstudio-projects")
              .upload(`${payload.projectId}/adaptations/${format.id}/${png.filename}`, png.buffer, {
                contentType: contentTypeForFilename(png.filename),
                upsert: true,
              }),
          ),
        );

        const pieceFolders = pieceFoldersFor(format);
        for (const pieceFolder of pieceFolders) {
          zipEntries.push({ path: `${pieceFolder}/index.html`, content: ownHtml });
          for (const png of ownPngEntries) {
            zipEntries.push({ path: `${pieceFolder}/${png.filename}`, content: png.buffer });
          }
          zipEntries.push({ path: `${pieceFolder}/fallback.jpg`, content: fallbackJpg });
        }

        manifestPieces.push({
          nombreSoporte: format.nombre_soporte,
          iabFormat: format.iab_format,
          width: spec.ancho,
          height: spec.alto,
          jpgSizeBytes: fallbackJpg.byteLength,
          htmlSizeBytes: Buffer.byteLength(ownHtml, "utf8"),
          incidencias: format.incidencias ?? [],
          soportes: format.soportes ?? [],
        });

        producedCount += 1;
      } catch (formatError) {
        await supabase.from("adstudio_formats").update({ status: "incident" }).eq("id", format.id);
        console.error(`Error copiando master propio de ${format.iab_format}:`, formatError);
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
