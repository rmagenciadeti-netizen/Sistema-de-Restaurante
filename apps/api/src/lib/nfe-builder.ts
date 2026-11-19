import { createHash } from 'node:crypto';
import { FiscalConfigError, type FiscalIssuer } from './fiscal-config';
import { brandCode } from './card-brands';
import { spread } from './fiscal-focus';
import type { FiscalContext, FiscalItemTax, FiscalOrder } from './providers';
import { clean, g, NFE_NS, t } from './xml-signature';

/** Layout NF-e/NFC-e 4.00 (MOC 7.0 + NTs vigentes). Values in cents internally to avoid rounding drift between items and totals. */
export const UF_CODE: Record<string, string> = { RO: '11', AC: '12', AM: '13', RR: '14', PA: '15', AP: '16', TO: '17', MA: '21', PI: '22', CE: '23', RN: '24', PB: '25', PE: '26', AL: '27', SE: '28', BA: '29', MG: '31', ES: '32', RJ: '33', SP: '35', PR: '41', SC: '42', RS: '43', MS: '50', MT: '51', GO: '52', DF: '53' };
const UF_OFFSET: Record<string, string> = { AC: '-05:00', AM: '-04:00', RO: '-04:00', RR: '-04:00', MT: '-04:00', MS: '-04:00' };
export const HOMOLOGATION_NAME = 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';
const HOMOLOGATION_ITEM = 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';
// Payment group of the card/PIX family. A payment taken through TEF is reported as integrated (tpIntegra 1) with the REAL data the provider returned; incomplete data stops the document instead of being invented.
function cardGroup(payment: NonNullable<FiscalOrder['payments']>[number], code: string): string {
  if (!['03', '04', '10', '11', '12', '13', '17', '18'].includes(code)) return '';
  if (!payment.integrated) return g('card', [t('tpIntegra', '2')]);
  const cnpj = (payment.acquirerCnpj ?? '').replace(/\D/g, '');
  if (['03', '04', '10', '11', '12', '13'].includes(code)) {
    if (cnpj.length !== 14 || !payment.cardBrand || !payment.authorizationCode) throw new FiscalConfigError('Pagamento por cartão via TEF sem CNPJ da adquirente, bandeira ou código de autorização retornados pelo provedor: o documento não pode ser emitido com dados presumidos. Consulte a transação TEF.');
    return g('card', [t('tpIntegra', '1'), t('CNPJ', cnpj), t('tBand', brandCode(payment.cardBrand)), t('cAut', clean(payment.authorizationCode, 20))]);
  }
  return g('card', [t('tpIntegra', '1'), cnpj.length === 14 ? t('CNPJ', cnpj) : '']);
}
const PAYMENT_CODE: Record<string, string> = { CASH: '01', CREDIT_CARD: '03', DEBIT_CARD: '04', VOUCHER: '10', PIX: '17', OTHER: '99' };
// CFOPs accepted in NFC-e (MOC, regra de validação da NFC-e).
export const NFCE_CFOPS = ['5101', '5102', '5103', '5104', '5115', '5405', '5656', '5667', '5933'];

const cents = (value: string | number | null | undefined) => Math.round(Number(value ?? 0) * 100);
const money = (value: number) => (value / 100).toFixed(2);
const rateOf = (value: string | null | undefined) => (value === null || value === undefined || value === '' ? null : Number(value));
const pct = (value: number, digits = 2) => value.toFixed(digits);
const taxOn = (baseCents: number, rate: number) => Math.round((baseCents * rate) / 100);

export function localDateTime(date: Date, uf: string) {
  const offset = UF_OFFSET[uf] ?? '-03:00';
  const minutes = (offset.startsWith('-') ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4)));
  return `${new Date(date.getTime() + minutes * 60_000).toISOString().slice(0, 19)}${offset}`;
}
export function mod11(digits: string) {
  let sum = 0; let weight = 2;
  for (let i = digits.length - 1; i >= 0; i--) { sum += Number(digits[i]) * weight; weight = weight === 9 ? 2 : weight + 1; }
  const dv = 11 - (sum % 11);
  return dv >= 10 ? 0 : dv;
}
// cNF is derived from the document reference, so the same document always rebuilds the same access key.
export function accessKey(parts: { uf: string; issuedAt: Date; cnpj: string; model: '55' | '65'; series: string; number: string; tpEmis: string; ref: string }) {
  const local = localDateTime(parts.issuedAt, parts.uf);
  let cNF = String(parseInt(createHash('sha1').update(parts.ref).digest('hex').slice(0, 12), 16) % 100_000_000).padStart(8, '0');
  if (Number(cNF) === Number(parts.number)) cNF = String((Number(cNF) + 1) % 100_000_000).padStart(8, '0');
  const base = `${UF_CODE[parts.uf]}${local.slice(2, 4)}${local.slice(5, 7)}${parts.cnpj}${parts.model}${parts.series.padStart(3, '0')}${parts.number.padStart(9, '0')}${parts.tpEmis}${cNF}`;
  return { key: `${base}${mod11(base)}`, cNF, cDV: String(mod11(base)) };
}

