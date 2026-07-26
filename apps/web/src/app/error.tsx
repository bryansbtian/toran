// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect } from 'react';

/**
 * Client error boundary. Next.js already strips server error details in
 * production; this renders a safe message and never displays `error.message`,
 * which could carry internal text in development.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  useEffect(() => {
    console.error('[toran] unhandled UI error', error.digest ?? error.name);
  }, [error]);

  return (
    <div className="rounded-xl border border-line bg-surface-raised p-6 sm:p-8">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Something went wrong</h1>
      <p className="mt-3 text-sm text-ink-muted">
        The page could not be displayed. Please try again.
        {error.digest ? (
          <>
            {' '}
            Reference: <code className="font-mono text-xs">{error.digest}</code>
          </>
        ) : null}
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-6 inline-flex items-center rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-700"
      >
        Try again
      </button>
    </div>
  );
}
