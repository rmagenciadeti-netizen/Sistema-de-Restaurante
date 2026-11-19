#!/usr/bin/env node
// Guards the Prisma migration history. Run in CI (needs full git history) or locally: `node scripts/check-migrations.mjs [base-ref]`.
//  1. every folder is `YYYYMMDDHHMMSS_name` with a real calendar date and contains migration.sql;
//  2. migrations that already exist on the base ref are never renamed or removed (they may be applied in production);
//  3. every NEW migration sorts after the newest one of the base ref (Prisma applies folders in lexicographic order);
//  4. each new migration is at most 3 days after the migration before it, so a wrong clock cannot push a timestamp far past every
//     migration that will be created later (the history already carries dates ahead of the calendar; that is kept, not renamed).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

const DIR = 'packages/db/prisma/migrations';
const base = process.argv[2] ?? 'origin/main';
const fail = message => { console.error(`migration check failed: ${message}`); process.exit(1); };
const parse = name => {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_[a-z0-9_]+$/.exec(name);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date.getTime() : null;
};

const current = readdirSync(DIR, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
for (const name of current) {
  if (parse(name) === null) fail(`"${name}" is not YYYYMMDDHHMMSS_snake_case with a valid date`);
  if (!existsSync(`${DIR}/${name}/migration.sql`)) fail(`"${name}" has no migration.sql`);
}

let existing = [];
try {
  existing = execFileSync('git', ['ls-tree', '-d', '--name-only', `${base}:${DIR}`], { encoding: 'utf8' }).split('\n').filter(Boolean).map(path => path.split('/').pop()).sort();
} catch { console.log(`base ref ${base} not available: only the format was checked`); process.exit(0); }

for (const name of existing) if (!current.includes(name)) fail(`applied migration "${name}" was renamed or removed`);
const added = current.filter(name => !existing.includes(name));
let previous = existing.at(-1);
for (const name of added) {
  if (previous && name <= previous) fail(`new migration "${name}" must sort after "${previous}"`);
  if (previous && parse(name) - parse(previous) > 3 * 86_400_000) fail(`new migration "${name}" is more than 3 days after "${previous}"; use a timestamp right after it`);
  previous = name;
}
console.log(`migrations ok: ${current.length} total, ${added.length} new since ${base}`);
