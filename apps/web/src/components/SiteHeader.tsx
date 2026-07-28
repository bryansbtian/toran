// SPDX-License-Identifier: MIT
import Link from 'next/link';
import { branding } from '@toran/shared';
import { Logo } from '@toran/ui';
import { ThemeToggle } from './ThemeToggle';

export function SiteHeader() {
  return (
    <header className="border-b border-line bg-surface-raised">
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <Link
          href="/"
          className="flex items-center gap-2.5 rounded-lg text-ink"
          aria-label={`${branding.name} home`}
        >
          <Logo size={30} />
          <span className="text-lg font-semibold tracking-tight">{branding.name}</span>
        </Link>
        <nav aria-label="Primary" className="flex items-center gap-1">
          <Link
            href="/report"
            className="rounded-lg px-3 py-2 text-sm font-medium text-ink-muted hover:bg-surface-sunken hover:text-ink"
          >
            Report abuse
          </Link>
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
