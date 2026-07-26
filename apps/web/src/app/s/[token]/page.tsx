// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { DownloadPanel } from '@/components/DownloadPanel';

export const dynamic = 'force-dynamic';

// A share page must never be indexed or previewed: the URL is the credential.
export const metadata: Metadata = {
  title: 'Download',
  robots: { index: false, follow: false, nocache: true },
};

/**
 * The share page renders no server-side detail about the link.
 *
 * All metadata is fetched client-side from `/api/shares/{token}`, which keeps
 * the raw token out of any server-rendered HTML, out of the Next.js RSC payload
 * cache, and out of server logs that record rendered routes.
 */
export default async function SharePage({
  params,
}: {
  readonly params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <DownloadPanel token={token} />;
}
