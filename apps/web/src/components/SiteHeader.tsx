import Link from 'next/link';
import { branding } from '@toran/shared';
import { ThemeToggle } from './ThemeToggle';

export function SiteHeader() {
  return (
    <header className="border-b border-line bg-surface-raised">
      <div className="flex w-full items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
        <Link
          href="/"
          className="rounded-lg text-lg font-semibold tracking-tight text-ink"
          aria-label={`${branding.name} home`}
        >
          {branding.name}
        </Link>
        <nav aria-label="Primary" className="flex items-center gap-1">
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
