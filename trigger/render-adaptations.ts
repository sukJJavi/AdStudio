import { task, metadata } from "@trigger.dev/sdk/v3";
import type { Browser } from "puppeteer-core";
import { createTriggerSupabaseClient } from "@/lib/supabase/trigger-client";
import { getIABFormatById, type IABFormat } from "@/lib/iab/specs";
import { unblockedFormats } from "@/lib/iab/incident-analyzer";
import { fontFamilyStack, googleFontUrl } from "@/lib/fonts";
import { buildCanvasHtml, splitCopy } from "@/lib/render/canvas-html";
import { downloadAsset, selectClassifiedAssets } from "@/lib/render/assets";
import { launchBrowser } from "@/lib/render/browser";
import {
  buildManifestJson,
  buildZipBuffer,
  campaignSlug,
  sanitizePathSegment,
  type ManifestPieceEntry,
  type ZipFileEntry,
} from "@/lib/export/zip";
import type { ProjectFormat } from "@/lib/types";

type RenderAdaptationsPayload = {
  projectId: string;
};

/** Bloque 3: valores fijos del CTA — altura fija 32px, padding 12px horizontal. */
const CTA_HEIGHT_PX = 32;
const CTA_PADDING_HORIZONTAL_PX = 12;
const CTA_FONT_SIZE_PX = 13;

/** Claim: base 16px en 300x250 (75.000px²), escala linealmente con sqrt(área). */
const CLAIM_BASE_FONT_SIZE_PX = 16;
const CLAIM_BASE_AREA = 300 * 250;

/** Imagen principal: máx 55% del área del formato → caja al sqrt(0.55) del ancho/alto. */
const MAIN_IMAGE_AREA_RATIO = 0.55;

const ASSET_FILE_NAMES = {
  fondo: "fondo.png",
  imagenPrincipal: "imagen-principal.png",
  logo: "logo.png",
} as const;

type PieceAssets = { fileName: string; buffer: Buffer }[];

