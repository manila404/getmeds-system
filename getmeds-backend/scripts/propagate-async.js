'use strict';

/**
 * Async propagation to a fixpoint.
 *
 * Sep 2, 2026. The db-call codemod turns ~175 query sites into `await`, which
 * makes their enclosing functions async. That is only the first ripple: a
 * helper that becomes async makes ITS callers wrong too, and so on. `logEvent`
 * in auditService.js is the clearest case — it writes to order_events, so it
 * becomes async, and it is called from inside 8 webhook transactions, 4 order
 * transactions and a dozen other places. Every one of those now silently gets
 * a Promise instead of nothing, and the event is written *after* the
 * transaction it was supposed to be part of has already committed.
 *
 * That is the failure this file exists to prevent. It repeatedly:
 *
 *   1. finds calls to functions known to be async,
 *   2. wraps them in `await`,
 *   3. marks the enclosing function async — which adds it to the known set,
 *
 * until a full pass changes nothing.
 *
 * Resolution is deliberately conservative. A bare name is only treated as
 * async when it is either a function declared in the same file that we marked,
 * or an identifier this file imported from a module we know exports an async
 * function of that name. Matching on bare names alone would be much simpler
 * and would eventually await something unrelated that happens to share a name.
 */

const fs = require('fs');
const path = require('path');
const jscodeshift = require('jscodeshift');

const j = jscodeshift.withParser('babel');

const DB_TERMINALS = new Set(['get', 'all', 'run']);
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

/** Call sites that would need a top-level await — reported, never rewritten. */
const topLevelAwaits = [];

/** Call sites whose RESULT is used as a promise — must not be awaited. */
const promiseValued = [];

const lineOfNode = (src, node) => src.slice(0, node.start ?? 0).split('\n').length;

/** file -> Set of local function names that are async */
const localAsync = new Map();
/** resolved module path -> Set of exported names that are async */
const exportAsync = new Map();

const addLocal = (file, name) => {
  if (!name) return false;
  if (!localAsync.has(file)) localAsync.set(file, new Set());
  const s = localAsync.get(file);
  if (s.has(name)) return false;
  s.add(name);
  return true;
};

const addExport = (file, name) => {
  if (!name) return false;
  if (!exportAsync.has(file)) exportAsync.set(file, new Set());
  const s = exportAsync.get(file);
  if (s.has(name)) return false;
  s.add(name);
  return true;
};

