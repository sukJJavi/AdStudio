import Link from "next/link";
import { createSessionSupabaseClient } from "@/lib/supabase/server-session";
import { STATUS_LABELS, STATUS_ROUTE, TIER_LABELS, type Project, type ProjectStatus } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { LogoutButton } from "@/components/auth/logout-button";
import { createBlankProject } from "./actions";

/** Colores semánticos del design system para el badge de status del proyecto. */
const READY_STATUSES = new Set<ProjectStatus>(["master_ready", "approved", "delivery", "delivery_ready"]);
const IN_PROGRESS_STATUSES = new Set<ProjectStatus>(["analyzing", "master_generating", "producing"]);

function statusBadgeClasses(status: ProjectStatus): string {
  if (READY_STATUSES.has(status)) {
    return "bg-[rgba(52,199,89,0.12)] border-[rgba(52,199,89,0.40)] text-[#7BE096]";
  }
  if (IN_PROGRESS_STATUSES.has(status)) {
    return "bg-[rgba(245,165,36,0.12)] border-[rgba(245,165,36,0.40)] text-[#F5C46B]";
  }
  return "bg-[#171C27] border-[#232935] text-[#9AA3B2]";
}

export default async function DashboardPage() {
  const supabase = await createSessionSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: projects } = await supabase
    .from("adstudio_projects")
    .select("*")
    .eq("user_id", user?.id ?? "")
    .order("created_at", { ascending: false });

  const projectList = (projects ?? []) as Project[];

  return (
    <div className="min-h-screen bg-[#0A0D14]">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-10">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-mono text-[#5D6675]">AdStudio</p>
            <h1 className="font-display text-xl font-semibold tracking-tight text-[#E6E9EF]">
              Tus proyectos
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <form action={createBlankProject}>
              <Button type="submit">+ Nuevo proyecto</Button>
            </form>
            <LogoutButton />
          </div>
        </div>

        {projectList.length === 0 ? (
          <Card className="border-[#232935] bg-[#12161F]">
            <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
              <p className="text-sm text-[#9AA3B2]">
                Todavía no tienes proyectos. Crea el primero para empezar el brief.
              </p>
              <form action={createBlankProject}>
                <Button type="submit">+ Nuevo proyecto</Button>
              </form>
            </CardContent>
          </Card>
        ) : (
          <div className="flex flex-col gap-3">
            {projectList.map((project) => (
              <Link key={project.id} href={`/project/${project.id}/${STATUS_ROUTE[project.status]}`}>
                <Card className="border-[#232935] bg-[#12161F] transition-colors hover:bg-[#171C27]">
                  <CardContent className="flex items-center justify-between py-4">
                    <div>
                      <p className="font-display font-medium text-[#E6E9EF]">
                        {project.cliente || "Proyecto sin nombre"}
                      </p>
                      {project.producto && (
                        <p className="text-sm text-[#9AA3B2]">{project.producto}</p>
                      )}
                      <p className="font-mono text-xs text-[#5D6675]">
                        {new Date(project.created_at).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className={cn("text-xs", statusBadgeClasses(project.status))}>
                        {STATUS_LABELS[project.status]}
                      </Badge>
                      <Badge variant="secondary" className="bg-[#171C27] text-xs text-[#9AA3B2]">
                        {TIER_LABELS[project.tier]}
                      </Badge>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
