'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import QRCode from 'qrcode';
import { api, errorMessage } from '../../../lib/api';
import { buttonClass, secondaryButtonClass } from '../../../components/app-shell';
import { code128C } from './barcode';

// DANFE / DANFE NFC-e rendered from the stored fiscal XML (never from the order): what is printed is exactly what SEFAZ received.
const text = (node: Element | Document | null | undefined, tag: string) => node?.getElementsByTagName(tag)[0]?.textContent?.trim() ?? '';
const money = (value: string) => Number(value || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (value: string) => Number(value || 0).toLocaleString('pt-BR', { maximumFractionDigits: 4 });
const keyGroups = (key: string) => key.replace(/(\d{4})(?=\d)/g, '$1 ');
const doc = (value: string) => (value.length === 14 ? value.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : value.length === 11 ? value.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') : value);
const dateTime = (value: string) => (value ? new Date(value).toLocaleString('pt-BR') : '');
const PAYMENT: Record<string, string> = { '01': 'Dinheiro', '03': 'Cartão de crédito', '04': 'Cartão de débito', '10': 'Vale alimentação', '15': 'Boleto', '17': 'PIX', '90': 'Sem pagamento', '99': 'Outros' };

function Barcode({ digits }: { digits: string }) {
  const { bars, width } = code128C(digits);
  return <svg viewBox={`0 0 ${width} 50`} className="h-12 w-full" role="img" aria-label={`Código de barras da chave ${digits}`}>{bars.map(bar => <rect key={bar.x} x={bar.x} y={0} width={bar.w} height={50} fill="#000" />)}</svg>;
}

function useDanfe(id: string | null) {
  const [state, setState] = useState<{ xml: Document; qr: string | null } | { error: string } | null>(null);
  useEffect(() => {
    if (!id) return;
    api<{ xml: string }>(`/fiscal/documents/${encodeURIComponent(id)}/xml`).then(async file => {
      const xml = new DOMParser().parseFromString(file.xml, 'application/xml');
      if (xml.getElementsByTagName('parsererror').length) throw new Error('XML inválido.');
      const qrText = text(xml, 'qrCode');
      setState({ xml, qr: qrText ? await QRCode.toDataURL(qrText, { margin: 1, width: 220, errorCorrectionLevel: 'M' }) : null });
    }).catch(error => setState({ error: errorMessage(error, 'Não foi possível carregar o XML do documento.') }));
  }, [id]);
  return id ? state : { error: 'Documento não informado.' };
}

function Marks({ xml }: { xml: Document }) {
  const prot = xml.getElementsByTagName('protNFe')[0];
  const authorized = Boolean(prot) && ['100', '150'].includes(text(prot, 'cStat'));
  const homologation = text(xml, 'tpAmb') === '2';
  const offline = ['6', '7', '9'].includes(text(xml.getElementsByTagName('ide')[0], 'tpEmis'));
  const mark = (label: string) => <p className="my-1 border border-black p-1 text-center text-[11px] font-bold">{label}</p>;
  return <>
    {homologation && mark('EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO — SEM VALOR FISCAL')}
    {offline && mark(`EMITIDA EM CONTINGÊNCIA${authorized ? '' : ' — PENDENTE DE AUTORIZAÇÃO'}`)}
    {!authorized && !offline && mark('DOCUMENTO NÃO AUTORIZADO PELA SEFAZ — SEM VALOR FISCAL')}
  </>;
}

function NfceDanfe({ xml, qr }: { xml: Document; qr: string | null }) {
  const emit = xml.getElementsByTagName('emit')[0]; const ender = emit?.getElementsByTagName('enderEmit')[0]; const ide = xml.getElementsByTagName('ide')[0];
  const items = Array.from(xml.getElementsByTagName('det')); const total = xml.getElementsByTagName('ICMSTot')[0]; const prot = xml.getElementsByTagName('protNFe')[0]; const dest = xml.getElementsByTagName('dest')[0];
  const key = (xml.getElementsByTagName('infNFe')[0]?.getAttribute('Id') ?? '').replace('NFe', '');
  const row = (label: string, value: string, bold = false) => <div className={`flex justify-between ${bold ? 'font-bold' : ''}`}><dt>{label}</dt><dd>{value}</dd></div>;
  return <article className="mx-auto w-[80mm] bg-white p-2 font-mono text-[11px] leading-tight text-black">
    <header className="text-center"><p className="font-bold">{text(emit, 'xNome')}</p><p>CNPJ {doc(text(emit, 'CNPJ'))} IE {text(emit, 'IE')}</p><p>{text(ender, 'xLgr')}, {text(ender, 'nro')} — {text(ender, 'xBairro')} — {text(ender, 'xMun')}/{text(ender, 'UF')}</p></header>
    <p className="my-1 border-y border-black py-1 text-center font-bold">DANFE NFC-e — Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica</p>
    <Marks xml={xml} />
    <table className="w-full"><thead><tr className="text-left"><th>Item</th><th className="text-right">Qtd</th><th className="text-right">Unit</th><th className="text-right">Total</th></tr></thead>
      <tbody>{items.map(item => <tr key={item.getAttribute('nItem')}><td>{text(item, 'cProd')} {text(item, 'xProd')}</td><td className="text-right">{qty(text(item, 'qCom'))} {text(item, 'uCom')}</td><td className="text-right">{money(text(item, 'vUnCom'))}</td><td className="text-right">{money(text(item, 'vProd'))}</td></tr>)}</tbody></table>
    <dl className="mt-1 border-t border-black pt-1">
      {row('Qtd. total de itens', String(items.length))}{row('Valor total R$', money(text(total, 'vProd')))}
      {Number(text(total, 'vDesc')) > 0 && row('Desconto R$', money(text(total, 'vDesc')))}
      {Number(text(total, 'vOutro')) > 0 && row('Acréscimos R$', money(text(total, 'vOutro')))}
      {row('Valor a pagar R$', money(text(total, 'vNF')), true)}
      {Array.from(xml.getElementsByTagName('detPag')).map((pag, index) => <div key={index}>{row(PAYMENT[text(pag, 'tPag')] ?? text(pag, 'xPag'), money(text(pag, 'vPag')))}</div>)}
      {text(xml, 'vTroco') && row('Troco R$', money(text(xml, 'vTroco')))}
    </dl>
    <section className="mt-1 border-t border-black pt-1 text-center">
      <p>Consulte pela chave de acesso em</p><p className="break-all">{text(xml, 'urlChave')}</p><p className="font-bold">{keyGroups(key)}</p>
      <p className="mt-1">{dest ? `CONSUMIDOR ${text(dest, 'CNPJ') ? 'CNPJ' : 'CPF'} ${doc(text(dest, 'CNPJ') || text(dest, 'CPF'))}${text(dest, 'xNome') ? ` — ${text(dest, 'xNome')}` : ''}` : 'CONSUMIDOR NÃO IDENTIFICADO'}</p>
      <p className="mt-1">NFC-e nº {text(ide, 'nNF')} Série {text(ide, 'serie')} {dateTime(text(ide, 'dhEmi'))}</p>
      {prot && <p>Protocolo de autorização: {text(prot, 'nProt')}<br />Data de autorização: {dateTime(text(prot, 'dhRecbto'))}</p>}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {qr && <img src={qr} alt="QR Code de consulta da NFC-e" className="mx-auto my-2 h-36 w-36" />}
      {text(xml, 'infCpl') && <p className="mt-1">{text(xml, 'infCpl')}</p>}
    </section>
  </article>;
}

function Box({ label, value, className = '' }: { label: string; value: string; className?: string }) {
  return <div className={`border border-black px-1 ${className}`}><p className="text-[7px] uppercase">{label}</p><p className="min-h-[14px] text-[10px] font-semibold">{value}</p></div>;
}
function NfeDanfe({ xml }: { xml: Document }) {
  const emit = xml.getElementsByTagName('emit')[0]; const ee = emit?.getElementsByTagName('enderEmit')[0]; const ide = xml.getElementsByTagName('ide')[0];
  const dest = xml.getElementsByTagName('dest')[0]; const ed = dest?.getElementsByTagName('enderDest')[0]; const tot = xml.getElementsByTagName('ICMSTot')[0]; const prot = xml.getElementsByTagName('protNFe')[0];
  const key = (xml.getElementsByTagName('infNFe')[0]?.getAttribute('Id') ?? '').replace('NFe', '');
  const freight: Record<string, string> = { '0': '0 - Por conta do emitente', '1': '1 - Por conta do destinatário', '9': '9 - Sem ocorrência de transporte' };
  return <article className="mx-auto w-[200mm] bg-white p-3 text-black">
    <div className="grid grid-cols-[1fr_auto_1.2fr]">
      <div className="border border-black p-2 text-[10px]"><p className="text-sm font-bold">{text(emit, 'xNome')}</p><p>{text(ee, 'xLgr')}, {text(ee, 'nro')} {text(ee, 'xCpl')}</p><p>{text(ee, 'xBairro')} — {text(ee, 'xMun')}/{text(ee, 'UF')} — CEP {text(ee, 'CEP')}</p><p>{text(ee, 'fone')}</p></div>
      <div className="border border-black p-2 text-center text-[10px]"><p className="text-base font-bold">DANFE</p><p>Documento Auxiliar da<br />Nota Fiscal Eletrônica</p><p>{text(ide, 'tpNF') === '0' ? '0 - Entrada' : '1 - Saída'}</p><p className="font-bold">Nº {text(ide, 'nNF').padStart(9, '0').replace(/(\d{3})(?=\d)/g, '$1.')}</p><p>Série {text(ide, 'serie')}</p></div>
      <div className="border border-black p-2 text-[10px]"><Barcode digits={key} /><p className="text-[7px] uppercase">Chave de acesso</p><p className="font-semibold">{keyGroups(key)}</p><p className="mt-1">Consulta de autenticidade no portal nacional da NF-e www.nfe.fazenda.gov.br/portal ou no site da Sefaz autorizadora</p></div>
    </div>
    <Marks xml={xml} />
    <div className="grid grid-cols-2"><Box label="Natureza da operação" value={text(ide, 'natOp')} /><Box label="Protocolo de autorização de uso" value={prot ? `${text(prot, 'nProt')} — ${dateTime(text(prot, 'dhRecbto'))}` : '—'} /></div>
    <div className="grid grid-cols-3"><Box label="Inscrição estadual" value={text(emit, 'IE')} /><Box label="Inscrição municipal" value={text(emit, 'IM')} /><Box label="CNPJ" value={doc(text(emit, 'CNPJ'))} /></div>
    <p className="mt-2 text-[8px] font-bold">DESTINATÁRIO / REMETENTE</p>
    <div className="grid grid-cols-[2fr_1fr_1fr]"><Box label="Nome / razão social" value={text(dest, 'xNome')} /><Box label="CNPJ / CPF" value={doc(text(dest, 'CNPJ') || text(dest, 'CPF'))} /><Box label="Data da emissão" value={dateTime(text(ide, 'dhEmi'))} /></div>
    <div className="grid grid-cols-[2fr_1fr_1fr_1fr]"><Box label="Endereço" value={`${text(ed, 'xLgr')}, ${text(ed, 'nro')} ${text(ed, 'xCpl')}`} /><Box label="Bairro" value={text(ed, 'xBairro')} /><Box label="CEP" value={text(ed, 'CEP')} /><Box label="Município / UF" value={`${text(ed, 'xMun')}/${text(ed, 'UF')}`} /></div>
    <p className="mt-2 text-[8px] font-bold">CÁLCULO DO IMPOSTO</p>
    <div className="grid grid-cols-6">{[['Base de cálculo do ICMS', 'vBC'], ['Valor do ICMS', 'vICMS'], ['Valor do FCP', 'vFCP'], ['Valor total dos produtos', 'vProd'], ['Valor do frete', 'vFrete'], ['Desconto', 'vDesc'], ['Outras despesas', 'vOutro'], ['Valor do IPI', 'vIPI'], ['Valor do PIS', 'vPIS'], ['Valor da COFINS', 'vCOFINS'], ['Valor do seguro', 'vSeg'], ['Valor total da nota', 'vNF']].map(([label, tag]) => <Box key={tag} label={label} value={money(text(tot, tag))} />)}</div>
    <p className="mt-2 text-[8px] font-bold">TRANSPORTADOR / VOLUMES</p>
    <div className="grid grid-cols-2"><Box label="Modalidade do frete" value={freight[text(xml, 'modFrete')] ?? text(xml, 'modFrete')} /><Box label="Transportador" value={text(xml.getElementsByTagName('transporta')[0], 'xNome')} /></div>
    <p className="mt-2 text-[8px] font-bold">DADOS DOS PRODUTOS / SERVIÇOS</p>
    <table className="w-full border-collapse text-[8px]"><thead><tr>{['Código', 'Descrição', 'NCM', 'CST/CSOSN', 'CFOP', 'Un', 'Qtd', 'V. unit', 'V. total', 'BC ICMS', 'V. ICMS', 'V. IPI', 'Alíq. ICMS', 'Alíq. IPI'].map(head => <th key={head} className="border border-black px-0.5">{head}</th>)}</tr></thead>
      <tbody>{Array.from(xml.getElementsByTagName('det')).map(item => {
        const group = item.getElementsByTagName('ICMS')[0]?.firstElementChild ?? null; const ipi = item.getElementsByTagName('IPI')[0];
        const cells = [text(item, 'cProd'), text(item, 'xProd'), text(item, 'NCM'), `${text(group, 'orig')}${text(group, 'CST') || text(group, 'CSOSN')}`, text(item, 'CFOP'), text(item, 'uCom'), qty(text(item, 'qCom')), money(text(item, 'vUnCom')), money(text(item, 'vProd')), money(text(group, 'vBC')), money(text(group, 'vICMS')), money(text(ipi, 'vIPI')), money(text(group, 'pICMS')), money(text(ipi, 'pIPI'))];
        return <tr key={item.getAttribute('nItem')}>{cells.map((cell, index) => <td key={index} className="border border-black px-0.5">{cell}</td>)}</tr>;
      })}</tbody></table>
    <p className="mt-2 text-[8px] font-bold">DADOS ADICIONAIS</p>
    <div className="grid grid-cols-[2fr_1fr]"><Box label="Informações complementares" value={text(xml, 'infCpl')} className="min-h-16" /><Box label="Reservado ao fisco" value="" /></div>
  </article>;
}

function DanfeContent() {
  const id = useSearchParams().get('id'); const state = useDanfe(id);
  if (!state) return <p className="p-6 text-sm text-slate-500">Carregando DANFE…</p>;
  if ('error' in state) return <div className="p-6"><p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{state.error}</p><a className={`${secondaryButtonClass} mt-4 inline-block`} href="/fiscal">Voltar</a></div>;
  const model = text(state.xml.getElementsByTagName('ide')[0], 'mod');
  return <main className="min-h-screen bg-slate-100 py-4 print:bg-white print:py-0">
    <div className="mx-auto mb-3 flex max-w-3xl justify-between gap-2 print:hidden"><a className={secondaryButtonClass} href="/fiscal">‹ Documentos fiscais</a><button type="button" className={buttonClass} onClick={() => window.print()}>Imprimir / salvar PDF</button></div>
    {model === '65' ? <NfceDanfe xml={state.xml} qr={state.qr} /> : <NfeDanfe xml={state.xml} />}
  </main>;
}

export default function DanfePage() {
  return <Suspense fallback={null}><DanfeContent /></Suspense>;
}
