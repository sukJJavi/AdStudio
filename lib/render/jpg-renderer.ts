import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { computeBannerLayout } from "@/lib/render/layout";

export interface BannerElements {
  width: number;
  height: number;
  backgroundColor: string;
  backgroundImageBase64?: string | null;
  logoBase64?: string | null;
  /** Ancho/alto real del logo (de `adstudio_assets.width/height`), para no deformarlo. */
  logoAspectRatio?: number | null;
  mainImageBase64?: string | null;
  claim?: string | null;
  subclaim?: string | null;
  cta?: string | null;
  disclaimer?: string | null;
  fontFamily: string;
  fontBase64: string;
  /**
   * Peso bold (700) real de la misma familia, para claim/CTA. Si se omite,
   * se reutiliza `fontBase64` (el texto seguirá pidiendo `fontWeight: 700`
   * pero sin un archivo bold real no se verá en negrita).
   */
  fontBoldBase64?: string;
}

/** Nodo mínimo compatible con `ReactElement` (lo que espera `satori()`), sin depender de React/JSX. */
type SatoriNode = {
  type: string;
  key: null;
  props: Record<string, unknown>;
};

function el(type: string, props: Record<string, unknown>, children?: SatoriNode[] | string): SatoriNode {
  return { type, key: null, props: children === undefined ? props : { ...props, children } };
}

function dataUri(base64: string): string {
  return `data:image/png;base64,${base64}`;
}

const JPG_QUALITY = 90;

function buildBannerTree(elements: BannerElements): SatoriNode {
  const {
    width,
    height,
    backgroundColor,
    backgroundImageBase64,
    logoBase64,
    logoAspectRatio,
    mainImageBase64,
    claim,
    subclaim,
    cta,
    disclaimer,
    fontFamily,
  } = elements;

  const layout = computeBannerLayout({ width, height, hasLogo: !!logoBase64, logoAspectRatio });

  // Jerarquía visual (misma que en el HTML animado): fondo → imagen principal
  // → logo → claim → subclaim → cta → disclaimer.
  const children: SatoriNode[] = [];

  if (backgroundImageBase64) {
    children.push(
      el("img", {
        src: dataUri(backgroundImageBase64),
        width,
        height,
        style: { position: "absolute", top: 0, left: 0, width, height, objectFit: "cover" },
      }),
    );
  }

  if (mainImageBase64) {
    const boxW = layout.mainImageBoxWidthPx;
    const boxH = layout.mainImageBoxHeightPx;
    children.push(
      el("img", {
        src: dataUri(mainImageBase64),
        width: boxW,
        height: boxH,
        style: {
          position: "absolute",
          top: Math.round((height - boxH) / 2),
          left: Math.round((width - boxW) / 2),
          width: boxW,
          height: boxH,
          objectFit: "contain",
        },
      }),
    );
  }

  if (logoBase64) {
    children.push(
      el("img", {
        src: dataUri(logoBase64),
        width: layout.logoWidthPx,
        height: layout.logoHeightPx,
        style: {
          position: "absolute",
          top: layout.safeZonePx,
          left: layout.safeZonePx,
          width: layout.logoWidthPx,
          height: layout.logoHeightPx,
          objectFit: "contain",
        },
      }),
    );
  }

  if (claim) {
    children.push(
      el(
        "div",
        {
          style: {
            position: "absolute",
            top: layout.claimTopPx,
            left: layout.safeZonePx,
            width: width - layout.safeZonePx * 2,
            display: "flex",
            fontFamily,
            fontWeight: 700,
            fontSize: layout.claimFontSizePx,
            lineHeight: 1.1,
            color: "#111111",
            textShadow: "0 1px 3px rgba(255,255,255,0.6)",
          },
        },
        claim,
      ),
    );
  }

  if (subclaim) {
    children.push(
      el(
        "div",
        {
          style: {
            position: "absolute",
            top: layout.subclaimTopPx,
            left: layout.safeZonePx,
            width: width - layout.safeZonePx * 2,
            display: "flex",
            fontFamily,
            fontWeight: 400,
            fontSize: layout.subclaimFontSizePx,
            color: "#333333",
          },
        },
        subclaim,
      ),
    );
  }

  if (cta) {
    children.push(
      el(
        "div",
        {
          style: {
            position: "absolute",
            bottom: layout.safeZonePx,
            right: layout.safeZonePx,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: layout.ctaHeightPx,
            paddingLeft: layout.ctaPaddingHorizontalPx,
            paddingRight: layout.ctaPaddingHorizontalPx,
            backgroundColor: "#000000",
            color: "#FFFFFF",
            fontFamily,
            fontWeight: 700,
            fontSize: layout.ctaFontSizePx,
            borderRadius: 4,
            whiteSpace: "nowrap",
          },
        },
        cta,
      ),
    );
  }

  if (disclaimer) {
    children.push(
      el(
        "div",
        {
          style: {
            position: "absolute",
            bottom: layout.safeZonePx,
            left: layout.safeZonePx,
            maxWidth: "55%",
            display: "flex",
            fontFamily,
            fontWeight: 400,
            fontSize: layout.disclaimerFontSizePx,
            color: "#555555",
          },
        },
        disclaimer,
      ),
    );
  }

  return el(
    "div",
    {
      style: { position: "relative", display: "flex", width, height, backgroundColor },
    },
    children,
  );
}

async function renderBannerToPngBuffer(elements: BannerElements): Promise<Buffer> {
  const tree = buildBannerTree(elements);

  const svg = await satori(tree, {
    width: elements.width,
    height: elements.height,
    fonts: [
      { name: elements.fontFamily, data: Buffer.from(elements.fontBase64, "base64"), weight: 400, style: "normal" },
      {
        name: elements.fontFamily,
        data: Buffer.from(elements.fontBoldBase64 ?? elements.fontBase64, "base64"),
        weight: 700,
        style: "normal",
      },
    ],
  });

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: elements.width },
    background: elements.backgroundColor,
  });

  return resvg.render().asPng();
}

/** PNG del banner — usado por `render-master.ts` (además del JPG) por compatibilidad con `adstudio_masters.png_path`. */
export async function renderBannerToPng(elements: BannerElements): Promise<Buffer> {
  return renderBannerToPngBuffer(elements);
}

export async function renderBannerToJpg(elements: BannerElements): Promise<Buffer> {
  const png = await renderBannerToPngBuffer(elements);
  return sharp(png).jpeg({ quality: JPG_QUALITY }).toBuffer();
}
