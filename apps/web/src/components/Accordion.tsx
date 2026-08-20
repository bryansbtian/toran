'use client';

import { useId, useState, type JSX, type ReactNode } from 'react';
import clsx from 'clsx';

export interface AccordionEntry {
  readonly question: string;
  readonly answer: ReactNode;
}

/**
 * A single-open, collapsible disclosure list.
 *
 * One panel at a time: opening an entry closes whichever was open, and
 * clicking the open entry closes it. The panel animates between heights with
 * a `0fr`/`1fr` grid row rather than a measured pixel height, so nothing has
 * to be read from the DOM and the content sets its own size; `globals.css`
 * collapses the transition under `prefers-reduced-motion`.
 *
 * `visibility` is transitioned alongside it so a closing panel stays visible
 * for the whole animation, then leaves the accessibility tree rather than
 * being read out from behind a zero-height box.

 */
export function Accordion({
  entries,
  defaultOpen = null,
}: {
  readonly entries: readonly AccordionEntry[];
  /** Index open on first render, or `null` for all closed. */
  readonly defaultOpen?: number | null;
}): JSX.Element {
  const [openIndex, setOpenIndex] = useState<number | null>(defaultOpen);
  const baseId = useId();

  /** Clicking the open entry closes it; clicking any other one opens that one. */
  const toggle = (index: number) => {
    setOpenIndex((current) => {
      if (current === index) {
        return null;
      }
      return index;
    });
  };

  return (
    <div className="flex w-full flex-col">
      {entries.map((entry, index) => {
        const open = openIndex === index;
        const triggerId = `${baseId}-trigger-${index}`;
        const panelId = `${baseId}-panel-${index}`;
        return (
          <div key={entry.question} className="border-b border-line last:-mb-4 last:border-b-0">
            <h3 className="flex">
              <button
                type="button"
                id={triggerId}
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => toggle(index)}
                className={clsx(
                  'flex flex-1 items-center justify-between gap-4 rounded-lg py-4',
                  'text-left text-sm font-medium text-ink transition-colors hover:text-brand-600',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                  'focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised',
                )}
              >
                {entry.question}
                <ChevronDownIcon open={open} />
              </button>
            </h3>
            <div
              id={panelId}
              role="region"
              aria-labelledby={triggerId}
              className={clsx(
                'grid transition-all duration-200 ease-out',
                open && 'visible grid-rows-[1fr]',
                !open && 'invisible grid-rows-[0fr]',
              )}
            >
              <div className="overflow-hidden">
                <p className="pb-4 text-sm leading-relaxed text-ink-muted">{entry.answer}</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ChevronDownIcon({ open }: { readonly open: boolean }): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={clsx(
        'h-4 w-4 shrink-0 text-ink-subtle transition-transform duration-200',
        open && 'rotate-180',
      )}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
