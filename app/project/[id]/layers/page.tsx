import { getProjectLayers } from "@/lib/layers";
import { getProjectFormats } from "@/lib/formats";
import { getProjectAssets } from "@/lib/assets";
import { getIABFormatById } from "@/lib/iab/specs";
import { LayersEditor } from "@/components/project/layers-editor";

export default async function LayersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [layers, formats, assets] = await Promise.all([
    getProjectLayers(id),
    getProjectFormats(id),
    getProjectAssets(id),
  ]);

  const largestFormat = formats.reduce<{ ancho: number; alto: number } | null>((max, f) => {
    const spec = getIABFormatById(f.iab_format);
    if (!spec) return max;
    if (!max || spec.ancho * spec.alto > max.ancho * max.alto) return spec;
    return max;
  }, null) ?? { ancho: 300, alto: 250 };

  const psdAssets = assets.filter((a) => a.layer_type === "psd");

  return (
    <LayersEditor
      projectId={id}
      initialLayers={layers}
      canvasWidth={largestFormat.ancho}
      canvasHeight={largestFormat.alto}
      psdAssets={psdAssets}
      formats={formats}
    />
  );
}
