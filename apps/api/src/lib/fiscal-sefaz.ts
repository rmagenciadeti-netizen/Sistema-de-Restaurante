import { createHash } from 'node:crypto';
import { request } from 'node:https';
import { FiscalConfigError } from './fiscal-config';
import { parsePfx, type ParsedCertificate } from './fiscal-certificate';
import { ICP_BRASIL_ROOTS } from './icp-brasil-roots';
import { buildNFe, localDateTime, UF_CODE } from './nfe-builder';
import { FiscalTransportError, type FiscalContext, type FiscalDocumentRef, type FiscalEmission, type FiscalEventResult, type FiscalInutilization, type FiscalOrder, type FiscalProvider } from './providers';
import { block, g, NFE_NS, rsaSha1, signXml, soapBody, t, value } from './xml-signature';

/**
 * Direct SEFAZ connector (NF-e 55 / NFC-e 65, layout 4.00): builds and signs the XML with the company's A1 certificate and talks to the
 * official web services over mutual TLS. The SEFAZ server is authenticated against the ICP-Brasil roots (never with verification off).
 * Endpoints: official MT services (same table maintained by the nfephp-org/sped-nfe project); other UFs can be added to ENDPOINTS.
 */
type Service = 'status' | 'authorize' | 'consult' | 'inutilize' | 'event';
type Env = 'HOMOLOGATION' | 'PRODUCTION';
type ModelEndpoints = Record<Env, Record<Service, string>>;
const mt = (host: string, path: string): Record<Service, string> => ({ status: `${host}${path}/NfeStatusServico4`, authorize: `${host}${path}/NfeAutorizacao4`, consult: `${host}${path}/NfeConsulta4`, inutilize: `${host}${path}/NfeInutilizacao4`, event: `${host}${path}/RecepcaoEvento4` });
export const ENDPOINTS: Record<string, { NFE: ModelEndpoints; NFCE: ModelEndpoints; qr: Record<Env, { url: string; version: 2 | 3 }> }> = {
  MT: {
    NFE: { HOMOLOGATION: mt('https://homologacao.sefaz.mt.gov.br', '/nfews/v2/services'), PRODUCTION: mt('https://nfe.sefaz.mt.gov.br', '/nfews/v2/services') },
    NFCE: { HOMOLOGATION: mt('https://homologacao.sefaz.mt.gov.br', '/nfcews/services'), PRODUCTION: mt('https://nfce.sefaz.mt.gov.br', '/nfcews/services') },
    qr: { HOMOLOGATION: { url: 'http://homologacao.sefaz.mt.gov.br/nfce/consultanfce', version: 3 }, PRODUCTION: { url: 'http://www.sefaz.mt.gov.br/nfce/consultanfce', version: 2 } },
  },
};
const WSDL: Record<Service, { ns: string; action: string }> = {
  status: { ns: 'NFeStatusServico4', action: 'nfeStatusServicoNF' }, authorize: { ns: 'NFeAutorizacao4', action: 'nfeAutorizacaoLote' }, consult: { ns: 'NFeConsultaProtocolo4', action: 'nfeConsultaNF' },
  inutilize: { ns: 'NFeInutilizacao4', action: 'nfeInutilizacaoNF' }, event: { ns: 'NFeRecepcaoEvento4', action: 'nfeRecepcaoEvento' },
};
const AUTHORIZED = ['100', '150']; const DENIED = ['110', '301', '302', '303']; const CANCELLED = ['101', '151', '155'];
const EVENT_OK = ['135', '136', '155'];
const CCE_CONDITIONS = 'A Carta de Correcao e disciplinada pelo paragrafo 1o-A do art. 7o do Convenio S/N, de 15 de dezembro de 1970 e pode ser utilizada para regularizacao de erro ocorrido na emissao de documento fiscal, desde que o erro nao esteja relacionado com: I - as variaveis que determinam o valor do imposto tais como: base de calculo, aliquota, diferenca de preco, quantidade, valor da operacao ou da prestacao; II - a correcao de dados cadastrais que implique mudanca do remetente ou do destinatario; III - a data de emissao ou de saida.';
const TIMEOUT_MS = 30_000;

