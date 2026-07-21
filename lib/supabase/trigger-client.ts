import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

/**
 * Cliente Supabase para los jobs de Trigger.dev (`trigger/*.ts`). Service-role,
 * sin sesión de usuario — un job de background no tiene contexto de cookies de
 * Next.js, así que nunca debe usar `lib/supabase/server-session.ts`.
 *
 * `SupabaseClient` inicializa su `RealtimeClient` en el constructor aunque no
 * se use, y este resuelve un WebSocket global si no se le da uno explícito —
 * Node 18 (el runtime de Trigger.dev) no tiene `WebSocket` nativo, así que sin
 * esto la construcción del cliente falla. `realtime.transport` es el campo
 * documentado de `RealtimeClientOptions` para inyectar una implementación
 * (nativa, `ws`, etc.) sin tocar globals ni necesitar `@ts-ignore`.
 *
 * Separado de `lib/supabase/server.ts` (usado por rutas de API/lib de negocio,
 * que sí corren en un runtime con `WebSocket` nativo) para que quede explícito
 * en el import qué código corre en un job vs. en una request de Next.js.
 */
// `ws`'s constructor type has an overload (raw-socket mode, `address: null`)
// that TypeScript's structural check rejects against realtime-js's single-signature
// `WebSocketLikeConstructor`, even though `ws` satisfies it at runtime in the
// `new WebSocket(url)` shape actually used. Cast through the ambient DOM
// `WebSocket` type (what `WebSocketLikeConstructor` structurally mirrors)
// instead of `any`/`@ts-ignore`, so the cast stays scoped to this known mismatch.
const NodeWebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

export function createTriggerSupabaseClient() {
  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false },
    realtime: { transport: NodeWebSocket },
  });
}
