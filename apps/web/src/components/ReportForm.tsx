// SPDX-License-Identifier: MIT
'use client';

import { useId, useState } from 'react';
import { REPORT_REASON_LABELS, REPORT_REASONS, type ReportReason } from '@toran/shared';
import { Alert, Button, Card, Field, inputClassName } from '@toran/ui';
import { ApiError, submitReport } from '@/lib/api';

export function ReportForm({ abuseContactEmail }: { readonly abuseContactEmail: string }) {
  const linkId = useId();
  const reasonId = useId();
  const detailsId = useId();
  const emailId = useId();

  const [link, setLink] = useState('');
  const [reason, setReason] = useState<ReportReason>('malware');
  const [details, setDetails] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [working, setWorking] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setWorking(true);
    try {
      await submitReport({
        link: link.trim(),
        reason,
        ...(details.trim() ? { details: details.trim() } : {}),
        ...(contactEmail.trim() ? { contactEmail: contactEmail.trim() } : {}),
      });
      setSent(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The report could not be submitted.');
    } finally {
      setWorking(false);
    }
  };

  if (sent) {
    return (
      <Card>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Report received</h1>
        <p className="mt-3 text-sm text-ink-muted">
          Thank you. An administrator will review this report. Your identity is not shared with the
          person who uploaded the file.
        </p>
        <p className="mt-3 text-sm text-ink-muted">
          For urgent matters, contact{' '}
          <a
            className="font-medium underline underline-offset-2"
            href={`mailto:${abuseContactEmail}`}
          >
            {abuseContactEmail}
          </a>
          .
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Report abuse</h1>
      <p className="mt-2 text-sm text-ink-muted">
        Use this form to report a link used for malware, phishing, harassment, copyright
        infringement or illegal content. Reports are rate limited.
      </p>

      <form
        className="mt-6 space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field
          label="Link being reported"
          htmlFor={linkId}
          hint="Paste the full share link, or just the token from the end of it."
        >
          <input
            id={linkId}
            type="text"
            required
            className={inputClassName}
            value={link}
            onChange={(event) => setLink(event.target.value)}
            placeholder="https://example.com/s/…"
          />
        </Field>

        <Field label="Reason" htmlFor={reasonId}>
          <select
            id={reasonId}
            className={inputClassName}
            value={reason}
            onChange={(event) => setReason(event.target.value as ReportReason)}
          >
            {REPORT_REASONS.map((value) => (
              <option key={value} value={value}>
                {REPORT_REASON_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Details (optional)" htmlFor={detailsId} hint="Up to 4000 characters.">
          <textarea
            id={detailsId}
            rows={4}
            maxLength={4000}
            className={inputClassName}
            value={details}
            onChange={(event) => setDetails(event.target.value)}
          />
        </Field>

        <Field
          label="Your email (optional)"
          htmlFor={emailId}
          hint="Only used if an administrator needs to follow up. Never shown to the uploader."
        >
          <input
            id={emailId}
            type="email"
            className={inputClassName}
            value={contactEmail}
            onChange={(event) => setContactEmail(event.target.value)}
          />
        </Field>

        {error ? <Alert title="Could not submit">{error}</Alert> : null}

        <Button type="submit" loading={working} disabled={link.trim().length === 0}>
          Submit report
        </Button>
      </form>
    </Card>
  );
}