type ItemValues = { vProd: number; vDesc: number; vFrete: number; vOutro: number };
type Totals = { vBC: number; vICMS: number; vFCP: number; vIPI: number; vPIS: number; vCOFINS: number };

function icmsXml(tax: FiscalItemTax, crt: number, values: ItemValues, totals: Totals): string {
  const code = (tax.icmsCst ?? '').trim(); const orig = String(tax.origin ?? 0);
  const base = values.vProd - values.vDesc + values.vFrete + values.vOutro;
  const rate = rateOf(tax.icmsRate) ?? 0; const reduction = rateOf(tax.icmsReduction) ?? 0; const fcp = rateOf(tax.fcpRate);
  // ICMS20 lists pRedBC before vBC; ICMS90 and ICMSSN900 list it after vBC.
  const taxed = (withReduction: boolean, reductionFirst = true, withFcpBase = true) => {
    const vBC = withReduction ? Math.round(base * (1 - reduction / 100)) : base; const vICMS = taxOn(vBC, rate);
    totals.vBC += vBC; totals.vICMS += vICMS;
    const vFCP = fcp ? taxOn(vBC, fcp) : 0; totals.vFCP += vFCP;
    const red = withReduction ? t('pRedBC', pct(reduction, 4)) : '';
    return [t('modBC', '3'), reductionFirst ? red : '', t('vBC', money(vBC)), reductionFirst ? '' : red, t('pICMS', pct(rate, 4)), t('vICMS', money(vICMS)), ...(fcp ? [withFcpBase ? t('vBCFCP', money(vBC)) : '', t('pFCP', pct(fcp, 4)), t('vFCP', money(vFCP))] : [])];
  };
  if (crt === 1 || crt === 4) {
    if (['102', '103', '300', '400'].includes(code)) return g('ICMS', [g('ICMSSN102', [t('orig', orig), t('CSOSN', code)])]);
    if (code === '101') return g('ICMS', [g('ICMSSN101', [t('orig', orig), t('CSOSN', code), t('pCredSN', pct(rate, 4)), t('vCredICMSSN', money(taxOn(base, rate)))])]);
    if (code === '500') return g('ICMS', [g('ICMSSN500', [t('orig', orig), t('CSOSN', code)])]);
    if (code === '900') return g('ICMS', [g('ICMSSN900', [t('orig', orig), t('CSOSN', code), ...(rate > 0 ? taxed(reduction > 0, false).filter(item => !/^<(vBCFCP|pFCP|vFCP)>/.test(item)) : [])])]);
    throw new FiscalConfigError(`CSOSN ${code || '(vazio)'} não suportado pelo conector direto (use 101, 102, 103, 300, 400, 500 ou 900).`);
  }
  // ICMS00 carries pFCP/vFCP only; ICMS20/90 also carry the FCP base (vBCFCP).
  if (code === '00') return g('ICMS', [g('ICMS00', [t('orig', orig), t('CST', code), ...taxed(false, true, false)])]);
  if (code === '20') return g('ICMS', [g('ICMS20', [t('orig', orig), t('CST', code), ...taxed(true)])]);
  if (['40', '41', '50'].includes(code)) return g('ICMS', [g('ICMS40', [t('orig', orig), t('CST', code)])]);
  if (code === '60') return g('ICMS', [g('ICMS60', [t('orig', orig), t('CST', code)])]);
  if (code === '90') return g('ICMS', [g('ICMS90', [t('orig', orig), t('CST', code), ...(rate > 0 ? taxed(reduction > 0, false) : [])])]);
  throw new FiscalConfigError(`CST ICMS ${code || '(vazio)'} não suportado pelo conector direto (use 00, 20, 40, 41, 50, 60 ou 90).`);
}

