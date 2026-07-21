export default function PsdGuidePage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-10">
      <div>
        <p className="text-xs text-muted-foreground">Guía</p>
        <h1 className="text-2xl font-semibold">Cómo preparar tu PSD para AdStudio</h1>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Estructura de carpetas</h2>
        <p className="text-sm text-muted-foreground">
          Cada frame es una carpeta de primer nivel. Nómbralas &quot;Frame 0&quot;, &quot;Frame
          1&quot;, etc. Los elementos que aparecen en todos los frames van en una carpeta
          &quot;Persistente&quot; o fuera de cualquier carpeta de frame.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Nombrado de capas</h2>
        <p className="text-sm text-muted-foreground">
          No es obligatorio pero ayuda. Nombres recomendados: &quot;logo&quot;,
          &quot;background&quot;, &quot;claim&quot;, &quot;cta&quot;, &quot;disclaimer&quot;.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Capas ocultas</h2>
        <p className="text-sm text-muted-foreground">
          Se detectan pero se descartan automáticamente. Si quieres incluir una capa oculta,
          hazla visible antes de exportar.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Resolución</h2>
        <p className="text-sm text-muted-foreground">
          Mínimo 72dpi. Para formatos grandes (970x250, 300x600) recomendamos 144dpi.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Texto</h2>
        <p className="text-sm text-muted-foreground">
          Las capas de texto de Photoshop se detectan y son editables en AdStudio. No es
          necesario rasterizarlas.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Tamaño máximo</h2>
        <p className="text-sm text-muted-foreground">150MB por archivo PSD.</p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Formatos</h2>
        <p className="text-sm text-muted-foreground">Se aceptan .psd y .psb.</p>
      </section>
    </div>
  );
}
