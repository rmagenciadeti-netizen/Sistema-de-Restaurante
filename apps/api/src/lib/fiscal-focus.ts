import { FiscalConfigError } from './fiscal-config';
import type { FiscalContext, FiscalDocumentRef, FiscalEmission, FiscalEventResult, FiscalInutilization, FiscalItemTax, FiscalOrder, FiscalProvider, FiscalResultStatus } from './providers';

/**
 * Focus NFe (https://doc.focusnfe.com.br) adapter: the provider builds, signs and transmits NF-e/NFC-e to SEFAZ (including SVC and NFC-e
 * offline contingency) with the A1 certificate registered in the company's Focus account. Each company stores its own API token in the
 * fiscal settings. The FiscalDocument id is sent as `ref`, so a retry never creates a second document at the provider.
 */
type FocusResponse = Record<string, unknown> & { status?: string; status_sefaz?: string | number; mensagem_sefaz?: string; mensagem?: string; codigo?: string; erros?: Array<{ mensagem?: string; campo?: string }> };
const BASE = { HOMOLOGATION: 'https://homologacao.focusnfe.com.br', PRODUCTION: 'https://api.focusnfe.com.br' } as const;
const TIMEOUT_MS = 45_000;
const PAYMENT_CODE: Record<string, string> = { CASH: '01', CREDIT_CARD: '03', DEBIT_CARD: '04', VOUCHER: '10', PIX: '17', OTHER: '99' };

export const focusStatus = (status: string | undefined): FiscalResultStatus => {
  switch (status) {
    case 'autorizado': return 'AUTHORIZED';
    case 'cancelado': return 'CANCELLED';
    case 'denegado': return 'DENIED';
    case 'erro_autorizacao': return 'REJECTED';
    case 'processando_autorizacao': return 'PROCESSING';
    default: return 'PROCESSING';
  }
};
const message = (body: FocusResponse) => [body.mensagem_sefaz ?? body.mensagem, ...(body.erros ?? []).map(item => [item.campo, item.mensagem].filter(Boolean).join(': '))].filter(Boolean).join(' | ') || undefined;
const str = (value: unknown) => (value === undefined || value === null || value === '' ? undefined : String(value));
const cents = (value: string | number) => Math.round(Number(value) * 100);
const money = (value: number) => (value / 100).toFixed(2);

// Spreads a document-level amount over the items proportionally to their totals, in cents, with the remainder on the last item.
export function spread(totalCents: number, weights: number[]): number[] {
  const sum = weights.reduce((acc, value) => acc + value, 0);
  if (totalCents === 0 || sum === 0) return weights.map(() => 0);
  const parts = weights.map(weight => Math.floor((totalCents * weight) / sum));
  parts[parts.length - 1] += totalCents - parts.reduce((acc, value) => acc + value, 0);
  return parts;
}

function itemTax(tax: FiscalItemTax) {
  const rate = (value: string | null | undefined) => (value === null || value === undefined ? undefined : value);
  const fields: Record<string, unknown> = {
    codigo_ncm: tax.ncm ?? undefined, cest: tax.cest ?? undefined, cfop: tax.cfop ?? undefined, icms_origem: tax.origin,
    icms_situacao_tributaria: tax.icmsCst ?? undefined, icms_aliquota: rate(tax.icmsRate), icms_reducao_base_calculo: rate(tax.icmsReduction),
    icms_margem_valor_adicionado_st: rate(tax.icmsStMva), icms_aliquota_st: rate(tax.icmsStRate), icms_reducao_base_calculo_st: rate(tax.icmsStReduction),
    fcp_percentual: rate(tax.fcpRate), fcp_percentual_st: rate(tax.fcpStRate), codigo_beneficio_fiscal: tax.cBenef ?? undefined,
    pis_situacao_tributaria: tax.pisCst ?? undefined, pis_aliquota_porcentual: rate(tax.pisRate),
    cofins_situacao_tributaria: tax.cofinsCst ?? undefined, cofins_aliquota_porcentual: rate(tax.cofinsRate),
    ipi_situacao_tributaria: tax.ipiCst ?? undefined, ipi_codigo_enquadramento_legal: tax.ipiEnquadramento ?? undefined, ipi_aliquota: rate(tax.ipiRate),
  };
  // Reforma Tributária (NT 2025.002-RTC): only sent when the rule defines the IBS/CBS group.
  if (tax.ibsCbsCst) Object.assign(fields, { ibs_cbs_situacao_tributaria: tax.ibsCbsCst, ibs_cbs_classificacao_tributaria: tax.cClassTrib ?? undefined, ibs_uf_aliquota: rate(tax.ibsUfRate), ibs_mun_aliquota: rate(tax.ibsMunRate), cbs_aliquota: rate(tax.cbsRate) });
  if (tax.isRate) fields.is_aliquota = tax.isRate;
  return fields;
}

