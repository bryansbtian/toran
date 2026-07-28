// SPDX-License-Identifier: MIT
import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="rounded-xl border border-line bg-surface-raised p-6 sm:p-8">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Page not found</h1>
      <p className="mt-3 text-sm text-ink-muted">
        That page does not exist. If you followed a share link, it may have expired or been revoked.
      </p>
      <Link
        href="/"
        className="mt-6 inline-flex items-center rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-700"
      >
        Go to the upload page
      </Link>
    </div>
  );
}
