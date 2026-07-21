import { task, metadata } from "@trigger.dev/sdk/v3";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getIABFormatById, type IABFormat } from "@/lib/iab/specs";
import { fontFamilyStack, googleFontUrl } from "@/lib/fonts";
import { buildCanvasHtml, splitCopy } from "@/lib/render/canvas-html";
import { pickLargestBy, selectClassifiedAssets, toDataUri } from "@/lib/render/assets";
import { launchBrowser } from "@/lib/render/browser";
import type { ProjectFormat } from "@/lib/types";

type RenderMasterPayload = {
  projectId: string;
  iabFormatId?: string;
  isPrimary?: boolean;
};

export const renderMaster = task({
  id: "render-master",
  run: async (payload: RenderMasterPayload) => {
    const supabase = createServerSupabaseClient();

    metadata.set("step", "leyendo-assets");
    metadata.set("progress", 0);

    const [{ data: assets }, { data: formats }, { data: project }] = await Promise.all([
      supabase.from("adstudio_assets").select("*").eq("project_id", payload.projectId),
      supabase.from("adstudio_formats").select("*").eq("project_id", payload.projectId),
      supabase.from("adstudio_projects").select("font_primary").eq("id", payload.projectId).single(),
    ]);

    const { byClassification } = selectClassifiedAssets(assets ?? []);

    metadata.set("step", "seleccionando-formato");
    metadata.set("progress", 0.15);

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

    metadata.set("step", "construyendo-html");
    metadata.set("progress", 0.3);

    const fondoAsset = byClassification("fondo");
    const imagenPrincipalAsset = byClassification("imagen_principal");
    const logoAsset = byClassification("logo");

    const [backgroundSrc, mainImageSrc, logoSrc] = await Promise.all([
      toDataUri(supabase, fondoAsset?.file_path ?? null),
      toDataUri(supabase, imagenPrincipalAsset?.file_path ?? null),
      toDataUri(supabase, logoAsset?.file_path ?? null),
    ]);

    const logoAspectRatio =
      logoAsset?.width && logoAsset?.height && logoAsset.height > 0 ? logoAsset.width / logoAsset.height : null;

    const safe = spec.zonaSeguraPx;
    const logoWidthPx = Math.round(spec.ancho * 0.2);
    const logoHeightPx = logoAspectRatio ? Math.round(logoWidthPx / logoAspectRatio) : Math.round(logoWidthPx * 0.4);
    const claimTopPx = logoSrc ? safe + logoHeightPx + safe : safe;
    const claimFontSizePx = Math.min(56, Math.max(14, Math.round(spec.alto * 0.12)));
    const subclaimFontSizePx = Math.max(11, Math.round(claimFontSizePx * 0.55));
    const ctaFontSizePx = Math.max(12, Math.round(claimFontSizePx * 0.5));

    const { claim, subclaim, disclaimer } = splitCopy(format.copy ?? null);

    const html = buildCanvasHtml({
      width: spec.ancho,
      height: spec.alto,
      safeZonePx: safe,
      backgroundSrc,
      mainImageSrc,
      mainImageMaxWidthPct: 60,
      mainImageMaxHeightPct: 60,
      logoSrc,
      logoWidthPx,
      logoHeightPx,
      claim,
      claimFontSizePx,
      claimTopPx,
      subclaim,
      subclaimFontSizePx,
      subclaimTopPx: claimTopPx + claimFontSizePx + 6,
      cta: claim,
      ctaFontSizePx,
      ctaHeightPx: 32,
      ctaPaddingHorizontalPx: 16,
      disclaimer,
      fontFamily: fontFamilyStack(fontPrimary),
      googleFontImportUrl: googleFontUrl(fontPrimary),
      animated: false,
    });

    metadata.set("step", "renderizando");
    metadata.set("progress", 0.55);

    const browser = await launchBrowser();

    let jpgBuffer: Buffer;
    let pngBuffer: Buffer;

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: spec.ancho, height: spec.alto, deviceScaleFactor: 1 });
      // page.goto (no setContent, que no admite networkidle0) para esperar a que
      // cargue la Google Font (@import) antes de capturar.
      await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, {
        waitUntil: "networkidle0",
      });
      jpgBuffer = (await page.screenshot({ type: "jpeg", quality: 90 })) as Buffer;
      pngBuffer = (await page.screenshot({ type: "png" })) as Buffer;
    } finally {
      await browser.close();
    }

    metadata.set("step", "subiendo-archivos");
    metadata.set("progress", 0.85);

    const jpgPath = `${payload.projectId}/master/${format.iab_format}.jpg`;
    const pngPath = `${payload.projectId}/master/${format.iab_format}.png`;

    await Promise.all([
      supabase.storage
        .from("adstudio-projects")
        .upload(jpgPath, jpgBuffer, { contentType: "image/jpeg", upsert: true }),
      supabase.storage
        .from("adstudio-projects")
        .upload(pngPath, pngBuffer, { contentType: "image/png", upsert: true }),
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
        jpg_path: jpgPath,
        png_path: pngPath,
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