export function focusPayload(order: FiscalOrder, kind: 'NFCE' | 'NFE', context: FiscalContext) {
  const weights = order.items.map(item => cents(item.total));
  const discount = spread(cents(order.discount ?? '0'), weights); const freight = spread(cents(order.freight ?? '0'), weights); const other = spread(cents(order.otherExpenses ?? '0'), weights);
  const doc = (order.customer.document ?? '').replace(/\D/g, '');
  const recipient: Record<string, unknown> = {};
  if (doc.length === 11) recipient.cpf_destinatario = doc;
  if (doc.length === 14) recipient.cnpj_destinatario = doc;
  if (doc && order.customer.name) recipient.nome_destinatario = order.customer.name;
  if (order.customer.email) recipient.email_destinatario = order.customer.email;
  const address = order.customer.address;
  if (address) Object.assign(recipient, { logradouro_destinatario: address.street, numero_destinatario: address.number, complemento_destinatario: address.complement || undefined, bairro_destinatario: address.district, municipio_destinatario: address.city, codigo_municipio_destinatario: address.cityIbge, uf_destinatario: address.uf, cep_destinatario: address.cep, pais_destinatario: 'Brasil' });
  if (kind === 'NFE' && doc) Object.assign(recipient, { indicador_inscricao_estadual_destinatario: order.customer.contributorIndicator ?? '9', inscricao_estadual_destinatario: order.customer.stateRegistration || undefined });
  const payments = order.payments?.length ? order.payments : [{ method: 'OTHER', amount: order.total }];
  const interstate = Boolean(address?.uf && context.issuer.uf && address.uf !== context.issuer.uf);
  return {
    natureza_operacao: order.nature ?? 'Venda de mercadoria', data_emissao: order.issuedAt.toISOString(), numero: order.number, serie: order.series,
    cnpj_emitente: context.issuer.cnpj, tipo_documento: 1, finalidade_emissao: order.finality ?? '1', consumidor_final: 1,
    presenca_comprador: 1, local_destino: interstate ? 2 : 1, modalidade_frete: cents(order.freight ?? '0') > 0 ? 0 : 9,
    informacoes_adicionais_contribuinte: order.additionalInfo || undefined,
    ...recipient,
    items: order.items.map((item, index) => ({
      numero_item: index + 1, codigo_produto: item.code ?? String(index + 1), descricao: item.name.slice(0, 120),
      unidade_comercial: item.unit ?? 'UN', quantidade_comercial: item.quantity, valor_unitario_comercial: item.unitPrice,
      unidade_tributavel: item.unit ?? 'UN', quantidade_tributavel: item.quantity, valor_unitario_tributavel: item.unitPrice,
      valor_bruto: item.total, codigo_barras_comercial: item.gtin || 'SEM GTIN', codigo_barras_tributavel: item.gtin || 'SEM GTIN', inclui_no_total: 1,
      valor_desconto: discount[index] ? money(discount[index]) : undefined, valor_frete: freight[index] ? money(freight[index]) : undefined, valor_outras_despesas: other[index] ? money(other[index]) : undefined,
      ...itemTax(item.tax),
    })),
    formas_pagamento: payments.map(payment => ({ forma_pagamento: PAYMENT_CODE[payment.method] ?? '99', valor_pagamento: Number(payment.amount).toFixed(2) })),
  };
}

export class FocusNfeProvider implements FiscalProvider {
  readonly name = 'focusnfe';
  constructor(private readonly http: typeof fetch = fetch) {}

