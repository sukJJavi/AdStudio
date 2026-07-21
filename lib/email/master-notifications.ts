import { createEmailClient, EMAIL_FROM } from "@/lib/email/client";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function campaignLabel(cliente: string, producto: string | null): string {
  return producto ? `${cliente} ${producto}` : cliente;
}

export async function sendMasterReadyEmail(params: {
  to: string;
  cliente: string;
  producto: string | null;
  approveUrl: string;
  masterPreviewUrl: string;
}): Promise<{ ok: boolean; error?: string }> {
  const resend = createEmailClient();
  const subject = `Master listo para revisar — ${campaignLabel(params.cliente, params.producto)}`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;">
      <h1 style="font-size: 18px;">Master listo para revisar</h1>
      <p>El master de <strong>${escapeHtml(campaignLabel(params.cliente, params.producto))}</strong> está listo para tu revisión.</p>
      <p>
        <a href="${params.approveUrl}">
          <img src="${params.masterPreviewUrl}" alt="Preview del master" style="max-width: 100%; border: 1px solid #e5e5e5; border-radius: 8px;" />
        </a>
      </p>
      <p>
        <a href="${params.approveUrl}" style="display: inline-block; background: #000000; color: #ffffff; padding: 10px 20px; border-radius: 6px; text-decoration: none;">
          Revisar y aprobar
        </a>
      </p>
      <p style="color: #6b7280; font-size: 12px;">Si el botón no funciona, copia este enlace: ${params.approveUrl}</p>
    </div>
  `;

  const { error } = await resend.emails.send({ from: EMAIL_FROM, to: params.to, subject, html });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function sendChangesRequestedEmail(params: {
  to: string;
  cliente: string;
  producto: string | null;
  comments: string;
}): Promise<{ ok: boolean; error?: string }> {
  const resend = createEmailClient();
  const subject = `Cambios solicitados en el master — ${campaignLabel(params.cliente, params.producto)}`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;">
      <h1 style="font-size: 18px;">Se han solicitado cambios</h1>
      <p>El cliente ha pedido cambios en el master de <strong>${escapeHtml(campaignLabel(params.cliente, params.producto))}</strong>:</p>
      <blockquote style="border-left: 3px solid #000000; margin: 16px 0; padding: 4px 16px; color: #111827; white-space: pre-wrap;">${escapeHtml(params.comments)}</blockquote>
    </div>
  `;

  const { error } = await resend.emails.send({ from: EMAIL_FROM, to: params.to, subject, html });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
