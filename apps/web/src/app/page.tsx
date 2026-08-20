import { getConfig } from '@toran/config';
import { HowItWorks } from '@/components/HowItWorks';
import { UploadPanel } from '@/components/UploadPanel';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  // Server limits are the only limits that matter, but the browser needs to
  // know them to give immediate, accurate feedback.
  const config = getConfig();

  return (
    <div className="space-y-8">
      <UploadPanel
        maxFileSizeBytes={config.limits.maxFileSizeBytes}
        maxExpirySeconds={config.limits.maxExpirySeconds}
        defaultExpirySeconds={config.limits.defaultExpirySeconds}
        maxDownloadLimit={config.limits.maxDownloadLimit}
        scanningEnabled={config.scanning.enabled}
      />

      <section aria-labelledby="how-it-works">
        <HowItWorks scanningEnabled={config.scanning.enabled} />
      </section>
    </div>
  );
}
