'use strict';

/**
 * Loads the sales team structure (src/seeds/salesStructure.json) into
 * sales_channels / sales_managers / sales_territories.
 *
 *   npm run seed:structure                 insert what is missing, change nothing else
 *   npm run seed:structure -- --overwrite  also refresh names, HQ, targets and vacancy from the sheet
 *
 * Unlike `npm run seed`, this NEVER deletes anything: it only inserts rows that do
 * not exist yet (and, with --overwrite, updates rows that came from the sheet). It
 * touches only the three sales_* tables. Run `npm run migrate:pg` first so they
 * exist.
 */

require('dotenv').config();
const svc = require('../services/salesStructureService');

(async () => {
  const overwrite = process.argv.includes('--overwrite');
  const stats = await svc.importSeed({ overwrite });
  console.log(`Sales team structure loaded${overwrite ? ' (overwrite)' : ''}:`);
  console.log(JSON.stringify(stats, null, 2));
  process.exit(0);
})().catch((err) => {
  console.error('Could not load the sales team structure:', err.message);
  if (/relation .* does not exist/i.test(err.message)) console.error('Run `npm run migrate:pg` first.');
  process.exit(1);
});
