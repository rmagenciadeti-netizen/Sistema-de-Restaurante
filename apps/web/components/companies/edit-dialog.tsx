'use client';

import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { isValidCnpj, maskCnpj } from '../../lib/cnpj';
import { buttonClass, Field, Notice, secondaryButtonClass, Select } from '../app-shell';

type Form = {
  name: string; slug: string; plan: string; legalName: string; tradeName: string; document: string; activity: string; email: string; phone: string; whatsapp: string;
  responsibleName: string; zip: string; state: string; city: string; district: string; address: string; number: string;
};
type Detail = { tenant: { id: string; name: string; slug: string; plan: string }; company: Omit<Form, 'name' | 'slug' | 'plan'> };
const COMPANY_KEYS = ['legalName', 'tradeName', 'document', 'activity', 'email', 'phone', 'whatsapp', 'responsibleName', 'zip', 'state', 'city', 'district', 'address', 'number'] as const;
const digits = (value: string) => value.replace(/\D/g, '');

// Full editing of a registered company: identity (name, slug, plan) and cadastral data. Validates on the client for quick feedback; the API validates again.
export function CompanyEditDialog({ tenantId, onClose, onSaved }: { tenantId: string; onClose: () => void; onSaved: (message: string) => void }) {
  const [form, setForm] = useState<Form | null>(null);
  const [original, setOriginal] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api<Detail>(`/tenants/${tenantId}`).then(detail => {
      if (!active) return;
      const values: Form = { name: detail.tenant.name, slug: detail.tenant.slug, plan: detail.tenant.plan, ...Object.fromEntries(COMPANY_KEYS.map(key => [key, detail.company[key] ?? ''])) } as Form;
      setForm(values); setOriginal(values);
    }).catch(cause => { if (active) setMessage(errorMessage(cause, 'Erro ao carregar os dados da empresa')); });
    return () => { active = false; };
  }, [tenantId]);

  function validate(values: Form) {
    const found: Partial<Record<keyof Form, string>> = {};
    if (values.name.trim().length < 2) found.name = 'Informe o nome da empresa.';
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values.slug)) found.slug = 'Use letras minúsculas, números e hífens.';
    if (values.document && !isValidCnpj(values.document)) found.document = 'CNPJ inválido.';
    if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) found.email = 'E-mail inválido.';
    for (const key of ['phone', 'whatsapp'] as const) if (values[key] && (digits(values[key]).length < 10 || digits(values[key]).length > 13)) found[key] = 'Informe DDD + número.';
    if (values.zip && digits(values.zip).length !== 8) found.zip = 'CEP deve ter 8 dígitos.';
    if (values.state && !/^[A-Za-z]{2}$/.test(values.state)) found.state = 'Use a sigla da UF.';
    return found;
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!form || !original) return;
    const found = validate(form); setErrors(found);
    if (Object.keys(found).length > 0) { setMessage('Corrija os campos destacados.'); return; }
    const company = Object.fromEntries(COMPANY_KEYS.filter(key => form[key] !== original[key]).map(key => [key, form[key]]));
    const body = { ...(form.name !== original.name ? { name: form.name } : {}), ...(form.slug !== original.slug ? { slug: form.slug } : {}), ...(form.plan !== original.plan ? { plan: form.plan } : {}), ...(Object.keys(company).length ? { company } : {}) };
    if (Object.keys(body).length === 0) { onClose(); return; }
    setBusy(true); setMessage('');
    try {
      const result = await api<{ changedFields: string[] }>(`/tenants/${tenantId}`, { method: 'PATCH', body: JSON.stringify(body) });
      onSaved(`Empresa atualizada (${result.changedFields.length} campo(s) alterado(s)).`);
    } catch (cause) { setMessage(errorMessage(cause, 'Erro ao salvar a empresa')); } finally { setBusy(false); }
  }

  const set = (key: keyof Form, value: string) => { setForm(current => (current ? { ...current, [key]: value } : current)); setErrors(current => ({ ...current, [key]: undefined })); };
  const input = (key: keyof Form, label: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div><Field label={label} value={form?.[key] ?? ''} onChange={event => set(key, event.target.value)} aria-invalid={Boolean(errors[key])} {...extra} />{errors[key] && <p className="mt-1 text-xs text-red-600">{errors[key]}</p>}</div>
  );

  return <div role="dialog" aria-modal="true" aria-label="Editar empresa" className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/60 p-4" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <form onSubmit={save} className="w-full max-w-4xl rounded-2xl bg-white p-5 text-slate-900 shadow-xl">
      <h2 className="mb-1 text-lg font-bold">Editar empresa</h2>
      <p className="mb-4 text-xs text-slate-500">Alterar o slug muda o endereço público da loja. Plano comercial, valores e licença são editados em Clientes e assinaturas.</p>
      {message && <Notice message={message} />}
      {!form ? <p className="text-sm text-slate-500">Carregando…</p> : <>
        <div className="grid gap-3 md:grid-cols-3">
          {input('name', 'Nome da empresa', { required: true })}
          {input('slug', 'Slug (endereço da loja)', { required: true })}
          <Select label="Plano" value={form.plan} onChange={event => set('plan', event.target.value)}><option value="BASIC">Básico</option><option value="PRO">Pro</option><option value="PREMIUM">Premium</option><option value="ENTERPRISE">Enterprise</option></Select>
          {input('legalName', 'Razão social')}
          {input('tradeName', 'Nome fantasia')}
          {input('document', 'CNPJ', { inputMode: 'numeric', placeholder: '00.000.000/0000-00', onChange: event => set('document', maskCnpj(event.target.value)) })}
          {input('activity', 'Atividade')}
          {input('responsibleName', 'Responsável')}
          {input('email', 'E-mail', { type: 'email' })}
          {input('phone', 'Telefone')}
          {input('whatsapp', 'WhatsApp')}
          {input('zip', 'CEP')}
          {input('state', 'UF', { maxLength: 2 })}
          {input('city', 'Cidade')}
          {input('district', 'Bairro')}
          {input('address', 'Endereço')}
          {input('number', 'Número')}
        </div>
        <div className="mt-5 flex justify-end gap-2"><button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>Cancelar</button><button className={buttonClass} disabled={busy}>{busy ? 'Salvando…' : 'Salvar alterações'}</button></div>
      </>}
      {!form && <div className="mt-4 flex justify-end"><button type="button" className={secondaryButtonClass} onClick={onClose}>Fechar</button></div>}
    </form>
  </div>;
}
