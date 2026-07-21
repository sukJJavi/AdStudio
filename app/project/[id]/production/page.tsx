import { getProductionStatus } from "@/lib/production";
import { getProject } from "@/lib/projects";
import { ProductionView } from "@/components/project/production-view";

export default async function ProductionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [project, status] = await Promise.all([getProject(id), getProductionStatus(id)]);

  return (
    <ProductionView
      projectId={id}
      initialStatus={
        status ?? { projectStatus: project.status, step: null, current: null, total: null, progress: null, formats: [] }
      }
    />
  );
}
