"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

type Phase = {
  key: string;
  label: string;
  href: (id: string) => string;
};

const PHASES: Phase[] = [
  { key: "brief", label: "Brief", href: (id) => `/project/${id}/brief` },
  { key: "upload", label: "Upload", href: (id) => `/project/${id}/upload` },
  { key: "analysis", label: "Analysis", href: (id) => `/project/${id}/analysis` },
  { key: "master", label: "Master", href: (id) => `/project/${id}/master` },
  { key: "production", label: "Production", href: (id) => `/project/${id}/production` },
  { key: "delivery", label: "Delivery", href: (id) => `/project/${id}/delivery` },
];

export function ProjectSidebar({ projectId }: { projectId: string }) {
  const pathname = usePathname();

  return (
    <aside className="w-56 shrink-0 border-r border-border bg-muted/30 flex flex-col">
      <div className="px-4 py-4 text-sm font-semibold tracking-tight">AdStudio</div>
      <nav className="flex flex-col gap-1 px-2">
        {PHASES.map((phase, index) => {
          const href = phase.href(projectId);
          const isActive = pathname?.startsWith(href);
          return (
            <Link
              key={phase.key}
              href={href}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-full border text-[11px] font-medium">
                {index + 1}
              </span>
              {phase.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto px-4 py-4 text-xs text-muted-foreground">
        <Link href="/dashboard" className="hover:text-foreground">
          ← Volver a proyectos
        </Link>
      </div>
    </aside>
  );
}
