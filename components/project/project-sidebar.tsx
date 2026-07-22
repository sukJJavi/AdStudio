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
  { key: "layers", label: "Capas", href: (id) => `/project/${id}/layers` },
  { key: "master", label: "Master", href: (id) => `/project/${id}/master` },
  { key: "production", label: "Production", href: (id) => `/project/${id}/production` },
  { key: "delivery", label: "Delivery", href: (id) => `/project/${id}/delivery` },
];

export function ProjectSidebar({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const activeIndex = PHASES.findIndex((phase) => pathname?.startsWith(phase.href(projectId)));

  return (
    <aside className="w-56 shrink-0 border-r border-[#232935] bg-[#12161F] flex flex-col">
      <div className="px-4 py-4 text-sm font-semibold tracking-tight font-display text-[#E6E9EF]">
        AdStudio
      </div>
      <nav className="flex flex-col gap-1 px-2">
        {PHASES.map((phase, index) => {
          const href = phase.href(projectId);
          const isActive = index === activeIndex;
          const isCompleted = activeIndex !== -1 && index < activeIndex;
          return (
            <Link
              key={phase.key}
              href={href}
              className={cn(
                "flex items-center gap-2 rounded-md border-l-2 border-transparent px-3 py-2 text-sm transition-colors",
                isActive
                  ? "border-[#2E80FF] text-[#2E80FF]"
                  : isCompleted
                    ? "text-[#34C759] hover:bg-[#171C27]"
                    : "text-[#5D6675] hover:bg-[#171C27] hover:text-[#E6E9EF]",
              )}
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-full border border-current text-[11px] font-mono text-[#5D6675]">
                {isCompleted ? "✓" : index + 1}
              </span>
              {phase.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto px-4 py-4 text-xs text-[#5D6675]">
        <Link href="/dashboard" className="hover:text-[#E6E9EF]">
          ← Volver a proyectos
        </Link>
      </div>
    </aside>
  );
}
