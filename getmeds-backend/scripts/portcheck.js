'use strict';

/**
 * Port progress meter.
 *
 * Counts what is STILL WRONG, not what exists — so it goes to zero as the port
 * lands and can be run as a check. An AST is used rather than grep because the
 * question "is this db call awaited" cannot be answered by a regex: the await
 * may be on an enclosing parenthesised expression, and `.map()` chains put text
 * between the call and its await.
 *
 * Usage:  node scripts/portcheck.js src
 * Exit code 1 when anything is outstanding, so CI can gate on it.
 */

const fs = require('fs');
const path = require('path');
const j = require('jscodeshift').withParser('babel');
const { translate } = require('../src/db/sqlToPg');

const TERMINALS = new Set(['get', 'all', 'run']);
const DB_DIRECT = new Set(['exec', 'pragma']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(p, out);
    } else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const root = process.argv[2];
if (!root) {
  console.error('usage: node portcheck.js <src-dir>');
  process.exit(2);
}

const skipped = [];

const totals = {
  unawaitedDb: [],
  syncTransactionCallbacks: [],
  sqliteDateFns: [],
  sqliteMaster: [],
  awaitedDb: 0,
  transactions: 0,
};

for (const file of walk(root)) {
  const src = fs.readFileSync(file, 'utf8');
  if (!/\bdb\s*\.\s*(prepare|exec|pragma|transaction)\s*\(/.test(src)) continue;
  // Files that are deliberately still SQLite — the archived original data
  // layer, and the SQLite-only migration runner kept for anyone not yet moved
  // over. They are not port debt, so they must not show up as port debt;
  // otherwise this check never reaches zero and stops being read.
  if (/@sqlite-only/.test(src.slice(0, 3000))) {
    skipped.push(file.split(/[\\/]/).slice(-2).join('/'));
    continue;
  }
  const short = file.split(/[\\/]/).slice(-2).join('/');
  let r;
  try {
    r = j(src);
  } catch (err) {
    console.error(`parse error ${short}: ${err.message}`);
    continue;
  }

  const lineOf = (node) => src.slice(0, node.start ?? 0).split('\n').length;

  // statement variables: const ins = db.prepare(...)
  const stmtVars = new Set();
  r.find(j.VariableDeclarator)
    .filter((p) => {
      const i = p.node.init;
      return (
        i &&
        i.type === 'CallExpression' &&
        i.callee.type === 'MemberExpression' &&
        i.callee.object.name === 'db' &&
        i.callee.property.name === 'prepare'
      );
    })
    .forEach((p) => p.node.id.type === 'Identifier' && stmtVars.add(p.node.id.name));

  const isStmt = (n) =>
    (n.type === 'CallExpression' &&
      n.callee.type === 'MemberExpression' &&
      n.callee.object.name === 'db' &&
      n.callee.property.name === 'prepare') ||
    (n.type === 'Identifier' && stmtVars.has(n.name));

  r.find(j.CallExpression).forEach((p) => {
    const c = p.node.callee;
    if (c.type !== 'MemberExpression' || c.computed || c.property.type !== 'Identifier') return;

    const isTerminal = TERMINALS.has(c.property.name) && isStmt(c.object);
    const isDirect = DB_DIRECT.has(c.property.name) && c.object.type === 'Identifier' && c.object.name === 'db';
    if (!isTerminal && !isDirect) return;

    if (p.parent.node.type === 'AwaitExpression') totals.awaitedDb += 1;
    else totals.unawaitedDb.push(`${short}:${lineOf(p.node)}`);
  });

  r.find(j.CallExpression, {
    callee: { type: 'MemberExpression', object: { name: 'db' }, property: { name: 'transaction' } },
  }).forEach((p) => {
    totals.transactions += 1;
    const fn = p.node.arguments[0];
    if (fn && (fn.type === 'ArrowFunctionExpression' || fn.type === 'FunctionExpression') && !fn.async) {
      totals.syncTransactionCallbacks.push(`${short}:${lineOf(p.node)}`);
    }
  });

  // Ask the REAL translator what it cannot handle, instead of guessing with a
  // regex. The regex version of this check searched lowercase only and so
  // reported a clean bill of health while management.controller.js was calling
  // JULIANDAY() in capitals — a query that fails outright on Postgres.
  //
  // Every SQL string handed to db.prepare() is run through translate(), and any
  // note it raises about untranslatable syntax is reported here. That means
  // this check cannot drift from what the data layer actually does.
  r.find(j.CallExpression, {
    callee: { type: 'MemberExpression', object: { name: 'db' }, property: { name: 'prepare' } },
  }).forEach((p) => {
    const arg = p.node.arguments[0];
    if (!arg) return;
    let sql = null;
    if (arg.type === 'Literal' || arg.type === 'StringLiteral') sql = arg.value;
    // Template literal: join the static parts. The interpolations are WHERE
    // fragments and column lists built elsewhere, not date functions.
    else if (arg.type === 'TemplateLiteral') sql = arg.quasis.map((q) => q.value.cooked).join(' ? ');
    if (typeof sql !== 'string') return;

    let notes = [];
    try {
      notes = translate(sql).notes;
    } catch (err) {
      totals.sqliteDateFns.push(`${short}:${lineOf(p.node)}  translate() threw: ${err.message}`);
      return;
    }
    for (const n of notes) {
      if (n.startsWith('UNTRANSLATED') || n.startsWith('DATE()')) {
        totals.sqliteDateFns.push(`${short}:${lineOf(p.node)}  ${n}`);
      }
    }
  });
  for (const m of src.matchAll(/sqlite_master/g)) {
    totals.sqliteMaster.push(`${short}:${src.slice(0, m.index).split('\n').length}`);
  }
}

const line = (label, arr) => {
  console.log(`${String(arr.length).padStart(4)}  ${label}`);
  for (const s of arr.slice(0, 12)) console.log(`        ${s}`);
  if (arr.length > 12) console.log(`        ...and ${arr.length - 12} more`);
};

console.log('REMAINING PORT WORK');
console.log('='.repeat(60));
if (skipped.length) console.log(`      (skipping @sqlite-only: ${skipped.join(', ')})`);
line('db calls still missing await', totals.unawaitedDb);
line('db.transaction() callbacks still sync', totals.syncTransactionCallbacks);
line('SQL that sqlToPg cannot fully translate', totals.sqliteDateFns);
line('sqlite_master references (need information_schema)', totals.sqliteMaster);
console.log('-'.repeat(60));
console.log(`${String(totals.awaitedDb).padStart(4)}  db calls correctly awaited`);
console.log(`${String(totals.transactions).padStart(4)}  db.transaction() blocks total`);

const outstanding =
  totals.unawaitedDb.length +
  totals.syncTransactionCallbacks.length +
  totals.sqliteDateFns.length +
  totals.sqliteMaster.length;

console.log();
console.log(outstanding === 0 ? 'CLEAN — nothing outstanding.' : `${outstanding} items outstanding.`);
process.exit(outstanding === 0 ? 0 : 1);