function resolveRequire(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, base + '.js', path.join(base, 'index.js')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

/** Names imported into this file, mapped to {module, exportName}. */
function collectImports(root, file) {
  const imports = new Map();
  root
    .find(j.VariableDeclarator)
    .filter((p) => {
      const init = p.node.init;
      return (
        init &&
        init.type === 'CallExpression' &&
        init.callee.type === 'Identifier' &&
        init.callee.name === 'require' &&
        init.arguments[0] &&
        // jscodeshift's babel parser emits `Literal`, not babel's own
        // `StringLiteral`. Matching only StringLiteral makes this function
        // return an empty map for every file — which is silent, and made the
        // first run miss every cross-file call site while still reporting a
        // clean audit. Accept both.
        (init.arguments[0].type === 'Literal' || init.arguments[0].type === 'StringLiteral') &&
        typeof init.arguments[0].value === 'string'
      );
    })
    .forEach((p) => {
      const mod = resolveRequire(file, p.node.init.arguments[0].value);
      if (!mod) return;
      const id = p.node.id;
      if (id.type === 'Identifier') {
        // const svc = require('./x')  -> svc.foo()
        imports.set(id.name, { module: mod, namespace: true });
      } else if (id.type === 'ObjectPattern') {
        // const { logEvent } = require('./x')
        for (const prop of id.properties) {
          if (prop.type !== 'ObjectProperty' && prop.type !== 'Property') continue;
          const local = prop.value.name || prop.key.name;
          imports.set(local, { module: mod, exportName: prop.key.name });
        }
      }
    });
  return imports;
}

function enclosingFunction(path) {
  let p = path.parent;
  while (p) {
    const t = p.node.type;
    if (t === 'FunctionDeclaration' || t === 'FunctionExpression' || t === 'ArrowFunctionExpression') return p;
    p = p.parent;
  }
  return null;
}

/** Best-effort name for a function node, for the async registry. */
function functionName(fnPath) {
  const n = fnPath.node;
  if (n.id && n.id.name) return n.id.name;
  const parent = fnPath.parent.node;
  if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
  if ((parent.type === 'Property' || parent.type === 'ObjectProperty') && parent.key.name) return parent.key.name;
  if (
    parent.type === 'AssignmentExpression' &&
    parent.left.type === 'MemberExpression' &&
    parent.left.property.name
  ) {
    return parent.left.property.name; // exports.foo = ...
  }
  return null;
}

/** Is this function assigned to exports.X / module.exports.X? */
function exportedNameOf(fnPath) {
  const parent = fnPath.parent.node;
  if (
    parent.type === 'AssignmentExpression' &&
    parent.left.type === 'MemberExpression' &&
    ((parent.left.object.name === 'exports') ||
      (parent.left.object.type === 'MemberExpression' &&
        parent.left.object.object.name === 'module' &&
        parent.left.object.property.name === 'exports'))
  ) {
    return parent.left.property.name;
  }
  return null;
}

/**
 * Register functions that are ALREADY async.
 *
 * Without this the registries only ever learn about functions this run marked,
 * so a second run over an already-ported tree — exactly what happens when the
 * tests are ported after the source — believes nothing is async and propagates
 * nothing. The symptom is quiet: 608 edits, a clean audit, and every test still
 * calling `logEvent()` without awaiting it.
 */
function seedAlreadyAsync(file, source) {
  if (/@sqlite-only/.test(source.slice(0, 3000))) return;
  let r;
  try {
    r = j(source);
  } catch {
    return;
  }
  for (const type of [j.FunctionDeclaration, j.FunctionExpression, j.ArrowFunctionExpression]) {
    r.find(type).forEach((p) => {
      if (!p.node.async) return;
      const name = functionName(p);
      if (name) addLocal(file, name);
      const exp = exportedNameOf(p) || (name && knownExportName(r, file, name));
      if (exp) addExport(file, exp);
    });
  }
}

/**
 * One pass over one file. Returns { source, changed, discovered }.
 * `discovered` is true when this pass marked a function async that was not
 * already known, meaning another global round is needed.
 */
/**
 * Is the identifier `db` in this file actually OUR data layer?
 *
 * The first version matched `db.prepare(...)` by NAME, which is wrong in the
 * migration test suites: they do `const db = openDb()` where openDb() is
 * `new Database(dbPath)` — a raw better-sqlite3 handle whose .run() is
 * SYNCHRONOUS. Awaiting those turned working synchronous assertions into
 * promises, and `expect(...).toThrow()` on an async callback never fires while
 * its rejection goes unhandled and kills the whole jest run.
 *
 * So the transform only applies when the file requires the db module. Files
 * that use a local better-sqlite3 handle are skipped and reported.
 */
function fileUsesOurDbLayer(root, file) {
  let found = false;
  root.find(j.VariableDeclarator).forEach((p) => {
    const init = p.node.init;
    if (
      init &&
      init.type === 'CallExpression' &&
      init.callee.type === 'Identifier' &&
      init.callee.name === 'require' &&
      init.arguments[0] &&
      typeof init.arguments[0].value === 'string' &&
      p.node.id.type === 'Identifier' &&
      p.node.id.name === 'db'
    ) {
      // Resolve the specifier to a real path rather than pattern-matching the
      // string: `require('./database')` from src/db/ and
      // `require('../src/db/database')` from tests/ are the same module, and a
      // regex that catches one misses the other. Matching './database' by
      // substring silently skipped src/db/seed.js.
      const mod = resolveRequire(file, init.arguments[0].value);
      if (mod && /[\\/]src[\\/]db[\\/](database|pg)\.js$/.test(mod)) found = true;
    }
  });
  return found;
}

/** Files skipped because their `db` is not our data layer. */
const foreignDbFiles = new Set();

function pass(file, source, { doDbCalls }) {
  // Files explicitly marked as still-SQLite are not part of the port and must
  // not be rewritten. The first run of this script ported src/db/migrate.js —
  // the SQLite-only migration runner deliberately kept working — and
  // database.sqlite.js, the archived original data layer.
  if (/@sqlite-only/.test(source.slice(0, 3000))) {
    return { source, edits: 0, discovered: false };
  }
  const root = j(source);
  const imports = collectImports(root, file);
  let edits = 0;
  let discovered = false;

  const knownLocal = localAsync.get(file) || new Set();

  const markAsync = (path) => {
    const fnPath = enclosingFunction(path);
    if (!fnPath || fnPath.node.async) return;
    fnPath.node.async = true;
    edits += 1;
    const name = functionName(fnPath);
    if (addLocal(file, name)) discovered = true;
    const exp = exportedNameOf(fnPath) || (name && knownExportName(root, file, name));
    if (exp && addExport(file, exp)) discovered = true;
  };

  const awaited = (p) => p.parent.node.type === 'AwaitExpression';

  /**
   * Wrap in `await` — but NEVER at module scope.
   *
   * A top-level await is a SyntaxError in CommonJS (this package has no
   * "type": "module"), and the naive version of this function produced five of
   * them: server.js, both migrate scripts, and two others. One was worse than a
   * syntax error — `main().catch(...)` became `(await main()).catch(...)`,
   * which awaits the promise and then calls .catch on the resolved VALUE.
   *
   * These need a human: the right shape is usually `.then(...).catch(...)` or
   * an async IIFE, and which one depends on what the script does on failure.
   * So they are collected and reported rather than guessed at.
   */
  /**
   * Is this call's result deliberately kept as a PROMISE?
   *
   *     const reconcile = reconcileOrderFully({...});      // not awaited
   *     const outcome  = await Promise.race([reconcile, timeout]);
   *
   * Awaiting the first line defeats the race entirely: the request waits for
   * Zoho forever, which is the precise bug the timeout was written to prevent.
   * The codemod did exactly this in orders.controller.js and silently removed
   * the order page's hang protection — no error, no failing assertion except
   * the one test written for it.
   *
   * So: if the variable a call is assigned to is later used as a promise —
   * .then/.catch/.finally, or an element inside Promise.race/all/allSettled/any
   * — the call is left alone and reported.
   */
  const resultUsedAsPromise = (p) => {
    const decl = p.parent.node;
    if (decl.type !== 'VariableDeclarator' || decl.id.type !== 'Identifier') return false;
    const name = decl.id.name;
    const scope = enclosingFunction(p);
    if (!scope) return false;

    let used = false;
    j(scope.node)
      .find(j.Identifier, { name })
      .forEach((idPath) => {
        const parent = idPath.parent.node;
        // reconcile.then(...) / .catch(...) / .finally(...)
        if (
          parent.type === 'MemberExpression' &&
          parent.object === idPath.node &&
          ['then', 'catch', 'finally'].includes(parent.property.name)
        ) {
          used = true;
        }
        // Promise.race([reconcile, timeout])
        if (parent.type === 'ArrayExpression') {
          const gp = idPath.parent.parent.node;
          if (
            gp &&
            gp.type === 'CallExpression' &&
            gp.callee.type === 'MemberExpression' &&
            gp.callee.object.name === 'Promise' &&
            ['race', 'all', 'allSettled', 'any'].includes(gp.callee.property.name)
          ) {
            used = true;
          }
        }
      });
    return used;
  };

  const wrap = (p) => {
    if (awaited(p)) return;

    /**
     * Directly chained: `runOnce().catch(...)` / `.then(...)` / `.finally(...)`.
     *
     * resultUsedAsPromise() below only inspects calls assigned to a VARIABLE,
     * which missed this shape entirely and produced `(await runOnce()).catch(...)`
     * in three places — awaiting the promise, then calling .catch on the
     * resolved VALUE. That is a TypeError at runtime, and in
     * zohoAutoSyncService.start() it did not fire until the first 5-minute
     * interval tick, crashing the server long after a clean startup.
     */
    const parent = p.parent.node;
    if (
      parent.type === 'MemberExpression' &&
      parent.object === p.node &&
      ['then', 'catch', 'finally'].includes(parent.property && parent.property.name)
    ) {
      promiseValued.push(`${file.split(/[\\/]/).slice(-2).join('/')}:${lineOfNode(source, p.node)}`);
      return;
    }

    if (resultUsedAsPromise(p)) {
      promiseValued.push(`${file.split(/[\\/]/).slice(-2).join('/')}:${lineOfNode(source, p.node)}`);
      return;
    }
    if (!enclosingFunction(p)) {
      topLevelAwaits.push(`${file.split(/[\\/]/).slice(-2).join('/')}:${lineOfNode(source, p.node)}`);
      return;
    }
    p.replace(j.awaitExpression(p.node));
    edits += 1;
    markAsync(p);
  };

  // --- db calls (only on the first global round) -------------------------
  if (doDbCalls && /\bdb\s*\.\s*(prepare|exec|pragma|transaction)\s*\(/.test(source) && !fileUsesOurDbLayer(root, file)) {
    foreignDbFiles.add(file.split(/[\\/]/).slice(-2).join('/'));
  }
  if (doDbCalls && fileUsesOurDbLayer(root, file)) {
    const stmtVars = new Set();
    root
      .find(j.VariableDeclarator)
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

    root
      .find(j.CallExpression)
      .filter((p) => {
        const c = p.node.callee;
        return (
          c.type === 'MemberExpression' &&
          !c.computed &&
          c.property.type === 'Identifier' &&
          DB_TERMINALS.has(c.property.name) &&
          isStmt(c.object)
        );
      })
      .forEach(wrap);

    root
      .find(j.CallExpression, { callee: { type: 'MemberExpression', object: { type: 'Identifier', name: 'db' } } })
      .filter((p) => DB_DIRECT.has(p.node.callee.property.name))
      .forEach(wrap);

    // db.transaction(fn) — callback becomes async
    root
      .find(j.CallExpression, {
        callee: { type: 'MemberExpression', object: { name: 'db' }, property: { name: 'transaction' } },
      })
      .forEach((p) => {
        const fn = p.node.arguments[0];
        if (fn && (fn.type === 'ArrowFunctionExpression' || fn.type === 'FunctionExpression') && !fn.async) {
          fn.async = true;
          edits += 1;
        }
        if (p.parent.node.type === 'CallExpression' && p.parent.node.callee === p.node) wrap(p.parent);
      });

    const txnVars = new Set();
    root
      .find(j.VariableDeclarator)
      .filter((p) => {
        const i = p.node.init;
        return (
          i &&
          i.type === 'CallExpression' &&
          i.callee.type === 'MemberExpression' &&
          i.callee.object.name === 'db' &&
          i.callee.property.name === 'transaction'
        );
      })
      .forEach((p) => p.node.id.type === 'Identifier' && txnVars.add(p.node.id.name));

    root
      .find(j.CallExpression, { callee: { type: 'Identifier' } })
      .filter((p) => txnVars.has(p.node.callee.name))
      .forEach(wrap);
  }

  // --- propagation: calls to functions we know are async ------------------
  root.find(j.CallExpression).forEach((p) => {
    const c = p.node.callee;

    // bare local call:  logEvent(...)
    if (c.type === 'Identifier') {
      const local = localAsync.get(file);
      if (local && local.has(c.name)) return wrap(p);
      const imp = imports.get(c.name);
      if (imp && !imp.namespace) {
        const exp = exportAsync.get(imp.module);
        if (exp && exp.has(imp.exportName)) return wrap(p);
      }
      return;
    }

    // namespace call:  auditService.logEvent(...)
    if (c.type === 'MemberExpression' && c.object.type === 'Identifier' && !c.computed) {
      const imp = imports.get(c.object.name);
      if (imp && imp.namespace) {
        const exp = exportAsync.get(imp.module);
        if (exp && exp.has(c.property.name)) return wrap(p);
      }
    }
  });

  return { source: edits ? root.toSource({ lineTerminator: '\n' }) : source, edits, discovered };
}

/** exports.foo = foo  — link a local name to an export name. */
function knownExportName(root, file, localName) {
  // Returns ONE name for the caller's convenience, but registers every alias
  // it finds. admin.controller.js exports the same function twice:
  //     module.exports = { getAllUsers, getAll: getAllUsers, ... }
  // Registering only the first meant `adminController.getAllUsers(...)` was
  // never awaited, and admin.test.js asserted on a response that had not been
  // written yet.
  let found = null;
  root
    .find(j.AssignmentExpression, {
      left: { type: 'MemberExpression', object: { name: 'exports' } },
      right: { type: 'Identifier', name: localName },
    })
    .forEach((p) => {
      found = p.node.left.property.name;
    });
  if (found) return found;
  // module.exports = { logEvent, resolveActor }
  //
  // Note the node type: jscodeshift's babel parser normalises object members
  // to `Property`, NOT babel's own `ObjectProperty`. Searching for
  // ObjectProperty here silently matches nothing — which is exactly what it
  // did on the first run, leaving logEvent async but its 40-odd call sites
  // un-awaited, the single most dangerous outcome this script exists to
  // prevent. Hence the assertion in the driver that every async export is
  // reachable.
  for (const type of [j.Property, j.ObjectProperty]) {
    let nodes;
    try {
      nodes = root.find(type, { value: { type: 'Identifier', name: localName } });
    } catch (e) {
      continue; // node type not known to this ast-types build
    }
    nodes.forEach((p) => {
      if (p.parent.node.type === 'ObjectExpression' && p.parent.parent.node.type === 'AssignmentExpression') {
        const left = p.parent.parent.node.left;
        if (
          left.type === 'MemberExpression' &&
          ((left.object.name === 'module' && left.property.name === 'exports') || left.object.name === 'exports')
        ) {
          addExport(file, p.node.key.name); // every alias, not just the first
          found = found || p.node.key.name;
        }
      }
    });
  }
  return found;
}

// ---------------------------------------------------------------- driver
const root = process.argv[2];
const apply = process.argv.includes('--write');
if (!root) {
  console.error('usage: node propagate-async.js <src-dir> [--write]');
  process.exit(2);
}

const files = walk(root);
const buffers = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));

