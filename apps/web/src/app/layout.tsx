import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { branding } from '@toran/shared';
import { SiteHeader } from '@/components/SiteHeader';
import { ThemeScript } from '@/components/ThemeScript';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: `${branding.name} | Secure File Sharing`,
    template: `%s | ${branding.name}`,
  },
  description: branding.description,
  applicationName: branding.name,
  // Uploaded content is never rendered here, but share pages should not be
  // indexed or previewed by third parties.
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: branding.themeColor.light },
    { media: '(prefers-color-scheme: dark)', color: branding.themeColor.dark },
  ],
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-dvh">
        <a href="#main" className="toran-skip-link">
          Skip to Main Content
        </a>
        <div className="flex min-h-dvh flex-col">
          <SiteHeader />
          <main
            id="main"
            className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-12 lg:px-8"
          >
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
