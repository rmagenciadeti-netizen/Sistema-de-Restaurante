// Reads the main fields of an NF-e XML received from a supplier. It extracts data only: it does not validate the digital signature
// or query the SEFAZ, so the note must still be confirmed with the issuer/provider before it is trusted.

export type ParsedInvoiceItem = { description: string; ncm: string | null; cfop: string | null; quantity: number; unitValue: number; totalValue: number };
export type ParsedInvoice = { accessKey: string; number: string; series: string; issuedAt: Date; supplierName: string; supplierDocument: string | null; totalAmount: number; items: ParsedInvoiceItem[] };

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
const tag = (xml: string, name: string) => { const match = xml.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([^<]*)</(?:\\w+:)?${name}>`)); return match ? decode(match[1]) : null; };
const block = (xml: string, name: string) => xml.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`))?.[1] ?? null;
const number = (value: string | null) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; };

export function parseNfeXml(xml: string): ParsedInvoice {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML com DOCTYPE/ENTITY não é aceito.');
  const info = xml.match(/<(?:\w+:)?infNFe\b[^>]*\bId="NFe(\d{44})"/);
  const accessKey = info?.[1] ?? tag(xml, 'chNFe');
  if (!accessKey || !isValidAccessKey(accessKey)) throw new Error('Chave de acesso da NF-e ausente ou inválida no XML.');
  const ide = block(xml, 'ide'); const emit = block(xml, 'emit'); const total = block(xml, 'ICMSTot');
  if (!ide || !emit || !total) throw new Error('O XML não parece ser uma NF-e (faltam os grupos ide, emit ou ICMSTot).');
  const issued = tag(ide, 'dhEmi') ?? tag(ide, 'dEmi');
  const issuedAt = issued ? new Date(issued) : null;
  if (!issuedAt || Number.isNaN(issuedAt.getTime())) throw new Error('Data de emissão ausente ou inválida no XML.');
  const supplierName = tag(emit, 'xNome'); const invoiceNumber = tag(ide, 'nNF');
  if (!supplierName || !invoiceNumber) throw new Error('Emitente ou número da NF-e ausente no XML.');
  const items = [...xml.matchAll(/<(?:\w+:)?det\b[^>]*>([\s\S]*?)<\/(?:\w+:)?det>/g)].map(([, det]) => {
    const product = block(det, 'prod') ?? '';
    return { description: tag(product, 'xProd') ?? 'Item', ncm: tag(product, 'NCM'), cfop: tag(product, 'CFOP'), quantity: number(tag(product, 'qCom')), unitValue: number(tag(product, 'vUnCom')), totalValue: number(tag(product, 'vProd')) };
  });
  return { accessKey, number: invoiceNumber, series: tag(ide, 'serie') ?? '1', issuedAt, supplierName, supplierDocument: tag(emit, 'CNPJ') ?? tag(emit, 'CPF'), totalAmount: number(tag(total, 'vNF')), items };
}
