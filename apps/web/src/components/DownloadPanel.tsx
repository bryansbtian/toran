'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { formatAbsolute, formatBytes, type PublicShare } from '@toran/shared';
import { Alert, Badge, Button, Card, Field, inputClassName, Spinner } from '@toran/ui';
import { apiErrorMessage, authorizeShare, fetchShare, requestDownload } from '@/lib/api';

function plural(word: string, count: number): string {
  if (count === 1) {
    return word;
  }
  return `${word}s`;
}

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
      setError(apiErrorMessage(caught, 'This link could not be loaded.'));
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
    if (!scanning) {
      return;
    }
    pollRef.current = window.setInterval(() => void load(), 3000);
    return () => {
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
      }
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
      setPasswordError(apiErrorMessage(caught, 'That password could not be checked.'));
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
      setError(apiErrorMessage(caught, 'The download could not start.'));
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
          This Link Isn&apos;t Available
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
            Share Your Own File
          </Link>
        </div>
      </Card>
    );
  }

  if (share.status === 'scanning') {
    let scanningHeading = 'Scanning This File';
    let scanningDetail = '';
    if (share.files.length > 1) {
      scanningHeading = 'Scanning These Files';
      scanningDetail = ', file by file';
    }

    return (
      <Card>
        <div className="flex items-center gap-3">
          <Spinner />
          <div>
            <h1 className="text-xl font-semibold text-ink">{scanningHeading}</h1>
            <p className="mt-1 text-sm text-ink-muted">
              Toran checks every upload for malware before it can be downloaded. This page updates
              automatically{scanningDetail}.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  if (share.passwordProtected && !share.authorized) {
    // Passed as an absent key rather than `error: undefined`, so `Field` does
    // not render an empty alert region before the first failed attempt.
    const fieldError: { error?: string } = {};
    if (passwordError) {
      fieldError.error = passwordError;
    }

    return (
      <Card>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Password Required</h1>
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
          <Field label="Password" htmlFor={passwordId} {...fieldError}>
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

  let expiresLabel = 'Never';
  if (share.expiresAt) {
    expiresLabel = formatAbsolute(new Date(share.expiresAt));
  }

  // A single-file link is titled by its filename, which can overflow and so
  // carries a tooltip. A count never overflows and needs none.
  let heading = single?.filename ?? '';
  let headingTitle: string | undefined = single?.filename;
  let sizeSuffix = '';
  if (many) {
    heading = `${files.length} Files`;
    headingTitle = undefined;
    sizeSuffix = ' total';
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1
            className="truncate text-2xl font-semibold tracking-tight text-ink"
            title={headingTitle}
          >
            {heading}
          </h1>
          <p className="mt-2 text-sm text-ink-muted">
            {formatBytes(totalBytes)}
            {sizeSuffix}
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
                {file.remainingDownloads !== null && (
                  <span data-testid="remaining-downloads">
                    {' · '}
                    {file.remainingDownloads} {plural('download', file.remainingDownloads)} left
                  </span>
                )}
              </p>
            </div>
            {file.status === 'ready' && (
              <Button
                onClick={() => void download(file.fileId)}
                loading={busyFileId === file.fileId}
                disabled={busyFileId !== null}
                data-testid="download"
              >
                Download
                <span className="sr-only"> {file.filename}</span>
              </Button>
            )}
            {file.status === 'scanning' && <Badge tone="warning">Scanning…</Badge>}
            {/*
              Exhausted, blocked, expired or deleted all present the same way:
              the link already reveals that the file exists, and nothing more is
              owed to a visitor holding only the token.
            */}
            {file.status !== 'ready' && file.status !== 'scanning' && (
              <Badge tone="danger">Unavailable</Badge>
            )}
          </li>
        ))}
      </ul>

      <dl className="mt-6 grid grid-cols-1 gap-4 border-t border-line pt-6 sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">Expires</dt>
          <dd className="mt-1 text-sm text-ink">{expiresLabel}</dd>
        </div>
      </dl>

      {error && (
        <div className="mt-6">
          <Alert title="Download Failed">{error}</Alert>
        </div>
      )}

      {downloaded && !error && (
        <div className="mt-6">
          <Alert tone="success">
            Your download has started. If nothing happened, use the button again.
          </Alert>
        </div>
      )}

      <p className="mt-6 border-t border-line pt-6 text-xs text-ink-subtle">
        Toran scans uploads for known malware, but no scanner catches everything. Only open files
        from people you trust.
      </p>
    </Card>
  );
}