export type SoapTransport = (url: string, soapAction: string, envelope: string, tls: { pfx: Buffer; passphrase: string }) => Promise<string>;
export const httpsTransport: SoapTransport = (url, soapAction, envelope, tls) => new Promise((resolve, reject) => {
  const req = request(url, {
    method: 'POST', pfx: tls.pfx, passphrase: tls.passphrase, ca: ICP_BRASIL_ROOTS, minVersion: 'TLSv1.2', timeout: TIMEOUT_MS,
    headers: { 'Content-Type': `application/soap+xml; charset=utf-8; action="${soapAction}"`, 'Content-Length': Buffer.byteLength(envelope) },
  }, response => {
    const chunks: Buffer[] = [];
    response.on('data', chunk => chunks.push(chunk)); response.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if ((response.statusCode ?? 500) >= 400 && !text.includes('cStat')) reject(new Error(`HTTP ${response.statusCode} da SEFAZ`)); else resolve(text);
    });
  });
  req.on('timeout', () => req.destroy(new Error('Tempo esgotado aguardando a SEFAZ')));
  req.on('error', reject);
  req.end(envelope);
});

// Turns TLS/socket errors into operator messages (the raw OpenSSL text is kept out of the UI).
export function transportMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/alert (number )?(40|42|43|45|46|48)|handshake failure|certificate (unknown|required)/i.test(text)) return 'a SEFAZ recusou o certificado digital (use e-CNPJ A1 ICP-Brasil válido da empresa credenciada)';
  if (/unable to (get|verify)|self.signed|CERT_/i.test(text)) return 'o certificado do servidor da SEFAZ não pôde ser validado pela cadeia ICP-Brasil';
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) return 'endereço da SEFAZ não encontrado (DNS)';
  if (/Tempo esgotado|ETIMEDOUT|timeout/i.test(text)) return 'tempo esgotado aguardando a SEFAZ';
  if (/ECONNRESET|socket hang up|ECONNREFUSED/i.test(text)) return 'conexão interrompida pela SEFAZ';
  return text.split('\n')[0].slice(0, 200);
}

const signerCache = new Map<string, ParsedCertificate>();
function signer(context: FiscalContext): ParsedCertificate & { pfx: Buffer; password: string } {
  if (!context.certificate) throw new FiscalConfigError('Cadastre o certificado digital A1 para comunicar com a SEFAZ.');
  const pfx = Buffer.from(context.certificate.pfxBase64, 'base64');
  const cacheKey = createHash('sha256').update(pfx).update(context.certificate.password).digest('hex');
  let parsed = signerCache.get(cacheKey);
  if (!parsed) { parsed = parsePfx(pfx, context.certificate.password); if (signerCache.size > 50) signerCache.clear(); signerCache.set(cacheKey, parsed); }
  if (parsed.validTo < new Date()) throw new FiscalConfigError('O certificado digital está vencido.');
  return { ...parsed, pfx, password: context.certificate.password };
}
function endpoints(context: FiscalContext, kind: 'NFE' | 'NFCE') {
  const uf = context.issuer.uf; const table = ENDPOINTS[uf];
  if (!table) throw new FiscalConfigError(`O conector SEFAZ direto atende ${Object.keys(ENDPOINTS).join(', ')}; para a UF ${uf || '(não informada)'} use o provedor Focus NFe.`);
  return { services: table[kind][context.environment], qr: table.qr[context.environment] };
}
const tpAmb = (context: FiscalContext) => (context.environment === 'PRODUCTION' ? '1' : '2');
const lotId = () => String(Date.now()).padStart(15, '0').slice(-15);
const kindOfKey = (key: string): 'NFE' | 'NFCE' => (key.slice(20, 22) === '65' ? 'NFCE' : 'NFE');
const hex = (text: string) => Buffer.from(text, 'utf8').toString('hex');

export class SefazProvider implements FiscalProvider {
  readonly name = 'sefaz';
  constructor(private readonly transport: SoapTransport = httpsTransport) {}

  private async call(context: FiscalContext, kind: 'NFE' | 'NFCE', service: Service, xml: string): Promise<string> {
    const { services } = endpoints(context, kind); const cert = signer(context); const wsdl = WSDL[service];
    const envelope = `<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/${wsdl.ns}">${xml}</nfeDadosMsg></soap12:Body></soap12:Envelope>`;
    return soapBody(await this.transport(services[service], `http://www.portalfiscal.inf.br/nfe/wsdl/${wsdl.ns}/${wsdl.action}`, envelope, { pfx: cert.pfx, passphrase: cert.password }));
  }

