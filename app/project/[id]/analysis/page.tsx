import { getProject } from "@/lib/projects";
import { getProjectFormats } from "@/lib/formats";
import { summarizeFormatStatuses, toAnalysisFormatStatus } from "@/lib/iab/incident-analyzer";
import type { AnalysisStatusResponse } from "@/lib/iab/incident-analyzer";
import { AnalysisView } from "@/components/project/analysis-view";

export default async function AnalysisPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [project, formats] = await Promise.all([getProject(id), getProjectFormats(id)]);

  const formatStatuses = formats.map(toAnalysisFormatStatus);

  const initialData: AnalysisStatusResponse = {
    projectStatus: project.status,
    formats: formatStatuses,
    summary: summarizeFormatStatuses(formatStatuses),
  };

  return <AnalysisView projectId={id} initialData={initialData} />;
}
