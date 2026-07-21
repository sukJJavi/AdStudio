import { redirect } from "next/navigation";
import { getAuthenticatedUserId } from "@/lib/supabase/auth";

export default async function Home() {
  const userId = await getAuthenticatedUserId();
  redirect(userId ? "/dashboard" : "/login");
}
