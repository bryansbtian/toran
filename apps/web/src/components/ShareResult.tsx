// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useState } from 'react';
import { formatAbsolute, formatBytes } from '@toran/shared';
import { Alert, Badge, Button, Card } from '@toran/ui';
import { ApiError, revokeShare, type CompleteResponse } from '@/lib/api';

export interface ShareResultProps {
  readonly result: CompleteResponse;
  readonly scanningEnabled: boolean;
  readonly onCreateAnother: () => void;
}

export function ShareResult({ result, scanningEnabled, onCreateAnother }: ShareResultProps) {
  const [copied, setCopied] = useState(false);
  const [revoked, setRevoked] = useState(result.share.revokedAt !== null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const url = result.share.url;

  const copy = async () => {
    setError(null);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setError('Could not copy automatically. Select the link and copy it manually.');
    }
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
              : 'Anyone with this link can download the file until it expires.'}
          </p>
        </div>
        <Badge tone={revoked ? 'danger' : result.file.status === 'ready' ? 'success' : 'warning'}>
          {revoked ? 'Revoked' : result.file.status === 'ready' ? 'Active' : 'Scanning'}
        </Badge>
      </div>

      {!revoked && result.file.status === 'scanning' && scanningEnabled ? (
        <div className="mt-4">
          <Alert tone="warning" title="Scanning in progress">
            The file is being checked for malware. The link will start working as soon as the scan
            finishes — usually within a few seconds.
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

      <dl className="mt-6 grid grid-cols-1 gap-4 border-t border-line pt-6 sm:grid-cols-2">
        <Detail label="File name" value={result.file.filename} />
        <Detail label="Size" value={formatBytes(result.file.size)} />
        <Detail
          label="Expires"
          value={
            result.share.expiresAt ? formatAbsolute(new Date(result.share.expiresAt)) : 'Never'
          }
        />
        <Detail
          label="Download limit"
          value={
            result.share.maxDownloads === null ? 'Unlimited' : String(result.share.maxDownloads)
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
