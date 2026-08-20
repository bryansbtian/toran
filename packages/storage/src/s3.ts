import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { contentDispositionAttachment } from '@toran/shared';
import { assertValidStorageKey } from './keys.js';
import {
  StorageError,
  type CreateDownloadUrlInput,
  type CreateUploadUrlInput,
  type PresignedUpload,
  type StorageProvider,
  type StoredObjectMetadata,
} from './types.js';

export interface S3StorageOptions {
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Omit for AWS S3. Required for MinIO and other S3-compatible endpoints. */
  readonly endpoint?: string | undefined;
  /**
   * Host the browser should be sent to, when it differs from the endpoint used
   * for signing. Only the origin is rewritten, so the SigV4 signature (which
   * does not cover the host for query-signed URLs with an unsigned host header)
   * stays valid.
   */
  readonly publicEndpoint?: string | undefined;
  readonly forcePathStyle: boolean;
  /** Injectable for tests. */
  readonly client?: S3Client;
}

const RETRYABLE_CODES = new Set([
  'InternalError',
  'RequestTimeout',
  'ServiceUnavailable',
  'SlowDown',
  'ThrottlingException',
  'RequestTimeTooSkewed',
]);

export class S3Storage implements StorageProvider {
  public readonly name = 's3';
  private readonly client: S3Client;

  constructor(private readonly options: S3StorageOptions) {
    this.client =
      options.client ??
      new S3Client({
        region: options.region,
        ...endpointOverride(options.endpoint),
        forcePathStyle: options.forcePathStyle,
        credentials: {
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey,
        },
        // The SDK otherwise attaches a CRC32 of an *empty* body to presigned
        // PUT URLs, because it has no body to hash at signing time. A browser
        // uploading real bytes would then contradict the pinned checksum.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });
  }

  async createUploadUrl(input: CreateUploadUrlInput): Promise<PresignedUpload> {
    assertValidStorageKey(input.key);
    const command = new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: input.key,
      ContentType: input.contentType,
      ContentLength: input.contentLength,
    });

    const url = await this.sign(() =>
      getSignedUrl(this.client, command, { expiresIn: input.expiresInSeconds }),
    );

    return {
      url: this.toPublicUrl(url),
      method: 'PUT',
      // Signed headers. The browser must echo these exactly; anything else
      // produces a signature mismatch, which is how the declared size and type
      // are enforced at the storage layer rather than only in our API.
      headers: {
        'Content-Type': input.contentType,
        'Content-Length': String(input.contentLength),
      },
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    };
  }

  async createDownloadUrl(input: CreateDownloadUrlInput): Promise<string> {
    assertValidStorageKey(input.key);
    const command = new GetObjectCommand({
      Bucket: this.options.bucket,
      Key: input.key,
      // Response overrides make storage serve the original filename and a
      // neutralised content type without ever storing either in the key.
      ResponseContentDisposition: contentDispositionAttachment(input.downloadFilename),
      ResponseContentType: input.contentType,
    });
    return this.toPublicUrl(
      await this.sign(() =>
        getSignedUrl(this.client, command, { expiresIn: input.expiresInSeconds }),
      ),
    );
  }

  async headObject(key: string): Promise<StoredObjectMetadata | null> {
    assertValidStorageKey(key);
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      return {
        key,
        size: Number(response.ContentLength ?? 0),
        contentType: response.ContentType,
        etag: response.ETag?.replaceAll('"', ''),
        lastModified: response.LastModified,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw wrap(error, 'failed to read object metadata');
    }
  }

  async getObjectStream(key: string): Promise<NodeJS.ReadableStream> {
    assertValidStorageKey(key);
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      const body = response.Body;
      if (!body || typeof (body as NodeJS.ReadableStream).pipe !== 'function') {
        throw new StorageError('object body is not a readable stream', false);
      }
      return body as NodeJS.ReadableStream;
    } catch (error) {
      if (isNotFound(error)) {
        throw new StorageError('object not found', false, { cause: error });
      }
      throw wrap(error, 'failed to read object');
    }
  }

  async deleteObject(key: string): Promise<void> {
    assertValidStorageKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
    } catch (error) {
      // S3 delete is already idempotent, but some compatible implementations
      // surface a 404 rather than succeeding.
      if (isNotFound(error)) {
        return;
      }
      throw wrap(error, 'failed to delete object');
    }
  }

  async copyObject(sourceKey: string, destinationKey: string): Promise<void> {
    assertValidStorageKey(sourceKey);
    assertValidStorageKey(destinationKey);
    try {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.options.bucket,
          Key: destinationKey,
          CopySource: `${this.options.bucket}/${sourceKey}`,
        }),
      );
    } catch (error) {
      throw wrap(error, 'failed to copy object');
    }
  }

  async healthCheck(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.options.bucket }));
    } catch (error) {
      throw wrap(error, 'bucket is not reachable');
    }
  }

  /**
   * Takes a thunk rather than a command so the SDK's generics resolve against
   * the concrete command type at each call site.
   */
  private async sign(signer: () => Promise<string>): Promise<string> {
    try {
      return await signer();
    } catch (error) {
      throw wrap(error, 'failed to sign a storage url');
    }
  }

  /**
   * Rewrites only the origin, so a browser on the host can reach an endpoint
   * that the server addresses by its internal service name.
   */
  private toPublicUrl(signedUrl: string): string {
    if (!this.options.publicEndpoint || !this.options.endpoint) {
      return signedUrl;
    }
    if (this.options.publicEndpoint === this.options.endpoint) {
      return signedUrl;
    }
    const source = new URL(signedUrl);
    const target = new URL(this.options.publicEndpoint);
    source.protocol = target.protocol;
    source.host = target.host;
    return source.toString();
  }
}

function isNotFound(error: unknown): boolean {
  if (error instanceof S3ServiceException) {
    const status = error.$metadata?.httpStatusCode;
    return status === 404 || error.name === 'NotFound' || error.name === 'NoSuchKey';
  }
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error.name === 'NotFound' || error.name === 'NoSuchKey')
  );
}

/**
 * Converts an SDK failure into a Toran error carrying no endpoint, credential
 * or request-signing detail. The original is kept as `cause` for structured
 * logs, which redact it before serialisation.
 */
/**
 * An absent endpoint has to be an absent key: the SDK reads an explicit
 * `endpoint: undefined` as a configured value and stops resolving the default.
 */
function endpointOverride(endpoint: string | undefined): { endpoint?: string } {
  if (!endpoint) {
    return {};
  }
  return { endpoint };
}

function errorCode(error: unknown): string {
  if (error instanceof S3ServiceException) {
    return error.name ?? '';
  }
  if (typeof error === 'object' && error !== null && 'name' in error) {
    return String(error.name);
  }
  return '';
}

function wrap(error: unknown, message: string): StorageError {
  const code = errorCode(error);
  let status = 0;
  if (error instanceof S3ServiceException) {
    status = error.$metadata?.httpStatusCode ?? 0;
  }
  const retryable = RETRYABLE_CODES.has(code) || status >= 500 || status === 429;
  return new StorageError(message, retryable, { cause: error });
}
