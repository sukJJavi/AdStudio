import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createSessionSupabaseClient } from "@/lib/supabase/server-session";
import { getAuthenticatedUser } from "@/lib/supabase/auth";
import { getMasterStatus } from "@/lib/master";
import { sendChangesRequestedEmail, sendMasterReadyEmail } from "@/lib/email/master-notifications";

const APPROVAL_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MASTER_PREVIEW_SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7;

/**
 * Genera el link público de aprobación y envía el email al usuario autenticado
 * (no hay campo de email del cliente final en el esquema; ver CLAUDE.md).
 * Requiere sesión — la propiedad del proyecto la garantiza RLS vía el cliente de sesión.
 *
 * @param requestOrigin Origen de la request (`req.nextUrl.origin`), usado como fallback
 *   cuando no hay `NEXT_PUBLIC_APP_URL` configurada (p. ej. en local).
 */
export async function createApprovalLink(
  projectId: string,
  requestOrigin: string,
): Promise<{ ok: true; token: string; url: string } | { ok: false; error: string }> {
  const origin = process.env.NEXT_PUBLIC_APP_URL?.trim() || requestOrigin;
  const supabase = await createSessionSupabaseClient();

  const { data: project, error: projectError } = await supabase
    .from("adstudio_projects")
    .select("cliente, producto")
    .eq("id", projectId)
    .single();

  if (projectError || !project) {
    return { ok: false, error: "Proyecto no encontrado." };
  }

  const { data: masterRow } = await supabase
    .from("adstudio_masters")
    .select("id")
    .eq("project_id", projectId)
    .limit(1)
    .maybeSingle();

  if (!masterRow) {
    return { ok: false, error: "Todavía no hay un master generado para este proyecto." };
  }

  const expiresAt = new Date(Date.now() + APPROVAL_TOKEN_TTL_MS).toISOString();

  const { data: tokenRow, error: tokenError } = await supabase
    .from("adstudio_approval_tokens")
    .insert({ project_id: projectId, expires_at: expiresAt })
    .select()
    .single();

  if (tokenError || !tokenRow) {
    return { ok: false, error: tokenError?.message ?? "No se pudo generar el link de aprobación." };
  }

  const url = `${origin}/approve/${tokenRow.token}`;

  const user = await getAuthenticatedUser();
  if (user) {
    const masterStatus = await getMasterStatus(projectId);
    const primary = masterStatus?.masters.find((m) => m.isPrimary) ?? masterStatus?.masters[0];

    await sendMasterReadyEmail({
      to: user.email,
      cliente: project.cliente,
      producto: project.producto,
      approveUrl: url,
      masterPreviewUrl: primary?.jpgUrl ?? url,
    });
  }

  return { ok: true, token: tokenRow.token as string, url };
}

export type ApprovalContext =
  | { state: "not_found" }
  | { state: "expired" }
  | {
      state: "approved" | "pending";
      projectId: string;
      cliente: string;
      producto: string | null;
      masterJpgUrl: string | null;
      /** true si `adstudio_projects.master_html` tiene contenido — el iframe lo sirve vía `/api/preview/[projectId]`. */
      hasHtml5: boolean;
      width: number | null;
      height: number | null;
    };

/** Lectura pública (sin sesión) del estado de un token de aprobación. Usa service-role. */
export async function getApprovalContext(token: string): Promise<ApprovalContext> {
  const supabase = createServerSupabaseClient();

  const { data: tokenRow, error: tokenError } = await supabase
    .from("adstudio_approval_tokens")
    .select("*")
    .eq("token", token)
    .single();

  if (tokenError || !tokenRow) return { state: "not_found" };

  if (tokenRow.expires_at && new Date(tokenRow.expires_at).getTime() < Date.now()) {
    return { state: "expired" };
  }

  const { data: project, error: projectError } = await supabase
    .from("adstudio_projects")
    .select("cliente, producto, master_html")
    .eq("id", tokenRow.project_id)
    .single();

  if (projectError || !project) return { state: "not_found" };

  const { data: masterRow } = await supabase
    .from("adstudio_masters")
    .select("jpg_path, width, height")
    .eq("project_id", tokenRow.project_id)
    .eq("is_primary", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let masterJpgUrl: string | null = null;
  if (masterRow?.jpg_path) {
    const { data: signed } = await supabase.storage
      .from("adstudio-projects")
      .createSignedUrl(masterRow.jpg_path, MASTER_PREVIEW_SIGNED_URL_TTL_SECONDS);
    masterJpgUrl = signed?.signedUrl ?? null;
  }

  return {
    state: tokenRow.approved_at ? "approved" : "pending",
    projectId: tokenRow.project_id as string,
    cliente: project.cliente,
    producto: project.producto,
    masterJpgUrl,
    hasHtml5: !!project.master_html,
    width: masterRow?.width ?? null,
    height: masterRow?.height ?? null,
  };
}

async function resolveValidToken(token: string) {
  const supabase = createServerSupabaseClient();

  const { data: tokenRow, error } = await supabase
    .from("adstudio_approval_tokens")
    .select("*")
    .eq("token", token)
    .single();

  if (error || !tokenRow) return { ok: false as const, error: "Token no válido." };
  if (tokenRow.expires_at && new Date(tokenRow.expires_at).getTime() < Date.now()) {
    return { ok: false as const, error: "El link de aprobación ha expirado." };
  }

  return { ok: true as const, supabase, tokenRow };
}

export async function approveMaster(token: string): Promise<{ ok: boolean; error?: string }> {
  const resolved = await resolveValidToken(token);
  if (!resolved.ok) return resolved;

  const { supabase, tokenRow } = resolved;

  await supabase
    .from("adstudio_approval_tokens")
    .update({ approved_at: new Date().toISOString() })
    .eq("id", tokenRow.id);

  await supabase.from("adstudio_projects").update({ status: "approved" }).eq("id", tokenRow.project_id);

  return { ok: true };
}

export async function requestMasterChanges(
  token: string,
  comments: string,
): Promise<{ ok: boolean; error?: string }> {
  const resolved = await resolveValidToken(token);
  if (!resolved.ok) return resolved;

  const { supabase, tokenRow } = resolved;

  const { data: project, error: projectError } = await supabase
    .from("adstudio_projects")
    .select("id, user_id, cliente, producto")
    .eq("id", tokenRow.project_id)
    .single();

  if (projectError || !project) {
    return { ok: false, error: "Proyecto no encontrado." };
  }

  await supabase.from("adstudio_projects").update({ notes: comments }).eq("id", project.id);

  const { data: userData } = await supabase.auth.admin.getUserById(project.user_id);
  const email = userData?.user?.email;

  if (email) {
    await sendChangesRequestedEmail({
      to: email,
      cliente: project.cliente,
      producto: project.producto,
      comments,
    });
  }

  return { ok: true };
}
