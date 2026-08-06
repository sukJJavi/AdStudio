# Auditoría de seguridad — AdStudio (2026-08-06)

Alcance: `/app/api`, `/trigger`, `/app/approve`, `/app/guide/psd`, `supabase/schema.sql` + `migrations.sql`, variables de entorno, integración Stripe (no implementada aún).
Metodología: revisión de código estática (sin pentest activo). No se aplicó ningún fix — solo se documenta para priorizar.
Verificación final: `npx tsc --noEmit` sin errores (no se tocó código, así que este chequeo confirma que el estado del repo ya compilaba limpio).

**Resumen ejecutivo**: no se encontraron vulnerabilidades CRÍTICAS. El diseño de RLS, Storage policies y `requireProjectOwnership` está bien aplicado de forma consistente. Los hallazgos son de severidad ALTA→BAJA, mayormente relacionados con defensa en profundidad (rutas de preview públicas, falta de rate limiting, sanitización de nombres de fichero en rutas de preview, y exposición de mensajes de error de Supabase).

| # | Severidad | Área | Resumen |
|---|---|---|---|
| 1 | ALTA | Preview público | Rutas `/api/preview/*` sirven HTML5/assets del master sin sesión ni validación de token de aprobación — cualquiera con el `projectId` (UUID) ve la creatividad antes de aprobación |
| 2 | MEDIA | Path traversal | `filename` en rutas de preview/adaptación no se sanitiza contra `..`, `/`, `\` |
| 3 | MEDIA | Rate limiting | `master/refine` y `production/refine` llaman a Claude en cada request sin ningún guard de frecuencia |
| 4 | MEDIA | Rate limiting | `/approve/[token]` y `PUT /api/master/approve` sin rate limiting por IP (mitigado por entropía del UUID) |
| 5 | MEDIA | Trigger.dev | Los 4 jobs no revalidan que `projectId` exista/sea legítimo — dependen 100% de que la API route que dispara el job ya validó ownership |
| 6 | BAJA | Exposición de errores | Varias rutas devuelven `error.message` de Supabase/Postgres directamente al cliente |
| 7 | BAJA | Logging | `analyze-psd.ts` loguea filas completas insertadas (incluye `text_content`, copy de cliente) en logs de Trigger.dev |
| 8 | BAJA | Uploads | Validación de tipo de fichero solo por extensión, no por contenido/magic bytes |
| 9 | BAJA | Approval tokens | Token sigue siendo válido/reutilizable indefinidamente tras aprobar (dentro de la ventana de 7 días); sin invalidación tras uso |
| 10 | BAJA | Ownership | 3 rutas resuelven `project_id` con `select` antes de verificar ownership, dependiendo de que RLS esté bien configurada como única defensa |
| — | Ninguno | Stripe | Sin implementar aún — sin superficie de ataque; recordatorio de checklist para cuando se implemente |
| — | Ninguno | RLS / Storage policies | Correctamente configuradas en `schema.sql`, verificado a nivel de definición declarada en el repo |
| — | Ninguno | Env vars / service role key | Sin secretos en `NEXT_PUBLIC_*`; `SUPABASE_SERVICE_ROLE_KEY` solo server-side; `.env.local.example` sin valores reales |

---

## 1. Preview público sin autenticación ni validación de token — ALTA

**Archivos**: `app/api/preview/[projectId]/route.ts`, `.../assets/[filename]/route.ts`, `.../master/[psdId]/route.ts`, `.../adaptation/[formatId]/route.ts` y su `assets/[filename]`.

**Riesgo**: estas rutas usan el cliente service-role (`createServerSupabaseClient()`) y **no llaman a `requireProjectOwnership`** ni comprueban un token de aprobación válido. Cualquiera que conozca o adivine un `projectId` (UUID v4 — difícil de fuerza bruta, pero no es un secreto rotable/revocable: puede filtrarse en logs, URLs compartidas, capturas de pantalla, etc.) puede ver el HTML5 del master, sus imágenes y adaptaciones sin sesión ni link de aprobación válido, incluso antes de que el proyecto se comparta con el cliente.

**Fix recomendado**: exigir sesión propietaria O un token de aprobación vigente (query string) para servir estos recursos:
```ts
const session = await getSessionUser(); // opcional
const token = req.nextUrl.searchParams.get("token");
const hasValidToken = token ? await isValidApprovalToken(projectId, token) : false;
if (!session?.ownsProject(projectId) && !hasValidToken) {
  return new NextResponse("No autorizado", { status: 403 });
}
```

## 2. Path traversal potencial en nombres de fichero de preview — MEDIA

**Archivos**: `app/api/preview/[projectId]/assets/[filename]/route.ts`, `.../adaptation/[formatId]/assets/[filename]/route.ts`.

**Riesgo**: `filename` se concatena directo en `storagePath = \`${projectId}/layers/${filename}\`` sin rechazar `..`, `/`, `\`. Dependiendo de la normalización de Next.js/runtime ante segmentos codificados (`%2e%2e%2f`, doble codificación), podría colar una ruta hacia storage de otro proyecto dentro del mismo bucket.

**Fix recomendado**:
```ts
if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
  return new NextResponse("Nombre de archivo inválido.", { status: 400 });
}
```
Aplicar en los 2 archivos citados; opcionalmente el mismo criterio en los segmentos `[projectId]`/`[formatId]`/`[psdId]` aunque ahí el riesgo es menor porque se validan contra BD antes de usarse.

## 3. Sin rate limiting en endpoints que llaman a Claude directamente — MEDIA

**Archivos**: `app/api/master/refine/route.ts`, `app/api/production/refine/route.ts`.

**Riesgo**: a diferencia de `analysis`/`master/generate`/`production/start` (que tienen guard de single-flight vía `status` del proyecto), estas dos rutas no tienen ningún control de frecuencia. Un usuario (o su sesión comprometida) puede golpear estos endpoints en bucle, generando coste de Claude sin límite técnico — solo mitigado indirectamente por límites de proyectos/tier.

**Fix recomendado**: rate limiting básico por `userId` (Upstash Ratelimit, o contador en Supabase con ventana deslizante) en ambas rutas.

## 4. Sin rate limiting en `/approve/[token]` — MEDIA

**Archivos**: `app/api/master/approve/route.ts`, página `/approve/[token]`.

**Riesgo**: rutas públicas sin auth que consultan Supabase por `token` en cada request. El UUID v4 es computacionalmente inviable de fuerza bruta (122 bits), así que el riesgo real es bajo, pero cada intento fallido genera una query — superficie de scraping/DoS de bajo coste.

**Fix recomendado**: rate limiting genérico por IP en middleware para estas rutas públicas.

## 5. Jobs de Trigger.dev sin revalidación de `projectId` — MEDIA

**Archivos**: `trigger/analyze-psd.ts`, `parse-media-plan.ts`, `render-master.ts`, `render-adaptations.ts`.

**Riesgo**: los 4 jobs usan `createTriggerSupabaseClient` (service-role, bypassa RLS) y confían en que el `projectId` del payload ya fue validado por la API route que disparó el job. No hay defensa en profundidad: quien tenga `TRIGGER_SECRET_KEY` (equipo interno, o si se filtrara) podría invocar estos jobs directamente vía la API de Trigger.dev con cualquier `projectId`. `TRIGGER_SECRET_KEY` en sí no está expuesta (confirmado — solo aparece en server-side/docs).

**Fix recomendado**: al inicio de cada `run()`, verificar que el proyecto existe (chequeo de cordura, no sustituye ownership):
```ts
const { data: project } = await supabase.from("adstudio_projects").select("id").eq("id", projectId).single();
if (!project) throw new Error(`Proyecto ${projectId} no encontrado`);
```

## 6. Mensajes de error de Supabase expuestos al cliente — BAJA

**Archivos**: `app/api/project/[id]/font/route.ts:31`, `layers/project/[projectId]/reorder/route.ts:33`, `layers/asset/[assetId]/route.ts:158`, `upload/[assetId]/route.ts:40`, `brief/formats/[formatId]/route.ts:77`, `brief/route.ts` (líneas 73, 76, 114, 137, 179, 205, 229).

**Riesgo**: `error.message` de Postgres/Supabase se devuelve tal cual en la respuesta JSON — puede filtrar nombres de columnas/constraints/detalles de esquema a quien sondee estas rutas con payloads inválidos.

**Fix recomendado**:
```ts
if (error || !updated) {
  console.error("Error actualizando formato:", error);
  return NextResponse.json({ error: "No se pudo actualizar el formato." }, { status: 400 });
}
```

## 7. Logging verboso con datos de cliente en `analyze-psd.ts` — BAJA

**Archivo**: `trigger/analyze-psd.ts:211,241,246,266,306`.

**Riesgo**: se loguea el objeto completo insertado/devuelto por Supabase (`console.log("Resultado insert:", { data: inserted, error: insertError })`), que puede incluir `text_content` (copy real de campaña del cliente, potencialmente confidencial antes de publicación) en los logs de Trigger.dev.

**Fix recomendado**: quitar o condicionar a modo debug; loguear solo IDs/resúmenes, no filas completas.

## 8. Validación de uploads solo por extensión declarada — BAJA

**Archivo**: `app/api/upload/route.ts`.

**Riesgo**: la validación server-side (correcta en cuanto a tamaño y extensión) se basa en el nombre de archivo declarado, no en magic bytes/contenido real. Un archivo con extensión `.psd` falsa llegaría intacto a `ag-psd` en el job `analyze-psd`. Impacto limitado (parsing aislado en Trigger.dev), pero conviene verificar resiliencia de `ag-psd` ante input corrupto/malicioso.

**Fix recomendado**: validar magic bytes mínimos del PSD (`8BPS` en los primeros 4 bytes) antes de aceptar el upload.

## 9. Tokens de aprobación reutilizables indefinidamente tras aprobar — BAJA

**Archivo**: `lib/approval.ts`.

**Riesgo**: una vez `approved_at` se rellena, el token sigue siendo válido dentro de la ventana de 7 días — cualquiera con el link puede seguir viendo el estado aprobado, y un `PUT` repetido simplemente re-escribe `approved_at`. Comportamiento probablemente intencional (permite revisitar lo aprobado), pero merece decisión explícita del producto.

**Fix recomendado** (si se decide cerrar): invalidar el token o marcarlo de solo lectura tras la primera aprobación.

## 10. Orden de verificación: leer antes de comprobar ownership — BAJA

**Archivos**: `app/api/upload/[assetId]/route.ts:16-29`, `layers/asset/[assetId]/route.ts:35-50`, `brief/formats/[formatId]/route.ts:35-47`.

**Riesgo**: estas rutas hacen `select` con el cliente de sesión (que aplica RLS) para resolver `project_id` a partir de un `assetId`/`formatId`, y solo *después* llaman a `requireProjectOwnership`. Es seguro mientras RLS esté correctamente configurada (confirmado que lo está en `schema.sql`), pero convierte a RLS en la única línea de defensa para estas 3 rutas — si una policy se rompe algún día, quedan sin protección adicional.

**Fix recomendado**: mover la verificación de ownership antes del `select` cuando sea posible, o documentar explícitamente la dependencia en el código con un comentario.

---

## Verificaciones sin hallazgos (confirmado correcto)

- **RLS**: las 7 tablas `adstudio_*` tienen `ENABLE ROW LEVEL SECURITY` con policies que filtran por `user_id = auth.uid()` (tablas raíz) o `EXISTS (... p.user_id = auth.uid())` (tablas hijas) — `supabase/schema.sql:294-300` y policies asociadas.
- **Storage policies**: bucket `adstudio-projects` es privado (`public: false`), policies exigen que el primer segmento del path sea un `project_id` propiedad del usuario — imposibilita acceso cruzado aunque se adivine la ruta.
- **`SUPABASE_SERVICE_ROLE_KEY`**: solo dos referencias en todo el repo, ambas server-side (`lib/supabase/server.ts`, `lib/supabase/trigger-client.ts`); nunca en código cliente.
- **`NEXT_PUBLIC_*`**: solo `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_APP_URL` — ninguna es un secreto real; la anon key depende de RLS (correctamente configurada).
- **`.env.local.example`**: sin valores reales, solo placeholders vacíos.
- **`TRIGGER_SECRET_KEY`**: nunca expuesta como `NEXT_PUBLIC_`, solo uso server-side.
- **Generación de approval token**: `gen_random_uuid()` en BD (122 bits de entropía), TTL de 7 días siempre asignado en `createApprovalLink` (`lib/approval.ts:46,50`), expiración verificada en `resolveValidToken`/`getApprovalContext` antes de servir contenido.
- **`/guide/psd`**: contenido 100% estático, sin queries a Supabase, sin datos de proyecto/usuario.
- **Stripe**: no implementado — sin superficie de ataque. Checklist para cuando se implemente: validar firma de webhook con `stripe.webhooks.constructEvent` + `STRIPE_WEBHOOK_SECRET`, no confiar en tier del cliente, crear precio/producto solo server-side.
- **IDOR general en `/app/api`**: todas las rutas que reciben `projectId` verificado llaman a `requireProjectOwnership` antes de operar — patrón consistente.
- **Uploads**: tamaño y extensión validados server-side (no solo cliente); `sanitizeFilename` evita path traversal en el handler multipart; el handler JSON valida que el `filePath` declarado por el cliente caiga dentro de `${projectId}/${STORAGE_FOLDER}/`.
- **Console.log en `/app/api`**: sin credenciales ni payloads sensibles logueados.
- **Incidente previo de Replicate**: revisado `lib/render/replicate-outpainting.ts` — solo loguea `subjectDescription` y dimensiones, no la API key.

---

## Prioridad sugerida de remediación

1. **#1** (preview público) — mayor impacto de negocio (exposición de creatividad de cliente antes de aprobación).
2. **#2** (path traversal) — barato de arreglar, cierra una vía teórica de acceso cruzado.
3. **#3, #4, #5** — rate limiting / defensa en profundidad, recomendable pero no urgente.
4. **#6–#10** — limpieza de higiene, bajo riesgo, hacer en el próximo ciclo de refactor.