// Seed the registries from what is already async before the first pass, so a
// run over a partially-ported tree sees the whole picture.
for (const [f, src] of buffers) seedAlreadyAsync(f, src);
console.log(
  `seeded from existing code: ${[...localAsync.values()].reduce((n, s) => n + s.size, 0)} async functions, ` +
    `${[...exportAsync.values()].reduce((n, s) => n + s.size, 0)} async exports`
);

let round = 0;
let totalEdits = 0;
for (;;) {
  round += 1;
  let discoveredAny = false;
  let roundEdits = 0;
  for (const f of files) {
    const before = buffers.get(f);
    let out;
    try {
      out = pass(f, before, { doDbCalls: round === 1 });
    } catch (err) {
      console.error(`  parse/transform error in ${f}: ${err.message}`);
      continue;
    }
    if (out.edits) {
      buffers.set(f, out.source);
      roundEdits += out.edits;
    }
    if (out.discovered) discoveredAny = true;
  }
  totalEdits += roundEdits;
  console.log(`round ${round}: ${roundEdits} edits`);
  if (!discoveredAny && round > 1) break;
  if (round > 12) {
    console.error('did not reach a fixpoint in 12 rounds — stopping');
    break;
  }
}

console.log(`\nfixpoint after ${round} rounds, ${totalEdits} edits total\n`);

