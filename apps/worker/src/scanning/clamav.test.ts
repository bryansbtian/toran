// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { ClamAvScanner, DisabledScanner, interpretReply } from './clamav.js';

describe('interpretReply', () => {
  it('reads a clean verdict', () => {
    expect(interpretReply('stream: OK')).toEqual({ kind: 'clean' });
    // clamd terminates z-replies with a NUL and may pad with whitespace.
    expect(interpretReply('stream: OK' + String.fromCharCode(0))).toEqual({ kind: 'clean' });
    expect(interpretReply('stream: OK   ')).toEqual({ kind: 'clean' });
  });

  it('extracts the signature from an infected verdict', () => {
    expect(interpretReply('stream: Win.Test.EICAR_HDB-1 FOUND')).toEqual({
      kind: 'infected',
      signature: 'Win.Test.EICAR_HDB-1',
    });
  });

  it('handles a signature containing spaces', () => {
    expect(interpretReply('stream: Some Long Signature Name FOUND')).toEqual({
      kind: 'infected',
      signature: 'Some Long Signature Name',
    });
  });

  it('treats a generic error as retryable', () => {
    const verdict = interpretReply('INSTREAM: Unexpected ERROR');
    expect(verdict.kind).toBe('error');
    if (verdict.kind === 'error') expect(verdict.retryable).toBe(true);
  });

  it('treats a size-limit error as permanent', () => {
    const verdict = interpretReply('INSTREAM size limit exceeded. ERROR');
    expect(verdict.kind).toBe('error');
    if (verdict.kind === 'error') expect(verdict.retryable).toBe(false);
  });

  it('never reads an empty or unknown reply as clean', () => {
    expect(interpretReply('').kind).toBe('error');
    expect(interpretReply('   ').kind).toBe('error');
    expect(interpretReply('something unexpected').kind).toBe('error');
  });
});

/** Minimal clamd stand-in speaking just enough of the protocol. */
function fakeClamd(reply: string, options: { closeEarly?: boolean } = {}): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      let seenTerminator = false;
      socket.on('data', (chunk) => {
        // The INSTREAM terminator is a zero-length chunk header.
        if (chunk.includes(Buffer.from([0, 0, 0, 0]))) seenTerminator = true;
        if (!seenTerminator) return;
        if (options.closeEarly) {
          socket.destroy();
          return;
        }
        socket.write(reply + String.fromCharCode(0));
        socket.end();
      });
      socket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function portOf(server: Server): number {
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return address.port;
}

describe('ClamAvScanner', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  });

  const scanner = (port: number, maxScanBytes = 1024 * 1024) =>
    new ClamAvScanner({ host: '127.0.0.1', port, timeoutMs: 5000, maxScanBytes });

  it('reports a clean stream', async () => {
    server = await fakeClamd('stream: OK');
    const verdict = await scanner(portOf(server)).scanStream(
      Readable.from([Buffer.from('harmless')]),
      8,
    );
    expect(verdict).toEqual({ kind: 'clean' });
  });

  it('reports an infected stream', async () => {
    server = await fakeClamd('stream: Eicar-Signature FOUND');
    const verdict = await scanner(portOf(server)).scanStream(
      Readable.from([Buffer.from('bad')]),
      3,
    );
    expect(verdict).toEqual({ kind: 'infected', signature: 'Eicar-Signature' });
  });

  it('fails closed rather than clean when the connection drops', async () => {
    server = await fakeClamd('stream: OK', { closeEarly: true });
    const verdict = await scanner(portOf(server)).scanStream(Readable.from([Buffer.from('x')]), 1);
    expect(verdict.kind).toBe('error');
    if (verdict.kind === 'error') expect(verdict.retryable).toBe(true);
  });

  it('fails closed when clamd is unreachable', async () => {
    // Port 1 is reserved and nothing listens on it.
    const verdict = await scanner(1).scanStream(Readable.from([Buffer.from('x')]), 1);
    expect(verdict.kind).toBe('error');
    if (verdict.kind === 'error') expect(verdict.retryable).toBe(true);
  });

  it('refuses to scan an object above the configured ceiling', async () => {
    server = await fakeClamd('stream: OK');
    const verdict = await scanner(portOf(server), 100).scanStream(
      Readable.from([Buffer.from('x')]),
      1000,
    );
    expect(verdict.kind).toBe('error');
    // Permanent: no retry will make an oversized object scannable.
    if (verdict.kind === 'error') expect(verdict.retryable).toBe(false);
  });

  it('stops when a stream grows past the ceiling mid-scan', async () => {
    server = await fakeClamd('stream: OK');
    const oversized = Readable.from([Buffer.alloc(200, 1)]);
    // Declared size passes the pre-check; the actual stream does not.
    const verdict = await scanner(portOf(server), 100).scanStream(oversized, 50);
    expect(verdict.kind).toBe('error');
    if (verdict.kind === 'error') expect(verdict.retryable).toBe(false);
  });

  it('streams a payload larger than one chunk', async () => {
    server = await fakeClamd('stream: OK');
    const chunks = Array.from({ length: 5 }, () => Buffer.alloc(64 * 1024, 7));
    const verdict = await scanner(portOf(server), 10 * 1024 * 1024).scanStream(
      Readable.from(chunks),
      chunks.length * 64 * 1024,
    );
    expect(verdict).toEqual({ kind: 'clean' });
  });

  it('reports an unreachable clamd from ping', async () => {
    await expect(scanner(1).ping()).resolves.toBe(false);
  });
});

describe('DisabledScanner', () => {
  it('is only ever used when scanning is explicitly turned off', async () => {
    const scanner = new DisabledScanner();
    expect(scanner.name).toBe('disabled');
    await expect(scanner.scanStream()).resolves.toEqual({ kind: 'clean' });
    await expect(scanner.ping()).resolves.toBe(true);
  });
});
