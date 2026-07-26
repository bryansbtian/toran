// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useCallback, useId, useMemo, useRef, useState, type DragEvent } from 'react';
import { expiryChoices, formatBytes } from '@toran/shared';
import { Alert, Button, Card, Field, inputClassName, ProgressBar } from '@toran/ui';
import {
  ApiError,
  beginUpload,
  cancelUpload,
  completeUpload,
  uploadToStorage,
  type CompleteResponse,
} from '@/lib/api';
import { ShareResult } from './ShareResult';

export interface UploadPanelProps {
  readonly maxFileSizeBytes: number;
  readonly maxExpirySeconds: number;
  readonly defaultExpirySeconds: number;
  readonly maxDownloadLimit: number;
  readonly scanningEnabled: boolean;
}

type Phase = 'idle' | 'uploading' | 'finalising' | 'done';

export function UploadPanel(props: UploadPanelProps) {
  const fileInputId = useId();
  const expiryId = useId();
  const passwordId = useId();
  const downloadsId = useId();

  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const uploadIdRef = useRef<{ uploadId: string; manageKey: string } | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [result, setResult] = useState<CompleteResponse | null>(null);

  const [expiry, setExpiry] = useState(String(props.defaultExpirySeconds));
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState('');
  const [useDownloadLimit, setUseDownloadLimit] = useState(false);
  const [downloadLimit, setDownloadLimit] = useState('1');

  const choices = useMemo(() => expiryChoices(props.maxExpirySeconds), [props.maxExpirySeconds]);

  const selectFile = useCallback(
    (next: File | null) => {
      setError(null);
      setFileError(null);
      if (!next) {
        setFile(null);
        return;
      }
      if (next.size === 0) {
        setFile(null);
        setFileError('That file is empty. Choose a file with content.');
        return;
      }
      if (next.size > props.maxFileSizeBytes) {
        setFile(null);
        setFileError(
          `That file is ${formatBytes(next.size)}. This server accepts up to ${formatBytes(
            props.maxFileSizeBytes,
          )}.`,
        );
        return;
      }
      setFile(next);
    },
    [props.maxFileSizeBytes],
  );

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    selectFile(event.dataTransfer.files?.[0] ?? null);
  };

  const reset = () => {
    abortRef.current = null;
    uploadIdRef.current = null;
    setFile(null);
    setPhase('idle');
    setPercent(0);
    setError(null);
    setFileError(null);
    setResult(null);
    setPassword('');
    setUsePassword(false);
    setUseDownloadLimit(false);
    setDownloadLimit('1');
    if (inputRef.current) inputRef.current.value = '';
  };

  const cancel = async () => {
    abortRef.current?.abort();
    const pending = uploadIdRef.current;
    if (pending) {
      // Best effort: the stale-upload cleanup job reclaims the object even if
      // this call never lands.
      await cancelUpload(pending.uploadId, pending.manageKey).catch(() => {});
    }
    uploadIdRef.current = null;
    setPhase('idle');
    setPercent(0);
  };

  const submit = async () => {
    if (!file || phase === 'uploading' || phase === 'finalising') return;

    if (usePassword && password.length < 8) {
      setError('Passwords must be at least 8 characters.');
      return;
    }
    const limit = Number(downloadLimit);
    if (
      useDownloadLimit &&
      (!Number.isInteger(limit) || limit < 1 || limit > props.maxDownloadLimit)
    ) {
      setError(
        `The download limit must be a whole number between 1 and ${props.maxDownloadLimit}.`,
      );
      return;
    }

    setError(null);
    setPhase('uploading');
    setPercent(0);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const session = await beginUpload({
        filename: file.name,
        size: file.size,
        contentType: file.type || 'application/octet-stream',
        expiresInSeconds: Number(expiry),
        ...(usePassword ? { password } : {}),
        ...(useDownloadLimit ? { maxDownloads: limit } : {}),
      });
      uploadIdRef.current = { uploadId: session.uploadId, manageKey: session.manageKey };

      await uploadToStorage({
        url: session.upload.url,
        headers: session.upload.headers,
        file,
        signal: controller.signal,
        onProgress: (progress) => setPercent(progress.percent),
      });

      setPhase('finalising');
      const completed = await completeUpload(session.uploadId);
      uploadIdRef.current = null;
      setResult(completed);
      setPhase('done');
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') {
        setPhase('idle');
        return;
      }
      setPhase('idle');
      setPercent(0);
      setError(
        caught instanceof ApiError ? caught.message : 'The upload failed. Please try again.',
      );
    }
  };

  if (phase === 'done' && result) {
    return (
      <ShareResult
        result={result}
        onCreateAnother={reset}
        scanningEnabled={props.scanningEnabled}
      />
    );
  }

  const busy = phase === 'uploading' || phase === 'finalising';

  return (
    <Card>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Share a file</h1>
      <p className="mt-2 text-sm text-ink-muted">
        Your file goes straight from this browser to storage. Toran only ever handles the link.
      </p>

      <div className="mt-6 space-y-6">
        <div>
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={[
              'rounded-xl border-2 border-dashed p-6 text-center transition-colors',
              dragging ? 'border-brand-500 bg-brand-50' : 'border-line bg-surface-sunken',
            ].join(' ')}
          >
            <p className="text-sm text-ink-muted">Drag a file here, or</p>
            <label
              htmlFor={fileInputId}
              className="mt-3 inline-flex cursor-pointer items-center rounded-lg border border-line bg-surface-raised px-4 py-2.5 text-sm font-medium text-ink hover:bg-surface focus-within:ring-2 focus-within:ring-brand-500"
            >
              Choose a file
              <input
                ref={inputRef}
                id={fileInputId}
                type="file"
                className="sr-only"
                disabled={busy}
                onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
              />
            </label>
            <p className="mt-3 text-xs text-ink-subtle">
              Up to {formatBytes(props.maxFileSizeBytes)}
            </p>
          </div>
          {fileError ? (
            <p className="mt-2 text-xs font-medium text-danger-700" role="alert">
              {fileError}
            </p>
          ) : null}
        </div>

        {file ? (
          <div
            className="rounded-lg border border-line bg-surface-sunken px-4 py-3"
            data-testid="selected-file"
          >
            <p className="truncate text-sm font-medium text-ink" title={file.name}>
              {file.name}
            </p>
            <p className="text-xs text-ink-muted">{formatBytes(file.size)}</p>
          </div>
        ) : null}

        <fieldset className="space-y-4" disabled={busy}>
          <legend className="sr-only">Link options</legend>

          <Field label="Link expires after" htmlFor={expiryId}>
            <select
              id={expiryId}
              className={inputClassName}
              value={expiry}
              onChange={(event) => setExpiry(event.target.value)}
            >
              {choices.map((choice) => (
                <option key={choice.seconds} value={choice.seconds}>
                  {choice.label}
                </option>
              ))}
            </select>
          </Field>

          <div className="space-y-3">
            <label className="flex items-center gap-2.5 text-sm text-ink">
              <input
                type="checkbox"
                checked={usePassword}
                onChange={(event) => setUsePassword(event.target.checked)}
                className="h-4 w-4 rounded border-line text-brand-600 focus-visible:ring-2 focus-visible:ring-brand-500"
              />
              Require a password
            </label>
            {usePassword ? (
              <Field
                label="Password"
                htmlFor={passwordId}
                hint="At least 8 characters. Share it separately from the link."
              >
                <input
                  id={passwordId}
                  type="password"
                  autoComplete="new-password"
                  className={inputClassName}
                  value={password}
                  minLength={8}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
            ) : null}
          </div>

          <div className="space-y-3">
            <label className="flex items-center gap-2.5 text-sm text-ink">
              <input
                type="checkbox"
                checked={useDownloadLimit}
                onChange={(event) => setUseDownloadLimit(event.target.checked)}
                className="h-4 w-4 rounded border-line text-brand-600 focus-visible:ring-2 focus-visible:ring-brand-500"
              />
              Limit the number of downloads
            </label>
            {useDownloadLimit ? (
              <Field
                label="Maximum downloads"
                htmlFor={downloadsId}
                hint={`Between 1 and ${props.maxDownloadLimit}.`}
              >
                <input
                  id={downloadsId}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={props.maxDownloadLimit}
                  className={inputClassName}
                  value={downloadLimit}
                  onChange={(event) => setDownloadLimit(event.target.value)}
                />
              </Field>
            ) : null}
          </div>
        </fieldset>

        {busy ? (
          <div className="space-y-2" data-testid="upload-progress">
            <ProgressBar value={phase === 'finalising' ? 100 : percent} label="Upload progress" />
            <p className="text-xs text-ink-muted" aria-live="polite">
              {phase === 'finalising'
                ? 'Verifying the stored file…'
                : `Uploading… ${Math.round(percent)}%`}
            </p>
          </div>
        ) : null}

        {error ? <Alert title="Upload failed">{error}</Alert> : null}

        <div className="flex flex-wrap gap-3">
          <Button onClick={submit} disabled={!file || busy} loading={busy}>
            {busy ? 'Uploading' : 'Create share link'}
          </Button>
          {busy ? (
            <Button variant="secondary" onClick={cancel}>
              Cancel
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
