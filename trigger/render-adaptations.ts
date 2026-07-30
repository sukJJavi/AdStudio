import { task, metadata } from "@trigger.dev/sdk/v3";
import sharp from "sharp";
import { createTriggerSupabaseClient } from "@/lib/supabase/trigger-client";
import { getIABFormatById, type IABFormat } from "@/lib/iab/specs";
import { unblockedFormats } from "@/lib/iab/incident-analyzer";
import { downloadAsset, downloadAssetBuffers } from "@/lib/render/assets";
import { adaptHtml5WithVision, inlineAssetsAsDataUrls } from "@/lib/render/html5-generator";
import { renderInlinedHtmlToImage } from "@/lib/render/browserless-renderer";
import { adaptImageAsset } from "@/lib/render/replicate-outpainting";
import { renderAdaptationFallbackJpg } from "@/lib/render/adaptation-fallback";
import { exportBufferFor, exportFilenameFor } from "@/lib/render/export-format";
import { classifyFormat } from "@/lib/render/format-level";
import { generateNivel1Adaptation } from "@/lib/render/geometric-scale-adaptation";
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

type PsdMaster = {
  psdId: string;
  width: number;
  height: number;
  ratio: number;
  iabFormat: string;
  html: string;
};

/**
 * Bloque 15 — multi-master: cada PSD subido es un master independiente (ver
 * trigger/render-master.ts), no un único master global. Asigna cada formato
 * del plan al master-base cuyo ratio de aspecto sea más cercano; `exact`
 * (diferencia < 5%) significa que el formato puede servirse copiando el
 * master de ese PSD directamente (solo ajuste geométrico mínimo), sin pasar
 * por el pipeline de adaptación Nivel 1/2.
 */
function assignMasterToFormat(formatRatio: number, psdMasters: PsdMaster[]): { psdId: string; exact: boolean } {
  let closest = psdMasters[0];
  let minDiff = Infinity;
  for (const m of psdMasters) {
    const diff = Math.abs(m.ratio - formatRatio) / m.ratio;
    if (diff < minDiff) {
      minDiff = diff;
      closest = m;
    }
  }
  return { psdId: closest.psdId, exact: minDiff < 0.05 };
}

