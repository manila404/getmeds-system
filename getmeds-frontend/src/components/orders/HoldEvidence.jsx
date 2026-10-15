import React from 'react';
import { useQuery } from '@tanstack/react-query';
import client from '../../api/client';

/**
 * The screenshots Finance attached when it put an order on hold. Oct 15, 2026.
 *
 * `evidence` is the [{id, file_name}] list recorded on the hold event. The pictures themselves
 * come from the order's attachment list (same query the Attachments tab uses), so a MedRep sees
 * why Finance held the order without opening anything else. Renders nothing when there are none.
 */
const HoldEvidence = ({ orderId, evidence }) => {
  const ids = (evidence || []).map((e) => Number(e.id)).filter(Boolean);
  const { data } = useQuery({
    queryKey: ['order-attachments', orderId],
    queryFn: async () => (await client.get(`/api/orders/${orderId}/attachments`)).data?.data?.attachments || [],
    enabled: ids.length > 0 && Boolean(orderId),
    staleTime: 5 * 60 * 1000,
  });
  if (!ids.length) return null;
  const files = (data || []).filter((a) => ids.includes(Number(a.id)));
  if (!files.length) return null;

  return (
    <div className="mt-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-secondary mb-1">Proof from Finance</p>
      <div className="flex flex-wrap gap-2">
        {files.map((a) => (
          <a
            key={a.id}
            href={a.viewUrl}
            target="_blank"
            rel="noreferrer"
            title={a.file_name || 'Open screenshot'}
            className="block"
          >
            <img
              src={a.viewUrl}
              alt={a.file_name || 'Finance screenshot'}
              className="h-20 w-20 rounded-md border border-slate-300 object-cover hover:opacity-90"
              loading="lazy"
            />
          </a>
        ))}
      </div>
    </div>
  );
};

export default HoldEvidence;

/** Parse the evidence list off an order event (metadata is a JSON string). */
export const evidenceOf = (event) => {
  try {
    const m = typeof event?.metadata === 'string' ? JSON.parse(event.metadata || '{}') : (event?.metadata || {});
    return Array.isArray(m.evidence) ? m.evidence : [];
  } catch {
    return [];
  }
};
