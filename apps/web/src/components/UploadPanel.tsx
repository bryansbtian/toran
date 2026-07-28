// SPDX-License-Identifier: MIT
'use client';

import { useCallback, useId, useMemo, useRef, useState, type DragEvent } from 'react';
import { expiryChoices, formatBytes, MAX_FILES_PER_SHARE } from '@toran/shared';
import { Alert, Button, Card, Field, inputClassName, ProgressBar } from '@toran/ui';
import {
  ApiError,
  beginUpload,
  cancelUpload,
  completeUpload,
  createShare,
  uploadToStorage,
  type ShareResponse,
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

/**
 * A file the user picked, with a key of our own.
 *
 * Two files can share a name and a size, and `File` objects are not stable
 * across re-renders, so removing "the third one" needs an identity React can
 * key on that is not derived from the file itself.
 */
interface Selected {
  readonly key: string;
  readonly file: File;
}

let nextKey = 0;

export function UploadPanel(props: UploadPanelProps) {
  const fileInputId = useId();
  const expiryId = useId();
  const passwordId = useId();
  const downloadsId = useId();

  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const uploadIdRef = useRef<{ uploadId: string; manageKey: string } | null>(null);

  const [selected, setSelected] = useState<Selected[]>([]);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  /** Bytes sent across the whole batch, so one bar covers every file. */
  const [sentBytes, setSentBytes] = useState(0);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [doneCount, setDoneCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [result, setResult] = useState<ShareResponse | null>(null);

  const [expiry, setExpiry] = useState(String(props.defaultExpirySeconds));
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState('');
  const [useDownloadLimit, setUseDownloadLimit] = useState(false);
  const [downloadLimit, setDownloadLimit] = useState('1');

  const choices = useMemo(() => expiryChoices(props.maxExpirySeconds), [props.maxExpirySeconds]);
  const totalBytes = useMemo(
    () => selected.reduce((sum, entry) => sum + entry.file.size, 0),
    [selected],
  );

  const addFiles = useCallback(
    (incoming: FileList | null) => {
      setError(null);
      setFileError(null);
      const list = Array.from(incoming ?? []);
      if (list.length === 0) return;

      const accepted: Selected[] = [];
      const rejected: string[] = [];
      for (const file of list) {
        if (file.size === 0) {
          rejected.push(`${file.name} is empty`);
          continue;
        }
        if (file.size > props.maxFileSizeBytes) {
          rejected.push(`${file.name} is ${formatBytes(file.size)}`);
          continue;
        }
        accepted.push({ key: `f${(nextKey += 1)}`, file });
      }

      setSelected((current) => {
        const room = MAX_FILES_PER_SHARE - current.length;
        if (accepted.length > room) {
          rejected.push(`only ${MAX_FILES_PER_SHARE} files fit on one link`);
        }
        return [...current, ...accepted.slice(0, Math.max(0, room))];
      });

      if (rejected.length > 0) {
        setFileError(
          `Skipped: ${rejected.join(', ')}. This server accepts files up to ${formatBytes(
            props.maxFileSizeBytes,
          )}.`,
        );
      }
    },
    [props.maxFileSizeBytes],
  );

  const removeFile = (key: string) => {
    setFileError(null);
    setSelected((current) => current.filter((entry) => entry.key !== key));
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  };

  const reset = () => {
    abortRef.current = null;
    uploadIdRef.current = null;
    setSelected([]);
    setPhase('idle');
    setSentBytes(0);
    setActiveName(null);
    setDoneCount(0);
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
      // this call never lands. Files earlier in the batch that already finished
      // are left to their own expiry - no link was ever minted over them, so
      // nothing can reach them in the meantime.
      await cancelUpload(pending.uploadId, pending.manageKey).catch(() => {});
    }
    uploadIdRef.current = null;
    setPhase('idle');
    setSentBytes(0);
    setActiveName(null);
    setDoneCount(0);
  };

  const submit = async () => {
    if (selected.length === 0 || phase === 'uploading' || phase === 'finalising') return;

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
    setSentBytes(0);
    setDoneCount(0);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const fileIds: string[] = [];
      const manageKeys: string[] = [];
      let completedBytes = 0;

      // Sequential rather than parallel: the per-client upload quota and the
      // rate limiter both count requests, and a browser uploading twenty files
      // at once mostly succeeds in starving itself.
      for (const entry of selected) {
        setActiveName(entry.file.name);

        const session = await beginUpload({
          filename: entry.file.name,
          size: entry.file.size,
          contentType: entry.file.type || 'application/octet-stream',
          // The file's own lifetime, set here because the link may not outlive
          // its content: `createShare` clamps the link to the earliest file
          // expiry, so a file given the default would cap the link at it.
          expiresInSeconds: Number(expiry),
        });
        uploadIdRef.current = { uploadId: session.uploadId, manageKey: session.manageKey };

        await uploadToStorage({
          url: session.upload.url,
          headers: session.upload.headers,
          file: entry.file,
          signal: controller.signal,
          onProgress: (progress) => setSentBytes(completedBytes + progress.loaded),
        });

        const completed = await completeUpload(session.uploadId);
        uploadIdRef.current = null;
        completedBytes += entry.file.size;
        setSentBytes(completedBytes);
        setDoneCount((count) => count + 1);

        fileIds.push(completed.file.fileId);
        manageKeys.push(completed.manageKey);
      }

      // Every file is stored and verified, so the link can finally be minted
      // over all of them at once.
      setPhase('finalising');
      setActiveName(null);
      const share = await createShare({
        fileIds,
        manageKeys,
        expiresInSeconds: Number(expiry),
        ...(usePassword ? { password } : {}),
        ...(useDownloadLimit ? { maxDownloads: limit } : {}),
      });

      setResult(share);
      setPhase('done');
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') {
        setPhase('idle');
        return;
      }
      setPhase('idle');
      setSentBytes(0);
      setActiveName(null);
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
  const percent = phase === 'finalising' || totalBytes === 0 ? 100 : (sentBytes / totalBytes) * 100;
  const many = selected.length > 1;

  return (
    <Card>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">
        {many ? 'Share files' : 'Share a file'}
      </h1>
      <p className="mt-2 text-sm text-ink-muted">
        Your {many ? 'files go' : 'file goes'} straight from this browser to storage. Toran only
        ever handles the link.
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
            <p className="text-sm text-ink-muted">Drag files here, or</p>
            <label
              htmlFor={fileInputId}
              className="mt-3 inline-flex cursor-pointer items-center rounded-lg border border-line bg-surface-raised px-4 py-2.5 text-sm font-medium text-ink hover:bg-surface focus-within:ring-2 focus-within:ring-brand-500"
            >
              {selected.length > 0 ? 'Add more files' : 'Choose files'}
              <input
                ref={inputRef}
                id={fileInputId}
                type="file"
                multiple
                className="sr-only"
                disabled={busy}
                onChange={(event) => {
                  addFiles(event.target.files);
                  // Cleared so picking the same file twice still fires change.
                  event.target.value = '';
                }}
              />
            </label>
            <p className="mt-3 text-xs text-ink-subtle">
              Up to {formatBytes(props.maxFileSizeBytes)} each, {MAX_FILES_PER_SHARE} files per link
            </p>
          </div>
          {fileError ? (
            <p className="mt-2 text-xs font-medium text-danger-700" role="alert">
              {fileError}
            </p>
          ) : null}
        </div>

        {selected.length > 0 ? (
          <ul className="space-y-2" data-testid="selected-file">
            {selected.map((entry) => (
              <li
                key={entry.key}
                className="flex items-center gap-3 rounded-lg border border-line bg-surface-sunken px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink" title={entry.file.name}>
                    {entry.file.name}
                  </p>
                  <p className="text-xs text-ink-muted">{formatBytes(entry.file.size)}</p>
                </div>
                {!busy ? (
                  <button
                    type="button"
                    onClick={() => removeFile(entry.key)}
                    className="shrink-0 rounded px-2 py-1 text-xs font-medium text-ink-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    Remove
                    <span className="sr-only"> {entry.file.name}</span>
                  </button>
                ) : null}
              </li>
            ))}
            {many ? (
              <li className="px-1 text-xs text-ink-subtle">
                {selected.length} files · {formatBytes(totalBytes)} total · one link
              </li>
            ) : null}
          </ul>
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
                hint={
                  many
                    ? `Between 1 and ${props.maxDownloadLimit}, counted separately for each file.`
                    : `Between 1 and ${props.maxDownloadLimit}.`
                }
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
            <ProgressBar value={percent} label="Upload progress" />
            <p className="text-xs text-ink-muted" aria-live="polite">
              {phase === 'finalising'
                ? 'Creating the link…'
                : many
                  ? `Uploading ${Math.min(doneCount + 1, selected.length)} of ${selected.length}` +
                    `${activeName === null ? '' : ` — ${activeName}`} … ${Math.round(percent)}%`
                  : `Uploading… ${Math.round(percent)}%`}
            </p>
          </div>
        ) : null}

        {error ? <Alert title="Upload failed">{error}</Alert> : null}

        <div className="flex flex-wrap gap-3">
          <Button onClick={submit} disabled={selected.length === 0 || busy} loading={busy}>
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
