import { UploadZones } from "@/components/project/upload-zones";
import { getProjectAssets } from "@/lib/assets";

export default async function UploadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const assets = await getProjectAssets(id);

  return (
    <div className="mx-auto max-w-4xl">
      <UploadZones projectId={id} initialAssets={assets} />
    </div>
  );
}
