import { BriefForm } from "@/components/project/brief-form";
import { getProject } from "@/lib/projects";
import { getProjectFormats } from "@/lib/formats";
import { getProjectAssets } from "@/lib/assets";

export default async function BriefPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [project, formats, assets] = await Promise.all([
    getProject(id),
    getProjectFormats(id),
    getProjectAssets(id),
  ]);

  const excelAsset = assets.find((a) => a.layer_type === "excel") ?? null;

  return (
    <div className="mx-auto max-w-4xl">
      <BriefForm project={project} formats={formats} excelAsset={excelAsset} />
    </div>
  );
}
