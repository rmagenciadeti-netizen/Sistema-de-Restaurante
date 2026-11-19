import type { ToolResult } from './types';

// CSV of what a specialist's analysis returned. It only contains the data the caller was already allowed to see (the tools enforce permission); nothing is recomputed here.
// Text from the database is neutralised against spreadsheet formulas; numbers stay numbers (pt-BR decimal comma).
const cell = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'number' ? String(value).replace('.', ',') : typeof value === 'boolean' ? (value ? 'sim' : 'não') : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (typeof value !== 'number' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const row = (values: unknown[]) => values.map(cell).join(';');
const isFlatRows = (value: unknown): value is Record<string, unknown>[] => Array.isArray(value) && value.length > 0 && value.every(item => item && typeof item === 'object' && !Array.isArray(item));

function flatten(data: Record<string, unknown>, prefix = ''): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(data)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) out.push(...flatten(value as Record<string, unknown>, path));
    else if (!isFlatRows(value) && !(Array.isArray(value) && value.length === 0)) out.push([path, Array.isArray(value) ? value.join(' | ') : value]);
  }
  return out;
}
function tables(data: Record<string, unknown>, prefix = ''): Array<[string, Record<string, unknown>[]]> {
  const out: Array<[string, Record<string, unknown>[]]> = [];
  for (const [key, value] of Object.entries(data)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isFlatRows(value)) out.push([path, value]);
    else if (value && typeof value === 'object' && !Array.isArray(value)) out.push(...tables(value as Record<string, unknown>, path));
  }
  return out;
}

export function specialistCsv(domainName: string, results: ToolResult[], generatedAt = new Date()): string {
  const lines: string[] = [row(['Especialista', domainName]), row(['Gerado em', generatedAt.toISOString()])];
  for (const result of results) {
    lines.push('', row([`# ${result.title}`]), row(['Período', `${result.period.from.slice(0, 10)} a ${result.period.to.slice(0, 10)}`]), row(['Unidade', result.unit ?? 'Todas as autorizadas']), row(['Natureza', result.kind === 'FACT' ? 'Fato registrado' : result.kind === 'ESTIMATE' ? 'Estimativa' : 'Fatos e estimativas']), row(['Fonte', result.source]));
    for (const limitation of result.limitations) lines.push(row(['Limitação', limitation]));
    const scalars = flatten(result.data);
    if (scalars.length > 0) { lines.push(row(['Indicador', 'Valor'])); for (const [key, value] of scalars) lines.push(row([key, value])); }
    for (const [name, rows] of tables(result.data)) {
      const columns = [...new Set(rows.flatMap(item => Object.keys(item)))];
      lines.push('', row([`## ${name}`]), row(columns));
      for (const item of rows) lines.push(row(columns.map(column => item[column])));
    }
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
