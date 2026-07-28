// SPDX-License-Identifier: MIT
import { loadConfig } from '@toran/config';
import { generateShareToken, hashShareToken } from '@toran/security';
import { generateStorageKey } from '@toran/storage';
import { createDatabase } from '../client.js';
import { createUpload } from '../repos/files.js';
import { createShareLink } from '../repos/shares.js';
import { files } from '../schema.js';
import { eq } from 'drizzle-orm';

/**
 * Seeds one ready-to-download demo file so a fresh developer install has
 * something to click on. It does NOT put an object in storage, so the demo
 * link intentionally fails at the storage step; upload a real file to see the
 * full flow. Refuses to run against production.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (config.isProduction) {
    throw new Error('refusing to seed a production database');
  }

  const handle = createDatabase({ url: config.database.url, poolMax: 1 });
  try {
    const { file } = await createUpload(handle.db, {
      storageKey: generateStorageKey(),
      originalFilename: 'toran-demo.txt',
      normalizedFilename: 'toran-demo.txt',
      contentType: 'text/plain',
      declaredSize: 26,
      expiresAt: new Date(Date.now() + 86_400_000),
      anonIdentifier: 'seed',
      ownerId: null,
      sessionExpiresAt: new Date(Date.now() + 3_600_000),
      sharePasswordHash: null,
      shareMaxDownloads: null,
      shareExpiresAt: new Date(Date.now() + 86_400_000),
    });

    await handle.db
      .update(files)
      .set({ status: 'ready', actualSize: 26 })
      .where(eq(files.id, file.id));

    const token = generateShareToken();
    await createShareLink(handle.db, {
      fileIds: [file.id],
      tokenHash: hashShareToken(token),
      passwordHash: null,
      expiresAt: new Date(Date.now() + 86_400_000),
      maxDownloads: null,
    });

    console.log('[toran:db] seeded demo file');
    console.log(`[toran:db] demo share url: ${config.app.url}/s/${token}`);
    console.log('[toran:db] note: no object was written to storage for this seed row');
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error('[toran:db] seed failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
