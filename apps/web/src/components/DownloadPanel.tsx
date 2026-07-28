// SPDX-License-Identifier: MIT
'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { formatAbsolute, formatBytes, type PublicShare } from '@toran/shared';
import { Alert, Badge, Button, Card, Field, inputClassName, Spinner } from '@toran/ui';
import { ApiError, authorizeShare, fetchShare, requestDownload } from '@/lib/api';

export function DownloadPanel({ token }: { readonly token: string }) {
  const passwordId = useId();
  const [share, setShare] = useState<PublicShare | null>(null);
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  /** Which file's download is in flight, so only that button shows a spinner. */
  const [busyFileId, setBusyFileId] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const pollRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await fetchShare(token);
      setShare(next);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'This link could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // Polls while anything is still being scanned, so a visitor who arrives
  // immediately after upload sees files become downloadable without reloading.
  // A link with one ready file and one still scanning reports itself as ready,
  // so the link's own status is not enough to decide whether to keep polling.
  const scanning =
    share?.status === 'scanning' ||
    (share?.files.some((file) => file.status === 'scanning') ?? false);

  useEffect(() => {
    if (!scanning) return;
    pollRef.current = window.setInterval(() => void load(), 3000);
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [scanning, load]);

  const authorize = async () => {
    setPasswordError(null);
    setWorking(true);
    try {
      await authorizeShare(token, password);
      setPassword('');
      await load();
    } catch (caught) {
      setPasswordError(
        caught instanceof ApiError ? caught.message : 'That password could not be checked.',
      );
    } finally {
      setWorking(false);
    }
  };

  const download = async (fileId: string) => {
    setError(null);
    setBusyFileId(fileId);
    try {
      const result = await requestDownload(token, fileId);
      setDownloaded(true);
      // Navigating rather than opening a tab keeps the presigned URL out of a
      // window Toran cannot control, and the storage response is an attachment.
      window.location.href = result.url;
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The download could not start.');
      await load();
    } finally {
      setBusyFileId(null);
    }
  };

  if (loading) {
    return (
      <Card>
        <div className="flex items-center gap-3 text-sm text-ink-muted">
          <Spinner />
          <span>Checking this link…</span>
        </div>
      </Card>
    );
  }

  if (!share || share.status === 'unavailable') {
    return (
      <Card>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          This link isn&apos;t available
        </h1>
        <p className="mt-3 text-sm text-ink-muted">
          The link may have expired, reached its download limit, been revoked by the person who
          created it, or never existed. Toran does not say which, so links cannot be probed.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/"
            className="inline-flex items-center rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            Share your own file
          </Link>
          <Link
            href="/report"
            className="inline-flex items-center rounded-lg border border-line px-4 py-2.5 text-sm font-medium text-ink hover:bg-surface-sunken"
          >
            Report this link
          </Link>
        </div>
      </Card>
    );
  }

  if (share.status === 'scanning') {
    return (
      <Card>
        <div className="flex items-center gap-3">
          <Spinner />
          <div>
            <h1 className="text-xl font-semibold text-ink">
              {share.files.length > 1 ? 'Scanning these files' : 'Scanning this file'}
            </h1>
            <p className="mt-1 text-sm text-ink-muted">
              Toran checks every upload for malware before it can be downloaded. This page updates
              automatically{share.files.length > 1 ? ', file by file' : ''}.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  if (share.passwordProtected && !share.authorized) {
    return (
      <Card>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Password required</h1>
        <p className="mt-2 text-sm text-ink-muted">
          The person who shared this file protected it with a password.
        </p>
        <form
          className="mt-6 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void authorize();
          }}
        >
          <Field
            label="Password"
            htmlFor={passwordId}
            {...(passwordError ? { error: passwordError } : {})}
          >
            <input
              id={passwordId}
              type="password"
              autoComplete="off"
              autoFocus
              required
              className={inputClassName}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <Button type="submit" loading={working} disabled={password.length === 0}>
            Unlock
          </Button>
        </form>
      </Card>
    );
  }

  const files = share.files;
  const many = files.length > 1;
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const single = files[0];

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1
            className="truncate text-2xl font-semibold tracking-tight text-ink"
            title={many ? undefined : single?.filename}
          >
            {many ? `${files.length} files` : (single?.filename ?? '')}
          </h1>
          <p className="mt-2 text-sm text-ink-muted">
            {formatBytes(totalBytes)}
            {many ? ' total · pick the ones you want' : ''}
          </p>
        </div>
        <Badge tone="success">Ready</Badge>
      </div>

      <ul className="mt-6 space-y-2 border-t border-line pt-6" data-testid="share-files">
        {files.map((file) => (
          <li
            key={file.fileId}
            className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-sunken px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink" title={file.filename}>
                {file.filename}
              </p>
              <p className="text-xs text-ink-muted">
                {formatBytes(file.size)}
                {file.remainingDownloads !== null ? (
                  <span data-testid="remaining-downloads">
                    {' · '}
                    {file.remainingDownloads} download
                    {file.remainingDownloads === 1 ? '' : 's'} left
                  </span>
                ) : null}
              </p>
            </div>
            {file.status === 'ready' ? (
              <Button
                onClick={() => void download(file.fileId)}
                loading={busyFileId === file.fileId}
                disabled={busyFileId !== null}
                data-testid="download"
              >
                Download
                <span className="sr-only"> {file.filename}</span>
              </Button>
            ) : file.status === 'scanning' ? (
              <Badge tone="warning">Scanning…</Badge>
            ) : (
              // Exhausted, blocked, expired or deleted all present the same way:
              // the link already reveals that the file exists, and nothing more
              // is owed to a visitor holding only the token.
              <Badge tone="danger">Unavailable</Badge>
            )}
          </li>
        ))}
      </ul>

      <dl className="mt-6 grid grid-cols-1 gap-4 border-t border-line pt-6 sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">Expires</dt>
          <dd className="mt-1 text-sm text-ink">
            {share.expiresAt ? formatAbsolute(new Date(share.expiresAt)) : 'Never'}
          </dd>
        </div>
      </dl>

      {error ? (
        <div className="mt-6">
          <Alert title="Download failed">{error}</Alert>
        </div>
      ) : null}

      {downloaded && !error ? (
        <div className="mt-6">
          <Alert tone="success">
            Your download has started. If nothing happened, use the button again.
          </Alert>
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-6">
        <Link
          href="/report"
          className="text-xs font-medium text-ink-muted underline underline-offset-2 hover:text-ink"
        >
          Report this file
        </Link>
      </div>

      <p className="mt-4 text-xs text-ink-subtle">
        Toran scans uploads for known malware, but no scanner catches everything. Only open files
        from people you trust.
      </p>
    </Card>
  );
}
