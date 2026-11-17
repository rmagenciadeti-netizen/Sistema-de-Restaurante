'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { buttonClass, Field, Notice, Select, secondaryButtonClass } from './app-shell';
import { Badge, dangerButtonClass, sectionTitleClass, Tabs, textareaClass } from './ui';
import { api, ApiError, errorMessage, formatDateTime, storedUser, type Unit } from '../lib/api';
import { NaturesManager } from './natures-manager';
import { TaxRulesManager } from './tax-rules-manager';
import { environmentLabel, type CfopDefaults, type FiscalIssuer, type FiscalModelConfig, type FiscalSettingsView, type PdvMode } from '../lib/types-fiscal';

type Section = 'environment' | 'issuer' | 'unit' | 'certificate' | 'provider' | 'nfe' | 'nfce' | 'numbering' | 'tax' | 'natures' | 'rules' | 'pdv';
const sections: { key: Section; label: string }[] = [
  { key: 'environment', label: 'Ambiente' }, { key: 'issuer', label: 'Empresa / emitente' }, { key: 'unit', label: 'Estabelecimentos' }, { key: 'certificate', label: 'Certificado digital' },
  { key: 'provider', label: 'Conexão SEFAZ' }, { key: 'nfe', label: 'NF-e (55)' }, { key: 'nfce', label: 'NFC-e (65) e CSC' }, { key: 'numbering', label: 'Série e numeração' },
  { key: 'tax', label: 'CFOP e tributação padrão' }, { key: 'natures', label: 'Naturezas de operação' }, { key: 'rules', label: 'Regras tributárias (NCM, CST, alíquotas)' }, { key: 'pdv', label: 'Comportamento no PDV' },
];
// Sections with their own save actions (embedded managers, certificate upload, numbering).
const selfSaving: Section[] = ['certificate', 'numbering', 'natures', 'rules'];
type Draft = Pick<FiscalSettingsView, 'environment' | 'provider' | 'issuer' | 'nfe' | 'nfce' | 'cscId' | 'pdvMode' | 'defaultTaxRuleId' | 'cfop'> & { providerToken: string; cscToken: string };
type Numbering = { items: { kind: string; series: string; nextNumber: number }[]; environment: string };
type CertificateTest = { ok: boolean; message: string; subject?: string | null; cnpj?: string | null; validTo?: string | null; warnings?: string[] };
type UnitFiscalView = { configured: boolean; issuer: FiscalIssuer; ownCertificate: boolean; certificate: { state: string; daysLeft: number | null; subject?: string | null; cnpj?: string | null; validFrom?: string | null; validTo?: string | null; uploadedAt?: string | null }; certificateWarnings?: string[] };
type Message = { text: string; kind: 'error' | 'success'; problems?: string[] };

const regimeLabel: Record<FiscalIssuer['taxRegime'], string> = { SIMPLES_NACIONAL: 'Simples Nacional', SIMPLES_EXCESSO: 'Simples Nacional — excesso de sublimite', NORMAL: 'Regime Normal (Lucro Presumido/Real)', MEI: 'MEI — Microempreendedor Individual' };
const regimeCrt: Record<FiscalIssuer['taxRegime'], number> = { SIMPLES_NACIONAL: 1, SIMPLES_EXCESSO: 2, NORMAL: 3, MEI: 4 };
const contributorLabel: Record<FiscalIssuer['contributorIndicator'], string> = { '1': '1 — Contribuinte ICMS', '2': '2 — Contribuinte isento de inscrição', '9': '9 — Não contribuinte' };
const finalityLabel: Record<FiscalModelConfig['finality'], string> = { '1': '1 — Normal', '2': '2 — Complementar', '3': '3 — Ajuste', '4': '4 — Devolução' };
const emissionLabel: Record<FiscalModelConfig['emissionType'], string> = { NORMAL: 'Normal', CONTINGENCY_OFFLINE: 'Contingência off-line (NFC-e)', EPEC: 'EPEC — Evento Prévio de Emissão em Contingência', FS_DA: 'FS-DA — Formulário de Segurança' };
const providerLabel = (provider: string) => (provider === 'focusnfe' ? 'Focus NFe (provedor certificado)' : provider === 'sefaz' ? 'SEFAZ direta (assinatura com o certificado A1)' : provider);
const pdvModes: { key: PdvMode; title: string; description: string }[] = [
  { key: 'FISCAL', title: 'Todas as vendas fiscais', description: 'Cada venda concluída emite NFC-e automaticamente. A configuração fiscal (certificado, CSC, emitente, provedor) é validada antes da emissão.' },
  { key: 'NON_FISCAL', title: 'Todas as vendas não fiscais', description: 'As vendas são registradas sem emissão fiscal. Comprovantes internos impressos não são documentos fiscais.' },
  { key: 'ASK', title: 'Perguntar em cada venda', description: 'No fechamento é exibida a pergunta "DESEJA EMITIR DOCUMENTO FISCAL PARA ESTA VENDA?". A escolha é registrada com operador, data e hora.' },
];

const toDraft = (view: FiscalSettingsView): Draft => ({ environment: view.environment, provider: view.provider, issuer: view.issuer, nfe: view.nfe, nfce: view.nfce, cscId: view.cscId, pdvMode: view.pdvMode, defaultTaxRuleId: view.defaultTaxRuleId, cfop: view.cfop ?? {}, providerToken: '', cscToken: '' });

function readBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? '').replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo do certificado.'));
    reader.readAsDataURL(file);
  });
}

function failure(error: unknown, fallback: string): Message {
  const problems = error instanceof ApiError && Array.isArray(error.payload.problems) ? error.payload.problems.filter((item): item is string => typeof item === 'string') : undefined;
  if (error instanceof ApiError && error.status === 503) return { text: 'O servidor não está configurado para armazenar certificados (FISCAL_ENCRYPTION_KEY ausente). Contate o suporte.', kind: 'error' };
  return { text: errorMessage(error, fallback), kind: 'error', problems };
}

// Fiscal data belongs to each restaurant: the Master administrator has no company and must sign in as a restaurant user.
export function FiscalSettingsPanel({ canEdit }: { canEdit: boolean }) {
  const [master] = useState(() => storedUser().role === 'MASTER_ADMIN');
  if (master) return <Notice message="As configurações fiscais pertencem a cada restaurante (certificado, emitente, séries e tributação ficam isolados por empresa). O usuário Master do RM Painel Admin não tem empresa vinculada: entre com um administrador ou gerente do restaurante para configurar." />;
  return <FiscalSettingsForm canEdit={canEdit} />;
}

function FiscalSettingsForm({ canEdit }: { canEdit: boolean }) {
  const [view, setView] = useState<FiscalSettingsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [rules, setRules] = useState<{ id: string; name: string; active: boolean }[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [unitId, setUnitId] = useState('');
  const [unitView, setUnitView] = useState<UnitFiscalView | null>(null);
  const [numbering, setNumbering] = useState<Numbering | null>(null);
  const [section, setSection] = useState<Section>('environment');
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState('');
  const [certFile, setCertFile] = useState<File | null>(null);
  const [certPassword, setCertPassword] = useState('');
  const [fileKey, setFileKey] = useState(0);
  const [unitCertFile, setUnitCertFile] = useState<File | null>(null);
  const [unitCertPassword, setUnitCertPassword] = useState('');
  const [unitFileKey, setUnitFileKey] = useState(0);
  const [numberingDraft, setNumberingDraft] = useState<Record<string, { series: string; nextNumber: string }>>({});

  function apply(next: FiscalSettingsView) { setView(next); setDraft(toDraft(next)); }

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const settings = await api<FiscalSettingsView>('/fiscal/settings');
        if (alive) apply(settings);
      } catch (error) { if (alive) setMessage(failure(error, 'Erro ao carregar as configurações fiscais')); }
      const [ruleList, numbers] = await Promise.all([
        api<{ items: { id: string; name: string; active: boolean }[] }>('/tax-rules').catch(() => ({ items: [] })),
        api<Numbering>('/fiscal/numbering').catch(() => null),
      ]);
      if (alive) { setRules(ruleList.items); setNumbering(numbers); if (numbers) setNumberingDraft(Object.fromEntries(numbers.items.map(item => [item.kind, { series: item.series, nextNumber: String(item.nextNumber) }]))); }
      if (canEdit) {
        try {
          const unitList = await api<{ items: Unit[] }>('/units');
          if (alive) {
            const activeUnits = unitList.items.filter(unit => unit.status === 'ACTIVE');
            setUnits(activeUnits);
            setUnitId(current => current || (activeUnits.length === 1 ? activeUnits[0].id : ''));
          }
        } catch (error) { if (alive) setMessage(failure(error, 'Erro ao carregar as unidades')); }
      }
    })();
    return () => { alive = false; };
  }, [canEdit]);

  useEffect(() => {
    if (!unitId) { setUnitView(null); return; }
    let alive = true;
    void api<UnitFiscalView>(`/fiscal/settings/units/${unitId}`)
      .then(result => { if (alive) setUnitView(result); })
      .catch(error => { if (alive) { setUnitView(null); setMessage(failure(error, 'Erro ao carregar a configuração fiscal da unidade')); } });
    return () => { alive = false; };
  }, [unitId]);

  if (!draft || !view) return <>{message ? <Notice message={message.text} kind={message.kind} /> : <p className="text-sm text-slate-500">Carregando configurações fiscais…</p>}</>;

  const disabled = !canEdit || Boolean(busy);
  const visibleSections = canEdit ? sections : sections.filter(item => item.key !== 'unit');
  const set = (change: Partial<Draft>) => setDraft(current => current && { ...current, ...change });
  const setIssuer = (change: Partial<FiscalIssuer>) => setDraft(current => current && { ...current, issuer: { ...current.issuer, ...change } });
  const setUnitIssuer = (change: Partial<FiscalIssuer>) => setUnitView(current => current && { ...current, issuer: { ...current.issuer, ...change } });
  const setModel = (model: 'nfe' | 'nfce', change: Partial<FiscalModelConfig>) => setDraft(current => current && { ...current, [model]: { ...current[model], ...change } });
  const issuer = draft.issuer;
  const series = (kind: 'NFCE' | 'NFE') => numbering?.items.find(item => item.kind === kind);

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label); setMessage(null);
    try { await action(); } finally { setBusy(''); }
  }

  const save = () => run('save', async () => {
    if (section === 'unit') {
      if (!unitId || !unitView) { setMessage({ text: 'Selecione uma unidade para salvar.', kind: 'error' }); return; }
      try {
        const next = await api<UnitFiscalView>(`/fiscal/settings/units/${unitId}`, { method: 'PUT', body: JSON.stringify({ issuer: unitView.issuer }) });
        setUnitView(next); setMessage({ text: 'Emitente fiscal da unidade salvo.', kind: 'success' });
      } catch (error) { setMessage(failure(error, 'Erro ao salvar o emitente fiscal da unidade')); }
      return;
    }
    if (!draft) return;
    const { providerToken, cscToken, ...rest } = draft;
    const body = { ...rest, ...(providerToken.trim() ? { providerToken: providerToken.trim() } : {}), ...(cscToken.trim() ? { cscToken: cscToken.trim() } : {}) };
    try {
      apply(await api<FiscalSettingsView>('/fiscal/settings', { method: 'PUT', body: JSON.stringify(body) }));
      setMessage({ text: 'Configurações fiscais salvas.', kind: 'success' });
    } catch (error) { setMessage(failure(error, 'Erro ao salvar as configurações fiscais')); }
  });

  const uploadUnitCertificate = () => run('unit-cert', async () => {
    if (!unitId || !unitCertFile) { setMessage({ text: 'Selecione o arquivo .pfx/.p12 do certificado.', kind: 'error' }); return; }
    try {
      const pfxBase64 = await readBase64(unitCertFile);
      const next = await api<UnitFiscalView>(`/fiscal/settings/units/${unitId}/certificate`, { method: 'POST', body: JSON.stringify({ pfxBase64, password: unitCertPassword }) });
      setUnitView(next); setUnitCertFile(null); setUnitCertPassword(''); setUnitFileKey(key => key + 1);
      setMessage({ text: `Certificado da unidade armazenado de forma criptografada.${next.certificateWarnings?.length ? ` Avisos: ${next.certificateWarnings.join(' ')}` : ''}`, kind: 'success' });
    } catch (error) { setUnitCertPassword(''); setMessage(failure(error, 'Erro ao importar o certificado da unidade')); }
  });

  const uploadCertificate = () => run('cert', async () => {
    if (!certFile) { setMessage({ text: 'Selecione o arquivo .pfx/.p12 do certificado.', kind: 'error' }); return; }
    try {
      const pfxBase64 = await readBase64(certFile);
      const next = await api<FiscalSettingsView & { certificateWarnings?: string[] }>('/fiscal/settings/certificate', { method: 'POST', body: JSON.stringify({ pfxBase64, password: certPassword }) });
      setView(next); setDraft(current => current && { ...current, issuer: next.issuer });
      setCertFile(null); setCertPassword(''); setFileKey(key => key + 1);
      setMessage({ text: `Certificado importado e armazenado de forma criptografada.${next.certificateWarnings?.length ? ` Avisos: ${next.certificateWarnings.join(' ')}` : ''}`, kind: 'success' });
    } catch (error) { setCertPassword(''); setMessage(failure(error, 'Erro ao importar o certificado')); }
  });

  const removeCertificate = () => run('cert-remove', async () => {
    if (!window.confirm('Remover o certificado digital da empresa? A emissão de NF-e/NFC-e ficará bloqueada até importar outro certificado.')) return;
    try { apply(await api<FiscalSettingsView>('/fiscal/settings/certificate', { method: 'DELETE' })); setMessage({ text: 'Certificado removido. O histórico fiscal foi mantido.', kind: 'success' }); }
    catch (error) { setMessage(failure(error, 'Erro ao remover o certificado')); }
  });

  const removeUnitCertificate = () => run('unit-cert-remove', async () => {
    if (!unitId || !window.confirm('Remover o certificado próprio desta unidade? Ela passará a usar o certificado da empresa.')) return;
    try {
      await api(`/fiscal/settings/units/${unitId}/certificate`, { method: 'DELETE' });
      setUnitView(await api<UnitFiscalView>(`/fiscal/settings/units/${unitId}`)); setMessage({ text: 'Certificado da unidade removido.', kind: 'success' });
    } catch (error) { setMessage(failure(error, 'Erro ao remover o certificado da unidade')); }
  });

  const saveNumbering = (kind: 'NFCE' | 'NFE') => run(`num-${kind}`, async () => {
    const value = numberingDraft[kind];
    if (!value) return;
    try {
      await api('/fiscal/numbering', { method: 'PUT', body: JSON.stringify({ kind, series: value.series.trim(), nextNumber: Number(value.nextNumber) }) });
      const next = await api<Numbering>('/fiscal/numbering'); setNumbering(next);
      setMessage({ text: `Numeração da ${kind === 'NFE' ? 'NF-e' : 'NFC-e'} salva.`, kind: 'success' });
    } catch (error) { setMessage(failure(error, 'Erro ao salvar a numeração')); }
  });

  const testCertificate = () => run('cert-test', async () => {
    try {
      const result = await api<CertificateTest>('/fiscal/settings/certificate/test', { method: 'POST' });
      const details = [result.subject, result.cnpj ? `CNPJ ${result.cnpj}` : '', result.validTo ? `válido até ${formatDateTime(result.validTo)}` : ''].filter(Boolean).join(' · ');
      setMessage({ text: `${result.message}${details ? ` (${details})` : ''}${result.warnings?.length ? ` Avisos: ${result.warnings.join(' ')}` : ''}`, kind: result.ok ? 'success' : 'error' });
    } catch (error) { setMessage(failure(error, 'Erro ao testar o certificado')); }
  });

  const testConnection = () => run('conn', async () => {
    try {
      const result = await api<{ ok: boolean; message: string }>('/fiscal/settings/test-connection', { method: 'POST' });
      setMessage({ text: result.message, kind: result.ok ? 'success' : 'error' });
    } catch (error) { setMessage(failure(error, 'Falha na comunicação com o provedor')); }
  });

  const cert = view.certificate;
  const certBadge = cert.state === 'VALID' ? <Badge tone="green">Válido</Badge> : cert.state === 'EXPIRING' ? <Badge tone="amber">Vence em {cert.daysLeft ?? 0} dias</Badge> : cert.state === 'EXPIRED' ? <Badge tone="red">Vencido</Badge> : <Badge>Não importado</Badge>;
  const problemsList = (title: string, items: string[]) => <div className="rounded-xl border border-slate-200 p-3 text-sm">
    <p className="font-semibold text-slate-800">{title}: {items.length === 0 ? <Badge tone="green">Pronto para emitir</Badge> : <Badge tone="amber">{items.length} pendência(s)</Badge>}</p>
    {items.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-600">{items.map(item => <li key={item}>{item}</li>)}</ul>}
  </div>;
  const numberingInfo = (kind: 'NFCE' | 'NFE') => {
    const current = series(kind);
    return <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">Série atual: <strong>{current?.series ?? '—'}</strong> · Próximo número: <strong>{current?.nextNumber ?? '—'}</strong>{numbering ? ` (${environmentLabel[numbering.environment as keyof typeof environmentLabel] ?? numbering.environment})` : ''}. Altere em <strong>Série e numeração</strong>.</p>;
  };
  const modelFields = (model: 'nfe' | 'nfce', emissionTypes: FiscalModelConfig['emissionType'][]) => {
    const config = draft[model];
    return <div className="grid gap-4 md:grid-cols-2">
      <Field label="Natureza da operação" maxLength={60} value={config.nature} disabled={disabled} onChange={e => setModel(model, { nature: e.target.value })} />
      <Select label="Tipo de emissão" value={config.emissionType} disabled={disabled} onChange={e => setModel(model, { emissionType: e.target.value as FiscalModelConfig['emissionType'] })}>{emissionTypes.map(type => <option key={type} value={type}>{emissionLabel[type]}</option>)}</Select>
      <Select label="Finalidade" value={config.finality} disabled={disabled} onChange={e => setModel(model, { finality: e.target.value as FiscalModelConfig['finality'] })}>{(Object.keys(finalityLabel) as FiscalModelConfig['finality'][]).map(key => <option key={key} value={key}>{finalityLabel[key]}</option>)}</Select>
      <Field label="CFOP padrão" inputMode="numeric" maxLength={4} placeholder="5102" value={config.defaultCfop} disabled={disabled} onChange={e => setModel(model, { defaultCfop: e.target.value.replace(/\D/g, '') })} />
      <label className="block text-sm font-medium text-slate-700 md:col-span-2">Informações complementares<textarea className={textareaClass} rows={3} maxLength={2000} value={config.additionalInfo} disabled={disabled} onChange={e => setModel(model, { additionalInfo: e.target.value })} /></label>
    </div>;
  };

  const body = () => {
    switch (section) {
      case 'environment': return <div className="grid gap-4">
        <div className={`rounded-2xl border-2 p-4 text-center ${view.environment === 'PRODUCTION' ? 'border-emerald-500 bg-emerald-50' : 'border-amber-400 bg-amber-50'}`}>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">Ambiente atual</p>
          <p className={`mt-1 text-2xl font-black ${view.environment === 'PRODUCTION' ? 'text-emerald-800' : 'text-amber-800'}`}>{environmentLabel[view.environment].toUpperCase()}</p>
          <p className="mt-1 text-sm text-slate-600">{view.environment === 'PRODUCTION' ? 'Os documentos emitidos têm validade fiscal.' : 'Documentos de teste, sem validade fiscal.'}</p>
        </div>
        <fieldset className="grid gap-2 sm:grid-cols-2" disabled={disabled}><legend className="mb-2 text-sm font-medium text-slate-700">Selecionar ambiente</legend>
          {(['HOMOLOGATION', 'PRODUCTION'] as const).map(env => <label key={env} className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-sm font-semibold ${draft.environment === env ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-slate-300 text-slate-700'}`}><input type="radio" name="fiscal-environment" className="accent-brand-600" checked={draft.environment === env} onChange={() => set({ environment: env })} />{environmentLabel[env]}</label>)}
        </fieldset>
        {draft.environment === 'PRODUCTION' && <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"><strong>Atenção:</strong> em Produção os documentos são transmitidos à SEFAZ com validade fiscal. Só altere após concluir os testes em homologação.</p>}
        <div className="grid gap-3 md:grid-cols-2">{problemsList('NFC-e (modelo 65)', view.readiness.NFCE)}{problemsList('NF-e (modelo 55)', view.readiness.NFE)}</div>
      </div>;
      case 'issuer': return <div className="grid gap-4 md:grid-cols-3">
        <div className="md:col-span-2"><Field label="Razão social" value={issuer.legalName} disabled={disabled} onChange={e => setIssuer({ legalName: e.target.value })} /></div>
        <Field label="Nome fantasia" value={issuer.tradeName} disabled={disabled} onChange={e => setIssuer({ tradeName: e.target.value })} />
        <Field label="CNPJ" inputMode="numeric" maxLength={18} value={issuer.cnpj} disabled={disabled} onChange={e => setIssuer({ cnpj: e.target.value })} />
        <Field label="Inscrição estadual (IE)" value={issuer.stateRegistration} disabled={disabled} onChange={e => setIssuer({ stateRegistration: e.target.value })} />
        <Field label="Inscrição municipal (IM)" value={issuer.municipalRegistration} disabled={disabled} onChange={e => setIssuer({ municipalRegistration: e.target.value })} />
        <Field label="CNAE" inputMode="numeric" maxLength={9} value={issuer.cnae} disabled={disabled} onChange={e => setIssuer({ cnae: e.target.value })} />
        <Select label="Regime tributário" value={issuer.taxRegime} disabled={disabled} onChange={e => setIssuer({ taxRegime: e.target.value as FiscalIssuer['taxRegime'] })}>{(Object.keys(regimeLabel) as FiscalIssuer['taxRegime'][]).map(key => <option key={key} value={key}>{regimeLabel[key]}</option>)}</Select>
        <div className="text-sm text-slate-700">CRT (derivado)<p className="mt-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 font-semibold">{regimeCrt[issuer.taxRegime]}</p></div>
        <div className="md:col-span-2"><Field label="Logradouro" value={issuer.street} disabled={disabled} onChange={e => setIssuer({ street: e.target.value })} /></div>
        <Field label="Número" value={issuer.number} disabled={disabled} onChange={e => setIssuer({ number: e.target.value })} />
        <Field label="Complemento" value={issuer.complement} disabled={disabled} onChange={e => setIssuer({ complement: e.target.value })} />
        <Field label="Bairro" value={issuer.district} disabled={disabled} onChange={e => setIssuer({ district: e.target.value })} />
        <Field label="Município" value={issuer.city} disabled={disabled} onChange={e => setIssuer({ city: e.target.value })} />
        <Field label="Código IBGE do município" inputMode="numeric" maxLength={7} value={issuer.cityIbge} disabled={disabled} onChange={e => setIssuer({ cityIbge: e.target.value.replace(/\D/g, '') })} />
        <Field label="UF" maxLength={2} value={issuer.uf} disabled={disabled} onChange={e => setIssuer({ uf: e.target.value.toUpperCase() })} />
        <Field label="CEP" inputMode="numeric" maxLength={9} value={issuer.cep} disabled={disabled} onChange={e => setIssuer({ cep: e.target.value })} />
        <Field label="País" value={issuer.country} disabled={disabled} onChange={e => setIssuer({ country: e.target.value })} />
        <Field label="Código do país (BACEN)" inputMode="numeric" maxLength={4} value={issuer.countryCode} disabled={disabled} onChange={e => setIssuer({ countryCode: e.target.value.replace(/\D/g, '') })} />
        <Field label="Telefone" inputMode="tel" value={issuer.phone} disabled={disabled} onChange={e => setIssuer({ phone: e.target.value })} />
        <Select label="Indicador de contribuinte (IE)" value={issuer.contributorIndicator} disabled={disabled} onChange={e => setIssuer({ contributorIndicator: e.target.value as FiscalIssuer['contributorIndicator'] })}>{(Object.keys(contributorLabel) as FiscalIssuer['contributorIndicator'][]).map(key => <option key={key} value={key}>{contributorLabel[key]}</option>)}</Select>
      </div>;
      case 'certificate': return <div className="grid gap-4">
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold text-slate-900">Certificado digital A1</p>{certBadge}</div>
          {cert.state === 'MISSING' ? <p className="mt-2 text-slate-600">Nenhum certificado importado. Sem ele não é possível emitir documentos fiscais.</p> :
            <dl className="mt-3 grid gap-2 sm:grid-cols-2">
              <div><dt className="text-xs text-slate-500">Titular</dt><dd className="break-words font-medium text-slate-800">{cert.subject || '—'}</dd></div>
              <div><dt className="text-xs text-slate-500">CNPJ</dt><dd className="font-medium text-slate-800">{cert.cnpj || '—'}</dd></div>
              <div><dt className="text-xs text-slate-500">Validade</dt><dd className="font-medium text-slate-800">{formatDateTime(cert.validFrom)} até {formatDateTime(cert.validTo)}</dd></div>
              <div><dt className="text-xs text-slate-500">Dias restantes</dt><dd className="font-medium text-slate-800">{cert.daysLeft ?? '—'}</dd></div>
              <div><dt className="text-xs text-slate-500">Importado em</dt><dd className="font-medium text-slate-800">{formatDateTime(cert.uploadedAt)}</dd></div>
            </dl>}
          <p className="mt-3 text-xs text-slate-500">O arquivo e a senha são armazenados criptografados no servidor e nunca são exibidos novamente.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm font-medium text-slate-700">Arquivo do certificado (.pfx/.p12)<input key={fileKey} type="file" accept=".pfx,.p12,application/x-pkcs12" disabled={disabled} onChange={e => setCertFile(e.target.files?.[0] ?? null)} className="mt-1 block w-full text-sm text-slate-700 file:mr-3 file:rounded-lg file:border-0 file:bg-neutral-950 file:px-3 file:py-2 file:text-brand-300" /></label>
          <Field label="Senha do certificado" type="password" autoComplete="new-password" value={certPassword} disabled={disabled} onChange={e => setCertPassword(e.target.value)} />
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass} disabled={disabled || !certFile || !certPassword} onClick={() => void uploadCertificate()}>{busy === 'cert' ? 'Importando…' : cert.state === 'MISSING' ? 'Importar certificado' : 'Substituir certificado'}</button>
          <button type="button" className={secondaryButtonClass} disabled={Boolean(busy) || cert.state === 'MISSING'} onClick={() => void testCertificate()}>{busy === 'cert-test' ? 'Testando…' : 'Validar certificado'}</button>
          {cert.state !== 'MISSING' && <button type="button" className={dangerButtonClass} disabled={disabled} onClick={() => void removeCertificate()}>{busy === 'cert-remove' ? 'Removendo…' : 'Remover certificado'}</button>}
        </div>
        <p className="text-xs text-slate-500">Somente certificado A1 (arquivo). Certificado A3 (token/cartão) ainda não é suportado. Um estabelecimento com CNPJ próprio pode ter certificado próprio em <strong>Estabelecimentos</strong>.</p>
      </div>;
      case 'provider': return <div className="grid gap-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Select label="Provedor fiscal" value={draft.provider ?? ''} disabled={disabled} onChange={e => set({ provider: e.target.value || null })}><option value="">Nenhum</option>{view.providers.map(provider => <option key={provider} value={provider}>{providerLabel(provider)}</option>)}</Select>
          <Field label="Token da API do provedor" type="password" autoComplete="new-password" placeholder={view.hasProviderToken ? '•••• (mantido)' : 'Informe o token'} value={draft.providerToken} disabled={disabled} onChange={e => set({ providerToken: e.target.value })} />
        </div>
        <p className="text-xs text-slate-500">{draft.provider === 'sefaz' ? 'SEFAZ direta: o XML é assinado com o certificado A1 e enviado aos web services oficiais (MT). Não precisa de token.' : 'Deixe o token em branco para manter o atual.'} Salve antes de testar a comunicação; o teste consulta o status do serviço da SEFAZ no ambiente selecionado.</p>
        <div><button type="button" className={secondaryButtonClass} disabled={Boolean(busy) || !view.provider} onClick={() => void testConnection()}>{busy === 'conn' ? 'Testando…' : 'Testar comunicação'}</button></div>
      </div>;
      case 'nfce': return <div className="grid gap-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="CSC ID (identificador do token)" inputMode="numeric" maxLength={6} value={draft.cscId} disabled={disabled} onChange={e => set({ cscId: e.target.value.replace(/\D/g, '').slice(0, 6) })} />
          <Field label="CSC (código de segurança do contribuinte)" type="password" autoComplete="new-password" placeholder={view.hasCscToken ? '•••• (mantido)' : 'Informe o CSC'} value={draft.cscToken} disabled={disabled} onChange={e => set({ cscToken: e.target.value })} />
        </div>
        {modelFields('nfce', ['NORMAL', 'CONTINGENCY_OFFLINE'])}
        {numberingInfo('NFCE')}
      </div>;
      case 'nfe': return <div className="grid gap-4">
        {modelFields('nfe', ['NORMAL', 'EPEC', 'FS_DA'])}
        <p className="text-xs text-slate-500">A disponibilidade de EPEC e FS-DA depende da SEFAZ da UF e do provedor fiscal.</p>
        {numberingInfo('NFE')}
      </div>;
      case 'tax': return <div className="grid gap-3">
        <Select label="Regra tributária padrão" value={draft.defaultTaxRuleId ?? ''} disabled={disabled} onChange={e => set({ defaultTaxRuleId: e.target.value || null })}><option value="">Nenhuma</option>{rules.filter(rule => rule.active || rule.id === draft.defaultTaxRuleId).map(rule => <option key={rule.id} value={rule.id}>{rule.name}{rule.active ? '' : ' (inativa)'}</option>)}</Select>
        <p className="text-sm text-slate-600">Aplicada aos produtos sem regra própria ou com regra fora da vigência. Cadastre as regras em <strong>Regras tributárias</strong>; o CFOP segue a ordem: regra do produto (estadual/interestadual) → natureza de operação compatível → padrão abaixo.</p>
        <h5 className="mt-2 text-sm font-semibold text-slate-800">CFOP padrão por operação</h5>
        <p className="text-xs text-slate-500">Usado quando a regra tributária do produto e a natureza de operação não definem o CFOP. A NFC-e é sempre dentro do estado; o CFOP interestadual vale apenas para NF-e.</p>
        <div className="grid gap-4 md:grid-cols-4">
          {([['saleInternal', 'Saída: venda no estado', '5102'], ['saleInterstate', 'Saída: venda interestadual', '6102'], ['returnInternal', 'Devolução no estado', '1202'], ['returnInterstate', 'Devolução interestadual', '2202'], ['purchaseInternal', 'Entrada: compra no estado', '1102'], ['purchaseInterstate', 'Entrada: compra interestadual', '2102']] as [keyof CfopDefaults, string, string][]).map(([key, label, example]) =>
            <Field key={key} label={label} inputMode="numeric" maxLength={4} placeholder={example} value={draft.cfop[key] ?? ''} disabled={disabled} onChange={e => set({ cfop: { ...draft.cfop, [key]: e.target.value.replace(/\D/g, '') } })} />)}
        </div>
      </div>;
      case 'numbering': return <div className="grid gap-4">
        <p className="text-sm text-slate-600">Série e próximo número de cada modelo no ambiente <strong>{numbering ? environmentLabel[numbering.environment as keyof typeof environmentLabel] ?? numbering.environment : '—'}</strong>{storedUser().unitId ? ' para o seu estabelecimento' : ''}. A numeração só avança: números já emitidos ou inutilizados não podem ser reutilizados. Para inutilizar faixas use <Link href="/contingency" className="font-semibold text-brand-700 underline">Contingências</Link> ou o PDV.</p>
        {(['NFCE', 'NFE'] as const).map(kind => <div key={kind} className="grid items-end gap-4 rounded-xl border border-slate-200 p-4 md:grid-cols-4">
          <p className="font-semibold text-slate-800">{kind === 'NFE' ? 'NF-e (modelo 55)' : 'NFC-e (modelo 65)'}</p>
          <Field label="Série" inputMode="numeric" maxLength={3} value={numberingDraft[kind]?.series ?? ''} disabled={disabled} onChange={e => setNumberingDraft(current => ({ ...current, [kind]: { series: e.target.value.replace(/\D/g, ''), nextNumber: current[kind]?.nextNumber ?? '1' } }))} />
          <Field label="Próximo número" type="number" min="1" step="1" value={numberingDraft[kind]?.nextNumber ?? ''} disabled={disabled} onChange={e => setNumberingDraft(current => ({ ...current, [kind]: { series: current[kind]?.series ?? '1', nextNumber: e.target.value } }))} />
          <button type="button" className={buttonClass} disabled={disabled || !numberingDraft[kind]?.series || !Number(numberingDraft[kind]?.nextNumber)} onClick={() => void saveNumbering(kind)}>{busy === `num-${kind}` ? 'Salvando…' : 'Salvar numeração'}</button>
        </div>)}
      </div>;
      case 'natures': return <NaturesManager embedded />;
      case 'rules': return <TaxRulesManager embedded />;
      case 'pdv': return <fieldset disabled={disabled} className="grid gap-3"><legend className={`${sectionTitleClass} w-full`}>Comportamento fiscal do PDV</legend>
        {pdvModes.map(mode => <label key={mode.key} className={`flex cursor-pointer items-start gap-3 rounded-2xl border-2 p-4 transition ${draft.pdvMode === mode.key ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:border-brand-300'}`}>
          <input type="radio" name="pdv-mode" className="mt-1 h-4 w-4 accent-brand-600" checked={draft.pdvMode === mode.key} onChange={() => set({ pdvMode: mode.key })} />
          <span><span className="block text-base font-bold text-slate-900">{mode.title}</span><span className="mt-1 block text-sm text-slate-600">{mode.description}</span></span>
        </label>)}
        <p className="text-xs text-slate-500">A alteração vale apenas para as próximas vendas; vendas já registradas não são afetadas.</p>
      </fieldset>;
      case 'unit': return <div className="grid gap-4">
        <Select label="Unidade" value={unitId} disabled={disabled || units.length === 0} onChange={e => setUnitId(e.target.value)}>
          <option value="">Selecione uma unidade</option>{units.map(unit => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
        </Select>
        {!unitId ? <p className="text-sm text-slate-600">{units.length ? 'Selecione a unidade para configurar seu emitente e certificado.' : 'Nenhuma unidade ativa disponível.'}</p> : !unitView ? <p className="text-sm text-slate-500">Carregando configuração da unidade…</p> : <>
          <p className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">A unidade usa a configuração da empresa até você cadastrar um emitente próprio. Certificado próprio é opcional quando o certificado da empresa pertence à mesma raiz de CNPJ.</p>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="md:col-span-2"><Field label="Razão social" value={unitView.issuer.legalName} disabled={disabled} onChange={e => setUnitIssuer({ legalName: e.target.value })} /></div>
            <Field label="Nome fantasia" value={unitView.issuer.tradeName} disabled={disabled} onChange={e => setUnitIssuer({ tradeName: e.target.value })} />
            <Field label="CNPJ" inputMode="numeric" maxLength={18} value={unitView.issuer.cnpj} disabled={disabled} onChange={e => setUnitIssuer({ cnpj: e.target.value })} />
            <Field label="Inscrição estadual (IE)" value={unitView.issuer.stateRegistration} disabled={disabled} onChange={e => setUnitIssuer({ stateRegistration: e.target.value })} />
            <Field label="Inscrição municipal (IM)" value={unitView.issuer.municipalRegistration} disabled={disabled} onChange={e => setUnitIssuer({ municipalRegistration: e.target.value })} />
            <Field label="CNAE" inputMode="numeric" maxLength={9} value={unitView.issuer.cnae} disabled={disabled} onChange={e => setUnitIssuer({ cnae: e.target.value })} />
            <Select label="Regime tributário" value={unitView.issuer.taxRegime} disabled={disabled} onChange={e => setUnitIssuer({ taxRegime: e.target.value as FiscalIssuer['taxRegime'] })}>{(Object.keys(regimeLabel) as FiscalIssuer['taxRegime'][]).map(key => <option key={key} value={key}>{regimeLabel[key]}</option>)}</Select>
            <div className="text-sm text-slate-700">CRT (derivado)<p className="mt-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 font-semibold">{regimeCrt[unitView.issuer.taxRegime]}</p></div>
            <div className="md:col-span-2"><Field label="Logradouro" value={unitView.issuer.street} disabled={disabled} onChange={e => setUnitIssuer({ street: e.target.value })} /></div>
            <Field label="Número" value={unitView.issuer.number} disabled={disabled} onChange={e => setUnitIssuer({ number: e.target.value })} />
            <Field label="Complemento" value={unitView.issuer.complement} disabled={disabled} onChange={e => setUnitIssuer({ complement: e.target.value })} />
            <Field label="Bairro" value={unitView.issuer.district} disabled={disabled} onChange={e => setUnitIssuer({ district: e.target.value })} />
            <Field label="Município" value={unitView.issuer.city} disabled={disabled} onChange={e => setUnitIssuer({ city: e.target.value })} />
            <Field label="Código IBGE do município" inputMode="numeric" maxLength={7} value={unitView.issuer.cityIbge} disabled={disabled} onChange={e => setUnitIssuer({ cityIbge: e.target.value.replace(/\D/g, '') })} />
            <Field label="UF" maxLength={2} value={unitView.issuer.uf} disabled={disabled} onChange={e => setUnitIssuer({ uf: e.target.value.toUpperCase() })} />
            <Field label="CEP" inputMode="numeric" maxLength={9} value={unitView.issuer.cep} disabled={disabled} onChange={e => setUnitIssuer({ cep: e.target.value })} />
            <Field label="País" value={unitView.issuer.country} disabled={disabled} onChange={e => setUnitIssuer({ country: e.target.value })} />
            <Field label="Código do país (BACEN)" inputMode="numeric" maxLength={4} value={unitView.issuer.countryCode} disabled={disabled} onChange={e => setUnitIssuer({ countryCode: e.target.value.replace(/\D/g, '') })} />
            <Field label="Telefone" inputMode="tel" value={unitView.issuer.phone} disabled={disabled} onChange={e => setUnitIssuer({ phone: e.target.value })} />
            <Select label="Indicador de contribuinte (IE)" value={unitView.issuer.contributorIndicator} disabled={disabled} onChange={e => setUnitIssuer({ contributorIndicator: e.target.value as FiscalIssuer['contributorIndicator'] })}>{(Object.keys(contributorLabel) as FiscalIssuer['contributorIndicator'][]).map(key => <option key={key} value={key}>{contributorLabel[key]}</option>)}</Select>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm">
            <div className="flex items-center justify-between gap-2"><p className="font-semibold text-slate-900">Certificado da unidade</p>{unitView.certificate.state === 'VALID' ? <Badge tone="green">Válido</Badge> : unitView.certificate.state === 'EXPIRING' ? <Badge tone="amber">Vence em {unitView.certificate.daysLeft ?? 0} dias</Badge> : unitView.certificate.state === 'EXPIRED' ? <Badge tone="red">Vencido</Badge> : <Badge>Não importado</Badge>}</div>
            <p className="mt-2 text-slate-600">{unitView.ownCertificate ? `Certificado próprio: ${unitView.certificate.subject ?? 'A1'}` : 'Usando o certificado da empresa, se compatível com a raiz do CNPJ.'}</p>
            {unitView.certificate.validTo && <p className="mt-1 text-slate-600">CNPJ {unitView.certificate.cnpj ?? '—'} · válido até {formatDateTime(unitView.certificate.validTo)}</p>}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block text-sm font-medium text-slate-700">Arquivo do certificado (.pfx/.p12)<input key={unitFileKey} type="file" accept=".pfx,.p12,application/x-pkcs12" disabled={disabled} onChange={e => setUnitCertFile(e.target.files?.[0] ?? null)} className="mt-1 block w-full text-sm text-slate-700 file:mr-3 file:rounded-lg file:border-0 file:bg-neutral-950 file:px-3 file:py-2 file:text-brand-300" /></label>
            <Field label="Senha do certificado" type="password" autoComplete="new-password" value={unitCertPassword} disabled={disabled} onChange={e => setUnitCertPassword(e.target.value)} />
          </div>
          <button type="button" className={secondaryButtonClass} disabled={disabled || !unitCertFile || !unitCertPassword} onClick={() => void uploadUnitCertificate()}>{busy === 'unit-cert' ? 'Importando…' : unitView.ownCertificate ? 'Substituir certificado da unidade' : 'Importar certificado da unidade'}</button>
          {unitView.ownCertificate && <button type="button" className={dangerButtonClass} disabled={disabled} onClick={() => void removeUnitCertificate()}>{busy === 'unit-cert-remove' ? 'Removendo…' : 'Remover certificado da unidade'}</button>}
        </>}
      </div>;
      default: return null;
    }
  };

  return <div>
    {message && <div><Notice message={message.text} kind={message.kind} />{message.problems && message.problems.length > 0 && <ul className="-mt-2 mb-4 list-disc space-y-1 rounded-xl border border-red-200 bg-red-50 py-3 pl-9 pr-4 text-sm text-red-800">{message.problems.map(item => <li key={item}>{item}</li>)}</ul>}</div>}
    <Tabs tabs={visibleSections} value={section} onChange={setSection} label="Seções fiscais" />
    <h4 className={sectionTitleClass}>{visibleSections.find(item => item.key === section)?.label}</h4>
    {body()}
    {!selfSaving.includes(section) && <div className="mt-6 flex flex-wrap items-center justify-end gap-3 border-t border-slate-200 pt-4">
      {!canEdit && <span className="text-sm text-slate-500">Somente administradores e gerentes podem alterar.</span>}
      <button type="button" className={buttonClass} disabled={disabled || (section === 'unit' && (!unitId || !unitView))} onClick={() => void save()}>{busy === 'save' ? 'Salvando…' : section === 'unit' ? 'Salvar unidade fiscal' : 'Salvar configurações fiscais'}</button>
    </div>}
  </div>;
}
