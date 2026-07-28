import { Badge } from "@/components/ui/badge";
import { LogoutButton } from "@/components/auth/logout-button";
import { TIER_LABELS, type Tier } from "@/lib/types";
import type { ApprovalStatus } from "@/lib/approval-status";

const APPROVAL_INDICATOR: Record<Exclude<ApprovalStatus["state"], "none">, string> = {
  pending: "🟡 Esperando aprobación",
  approved: "🟢 Aprobado por cliente",
  changes_requested: "🔴 Cambios solicitados",
};

export function ProjectHeader({
  cliente,
  producto,
  tier,
  approval,
}: {
  cliente: string;
  producto: string | null;
  tier: Tier;
  /** Estado del enlace de aprobación más reciente — sin indicador si todavía no se generó ninguno. */
  approval?: ApprovalStatus;
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
        {approval && approval.state !== "none" && (
          <span className="text-xs font-medium text-muted-foreground">
            {APPROVAL_INDICATOR[approval.state]}
          </span>
        )}
        <Badge variant="secondary" className="text-xs font-medium">
          Plan {TIER_LABELS[tier]}
        </Badge>
        <LogoutButton />
      </div>
    </header>
  );
}