/**
 * Adaptaciones profesionales: Browserless (render real del master-base
 * asignado) + Replicate FLUX Kontext (reencuadre por asset de fondo/imagen_
 * principal) + Claude Vision (posicionamiento de todos los assets, ya
 * reencuadrados o no) — Nivel 2. Nivel 1 (ratio parecido) y los formatos con
 * match casi exacto usan escalado geométrico puro, sin Claude ni FLUX.
 *
 * CRÍTICO (Bloque 15): los assets de cada formato se toman EXCLUSIVAMENTE del
 * PSD asignado como su master-base (`source_psd_id`) — nunca se mezclan capas
 * de PSDs distintos para un mismo formato (bug previo: "Adapting asset:
 * 728x90 → 300x250" ocurría incluso cuando el 300x250 pertenecía a otro
 * master; el ZIP salía con assets duplicados de todos los PSDs).
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

    const [{ data: allFormats }, { data: assets }, { data: project }, { data: masterRows }] = await Promise.all([
      supabase.from("adstudio_formats").select("*").eq("project_id", payload.projectId),
      supabase.from("adstudio_assets").select("*").eq("project_id", payload.projectId),
      supabase.from("adstudio_projects").select("cliente, producto").eq("id", payload.projectId).single(),
      supabase
        .from("adstudio_masters")
        .select("source_psd_id, width, height, iab_format, html")
        .eq("project_id", payload.projectId)
        .not("source_psd_id", "is", null),
    ]);

    if (!project) {
      throw new Error("Proyecto no encontrado.");
    }

    const psdMasters: PsdMaster[] = (masterRows ?? [])
      .filter((m) => m.source_psd_id && m.html && m.width && m.height)
      .map((m) => ({
        psdId: m.source_psd_id as string,
        width: m.width as number,
        height: m.height as number,
        ratio: (m.width as number) / (m.height as number),
        iabFormat: m.iab_format as string,
        html: m.html as string,
      }));

    if (psdMasters.length === 0) {
      throw new Error("No hay ningún master generado. Genera el master antes de producir adaptaciones.");
    }

    const allAssets = (assets ?? []) as ProjectAsset[];

    const formatsToProduce = unblockedFormats((allFormats ?? []) as ProjectFormat[])
      .map((format) => ({ format, spec: getIABFormatById(format.iab_format) }))
      .filter((x): x is { format: ProjectFormat; spec: IABFormat } => x.spec != null);

    if (formatsToProduce.length === 0) {
      throw new Error("No hay formatos disponibles para producir (todos bloqueados o sin especificación IAB).");
    }

    // Assets ya descargados/exportados, cacheados por PSD — evita
    // redescargar los mismos buffers para cada formato asignado al mismo
    // master-base, y garantiza que nunca se mezclan con los de otro PSD.
    const assetBuffersByPsd = new Map<string, Map<string, Buffer>>();
    async function assetBuffersForPsd(psdId: string): Promise<Map<string, Buffer>> {
      const cached = assetBuffersByPsd.get(psdId);
      if (cached) return cached;
      const scoped = allAssets.filter((a) => a.source_psd_id === psdId);
      const buffers = await downloadAssetBuffers(scoped, supabase);
      assetBuffersByPsd.set(psdId, buffers);
      return buffers;
    }

    // Screenshot del master-base ya renderizado — cacheado por PSD; solo se
    // calcula para los formatos que de verdad necesitan Nivel 2 (FLUX +
    // Claude Vision), nunca para match exacto o Nivel 1 (escalado puro).
    const masterRenderedByPsd = new Map<string, Buffer>();
    async function masterRenderedForPsd(psdMaster: PsdMaster): Promise<Buffer> {
      const cached = masterRenderedByPsd.get(psdMaster.psdId);
      if (cached) return cached;
      const buffers = await assetBuffersForPsd(psdMaster.psdId);
      const inlined = inlineAssetsAsDataUrls(psdMaster.html, buffers);
      const rendered = await renderInlinedHtmlToImage(inlined, psdMaster.width, psdMaster.height, {
        forceAnimationEnd: true,
      });
      masterRenderedByPsd.set(psdMaster.psdId, rendered);
      return rendered;
    }

    const cropTargetsByPsd = new Map<string, ProjectAsset[]>();
    function cropTargetsForPsd(psdId: string): ProjectAsset[] {
      const cached = cropTargetsByPsd.get(psdId);
      if (cached) return cached;
      // Reencuadre con FLUX Kontext solo para la capa que el usuario marcó
      // explícitamente como JPG (toggle en el editor de capas) — decisión
      // explícita en vez de inferir "es fondo" por classification, y el
      // umbral de área descarta capas JPG pequeñas (p. ej. un logo).
      const targets = allAssets.filter(
        (a) =>
          a.source_psd_id === psdId &&
          !a.discarded &&
          a.export_as_jpg === true &&
          a.layer_bounds &&
          a.layer_bounds.width * a.layer_bounds.height >= 10000,
      );
      cropTargetsByPsd.set(psdId, targets);
      return targets;
    }

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
        const formatRatio = spec.ancho / spec.alto;

        // Override manual (Bloque 15, "Master base" en brief-form.tsx) >
        // asociación histórica (Bloque 11, source_psd_id) > automático por
        // ratio más cercano.
        const overridePsdId = format.master_base_psd_id ?? format.source_psd_id ?? null;
        const overrideMaster = overridePsdId ? psdMasters.find((m) => m.psdId === overridePsdId) : undefined;

        const assignment = overrideMaster
          ? { psdId: overrideMaster.psdId, exact: true }
          : assignMasterToFormat(formatRatio, psdMasters);

        const psdMaster = psdMasters.find((m) => m.psdId === assignment.psdId);
        if (!psdMaster) throw new Error("No se encontró el master-base asignado a este formato.");

        console.log(
          `Formato ${n}/${total} (${spec.ancho}x${spec.alto}): master-base PSD ${psdMaster.psdId} ` +
            `(${psdMaster.width}x${psdMaster.height}), exact=${assignment.exact}`,
        );

        // CRÍTICO: solo los assets del PSD asignado — nunca se mezclan capas
        // de otros PSDs para este formato (ver docstring del task arriba).
        const formatAssetBuffers = new Map(await assetBuffersForPsd(psdMaster.psdId));
        const psdAssets = allAssets.filter((a) => a.source_psd_id === psdMaster.psdId);

        let finalHtml: string;
        let level: "nivel1" | "nivel2" | null = null;

        if (assignment.exact) {
          // Match casi exacto: se usa el master de ese PSD directamente — el
          // escalado geométrico con factores ~1 solo ajusta el px de sobra si
          // las dimensiones difieren mínimamente, sin reconstruir el HTML.
          console.log(`Formato ${n}/${total}: match exacto con su master-base, copiando directamente...`);
          const scaled = await generateNivel1Adaptation(
            payload.projectId,
            psdMaster.html,
            { width: psdMaster.width, height: psdMaster.height },
            { width: spec.ancho, height: spec.alto },
            psdAssets,
            formatAssetBuffers,
          );
          for (const [filename, buffer] of scaled.assetBuffers) {
            formatAssetBuffers.set(filename, buffer);
          }
          finalHtml = scaled.html;
        } else {
          level = classifyFormat(psdMaster.width, psdMaster.height, spec.ancho, spec.alto);
          console.log(`Formato ${n}/${total}: nivel ${level} (frente a su master-base)`);

          if (level === "nivel1") {
            const nivel1 = await generateNivel1Adaptation(
              payload.projectId,
              psdMaster.html,
              { width: psdMaster.width, height: psdMaster.height },
              { width: spec.ancho, height: spec.alto },
              psdAssets,
              formatAssetBuffers,
            );
            for (const [filename, buffer] of nivel1.assetBuffers) {
              formatAssetBuffers.set(filename, buffer);
            }
            finalHtml = nivel1.html;
          } else {
            console.log(`Formato ${n}/${total}: reencuadrando assets con FLUX Kontext (Nivel 2)...`);

            const cropTargets = cropTargetsForPsd(psdMaster.psdId);
            for (let cropIndex = 0; cropIndex < cropTargets.length; cropIndex++) {
              const asset = cropTargets[cropIndex];

              // Espaciar llamadas a Replicate cuando hay más de un cropTarget
              // en este formato — evita el rate limiting de la API.
              if (cropIndex > 0) {
                await sleep(10_000);
              }

              const pngFilename = assetFilename(asset);
              if (!pngFilename || !asset.file_path) continue;

              // Siempre desde el PNG original en Storage (nunca del buffer ya
              // convertido a JPG) — adaptImageAsset asume PNG.
              const originalBuffer = await downloadAsset(supabase, asset.file_path);
              if (!originalBuffer) continue;

              const { width: srcWidth, height: srcHeight } = await sharp(originalBuffer).metadata();
              if (!srcWidth || !srcHeight) continue;

              const adaptedPng = await adaptImageAsset(originalBuffer, srcWidth, srcHeight, spec.ancho, spec.alto);
              const adaptedExported = await exportBufferFor(adaptedPng, !!asset.export_as_jpg);

              formatAssetBuffers.set(exportFilenameFor(pngFilename, !!asset.export_as_jpg), adaptedExported);
            }

            console.log("Assets en ZIP para", format.iab_format, ":", Array.from(formatAssetBuffers.keys()));

            const masterRendered = await masterRenderedForPsd(psdMaster);

            finalHtml = await adaptHtml5WithVision(
              psdMaster.html,
              masterRendered,
              { width: psdMaster.width, height: psdMaster.height },
              psdAssets,
              formatAssetBuffers,
              { width: spec.ancho, height: spec.alto, iabFormat: format.iab_format },
            );
          }
        }

        console.log(`Formato ${n}/${total}: renderizando fallback.jpg (screenshot real del HTML)...`);
        const fallbackJpg = await renderAdaptationFallbackJpg(
          finalHtml,
          { width: spec.ancho, height: spec.alto },
          formatAssetBuffers,
        );

        const basePath = `${payload.projectId}/adaptations/${format.iab_format}`;

        await Promise.all([
          supabase.storage
            .from("adstudio-projects")
            .upload(`${basePath}/index.html`, finalHtml, { contentType: "text/html", upsert: true }),
          supabase.storage
            .from("adstudio-projects")
            .upload(`${basePath}/fallback.jpg`, fallbackJpg, { contentType: "image/jpeg", upsert: true }),
        ]);

        // Se guarda en adstudio_masters para poder revisarlo/refinarlo por
        // chat desde app/project/[id]/delivery (ver lib/adaptation-refine.ts)
        // — 'draft' solo para Nivel 2 (FLUX + Claude Vision, más propenso a
        // necesitar ajuste); match exacto y Nivel 1 quedan 'ready' de entrada.
        await supabase.from("adstudio_masters").upsert(
          {
            project_id: payload.projectId,
            format_id: format.id,
            iab_format: format.iab_format,
            width: spec.ancho,
            height: spec.alto,
            jpg_path: `${basePath}/fallback.jpg`,
            html: finalHtml,
            status: level === "nivel2" ? "draft" : "ready",
          },
          { onConflict: "project_id,iab_format" },
        );

        // "ready" (no "producido"): es el valor de FormatStatus que ya
        // consume el resto de la UI (p. ej. production-view.tsx cuenta
        // producedCount por status === "ready") — introducir un literal
        // nuevo rompería esas vistas sin aportar nada.
        await supabase.from("adstudio_formats").update({ status: "ready" }).eq("id", format.id);

        // Solo los assets resueltos para ESTE formato (los del PSD asignado,
        // con fondo/imagen_principal ya adaptado si aplica) — punto 6: sin
        // duplicados ni mezcla de otros PSDs en el ZIP.
        const formatPngEntries = Array.from(formatAssetBuffers.entries()).map(([filename, buffer]) => ({
          filename,
          buffer,
        }));

        // Persistidos por format.id para que
        // app/api/preview/[projectId]/adaptation/[formatId] pueda servirlos
        // en el iframe de app/project/[id]/delivery.
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
          zipEntries.push({ path: `${pieceFolder}/index.html`, content: finalHtml });
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
          htmlSizeBytes: Buffer.byteLength(finalHtml, "utf8"),
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