/**
 * Independent audit of the result.
 *
 * A fixpoint that converged is not the same as a fixpoint that converged for
 * the right reason: the first run of this script "converged" in two rounds
 * because a node-type mismatch made it blind to `module.exports = { logEvent }`,
 * so logEvent went async while all of its call sites stayed synchronous. That
 * is a silent, production-breaking outcome. This pass re-reads the finished
 * buffers and reports any call to a known-async function that is not awaited.
 */
function audit() {
  const problems = [];
  for (const [file, src] of buffers) {
    let r;
    try {
      r = j(src);
    } catch {
      continue;
    }
    const imports = collectImports(r, file);
    const local = localAsync.get(file) || new Set();
    r.find(j.CallExpression).forEach((p) => {
      const c = p.node.callee;
      let isAsyncTarget = false;
      let label = '';
      if (c.type === 'Identifier') {
        if (local.has(c.name)) {
          isAsyncTarget = true;
          label = c.name;
        } else {
          const imp = imports.get(c.name);
          const exp = imp && !imp.namespace && exportAsync.get(imp.module);
          if (exp && exp.has(imp.exportName)) {
            isAsyncTarget = true;
            label = c.name;
          }
        }
      } else if (c.type === 'MemberExpression' && c.object.type === 'Identifier' && !c.computed) {
        const imp = imports.get(c.object.name);
        const exp = imp && imp.namespace && exportAsync.get(imp.module);
        if (exp && exp.has(c.property.name)) {
          isAsyncTarget = true;
          label = `${c.object.name}.${c.property.name}`;
        }
      }
      if (!isAsyncTarget) return;
      // Awaited, returned, or explicitly handed to .then/.catch/Promise.all
      const pt = p.parent.node.type;
      if (pt === 'AwaitExpression' || pt === 'ReturnStatement' || pt === 'ArrowFunctionExpression') return;
      if (pt === 'MemberExpression' && ['then', 'catch', 'finally'].includes(p.parent.node.property.name)) return;
      const line = src.slice(0, p.node.start ?? 0).split('\n').length;
      problems.push(`${file.split(/[\\/]/).slice(-2).join('/')}:${line}  ${label}()`);
    });
  }
  return problems;
}

