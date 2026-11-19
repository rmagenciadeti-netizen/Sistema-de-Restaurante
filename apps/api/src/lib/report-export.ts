import { createZip } from './zip';
import { D, type ReportColumn, type ReportColumnType, type ReportRow, type TabularReport } from './report-helpers';

// Excel (.xlsx) and PDF writers for any TabularReport, with no third-party dependency (the xlsx is a ZIP of small XML parts, the PDF uses the built-in Helvetica font).
export type ExportOptions = { timeZone: string; title: string; headerLines?: string[] };

const escapeXml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

export function formatDateTimeCell(value: unknown, timeZone: string): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  const parts = new Intl.DateTimeFormat('pt-BR', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (name: string) => parts.find(part => part.type === name)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}`;
}

// The first text column of the totals row carries the label, like the CSV export does.
function withTotals(report: TabularReport): ReportRow[] {
  if (!report.totals) return report.rows;
  const totals = { ...report.totals };
  const first = report.columns.find(column => column.type === 'text');
  if (first && (totals[first.key] === undefined || totals[first.key] === null)) totals[first.key] = 'Totais';
  return [...report.rows, totals];
}

const columnName = (index: number) => { let name = ''; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name; return name; };
const isNumeric = (type: ReportColumnType) => type === 'money' || type === 'number' || type === 'percent';
const numberOf = (value: unknown) => { try { const parsed = Number(D(value as never).toString()); return Number.isFinite(parsed) ? parsed : null; } catch { return null; } };

// cellXfs index: 0 text, 1 header, 2 money, 3 percent, 4 number, then the bold (totals) variants 5 text, 6 money, 7 percent, 8 number.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;R$&quot;\\ #,##0.00"/><numFmt numFmtId="165" formatCode="0.00&quot;%&quot;"/></numFmts><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF171612"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="9"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/><xf numFmtId="165" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/><xf numFmtId="4" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
const styleFor = (type: ReportColumnType, bold: boolean) => (bold ? 5 + (type === 'money' ? 1 : type === 'percent' ? 2 : type === 'number' ? 3 : 0) : type === 'money' ? 2 : type === 'percent' ? 3 : type === 'number' ? 4 : 0);

function cellXml(reference: string, column: ReportColumn, value: unknown, bold: boolean, timeZone: string): string {
  if (value === null || value === undefined || value === '') return '';
  if (isNumeric(column.type)) {
    const number = numberOf(value);
    if (number !== null) return `<c r="${reference}" s="${styleFor(column.type, bold)}"><v>${number}</v></c>`;
  }
  const text = column.type === 'datetime' ? formatDateTimeCell(value, timeZone) : String(value);
  return `<c r="${reference}" t="inlineStr" s="${bold ? 5 : 0}"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

export function reportToXlsx(report: TabularReport, options: ExportOptions): Buffer {
  const header = options.headerLines ?? [];
  const rows = withTotals(report);
  const firstDataRow = header.length + 2;
  const lines: string[] = [];
  header.forEach((line, index) => lines.push(`<row r="${index + 1}"><c r="A${index + 1}" t="inlineStr" s="5"><is><t xml:space="preserve">${escapeXml(line)}</t></is></c></row>`));
  const headerRow = header.length + 1;
  lines.push(`<row r="${headerRow}">${report.columns.map((column, index) => `<c r="${columnName(index)}${headerRow}" t="inlineStr" s="1"><is><t xml:space="preserve">${escapeXml(column.label)}</t></is></c>`).join('')}</row>`);
  rows.forEach((row, rowIndex) => {
    const number = firstDataRow + rowIndex;
    const bold = Boolean(report.totals) && rowIndex === rows.length - 1;
    lines.push(`<row r="${number}">${report.columns.map((column, index) => cellXml(`${columnName(index)}${number}`, column, row[column.key], bold, options.timeZone)).join('')}</row>`);
  });
  const widths = report.columns.map(column => {
    const longest = Math.max(column.label.length, ...rows.slice(0, 200).map(row => String(row[column.key] ?? '').length));
    return Math.min(60, Math.max(10, longest + 2));
  });
  const lastColumn = columnName(Math.max(0, report.columns.length - 1));
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols><sheetData>${lines.join('')}</sheetData><autoFilter ref="A${headerRow}:${lastColumn}${headerRow + Math.max(1, rows.length)}"/></worksheet>`;
  const sheetName = escapeXml(options.title.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Relatorio');
  return createZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'xl/styles.xml', data: STYLES },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
}

// ---- PDF (A4 landscape, Helvetica, WinAnsi). Text outside Latin-1 is replaced by '?' so the file never breaks. ----
const PAGE_WIDTH = 842; const PAGE_HEIGHT = 595; const MARGIN = 36; const ROW_HEIGHT = 15; const FONT_SIZE = 8;
const AVERAGE_CHAR = FONT_SIZE * 0.52;

const pdfText = (value: string) => Buffer.from(value.replace(/[\u2010-\u2015]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\u2026/g, '...').normalize('NFC').replace(/[^\u0020-\u007e\u00a0-\u00ff]/g, '?'), 'latin1');
const pdfEscape = (value: string) => pdfText(value).toString('latin1').replace(/[\\()]/g, '\\$&');
const fit = (text: string, width: number) => { const max = Math.max(1, Math.floor(width / AVERAGE_CHAR)); return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}~` : text; };