  // Signs the NF-e/NFC-e and, for NFC-e, appends infNFeSupl (QR Code + URL de consulta) between infNFe and Signature.
  signDocument(order: FiscalOrder, kind: 'NFE' | 'NFCE', context: FiscalContext, contingency?: { at: Date; reason: string }) {
    const built = buildNFe(order, kind, context, contingency); const cert = signer(context);
    const signed = signXml(built.xml, 'infNFe', cert);
    if (kind === 'NFE') return { ...built, xml: signed.xml };
    const { qr } = endpoints(context, kind); const offline = built.tpEmis === '9'; const env = tpAmb(context);
    const base = `${qr.url}?p=`; let payload: string;
    if (qr.version === 3) {
      payload = offline ? (() => { const text = `${built.key}|3|${env}|${built.dhEmi.slice(8, 10)}|${(built.vNF / 100).toFixed(2)}|${built.destIdType}|${built.destIdType === '3' ? '' : built.destDoc}`; return `${text}|${rsaSha1(text, cert.keyPem)}`; })() : `${built.key}|3|${env}`;
    } else {
      if (!context.csc) throw new FiscalConfigError('Informe o CSC (ID e código) para gerar o QR Code da NFC-e.');
      const cscId = String(Number(context.csc.id));
      const seq = offline ? `${built.key}|2|${env}|${built.dhEmi.slice(8, 10)}|${(built.vNF / 100).toFixed(2)}|${hex(signed.digest)}|${cscId}` : `${built.key}|2|${env}|${cscId}`;
      payload = `${seq}|${createHash('sha1').update(seq + context.csc.token).digest('hex').toUpperCase()}`;
    }
    const supl = g('infNFeSupl', [t('qrCode', `${base}${payload}`), t('urlChave', qr.url)]);
    return { ...built, xml: signed.xml.replace('<Signature ', `${supl}<Signature `) };
  }

  async emit(order: FiscalOrder, kind: 'NFCE' | 'NFE', context?: FiscalContext): Promise<FiscalEmission> {
    if (!context) throw new FiscalConfigError('Configurações fiscais ausentes.');
    // An off-line NFC-e already printed is transmitted exactly as signed.
    let signedXml = order.signedXml; let key = signedXml ? /Id="NFe(\d{44})"/.exec(signedXml)?.[1] ?? '' : '';
    if (!signedXml) {
      if (context.contingency && kind === 'NFE') throw new FiscalConfigError('Contingência de NF-e (SVC/EPEC) não está disponível no conector direto: aguarde o restabelecimento da SEFAZ ou use o provedor Focus NFe.');
      const built = this.signDocument(order, kind, context, context.contingency ? { at: order.issuedAt, reason: 'SEFAZ indisponivel - emissao em contingencia off-line' } : undefined);
      signedXml = built.xml; key = built.key;
      // NFC-e off-line: valid for printing now, transmitted later (POST /fiscal/documents/transmit).
      if (built.tpEmis === '9') return { status: 'PROCESSING', contingency: true, accessKey: key, number: order.number, xml: signedXml, error: 'NFC-e emitida em contingência off-line: transmita assim que a SEFAZ voltar.', documentUrl: `/fiscal/danfe?id=${encodeURIComponent(order.ref ?? order.orderId)}` };
    }
    const nfe = signedXml.replace(/^<\?xml[^>]*>/, '');
    let answer: string;
    try { answer = await this.call(context, kind, 'authorize', g('enviNFe', [t('idLote', lotId()), t('indSinc', '1'), nfe], { xmlns: NFE_NS, versao: '4.00' })); }
    catch (error) {
      if (error instanceof FiscalConfigError) throw error;
      throw new FiscalTransportError(`Sem resposta da SEFAZ: ${transportMessage(error)}`, key, signedXml);
    }
    const lot = value(answer, 'cStat');
    const documentUrl = `/fiscal/danfe?id=${encodeURIComponent(order.ref ?? order.orderId)}`;
    // Duplicity / async batch: the real situation comes from the consultation by access key.
    if (lot === '204' || lot === '103' || lot === '105') return { ...(await this.consult({ ref: order.ref ?? order.orderId, kind, number: order.number, series: order.series, accessKey: key, xml: signedXml }, context)), documentUrl };
    const prot = block(answer, 'protNFe');
    if (!prot) return { status: 'REJECTED', accessKey: key, statusCode: lot ?? undefined, error: `SEFAZ ${lot}: ${value(answer, 'xMotivo') ?? 'lote rejeitado'}` };
    return { ...this.fromProtocol(prot, nfe, key), number: order.number, documentUrl };
  }

