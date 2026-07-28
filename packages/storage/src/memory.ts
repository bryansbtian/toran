// SPDX-License-Identifier: MIT
import { Readable } from 'node:stream';
import { assertValidStorageKey, quarantineKeyFor } from './keys.js';
import {
  StorageError,
  type CreateDownloadUrlInput,
  type CreateUploadUrlInput,
  type PresignedUpload,
  type StorageProvider,
  type StoredObjectMetadata,
} from './types.js';

interface MemoryObject {
  body: Buffer;
  contentType: string;
  lastModified: Date;
}

/**
 * In-process storage used by integration tests.
 *
 * The URLs it returns are not fetchable; tests drive uploads by calling
 * {@link MemoryStorage.putObject} directly, which is what a browser PUT would
 * have produced. This keeps the automated suite free of any external service.
 */
export class MemoryStorage implements StorageProvider {
  public readonly name = 'memory';
  private readonly objects = new Map<string, MemoryObject>();
  public failNextHead = false;
  public healthy = true;

  async createUploadUrl(input: CreateUploadUrlInput): Promise<PresignedUpload> {
    assertValidStorageKey(input.key);
    return {
      url: `memory://upload/${encodeURIComponent(input.key)}`,
      method: 'PUT',
      headers: {
        'Content-Type': input.contentType,
        'Content-Length': String(input.contentLength),
      },
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    };
  }

  async createDownloadUrl(input: CreateDownloadUrlInput): Promise<string> {
    assertValidStorageKey(input.key);
    if (!this.objects.has(input.key)) throw new StorageError('object not found', false);
    return `memory://download/${encodeURIComponent(input.key)}?filename=${encodeURIComponent(
      input.downloadFilename,
    )}`;
  }

  async headObject(key: string): Promise<StoredObjectMetadata | null> {
    assertValidStorageKey(key);
    if (this.failNextHead) {
      this.failNextHead = false;
      throw new StorageError('simulated storage failure', true);
    }
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      key,
      size: object.body.byteLength,
      contentType: object.contentType,
      etag: `${object.body.byteLength.toString(16)}`,
      lastModified: object.lastModified,
    };
  }

  async getObjectStream(key: string): Promise<NodeJS.ReadableStream> {
    assertValidStorageKey(key);
    const object = this.objects.get(key);
    if (!object) throw new StorageError('object not found', false);
    return Readable.from([object.body]);
  }

  async deleteObject(key: string): Promise<void> {
    assertValidStorageKey(key);
    this.objects.delete(key);
  }

  async copyObject(sourceKey: string, destinationKey: string): Promise<void> {
    assertValidStorageKey(sourceKey);
    assertValidStorageKey(destinationKey);
    const object = this.objects.get(sourceKey);
    if (!object) throw new StorageError('object not found', false);
    this.objects.set(destinationKey, { ...object });
  }

  async healthCheck(): Promise<void> {
    if (!this.healthy) throw new StorageError('memory storage marked unhealthy', true);
  }

  // --- test helpers -------------------------------------------------------

  /** Stands in for the browser's direct PUT to object storage. */
  putObject(key: string, body: Buffer | string, contentType = 'application/octet-stream'): void {
    assertValidStorageKey(key);
    this.objects.set(key, {
      body: Buffer.isBuffer(body) ? body : Buffer.from(body),
      contentType,
      lastModified: new Date(),
    });
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  hasQuarantined(storageKey: string): boolean {
    return this.objects.has(quarantineKeyFor(storageKey));
  }

  keys(): string[] {
    return [...this.objects.keys()];
  }

  clear(): void {
    this.objects.clear();
  }
}
