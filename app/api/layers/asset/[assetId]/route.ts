import { NextRequest, NextResponse } from "next/server";
import { createSessionSupabaseClient } from "@/lib/supabase/server-session";
import { requireProjectOwnership } from "@/lib/authorization";
import { LAYER_PATCHABLE_FIELDS, type LayerPatchableField } from "@/lib/layers";
import { baseFilenameFor } from "@/lib/psd/filename";
import type { ProjectAsset, TextLayerMetadata } from "@/lib/types";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Si `filename` es exactamente `${expectedBase}.png` o `${expectedBase}_{N}.png`
 * (índice de desambiguación de trigger/analyze-psd.ts#uniqueFilename), devuelve
 * ese índice ("" si no hay). `null` si el filename no coincide con ese base —
 * en ese caso no se toca (p. ej. el usuario ya lo renombró a mano, o es un
 * "desconocido" cuyo nombre viene del layer_name original, no de classification).
 */
function matchingDisambiguationSuffix(filename: string, expectedBase: string): string | null {
  const withoutExt = filename.replace(/\.png$/i, "");
  if (withoutExt === expectedBase) return "";
  const match = withoutExt.match(new RegExp(`^${escapeRegExp(expectedBase)}_(\\d+)$`));
  return match ? match[1] : null;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ assetId: string }> },
) {
  const { assetId } = await params;
  const body = (await req.json()) as Partial<Record<LayerPatchableField, unknown>>;

  const supabase = await createSessionSupabaseClient();

  const { data: asset } = await supabase
    .from("adstudio_assets")
    .select("*")
    .eq("id", assetId)
    .single();

  if (!asset) {
    return NextResponse.json({ error: "Capa no encontrada" }, { status: 404 });
  }

  const currentAsset = asset as ProjectAsset;

  const auth = await requireProjectOwnership(currentAsset.project_id);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const update: Partial<Record<LayerPatchableField, unknown>> & { metadata?: TextLayerMetadata; file_path?: string } = {};
  for (const field of LAYER_PATCHABLE_FIELDS) {
    if (field in body) update[field] = body[field];
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "No hay campos válidos para actualizar" }, { status: 400 });
  }

  // `frames` es el campo autoritativo; `frame` se mantiene sincronizado como
  // frames[0] ?? null por compatibilidad retroactiva (ver lib/types.ts).
  if ("frames" in update) {
    const frames = (update.frames as number[] | null) ?? null;
    update.frame = frames && frames.length > 0 ? frames[0] : null;
    if (frames && frames.length > 0) update.persistent = false;
  }

  // "Persistente" implica frame(s)=null (mutuamente excluyentes).
  if (update.persistent === true) {
    update.frame = null;
    update.frames = null;
  }

  // Si cambia classification y el filename actual en Storage codifica la
  // clasificación anterior (naming de trigger/analyze-psd.ts#baseFilenameFor:
  // `f{N}_{classification}.png`, `{classification}.png`, o el nombre reservado
  // de persistentes), renombrar el archivo para que siga reflejando el rol real
  // de la capa — Claude Vision y el ZIP de entrega lo interpretan por nombre.
  if (typeof update.classification === "string" && update.classification !== currentAsset.classification) {
    const newClassification = update.classification;
    const oldClassification = currentAsset.classification ?? "";
    const currentFilename = (currentAsset.metadata as TextLayerMetadata | undefined)?.filename ?? null;

    if (currentFilename) {
      const oldFrame = currentAsset.frames?.[0] ?? currentAsset.frame ?? null;
      const oldBase = baseFilenameFor({
        classification: oldClassification,
        frame: oldFrame,
        persistent: !!currentAsset.persistent,
        layerName: currentAsset.layer_name ?? "capa",
      });

      const suffix = matchingDisambiguationSuffix(currentFilename, oldBase);

      if (suffix !== null) {
        // frame/persistent no vienen necesariamente en este PATCH (puede ser
        // solo un cambio de classification) — se usan los del PATCH si están
        // presentes, si no los del asset actual.
        const newPersistent = "persistent" in update ? !!update.persistent : !!currentAsset.persistent;
        const newFrame = "frames" in update ? ((update.frames as number[] | null)?.[0] ?? null) : oldFrame;

        const newBase = baseFilenameFor({
          classification: newClassification,
          frame: newPersistent ? null : newFrame,
          persistent: newPersistent,
          layerName: currentAsset.layer_name ?? "capa",
        });

        const newFilename = suffix ? `${newBase}_${suffix}.png` : `${newBase}.png`;

        if (newFilename !== currentFilename) {
          // Namespaced por source_psd_id (ver trigger/analyze-psd.ts): dos PSDs
          // distintos pueden generar el mismo filename sin ser el mismo archivo.
          const layersFolder = `${currentAsset.project_id}/layers/${currentAsset.source_psd_id}`;
          const oldPath = `${layersFolder}/${currentFilename}`;
          const newPath = `${layersFolder}/${newFilename}`;

          // Dos assets del mismo PSD pueden llegar al mismo newFilename (p. ej.
          // dos capas "imagen_principal" se reclasifican a "logo" por separado)
          // — copy() sobre un path ya ocupado falla con "The resource already
          // exists". Se comprueba antes y, si ya existe, se deja el archivo/nombre
          // tal cual y solo se actualiza classification en la BD.
          const { data: existing } = await supabase.storage
            .from("adstudio-projects")
            .list(layersFolder, { search: newFilename });

          if (existing && existing.length > 0) {
            console.log("Target filename already exists, skipping rename:", newFilename);
          } else {
            const { error: copyError } = await supabase.storage
              .from("adstudio-projects")
              .copy(oldPath, newPath);

            if (copyError) {
              console.error("Error interno:", copyError);
              return NextResponse.json(
                { error: "No se pudo renombrar el archivo en Storage." },
                { status: 500 },
              );
            }

            await supabase.storage.from("adstudio-projects").remove([oldPath]);

            update.metadata = { ...(currentAsset.metadata as TextLayerMetadata), filename: newFilename };
            update.file_path = newPath;
          }
        }

      }
    }
  }

  const { data: updated, error } = await supabase
    .from("adstudio_assets")
    .update(update)
    .eq("id", assetId)
    .select()
    .single();

  if (error || !updated) {
    console.error("Error interno:", error);
    return NextResponse.json({ error: "No se pudo actualizar la capa." }, { status: 400 });
  }

  return NextResponse.json({ layer: updated });
}
