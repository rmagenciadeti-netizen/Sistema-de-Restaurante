// Reads the main fields of an NF-e XML received from a supplier. It extracts data only: it does not validate the digital signature
// or query the SEFAZ, so the note must still be confirmed with the issuer/provider before it is trusted.

export type ParsedInvoiceItem = { description: string; ncm: string | null; cfop: string | null; quantity: number; unitValue: number; totalValue: number };
export type ParsedInvoice = { accessKey: string; number: string; series: string; issuedAt: Date; issueDate: string; supplierName: string; supplierDocument: string | null; totalAmount: number; items: ParsedInvoiceItem[] };

// Modulo-11 check digit of the 44-digit access key (weights 2..9 from right to left).
export function isValidAccessKey(key: string) {
  if (!/^\d{44}$/.test(key)) return false;
  let sum = 0; let weight = 2;
  for (let index = 42; index >= 0; index--) { sum += Number(key[index]) * weight; weight = weight === 9 ? 2 : weight + 1; }
  const remainder = sum % 11;
  const digit = remainder < 2 ? 0 : 11 - remainder;
  return digit === Number(key[43]);
}

const decode = (value: string) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();

// Linear-time element scanner (no backtracking regexes, so hostile input cannot stall the event loop). Elements of the wanted name are
// not expected to nest; a missing closing tag ends the scan.
type Found = { open: string; inner: string; end: number };
function nextElement(xml: string, name: string, from: number): Found | null {
  let position = from;
  while (position < xml.length) {
    const lt = xml.indexOf('<', position); if (lt < 0) return null;
    const head = /^(?:(\w+):)?(\w+)(?=[\s/>])/.exec(xml.slice(lt + 1, lt + 80));
    if (!head || head[2] !== name) { position = lt + 1; continue; }
    const gt = xml.indexOf('>', lt); if (gt < 0) return null;
    const close = `</${head[1] ? `${head[1]}:` : ''}${name}>`;
    const closeAt = xml.indexOf(close, gt + 1); if (closeAt < 0) return null;
    return { open: xml.slice(lt, gt + 1), inner: xml.slice(gt + 1, closeAt), end: closeAt + close.length };
  }
  return null;
}
const block = (xml: string, name: string) => nextElement(xml, name, 0)?.inner ?? null;
const tag = (xml: string, name: string) => { const inner = block(xml, name); return inner !== null && !inner.includes('<') ? decode(inner) : null; };
const number = (value: string | null) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; };
const MAX_ITEMS = 500;

export function parseNfeXml(xml: string): ParsedInvoice {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML com DOCTYPE/ENTITY não é aceito.');
  const accessKey = /\bId="NFe(\d{44})"/.exec(nextElement(xml, 'infNFe', 0)?.open ?? '')?.[1] ?? tag(xml, 'chNFe');
  if (!accessKey || !isValidAccessKey(accessKey)) throw new Error('Chave de acesso da NF-e ausente ou inválida no XML.');
  const ide = block(xml, 'ide'); const emit = block(xml, 'emit'); const total = block(xml, 'ICMSTot');
  if (!ide || !emit || !total) throw new Error('O XML não parece ser uma NF-e (faltam os grupos ide, emit ou ICMSTot).');
  const issued = tag(ide, 'dhEmi') ?? tag(ide, 'dEmi');
  const issuedAt = issued ? new Date(issued) : null;
  if (!issuedAt || Number.isNaN(issuedAt.getTime())) throw new Error('Data de emissão ausente ou inválida no XML.');
  const supplierName = tag(emit, 'xNome'); const invoiceNumber = tag(ide, 'nNF');
  if (!supplierName || !invoiceNumber) throw new Error('Emitente ou número da NF-e ausente no XML.');
  const items: ParsedInvoiceItem[] = [];
  for (let det = nextElement(xml, 'det', 0); det && items.length < MAX_ITEMS; det = nextElement(xml, 'det', det.end)) {
    const product = block(det.inner, 'prod') ?? '';
    items.push({ description: tag(product, 'xProd') ?? 'Item', ncm: tag(product, 'NCM'), cfop: tag(product, 'CFOP'), quantity: number(tag(product, 'qCom')), unitValue: number(tag(product, 'vUnCom')), totalValue: number(tag(product, 'vProd')) });
  }
  // issueDate keeps the calendar day exactly as written by the issuer (local time), unlike issuedAt which is an absolute instant.
  return { accessKey, number: invoiceNumber, series: tag(ide, 'serie') ?? '1', issuedAt, issueDate: (issued ?? '').slice(0, 10), supplierName, supplierDocument: tag(emit, 'CNPJ') ?? tag(emit, 'CPF'), totalAmount: number(tag(total, 'vNF')), items };
}
