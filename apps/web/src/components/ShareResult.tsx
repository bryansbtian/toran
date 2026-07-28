// SPDX-License-Identifier: MIT
'use client';

import { useRef, useState } from 'react';
import { formatAbsolute, formatBytes } from '@toran/shared';
import { Alert, Badge, Button, Card } from '@toran/ui';
import { ApiError, revokeShare, type ShareResponse } from '@/lib/api';
import { copyText } from '@/lib/clipboard';

export interface ShareResultProps {
  readonly result: ShareResponse;
  readonly scanningEnabled: boolean;
  readonly onCreateAnother: () => void;
}

export function ShareResult({ result, scanningEnabled, onCreateAnother }: ShareResultProps) {
  const [copied, setCopied] = useState(false);
  const [revoked, setRevoked] = useState(result.share.revokedAt !== null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const urlField = useRef<HTMLInputElement>(null);

  const url = result.share.url;
  const files = result.share.files;
  const many = files.length > 1;
  const scanning = files.some((file) => file.status === 'scanning');
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  const copy = async () => {
    setError(null);
    // Falls back to selecting the field when the Clipboard API is missing, as it
    // is on any plain-http origin other than localhost.
    if (await copyText(url, urlField.current)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
      return;
    }
    setError('Could not copy automatically. The link is selected - press Ctrl+C to copy it.');
  };

  const revoke = async () => {
    setError(null);
    setWorking(true);
    try {
      await revokeShare(result.share.shareId, result.shareManageKey);
      setRevoked(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not revoke this link.');
    } finally {
      setWorking(false);
    }
  };

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Your link is ready</h1>
          <p className="mt-2 text-sm text-ink-muted">
            {revoked
              ? 'This link has been revoked and can no longer be used.'
              : many
                ? `Anyone with this link can download these ${files.length} files until it expires.`
                : 'Anyone with this link can download the file until it expires.'}
          </p>
        </div>
        <Badge tone={revoked ? 'danger' : scanning ? 'warning' : 'success'}>
          {revoked ? 'Revoked' : scanning ? 'Scanning' : 'Active'}
        </Badge>
      </div>

      {!revoked && scanning && scanningEnabled ? (
        <div className="mt-4">
          <Alert tone="warning" title="Scanning in progress">
            {many
              ? 'The files are being checked for malware. Each one starts working as soon as its ' +
                'own scan finishes - usually within a few seconds.'
              : 'The file is being checked for malware. The link will start working as soon as ' +
                'the scan finishes - usually within a few seconds.'}
          </Alert>
        </div>
      ) : null}

      <div className="mt-6 space-y-3">
        <label htmlFor="share-url" className="block text-sm font-medium text-ink">
          Sharing link
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="share-url"
            ref={urlField}
            readOnly
            value={url}
            data-testid="share-url"
            onFocus={(event) => event.currentTarget.select()}
            className="block w-full rounded-lg border border-line bg-surface-sunken px-3 py-2.5 font-mono text-sm text-ink"
          />
          <Button onClick={copy} className="shrink-0">
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        </div>
        <p aria-live="polite" className="text-xs text-success-800">
          {copied ? 'Link copied to your clipboard.' : ''}
        </p>
      </div>

      <div className="mt-6 border-t border-line pt-6">
        <h2 className="text-sm font-medium text-ink">
          {many ? `${files.length} files` : 'File'}
          {many ? (
            <span className="ml-2 font-normal text-ink-subtle">
              {formatBytes(totalBytes)} total
            </span>
          ) : null}
        </h2>
        <ul className="mt-3 space-y-2" data-testid="share-files">
          {files.map((file) => (
            <li
              key={file.fileId}
              className="flex items-center gap-3 rounded-lg border border-line bg-surface-sunken px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink" title={file.filename}>
                  {file.filename}
                </p>
                <p className="text-xs text-ink-muted">{formatBytes(file.size)}</p>
              </div>
              {file.status === 'scanning' ? (
                <Badge tone="warning">Scanning</Badge>
              ) : file.status === 'ready' ? (
                <Badge tone="success">Ready</Badge>
              ) : (
                <Badge tone="danger">Unavailable</Badge>
              )}
            </li>
          ))}
        </ul>
      </div>

      <dl className="mt-6 grid grid-cols-1 gap-4 border-t border-line pt-6 sm:grid-cols-2">
        <Detail
          label="Expires"
          value={
            result.share.expiresAt ? formatAbsolute(new Date(result.share.expiresAt)) : 'Never'
          }
        />
        <Detail
          label="Download limit"
          value={
            result.share.maxDownloads === null
              ? 'Unlimited'
              : many
                ? `${result.share.maxDownloads} per file`
                : String(result.share.maxDownloads)
          }
        />
        <Detail
          label="Password"
          value={result.share.passwordProtected ? 'Required' : 'Not required'}
        />
        <Detail label="Status" value={revoked ? 'Revoked' : 'Active'} />
      </dl>

      {error ? (
        <div className="mt-4">
          <Alert>{error}</Alert>
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-3 border-t border-line pt-6">
        <Button variant="secondary" onClick={onCreateAnother}>
          Create another link
        </Button>
        {!revoked ? (
          <Button variant="danger" onClick={revoke} loading={working} data-testid="revoke">
            Revoke link
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

function Detail({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">{label}</dt>
      <dd className="mt-1 break-words text-sm text-ink">{value}</dd>
    </div>
  );
}
