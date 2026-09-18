/**
 * Sep 18, 2026: a screenshot or a copied image can be pasted (Ctrl+V / Cmd+V)
 * straight into an attachment picker, instead of having to save it to disk
 * first and then browse for it — the same file this hands back goes through
 * exactly the same size-check / upload path a chosen or dropped file does.
 *
 * Element-scoped ON PURPOSE, not a window-wide listener: several of these
 * pickers can be mounted on one screen at once — a whole list of Dispatch's
 * "Upload proof photo" buttons on the queue, or a resubmit dialog's file
 * field open on top of the Payment tab's own upload panel underneath it —
 * and a window listener would have every one of them answer the same paste.
 * `onPaste` wired onto one specific focusable element (a button, or a
 * drag-and-drop zone with tabIndex) only ever fires for whichever one the
 * rep actually has focused.
 *
 * Renames the file: clipboard images arrive as "image.png" or with no name
 * at all, which is useless in an attachments list or in Zoho's own file name.
 */
export function onPasteImage(onImage) {
  return (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault();
      const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      const named = new File(
        [file],
        file.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(file.name) ? file.name : `pasted-${Date.now()}.${ext}`,
        { type: file.type }
      );
      onImage(named);
      return;
    }
  };
}
