import { getProject } from "@/lib/projects";
import { getProjectFormats } from "@/lib/formats";
import { getProjectAssets } from "@/lib/assets";
import { getMasterStatus, rankFormatsByArea } from "@/lib/master";
import { unblockedFormats } from "@/lib/iab/incident-analyzer";
import { FontSelector } from "@/components/project/font-selector";
import { MasterView } from "@/components/project/master-view";
import type { TextLayerMetadata } from "@/lib/types";

export default async function MasterPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [project, formats, assets, masterStatus] = await Promise.all([
    getProject(id),
    getProjectFormats(id),
    getProjectAssets(id),
    getMasterStatus(id),
  ]);

  const unblocked = unblockedFormats(formats);
  const rankedUnblocked = rankFormatsByArea(unblocked);
  const secondLargest = rankedUnblocked[1]
    ? { iabFormat: rankedUnblocked[1].format.iab_format, nombreSoporte: rankedUnblocked[1].format.nombre_soporte }
    : null;

  const detectedFonts = Array.from(
    new Set(
      assets
        .filter((a) => a.classification === "texto")
        .map((a) => (a.metadata as TextLayerMetadata)?.fontName)
        .filter((fontName): fontName is string => !!fontName?.trim()),
    ),
  );

  const previewText = formats.find((f) => f.copy?.trim())?.copy?.split("\n")[0]?.trim() || "Tu claim aparecerá aquí";

  return (
    <div className="space-y-6">
      <FontSelector
        projectId={id}
        currentFont={project.font_primary}
        detectedFonts={detectedFonts}
        previewText={previewText}
      />

      <MasterView
        projectId={id}
        cliente={project.cliente}
        producto={project.producto}
        initialStatus={
          masterStatus ?? {
            projectStatus: project.status,
            step: null,
            progress: null,
            masters: [],
            html5Url: null,
            zipSizeBytes: null,
          }
        }
        formatsSummary={{ ready: unblocked.length, blocked: formats.length - unblocked.length }}
        hasUnblockedFormat={unblocked.length > 0}
        secondLargestFormat={secondLargest}
      />
    </div>
  );
}
