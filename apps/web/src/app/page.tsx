// SPDX-License-Identifier: AGPL-3.0-only
import { getConfig } from '@toran/config';
import { branding } from '@toran/shared';
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

      <section aria-labelledby="how-it-works" className="text-sm text-ink-muted">
        <h2 id="how-it-works" className="text-base font-semibold text-ink">
          How {branding.name} works
        </h2>
        <ol className="mt-3 space-y-2">
          <li>
            <strong className="font-medium text-ink">1.</strong> Your browser asks Toran for
            permission to upload. Toran checks the size, name and limits, then returns a
            short-lived, single-purpose upload URL.
          </li>
          <li>
            <strong className="font-medium text-ink">2.</strong> Your browser sends the file
            directly to object storage. The file never passes through the Toran server.
          </li>
          <li>
            <strong className="font-medium text-ink">3.</strong> Toran verifies the stored object
            {config.scanning.enabled ? ', scans it for malware,' : ''} and gives you a link.
          </li>
          <li>
            <strong className="font-medium text-ink">4.</strong> Anyone with the link downloads
            straight from storage using a URL that expires in minutes.
          </li>
        </ol>
        {!config.scanning.enabled ? (
          <p className="mt-4 rounded-lg border border-warning-200 bg-warning-50 px-4 py-3 text-warning-800">
            Malware scanning is disabled on this server. This is a development-only setting.
          </p>
        ) : null}
      </section>
    </div>
  );
}
