/**
 * Start-up configuration gate.
 *
 * Next.js calls `register()` once, when a server instance boots. Toran uses it
 * to validate the environment *before* the process accepts traffic.
 *
 * Without this the web tier builds its context lazily, on the first request, so
 * a deployment with example credentials or an http:// origin starts normally,
 * answers `/api/health` with 200, and fails every real request with a 500. An
 * orchestrator would call that container healthy. Refusing to start is both
 * louder and what SECURITY.md promises: Toran does not run in production with
 * unsafe configuration. The worker already behaves this way - it loads
 * configuration in `main()` - so this brings the two processes into line.
 */
export async function register(): Promise<void> {
  // Next compiles this module for the edge runtime as well, because Toran's
  // middleware runs there. Edge has no filesystem and never serves the API.
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }
  // During `next build` there is no deployment environment to validate yet:
  // the image is built once and configured later, by a different operator.
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return;
  }

  // `webpackIgnore` keeps `@toran/config` - which reads the filesystem - out of
  // the edge bundle, where `node:fs` does not resolve. At runtime this is a
  // plain dynamic import, and the package is already traced into the standalone
  // output because every API route imports it normally.
  const { getConfig, ConfigurationError } = await import(/* webpackIgnore: true */ '@toran/config');

  try {
    getConfig();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      // ConfigurationError names the offending variables and says why each is
      // unacceptable. It never includes their values, so this is safe to print.
      console.error(`[toran] refusing to start.\n${error.message}`);
    } else {
      let detail = 'unknown error';
      if (error instanceof Error) {
        detail = error.message;
      }
      console.error('[toran] refusing to start: configuration could not be loaded.', detail);
    }
    process.exit(1);
  }
}
