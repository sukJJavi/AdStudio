import { getProject } from "@/lib/projects";
import { getProjectFormats } from "@/lib/formats";
import { getProjectAssets } from "@/lib/assets";
import { getMasterChanges, getMasterStatus } from "@/lib/master";
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

  const [project, formats, assets, masterStatus, masterChanges] = await Promise.all([
    getProject(id),
    getProjectFormats(id),
    getProjectAssets(id),
    getMasterStatus(id),
    getMasterChanges(id),
  ]);

  const unblocked = unblockedFormats(formats);

  const detectedFonts = Array.from(
    new Set(
      assets
        .filter((a) => a.classification === "texto")
        .map((a) => (a.metadata as TextLayerMetadata)?.fontName)
        .filter((fontName): fontName is string => !!fontName?.trim()),
    ),
  );

  const previewText = formats.find((f) => f.copy?.trim())?.copy?.split("\n")[0]?.trim() || "Tu claim aparecerá aquí";

  // Bloque 15: cada master del grid se etiqueta con el nombre del PSD del que
  // proviene (adstudio_assets.layer_name), no con el iab_format técnico.
  const psdNamesById = Object.fromEntries(
    assets.filter((a) => a.layer_type === "psd").map((a) => [a.id, a.layer_name ?? "PSD"]),
  );

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
            hasHtml5: false,
            zipSizeBytes: null,
            approval: { state: "none" },
          }
        }
        formatsSummary={{ ready: unblocked.length, blocked: formats.length - unblocked.length }}
        hasUnblockedFormat={unblocked.length > 0}
        initialChanges={masterChanges}
        psdNamesById={psdNamesById}
      />
    </div>
  );
}
