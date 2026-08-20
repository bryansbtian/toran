'use client';

import { useEffect, useRef, useState } from 'react';
import { formatAbsolute, formatBytes, type PublicShareFile } from '@toran/shared';
import { Alert, Badge, Button, Card } from '@toran/ui';
import { apiErrorMessage, fetchShare, revokeShare, type ShareResponse } from '@/lib/api';
import { copyText } from '@/lib/clipboard';

export interface ShareResultProps {
  readonly result: ShareResponse;
  readonly scanningEnabled: boolean;
  readonly onCreateAnother: () => void;
}

type ShareFile = ShareResponse['share']['files'][number];
type FileStatus = ShareFile['status'];
/** A poll reports a narrower set of statuses than the stored file carries. */
type DisplayStatus = FileStatus | PublicShareFile['status'];

interface FileBadge {
  readonly tone: 'success' | 'warning' | 'danger';
  readonly label: string;
}

function fileBadge(status: DisplayStatus): FileBadge {
  if (status === 'scanning') {
    return { tone: 'warning', label: 'Scanning' };
  }
  if (status === 'ready') {
    return { tone: 'success', label: 'Ready' };
  }
  // Every other status collapses to one label on purpose, so the badge cannot
  // be read as a reason the file is unavailable.
  return { tone: 'danger', label: 'Unavailable' };
}

export function ShareResult({ result, scanningEnabled, onCreateAnother }: ShareResultProps) {
  const [copied, setCopied] = useState(false);
  const [revoked, setRevoked] = useState(result.share.revokedAt !== null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  // The creation response is a snapshot taken before any scan could finish, so
  // on its own this page would show "Scanning" until the uploader reloaded.
  const [liveStatuses, setLiveStatuses] = useState<Record<string, PublicShareFile['status']>>({});
  const urlField = useRef<HTMLInputElement>(null);

  const url = result.share.url;
  const files = result.share.files;
  const token = result.share.token;
  const many = files.length > 1;
  const statusOf = (file: ShareFile): DisplayStatus => {
    return liveStatuses[file.fileId] ?? file.status;
  };
  const scanning = files.some((file) => statusOf(file) === 'scanning');
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  // Mirrors the share page's own poll, so the uploader watching this screen and
  // a visitor watching the link see a file become ready at the same time.
  useEffect(() => {
    // A revoked link never becomes ready, so there is nothing left to watch.
    if (!token || !scanning || revoked) {
      return;
    }

    const poll = async (): Promise<void> => {
      try {
        const next = await fetchShare(token);
        setLiveStatuses((current) => {
          const merged = { ...current };
          // An unavailable link reports no files at all. Without this the merge
          // would be a no-op and the page would poll forever showing "Scanning".
          if (next.files.length === 0) {
            for (const file of files) {
              merged[file.fileId] = 'unavailable';
            }
            return merged;
          }
          for (const file of next.files) {
            merged[file.fileId] = file.status;
          }
          return merged;
        });
      } catch {
        // A failed poll leaves the last known status in place and the next tick
        // retries. The link itself works regardless of what this page shows.
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => {
      window.clearInterval(timer);
    };
  }, [token, scanning, revoked, files]);

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
      setError(apiErrorMessage(caught, 'Could not revoke this link.'));
    } finally {
      setWorking(false);
    }
  };

  // Revocation outranks scanning: a revoked link never becomes usable, so
  // reporting it as still being scanned would be a promise Toran cannot keep.
  let statusTone: 'success' | 'warning' | 'danger' = 'success';
  let statusLabel = 'Active';
  let summary = 'Anyone with this link can download the file until it expires.';
  if (many) {
    summary = `Anyone with this link can download these ${files.length} files until it expires.`;
  }
  if (revoked) {
    statusTone = 'danger';
    statusLabel = 'Revoked';
    summary = 'This link has been revoked and can no longer be used.';
  } else if (scanning) {
    statusTone = 'warning';
    statusLabel = 'Scanning';
  }

  let scanningMessage =
    'The file is being checked for malware. The link will start working as soon as ' +
    'the scan finishes - usually within a few seconds.';
  if (many) {
    scanningMessage =
      'The files are being checked for malware. Each one starts working as soon as its ' +
      'own scan finishes - usually within a few seconds.';
  }

  let copyLabel = 'Copy Link';
  if (copied) {
    copyLabel = 'Copied';
  }

  let filesHeading = 'File';
  if (many) {
    filesHeading = `${files.length} Files`;
  }

  let expiresLabel = 'Never';
  if (result.share.expiresAt) {
    expiresLabel = formatAbsolute(new Date(result.share.expiresAt));
  }

  // The limit is per file, so a multi-file link has to say so or the number
  // reads as a budget shared across the whole link.
  let downloadLimitLabel = 'Unlimited';
  if (result.share.maxDownloads !== null) {
    downloadLimitLabel = String(result.share.maxDownloads);
    if (many) {
      downloadLimitLabel = `${result.share.maxDownloads} Per File`;
    }
  }

  let passwordLabel = 'Not Required';
  if (result.share.passwordProtected) {
    passwordLabel = 'Required';
  }

  // The detail row reports the link itself, which is either revoked or not.
  // Scanning is a property of the files and is shown per file below.
  let linkStateLabel = 'Active';
  if (revoked) {
    linkStateLabel = 'Revoked';
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Your Link Is Ready</h1>
          <p className="mt-2 text-sm text-ink-muted">{summary}</p>
        </div>
        <Badge tone={statusTone}>{statusLabel}</Badge>
      </div>

      {!revoked && scanning && scanningEnabled && (
        <div className="mt-4">
          <Alert tone="warning" title="Scanning in Progress">
            {scanningMessage}
          </Alert>
        </div>
      )}

      <div className="mt-6 space-y-3">
        <label htmlFor="share-url" className="block text-sm font-medium text-ink">
          Sharing Link
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
            {copyLabel}
          </Button>
        </div>
        <p aria-live="polite" className="text-xs text-success-800">
          {copied && 'Link copied to your clipboard.'}
        </p>
      </div>

      <div className="mt-6 border-t border-line pt-6">
        <h2 className="text-sm font-medium text-ink">
          {filesHeading}
          {many && (
            <span className="ml-2 font-normal text-ink-subtle">
              {formatBytes(totalBytes)} total
            </span>
          )}
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
              <Badge tone={fileBadge(statusOf(file)).tone}>{fileBadge(statusOf(file)).label}</Badge>
            </li>
          ))}
        </ul>
      </div>

      <dl className="mt-6 grid grid-cols-1 gap-4 border-t border-line pt-6 sm:grid-cols-2">
        <Detail label="Expires" value={expiresLabel} />
        <Detail label="Download Limit" value={downloadLimitLabel} />
        <Detail label="Password" value={passwordLabel} />
        <Detail label="Status" value={linkStateLabel} />
      </dl>

      {error && (
        <div className="mt-4">
          <Alert>{error}</Alert>
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-3 border-t border-line pt-6">
        <Button variant="secondary" onClick={onCreateAnother}>
          Create Another Link
        </Button>
        {!revoked && (
          <Button variant="danger" onClick={revoke} loading={working} data-testid="revoke">
            Revoke Link
          </Button>
        )}
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
