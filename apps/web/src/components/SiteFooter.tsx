// SPDX-License-Identifier: MIT
import { branding } from '@toran/shared';

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-surface-raised">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 py-6 text-xs text-ink-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>
          {branding.name} is free software under the{' '}
          <a
            href="https://opensource.org/license/mit"
            className="font-medium underline underline-offset-2 hover:text-ink"
            rel="noreferrer noopener"
            target="_blank"
          >
            {branding.license} License
          </a>
          .
        </p>
        <a
          href={branding.repositoryUrl}
          className="font-medium underline underline-offset-2 hover:text-ink"
          rel="noreferrer noopener"
          target="_blank"
        >
          Source code
        </a>
      </div>
    </footer>
  );
}
