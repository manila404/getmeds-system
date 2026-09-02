/**
 * One place that knows how a Salesperson name is compared, and one error for
 * when it doesn't match.
 *
 * Sep 2, 2026 (2). Written after discovering that Zoho does NOT reject an
 * unrecognised Salesperson name on a Sales Order — it CREATES one. Two junk
 * Salespersons ("TEST | Juan dela Cruz", "TEST | Aaron Manila") already exist
 * in org 714292728 because this app sent names that weren't there.
 *
 * That makes name-based matching unsafe in a way a warning banner cannot fix:
 * a mistyped division doesn't fail, it quietly adds a row to a list the whole
 * company uses. The org's own list shows what that costs — "HOS | MARIKINA"
 * and "HOS| MARIKINA" both exist, one space apart, as do a dozen entries
 * typed with a letter I or a lowercase L instead of a pipe.
 *
 * So the adapters resolve a name to a `salesperson_id` against the live list
 * and send the ID. An unmatched name throws instead of being sent. This
 * module holds the comparison both adapters and services/salespersonService
 * use, because three copies of a normalizer is three chances for the check to
 * disagree with what actually gets sent.
 *
 * Note what normalize deliberately does NOT do: it tolerates spacing and
 * case, and nothing else. It will not treat "MSA I KESTER" as "MSA | KESTER".
 * Guessing past a typo would attribute someone's order to a different rep,
 * which is worse than refusing.
 */

/** Case- and spacing-insensitive; "TEST  |  aaron manila" === "TEST | Aaron Manila". */
const normalize = (s) =>
  (s || '')
    .trim()
    .replace(/\s*\|\s*/g, ' | ')
    .replace(/\s+/g, ' ')
    .toLowerCase();

/**
 * The Salesperson record whose name matches, or null.
 * `list` is Zoho's shape: [{ salesperson_id, salesperson_name, ... }]
 */
function findSalesperson(list, name) {
  const target = normalize(name);
  if (!target) return null;
  return (list || []).find((s) => normalize(s && s.salesperson_name) === target) || null;
}

/**
 * Thrown by createSalesOrder rather than letting Zoho invent a Salesperson.
 *
 * Carries a `code` so the controllers' existing ZOHO_SYNC_FAILED handling
 * records something a human can act on: the order is still created locally
 * and queued for retry, and fixing the rep's division makes the retry work,
 * because zohoPayloadBuilder re-reads the mapping on every attempt.
 */
class SalespersonNotFoundError extends Error {
  constructor(name) {
    super(
      name
        ? `Salesperson "${name}" does not exist in this Zoho organization. Refusing to send it: ` +
            'Zoho would create it rather than reject it, adding a permanent row to the ' +
            "company's Salesperson list. Add the Salesperson in Zoho under exactly that name, " +
            "or correct the rep's division / display name to match one that exists."
        : 'This order has no Salesperson mapping, and Salesperson is mandatory on every Sales ' +
            'Order in this organization. Set the ordering rep\'s division and display name so ' +
            '`users.salesperson` resolves, then retry.'
    );
    this.name = 'SalespersonNotFoundError';
    this.code = 'SALESPERSON_NOT_FOUND';
    this.salespersonName = name || null;
  }
}

module.exports = { normalize, findSalesperson, SalespersonNotFoundError };
