import Link from "next/link";
import { createSessionSupabaseClient } from "@/lib/supabase/server-session";
import { STATUS_LABELS, STATUS_ROUTE, TIER_LABELS, type Project } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LogoutButton } from "@/components/auth/logout-button";
import { createBlankProject } from "./actions";

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
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-10">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-muted-foreground">AdStudio</p>
          <h1 className="text-xl font-semibold tracking-tight">Tus proyectos</h1>
        </div>
        <div className="flex items-center gap-3">
          <form action={createBlankProject}>
            <Button type="submit">+ Nuevo proyecto</Button>
          </form>
          <LogoutButton />
        </div>
      </div>

      {projectList.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="text-sm text-muted-foreground">
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
              <Card className="transition-colors hover:border-primary/50">
                <CardContent className="flex items-center justify-between py-4">
                  <div>
                    <p className="font-medium">{project.cliente || "Proyecto sin nombre"}</p>
                    {project.producto && (
                      <p className="text-sm text-muted-foreground">{project.producto}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">
                      {STATUS_LABELS[project.status]}
                    </Badge>
                    <Badge variant="secondary" className="text-xs">
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
  );
}
