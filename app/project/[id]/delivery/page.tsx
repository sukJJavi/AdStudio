import { getDeliveryInfo } from "@/lib/delivery";
import { DeliveryView } from "@/components/project/delivery-view";

export default async function DeliveryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const info = await getDeliveryInfo(id);

  if (!info) {
    return <div className="text-sm text-destructive">Proyecto no encontrado.</div>;
  }

  if (info.pieces.length === 0 && !info.zip) {
    return (
      <div className="text-sm text-muted-foreground">
        Todavía no hay adaptaciones producidas. Vuelve desde la fase de producción cuando termine.
      </div>
    );
  }

  return <DeliveryView pieces={info.pieces} zip={info.zip} />;
}