function contribXml(kind: 'PIS' | 'COFINS', cst: string | null, rateText: string | null, base: number, totals: Totals): string {
  const code = (cst ?? '').trim(); if (!code) return '';
  const rate = rateOf(rateText) ?? 0; const value = taxOn(base, rate);
  const taxed = [t('CST', code), t('vBC', money(base)), t(`p${kind}`, pct(rate, 4)), t(`v${kind}`, money(value))];
  if (['01', '02'].includes(code)) { totals[kind === 'PIS' ? 'vPIS' : 'vCOFINS'] += value; return g(kind, [g(`${kind}Aliq`, taxed)]); }
  if (['04', '05', '06', '07', '08', '09'].includes(code)) return g(kind, [g(`${kind}NT`, [t('CST', code)])]);
  if (/^(49|5[0-6]|6[0-7]|7[0-5]|98|99)$/.test(code)) { totals[kind === 'PIS' ? 'vPIS' : 'vCOFINS'] += value; return g(kind, [g(`${kind}Outr`, taxed)]); }
  throw new FiscalConfigError(`CST ${kind} ${code} não suportado pelo conector direto.`);
}

function ipiXml(tax: FiscalItemTax, base: number, totals: Totals): string {
  const code = (tax.ipiCst ?? '').trim(); if (!code) return '';
  const enq = tax.ipiEnquadramento || '999';
  if (['00', '49', '50', '99'].includes(code)) {
    const rate = rateOf(tax.ipiRate) ?? 0; const value = taxOn(base, rate); totals.vIPI += value;
    return g('IPI', [t('cEnq', enq), g('IPITrib', [t('CST', code), t('vBC', money(base)), t('pIPI', pct(rate, 4)), t('vIPI', money(value))])]);
  }
  return g('IPI', [t('cEnq', enq), g('IPINT', [t('CST', code)])]);
}

function address(prefix: 'enderEmit' | 'enderDest', data: { street: string; number: string; complement?: string; district: string; cityIbge: string; city: string; uf: string; cep: string; phone?: string }) {
  const who = prefix === 'enderEmit' ? 'emitente' : 'destinatário';
  const short = [['logradouro', data.street], ['bairro', data.district], ['município', data.city]].filter(([, text]) => clean(text, 60).length < 2).map(([label]) => label);
  if (short.length) throw new FiscalConfigError(`Endereço do ${who}: informe ${short.join(', ')} com pelo menos 2 caracteres.`);
  if (!/^\d{7}$/.test(data.cityIbge) || !/^\d{8}$/.test(data.cep)) throw new FiscalConfigError(`Endereço do ${who}: código IBGE (7 dígitos) e CEP (8 dígitos) são obrigatórios.`);
  return g(prefix, [t('xLgr', clean(data.street, 60)), t('nro', clean(data.number, 60)), t('xCpl', data.complement ? clean(data.complement, 60) : ''), t('xBairro', clean(data.district, 60)), t('cMun', data.cityIbge), t('xMun', clean(data.city, 60)), t('UF', data.uf), t('CEP', data.cep), t('cPais', '1058'), t('xPais', 'Brasil'), t('fone', (data.phone ?? '').replace(/\D/g, '').slice(0, 14))]);
}

