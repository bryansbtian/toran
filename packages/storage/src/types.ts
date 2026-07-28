// SPDX-License-Identifier: MIT

export interface StoredObjectMetadata {
  readonly key: string;
  readonly size: number;
  readonly contentType: string | undefined;
  readonly etag: string | undefined;
  readonly lastModified: Date | undefined;
}

export interface PresignedUpload {
  readonly url: string;
  readonly method: 'PUT';
  /**
   * Headers the browser MUST send verbatim. Any deviation invalidates the
   * signature, which is what stops a client from uploading under a different
   * content type or size than the one the server authorised.
   */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

export interface CreateUploadUrlInput {
  readonly key: string;
  readonly contentType: string;
  /** Declared size in bytes. Verified again with a HEAD after upload. */
  readonly contentLength: number;
  readonly expiresInSeconds: number;
}

export interface CreateDownloadUrlInput {
  readonly key: string;
  readonly expiresInSeconds: number;
  /** Filename the browser should save as. */
  readonly downloadFilename: string;
  /** Response content type. Active formats must already be neutralised. */
  readonly contentType: string;
}

/**
 * Everything Toran needs from object storage.
 *
 * Deliberately narrow: no listing, no bucket administration, no ACL control.
 * A future multipart or resumable implementation adds methods here without
 * changing any caller that only needs single-request uploads.
 */
export interface StorageProvider {
  readonly name: string;
  createUploadUrl(input: CreateUploadUrlInput): Promise<PresignedUpload>;
  createDownloadUrl(input: CreateDownloadUrlInput): Promise<string>;
  /** `null` when the object does not exist. Throws on transport failures. */
  headObject(key: string): Promise<StoredObjectMetadata | null>;
  getObjectStream(key: string): Promise<NodeJS.ReadableStream>;
  /** Idempotent: deleting a missing object is not an error. */
  deleteObject(key: string): Promise<void>;
  /** Server-side copy, used to move blocked files into quarantine. */
  copyObject(sourceKey: string, destinationKey: string): Promise<void>;
  /** Cheap connectivity probe for /api/ready. */
  healthCheck(): Promise<void>;
}

export class StorageError extends Error {
  public override readonly name = 'StorageError';
  constructor(
    message: string,
    public readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