/**
 * Sanity check on the audit itself.
 *
 * The audit shares collectImports() with the transform, so a bug in import
 * resolution makes BOTH blind at once and the audit reports "clean" — which is
 * precisely what happened on the run before this check existed. If a file
 * plainly contains relative requires but we resolved no bindings from it, the
 * audit's silence means nothing and must not be trusted.
 */
function checkImportResolutionWorks() {
  let filesWithRelRequires = 0;
  let filesWithResolvedImports = 0;
  for (const [file, src] of buffers) {
    if (!/require\(['"]\.\.?\//.test(src)) continue;
    filesWithRelRequires += 1;
    let r;
    try {
      r = j(src);
    } catch {
      continue;
    }
    if (collectImports(r, file).size > 0) filesWithResolvedImports += 1;
  }
  if (filesWithRelRequires && !filesWithResolvedImports) {
    console.error(
      `\nFATAL: ${filesWithRelRequires} files use relative require() but zero import\n` +
        'bindings resolved. Cross-file propagation did not run and the audit below\n' +
        'is meaningless. Fix collectImports() before trusting this output.\n'
    );
    process.exit(3);
  }
  console.log(
    `import resolution: ${filesWithResolvedImports}/${filesWithRelRequires} files with relative requires resolved bindings`
  );
}

checkImportResolutionWorks();

if (promiseValued.length) {
  console.log(`\nLEFT UN-AWAITED (result is used as a promise): ${promiseValued.length}`);
  console.log('Awaiting these would defeat a Promise.race/.then — verify each is right.');
  for (const t of [...new Set(promiseValued)]) console.log(`  ${t}`);
  console.log();
}

if (foreignDbFiles.size) {
  console.log(`\nSKIPPED (their \`db\` is not src/db/database): ${[...foreignDbFiles].join(', ')}`);
  console.log('These use a local better-sqlite3 handle whose calls are synchronous.\n');
}

if (topLevelAwaits.length) {
  console.log(`\nNEEDS A HUMAN: ${topLevelAwaits.length} call sites would need a top-level await`);
  console.log('(invalid in CommonJS — rewrite as .then()/.catch() or an async IIFE)');
  for (const t of [...new Set(topLevelAwaits)]) console.log(`  ${t}`);
  console.log();
}

const problems = audit();
if (problems.length) {
  console.log(`AUDIT: ${problems.length} unawaited calls to async functions remain`);
  for (const p of problems.slice(0, 40)) console.log(`  ${p}`);
  if (problems.length > 40) console.log(`  ...and ${problems.length - 40} more`);
} else {
  console.log('AUDIT: no unawaited calls to async functions remain.');
}
console.log();
console.log('Functions that became async (these are the API changes):');
for (const [file, names] of [...exportAsync].sort()) {
  console.log(`  ${file.split(/[\\/]/).slice(-2).join('/')}: ${[...names].sort().join(', ')}`);
}

if (apply) {
  for (const [f, src] of buffers) fs.writeFileSync(f, src);
  console.log('\nwritten.');
} else {
  console.log('\n(dry run — pass --write to apply)');
}
