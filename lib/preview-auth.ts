import { NextRequest, NextResponse } from "next/server";
import { isProjectOwner } from "@/lib/authorization";
import { isValidApprovalToken } from "@/lib/approval";

/**
 * Autoriza una request a app/api/preview/** (rutas públicas sin `requireProjectOwnership`):
 * permite el acceso si hay sesión propietaria del proyecto, O si la query trae un
 * `?token=` de aprobación vigente para ese proyecto (el link enviado al cliente final en
 * /approve/[token]). Cualquier otro caso queda sin autorizar.
 */
export async function authorizePreviewRequest(req: NextRequest, projectId: string): Promise<boolean> {
  const token = req.nextUrl.searchParams.get("token");

  const [isOwner, hasValidToken] = await Promise.all([
    isProjectOwner(projectId),
    token ? isValidApprovalToken(projectId, token) : Promise.resolve(false),
  ]);

  return isOwner || hasValidToken;
}

export function previewUnauthorizedResponse(): NextResponse {
  return new NextResponse("No autorizado", { status: 403 });
}

/** Query string a reenviar (`?token=...`) hacia los assets referenciados dentro de un HTML5 de preview, para que el cliente final autorizado por token siga estándolo al pedir cada asset. Vacío si la request no traía token (p. ej. sesión propietaria). */
export function tokenQuerySuffix(req: NextRequest): string {
  const token = req.nextUrl.searchParams.get("token");
  return token ? `?token=${encodeURIComponent(token)}` : "";
}
