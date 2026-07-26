// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Applies the stored or system theme before first paint.
 *
 * This has to be inline and synchronous, otherwise the page renders in the
 * default theme and visibly flips. It reads only from localStorage and
 * matchMedia, and writes only a data attribute, so it handles no user data.
 */
const script = `
(function () {
  try {
    var stored = localStorage.getItem('toran-theme');
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = stored === 'light' || stored === 'dark' ? stored : (prefersDark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
`.trim();

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
