#!/usr/bin/env node
// Builds the knowledge index of the RM Assistente guide from the REAL screens: menu structure (apps/web/lib/menu-catalog.ts) and, for every
// page under apps/web/app, its title, subtitle, tabs, field labels (with hints) and button texts, read from the page and the components it imports.
//   node --import tsx scripts/generate-guide-screens.mjs          writes apps/api/src/lib/guide/screens.generated.json
//   node --import tsx scripts/generate-guide-screens.mjs --check  fails when the file is out of date (used by the API test / CI)
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'apps/web');
const OUT = join(root, 'apps/api/src/lib/guide/screens.generated.json');
const menu = await import(pathToFileURL(join(web, 'lib/menu-catalog.ts')).href);

const unique = list => [...new Set(list.map(item => item.replace(/\s+/g, ' ').trim()).filter(Boolean))];
// Shared shell pieces appear on every page; they are not part of any screen's own form.
const SHELL_FILES = /\/(app-shell|notification-bell|nav-link|rm-logo|offline-sync|pwa-register|guide-help|guide-panel)\.tsx$/;
const IGNORED_LABELS = new Set(['Pergunta', 'Pergunta ao RM Assistente', 'Atalhos', 'Seções']);

function sourceOf(file, seen = new Set()) {
  if (seen.has(file) || !existsSync(file)) return '';
  seen.add(file);
  let text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/from '(\.[^']+)'/g)) {
    const base = resolve(dirname(file), match[1]);
    for (const candidate of [`${base}.tsx`, join(base, 'index.tsx')]) if (existsSync(candidate) && /\/(components|app)\//.test(candidate) && !SHELL_FILES.test(candidate)) text += '\n' + sourceOf(candidate, seen);
  }
  return text;
}

function describe(source) {
  const found = [];
  for (const match of source.matchAll(/\blabel="([^"{}]{2,90})"/g)) {
    if (IGNORED_LABELS.has(match[1])) continue;
    const window = source.slice(match.index, match.index + 420);
    const end = window.search(/\/>|<\/|\n\s*\n/);
    const hint = (end > 0 ? window.slice(0, end) : window).match(/\bhint="([^"]{3,220})"/)?.[1];
    found.push({ at: match.index, label: match[1].replace(/\s+/g, ' ').trim(), ...(hint ? { hint } : {}) });
  }
  // `label={cond ? 'A' : 'B'}`: both alternatives are real labels of the same field.
  for (const match of source.matchAll(/\blabel=\{([^{}]{3,160})\}/g)) for (const item of match[1].matchAll(/'((?:[^'$]|\$(?!\{)){3,90})'/g)) if (!IGNORED_LABELS.has(item[1])) found.push({ at: match.index, label: item[1].trim() });
  found.sort((a, b) => a.at - b.at);
  const seenField = new Set();
  const uniqueFields = found.filter(field => (seenField.has(field.label) ? false : seenField.add(field.label))).map(({ at: _at, ...field }) => field);
  // Static texts, plus the quoted alternatives of `{cond ? 'Salvar' : 'Criar'}` children.
  const dynamic = [...source.matchAll(/<button\b[^>]*>\s*\{([^{}<>]{3,160})\}\s*<\/button>/g)].flatMap(match => [...match[1].matchAll(/'((?:[^'$]|\$(?!\{)){3,40})'/g)].map(item => item[1]));
  const buttons = unique([...source.matchAll(/<button\b[^>]*>\s*([^<>{}\n]{2,40}?)\s*<\/button>/g)].map(match => match[1])
    .concat([...source.matchAll(/>([A-ZÀ-Ú][^<>{}\n]{2,38})<\/button>/g)].map(match => match[1])).concat(dynamic));
  const tabs = unique([...source.matchAll(/\{\s*key:\s*'[^']+',\s*label:\s*'([^']+)'/g)].map(match => match[1]));
  const title = source.match(/<PageHeader\s+title="([^"]+)"/)?.[1] ?? source.match(/<AppShell\s+title="([^"]+)"/)?.[1] ?? null;
  const subtitle = source.match(/<PageHeader\s+title="[^"]+"\s+subtitle="([^"]+)"/)?.[1] ?? null;
  return { title, subtitle, tabs, fields: uniqueFields, buttons };
}

const menuEntries = new Map();
const addEntry = (item, group) => { const key = menu.pathOf(item.href); menuEntries.set(key, [...(menuEntries.get(key) ?? []), { label: item.label, group, href: item.href }]); };
for (const group of menu.menuGroups) for (const item of group.items) if (!item.masterOnly) addEntry(item, group.title);
for (const tab of menu.topTabs) addEntry(tab, 'Acesso rápido');

const screens = [];
for (const entry of readdirSync(join(web, 'app'), { withFileTypes: true }).filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  const page = join(web, 'app', entry.name, 'page.tsx');
  if (!existsSync(page) || entry.name.startsWith('[')) continue;
  const href = `/${entry.name}`;
  screens.push({ href, menu: menuEntries.get(href) ?? [], module: menu.moduleOfHref(href) ?? null, ...describe(sourceOf(page)) });
}
const reports = menu.reportMenu.filter(item => item.href.includes('?r=')).map(item => ({ href: item.href, label: item.label }));
const flowList = menu.flows.map(flow => ({ title: flow.title, hrefs: flow.hrefs }));

const output = `${JSON.stringify({ generatedFrom: 'apps/web (menu-catalog + pages)', groups: menu.menuGroups.filter(group => group.items.some(item => !item.masterOnly)).map(group => ({ title: group.title, icon: group.icon })), screens, reports, flows: flowList }, null, 1)}\n`;
if (process.argv.includes('--check')) {
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== output) { console.error('guide index is out of date: run `node --import tsx scripts/generate-guide-screens.mjs` and commit the result'); process.exit(1); }
  console.log(`guide index up to date (${screens.length} screens)`);
} else { writeFileSync(OUT, output); console.log(`guide index written: ${screens.length} screens`); }
