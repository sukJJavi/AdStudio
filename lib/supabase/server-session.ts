import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * Client bound to the current user's session cookies. Respects RLS.
 * Use in Server Components, Server Actions and Route Handlers.
 *
 * `setAll` can throw when called from a Server Component (cookies are
 * read-only there) — safe to ignore because the middleware refreshes
 * the session cookie on every request.
 */
export async function createSessionSupabaseClient() {
  const cookieStore = await cookies();

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Ignored in Server Component context.
        }
      },
    },
  });
}
