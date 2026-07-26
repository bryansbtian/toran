// SPDX-License-Identifier: AGPL-3.0-only
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

  // While a file is being scanned the page polls, so a visitor who arrives
  // immediately after upload sees the link become usable without reloading.
  useEffect(() => {
    if (share?.status !== 'scanning') return;
    pollRef.current = window.setInterval(() => void load(), 3000);
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [share?.status, load]);

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

  const download = async () => {
    setError(null);
    setWorking(true);
    try {
      const result = await requestDownload(token);
      setDownloaded(true);
      // Navigating rather than opening a tab keeps the presigned URL out of a
      // window Toran cannot control, and the storage response is an attachment.
      window.location.href = result.url;
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The download could not start.');
      await load();
    } finally {
      setWorking(false);
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
            <h1 className="text-xl font-semibold text-ink">Scanning this file</h1>
            <p className="mt-1 text-sm text-ink-muted">
              Toran checks every upload for malware before it can be downloaded. This page updates
              automatically.
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

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1
            className="truncate text-2xl font-semibold tracking-tight text-ink"
            title={share.filename}
          >
            {share.filename}
          </h1>
          <p className="mt-2 text-sm text-ink-muted">{formatBytes(share.size)}</p>
        </div>
        <Badge tone="success">Ready</Badge>
      </div>

      <dl className="mt-6 grid grid-cols-1 gap-4 border-t border-line pt-6 sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">Expires</dt>
          <dd className="mt-1 text-sm text-ink">
            {share.expiresAt ? formatAbsolute(new Date(share.expiresAt)) : 'Never'}
          </dd>
        </div>
        {share.remainingDownloads !== null ? (
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
              Downloads left
            </dt>
            <dd className="mt-1 text-sm text-ink" data-testid="remaining-downloads">
              {share.remainingDownloads}
            </dd>
          </div>
        ) : null}
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
        <Button onClick={download} loading={working} data-testid="download">
          Download
        </Button>
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
