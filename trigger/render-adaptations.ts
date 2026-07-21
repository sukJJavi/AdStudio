import { task, metadata } from "@trigger.dev/sdk/v3";
import { createTriggerSupabaseClient } from "@/lib/supabase/trigger-client";
import { getIABFormatById, type IABFormat } from "@/lib/iab/specs";
import { unblockedFormats } from "@/lib/iab/incident-analyzer";
import { fontFamilyStack, googleFontUrl } from "@/lib/fonts";
import { splitCopy } from "@/lib/render/copy";
import { downloadAsset, selectClassifiedAssets } from "@/lib/render/assets";
import { loadGoogleFont } from "@/lib/render/font-loader";
import { renderBannerToJpg } from "@/lib/render/jpg-renderer";
import { generateHtml5 } from "@/lib/render/html5-generator";
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

function toBase64(buffer: Buffer | null): string | undefined {
  return buffer ? buffer.toString("base64") : undefined;
}

async function renderPiece(params: {
  format: ProjectFormat;
  spec: IABFormat;
  fondoBase64: string | undefined;
  imagenPrincipalBase64: string | undefined;
  logoBase64: string | undefined;
  logoAspectRatio: number | null;
  fontFamily: string;
  fontImportUrl: string;
  fontRegularBase64: string;
  fontBoldBase64: string;
}): Promise<{ animatedHtml: string; fallbackJpg: Buffer }> {
  const {
    format,
    spec,
    fondoBase64,
    imagenPrincipalBase64,
    logoBase64,
    logoAspectRatio,
    fontFamily,
    fontImportUrl,
    fontRegularBase64,
    fontBoldBase64,
  } = params;

  const { claim, subclaim, disclaimer } = splitCopy(format.copy ?? null);

  const fallbackJpg = await renderBannerToJpg({
    width: spec.ancho,
    height: spec.alto,
    backgroundColor: "#FFFFFF",
    backgroundImageBase64: fondoBase64,
    mainImageBase64: imagenPrincipalBase64,
    logoBase64,
    logoAspectRatio,
    claim,
    subclaim,
    cta: claim,
    disclaimer,
    fontFamily,
    fontBase64: fontRegularBase64,
    fontBoldBase64,
  });

  const animatedHtml = generateHtml5({
    width: spec.ancho,
    height: spec.alto,
    backgroundColor: "#FFFFFF",
    backgroundImageBase64: fondoBase64 ?? null,
    mainImageBase64: imagenPrincipalBase64 ?? null,
    logoBase64: logoBase64 ?? null,
    logoAspectRatio,
    claim,
    subclaim,
    cta: claim,
    disclaimer,
    fontFamily,
    googleFontImportUrl: fontImportUrl,
    fallbackJpgBase64: fallbackJpg.toString("base64"),
  });

  return { animatedHtml, fallbackJpg };
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

    metadata.set("step", "descargando-assets-y-fuente");
    metadata.set("progress", 0.05);

    const fontPrimary = project.font_primary ?? "Inter";

    const [fondoBuffer, imagenPrincipalBuffer, logoBuffer, fontRegularBuffer, fontBoldBuffer] = await Promise.all([
      downloadAsset(supabase, fondoAsset?.file_path ?? null),
      downloadAsset(supabase, imagenPrincipalAsset?.file_path ?? null),
      downloadAsset(supabase, logoAsset?.file_path ?? null),
      loadGoogleFont(fontPrimary, 400),
      loadGoogleFont(fontPrimary, 700),
    ]);

    const fondoBase64 = toBase64(fondoBuffer);
    const imagenPrincipalBase64 = toBase64(imagenPrincipalBuffer);
    const logoBase64 = toBase64(logoBuffer);
    const fontRegularBase64 = fontRegularBuffer.toString("base64");
    const fontBoldBase64 = fontBoldBuffer.toString("base64");

    const logoAspectRatio =
      logoAsset?.width && logoAsset?.height && logoAsset.height > 0 ? logoAsset.width / logoAsset.height : null;

    const fontFamily = fontFamilyStack(fontPrimary);
    const fontImportUrl = googleFontUrl(fontPrimary);

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
        const { animatedHtml, fallbackJpg } = await renderPiece({
          format,
          spec,
          fondoBase64,
          imagenPrincipalBase64,
          logoBase64,
          logoAspectRatio,
          fontFamily,
          fontImportUrl,
          fontRegularBase64,
          fontBoldBase64,
        });

        const basePath = `${payload.projectId}/adaptations/${format.iab_format}`;

        await Promise.all([
          supabase.storage
            .from("adstudio-projects")
            .upload(`${basePath}/index.html`, animatedHtml, { contentType: "text/html", upsert: true }),
          supabase.storage
            .from("adstudio-projects")
            .upload(`${basePath}/fallback.jpg`, fallbackJpg, { contentType: "image/jpeg", upsert: true }),
        ]);

        await supabase.from("adstudio_formats").update({ status: "ready" }).eq("id", format.id);

        const pieceFolder = `${sanitizePathSegment(format.nombre_soporte)}_${format.iab_format}`;
        zipEntries.push({ path: `${pieceFolder}/index.html`, content: animatedHtml });
        zipEntries.push({ path: `${pieceFolder}/fallback.jpg`, content: fallbackJpg });

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
