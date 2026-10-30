'use strict';

const db = require('../db/database');

/**
 * People who sell in more than one division. Oct 30, 2026 (Aaron).
 *
 * A person has one account and reports to one Team Lead, but can hold Zoho Salesperson
 * names in several divisions: Nicka holds "CLIDP | NICKA" (her primary) and "MT | 1"
 * (Modern Trade). Each name is a territory in the Team Structure, and each territory sits
 * under one channel. Such a person is "split".
 *
 * For a split person, each ORDER belongs to one channel: the channel of the Zoho
 * Salesperson on it, or the person's primary channel when the name is not one of theirs
 * (or is blank). A viewer above them sees, and counts in their team KPI, only the orders
 * in the channels that viewer covers:
 *   - the channels the viewer heads (sales_channels.head_user_id) or leads
 *     (sales_managers.user_id), where the person holds a name;
 *   - otherwise (the viewer is above them only through the Team Lead chain, as Subir is
 *     above Nicka) the person's primary channel.
 * So Mhalou (MT) sees only Nicka's MT | 1 orders, and Subir only her CLIDP ones.
 *
 * Everyone else (one channel, or no territory) is untouched: all of their orders, exactly
 * as before. A person always sees all of their own orders.
 */

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

/**
 * One read of the structure: for every split person, their channels, which of their
 * names fall in each, and their primary channel. Small tables (~100 rows each).
 */
async function loadSplitPeople() {
  const terrs = await db.prepare(
    `SELECT t.zoho_salesperson, t.zoho_alias, m.channel_id
       FROM sales_territories t JOIN sales_managers m ON m.id = t.manager_id`
  ).all();
  const channelOfName = new Map();
  for (const t of terrs) {
    if (t.zoho_salesperson) channelOfName.set(norm(t.zoho_salesperson), t.channel_id);
    if (t.zoho_alias) channelOfName.set(norm(t.zoho_alias), t.channel_id);
  }
  const accts = await db.prepare('SELECT user_id, salesperson, is_primary FROM user_salespersons ORDER BY is_primary DESC, id').all();
  const byUser = new Map();
  for (const a of accts) {
    const ch = channelOfName.get(norm(a.salesperson));
    if (ch === undefined) continue;
    const p = byUser.get(a.user_id) || { primary: ch, names: new Map() }; // first row = primary when there is one
    p.names.set(norm(a.salesperson), ch);
    // the territory's other spelling counts as the same name
    for (const t of terrs) {
      if (t.channel_id === ch && [norm(t.zoho_salesperson), norm(t.zoho_alias)].includes(norm(a.salesperson))) {
        if (t.zoho_salesperson) p.names.set(norm(t.zoho_salesperson), ch);
        if (t.zoho_alias) p.names.set(norm(t.zoho_alias), ch);
      }
    }
    byUser.set(a.user_id, p);
  }
  const split = new Map();
  for (const [uid, p] of byUser) {
    const channels = new Set(p.names.values());
    if (channels.size > 1) split.set(uid, { primary: p.primary, channels, names: p.names });
  }
  return split;
}

/** The channel one order of a split person belongs to. */
function orderChannel(person, salesperson) {
  const ch = person.names.get(norm(salesperson));
  return ch === undefined ? person.primary : ch;
}

/** Channels this viewer heads or leads in the structure. */
async function viewerChannels(viewerId) {
  const rows = await db.prepare(
    `SELECT id AS channel_id FROM sales_channels WHERE head_user_id = ?
     UNION
     SELECT channel_id FROM sales_managers WHERE user_id = ?`
  ).all(viewerId, viewerId);
  return new Set(rows.map((r) => r.channel_id));
}

/** The channels of `person` (a split entry) that this viewer may see. */
function allowedChannels(person, mine) {
  const both = [...person.channels].filter((c) => mine.has(c));
  return new Set(both.length ? both : [person.primary]);
}

/**
 * For a viewer and their team: a Map memberId -> Set of allowed channel ids, for the
 * split members only (the viewer themself is never restricted). Empty Map when nobody
 * on the team is split, which is the case for almost everyone.
 */
async function splitRulesFor(viewerId, memberIds) {
  const split = await loadSplitPeople();
  const rules = new Map();
  if (!split.size) return { split, rules };
  const relevant = memberIds.filter((id) => id !== viewerId && split.has(id));
  if (!relevant.length) return { split, rules };
  const mine = await viewerChannels(viewerId);
  for (const id of relevant) rules.set(id, allowedChannels(split.get(id), mine));
  return { split, rules };
}

/**
 * SQL for "this member's orders in the allowed channels". Orders whose Salesperson is
 * not one of the member's names belong to their primary channel.
 */
function memberOrderSql(alias, memberId, person, allowed) {
  const inAllowed = [...person.names].filter(([, ch]) => allowed.has(ch)).map(([n]) => n);
  const outside = [...person.names].filter(([, ch]) => !allowed.has(ch)).map(([n]) => n);
  const sp = `LOWER(TRIM(COALESCE(${alias}.salesperson, '')))`;
  if (allowed.has(person.primary)) {
    // everything except the names in channels the viewer does not cover
    return outside.length
      ? { sql: `(${alias}.medrep_id = ? AND ${sp} NOT IN (${outside.map(() => '?').join(', ')}))`, params: [memberId, ...outside] }
      : { sql: `${alias}.medrep_id = ?`, params: [memberId] };
  }
  if (!inAllowed.length) return { sql: '1 = 0', params: [] };
  return { sql: `(${alias}.medrep_id = ? AND ${sp} IN (${inAllowed.map(() => '?').join(', ')}))`, params: [memberId, ...inAllowed] };
}

module.exports = { loadSplitPeople, orderChannel, viewerChannels, allowedChannels, splitRulesFor, memberOrderSql };
