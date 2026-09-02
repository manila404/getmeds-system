/**
 * Read-only: does this Zoho org actually have a Salesperson for every MedRep?
 *
 * Sep 2, 2026. Salesperson is a MANDATORY field on every Sales Order in this
 * org and createSalesOrder sends it BY NAME, from users.salesperson — the
 * generated "<division> | <display name>" column. Zoho does not create a name
 * it does not recognise; it rejects the Sales Order. So a mapping that looks
 * fine locally still fails at submit, after the MedRep has filled in the whole
 * order, and the only way to know beforehand is to ask Zoho.
 *
 * Verification goes through services/salespersonService.verify, deliberately —
 * the same function the order form's pre-check calls. Reimplementing the
 * comparison here would mean this script could pass while the app still
 * warned, or the reverse.
 *
 * Makes exactly ONE Zoho call (listSalespersons) and writes nothing, to Zoho
 * or to the local database.
 *
 *   npm run check:salespersons
 */
require('dotenv').config();
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');
const salespersonService = require('../src/services/salespersonService');

async function main() {
  console.log('\n── Salesperson mapping check ───────────────────────────\n');
  console.log(`  mode: ${zoho.mode}`);
  console.log(`  org:  ${process.env.ZOHO_ORG_ID || '(unset)'}\n`);

  let names;
  try {
    const res = await zoho.listSalespersons();
    names = (res.salespersons || []).map((s) => (s.salesperson_name || '').trim()).filter(Boolean);
  } catch (err) {
    console.log(`  ❌ Could not read the Salesperson list: ${err.message}\n`);
    console.log('     Nothing was checked. This is a connection problem, not a mapping one.\n');
    process.exitCode = 1;
    return;
  }

  console.log(`1. Zoho knows ${names.length} Salesperson(s)\n`);
  for (const n of [...names].sort()) console.log(`     ${n}`);

  const users = db
    .prepare(
      `SELECT id, name, email, role, division, sub_division, display_name, salesperson, is_active
         FROM users ORDER BY (role = 'medrep') DESC, email`
    )
    .all();

  console.log(`\n2. Local users (${users.length})\n`);

  const unmapped = [];
  const rejected = [];

  for (const u of users) {
    const verification = await salespersonService.verify(u.salesperson);
    const label = `${u.email} [${u.role}]${u.is_active ? '' : ' (inactive)'}`;

    if (!u.salesperson) {
      console.log(`  ⚠️  ${label}`);
      console.log('       no mapping — division and/or display name is blank');
      if (u.role === 'medrep' && u.is_active) unmapped.push(u.email);
    } else if (verification.exists) {
      console.log(`  ✅ ${label}`);
      console.log(`       "${u.salesperson}" → Zoho "${verification.matchedName}"`);
    } else if (verification.checked) {
      console.log(`  ❌ ${label}`);
      console.log(`       "${u.salesperson}" is NOT a Salesperson in this org`);
      if (u.is_active) rejected.push(`${u.email} → "${u.salesperson}"`);
    } else {
      console.log(`  ⚠️  ${label}`);
      console.log(`       could not check (${verification.reason})`);
    }
  }

  console.log('\n3. Verdict\n');

  if (rejected.length) {
    console.log('  ❌ These users will have every real Sales Order REJECTED by Zoho:\n');
    for (const r of rejected) console.log(`       ${r}`);
    console.log('\n     Fix by adding the Salesperson in Zoho under exactly that name, or by');
    console.log('     correcting the user\'s division / display name so it matches one above.');
  }

  if (unmapped.length) {
    console.log('\n  ⚠️  These active MedReps have no mapping at all, so nothing is sent and');
    console.log('     Zoho rejects the Sales Order for a missing mandatory field:\n');
    for (const e of unmapped) console.log(`       ${e}`);
  }

  if (!rejected.length && !unmapped.length) {
    console.log('  ✅ Every active user with a mapping matches a Salesperson in this org.');
  }

  console.log('\nNothing was written — to Zoho or to the local database.\n');
}

main()
  .catch((err) => {
    console.error('\nUnexpected failure:', err.message, '\n');
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode || 0));