  private fromProtocol(prot: string, nfe: string | null, key: string): FiscalEmission {
    const code = value(prot, 'cStat') ?? ''; const reason = value(prot, 'xMotivo') ?? '';
    const protocol = value(prot, 'nProt') ?? undefined;
    if (AUTHORIZED.includes(code)) return { status: 'AUTHORIZED', accessKey: key, protocol, statusCode: code, xml: nfe ? g('nfeProc', [nfe, prot], { xmlns: NFE_NS, versao: '4.00' }) : undefined };
    if (DENIED.includes(code)) return { status: 'DENIED', accessKey: key, protocol, statusCode: code, error: `SEFAZ ${code}: ${reason}`, xml: nfe ? g('nfeProc', [nfe, prot], { xmlns: NFE_NS, versao: '4.00' }) : undefined };
    return { status: 'REJECTED', accessKey: key, statusCode: code, error: `SEFAZ ${code}: ${reason}` };
  }

  // Situation by access key. A missing protocol is never read as "not authorized": SEFAZ is always asked first.
  async consult(document: FiscalDocumentRef, context: FiscalContext): Promise<FiscalEmission> {
    let key = document.accessKey ?? (document.xml ? /Id="NFe(\d{44})"/.exec(document.xml)?.[1] ?? null : null);
    let nfe = document.xml && document.xml.startsWith('<NFe') ? document.xml : document.xml ? block(document.xml, 'NFe') : null;
    if (!key && document.order) { const rebuilt = this.signDocument(document.order, document.kind, context); key = rebuilt.key; nfe = rebuilt.xml; }
    if (!key) return { status: 'NOT_FOUND', error: 'Documento sem chave de acesso: ainda não foi transmitido.' };
    const answer = await this.call(context, kindOfKey(key), 'consult', g('consSitNFe', [t('tpAmb', tpAmb(context)), t('xServ', 'CONSULTAR'), t('chNFe', key)], { xmlns: NFE_NS, versao: '4.00' }));
    const code = value(answer, 'cStat') ?? ''; const reason = value(answer, 'xMotivo') ?? '';
    if (code === '217') return { status: 'NOT_FOUND', accessKey: key, statusCode: code, error: `SEFAZ ${code}: ${reason}` };
    const prot = block(answer, 'protNFe');
    if (CANCELLED.includes(code)) return { status: 'CANCELLED', accessKey: key, statusCode: code, protocol: prot ? value(prot, 'nProt') ?? undefined : undefined };
    if (prot && (AUTHORIZED.includes(code) || DENIED.includes(code))) return this.fromProtocol(prot, nfe, key);
    if (['105', '106'].includes(code)) return { status: 'PROCESSING', accessKey: key, statusCode: code, error: `SEFAZ ${code}: ${reason}` };
    throw new FiscalConfigError(`SEFAZ ${code}: ${reason}`);
  }

  private async event(context: FiscalContext, key: string, type: '110111' | '110110', sequence: number, detail: string[], description: string): Promise<FiscalEventResult> {
    const cert = signer(context); const uf = context.issuer.uf;
    const id = `ID${type}${key}${String(sequence).padStart(2, '0')}`;
    const info = g('infEvento', [t('cOrgao', UF_CODE[uf]), t('tpAmb', tpAmb(context)), t('CNPJ', context.issuer.cnpj), t('chNFe', key), t('dhEvento', localDateTime(new Date(), uf)), t('tpEvento', type), t('nSeqEvento', String(sequence)), t('verEvento', '1.00'), g('detEvento', [t('descEvento', description), ...detail], { versao: '1.00' })], { Id: id });
    const evento = signXml(g('evento', [info], { xmlns: NFE_NS, versao: '1.00' }), 'infEvento', cert).xml;
    let answer: string;
    try { answer = await this.call(context, kindOfKey(key), 'event', g('envEvento', [t('idLote', lotId()), evento], { xmlns: NFE_NS, versao: '1.00' })); }
    catch (error) { if (error instanceof FiscalConfigError) throw error; return { status: 'REJECTED', error: `Sem resposta da SEFAZ: ${transportMessage(error)}. Consulte o documento antes de repetir.` }; }
    const ret = block(answer, 'retEvento'); const code = value(ret ?? answer, 'cStat') ?? ''; const reason = value(ret ?? answer, 'xMotivo') ?? '';
    if (!ret || !EVENT_OK.includes(code)) return { status: 'REJECTED', error: `SEFAZ ${code}: ${reason}` };
    return { status: 'REGISTERED', protocol: value(ret, 'nProt') ?? undefined, xml: g('procEventoNFe', [evento, ret], { xmlns: NFE_NS, versao: '1.00' }) };
  }

