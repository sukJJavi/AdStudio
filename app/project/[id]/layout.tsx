import { ProjectSidebar } from "@/components/project/project-sidebar";
import { ProjectHeader } from "@/components/project/project-header";
import { getProject } from "@/lib/projects";
import { getApprovalStatus } from "@/lib/approval-status";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [project, approval] = await Promise.all([getProject(id), getApprovalStatus(id)]);

  return (
    <div className="flex min-h-screen bg-[#0A0D14]">
      <ProjectSidebar projectId={id} />
      <div className="flex flex-1 flex-col">
        <ProjectHeader
          cliente={project.cliente}
          producto={project.producto}
          tier={project.tier}
          approval={approval}
        />
        <main className="flex-1 bg-[#0A0D14] px-6 py-6">{children}</main>
      </div>
    </div>
  );
}