function pdfCell(column: ReportColumn, value: unknown, timeZone: string): string {
  if (value === null || value === undefined || value === '') return '';
  if (column.type === 'money' && numberOf(value) === null) return String(value);
  if (column.type === 'money') return `R$ ${D(value as never).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
  if (column.type === 'percent' && numberOf(value) === null) return String(value);
  if (column.type === 'percent') return `${D(value as never).toFixed(2).replace('.', ',')}%`;
  if (column.type === 'number') return Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
  if (column.type === 'datetime') return formatDateTimeCell(value, timeZone);
  return String(value);
}

export function reportToPdf(report: TabularReport, options: ExportOptions): Buffer {
  const rows = withTotals(report);
  const usable = PAGE_WIDTH - MARGIN * 2;
  const weights = report.columns.map(column => Math.min(40, Math.max(8, column.label.length, ...rows.slice(0, 100).map(row => pdfCell(column, row[column.key], options.timeZone).length))));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const widths = weights.map(weight => (weight / totalWeight) * usable);
  const offsets = widths.map((_, index) => MARGIN + widths.slice(0, index).reduce((sum, width) => sum + width, 0));
  const titleLines = [options.title, ...(options.headerLines ?? []), `Período: ${new Date(report.period.from).toLocaleDateString('pt-BR', { timeZone: options.timeZone })} a ${new Date(report.period.to).toLocaleDateString('pt-BR', { timeZone: options.timeZone })}`];
  const headerHeight = 20 + titleLines.length * 12 + 6;
  const rowsPerPage = Math.max(1, Math.floor((PAGE_HEIGHT - MARGIN * 2 - headerHeight - 18) / ROW_HEIGHT));
  const pages: string[][] = [];
  for (let start = 0; start < Math.max(1, rows.length); start += rowsPerPage) pages.push([]);
  const totalPages = pages.length;

  pages.forEach((content, pageIndex) => {
    let y = PAGE_HEIGHT - MARGIN;
    titleLines.forEach((line, index) => { content.push(`BT /F2 ${index === 0 ? 13 : 9} Tf ${MARGIN} ${y} Td (${pdfEscape(line)}) Tj ET`); y -= index === 0 ? 18 : 12; });
    y -= 8;
    content.push(`0.09 0.09 0.07 rg ${MARGIN} ${y - 4} ${usable} ${ROW_HEIGHT} re f 1 1 1 rg`);
    report.columns.forEach((column, index) => content.push(`BT /F2 ${FONT_SIZE} Tf ${offsets[index] + 3} ${y} Td (${pdfEscape(fit(column.label, widths[index] - 6))}) Tj ET`));
    content.push('0 0 0 rg');
    y -= ROW_HEIGHT;
    rows.slice(pageIndex * rowsPerPage, (pageIndex + 1) * rowsPerPage).forEach((row, rowIndex) => {
      const absolute = pageIndex * rowsPerPage + rowIndex;
      const isTotal = Boolean(report.totals) && absolute === rows.length - 1;
      if (rowIndex % 2 === 1 && !isTotal) content.push(`0.95 0.94 0.91 rg ${MARGIN} ${y - 4} ${usable} ${ROW_HEIGHT} re f 0 0 0 rg`);
      report.columns.forEach((column, index) => {
        const text = fit(pdfCell(column, row[column.key], options.timeZone), widths[index] - 6);
        if (!text) return;
        const x = isNumeric(column.type) ? offsets[index] + widths[index] - 3 - text.length * AVERAGE_CHAR : offsets[index] + 3;
        content.push(`BT /${isTotal ? 'F2' : 'F1'} ${FONT_SIZE} Tf ${x.toFixed(2)} ${y} Td (${pdfEscape(text)}) Tj ET`);
      });
      y -= ROW_HEIGHT;
    });
    if (report.truncated && pageIndex === totalPages - 1) content.push(`BT /F1 7 Tf ${MARGIN} ${MARGIN + 12} Td (${pdfEscape('Mostrando apenas os primeiros resultados.')}) Tj ET`);
    content.push(`BT /F1 7 Tf ${MARGIN} ${MARGIN - 14} Td (${pdfEscape(`RM Restaurant - página ${pageIndex + 1} de ${totalPages}`)}) Tj ET`);
  });

  const objects: Buffer[] = [];
  const add = (body: string | Buffer) => { objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1')); return objects.length; };
  const catalog = add('');
  const pagesRoot = add('');
  const regular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const pageIds = pages.map(content => {
    const stream = Buffer.from(content.join('\n'), 'latin1');
    const contentId = add(Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'latin1'), stream, Buffer.from('\nendstream', 'latin1')]));
    return add(`<< /Type /Page /Parent ${pagesRoot} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> >> /Contents ${contentId} 0 R >>`);
  });
  objects[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesRoot} 0 R >>`, 'latin1');
  objects[pagesRoot - 1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`, 'latin1');

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')]; const positions: number[] = []; let size = chunks[0].length;
  objects.forEach((body, index) => {
    positions.push(size);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    chunks.push(chunk); size += chunk.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${positions.map(position => `${String(position).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${size}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

export const EXPORT_FORMATS = { csv: 'text/csv; charset=utf-8', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf' } as const;
export type ExportFormat = keyof typeof EXPORT_FORMATS;
export const isExportFormat = (value: unknown): value is ExportFormat => typeof value === 'string' && Object.hasOwn(EXPORT_FORMATS, value);
