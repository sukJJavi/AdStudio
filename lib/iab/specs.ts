export type IABFormat = {
  id: string;
  nombre: string;
  ancho: number;
  alto: number;
  pesoMaximoKB: number;
  zonaSeguraPx: number;
  notas: string;
  /** Longitud máxima recomendada (caracteres) para el copy que se muestra en este formato. */
  copyMaxLength: number;
};

export const IAB_SPECS: IABFormat[] = [
  {
    id: "medium-rectangle",
    nombre: "Medium Rectangle (Robapáginas)",
    ancho: 300,
    alto: 250,
    pesoMaximoKB: 150,
    zonaSeguraPx: 10,
    notas: "Formato más solicitado en display. Buen rendimiento en contenido editorial.",
    copyMaxLength: 90,
  },
  {
    id: "leaderboard",
    nombre: "Leaderboard",
    ancho: 728,
    alto: 90,
    pesoMaximoKB: 150,
    zonaSeguraPx: 10,
    notas: "Cabecera clásica en desktop. Evitar texto pequeño por la poca altura.",
    copyMaxLength: 50,
  },
  {
    id: "wide-skyscraper",
    nombre: "Wide Skyscraper",
    ancho: 160,
    alto: 600,
    pesoMaximoKB: 150,
    zonaSeguraPx: 10,
    notas: "Lateral de alto rendimiento. Aprovechar composición vertical.",
    copyMaxLength: 70,
  },
  {
    id: "skyscraper",
    nombre: "Skyscraper (Rascacielos)",
    ancho: 120,
    alto: 600,
    pesoMaximoKB: 150,
    zonaSeguraPx: 10,
    notas: "En desuso frente al Wide Skyscraper, aún soportado por algunos soportes.",
    copyMaxLength: 60,
  },
  {
    id: "half-page",
    nombre: "Half Page",
    ancho: 300,
    alto: 600,
    pesoMaximoKB: 150,
    zonaSeguraPx: 10,
    notas: "Alto impacto visual, ideal para creatividades ricas en imagen.",
    copyMaxLength: 100,
  },
  {
    id: "billboard",
    nombre: "Billboard",
    ancho: 970,
    alto: 250,
    pesoMaximoKB: 150,
    zonaSeguraPx: 10,
    notas: "Formato premium de cabecera, muy usado en homepages de medios.",
    copyMaxLength: 110,
  },
  {
    id: "super-leaderboard",
    nombre: "Super Leaderboard / Pushdown",
    ancho: 970,
    alto: 90,
    pesoMaximoKB: 150,
    zonaSeguraPx: 10,
    notas: "Variante ampliada del leaderboard, frecuente en pushdowns con expansión.",
    copyMaxLength: 60,
  },
  {
    id: "square",
    nombre: "Square",
    ancho: 250,
    alto: 250,
    pesoMaximoKB: 150,
    zonaSeguraPx: 10,
    notas: "Encaja bien en grillas de contenido y sidebars estrechos.",
    copyMaxLength: 80,
  },
  {
    id: "small-square",
    nombre: "Small Square",
    ancho: 200,
    alto: 200,
    pesoMaximoKB: 150,
    zonaSeguraPx: 10,
    notas: "Uso decreciente, útil como formato de refuerzo en RON.",
    copyMaxLength: 60,
  },
  {
    id: "button",
    nombre: "Button",
    ancho: 125,
    alto: 125,
    pesoMaximoKB: 150,
    zonaSeguraPx: 10,
    notas: "Formato legacy, principalmente para sponsors y logos.",
    copyMaxLength: 30,
  },
  {
    id: "mobile-banner",
    nombre: "Mobile Banner",
    ancho: 320,
    alto: 50,
    pesoMaximoKB: 150,
    zonaSeguraPx: 10,
    notas: "Estándar en apps y web mobile. Priorizar legibilidad del copy.",
    copyMaxLength: 40,
  },
  {
    id: "mobile-large-banner",
    nombre: "Mobile Large Banner",
    ancho: 320,
    alto: 100,
    pesoMaximoKB: 150,
    zonaSeguraPx: 10,
    notas: "Doble altura respecto al mobile banner, mejora la visibilidad de marca.",
    copyMaxLength: 60,
  },
  {
    id: "mobile-interstitial",
    nombre: "Mobile Interstitial",
    ancho: 320,
    alto: 480,
    pesoMaximoKB: 150,
    zonaSeguraPx: 10,
    notas: "Pantalla completa en mobile. Requiere botón de cierre visible siempre.",
    copyMaxLength: 120,
  },
  {
    id: "vertical-banner",
    nombre: "Vertical Banner",
    ancho: 240,
    alto: 400,
    pesoMaximoKB: 150,
    zonaSeguraPx: 10,
    notas: "Formato intermedio poco usado, alternativa al Half Page en espacios reducidos.",
    copyMaxLength: 80,
  },
  {
    id: "full-banner",
    nombre: "Full Banner",
    ancho: 468,
    alto: 60,
    pesoMaximoKB: 150,
    zonaSeguraPx: 10,
    notas: "Predecesor del Leaderboard, todavía presente en inventario legacy.",
    copyMaxLength: 45,
  },
];

export function getIABFormatById(id: string): IABFormat | undefined {
  return IAB_SPECS.find((f) => f.id === id);
}

export function validateFormatWeight(id: string, pesoKB: number): boolean {
  const spec = getIABFormatById(id);
  if (!spec) return false;
  return pesoKB <= spec.pesoMaximoKB;
}
