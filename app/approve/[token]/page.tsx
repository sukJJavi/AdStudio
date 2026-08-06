import { getApprovalContext, type ApprovalMasterEntry } from "@/lib/approval";
import { ApprovalActions } from "@/components/approve/approval-actions";

const MAX_PREVIEW_WIDTH = 400;

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/** Mismo patrón de escalado que components/project/delivery-view.tsx — tope MAX_PREVIEW_WIDTH manteniendo proporción. */
function scaledDimensions(width: number, height: number): { width: number; height: number; scale: number } {
  const scale = Math.min(1, MAX_PREVIEW_WIDTH / width);
  return { width: Math.round(width * scale), height: Math.round(height * scale), scale };
}

/** Tarjeta de un master en la aprobación pública — todos se muestran igual (Bloque 15: uno por PSD subido). */
function MasterCard({
  projectId,
  master,
  token,
}: {
  projectId: string;
  master: ApprovalMasterEntry;
  token: string;
}) {
  const { width: boxWidth, height: boxHeight, scale } = scaledDimensions(master.width, master.height);
  const previewPath = master.isPrimary
    ? `/api/preview/${projectId}`
    : `/api/preview/${projectId}/master/${master.sourcePsdId}`;
  // El preview es una ruta autorizada por sesión propietaria O token de aprobación (ver
  // lib/preview-auth.ts) — aquí no hay sesión, así que el token viaja en la query y el
  // propio handler lo reenvía a los assets referenciados dentro del HTML5.
  const previewUrl = `${previewPath}?token=${encodeURIComponent(token)}`;

  return (
    <div className="space-y-2">
      {master.hasHtml5 ? (
        <div
          className="relative overflow-hidden rounded-md border border-border bg-white"
          style={{ width: boxWidth, height: boxHeight }}
        >
          <iframe
            src={previewUrl}
            title={`Preview del master (${master.width}x${master.height})`}
            style={{
              width: master.width,
              height: master.height,
              border: 0,
              transform: `scale(${scale})`,
              transformOrigin: "0 0",
            }}
          />
        </div>
      ) : (
        master.jpgUrl && (
          <div className="overflow-hidden rounded-md border border-border">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={master.jpgUrl} alt="Master" className="block w-full" />
          </div>
        )
      )}
      <p className="text-xs text-muted-foreground">
        {master.width}×{master.height}px
      </p>
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
    <div className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-6 py-10">
      <div>
        <p className="text-xs text-muted-foreground">Aprobación de master</p>
        <h1 className="text-xl font-semibold">
          {context.cliente}
          {context.producto ? ` · ${context.producto}` : ""}
        </h1>
      </div>

      {context.masters.length === 0 ? (
        <p className="text-sm text-muted-foreground">Todavía no hay ningún master generado.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {context.masters.map((master, i) => (
            <MasterCard key={master.sourcePsdId ?? i} projectId={context.projectId} master={master} token={token} />
          ))}
        </div>
      )}

      {context.state === "approved" ? (
        <p className="text-sm text-green-600">Masters aprobados. El equipo comenzará las adaptaciones.</p>
      ) : (
        <ApprovalActions token={token} />
      )}
    </div>
  );
}
