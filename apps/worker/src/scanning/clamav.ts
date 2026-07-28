// SPDX-License-Identifier: MIT
import { Socket } from 'node:net';
import { once } from 'node:events';

/**
 * Minimal clamd client.
 *
 * Implemented directly against the documented TCP protocol rather than through
 * a wrapper library: the protocol is a handful of commands, and this keeps the
 * scanning path free of an unaudited third-party dependency in the one
 * component that touches untrusted bytes.
 *
 * INSTREAM framing:
 *   zINSTREAM\0  then, repeatedly, a 4-byte big-endian chunk length followed by
 *   that many bytes, terminated by a zero length. clamd replies with a single
 *   NUL-terminated line: "stream: OK", "stream: <SIG> FOUND", or an error.
 */
export type ScanVerdict =
  | { readonly kind: 'clean' }
  | { readonly kind: 'infected'; readonly signature: string }
  /** Transient: retry. Never treated as clean. */
  | { readonly kind: 'error'; readonly detail: string; readonly retryable: boolean };

export interface ClamAvOptions {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
  /** Refuse to scan anything larger; clamd would reject it anyway. */
  readonly maxScanBytes: number;
}

export interface Scanner {
  readonly name: string;
  scanStream(stream: NodeJS.ReadableStream, declaredSize: number): Promise<ScanVerdict>;
  ping(): Promise<boolean>;
}

const CHUNK_SIZE = 64 * 1024;

export class ClamAvScanner implements Scanner {
  public readonly name = 'clamav';

  constructor(private readonly options: ClamAvOptions) {}

  async ping(): Promise<boolean> {
    try {
      const reply = await this.command('zPING\0', this.options.timeoutMs);
      return reply.trim() === 'PONG';
    } catch {
      return false;
    }
  }

  async scanStream(stream: NodeJS.ReadableStream, declaredSize: number): Promise<ScanVerdict> {
    if (declaredSize > this.options.maxScanBytes) {
      // Fail closed: an unscannable file must never become `ready`.
      return {
        kind: 'error',
        detail: `object exceeds CLAMAV_MAX_SCAN_BYTES (${this.options.maxScanBytes})`,
        retryable: false,
      };
    }

    const socket = new Socket();
    socket.setTimeout(this.options.timeoutMs);

    try {
      await this.connect(socket);
      socket.write('zINSTREAM\0');

      let sent = 0;
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        sent += buffer.byteLength;
        if (sent > this.options.maxScanBytes) {
          return {
            kind: 'error',
            detail: 'object grew beyond the configured scan limit',
            retryable: false,
          };
        }
        for (let offset = 0; offset < buffer.byteLength; offset += CHUNK_SIZE) {
          const slice = buffer.subarray(offset, offset + CHUNK_SIZE);
          const header = Buffer.allocUnsafe(4);
          header.writeUInt32BE(slice.byteLength, 0);
          if (!socket.write(Buffer.concat([header, slice]))) {
            await once(socket, 'drain');
          }
        }
      }

      // A verdict is only meaningful for the whole object. A storage read that
      // ends early without raising - a truncated response, a provider that
      // silently short-reads - would otherwise have clamd bless a prefix and
      // Toran promote the file to `ready`. Refusing to interpret a reply for a
      // partial stream is what keeps that failure mode closed.
      if (sent !== declaredSize) {
        return {
          kind: 'error',
          detail: `stream ended after ${sent} of ${declaredSize} declared bytes`,
          retryable: true,
        };
      }

      // Zero-length chunk terminates the stream.
      socket.write(Buffer.from([0, 0, 0, 0]));

      const reply = await this.readReply(socket);
      return interpretReply(reply);
    } catch (error) {
      return {
        kind: 'error',
        detail: describe(error),
        // Connection-level problems are worth retrying; the file stays in
        // `scanning` and the job is rescheduled with backoff.
        retryable: true,
      };
    } finally {
      socket.destroy();
    }
  }

  private connect(socket: Socket): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onTimeout = () => {
        cleanup();
        reject(new Error('timed out connecting to clamd'));
      };
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        socket.off('error', onError);
        socket.off('timeout', onTimeout);
        socket.off('connect', onConnect);
      };
      socket.once('error', onError);
      socket.once('timeout', onTimeout);
      socket.once('connect', onConnect);
      socket.connect(this.options.port, this.options.host);
    });
  }

  private readReply(socket: Socket): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const onData = (chunk: Buffer) => {
        chunks.push(chunk);
        // clamd terminates its reply with a NUL when the z-prefix is used.
        if (chunk.includes(0)) {
          cleanup();
          resolve(Buffer.concat(chunks).toString('utf8').replace(/\0+$/, ''));
        }
      };
      const onEnd = () => {
        cleanup();
        const reply = Buffer.concat(chunks).toString('utf8').replace(/\0+$/, '');
        if (reply.length > 0) resolve(reply);
        else reject(new Error('clamd closed the connection without replying'));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onTimeout = () => {
        cleanup();
        reject(new Error('timed out waiting for a clamd reply'));
      };
      const cleanup = () => {
        socket.off('data', onData);
        socket.off('end', onEnd);
        socket.off('error', onError);
        socket.off('timeout', onTimeout);
      };
      socket.on('data', onData);
      socket.once('end', onEnd);
      socket.once('error', onError);
      socket.once('timeout', onTimeout);
    });
  }

  private async command(command: string, timeoutMs: number): Promise<string> {
    const socket = new Socket();
    socket.setTimeout(timeoutMs);
    try {
      await this.connect(socket);
      socket.write(command);
      return await this.readReply(socket);
    } finally {
      socket.destroy();
    }
  }
}

/** NUL, built at runtime so no control character appears in the source. */
const NUL = String.fromCharCode(0);

/** Parses a clamd reply line into a verdict. Exported for unit testing. */
export function interpretReply(reply: string): ScanVerdict {
  // clamd terminates z-prefixed replies with a NUL and some builds pad with
  // trailing whitespace. Splitting on the NUL avoids putting a control
  // character in a regex here.
  const line = (reply.split(NUL)[0] ?? '').trim();
  if (line.length === 0) {
    return { kind: 'error', detail: 'empty reply from clamd', retryable: true };
  }
  // Only clamd's exact INSTREAM success line counts as clean. Matching a looser
  // pattern (anything ending in "OK") would let an unexpected reply - a proxy
  // banner, a future status line, a partially framed response - be read as a
  // clean verdict, which is the one mistake a scanner must never make.
  if (/^stream:\s*OK$/.test(line)) return { kind: 'clean' };
  if (/\bFOUND$/.test(line)) {
    const match = /^stream:\s*(.+?)\s+FOUND$/.exec(line);
    return { kind: 'infected', signature: match?.[1] ?? 'unknown' };
  }
  if (/\bERROR$/i.test(line)) {
    // Size limits are a configuration problem, not a transient one.
    const retryable = !/size limit exceeded/i.test(line);
    return { kind: 'error', detail: line.slice(0, 200), retryable };
  }
  return {
    kind: 'error',
    detail: `unrecognised clamd reply: ${line.slice(0, 120)}`,
    retryable: true,
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 200);
  return 'unknown scanner error';
}

/**
 * Scanner used when `TORAN_SCANNING_ENABLED=false`.
 *
 * Reports every file as clean. `@toran/config` refuses to select this in
 * production, and the UI states plainly that scanning is off.
 */
export class DisabledScanner implements Scanner {
  public readonly name = 'disabled';
  async scanStream(): Promise<ScanVerdict> {
    return { kind: 'clean' };
  }
  async ping(): Promise<boolean> {
    return true;
  }
}
