"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { GOOGLE_FONTS, googleFontUrl } from "@/lib/fonts";
import { cn } from "@/lib/utils";

export function FontSelector({
  projectId,
  currentFont,
  detectedFonts,
  previewText,
}: {
  projectId: string;
  currentFont: string;
  detectedFonts: string[];
  previewText: string;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState(currentFont);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Carga la Google Font seleccionada para la preview en vivo.
  useEffect(() => {
    const linkId = "font-selector-preview-font";
    let link = document.getElementById(linkId) as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement("link");
      link.id = linkId;
      link.rel = "stylesheet";
      document.head.appendChild(link);
    }
    link.href = googleFontUrl(selected);
  }, [selected]);

  const filteredFonts = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GOOGLE_FONTS;
    return GOOGLE_FONTS.filter((font) => font.toLowerCase().includes(q));
  }, [query]);

  async function handleSelect(fontName: string) {
    setSelected(fontName);
    setSaving(true);
    setError(null);

    try {
      const res = await fetch(`/api/project/${projectId}/font`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ font_primary: fontName }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "No se pudo guardar la tipografía.");
        return;
      }

      router.refresh();
    } catch {
      setError("Error de red al guardar la tipografía.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tipografía</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {detectedFonts.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Detectada del PSD:</p>
            <div className="flex flex-wrap gap-2">
              {detectedFonts.map((font) => (
                <Button
                  key={font}
                  type="button"
                  variant={selected === font ? "default" : "outline"}
                  size="sm"
                  onClick={() => handleSelect(font)}
                  disabled={saving}
                >
                  {font}
                </Button>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-2">
          <Input
            placeholder="Buscar tipografía..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md border border-border p-1">
            {filteredFonts.length === 0 && (
              <p className="px-2 py-1 text-sm text-muted-foreground">Sin resultados.</p>
            )}
            {filteredFonts.map((font) => (
              <button
                key={font}
                type="button"
                onClick={() => handleSelect(font)}
                disabled={saving}
                className={cn(
                  "rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted",
                  selected === font && "bg-primary text-primary-foreground hover:bg-primary/90",
                )}
              >
                {font}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-md border border-border p-4">
          <p className="mb-2 text-xs text-muted-foreground">Preview — {selected}</p>
          <p style={{ fontFamily: `"${selected}", Arial, sans-serif`, fontWeight: 700 }} className="text-2xl">
            {previewText}
          </p>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
