import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

/**
 * Cliente Supabase para los jobs de Trigger.dev (`trigger/*.ts`). Service-role,
 * sin sesión de usuario — un job de background no tiene contexto de cookies de
 * Next.js, así que nunca debe usar `lib/supabase/server-session.ts`.
 *
 * Separado de `lib/supabase/server.ts` (usado por rutas de API/lib de negocio)
 * para que quede explícito en el import qué código corre en un job vs. en una
 * request de Next.js, aunque ambos construyen el cliente de la misma forma.
 */
export function createTriggerSupabaseClient() {
  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });
}
