import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { X, Download, ZoomIn, ZoomOut, RotateCcw, RotateCw, RefreshCw } from 'lucide-react';
import { attachmentLabel } from '../../constants/attachmentTypes';

const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.5;

/**
 * Bounded zoomable/rotatable image attachment lightbox shared between OrderDetailsModal
 * and DrFulfillModal so staff can inspect POs/prescriptions without closing their modal.
 */
const AttachmentLightbox = ({ attachment, onClose }) => {
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(null);
  const [rot, setRot] = useState(0);
  const [fit, setFit] = useState(1);
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef(null);
  const boxRef = useRef(null);

  useEffect(() => {
    setZoom(1);
    setPos({ x: 0, y: 0 });
    setRot(0);
    setLoaded(false);
  }, [attachment?.id]);

  useLayoutEffect(() => {
    const img = imgRef.current;
    const box = boxRef.current;
    if (!img || !box || !loaded || rot % 180 === 0) { setFit(1); return; }
    const w = img.offsetWidth;
    const h = img.offsetHeight;
    setFit(w && h ? Math.min(1, box.clientWidth / h, box.clientHeight / w) : 1);
  }, [rot, loaded, attachment?.id]);

  useEffect(() => {
    if (!attachment) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [attachment, onClose]);

  if (!attachment) return null;

  const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  const zoomIn = () => setZoom((z) => clampZoom(z + ZOOM_STEP));
  const zoomOut = () =>
    setZoom((z) => {
      const next = clampZoom(z - ZOOM_STEP);
      if (next === ZOOM_MIN) setPos({ x: 0, y: 0 });
      return next;
    });
  const rotate = (dir) => setRot((r) => (r + dir * 90 + 360) % 360);
  const reset = () => { setZoom(1); setPos({ x: 0, y: 0 }); setRot(0); };

  const onWheel = (e) => {
    e.preventDefault();
    setZoom((z) => clampZoom(z + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)));
  };
  const onMouseDown = (e) => {
    if (zoom <= 1) return;
    setDragging({ startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y });
  };
  const onMouseMove = (e) => {
    if (!dragging) return;
    setPos({ x: dragging.origX + (e.clientX - dragging.startX), y: dragging.origY + (e.clientY - dragging.startY) });
  };
  const stopDrag = () => setDragging(null);

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
      onMouseMove={onMouseMove}
      onMouseUp={stopDrag}
      onMouseLeave={stopDrag}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-200 bg-surface shrink-0">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink-primary truncate">{attachment.file_name}</p>
            <p className="text-xs text-ink-secondary">{attachmentLabel(attachment.file_type)}</p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button type="button" onClick={zoomOut} disabled={zoom <= ZOOM_MIN} title="Zoom out" className="p-1.5 rounded-md text-ink-secondary hover:bg-slate-100 hover:text-ink-primary disabled:opacity-40">
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="text-xs tabular-nums w-10 text-center text-ink-secondary">{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={zoomIn} disabled={zoom >= ZOOM_MAX} title="Zoom in" className="p-1.5 rounded-md text-ink-secondary hover:bg-slate-100 hover:text-ink-primary disabled:opacity-40">
              <ZoomIn className="w-4 h-4" />
            </button>
            <button type="button" onClick={() => rotate(-1)} title="Rotate left" aria-label="Rotate left" className="p-1.5 rounded-md text-ink-secondary hover:bg-slate-100 hover:text-ink-primary">
              <RotateCcw className="w-4 h-4" />
            </button>
            <button type="button" onClick={() => rotate(1)} title="Rotate right" aria-label="Rotate right" className="p-1.5 rounded-md text-ink-secondary hover:bg-slate-100 hover:text-ink-primary">
              <RotateCw className="w-4 h-4" />
            </button>
            <button type="button" onClick={reset} disabled={zoom === 1 && !pos.x && !pos.y && rot === 0} title="Reset zoom and rotation" aria-label="Reset zoom and rotation" className="p-1.5 rounded-md text-ink-secondary hover:bg-slate-100 hover:text-ink-primary disabled:opacity-40">
              <RefreshCw className="w-4 h-4" />
            </button>
            {attachment.downloadUrl && (
              <a href={attachment.downloadUrl} title="Download" className="p-1.5 rounded-md text-ink-secondary hover:bg-slate-100 hover:text-ink-primary">
                <Download className="w-4 h-4" />
              </a>
            )}
            <span className="w-px h-5 bg-slate-200 mx-0.5" aria-hidden="true" />
            <button type="button" onClick={onClose} title="Close" className="p-1.5 rounded-md text-ink-secondary hover:bg-slate-100 hover:text-ink-primary">
              <X className="w-4.5 h-4.5" />
            </button>
          </div>
        </div>
        <div ref={boxRef} className="flex-1 min-h-0 overflow-hidden flex items-center justify-center bg-surface" onWheel={onWheel}>
          <img
            ref={imgRef}
            onLoad={() => setLoaded(true)}
            src={attachment.viewUrl}
            alt={attachment.file_name}
            onMouseDown={onMouseDown}
            onDoubleClick={() => (zoom > 1 ? reset() : zoomIn())}
            draggable={false}
            style={{
              transform: `translate(${pos.x}px, ${pos.y}px) rotate(${rot}deg) scale(${zoom * fit})`,
              cursor: zoom > 1 ? (dragging ? 'grabbing' : 'grab') : 'zoom-in',
              transition: dragging ? 'none' : 'transform 0.15s ease-out'
            }}
            className="max-w-full max-h-[70vh] object-contain select-none"
          />
        </div>
      </div>
    </div>
  );
};

export default AttachmentLightbox;
