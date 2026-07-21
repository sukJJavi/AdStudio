import { task, metadata } from "@trigger.dev/sdk/v3";
import { createTriggerSupabaseClient } from "@/lib/supabase/trigger-client";
import { getIABFormatById, type IABFormat } from "@/lib/iab/specs";
import { fontFamilyStack, googleFontUrl } from "@/lib/fonts";
import { splitCopy } from "@/lib/render/copy";
import { pickLargestBy, selectClassifiedAssets, downloadAsset } from "@/lib/render/assets";
import { loadGoogleFont } from "@/lib/render/font-loader";
import { renderBannerToJpg, renderBannerToPng } from "@/lib/render/jpg-renderer";
import { generateHtml5 } from "@/lib/render/html5-generator";
import type { ProjectFormat } from "@/lib/types";

type RenderMasterPayload = {
  projectId: string;
  iabFormatId?: string;
  isPrimary?: boolean;
};

function toBase64(buffer: Buffer | null): string | undefined {
  return buffer ? buffer.toString("base64") : undefined;
}

export const renderMaster = task({
  id: "render-master",
  run: async (payload: RenderMasterPayload) => {
    const supabase = createTriggerSupabaseClient();

    metadata.set("step", "leyendo-assets");
    metadata.set("progress", 0);

    const [{ data: assets }, { data: formats }, { data: project }] = await Promise.all([
      supabase.from("adstudio_assets").select("*").eq("project_id", payload.projectId),
      supabase.from("adstudio_formats").select("*").eq("project_id", payload.projectId),
      supabase.from("adstudio_projects").select("font_primary").eq("id", payload.projectId).single(),
    ]);

    const { byClassification } = selectClassifiedAssets(assets ?? []);

    metadata.set("step", "seleccionando-formato");
    metadata.set("progress", 0.1);

    const formatsWithSpec = pickLargestBy(
      ((formats ?? []) as ProjectFormat[])
        .map((format) => ({ format, spec: getIABFormatById(format.iab_format) }))
        .filter((x): x is { format: ProjectFormat; spec: IABFormat } => x.spec != null),
      (x) => x.spec.ancho * x.spec.alto,
    );

    const selected = payload.iabFormatId
      ? (formatsWithSpec.find((x) => x.format.iab_format === payload.iabFormatId) ?? formatsWithSpec[0])
      : formatsWithSpec[0];

    if (!selected) {
      throw new Error("El proyecto no tiene formatos con especificación IAB válida.");
    }

    const { format, spec } = selected;
    const fontPrimary = project?.font_primary ?? "Inter";

    metadata.set("step", "descargando-assets-y-fuente");
    metadata.set("progress", 0.25);

    const fondoAsset = byClassification("fondo");
    const imagenPrincipalAsset = byClassification("imagen_principal");
    const logoAsset = byClassification("logo");

    const [fondoBuffer, imagenPrincipalBuffer, logoBuffer, fontRegular, fontBold] = await Promise.all([
      downloadAsset(supabase, fondoAsset?.file_path ?? null),
      downloadAsset(supabase, imagenPrincipalAsset?.file_path ?? null),
      downloadAsset(supabase, logoAsset?.file_path ?? null),
      loadGoogleFont(fontPrimary, 400),
      loadGoogleFont(fontPrimary, 700),
    ]);

    const logoAspectRatio =
      logoAsset?.width && logoAsset?.height && logoAsset.height > 0 ? logoAsset.width / logoAsset.height : null;

    const { claim, subclaim, disclaimer } = splitCopy(format.copy ?? null);
    const fontFamily = fontFamilyStack(fontPrimary);
    const fontImportUrl = googleFontUrl(fontPrimary);

    const bannerElements = {
      width: spec.ancho,
      height: spec.alto,
      backgroundColor: "#FFFFFF",
      backgroundImageBase64: toBase64(fondoBuffer),
      logoBase64: toBase64(logoBuffer),
      logoAspectRatio,
      mainImageBase64: toBase64(imagenPrincipalBuffer),
      claim,
      subclaim,
      cta: claim,
      disclaimer,
      fontFamily,
      fontBase64: fontRegular.toString("base64"),
      fontBoldBase64: fontBold.toString("base64"),
    };

    metadata.set("step", "renderizando-jpg");
    metadata.set("progress", 0.55);

    const [jpgBuffer, pngBuffer] = await Promise.all([
      renderBannerToJpg(bannerElements),
      renderBannerToPng(bannerElements),
    ]);

    metadata.set("step", "generando-html5");
    metadata.set("progress", 0.75);

    const html = generateHtml5({
      width: spec.ancho,
      height: spec.alto,
      backgroundColor: "#FFFFFF",
      backgroundImageBase64: toBase64(fondoBuffer) ?? null,
      logoBase64: toBase64(logoBuffer) ?? null,
      logoAspectRatio,
      mainImageBase64: toBase64(imagenPrincipalBuffer) ?? null,
      claim,
      subclaim,
      cta: claim,
      disclaimer,
      fontFamily,
      googleFontImportUrl: fontImportUrl,
      fallbackJpgBase64: jpgBuffer.toString("base64"),
    });

    metadata.set("step", "subiendo-archivos");
    metadata.set("progress", 0.9);

    const basePath = `${payload.projectId}/master/${format.iab_format}`;

    await Promise.all([
      supabase.storage
        .from("adstudio-projects")
        .upload(`${basePath}.jpg`, jpgBuffer, { contentType: "image/jpeg", upsert: true }),
      supabase.storage
        .from("adstudio-projects")
        .upload(`${basePath}.png`, pngBuffer, { contentType: "image/png", upsert: true }),
      supabase.storage
        .from("adstudio-projects")
        .upload(`${basePath}.html`, html, { contentType: "text/html", upsert: true }),
    ]);

    const isPrimary = payload.isPrimary ?? false;

    if (isPrimary) {
      await supabase
        .from("adstudio_masters")
        .update({ is_primary: false })
        .eq("project_id", payload.projectId);
    }

    await supabase.from("adstudio_masters").upsert(
      {
        project_id: payload.projectId,
        iab_format: format.iab_format,
        jpg_path: `${basePath}.jpg`,
        png_path: `${basePath}.png`,
        width: spec.ancho,
        height: spec.alto,
        jpg_size_bytes: jpgBuffer.byteLength,
        is_primary: isPrimary,
      },
      { onConflict: "project_id,iab_format" },
    );

    metadata.set("step", "completado");
    metadata.set("progress", 1);

    await supabase
      .from("adstudio_projects")
      .update({ status: "master_ready", master_run_id: null })
      .eq("id", payload.projectId);

    return { projectId: payload.projectId, iabFormat: format.iab_format };
  },
});
