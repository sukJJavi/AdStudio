import { getApprovalContext } from "@/lib/approval";
import { ApprovalActions } from "@/components/approve/approval-actions";

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

export default async function ApprovePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const context = await getApprovalContext(token);

  if (context.state === "not_found") {
    return <CenteredMessage>Este link de aprobación no existe.</CenteredMessage>;
  }
  if (context.state === "expired") {
    return <CenteredMessage>Este link de aprobación ha expirado. Pide a la agencia que te envíe uno nuevo.</CenteredMessage>;
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-6 py-10">
      <div>
        <p className="text-xs text-muted-foreground">Aprobación de master</p>
        <h1 className="text-xl font-semibold">
          {context.cliente}
          {context.producto ? ` · ${context.producto}` : ""}
        </h1>
      </div>

      {context.masterJpgUrl && (
        <div className="overflow-auto rounded-lg border border-border">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={context.masterJpgUrl} alt="Master" className="block w-full" />
        </div>
      )}

      {context.state === "approved" ? (
        <p className="text-sm text-green-600">Master aprobado. El equipo comenzará las adaptaciones.</p>
      ) : (
        <ApprovalActions token={token} />
      )}
    </div>
  );
}
