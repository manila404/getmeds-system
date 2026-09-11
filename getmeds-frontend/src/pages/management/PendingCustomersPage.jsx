import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { CloudOff, RefreshCw, AlertTriangle, Clock, Building2, Info } from 'lucide-react';
import client from '../../api/client';

/**
 * Customers saved here that Zoho has not accepted yet.
 *
 * Sep 11, 2026. This org's Zoho token grants ZohoInventory.contacts.READ and
 * not .CREATE, so creating a customer fails with "You are not authorized to
 * perform this operation" — and reissuing the token needs the API Console,
 * which is not always reachable.
 *
 * Rather than turn a MedRep away mid-order, those customers are kept as
 * pending. This screen is where that promise becomes visible: a held customer
 * that lives only in a database column is one nobody honours.
 *
 * The reason is stated at the top while it persists, so the queue reads as
 * "blocked on a known thing somebody is fixing" rather than "broken".
 */

const timeAgo = (iso) => {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

const PendingCustomersPage = () => {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['pending-customers'],
    queryFn: () => client.get('/api/customers/pending').then((r) => r.data?.data)
  });

  // Sep 11, 2026: a customer can be marked "Needs attention" for a reason that
  // was never about the customer — a push attempted during a token outage did
  // exactly that. Without a way back, the only remedies were SQL or re-typing.
  const retry = useMutation({
    mutationFn: (id) => client.post(`/api/customers/${id}/retry`).then((r) => r.data?.data),
    onSuccess: (res) => {
      toast.success(res.message);
      qc.invalidateQueries({ queryKey: ['pending-customers'] });
    },
    onError: (err) => toast.error(err?.response?.data?.error?.message || 'Could not requeue.')
  });

  const sync = useMutation({
    mutationFn: () => client.post('/api/customers/pending/sync').then((r) => r.data?.data),
    onSuccess: (res) => {
      // "0 pushed" is not a success. Reporting it as one is how an admin
      // concludes the queue is working while nothing actually moves — which is
      // exactly what happened when the old token was restored.
      if (res.blocked) {
        toast(res.message, { icon: '⏳', duration: 8000 });
      } else if (res.ok) {
        toast.success(res.message);
      } else {
        toast(res.message, { icon: '⚠️', duration: 8000 });
      }
      qc.invalidateQueries({ queryKey: ['pending-customers'] });
    },
    onError: (err) =>
      toast.error(err?.response?.data?.error?.message || 'Could not push customers to Zoho.')
  });

  const customers = data?.customers || [];
  const pending = data?.pending || 0;
  const failed = data?.failed || 0;

  if (isLoading) return <p className="p-6 text-sm text-ink-secondary">Loading…</p>;

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h1 className="text-xl font-bold text-ink-primary flex items-center gap-2">
            <CloudOff className="w-5 h-5 text-amber-600" />
            Customers waiting for Zoho
          </h1>
          <p className="text-sm text-ink-secondary mt-1">
            Created here while Zoho could not accept them. Orders for these customers can be raised
            and approved — they just cannot become Sales Orders until the customer exists in Zoho.
          </p>
        </div>

        {pending > 0 && (
          <button
            type="button"
            onClick={() => sync.mutate()}
            disabled={sync.isPending}
            className="shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-md bg-getmeds-blue text-white text-sm font-semibold disabled:opacity-60"
          >
            <RefreshCw className={`w-4 h-4 ${sync.isPending ? 'animate-spin' : ''}`} />
            {sync.isPending ? 'Pushing…' : `Push ${pending} to Zoho`}
          </button>
        )}
      </div>

      {customers.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-8 text-center">
          <p className="text-sm text-ink-secondary">
            Nothing waiting — every customer created here has reached Zoho.
          </p>
        </div>
      ) : (
        <>
          {/* Why they are stuck, named once at the top. Repeating an OAuth
              scope on every row would be noise; omitting it entirely leaves a
              queue that looks like a backlog somebody is ignoring. */}
          {pending > 0 && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
              <Info className="w-4 h-4 mt-0.5 shrink-0 text-amber-700" />
              <div className="text-[13px] text-amber-900">
                <p className="font-semibold">Zoho cannot accept new customers yet.</p>
                <p className="mt-0.5 text-amber-900/90">
                  The Zoho token can read contacts but not create them — the scope{' '}
                  <code className="text-[11px] bg-amber-100 px-1 py-0.5 rounded">
                    ZohoInventory.contacts.CREATE
                  </code>{' '}
                  is missing. An admin reissues it with{' '}
                  <code className="text-[11px] bg-amber-100 px-1 py-0.5 rounded">
                    node scripts/zoho-reissue-token.js --url
                  </code>
                  , then presses Push above. Nothing here is lost in the meantime.
                </p>
              </div>
            </div>
          )}

          <div className="rounded-lg border border-slate-200 bg-white divide-y divide-slate-100">
            {customers.map((c) => (
              <div key={c.id} className="px-4 py-3 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink-primary flex items-center gap-2">
                    <Building2 className="w-3.5 h-3.5 text-ink-secondary shrink-0" />
                    {c.name}
                    {c.category === 'hospital' && (
                      <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-800 border border-indigo-200">
                        Hospital
                      </span>
                    )}
                  </p>
                  <p className="text-[12px] text-ink-secondary mt-0.5">
                    {[c.contact_number, c.email].filter(Boolean).join(' · ')}
                    {c.created_at && <span> · added {timeAgo(c.created_at)}</span>}
                  </p>

                  {/* Only shown for a 'failed' row. A pending row's error is
                      the scope message already stated above, and repeating it
                      per row would bury the one row that is genuinely
                      different. */}
                  {c.zoho_sync_status === 'failed' && c.zoho_sync_error && (
                    <>
                      <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-red-800 bg-red-50 border border-red-200 rounded px-2 py-1.5">
                        <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                        <span>{c.zoho_sync_error}</span>
                      </p>
                      <button
                        type="button"
                        onClick={() => retry.mutate(c.id)}
                        disabled={retry.isPending}
                        className="mt-1.5 text-[11px] font-semibold text-getmeds-blue hover:text-getmeds-blue-dark disabled:opacity-60"
                      >
                        Put back in the queue
                      </button>
                    </>
                  )}
                </div>

                <span
                  className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${
                    c.zoho_sync_status === 'failed'
                      ? 'bg-red-50 text-red-800 border-red-200'
                      : 'bg-amber-100 text-amber-900 border-amber-300'
                  }`}
                >
                  {c.zoho_sync_status === 'failed' ? (
                    <>
                      <AlertTriangle className="w-3 h-3" />
                      Needs attention
                    </>
                  ) : (
                    <>
                      <Clock className="w-3 h-3" />
                      Waiting
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>

          {/* A 'failed' row will never clear itself, so it is separated from
              the waiting ones rather than being pushed again on every attempt. */}
          {failed > 0 && (
            <p className="mt-3 text-[12px] text-ink-secondary">
              {failed} customer{failed === 1 ? '' : 's'} marked <strong>Needs attention</strong> —
              Zoho refused {failed === 1 ? 'it' : 'them'} for a reason retrying will not fix, usually
              a duplicate LTO licence. Fix the detail in the Clients Directory, or create the
              customer directly in Zoho and re-sync.
            </p>
          )}
        </>
      )}
    </div>
  );
};

export default PendingCustomersPage;
