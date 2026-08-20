import type { JSX } from 'react';
import { branding } from '@toran/shared';
import { Card } from '@toran/ui';
import { Accordion, type AccordionEntry } from '@/components/Accordion';

/**
 * The "How Toran Works" explainer, as a disclosure list below the upload
 * panel. Only one answer is open at a time.
 */
export function HowItWorks({
  scanningEnabled,
}: {
  readonly scanningEnabled: boolean;
}): JSX.Element {
  // Omitted rather than negated when scanning is off: a server that does not
  // scan should not describe a scanning step at all.
  let scanStep = '';
  if (scanningEnabled) {
    scanStep = ', scans it for malware,';
  }

  const entries: readonly AccordionEntry[] = [
    {
      question: 'How Does the Upload Start?',
      answer: `Your browser asks ${branding.name} for permission to upload. ${branding.name} checks the size, name and limits, then returns a short-lived, single-purpose upload URL.`,
    },
    {
      question: 'Where Does the File Actually Go?',
      answer: `Your browser sends the file directly to object storage. The file never passes through the ${branding.name} server.`,
    },
    {
      question: 'What Happens Before I Get a Link?',
      answer: `${branding.name} verifies the stored object${scanStep} and gives you a link.`,
    },
    {
      question: 'How Does Someone Download It?',
      answer:
        'Anyone with the link downloads straight from storage using a URL that expires in minutes.',
    },
  ];

  // The accordion cancels the trailing padding of its last entry, so the gap
  // below it is this card's bottom padding alone. Held at 16px to match the gap
  // between a divider and the question beneath it, rather than the wider inset
  // used on the other three sides.
  return (
    <Card className="pb-4 sm:pb-4">
      <h2 id="how-it-works" className="text-xl font-semibold text-ink">
        How {branding.name} Works
      </h2>

      <div className="mt-4">
        <Accordion entries={entries} defaultOpen={0} />
      </div>

      {!scanningEnabled && (
        <p className="mt-4 rounded-lg border border-warning-200 bg-warning-50 px-4 py-3 text-sm text-warning-800">
          Malware scanning is disabled on this server. This is a development-only setting.
        </p>
      )}
    </Card>
  );
}
