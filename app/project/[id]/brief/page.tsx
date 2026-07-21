import { BriefForm } from "@/components/project/brief-form";
import { getProject } from "@/lib/projects";
import { getProjectFormats } from "@/lib/formats";

export default async function BriefPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [project, formats] = await Promise.all([getProject(id), getProjectFormats(id)]);

  return (
    <div className="mx-auto max-w-4xl">
      <BriefForm project={project} formats={formats} />
    </div>
  );
}
