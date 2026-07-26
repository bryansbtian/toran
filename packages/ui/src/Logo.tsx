// SPDX-License-Identifier: AGPL-3.0-only
import type { JSX } from 'react';
import { branding } from '@toran/shared';

export interface LogoProps {
  readonly size?: number;
  readonly className?: string;
  readonly title?: string;
}

/**
 * Toran's mark: an open gateway ("toran" is a ceremonial gateway/arch), drawn
 * entirely from primitives. No third-party or licensed artwork is used, so
 * forks may modify it freely under AGPL-3.0-only.
 */
export function Logo({ size = 28, className, title }: LogoProps): JSX.Element {
  const label = title ?? `${branding.name} logo`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label={label}
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{label}</title>
      <rect width="32" height="32" rx="8" className="fill-brand-600" />
      <path
        d="M8 23V13a8 8 0 0 1 16 0v10"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        className="text-white"
      />
      <path
        d="M16 10v9m0 0-3.5-3.5M16 19l3.5-3.5"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-white"
      />
    </svg>
  );
}
