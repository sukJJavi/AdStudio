import { Badge } from "@/components/ui/badge";
import { LogoutButton } from "@/components/auth/logout-button";
import { TIER_LABELS, type Tier } from "@/lib/types";

export function ProjectHeader({
  cliente,
  producto,
  tier,
}: {
  cliente: string;
  producto: string | null;
  tier: Tier;
}) {
  return (
    <header className="flex items-center justify-between border-b border-border px-6 py-4">
      <div>
        <p className="text-xs text-muted-foreground">Proyecto</p>
        <h1 className="text-lg font-semibold leading-tight">
          {cliente}
          {producto ? ` · ${producto}` : ""}
        </h1>
      </div>
      <div className="flex items-center gap-3">
        <Badge variant="secondary" className="text-xs font-medium">
          Plan {TIER_LABELS[tier]}
        </Badge>
        <LogoutButton />
      </div>
    </header>
  );
}