export type BuiltNFe = { xml: string; key: string; model: '55' | '65'; tpEmis: string; vNF: number; dhEmi: string; destIdType: '1' | '2' | '3'; destDoc: string };
export function buildNFe(order: FiscalOrder, kind: 'NFCE' | 'NFE', ctx: FiscalContext, contingency?: { at: Date; reason: string }): BuiltNFe {
  const issuer: FiscalIssuer = ctx.issuer; const model = kind === 'NFE' ? '55' : '65';
  const missing = [!issuer.cnpj && 'CNPJ', !issuer.stateRegistration && 'IE', !issuer.uf && 'UF', !issuer.cityIbge && 'código IBGE', !issuer.street && 'logradouro', !issuer.number && 'número', !issuer.district && 'bairro', !issuer.city && 'município', !issuer.cep && 'CEP'].filter(Boolean);
  if (missing.length) throw new FiscalConfigError(`Complete os dados do emitente: ${missing.join(', ')}.`);
  if (!UF_CODE[issuer.uf]) throw new FiscalConfigError('UF do emitente inválida.');
  const tpAmb = ctx.environment === 'PRODUCTION' ? '1' : '2';
  const tpEmis = contingency ? (kind === 'NFCE' ? '9' : '6') : '1';
  const { key, cNF, cDV } = accessKey({ uf: issuer.uf, issuedAt: order.issuedAt, cnpj: issuer.cnpj, model, series: order.series, number: order.number, tpEmis, ref: order.ref ?? order.orderId });
  const dhEmi = localDateTime(order.issuedAt, issuer.uf);
  const destination = kind === 'NFCE' ? '1' : order.destination ?? '1';
  const finality = order.finality ?? '1';
  const recipient = order.customer; const doc = (recipient.document ?? '').replace(/\D/g, '');
  if (kind === 'NFE' && !doc) throw new FiscalConfigError('A NF-e exige CPF/CNPJ do destinatário.');
  if (kind === 'NFE' && !recipient.address) throw new FiscalConfigError('A NF-e exige o endereço completo do destinatário.');
  const consumer = recipient.contributorIndicator !== '1';

  // Document-level amounts spread over the items in cents (remainder on the last item).
  const weights = order.items.map(item => cents(item.total));
  const discounts = spread(cents(order.discount), weights); const freights = spread(cents(order.freight), weights); const others = spread(cents(order.otherExpenses), weights);
  const totals: Totals = { vBC: 0, vICMS: 0, vFCP: 0, vIPI: 0, vPIS: 0, vCOFINS: 0 };
  let vProd = 0; let vDesc = 0; let vFrete = 0; let vOutro = 0;
  const det = order.items.map((item, index) => {
    const values = { vProd: cents(item.total), vDesc: discounts[index], vFrete: freights[index], vOutro: others[index] };
    vProd += values.vProd; vDesc += values.vDesc; vFrete += values.vFrete; vOutro += values.vOutro;
    const tax = item.tax; const cfop = (tax.cfop ?? '').trim();
    if (!/^\d{4}$/.test(cfop)) throw new FiscalConfigError(`Item ${index + 1} (${item.name}) sem CFOP.`);
    if (!tax.ncm || !/^\d{8}$/.test(tax.ncm)) throw new FiscalConfigError(`Item ${index + 1} (${item.name}) sem NCM válido.`);
    const quantity = Number(item.quantity); const unit = clean(item.unit || 'UN', 6) || 'UN';
    const unitValue = (values.vProd / 100 / quantity).toFixed(10).replace(/0+$/, '').replace(/\.$/, '.00');
    const gtin = item.gtin && /^\d{8}$|^\d{12,14}$/.test(item.gtin) ? item.gtin : 'SEM GTIN';
    const name = tpAmb === '2' && kind === 'NFCE' && index === 0 ? HOMOLOGATION_ITEM : clean(item.name, 120);
    const contribBase = values.vProd - values.vDesc;
    const prod = g('prod', [
      t('cProd', clean(item.code || String(index + 1), 60)), t('cEAN', gtin), t('xProd', name), t('NCM', tax.ncm), t('CEST', tax.cest ?? ''), t('cBenef', tax.cBenef ?? ''), t('CFOP', cfop),
      t('uCom', unit), t('qCom', quantity.toFixed(4)), t('vUnCom', unitValue), t('vProd', money(values.vProd)), t('cEANTrib', gtin), t('uTrib', unit), t('qTrib', quantity.toFixed(4)), t('vUnTrib', unitValue),
      values.vFrete ? t('vFrete', money(values.vFrete)) : '', values.vDesc ? t('vDesc', money(values.vDesc)) : '', values.vOutro ? t('vOutro', money(values.vOutro)) : '', t('indTot', '1'),
    ]);
    const imposto = g('imposto', [icmsXml(tax, ctx.crt, values, totals), kind === 'NFE' ? ipiXml(tax, contribBase, totals) : '', contribXml('PIS', tax.pisCst, tax.pisRate, contribBase, totals), contribXml('COFINS', tax.cofinsCst, tax.cofinsRate, contribBase, totals)]);
    return g('det', [prod, imposto], { nItem: String(index + 1) });
  });
  const vNF = vProd - vDesc + vFrete + vOutro + totals.vIPI;

  const dest = !doc ? '' : g('dest', [
    doc.length === 14 ? t('CNPJ', doc) : t('CPF', doc), t('xNome', tpAmb === '2' ? HOMOLOGATION_NAME : recipient.name ? clean(recipient.name, 60) : ''),
    kind === 'NFE' && recipient.address ? address('enderDest', recipient.address) : '',
    t('indIEDest', kind === 'NFCE' ? '9' : recipient.contributorIndicator ?? '9'), kind === 'NFE' && recipient.contributorIndicator === '1' ? t('IE', (recipient.stateRegistration ?? '').replace(/\D/g, '')) : '', t('email', recipient.email ? clean(recipient.email, 60) : ''),
  ]);
  // Payments: recorded payments (with change) or the outstanding amount as "outros"; adjustments/returns have no payment.
  const paid = (order.payments ?? []).map(payment => ({ code: PAYMENT_CODE[payment.method] ?? '99', amount: cents(payment.amount), card: cardGroup(payment, PAYMENT_CODE[payment.method] ?? '99') }));
  const paidTotal = paid.reduce((sum, item) => sum + item.amount, 0);
  // Payments are never completed with an invented "Outros" line: an order not fully paid is refused (NF-e without any payment is "sem pagamento", tPag 90).
  if (!['3', '4'].includes(finality) && paidTotal < vNF && !(kind === 'NFE' && paid.length === 0)) throw new FiscalConfigError(`Pagamento confirmado (${money(paidTotal)}) menor que o total do documento (${money(vNF)}): registre ou recupere o pagamento antes de emitir.`);
  const payments = ['3', '4'].includes(finality) || paid.length === 0 ? [{ code: '90', amount: 0, card: '' }] : paid;
  const pag = g('pag', [...payments.map(item => g('detPag', [t('tPag', item.code), item.code === '99' ? t('xPag', 'Outros') : '', t('vPag', money(item.amount)), item.card])), paidTotal > vNF && !['3', '4'].includes(finality) ? t('vTroco', money(paidTotal - vNF)) : '']);

  const ide = g('ide', [
    t('cUF', UF_CODE[issuer.uf]), t('cNF', cNF), t('natOp', clean(order.nature ?? 'Venda de mercadoria', 60)), t('mod', model), t('serie', String(Number(order.series))), t('nNF', String(Number(order.number))), t('dhEmi', dhEmi),
    t('tpNF', order.operationType ?? '1'), t('idDest', destination), t('cMunFG', issuer.cityIbge), t('tpImp', kind === 'NFCE' ? '4' : '1'), t('tpEmis', tpEmis), t('cDV', cDV), t('tpAmb', tpAmb), t('finNFe', finality),
    t('indFinal', kind === 'NFCE' || consumer ? '1' : '0'), t('indPres', kind === 'NFCE' ? '1' : finality === '1' ? '1' : '0'), t('procEmi', '0'), t('verProc', 'RM Restaurant 1.0'),
    ...(contingency ? [t('dhCont', localDateTime(contingency.at, issuer.uf)), t('xJust', clean(contingency.reason, 256))] : []),
  ]);
  const emit = g('emit', [t('CNPJ', issuer.cnpj), t('xNome', clean(issuer.legalName, 60)), t('xFant', issuer.tradeName ? clean(issuer.tradeName, 60) : ''), address('enderEmit', { ...issuer, phone: issuer.phone }), t('IE', issuer.stateRegistration.replace(/\D/g, '')), ...(issuer.municipalRegistration ? [t('IM', issuer.municipalRegistration), t('CNAE', issuer.cnae)] : []), t('CRT', String(ctx.crt))]);
  const total = g('total', [g('ICMSTot', [
    t('vBC', money(totals.vBC)), t('vICMS', money(totals.vICMS)), t('vICMSDeson', '0.00'), t('vFCP', money(totals.vFCP)), t('vBCST', '0.00'), t('vST', '0.00'), t('vFCPST', '0.00'), t('vFCPSTRet', '0.00'),
    t('vProd', money(vProd)), t('vFrete', money(vFrete)), t('vSeg', '0.00'), t('vDesc', money(vDesc)), t('vII', '0.00'), t('vIPI', money(totals.vIPI)), t('vIPIDevol', '0.00'), t('vPIS', money(totals.vPIS)), t('vCOFINS', money(totals.vCOFINS)), t('vOutro', money(vOutro)), t('vNF', money(vNF)),
  ])]);
  const transp = g('transp', [t('modFrete', kind === 'NFE' && vFrete > 0 ? '0' : '9')]);
  const infAdic = order.additionalInfo ? g('infAdic', [t('infCpl', clean(order.additionalInfo, 5000))]) : '';
  const tech = issuer as FiscalIssuer & Partial<Record<'respTecCnpj' | 'respTecContact' | 'respTecEmail' | 'respTecPhone', string>>;
  const respTec = tech.respTecCnpj ? g('infRespTec', [t('CNPJ', tech.respTecCnpj), t('xContato', clean(tech.respTecContact || 'Suporte', 60)), t('email', clean(tech.respTecEmail || '', 60)), t('fone', (tech.respTecPhone || '').replace(/\D/g, ''))]) : '';
  const infNFe = g('infNFe', [ide, emit, dest, ...det, total, transp, pag, infAdic, respTec], { Id: `NFe${key}`, versao: '4.00' });
  return { xml: g('NFe', [infNFe], { xmlns: NFE_NS }), key, model, tpEmis, vNF, dhEmi, destIdType: doc.length === 14 ? '1' : doc.length === 11 ? '2' : '3', destDoc: doc };
}
