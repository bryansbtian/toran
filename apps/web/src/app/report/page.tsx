// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { getConfig } from '@toran/config';
import { ReportForm } from '@/components/ReportForm';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Report abuse',
  description: 'Report a Toran link that is being used to distribute harmful content.',
};

export default function ReportPage() {
  const config = getConfig();
  return <ReportForm abuseContactEmail={config.app.abuseContactEmail} />;
}