  async cancel(document: { number: string | null; accessKey: string | null; ref?: string; kind?: 'NFCE' | 'NFE'; protocol?: string | null }, reason: string, context?: FiscalContext) {
    if (!context) return { cancelled: false, error: 'Configurações fiscais ausentes.' };
    if (!document.accessKey || !document.protocol) return { cancelled: false, error: 'Documento sem chave de acesso ou protocolo de autorização.' };
    const result = await this.event(context, document.accessKey, '110111', 1, [t('nProt', document.protocol), t('xJust', reason.trim())], 'Cancelamento');
    return result.status === 'REGISTERED' ? { cancelled: true, protocol: result.protocol, xml: result.xml } : { cancelled: false, error: result.error };
  }

  async correct(document: FiscalDocumentRef, correction: string, sequence: number, context: FiscalContext): Promise<FiscalEventResult> {
    if (!document.accessKey) return { status: 'REJECTED', error: 'Documento sem chave de acesso.' };
    return this.event(context, document.accessKey, '110110', sequence, [t('xCorrecao', correction.trim()), t('xCondUso', CCE_CONDITIONS)], 'Carta de Correcao');
  }

  async inutilize(request: FiscalInutilization, context: FiscalContext): Promise<FiscalEventResult> {
    const cert = signer(context); const uf = context.issuer.uf; const model = request.kind === 'NFE' ? '55' : '65';
    if (!UF_CODE[uf]) throw new FiscalConfigError('UF do emitente inválida.');
    const year = String(request.year % 100).padStart(2, '0');
    const id = `ID${UF_CODE[uf]}${year}${context.issuer.cnpj}${model}${request.series.padStart(3, '0')}${String(request.numberFrom).padStart(9, '0')}${String(request.numberTo).padStart(9, '0')}`;
    const info = g('infInut', [t('tpAmb', tpAmb(context)), t('xServ', 'INUTILIZAR'), t('cUF', UF_CODE[uf]), t('ano', year), t('CNPJ', context.issuer.cnpj), t('mod', model), t('serie', String(Number(request.series))), t('nNFIni', String(request.numberFrom)), t('nNFFin', String(request.numberTo)), t('xJust', request.justification.trim())], { Id: id });
    const signed = signXml(g('inutNFe', [info], { xmlns: NFE_NS, versao: '4.00' }), 'infInut', cert).xml;
    const answer = await this.call(context, request.kind, 'inutilize', signed);
    const ret = block(answer, 'retInutNFe'); const code = value(answer, 'cStat') ?? ''; const reason = value(answer, 'xMotivo') ?? '';
    if (code !== '102' || !ret) return { status: 'REJECTED', error: `SEFAZ ${code}: ${reason}` };
    return { status: 'REGISTERED', protocol: value(ret, 'nProt') ?? undefined, xml: g('procInutNFe', [signed, ret], { xmlns: NFE_NS, versao: '4.00' }) };
  }

  // Real round trip with SEFAZ (mutual TLS + NfeStatusServico4) for both models.
  async testConnection(context: FiscalContext) {
    const lines: string[] = []; let ok = true;
    for (const kind of ['NFCE', 'NFE'] as const) {
      try {
        const answer = await this.call(context, kind, 'status', g('consStatServ', [t('tpAmb', tpAmb(context)), t('cUF', UF_CODE[context.issuer.uf] ?? ''), t('xServ', 'STATUS')], { xmlns: NFE_NS, versao: '4.00' }));
        const code = value(answer, 'cStat'); ok &&= code === '107';
        lines.push(`${kind === 'NFE' ? 'NF-e' : 'NFC-e'}: ${code} - ${value(answer, 'xMotivo') ?? ''}`);
      } catch (error) {
        if (error instanceof FiscalConfigError) throw error;
        ok = false; lines.push(`${kind === 'NFE' ? 'NF-e' : 'NFC-e'}: ${transportMessage(error)}`);
      }
    }
    return { ok, message: `SEFAZ ${context.issuer.uf} (${context.environment === 'PRODUCTION' ? 'produção' : 'homologação'}) — ${lines.join(' | ')}` };
  }
}