async function renderPiece(params: {
  browser: Browser;
  format: ProjectFormat;
  spec: IABFormat;
  fondoBuffer: Buffer | null;
  imagenPrincipalBuffer: Buffer | null;
  logoBuffer: Buffer | null;
  logoAspectRatio: number | null;
  fontFamily: string;
  fontImportUrl: string;
}): Promise<{ animatedHtml: string; fallbackJpg: Buffer; assetFiles: PieceAssets }> {
  const { browser, format, spec, fondoBuffer, imagenPrincipalBuffer, logoBuffer, logoAspectRatio, fontFamily, fontImportUrl } =
    params;

  const safe = spec.zonaSeguraPx;
  const area = spec.ancho * spec.alto;

  const logoWidthPx = Math.round(spec.ancho * 0.2);
  const logoHeightPx = logoAspectRatio ? Math.round(logoWidthPx / logoAspectRatio) : Math.round(logoWidthPx * 0.4);
  const claimTopPx = logoBuffer ? safe + logoHeightPx + safe : safe;

  const claimFontSizePx = Math.min(
    64,
    Math.max(10, Math.round(CLAIM_BASE_FONT_SIZE_PX * Math.sqrt(area / CLAIM_BASE_AREA))),
  );
  const subclaimFontSizePx = Math.max(9, Math.round(claimFontSizePx * 0.55));

  const mainImageBoxPct = Math.sqrt(MAIN_IMAGE_AREA_RATIO) * 100;

  const { claim, subclaim, disclaimer } = splitCopy(format.copy ?? null);

  const layoutBase = {
    width: spec.ancho,
    height: spec.alto,
    safeZonePx: safe,
    mainImageMaxWidthPct: mainImageBoxPct,
    mainImageMaxHeightPct: mainImageBoxPct,
    logoWidthPx,
    logoHeightPx,
    claim,
    claimFontSizePx,
    claimTopPx,
    subclaim,
    subclaimFontSizePx,
    subclaimTopPx: claimTopPx + claimFontSizePx + 6,
    cta: claim,
    ctaFontSizePx: CTA_FONT_SIZE_PX,
    ctaHeightPx: CTA_HEIGHT_PX,
    ctaPaddingHorizontalPx: CTA_PADDING_HORIZONTAL_PX,
    disclaimer,
    fontFamily,
    googleFontImportUrl: fontImportUrl,
  };

  const toInlineDataUri = (buffer: Buffer | null) =>
    buffer ? `data:image/png;base64,${buffer.toString("base64")}` : null;

  // Render estático (sin GSAP) con imágenes en base64 — usado solo para capturar el JPG de respaldo.
  const staticHtml = buildCanvasHtml({
    ...layoutBase,
    backgroundSrc: toInlineDataUri(fondoBuffer),
    mainImageSrc: toInlineDataUri(imagenPrincipalBuffer),
    logoSrc: toInlineDataUri(logoBuffer),
    animated: false,
  });

  const page = await browser.newPage();
  let fallbackJpg: Buffer;
  try {
    await page.setViewport({ width: spec.ancho, height: spec.alto, deviceScaleFactor: 1 });
    await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(staticHtml)}`, {
      waitUntil: "networkidle0",
    });
    fallbackJpg = (await page.screenshot({ type: "jpeg", quality: 90 })) as Buffer;
  } finally {
    await page.close();
  }

  // HTML5 entregable: animado (GSAP) y con rutas relativas a assets/ (nunca base64,
  // para respetar el peso máximo IAB LEAN de 150KB).
  const assetFiles: PieceAssets = [];
  if (fondoBuffer) assetFiles.push({ fileName: ASSET_FILE_NAMES.fondo, buffer: fondoBuffer });
  if (imagenPrincipalBuffer) assetFiles.push({ fileName: ASSET_FILE_NAMES.imagenPrincipal, buffer: imagenPrincipalBuffer });
  if (logoBuffer) assetFiles.push({ fileName: ASSET_FILE_NAMES.logo, buffer: logoBuffer });

  const animatedHtml = buildCanvasHtml({
    ...layoutBase,
    backgroundSrc: fondoBuffer ? `assets/${ASSET_FILE_NAMES.fondo}` : null,
    mainImageSrc: imagenPrincipalBuffer ? `assets/${ASSET_FILE_NAMES.imagenPrincipal}` : null,
    logoSrc: logoBuffer ? `assets/${ASSET_FILE_NAMES.logo}` : null,
    animated: true,
  });

  return { animatedHtml, fallbackJpg, assetFiles };
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
      supabase
        .from("adstudio_projects")
        .select("cliente, producto, font_primary")
        .eq("id", payload.projectId)
        .single(),
    ]);

    if (!project) {
      throw new Error("Proyecto no encontrado.");
    }

    const formatsToProduce = unblockedFormats((allFormats ?? []) as ProjectFormat[])
      .map((format) => ({ format, spec: getIABFormatById(format.iab_format) }))
      .filter((x): x is { format: ProjectFormat; spec: IABFormat } => x.spec != null);

    if (formatsToProduce.length === 0) {
      throw new Error("No hay formatos disponibles para producir (todos bloqueados o sin especificación IAB).");
    }

    const { byClassification } = selectClassifiedAssets(assets ?? []);
    const fondoAsset = byClassification("fondo");
    const imagenPrincipalAsset = byClassification("imagen_principal");
    const logoAsset = byClassification("logo");

    const [fondoBuffer, imagenPrincipalBuffer, logoBuffer] = await Promise.all([
      downloadAsset(supabase, fondoAsset?.file_path ?? null),
      downloadAsset(supabase, imagenPrincipalAsset?.file_path ?? null),
      downloadAsset(supabase, logoAsset?.file_path ?? null),
    ]);

    const logoAspectRatio =
      logoAsset?.width && logoAsset?.height && logoAsset.height > 0 ? logoAsset.width / logoAsset.height : null;

    const fontPrimary = project.font_primary ?? "Inter";
    const fontFamily = fontFamilyStack(fontPrimary);
    const fontImportUrl = googleFontUrl(fontPrimary);

    const zipEntries: ZipFileEntry[] = [];
    const manifestPieces: ManifestPieceEntry[] = [];
    const total = formatsToProduce.length;
    let producedCount = 0;

    const browser = await launchBrowser();

    try {
      for (let i = 0; i < formatsToProduce.length; i++) {
        const { format, spec } = formatsToProduce[i];
        const stepLabel = `Produciendo ${format.nombre_soporte} ${spec.ancho}x${spec.alto} (${i + 1} de ${total})`;

        metadata.set("step", stepLabel);
        metadata.set("current", i + 1);
        metadata.set("total", total);
        metadata.set("progress", i / total);

        await supabase.from("adstudio_formats").update({ status: "producing" }).eq("id", format.id);

        try {
          const { animatedHtml, fallbackJpg, assetFiles } = await renderPiece({
            browser,
            format,
            spec,
            fondoBuffer,
            imagenPrincipalBuffer,
            logoBuffer,
            logoAspectRatio,
            fontFamily,
            fontImportUrl,
          });

          const basePath = `${payload.projectId}/adaptations/${format.iab_format}`;

          const uploads: Promise<unknown>[] = [
            supabase.storage
              .from("adstudio-projects")
              .upload(`${basePath}/index.html`, animatedHtml, { contentType: "text/html", upsert: true }),
            supabase.storage
              .from("adstudio-projects")
              .upload(`${basePath}/fallback.jpg`, fallbackJpg, { contentType: "image/jpeg", upsert: true }),
            ...assetFiles.map((asset) =>
              supabase.storage
                .from("adstudio-projects")
                .upload(`${basePath}/assets/${asset.fileName}`, asset.buffer, {
                  contentType: "image/png",
                  upsert: true,
                }),
            ),
          ];

          await Promise.all(uploads);
          await supabase.from("adstudio_formats").update({ status: "ready" }).eq("id", format.id);

          const pieceFolder = `${sanitizePathSegment(format.nombre_soporte)}_${format.iab_format}`;
          zipEntries.push({ path: `${pieceFolder}/index.html`, content: animatedHtml });
          zipEntries.push({ path: `${pieceFolder}/fallback.jpg`, content: fallbackJpg });
          for (const asset of assetFiles) {
            zipEntries.push({ path: `${pieceFolder}/assets/${asset.fileName}`, content: asset.buffer });
          }

          manifestPieces.push({
            nombreSoporte: format.nombre_soporte,
            iabFormat: format.iab_format,
            width: spec.ancho,
            height: spec.alto,
            jpgSizeBytes: fallbackJpg.byteLength,
            htmlSizeBytes: Buffer.byteLength(animatedHtml, "utf8"),
            incidencias: format.incidencias ?? [],
          });

          producedCount += 1;
        } catch (formatError) {
          // Un formato con error no debe tirar abajo el resto de la producción.
          await supabase.from("adstudio_formats").update({ status: "incident" }).eq("id", format.id);
          console.error(`Error produciendo ${format.iab_format}:`, formatError);
        }
      }
    } finally {
      await browser.close();
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
