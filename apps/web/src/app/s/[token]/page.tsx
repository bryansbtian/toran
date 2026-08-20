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
 * Filename, size, expiry and password state are all fetched client-side from
 * `/api/shares/{token}`, so none of it reaches the initial HTML and none of it
 * is rendered for a visitor who turns out not to be entitled to it.
 *
 * The token itself is a different matter: this is a dynamic route, so Next.js
 * puts the request's URL into the RSC payload embedded in the HTML regardless
 * of what this component does with `params`. That is acceptable because the
 * response is `Cache-Control: no-store` (see `middleware.ts`) and is only ever
 * sent to a client that already supplied the token - but it is not the same as
 * the token being absent. Closing it properly means moving the token into the
 * URL fragment, which never reaches the server at all.
 */
export default async function SharePage({
  params,
}: {
  readonly params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <div className="mx-auto w-full max-w-4xl">
      <DownloadPanel token={token} />
    </div>
  );
}
