import { Resend } from "resend";

/**
 * Remitente de los emails transaccionales. Toma `RESEND_FROM_EMAIL` si está
 * configurada (requiere un dominio verificado en Resend); si no, cae al
 * remitente de pruebas de Resend, funcional sin verificar dominio propio —
 * útil en desarrollo pero no pensado para producción.
 */
export const EMAIL_FROM = process.env.RESEND_FROM_EMAIL?.trim() || "AdStudio <onboarding@resend.dev>";

export function createEmailClient(): Resend {
  return new Resend(process.env.RESEND_API_KEY);
}