  private async call(context: FiscalContext | undefined, method: string, path: string, body?: unknown): Promise<{ status: number; body: FocusResponse }> {
    if (!context?.token) throw new FiscalConfigError('Token da Focus NFe não configurado nas Configurações Fiscais.');
    const response = await this.http(`${BASE[context.environment]}${path}`, {
      method, headers: { Authorization: `Basic ${Buffer.from(`${context.token}:`).toString('base64')}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const raw = await response.text();
    let parsed: FocusResponse = {};
    try { parsed = raw ? JSON.parse(raw) as FocusResponse : {}; } catch { parsed = { mensagem: raw.slice(0, 300) }; }
    return { status: response.status, body: parsed };
  }

  // XML files are downloaded exactly as stored by the provider, never rebuilt.
  private async xml(context: FiscalContext, path: unknown): Promise<string | undefined> {
    if (typeof path !== 'string' || !path) return undefined;
    try {
      const response = await this.http(path.startsWith('http') ? path : `${BASE[context.environment]}${path}`, { headers: { Authorization: `Basic ${Buffer.from(`${context.token}:`).toString('base64')}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      return response.ok ? await response.text() : undefined;
    } catch { return undefined; }
  }

  private async toEmission(context: FiscalContext, body: FocusResponse): Promise<FiscalEmission> {
    const status = focusStatus(body.status);
    const protocol = str(body.protocolo) ?? str((body.protocolo_nota_fiscal as Record<string, unknown> | undefined)?.numero_protocolo);
    const danfe = str(body.caminho_danfe);
    return {
      status, number: str(body.numero), accessKey: str(body.chave_nfe)?.replace(/^NFe/, ''), protocol, statusCode: str(body.status_sefaz),
      documentUrl: danfe ? (danfe.startsWith('http') ? danfe : `${BASE[context.environment]}${danfe}`) : undefined,
      error: status === 'AUTHORIZED' || status === 'PROCESSING' ? undefined : message(body), contingency: body.contingencia_offline === true,
      xml: status === 'AUTHORIZED' || status === 'CANCELLED' ? await this.xml(context, body.caminho_xml_nota_fiscal) : undefined,
    };
  }

  async emit(order: FiscalOrder, kind: 'NFCE' | 'NFE', context?: FiscalContext): Promise<FiscalEmission> {
    if (!context) throw new FiscalConfigError('Configurações fiscais ausentes.');
    // NFC-e offline contingency is automatic at Focus (same ref, `contingencia_offline` in the answer); NF-e falls back to SVC on their side.
    const { status, body } = await this.call(context, 'POST', `/v2/${kind === 'NFE' ? 'nfe' : 'nfce'}?ref=${encodeURIComponent(order.ref ?? order.orderId)}`, focusPayload(order, kind, context));
    // The reference was already used: the real state comes from the consultation, never from a new emission.
    if (body.codigo === 'already_processed' || body.codigo === 'pending_operation') return this.consult({ ref: order.ref ?? order.orderId, kind, number: order.number, series: order.series, accessKey: null }, context);
    if (status >= 400 && !body.status) return { status: 'REJECTED', error: message(body) ?? `HTTP ${status}` };
    return this.toEmission(context, body);
  }

  async consult(document: FiscalDocumentRef, context: FiscalContext): Promise<FiscalEmission> {
    const { status, body } = await this.call(context, 'GET', `/v2/${document.kind === 'NFE' ? 'nfe' : 'nfce'}/${encodeURIComponent(document.ref)}?completa=1`);
    if (status === 404) return { status: 'NOT_FOUND', error: message(body) ?? 'Documento não localizado no provedor.' };
    if (status >= 400 && !body.status) throw new Error(message(body) ?? `HTTP ${status}`);
    return this.toEmission(context, body);
  }

  async cancel(document: { number: string | null; accessKey: string | null; ref?: string; kind?: 'NFCE' | 'NFE' }, reason: string, context?: FiscalContext) {
    if (!context || !document.ref) return { cancelled: false, error: 'Documento sem referência no provedor.' };
    const { body } = await this.call(context, 'DELETE', `/v2/${document.kind === 'NFE' ? 'nfe' : 'nfce'}/${encodeURIComponent(document.ref)}`, { justificativa: reason });
    if (body.status !== 'cancelado') return { cancelled: false, error: message(body) ?? 'Cancelamento recusado.' };
    return { cancelled: true, protocol: str(body.protocolo) ?? str(body.status_sefaz), xml: await this.xml(context, body.caminho_xml_cancelamento) };
  }

  async correct(document: FiscalDocumentRef, correction: string, _sequence: number, context: FiscalContext): Promise<FiscalEventResult> {
    const { body } = await this.call(context, 'POST', `/v2/nfe/${encodeURIComponent(document.ref)}/carta_correcao`, { correcao: correction });
    if (body.status !== 'autorizado') return { status: 'REJECTED', error: message(body) ?? 'Carta de correção recusada.' };
    return { status: 'REGISTERED', protocol: str(body.protocolo) ?? str(body.numero_protocolo), xml: await this.xml(context, body.caminho_xml_carta_correcao) };
  }

  async inutilize(request: FiscalInutilization, context: FiscalContext): Promise<FiscalEventResult> {
    const { body } = await this.call(context, 'POST', `/v2/${request.kind === 'NFE' ? 'nfe' : 'nfce'}/inutilizacao`, { cnpj: context.issuer.cnpj, serie: request.series, numero_inicial: String(request.numberFrom), numero_final: String(request.numberTo), justificativa: request.justification });
    if (body.status !== 'autorizado') return { status: 'REJECTED', error: message(body) ?? 'Inutilização recusada.' };
    return { status: 'REGISTERED', protocol: str(body.protocolo_sefaz), xml: await this.xml(context, body.caminho_xml) };
  }

  // Authenticates against the selected environment: an unknown reference answers 404 when the token is valid.
  async testConnection(context: FiscalContext) {
    const { status, body } = await this.call(context, 'GET', `/v2/nfce/rm-teste-conexao-${Date.now()}`);
    if (status === 401 || status === 403) return { ok: false, message: message(body) ?? 'Token recusado pela Focus NFe.' };
    return status === 404 || status < 400 ? { ok: true, message: `Comunicação com a Focus NFe (${context.environment === 'PRODUCTION' ? 'produção' : 'homologação'}) estabelecida.` } : { ok: false, message: message(body) ?? `HTTP ${status}` };
  }
}
