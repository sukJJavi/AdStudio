export type Tier = "starter" | "studio" | "agency";

export type ProjectStatus =
  | "draft"
  | "upload"
  | "analyzing"
  | "analysis"
  | "master"
  | "master_generating"
  | "master_ready"
  | "approved"
  | "production"
  | "producing"
  | "delivery"
  | "delivery_ready";

export type Project = {
  id: string;
  user_id: string;
  cliente: string;
  producto: string | null;
  objetivo: string | null;
  fecha_inicio: string | null;
  fecha_fin: string | null;
  presupuesto: number | null;
  status: ProjectStatus;
  tier: Tier;
  /** Comentarios del cliente al solicitar cambios sobre el master. */
  notes: string | null;
  /** Run id del job render-master en curso (null si no hay uno activo). */
  master_run_id: string | null;
  /** Tipografía elegida para claim/subclaim/CTA en master y adaptaciones. */
  font_primary: string;
  /** Reservada para un futuro par claim/subclaim; no usada todavía. */
  font_secondary: string | null;
  created_at: string;
  updated_at: string;
};

export type FormatStatus = "pending" | "producing" | "ready" | "incident";

export type IncidenciaLevel = "critico" | "atencion" | "aviso";

export type Incidencia = {
  level: IncidenciaLevel;
  code: string;
  message: string;
  format_id?: string;
  asset_id?: string;
};

export type ProjectFormat = {
  id: string;
  project_id: string;
  nombre_soporte: string;
  iab_format: string;
  url_destino: string | null;
  versiones: number;
  status: FormatStatus;
  incidencias: Incidencia[];
  copy: string | null;
  created_at: string;
};

export type AssetType = "psd" | "excel" | "animation";

export type AssetStatus = "uploaded" | "processing" | "processed" | "error";

/** `adstudio_assets.metadata` para capas clasificadas como 'texto'. Vacío ({}) para el resto. */
export type TextLayerMetadata = {
  fontName?: string | null;
  fontSize?: number | null;
  content?: string | null;
};

export type ProjectAsset = {
  id: string;
  project_id: string;
  layer_name: string | null;
  layer_type: AssetType | string | null;
  classification: string | null;
  width: number | null;
  height: number | null;
  dpi: number | null;
  file_path: string | null;
  quality_score: number | null;
  status: AssetStatus;
  metadata: TextLayerMetadata | Record<string, never>;
  created_at: string;
};

export type ChangeType = "A" | "B" | "C" | "D" | "E";

export type ChangeStatus = "pending" | "in_progress" | "done" | "rejected";

export type ProjectChange = {
  id: string;
  project_id: string;
  type: ChangeType | null;
  description: string | null;
  formats_affected: string[];
  requested_at: string;
  status: ChangeStatus;
};

export type ApprovalToken = {
  id: string;
  project_id: string;
  token: string;
  expires_at: string | null;
  approved_at: string | null;
};

export type MasterRecord = {
  id: string;
  project_id: string;
  iab_format: string;
  jpg_path: string;
  png_path: string;
  width: number;
  height: number;
  jpg_size_bytes: number | null;
  is_primary: boolean;
  created_at: string;
};

export type Subscription = {
  id: string;
  user_id: string;
  tier: Tier;
  stripe_id: string | null;
  projects_limit: number;
  formats_limit: number;
  rounds_limit: number;
  created_at: string;
};

export const TIER_LABELS: Record<Tier, string> = {
  starter: "Starter",
  studio: "Studio",
  agency: "Agency",
};

export const STATUS_ROUTE: Record<ProjectStatus, string> = {
  draft: "brief",
  upload: "upload",
  analyzing: "analysis",
  analysis: "analysis",
  master: "master",
  master_generating: "master",
  master_ready: "master",
  approved: "production",
  production: "production",
  producing: "production",
  delivery: "delivery",
  delivery_ready: "delivery",
};

export const STATUS_LABELS: Record<ProjectStatus, string> = {
  draft: "Brief",
  upload: "Upload",
  analyzing: "Analizando",
  analysis: "Análisis",
  master: "Master",
  master_generating: "Generando master",
  master_ready: "Master listo",
  approved: "Aprobado",
  production: "Producción",
  producing: "Produciendo adaptaciones",
  delivery: "Entrega",
  delivery_ready: "Lista para entregar",
};
