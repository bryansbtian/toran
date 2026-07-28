// SPDX-License-Identifier: MIT
/**
 * Stand-in for Next.js's `server-only` marker package.
 *
 * The real module exists only to make a bundler fail if server code is pulled
 * into a client bundle. Under Vitest there is no bundler boundary to enforce,
 * so importing it must simply be a no-op.
 */
export {};
