# Trigger.dev en AdStudio

SDK: `@trigger.dev/sdk` v4, se importa desde `@trigger.dev/sdk/v3` (la ruta de import no cambia entre v3/v4 del paquete). Jobs viven en `/trigger/*.ts`, un archivo por task, nombrados por lo que hacen: `analyze-psd.ts`, `validate-excel.ts`, `render-master.ts`, `render-adaptations.ts`.

## Definir una task

```ts
import { task } from "@trigger.dev/sdk/v3";
import { createServerSupabaseClient } from "@/lib/supabase/server";

type MyPayload = { projectId: string };

export const myTask = task({
  id: "my-task", // kebab-case, se usa para invocar con tasks.trigger("my-task", payload)
  run: async (payload: MyPayload) => {
    const supabase = createServerSupabaseClient(); // service-role: no hay sesión de usuario en un job
    // ...
    return { projectId: payload.projectId /* resultado */ };
  },
});
```

- Siempre `createServerSupabaseClient()` (service-role) dentro de un job, nunca `createSessionSupabaseClient` — no hay cookies de sesión en el worker.
- El payload se tipa explícitamente, sin `any`.
- El `run` actualiza `status` en `adstudio_projects` (o la tabla que corresponda) al terminar, para que el frontend con polling/realtime vea el cambio.

## Reportar progreso por paso

Regla del proyecto: nunca reportar solo inicio/fin, cada paso relevante del job debe emitir progreso via `metadata.set`:

```ts
import { task, metadata } from "@trigger.dev/sdk/v3";

export const analyzePsd = task({
  id: "analyze-psd",
  run: async (payload: { projectId: string }) => {
    metadata.set("step", "descargando-psd");
    metadata.set("progress", 0);

    // ... trabajo del paso 1

    metadata.set("step", "extrayendo-capas");
    metadata.set("progress", 0.4);

    // ... trabajo del paso 2

    metadata.set("step", "clasificando-con-claude");
    metadata.set("progress", 0.7);

    // ... trabajo del paso 3

    metadata.set("step", "completado");
    metadata.set("progress", 1);
  },
});
```

Los pasos deben nombrarse igual que las fases visibles en la UI del proyecto (`/analysis`, `/master`, `/production`) para que el frontend pueda mostrar el mismo texto sin traducir códigos. El frontend lee este metadata via `runs.subscribeToRun(runId)` o el hook `useRealtimeRun` (`@trigger.dev/react-hooks`) para pintar la barra de progreso — no hacer polling manual a una tabla de progreso ad hoc.

## Invocar desde una API route

Patrón: la route no dispara el job directamente sin validar; primero valida precondiciones con el cliente de sesión o de service-role según corresponda, actualiza `status` a un valor "en curso", y luego llama `tasks.trigger`.

```ts
// lib/analysis.ts
import { tasks } from "@trigger.dev/sdk/v3";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function triggerAnalysis(projectId: string) {
  const supabase = createServerSupabaseClient();
  // 1. validar que el proyecto existe y no está ya corriendo
  // 2. validar precondiciones (ej: hay PSD y Excel subidos)
  // 3. marcar status "analyzing" en adstudio_projects
  const handle = await tasks.trigger("analyze-psd", { projectId });
  return { ok: true as const, runId: handle.id };
}
```

```ts
// app/api/analysis/route.ts
import { NextRequest, NextResponse } from "next/server";
import { triggerAnalysis } from "@/lib/analysis";

export async function POST(req: NextRequest) {
  const { projectId } = (await req.json()) as { projectId?: string };
  if (!projectId) return NextResponse.json({ error: "projectId es obligatorio" }, { status: 400 });

  const result = await triggerAnalysis(projectId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result);
}
```

La lógica de negocio (validaciones, transición de `status`, invocar el job) vive en `lib/*.ts`, no en la route — la route solo parsea el body y traduce el resultado a `NextResponse`.
