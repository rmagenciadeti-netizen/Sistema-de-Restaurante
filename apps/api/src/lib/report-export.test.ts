import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeReport } from './report-helpers';
import { isExportFormat, reportToPdf, reportToXlsx } from './report-export';

const report = finalizeReport('demo', { from: new Date('2026-06-01T03:00:00Z'), to: new Date('2026-06-30T03:00:00Z') }, {
  columns: [{ key: 'name', label: 'Produto', type: 'text' }, { key: 'total', label: 'Total', type: 'money' }, { key: 'share', label: 'Participação', type: 'percent' }, { key: 'qty', label: 'Qtde', type: 'number' }, { key: 'at', label: 'Data', type: 'datetime' }],
  rows: [
    { name: 'Pão & "Queijo" <especial>', total: 1234.5, share: 41.2, qty: 3, at: new Date('2026-06-10T15:30:00Z') },
    { name: '=HYPERLINK("http://x")', total: 10, share: 0, qty: 1.5, at: null },
    { name: 'Açaí • 🍓', total: 'n/a', share: 58.8, qty: 1, at: new Date('2026-06-11T01:00:00Z') },
  ],
  totals: { total: 1244.5, qty: 5.5 },
});
const options = { timeZone: 'America/Sao_Paulo', title: 'Vendas / Teste', headerLines: ['Restaurante Exemplo', '12.345.678/0001-90'] };

const withTemp = (name: string, data: Buffer, run: (path: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'rm-export-'));
  try { const path = join(dir, name); writeFileSync(path, data); run(path); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const python = (code: string, path: string) => spawnSync('python3', ['-c', code, path], { encoding: 'utf8' });
// The independent readers (openpyxl/pypdf) are optional locally; the structural test below always runs.
const readers = spawnSync('python3', ['-c', 'import openpyxl, pypdf']).status === 0;

test('pdf: cross-reference table points at every object (structural check without external readers)', () => {
  const pdf = reportToPdf(report, options); const text = pdf.toString('latin1');
  const start = Number(/startxref\n(\d+)\n%%EOF/.exec(text)![1]);
  assert.equal(text.slice(start, start + 4), 'xref');
  const entries = [...text.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map(match => Number(match[1]));
  assert.ok(entries.length >= 5);
  entries.forEach((offset, index) => assert.equal(text.slice(offset, offset + `${index + 1} 0 obj`.length), `${index + 1} 0 obj`));
});

test('xlsx: archive carries the workbook parts and escapes markup', () => {
  const xlsx = reportToXlsx(report, options);
  assert.equal(xlsx.readUInt32LE(0), 0x04034b50, 'zip signature');
  const text = xlsx.toString('latin1');
  for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) assert.ok(text.includes(part), part);
});

test('xlsx: valid workbook with typed cells, bold totals and no formula injection', { skip: !readers }, () => {
  const xlsx = reportToXlsx(report, options);
  withTemp('r.xlsx', xlsx, path => {
    const check = python(`
import sys, openpyxl
ws = openpyxl.load_workbook(sys.argv[1]).active
rows = [[c.value for c in r] for r in ws.iter_rows()]
print(ws.title)
for r in rows: print(r)
print(ws['B4'].number_format, ws['C4'].number_format, ws['B7'].font.b, ws.freeze_panes)
`, path);
    assert.equal(check.status, 0, check.stderr);
    const lines = check.stdout.trim().split('\n');
    assert.equal(lines[0], 'Vendas   Teste');
    assert.match(lines[1], /Restaurante Exemplo/);
    assert.match(lines[3], /'Produto', 'Total', 'Participação', 'Qtde', 'Data'/);
    assert.match(lines[4], /Pão & "Queijo" <especial>', 1234.5, 41.2, 3, '10\/06\/2026 12:30'/);
    assert.match(lines[5], /=HYPERLINK/, 'stored as text, never as a formula');
    assert.match(lines[6], /n\/a/, 'a non-numeric money cell falls back to text');
    assert.match(lines[7], /Totais', 1244.5, None, 5.5/);
    assert.match(lines[8], /"R\$"\\ #,##0.00 0.00"%" True A4/);
  });
});

test('pdf: valid document, paginated, Latin-1 text preserved and unsupported characters replaced', { skip: !readers }, () => {
  const many = finalizeReport('demo', { from: new Date('2026-06-01T03:00:00Z'), to: new Date('2026-06-30T03:00:00Z') }, {
    columns: report.columns, rows: Array.from({ length: 80 }, (_, index) => ({ name: `Item ${index + 1} Açaí`, total: index * 10, share: 1, qty: index, at: null })), totals: { total: 100 },
  });
  const pdf = reportToPdf(many, options);
  assert.equal(pdf.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  assert.match(pdf.subarray(-6).toString('latin1'), /%%EOF/);
  withTemp('r.pdf', pdf, path => {
    const check = python(`
import sys, pypdf
r = pypdf.PdfReader(sys.argv[1])
print(len(r.pages))
t = r.pages[0].extract_text()
print('Vendas / Teste' in t, 'Açaí' in t, 'Restaurante Exemplo' in t, 'página 1 de' in t)
print('Totais' in r.pages[-1].extract_text())
`, path);
    assert.equal(check.status, 0, check.stderr);
    const [pages, first, last] = check.stdout.trim().split('\n');
    assert.ok(Number(pages) >= 2, 'long reports use more than one page');
    assert.equal(first, 'True True True True');
    assert.equal(last, 'True');
  });
  const single = reportToPdf(report, options);
  withTemp('s.pdf', single, path => {
    const check = python(`
import sys, pypdf
t = pypdf.PdfReader(sys.argv[1]).pages[0].extract_text()
print('?' in t, '\\U0001F353' in t, '(' in t)
`, path);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout.trim(), /^True False True$/);
  });
});

test('export format whitelist', () => {
  assert.equal(isExportFormat('xlsx'), true);
  assert.equal(isExportFormat('pdf'), true);
  assert.equal(isExportFormat('exe'), false);
  assert.equal(isExportFormat(undefined), false);
});
