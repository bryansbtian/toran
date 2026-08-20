/**
 * Copies text to the clipboard, falling back when the async Clipboard API is
 * not available.
 *
 * `navigator.clipboard` is exposed only in a secure context. `https://` and
 * `localhost` qualify; a plain-http LAN instance - which is exactly what
 * `npm run dev` produces - does not, so the property is absent altogether and
 * the copy button reported failure with the link sitting right next to it.
 * `document.execCommand('copy')` is deprecated, but it carries no
 * secure-context requirement and is the only path available on that origin.
 *
 * Returns whether the text reached the clipboard. When it did not and a field
 * was supplied, that field is left selected so Ctrl+C finishes the job.
 */
export async function copyText(
  text: string,
  field?: HTMLInputElement | HTMLTextAreaElement | null,
): Promise<boolean> {
  if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied by permissions policy, or a document that is not focused. The
      // legacy path is driven by a user gesture and often still works.
    }
  }
  return copyBySelection(text, field ?? null);
}

function copyBySelection(
  text: string,
  field: HTMLInputElement | HTMLTextAreaElement | null,
): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  if (field !== null) {
    return copyFromField(field);
  }

  // Nothing on screen holds the text, so borrow a field for one gesture. It has
  // to be laid out and focusable - `display: none` and `hidden` cannot be
  // selected - so it is positioned off-screen instead.
  const scratch = document.createElement('textarea');
  scratch.value = text;
  scratch.setAttribute('readonly', '');
  scratch.setAttribute('aria-hidden', 'true');
  scratch.style.position = 'fixed';
  scratch.style.top = '0';
  scratch.style.left = '-9999px';
  document.body.appendChild(scratch);
  try {
    return copyFromField(scratch);
  } finally {
    scratch.remove();
  }
}

function copyFromField(field: HTMLInputElement | HTMLTextAreaElement): boolean {
  // `preventScroll` keeps a copy from yanking the page around when the field is
  // out of view.
  field.focus({ preventScroll: true });
  field.select();
  // iOS Safari ignores `select()` on a readonly field; an explicit range works.
  field.setSelectionRange(0, field.value.length);
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  }
}
