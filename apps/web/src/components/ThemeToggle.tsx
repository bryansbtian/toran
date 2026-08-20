'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

type Theme = 'light' | 'dark';

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  // Read the value ThemeScript already applied, rather than computing it again,
  // so the button label matches what is actually rendered.
  useEffect(() => {
    const current = document.documentElement.getAttribute('data-theme');
    // Anything other than an explicit "dark" is light, including the attribute
    // being absent, which is what ThemeScript leaves for the default theme.
    let applied: Theme = 'light';
    if (current === 'dark') {
      applied = 'dark';
    }
    setTheme(applied);
  }, []);

  const toggle = () => {
    let next: Theme = 'dark';
    if (theme === 'dark') {
      next = 'light';
    }
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('toran-theme', next);
    } catch {
      /* private browsing; the theme still applies for this page view */
    }
  };

  const isDark = theme === 'dark';

  // The control offers the theme you would switch to, so the icon and the label
  // are both the opposite of what is currently applied.
  let label = 'Switch to dark theme';
  if (isDark) {
    label = 'Switch to light theme';
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      className="rounded-lg px-3 py-2 text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink"
    >
      {isDark && <Sun className="h-5 w-5" aria-hidden="true" />}
      {!isDark && <Moon className="h-5 w-5" aria-hidden="true" />}
    </button>
  );
}
