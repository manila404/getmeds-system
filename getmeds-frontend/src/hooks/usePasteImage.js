import { useEffect } from 'react';

/**
 * Sep 18, 2026: a screenshot or a copied image can be pasted (Ctrl+V / Cmd+V)
 * straight into an attachment picker, instead of having to save it to disk
 * first and then browse for it — the same file this hands back goes through
 * exactly the same size-check and upload path a chosen or dropped file does.
 *
 * Renames it: clipboard images arrive as "image.png" or with no name at all,
 * which is useless in an attachments list or in Zoho's own file name.
 */
function extractPastedImage(e) {
  const items = e.clipboardData?.items;
  if (!items) return null;
  for (const item of items) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (!file) continue;
    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    return new File(
      [file],
      file.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(file.name) ? file.name : `pasted-${Date.now()}.${ext}`,
      { type: file.type }
    );
  }
  return null;
}

/**
 * Sep 18, 2026 (2): window-level, for a screen where exactly ONE attachment
 * picker is visible at a time (the order form's own page, a modal's single
 * file field). Ctrl+V works the instant a copied image is on the clipboard —
 * no click first.
 *
 * That "no click first" is not a nicety, it is the point. The click-to-browse
 * affordance on these pickers wraps (or triggers) a hidden `<input
 * type="file">`; clicking it opens the OS's native file dialog immediately,
 * which steals focus to a window outside the page entirely. Binding `onPaste`
 * to that same clickable element — the first version of this — meant "click
 * it to focus it for pasting" actually meant "click it to open a file
 * browser," and Ctrl+V never reached the page at all. Listening on the whole
 * window sidesteps that: nothing needs focus, and nothing here is a text
 * input a paste would otherwise be meant for.
 *
 * Wrong for a LIST of pickers (one per row) rendered at once — every
 * instance would fire on the same paste with no way to tell which row it was
 * meant for. Use `onPasteImage` below, on a focusable element that does NOT
 * also open the file dialog, for that case (see DeliveryActions.jsx).
 *
 * @param {(file: File) => void} onImage
 * @param {{ disabled?: boolean }} [opts]
 */
export function usePasteImage(onImage, { disabled = false } = {}) {
  useEffect(() => {
    if (disabled) return undefined;
    const handler = (e) => {
      const file = extractPastedImage(e);
      if (file) {
        e.preventDefault();
        onImage(file);
      }
    };
    window.addEventListener('paste', handler);
    return () => window.removeEventListener('paste', handler);
  }, [onImage, disabled]);
}

/**
 * Element-level version — an `onPaste` handler for ONE specific focusable
 * element, so a paste only ever reaches whichever row/instance the rep
 * actually has focused. Must be wired onto an element that does NOT also
 * open a file dialog on click/focus (see usePasteImage's note above for
 * why) — a plain focusable span/div works; a button or label that also
 * triggers `input.click()` does not.
 *
 * @param {(file: File) => void} onImage
 * @returns {(e: React.ClipboardEvent) => void}
 */
export function onPasteImage(onImage) {
  return (e) => {
    const file = extractPastedImage(e);
    if (file) {
      e.preventDefault();
      onImage(file);
    }
  };
}
