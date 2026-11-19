export type StatementLine = { date: string; amount: number; description: string };
export type ReconEntry = { id: string; type: 'INCOME' | 'EXPENSE'; amount: number; date: string; description: string };
export type ReconMatch = { line: StatementLine; entryId: string | null };

const round2 = (value: number) => Math.round(value * 100) / 100;
const DAY = 86_400_000;

// OFX amounts use a dot decimal; the sign already tells credit (+) from debit (-).
export function parseOfx(content: string): StatementLine[] {
  const lines: StatementLine[] = [];
  for (const block of content.split(/<STMTTRN>/i).slice(1)) {
    const field = (tag: string) => block.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i'))?.[1]?.trim() ?? '';
    const posted = field('DTPOSTED').match(/^(\d{4})(\d{2})(\d{2})/);
    const amount = Number(field('TRNAMT').replace(',', '.'));
    if (!posted || !Number.isFinite(amount)) continue;
    lines.push({ date: `${posted[1]}-${posted[2]}-${posted[3]}`, amount: round2(amount), description: field('MEMO') || field('NAME') || 'Lançamento' });
  }
  return lines;
}

// CSV with header "data;descricao;valor" (comma or semicolon; dd/mm/yyyy or yyyy-mm-dd; Brazilian or plain decimals).
export function parseStatementCsv(content: string): StatementLine[] {
  const rows = content.split(/\r?\n/).map(row => row.trim()).filter(Boolean);
  if (rows.length < 2) return [];
  const delimiter = rows[0].includes(';') ? ';' : ',';
  const head = rows[0].toLowerCase().split(delimiter).map(cell => cell.trim().replace(/^"|"$/g, ''));
  const col = (names: string[]) => head.findIndex(cell => names.some(name => cell.includes(name)));
  const dateCol = col(['data', 'date']); const valueCol = col(['valor', 'amount', 'value']); const descCol = col(['descri', 'hist', 'memo']);
  if (dateCol < 0 || valueCol < 0) return [];
  const out: StatementLine[] = [];
  for (const row of rows.slice(1)) {
    const cells = row.split(delimiter).map(cell => cell.trim().replace(/^"|"$/g, ''));
    const rawDate = cells[dateCol] ?? '';
    const date = /^\d{2}\/\d{2}\/\d{4}$/.test(rawDate) ? `${rawDate.slice(6)}-${rawDate.slice(3, 5)}-${rawDate.slice(0, 2)}` : /^\d{4}-\d{2}-\d{2}/.test(rawDate) ? rawDate.slice(0, 10) : '';
    const raw = (cells[valueCol] ?? '').replace(/[R$\s]/g, '');
    const amount = Number(raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw);
    if (!date || !Number.isFinite(amount)) continue;
    out.push({ date, amount: round2(amount), description: descCol >= 0 ? cells[descCol] ?? '' : '' });
  }
  return out;
}

// One-to-one greedy match: same signed amount (income positive, expense negative), closest date within the tolerance. Each entry is used at most once.
export function matchStatement(lines: StatementLine[], entries: ReconEntry[], toleranceDays = 3): { matches: ReconMatch[]; unmatchedEntries: ReconEntry[] } {
  const used = new Set<string>();
  const matches = lines.map(line => {
    const at = new Date(`${line.date}T12:00:00Z`).getTime();
    let best: ReconEntry | null = null; let bestGap = Infinity;
    for (const entry of entries) {
      if (used.has(entry.id)) continue;
      const signed = entry.type === 'INCOME' ? entry.amount : -entry.amount;
      if (round2(signed) !== line.amount) continue;
      const gap = Math.abs(new Date(`${entry.date}T12:00:00Z`).getTime() - at) / DAY;
      if (gap <= toleranceDays && gap < bestGap) { best = entry; bestGap = gap; }
    }
    if (best) used.add(best.id);
    return { line, entryId: best?.id ?? null };
  });
  return { matches, unmatchedEntries: entries.filter(entry => !used.has(entry.id)) };
}
