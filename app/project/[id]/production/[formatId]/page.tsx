import { notFound } from "next/navigation";
import { createSessionSupabaseClient } from "@/lib/supabase/server-session";
import { getAdaptationChanges, getAdaptationDraft } from "@/lib/adaptation-refine";
import { AdaptationReviewView } from "@/components/project/adaptation-review-view";

export default async function ProductionFormatPage({
  params,
}: {
  params: Promise<{ id: string; formatId: string }>;
}) {
  const { id, formatId } = await params;

  const supabase = await createSessionSupabaseClient();

  // RLS filtra por adstudio_projects.user_id — un formato de otro usuario o
  // inexistente simplemente no aparece, igual que el resto de páginas del
  // proyecto (ver lib/projects.ts:getProject).
  const { data: format } = await supabase
    .from("adstudio_formats")
    .select("nombre_soporte")
    .eq("id", formatId)
    .eq("project_id", id)
    .single();

  if (!format) notFound();

  const [draft, changes] = await Promise.all([
    getAdaptationDraft(id, formatId, supabase),
    getAdaptationChanges(id, formatId, supabase),
  ]);

  if (!draft) notFound();

  return (
    <AdaptationReviewView
      projectId={id}
      formatId={formatId}
      nombreSoporte={format.nombre_soporte}
      width={draft.width}
      height={draft.height}
      initialChanges={changes}
    />
  );
}
