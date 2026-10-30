import React, { useEffect, useMemo, useState } from 'react';
import { X, ArrowRight, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import client from '../../api/client';

/**
 * Move / change role for someone in the Sales department. Oct 30, 2026 (Aaron).
 *
 * Shows what the person holds now, lets Admin pick the new role, department (main Zoho
 * name), who they report to, where their people / old Zoho names / orders still to act
 * on go, then PREVIEWS every switch. Nothing is saved until Apply, and Apply sends exactly
 * what was previewed. See the backend's services/salesMoveService.js.
 */

const btn = 'inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-md text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const btnPrimary = `${btn} text-white bg-getmeds-blue hover:bg-getmeds-blue-hover shadow-sm`;
const btnGhost = `${btn} border border-slate-200 bg-white text-ink-secondary hover:bg-surface hover:text-ink-primary`;
const inputCls = 'w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-getmeds-blue/30';
const errorText = (err, fallback) => err?.response?.data?.error?.message || err?.message || fallback;

const ACTION = {
  ON: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  OFF: 'bg-red-50 text-red-700 border-red-200',
  MOVE: 'bg-sky-50 text-sky-800 border-sky-200',
  SWITCH: 'bg-indigo-50 text-indigo-800 border-indigo-200',
  KEEP: 'bg-slate-100 text-slate-600 border-slate-200',
};

const Label = ({ children }) => <p className="text-[11px] font-bold uppercase tracking-wide text-ink-secondary mb-1">{children}</p>;

const SalesMoveDialog = ({ userId, onClose, onDone }) => {
  const [info, setInfo] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [form, setForm] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    client.get(`/api/admin/users/${userId}/sales-move`)
      .then((r) => {
        const d = r.data.data;
        setInfo(d);
        setForm({
          role: d.person.role,
          channel_id: '',
          primary_salesperson: '',
          names: Object.fromEntries(d.names.map((n) => [n.name, 'keep'])),
          hand_to: '',
          team_lead_id: d.person.team_lead ? String(d.person.team_lead.id) : '',
          people_to: '',
          lead_channel_id: '',
          orders: 'keep',
        });
      })
      .catch((err) => setLoadError(errorText(err, 'Could not load this account.')));
  }, [userId]);

  // Any change makes the preview stale: Apply only ever sends what was previewed.
  const set = (patch) => { setForm((f) => ({ ...f, ...patch })); setPreview(null); setError(null); };

  const channel = useMemo(() => info?.choices.channels.find((c) => String(c.id) === form?.channel_id) || null, [info, form]);
  const body = () => ({
    role: form.role,
    primary_salesperson: form.primary_salesperson || null,
    names: form.names,
    hand_to: form.hand_to ? Number(form.hand_to) : null,
    team_lead_id: form.team_lead_id ? Number(form.team_lead_id) : null,
    ...(form.people_to ? { people_to: Number(form.people_to) } : {}),
    ...(form.role === 'team_lead' && form.lead_channel_id ? { lead_channel_id: Number(form.lead_channel_id) } : {}),
    orders: form.orders,
  });

  const run = async (path) => {
    setBusy(true); setError(null);
    try {
      const r = await client.post(`/api/admin/users/${userId}/sales-move/${path}`, body());
      return r.data.data;
    } catch (err) {
      setError(errorText(err, 'Something went wrong.'));
      return null;
    } finally { setBusy(false); }
  };
  const doPreview = async () => { const d = await run('preview'); if (d) setPreview(d); };
  const doApply = async () => {
    const d = await run('apply');
    if (!d) return;
    toast.success(`${info.person.name} updated.`);
    onDone();
  };

  // A new department: their old names in another channel default to "leave vacant".
  const pickTerritory = (name) => {
    const names = { ...form.names };
    if (name && channel) for (const n of info.names) if (n.channel_id !== channel.id) names[n.name] = 'vacant';
    set({ primary_salesperson: name, names });
  };

  const p = info?.person;
  const needsHand = form && (Object.values(form.names).includes('hand') || form.orders === 'hand');

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto p-4 sm:py-10" role="dialog" aria-modal="true" aria-labelledby="sales-move-title">
      <div className="fixed inset-0 bg-slate-900/50" onClick={() => !busy && onClose()} aria-hidden="true" />
      <div className="relative w-full max-w-2xl rounded-xl bg-white shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 id="sales-move-title" className="text-base font-semibold text-ink-primary">Move / change role</h2>
            <p className="text-xs text-ink-secondary mt-0.5">{p ? `${p.name} · ${p.role_label}` : 'Loading…'}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-ink-primary">
            <X className="h-5 w-5" />
          </button>
        </div>

        {loadError ? <p className="px-5 py-6 text-sm text-red-700">{loadError}</p> : !info || !form ? (
          <p className="px-5 py-6 text-sm text-ink-secondary flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</p>
        ) : (
          <div className="px-5 py-4 space-y-5">
            {/* What they hold now */}
            <section className="rounded-lg border border-slate-200 bg-slate-50/60 p-3 text-[13px] space-y-1">
              <p><span className="text-ink-secondary">Role:</span> {p.role_label}{p.sales_title ? ` · ${p.sales_title}` : ''}{p.division ? ` · Division ${p.division}` : ''}</p>
              <p><span className="text-ink-secondary">Reports to:</span> {p.team_lead ? p.team_lead.name : 'nobody'}</p>
              <p><span className="text-ink-secondary">Zoho names:</span> {info.names.length ? info.names.map((n) => `${n.name}${n.primary ? ' (main)' : ''}${n.channel ? ` · ${n.channel}` : ''}`).join('; ') : 'none'}</p>
              {info.people.length > 0 && <p><span className="text-ink-secondary">People under them:</span> {info.people.map((x) => x.name).join(', ')}</p>}
              {info.lead_rows.length > 0 && <p><span className="text-ink-secondary">Team Lead in:</span> {info.lead_rows.map((r) => r.channel).join(', ')}</p>}
              {info.head_of.length > 0 && <p><span className="text-ink-secondary">Head of:</span> {info.head_of.map((c) => c.name).join(', ')}</p>}
              <p><span className="text-ink-secondary">Orders still to act on:</span> {info.orders_to_act_on.length ? info.orders_to_act_on.map((o) => o.getmeds_order_id).join(', ') : 'none'}</p>
            </section>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label>New role</Label>
                <select className={inputCls} value={form.role} onChange={(e) => set({ role: e.target.value })} disabled={busy}>
                  <option value="medrep">MedRep</option>
                  <option value="team_lead">Team Lead</option>
                </select>
              </div>
              <div>
                <Label>Reports to</Label>
                <select className={inputCls} value={form.team_lead_id} onChange={(e) => set({ team_lead_id: e.target.value })} disabled={busy}>
                  <option value="">Nobody</option>
                  {info.choices.team_leads.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <div>
                <Label>Department</Label>
                <select className={inputCls} value={form.channel_id} onChange={(e) => set({ channel_id: e.target.value, primary_salesperson: '' })} disabled={busy}>
                  <option value="">Keep as it is</option>
                  {info.choices.channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <Label>Main Zoho name (territory)</Label>
                <select className={inputCls} value={form.primary_salesperson} onChange={(e) => pickTerritory(e.target.value)} disabled={busy || !channel}>
                  <option value="">{channel ? 'Pick a territory…' : 'Pick a department first'}</option>
                  {(channel?.territories || []).map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name}{t.held_by.length ? ` — held by ${t.held_by.join(', ')}` : t.vacant ? ' — vacant' : ''}
                    </option>
                  ))}
                </select>
              </div>
              {form.role === 'team_lead' && (
                <div>
                  <Label>Team Lead row in</Label>
                  <select className={inputCls} value={form.lead_channel_id} onChange={(e) => set({ lead_channel_id: e.target.value })} disabled={busy}>
                    <option value="">{info.lead_rows.length ? 'Keep as it is' : 'None'}</option>
                    {info.choices.channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              )}
              {info.people.length > 0 && (
                <div>
                  <Label>Their {info.people.length} people go to</Label>
                  <select className={inputCls} value={form.people_to} onChange={(e) => set({ people_to: e.target.value })} disabled={busy}>
                    <option value="">{form.role === 'team_lead' ? 'Stay with them' : 'Choose a Team Lead…'}</option>
                    {info.choices.team_leads.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
              )}
            </div>

            {info.names.filter((n) => n.name !== form.primary_salesperson).length > 0 && (
              <div>
                <Label>Their current Zoho names</Label>
                <div className="space-y-1.5">
                  {info.names.filter((n) => n.name !== form.primary_salesperson).map((n) => (
                    <div key={n.name} className="flex items-center gap-2 text-[13px]">
                      <span className="flex-1 font-mono text-[12px]">{n.name}{n.channel ? <span className="text-ink-secondary"> · {n.channel}</span> : null}</span>
                      <select className="rounded-md border border-slate-300 px-2 py-1 text-sm" value={form.names[n.name]} disabled={busy}
                        onChange={(e) => set({ names: { ...form.names, [n.name]: e.target.value } })}>
                        <option value="keep">Keep</option>
                        <option value="hand">Hand over</option>
                        <option value="vacant">Leave vacant</option>
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {info.orders_to_act_on.length > 0 && (
              <div>
                <Label>{info.orders_to_act_on.length} orders still to act on</Label>
                <select className={inputCls} value={form.orders} onChange={(e) => set({ orders: e.target.value })} disabled={busy}>
                  <option value="keep">Keep with {p.name}</option>
                  <option value="hand">Hand over</option>
                </select>
                <p className="text-[11px] text-ink-secondary mt-1">Drafts, sent back, waiting for approval, on hold, exception. Orders with Finance or Dispatch and past orders always stay.</p>
              </div>
            )}

            {needsHand && (
              <div>
                <Label>Hand over to</Label>
                <select className={inputCls} value={form.hand_to} onChange={(e) => set({ hand_to: e.target.value })} disabled={busy}>
                  <option value="">Choose a person…</option>
                  {info.choices.sales_people.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            )}

            {preview && (
              <section className="rounded-lg border border-slate-200">
                <p className="px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-ink-secondary border-b border-slate-200">What will happen</p>
                <ul className="divide-y divide-slate-100">
                  {preview.switches.map((s, i) => (
                    <li key={i} className="px-3 py-1.5 flex items-start gap-2 text-[13px]">
                      <span className={`shrink-0 inline-block w-16 text-center px-1.5 py-0.5 rounded text-[10.5px] font-bold border ${ACTION[s.action] || ACTION.KEEP}`}>{s.action}</span>
                      <span className="text-ink-primary">{s.what}{s.detail ? <span className="text-ink-secondary"> — {s.detail}</span> : null}</span>
                    </li>
                  ))}
                </ul>
                {preview.errors.length > 0 && (
                  <div className="border-t border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-800 space-y-0.5">
                    {preview.errors.map((e, i) => <p key={i}>{e}</p>)}
                  </div>
                )}
              </section>
            )}
            {error && <p className="text-sm text-red-700">{error}</p>}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4">
          <button type="button" className={btnGhost} disabled={busy} onClick={onClose}>Cancel</button>
          {preview && !preview.errors.length ? (
            <button type="button" className={btnPrimary} disabled={busy} onClick={doApply}>{busy ? 'Applying…' : 'Apply change'}</button>
          ) : (
            <button type="button" className={btnPrimary} disabled={busy || !form} onClick={doPreview}>
              {busy ? 'Checking…' : <>Preview <ArrowRight className="w-4 h-4" /></>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default SalesMoveDialog;
