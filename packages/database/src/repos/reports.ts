// SPDX-License-Identifier: MIT
import { desc, eq } from 'drizzle-orm';
import type { ReportReason } from '@toran/shared';
import type { Database } from '../client.js';
import { abuseReports, type AbuseReportRow } from '../schema.js';

export interface CreateReportInput {
  /** Null when the token does not resolve; the hash still records what was reported. */
  readonly shareLinkId: string | null;
  readonly tokenHash: string;
  readonly reason: ReportReason;
  readonly details: string | null;
  readonly contactEmail: string | null;
  readonly reporterIdentifier: string;
}

export async function createAbuseReport(
  db: Database,
  input: CreateReportInput,
): Promise<AbuseReportRow> {
  const [row] = await db
    .insert(abuseReports)
    .values({
      shareLinkId: input.shareLinkId,
      tokenHash: input.tokenHash,
      reason: input.reason,
      details: input.details,
      contactEmail: input.contactEmail,
      reporterIdentifier: input.reporterIdentifier,
    })
    .returning();
  if (!row) throw new Error('failed to record abuse report');
  return row;
}

export async function listOpenReports(db: Database, limit = 50): Promise<AbuseReportRow[]> {
  return db
    .select()
    .from(abuseReports)
    .where(eq(abuseReports.status, 'open'))
    .orderBy(desc(abuseReports.createdAt))
    .limit(limit);
}

export async function setReportStatus(
  db: Database,
  input: { readonly reportId: string; readonly status: 'open' | 'actioned' | 'dismissed' },
): Promise<AbuseReportRow | null> {
  const [row] = await db
    .update(abuseReports)
    .set({ status: input.status })
    .where(eq(abuseReports.id, input.reportId))
    .returning();
  return row ?? null;
}
