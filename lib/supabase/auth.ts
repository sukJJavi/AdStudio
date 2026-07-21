import { createSessionSupabaseClient } from "@/lib/supabase/server-session";

export async function getAuthenticatedUserId(): Promise<string | null> {
  try {
    const supabase = await createSessionSupabaseClient();
    const { data } = await supabase.auth.getUser();
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}

export type AuthenticatedUser = { id: string; email: string };

export async function getAuthenticatedUser(): Promise<AuthenticatedUser | null> {
  try {
    const supabase = await createSessionSupabaseClient();
    const { data } = await supabase.auth.getUser();
    if (!data.user?.id || !data.user.email) return null;
    return { id: data.user.id, email: data.user.email };
  } catch {
    return null;
  }
}
