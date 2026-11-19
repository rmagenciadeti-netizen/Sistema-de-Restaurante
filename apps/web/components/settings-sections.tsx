'use client';

import Link from './nav-link';
import { useRef, useState, type ReactNode } from 'react';
import { alwaysVisibleHrefs, menuCatalog } from '../lib/menu-catalog';
import { type TenantSettings } from '../lib/settings';
import { marginSimulation, parseMenuLayout, scaleBarcodeExample, serializeMenuLayout, suggestPassword } from '../lib/settings-helpers';
import { api, errorMessage, formatMoney } from '../lib/api';
import { useAutoLoad } from '../lib/use-auto-load';
import { fileToDataUrl } from '../lib/image-resize';
import { Field, inputClass, buttonClass, secondaryButtonClass, Select } from './app-shell';
import { Badge, dangerButtonClass, DataTable, Toggle } from './ui';
import { WeekSlots } from './week-slots';

type SectionProps<S extends keyof TenantSettings> = { value: TenantSettings[S]; onChange: (patch: Partial<TenantSettings[S]>) => void; disabled: boolean };

export function NumberField({ label, value, onChange, min = 0, max, step = 1, hint, disabled }: { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number; hint?: string; disabled?: boolean }) {
  const [text, setText] = useState<string | null>(null);
  return <label className="block text-sm font-medium text-slate-700">{label}
    <input type="number" inputMode="decimal" min={min} max={max} step={step} disabled={disabled} value={text ?? String(value)}
      onChange={event => { setText(event.target.value); const next = Number(event.target.value); if (event.target.value !== '' && Number.isFinite(next)) onChange(next); }}
      onBlur={() => setText(null)} className={inputClass} />
    {hint && <span className="mt-1 block text-xs font-normal text-slate-500">{hint}</span>}
  </label>;
}

const Grid = ({ children }: { children: ReactNode }) => <div className="grid gap-4 sm:grid-cols-2">{children}</div>;
const Stack = ({ children }: { children: ReactNode }) => <div className="space-y-3">{children}</div>;
const Subtitle = ({ children }: { children: ReactNode }) => <h3 className="mb-3 mt-6 text-sm font-bold uppercase tracking-wider text-slate-500 first:mt-0">{children}</h3>;
const Hint = ({ children }: { children: ReactNode }) => <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">{children}</p>;

function StoreIdentity() {
  const [slug, setSlug] = useState(''); const [message, setMessage] = useState('');
  useAutoLoad(async () => { try { setSlug((await api<{ user: { tenant?: { slug?: string } | null } }>('/auth/me')).user.tenant?.slug ?? ''); } catch (e) { setMessage(errorMessage(e, 'Erro ao carregar o identificador da loja')); } });
  if (!slug) return message ? <p role="status" className="mb-4 text-sm text-red-700">{message}</p> : <p className="mb-4 text-sm text-slate-500">Carregando o identificador da loja…</p>;
  async function copy() {
    try { await navigator.clipboard.writeText(slug); setMessage('Identificador copiado.'); }
    catch { setMessage('Não foi possível copiar automaticamente. Selecione o identificador e copie manualmente.'); }
  }
  return <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
    <span className="text-slate-500">ID da loja</span><code className="rounded bg-white px-2 py-0.5 font-mono text-slate-900">{slug}</code>
    <button type="button" className={secondaryButtonClass} onClick={() => void copy()}>Copiar</button>
    <span className="text-xs text-slate-500">Identifica a empresa no link da loja virtual e nas integrações.</span>
    {message && <span role="status" className="w-full text-xs text-slate-600">{message}</span>}
  </div>;
}

export function CompanySection({ value, onChange, disabled }: SectionProps<'company'>) {
  const text = (key: keyof TenantSettings['company'], label: string, extra: { maxLength?: number; placeholder?: string } = {}) => <Field label={label} value={value[key]} disabled={disabled} onChange={event => onChange({ [key]: event.target.value })} {...extra} />;
  return <div>
    <Subtitle>Aparência do painel</Subtitle>
    <Grid><Select label="Layout do menu lateral" value={value.sidebarLayout} disabled={disabled} onChange={event => onChange({ sidebarLayout: event.target.value as typeof value.sidebarLayout })}><option value="CLASSIC">Clássico (menu completo)</option><option value="COMPACT">Compacto (só ícones; expande pelo botão do menu)</option></Select></Grid>
    <p className="mt-3 text-sm text-slate-500">Ajustes do robô e das mensagens automáticas estão em <Link href="/whatsapp" className="font-semibold text-brand-700 underline">WhatsApp Business</Link>.</p>
    <Subtitle>Dados da empresa</Subtitle>
    <StoreIdentity />
    <Grid>{text('tradeName', 'Nome fantasia', { maxLength: 160 })}{text('legalName', 'Razão social', { maxLength: 160 })}{text('document', 'CNPJ/CPF', { maxLength: 20 })}{text('activity', 'Ramo de atividade', { maxLength: 80, placeholder: 'Ex.: Restaurante' })}</Grid>
    <div className="mt-4">{text('slogan', 'Slogan / frase de destaque', { maxLength: 120 })}</div>
    <Subtitle>Contato</Subtitle>
    <Grid>{text('phone', 'Telefone', { maxLength: 30 })}{text('whatsapp', 'WhatsApp', { maxLength: 30 })}</Grid>
    <Subtitle>Endereço</Subtitle>
    <Grid>{text('zip', 'CEP', { maxLength: 10 })}{text('state', 'UF', { maxLength: 2 })}{text('city', 'Cidade', { maxLength: 80 })}{text('district', 'Bairro', { maxLength: 80 })}{text('address', 'Rua / logradouro', { maxLength: 160 })}{text('number', 'Número', { maxLength: 10 })}</Grid>
    <Subtitle>Proteção de dados (LGPD)</Subtitle>
    <Grid>
      <Field label="Encarregado de dados (DPO)" value={value.dpoName} maxLength={120} disabled={disabled} onChange={event => onChange({ dpoName: event.target.value })} />
      <Field label="E-mail do encarregado" type="email" value={value.dpoEmail} maxLength={254} disabled={disabled} onChange={event => onChange({ dpoEmail: event.target.value })} />
    </Grid>
    <p className="mt-3 text-sm text-slate-600">Para acessar, baixar (cópia), corrigir ou excluir os dados de clientes, use o cadastro de clientes: cada ficha tem exportação em JSON, correção e anonimização, com registro na auditoria. Solicitações de titulares devem ser respondidas em até 15 dias (LGPD, art. 18). <Link href="/customers" className="font-semibold text-brand-700 underline">Abrir cadastro de clientes</Link></p>
  </div>;
}

export function MenuLayoutSection({ value, onChange, disabled, onMessage }: SectionProps<'menuLayout'> & { onMessage: (text: string, kind: 'error' | 'success') => void }) {
  const hidden = new Set(value.hidden);
  const fileRef = useRef<HTMLInputElement>(null);
  const groups = menuCatalog.reduce<Record<string, typeof menuCatalog>>((acc, item) => ({ ...acc, [item.group]: [...(acc[item.group] ?? []), item] }), {});
  const setVisible = (href: string, visible: boolean) => onChange({ hidden: visible ? value.hidden.filter(item => item !== href) : [...value.hidden, href] });

  function exportLayout() {
    const url = URL.createObjectURL(new Blob([serializeMenuLayout(value.hidden)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'layout-do-menu.json'; link.click(); URL.revokeObjectURL(url);
  }
  async function importLayout(file?: File) {
    if (!file) return;
    const imported = parseMenuLayout(await file.text(), menuCatalog.map(item => item.href));
    if (!imported) { onMessage('Arquivo inválido: use um layout exportado por esta tela.', 'error'); return; }
    onChange({ hidden: imported.filter(href => !alwaysVisibleHrefs.includes(href)) });
    onMessage(`Layout importado (${imported.length} itens ocultos). Clique em Salvar para aplicar.`, 'success');
    if (fileRef.current) fileRef.current.value = '';
  }

  return <div>
    <Hint>Escolha quais itens aparecem no menu lateral. <strong>Nada é excluído e isto não libera acesso</strong>: ocultar só simplifica a navegação, as permissões e a licença continuam valendo.</Hint>
    <div className="my-4 flex flex-wrap items-center gap-2">
      <button type="button" onClick={exportLayout} className={secondaryButtonClass}>Exportar layout (JSON)</button>
      <button type="button" disabled={disabled} onClick={() => fileRef.current?.click()} className={secondaryButtonClass}>Importar layout</button>
      <input ref={fileRef} type="file" accept="application/json,.json" className="sr-only" aria-label="Arquivo de layout do menu" onChange={event => void importLayout(event.target.files?.[0])} />
      <button type="button" disabled={disabled || value.hidden.length === 0} onClick={() => onChange({ hidden: [] })} className={secondaryButtonClass}>Mostrar todos</button>
      <Badge tone={value.hidden.length ? 'amber' : 'green'}>{value.hidden.length} oculto(s)</Badge>
    </div>
    <div className="space-y-5">
      {Object.entries(groups).map(([group, items]) => <fieldset key={group}>
        <legend className="mb-2 text-sm font-bold text-slate-800">{group}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {items.map(item => {
            const locked = alwaysVisibleHrefs.includes(item.href);
            return <Toggle key={item.href} label={item.label} hint={locked ? 'Sempre visível' : hidden.has(item.href) ? 'Oculto no menu' : 'Visível no menu'} checked={locked || !hidden.has(item.href)} disabled={disabled || locked} onChange={visible => setVisible(item.href, visible)} />;
          })}
        </div>
      </fieldset>)}
    </div>
  </div>;
}

const timezones = ['America/Sao_Paulo', 'America/Manaus', 'America/Belem', 'America/Fortaleza', 'America/Recife', 'America/Bahia', 'America/Cuiaba', 'America/Campo_Grande', 'America/Porto_Velho', 'America/Rio_Branco', 'America/Noronha'];

export function HoursSection({ value, onChange, disabled }: SectionProps<'hours'>) {
  const modes = [
    { key: 'OPEN', label: 'Aberto agora', hint: 'A loja aceita pedidos independentemente do horário.' },
    { key: 'CLOSED', label: 'Fechado agora', hint: 'A loja não aceita pedidos até você reabrir.' },
    { key: 'SCHEDULE', label: 'Horários pré-definidos', hint: 'Abre e fecha sozinha conforme a grade semanal.' },
  ] as const;
  return <div>
    <Select label="Fuso horário" value={value.timezone} disabled={disabled} onChange={event => onChange({ timezone: event.target.value })}>
      {(timezones.includes(value.timezone) ? timezones : [value.timezone, ...timezones]).map(zone => <option key={zone} value={zone}>{zone.replace('America/', '').replace('_', ' ')} ({zone})</option>)}
    </Select>
    <Subtitle>Funcionamento da loja</Subtitle>
    <div role="radiogroup" aria-label="Funcionamento da loja" className="grid gap-2 sm:grid-cols-3">
      {modes.map(mode => <label key={mode.key} className={`cursor-pointer rounded-xl border px-4 py-3 text-sm ${value.mode === mode.key ? 'border-brand-500 bg-brand-50' : 'border-slate-200 bg-slate-50 hover:border-brand-300'}`}>
        <input type="radio" name="hours-mode" className="sr-only" checked={value.mode === mode.key} disabled={disabled} onChange={() => onChange({ mode: mode.key })} />
        <span className="block font-semibold text-slate-900">{value.mode === mode.key ? '● ' : '○ '}{mode.label}</span><span className="mt-0.5 block text-xs text-slate-500">{mode.hint}</span>
      </label>)}
    </div>
    <Subtitle>Grade semanal</Subtitle>
    {value.mode !== 'SCHEDULE' && <p className="mb-3 text-xs text-slate-500">A grade só vale no modo “Horários pré-definidos”, mas pode ser preparada desde já.</p>}
    <WeekSlots slots={value.weekly} disabled={disabled} defaultOpen onChange={weekly => onChange({ weekly })} />
  </div>;
}

export function FulfillmentSection({ value, onChange, disabled }: SectionProps<'fulfillment'>) {
  return <div>
    <Subtitle>Modalidades</Subtitle>
    <Grid>
      <Toggle label="Retirada no balcão" checked={value.allowPickup} disabled={disabled} onChange={allowPickup => onChange({ allowPickup })} />
      <Toggle label="Entrega" checked={value.allowDelivery} disabled={disabled} onChange={allowDelivery => onChange({ allowDelivery })} />
      <Toggle label="Consumo no local" checked={value.allowDineIn} disabled={disabled} onChange={allowDineIn => onChange({ allowDineIn })} />
      <Toggle label="Pedidos do QR Code da mesa dependem de confirmação do atendente" hint="Desligado: o pedido vai direto para a cozinha. Ligado: aparece em Mesas › Solicitações para o atendente aceitar ou recusar." checked={value.qrConfirmation} disabled={disabled} onChange={qrConfirmation => onChange({ qrConfirmation })} />
      <Toggle label="Exibir tempo estimado" hint="Mostra os minutos abaixo ao cliente." checked={value.estimatedTime} disabled={disabled} onChange={estimatedTime => onChange({ estimatedTime })} />
    </Grid>
    <Subtitle>Tempos estimados</Subtitle>
    <Grid>
      <NumberField label="Retirada (minutos)" value={value.pickupMinutes} max={600} disabled={disabled} onChange={pickupMinutes => onChange({ pickupMinutes })} />
      <NumberField label="Entrega (minutos)" value={value.deliveryMinutes} max={600} disabled={disabled} onChange={deliveryMinutes => onChange({ deliveryMinutes })} />
    </Grid>
    <Subtitle>Taxa de entrega</Subtitle>
    <Grid>
      <Select label="Como cobrar a taxa" value={value.deliveryFeeMode} disabled={disabled} onChange={event => onChange({ deliveryFeeMode: event.target.value as typeof value.deliveryFeeMode })}>
        <option value="SINGLE">Taxa única</option><option value="UNMAPPED">Sem mapeamento (combinar com o cliente)</option><option value="ZONES">Por zona de entrega</option><option value="DISTRICT">Por bairro</option>
      </Select>
      {value.deliveryFeeMode === 'SINGLE' && <NumberField label="Taxa única (R$)" value={value.singleFee} step={0.5} max={9999} disabled={disabled} onChange={singleFee => onChange({ singleFee })} />}
      <NumberField label="Pedido mínimo para entrega (R$)" value={value.minDelivery} step={1} max={99999} disabled={disabled} onChange={minDelivery => onChange({ minDelivery })} />
      <NumberField label="Entrega grátis acima de (R$)" value={value.freeDeliveryMin} step={1} max={99999} hint="0 desativa." disabled={disabled} onChange={freeDeliveryMin => onChange({ freeDeliveryMin })} />
    </Grid>
    <p className="mt-4 text-sm text-slate-500">As zonas e valores por região ficam em <Link href="/delivery" className="font-semibold text-brand-700 hover:underline">Entregas e zonas</Link>.</p>
  </div>;
}

type StoreImageKind = 'LOGO' | 'COVER';
// Logo and cover are saved immediately through their own endpoints (not with the settings draft).
function StoreProfileControl({ disabled }: { disabled: boolean }) {
  const [images, setImages] = useState<Partial<Record<StoreImageKind, string>>>({}); const [busy, setBusy] = useState<StoreImageKind | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null); const [slug, setSlug] = useState(''); const [origin, setOrigin] = useState('');
  useAutoLoad(async () => {
    try {
      const [settings, me] = await Promise.all([api<{ storeImages: Partial<Record<StoreImageKind, number>> }>('/settings'), api<{ user: { tenant?: { slug?: string } | null } }>('/auth/me')]);
      setSlug(me.user.tenant?.slug ?? ''); setOrigin(window.location.origin);
      for (const kind of ['LOGO', 'COVER'] as const) if (settings.storeImages?.[kind]) api<{ dataUrl: string }>(`/settings/store-image/${kind}`).then(result => setImages(current => ({ ...current, [kind]: result.dataUrl }))).catch(e => setMessage({ text: errorMessage(e, 'Erro ao carregar as imagens da loja'), ok: false }));
    } catch (e) { setMessage({ text: errorMessage(e, 'Erro ao carregar o perfil da loja'), ok: false }); }
  });
  const storeUrl = slug && origin ? `${origin}/loja/${slug}` : '';
  async function copyStoreUrl() {
    try { await navigator.clipboard.writeText(storeUrl); setMessage({ text: 'Link da loja copiado.', ok: true }); }
    catch { setMessage({ text: 'Não foi possível copiar automaticamente. Selecione o link e copie manualmente.', ok: false }); }
  }
  async function choose(kind: StoreImageKind, file: File | undefined) {
    if (!file) return;
    setBusy(kind); setMessage(null);
    try { const dataUrl = await fileToDataUrl(file, kind === 'COVER' ? 1200 : 400); await api(`/settings/store-image/${kind}`, { method: 'PUT', body: JSON.stringify({ dataUrl }) }); setImages(current => ({ ...current, [kind]: dataUrl })); setMessage({ text: kind === 'LOGO' ? 'Logo atualizado.' : 'Capa atualizada.', ok: true }); }
    catch (e) { setMessage({ text: errorMessage(e, 'Erro ao enviar a imagem'), ok: false }); } finally { setBusy(null); }
  }
  async function remove(kind: StoreImageKind) {
    setBusy(kind); setMessage(null);
    try { await api(`/settings/store-image/${kind}`, { method: 'DELETE' }); setImages(current => ({ ...current, [kind]: undefined })); setMessage({ text: 'Imagem removida.', ok: true }); }
    catch (e) { setMessage({ text: errorMessage(e, 'Erro ao remover a imagem'), ok: false }); } finally { setBusy(null); }
  }
  const slot = (kind: StoreImageKind, title: string, hint: string, shape: string) => <div>
    <p className="mb-2 text-sm font-medium text-slate-700">{title}</p>
    <div className={`flex items-center justify-center overflow-hidden border border-dashed border-slate-300 bg-slate-50 text-xs text-slate-400 ${shape}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- local preview of a data URL */}
      {images[kind] ? <img src={images[kind]} alt={title} className="h-full w-full object-cover" /> : 'Sem imagem'}
    </div>
    <div className="mt-2 flex flex-wrap gap-2">
      <label className={`${secondaryButtonClass} cursor-pointer`}>{busy === kind ? 'Enviando...' : images[kind] ? 'Trocar' : 'Escolher imagem'}<input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" disabled={disabled || busy !== null} onChange={event => { void choose(kind, event.target.files?.[0]); event.target.value = ''; }} /></label>
      {images[kind] && <button type="button" className={secondaryButtonClass} disabled={disabled || busy !== null} onClick={() => void remove(kind)}>Remover</button>}
    </div>
    <p className="mt-1 text-xs text-slate-500">{hint}</p>
  </div>;
  return <div>
    <Subtitle>Link público da loja</Subtitle>
    {storeUrl ? <div className="flex flex-wrap items-end gap-2">
      <label className="min-w-64 flex-1 text-sm font-medium text-slate-700">Endereço para compartilhar
        <input readOnly value={storeUrl} onFocus={event => event.currentTarget.select()} className={`${inputClass} font-mono`} />
      </label>
      <button type="button" className={secondaryButtonClass} onClick={() => void copyStoreUrl()}>📋 Copiar link</button>
      <a className={secondaryButtonClass} href={storeUrl} target="_blank" rel="noreferrer">↗ Abrir loja</a>
    </div> : <p className="text-sm text-slate-500">Carregando o endereço público da loja…</p>}
    <Subtitle>Perfil da loja</Subtitle>
    <div className="grid gap-6 md:grid-cols-[10rem_1fr]">
      {slot('LOGO', 'Foto de perfil (logo)', 'Quadrada, aparece ao lado do nome.', 'h-32 w-32 rounded-2xl')}
      {slot('COVER', 'Capa', 'Horizontal (ex.: 1200×400), aparece no topo da loja.', 'h-32 w-full rounded-2xl')}
    </div>
    {message && <p role="status" className={`mt-2 text-sm ${message.ok ? 'text-emerald-700' : 'text-red-700'}`}>{message.text}</p>}
    {storeUrl && <p className="mt-3 text-xs text-slate-500">As imagens aparecem na <Link className="font-semibold text-brand-700 underline" href={`/loja/${slug}`} target="_blank">loja virtual</Link>.</p>}
  </div>;
}

export function StoreSection({ value, onChange, disabled }: SectionProps<'store'>) {
  return <div>
    <Subtitle>Aparência</Subtitle>
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-sm font-medium text-slate-700">Cor da loja<input type="color" value={value.brandColor} disabled={disabled} onChange={event => onChange({ brandColor: event.target.value })} className="mt-1 block h-11 w-20 cursor-pointer rounded-xl border border-slate-300 bg-white p-1" /></label>
      <label className="text-sm font-medium text-slate-700">Código da cor<input value={value.brandColor} disabled={disabled} maxLength={7} onChange={event => onChange({ brandColor: event.target.value })} className={`${inputClass} w-32 font-mono`} aria-invalid={!/^#[0-9a-fA-F]{6}$/.test(value.brandColor)} /></label>
      <span aria-hidden="true" className="mb-1 inline-block h-9 w-24 rounded-xl border border-slate-200" style={{ backgroundColor: /^#[0-9a-fA-F]{6}$/.test(value.brandColor) ? value.brandColor : '#ffffff' }} />
    </div>
    <StoreProfileControl disabled={disabled} />
    <Subtitle>Rastreamento</Subtitle>
    <label className="block max-w-sm text-sm font-medium text-slate-700">ID do Pixel da Meta (Facebook/Instagram)
      <input inputMode="numeric" value={value.metaPixelId} disabled={disabled} maxLength={20} placeholder="Ex.: 123456789012345" onChange={event => onChange({ metaPixelId: event.target.value.replace(/\D/g, '') })} className={`${inputClass} font-mono`} aria-invalid={!/^(\d{8,20})?$/.test(value.metaPixelId)} />
      <span className="mt-1 block text-xs font-normal text-slate-500">Opcional. Quando preenchido, a loja virtual registra visitas e pedidos concluídos no seu Pixel. Deixe vazio para não rastrear.</span>
    </label>
    <Subtitle>Comportamento</Subtitle>
    <Select label="Tipo de loja" value={value.mode} disabled={disabled} onChange={event => onChange({ mode: event.target.value as typeof value.mode })}><option value="MENU">Cardápio digital</option><option value="ECOMMERCE">Loja virtual (e-commerce)</option></Select>
    <div className="mt-3"><Stack>
      <Toggle label="Permitir pedidos com a loja fechada" hint="O cliente pode comprar fora do horário (útil junto do agendamento)." checked={value.allowBuyWhenClosed} disabled={disabled} onChange={allowBuyWhenClosed => onChange({ allowBuyWhenClosed })} />
      <Toggle label="Aceitar pedidos automaticamente" hint="Desligado: cada pedido online aguarda aceite manual." checked={value.autoAccept} disabled={disabled} onChange={autoAccept => onChange({ autoAccept })} />
      <Toggle label="Controle de venda para menores" hint="Registra que a loja vende itens restritos a maiores de idade." checked={value.minorControl} disabled={disabled} onChange={minorControl => onChange({ minorControl })} />
    </Stack></div>
  </div>;
}

export function ProductsSection({ value, onChange, disabled }: SectionProps<'products'>) {
  const [cost, setCost] = useState(10);
  const simulation = marginSimulation(cost, value.defaultMarginPercent);
  return <div>
    <NumberField label="Margem de lucro padrão (%)" value={value.defaultMarginPercent} max={1000} step={0.5} hint="Referência para sugerir preços a partir do custo do produto." disabled={disabled} onChange={defaultMarginPercent => onChange({ defaultMarginPercent })} />
    <Subtitle>Simulação</Subtitle>
    <div className="grid items-end gap-4 sm:grid-cols-3">
      <NumberField label="Custo do produto (R$)" value={cost} step={0.5} max={99999} onChange={setCost} />
      <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm"><p className="text-xs text-slate-500">Preço sugerido</p><p className="text-lg font-bold text-slate-900">{formatMoney(simulation.price)}</p></div>
      <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm"><p className="text-xs text-slate-500">Lucro por unidade</p><p className="text-lg font-bold text-emerald-700">{formatMoney(simulation.profit)}</p></div>
    </div>
  </div>;
}

// Saves on its own (not with the section draft): the counter lives outside the settings JSON and is changed by a dedicated endpoint.
function OrderCounterControl({ disabled }: { disabled: boolean }) {
  const [current, setCurrent] = useState<number | null>(null); const [text, setText] = useState('');
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  useAutoLoad(async () => { try { const result = await api<{ orderCounter: number }>('/settings'); setCurrent(result.orderCounter); setText(String(result.orderCounter + 1)); } catch (e) { setMessage({ text: errorMessage(e, 'Erro ao carregar o contador de pedidos'), ok: false }); } });
  async function save() {
    const wanted = Number(text);
    if (!Number.isInteger(wanted) || wanted < 1 || wanted > 1_000_000) { setMessage({ text: 'Informe um número inteiro entre 1 e 1.000.000.', ok: false }); return; }
    if (!window.confirm(`O próximo pedido será o número ${wanted}. Continuar?`)) return;
    setBusy(true); setMessage(null);
    try { const result = await api<{ orderCounter: number }>('/settings/order-counter', { method: 'PUT', body: JSON.stringify({ current: wanted - 1 }) }); setCurrent(result.orderCounter); setMessage({ text: `Pronto: o próximo pedido será o ${result.orderCounter + 1}.`, ok: true }); }
    catch (e) { setMessage({ text: errorMessage(e, 'Erro ao salvar o contador'), ok: false }); } finally { setBusy(false); }
  }
  return <div className="mt-6 max-w-md">
    <Subtitle>Número atual do pedido</Subtitle>
    <p className="mb-2 text-sm text-slate-600">{current === null ? 'Carregando…' : `Último número emitido: ${current}.`} Defina abaixo o número do <strong>próximo</strong> pedido.</p>
    <div className="flex items-end gap-3">
      <label className="block flex-1 text-sm font-medium text-slate-700">Próximo número<input type="number" min={1} max={1000000} value={text} disabled={disabled || busy || current === null} onChange={event => setText(event.target.value)} className={inputClass} /></label>
      <button type="button" className={buttonClass} disabled={disabled || busy || current === null} onClick={() => void save()}>{busy ? 'Salvando...' : 'Aplicar'}</button>
    </div>
    {message && <p role="status" className={`mt-2 text-sm ${message.ok ? 'text-emerald-700' : 'text-red-700'}`}>{message.text}</p>}
  </div>;
}

export function OrdersSection({ value, onChange, disabled }: SectionProps<'orders'>) {
  return <div>
    <Toggle label="Reiniciar a numeração dos pedidos todo dia" hint="A senha/número do pedido volta para 1 na primeira venda de cada dia. Desligado: a contagem segue sem parar." checked={value.resetCounterDaily} disabled={disabled} onChange={resetCounterDaily => onChange({ resetCounterDaily })} />
    <OrderCounterControl disabled={disabled} />
  </div>;
}

export function OrderStatusesSection({ value, onChange, disabled }: SectionProps<'orderStatuses'>) {
  const update = (key: string, change: Partial<(typeof value.items)[number]>) => onChange({ items: value.items.map(item => item.key === key ? { ...item, ...change } : item) });
  return <div>
    <p className="mb-4 text-sm text-slate-600">Ative as etapas que aparecem no acompanhamento e personalize os títulos. Status inativos não aparecem para o cliente; a chave interna e o fluxo operacional permanecem inalterados.</p>
    <DataTable columns={[{ label: 'Ativo', className: 'w-48' }, { label: 'Título exibido' }, { label: 'Chave interna', className: 'w-56' }]} footer={`${value.items.filter(item => item.active).length} de ${value.items.length} ativos`}>
      {value.items.map(item => <tr key={item.key}>
        <td><Toggle label={item.active ? 'Ativo' : 'Inativo'} checked={item.active} disabled={disabled} onChange={active => update(item.key, { active })} /></td>
        <td><label className="sr-only" htmlFor={`status-${item.key}`}>Título do status {item.key}</label><input id={`status-${item.key}`} value={item.title} maxLength={40} disabled={disabled} onChange={event => update(item.key, { title: event.target.value })} className={`${inputClass} mt-0`} aria-invalid={!item.title.trim()} /></td>
        <td><Badge>{item.key}</Badge></td>
      </tr>)}
    </DataTable>
  </div>;
}

export type AdminPasswordControls = { hasPassword: boolean; canManage: boolean; busy: boolean; onSet: (password: string | null) => Promise<boolean> };

export function PdvSection({ value, onChange, disabled, password, orderStatuses }: SectionProps<'pdv'> & { password: AdminPasswordControls; orderStatuses: TenantSettings['orderStatuses'] }) {
  const [next, setNext] = useState(''); const [visible, setVisible] = useState(false);
  async function submit(newValue: string | null) { if (await password.onSet(newValue)) setNext(''); }
  return <div>
    <Subtitle>Terminal de vendas</Subtitle>
    <Grid>
      <Select label="Layout do PDV" value={value.layout} disabled={disabled} onChange={event => onChange({ layout: event.target.value as typeof value.layout })}><option value="FOOD">Alimentação (restaurante, lanchonete)</option><option value="RETAIL">Varejo (mercado, loja)</option></Select>
      <Select label="Lado da lista de itens" value={value.side} disabled={disabled} onChange={event => onChange({ side: event.target.value as typeof value.side })}><option value="RIGHT">Direita</option><option value="LEFT">Esquerda</option></Select>
      <Select label="Controle de mesas e comandas" value={value.tableControl} disabled={disabled} onChange={event => onChange({ tableControl: event.target.value as typeof value.tableControl })}>
        <option value="TABLES">Somente mesas</option><option value="TABS">Somente comandas</option><option value="TABLES_AND_TABS">Mesas e comandas</option><option value="TABLES_AND_ORDERS">Mesas e pedidos</option>
      </Select>
      <Select label="Status padrão dos pedidos do PDV" value={value.defaultOrderStatus} disabled={disabled} onChange={event => onChange({ defaultOrderStatus: event.target.value as typeof value.defaultOrderStatus })}>
        {(['OPEN', 'PREPARING'] as const).map(status => {
          const label = orderStatuses.items.find(item => item.key === (status === 'OPEN' ? 'ACCEPTED' : 'PREPARING'))?.title ?? (status === 'OPEN' ? 'Aceito' : 'Em preparo');
          return <option key={status} value={status}>{label}</option>;
        })}
      </Select>
      <Field label="Nome da taxa de serviço" value={value.serviceFeeName} maxLength={40} disabled={disabled} onChange={event => onChange({ serviceFeeName: event.target.value })} />
    </Grid>
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <Toggle label="Modo pedido" checked={value.orderMode} disabled={disabled} onChange={orderMode => onChange({ orderMode })} />
      <Toggle label="Modo venda" checked={value.saleMode} disabled={disabled} onChange={saleMode => onChange({ saleMode })} />
      <Toggle label="Avisar cliente por WhatsApp" checked={value.whatsappNotify} disabled={disabled} onChange={whatsappNotify => onChange({ whatsappNotify })} />
      <Toggle label="Cadastrar cliente automaticamente" checked={value.autoRegisterCustomer} disabled={disabled} onChange={autoRegisterCustomer => onChange({ autoRegisterCustomer })} />
      <Toggle label="Perguntar o vendedor" checked={value.askSeller} disabled={disabled} onChange={askSeller => onChange({ askSeller })} />
      <Toggle label="Exigir senha de administrador em pedidos online" checked={value.requireAdminPasswordOnline} disabled={disabled} onChange={requireAdminPasswordOnline => onChange({ requireAdminPasswordOnline })} />
      <Toggle label="Mostrar PIX no terminal" hint="Depende de um provedor PIX configurado em Integrações." checked={value.showPixOnTerminal} disabled={disabled} onChange={showPixOnTerminal => onChange({ showPixOnTerminal })} />
    </div>
    <Subtitle>Controle de moedas estrangeiras</Subtitle>
    <Grid>
      <NumberField label="Cotação do dólar (R$ por US$)" value={value.usdRate} step={0.01} max={1000} disabled={disabled} onChange={usdRate => onChange({ usdRate })} />
      <NumberField label="Cotação do peso (pesos por R$ 1)" value={value.pesoRate} step={0.01} max={1000000} disabled={disabled} onChange={pesoRate => onChange({ pesoRate })} />
    </Grid>
    <p className="mt-2 text-xs text-slate-500">Quando preenchidas, o PDV mostra o total também nessas moedas como referência para o atendente. Os pedidos continuam sempre em reais; use 0 para desativar.</p>
    <p className="mt-3 text-sm text-slate-500">O percentual da taxa de serviço é configurado por unidade em <Link href="/units" className="font-semibold text-brand-700 hover:underline">Unidades</Link>. Pedidos agendados sempre aguardam em “Aceito” até a liberação.</p>
    <Subtitle>Senha de administrador do caixa</Subtitle>
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <p className="mb-3 text-sm text-slate-600">Usada nas <Link href="/releases" className="font-semibold text-brand-700 hover:underline">liberações por senha</Link> (cancelamentos, descontos, sangria…). Só é guardada criptografada e não pode ser consultada depois. Estado atual: <Badge tone={password.hasPassword ? 'green' : 'amber'}>{password.hasPassword ? 'Configurada' : 'Não configurada'}</Badge></p>
      {password.canManage ? <>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm font-medium text-slate-700">{password.hasPassword ? 'Nova senha' : 'Senha'} (4 a 60 caracteres)
            <input type={visible ? 'text' : 'password'} autoComplete="new-password" value={next} minLength={4} maxLength={60} onChange={event => setNext(event.target.value)} className={`${inputClass} w-64 font-mono`} />
          </label>
          <button type="button" onClick={() => { setNext(suggestPassword()); setVisible(true); }} className={secondaryButtonClass}>Gerar outra</button>
          <button type="button" onClick={() => setVisible(current => !current)} className={secondaryButtonClass} aria-pressed={visible}>{visible ? 'Ocultar' : 'Mostrar'}</button>
          <button type="button" disabled={password.busy || next.length < 4} onClick={() => void submit(next)} className={buttonClass}>{password.hasPassword ? 'Alterar senha' : 'Definir senha'}</button>
          {password.hasPassword && <button type="button" disabled={password.busy} onClick={() => { if (window.confirm('Remover a senha de administrador? As liberações por senha deixarão de funcionar.')) void submit(null); }} className={dangerButtonClass}>Remover senha</button>}
        </div>
        <p className="mt-2 text-xs text-slate-500">Anote a senha gerada antes de salvar: ela não será exibida novamente.</p>
      </> : <p className="text-sm text-slate-500">Somente administradores podem definir ou remover esta senha.</p>}
    </div>
  </div>;
}

export function ScaleSection({ value, onChange, disabled }: SectionProps<'scale'>) {
  const [code, setCode] = useState(123); const [amount, setAmount] = useState(1.25);
  const valueLength = value.barcodeLength - value.prefix.length - value.codeLength - 1;
  const example = scaleBarcodeExample(value, code, amount);
  const isWeight = value.saleType === 'WEIGHT';
  return <div>
    <Toggle label="Habilitar leitura de etiquetas de balança" hint="Reconhece códigos de barras gerados por balanças etiquetadoras e lança peso ou preço. O sistema não se conecta à balança física." checked={value.enabled} disabled={disabled} onChange={enabled => onChange({ enabled })} />
    <Subtitle>Formato do código de barras</Subtitle>
    <Grid>
      <Field label="Prefixo (1 a 2 dígitos)" value={value.prefix} inputMode="numeric" maxLength={2} disabled={disabled} onChange={event => onChange({ prefix: event.target.value.replace(/\D/g, '') })} />
      <NumberField label="Dígitos do código do produto" value={value.codeLength} min={3} max={7} disabled={disabled} onChange={codeLength => onChange({ codeLength })} />
      <NumberField label="Tamanho do código de barras" value={value.barcodeLength} min={12} max={14} hint="EAN-13 usa 13." disabled={disabled} onChange={barcodeLength => onChange({ barcodeLength })} />
      <Select label="Tipo de venda" value={value.saleType} disabled={disabled} onChange={event => onChange({ saleType: event.target.value as typeof value.saleType })}><option value="WEIGHT">Peso (kg)</option><option value="PRICE">Preço (R$)</option></Select>
    </Grid>
    {valueLength < 1 && <p role="alert" className="mt-3 text-sm text-red-700">O formato não deixa espaço para o peso/preço: aumente o tamanho do código ou reduza prefixo/código.</p>}
    <Subtitle>Exemplo ao vivo</Subtitle>
    <div className="grid gap-4 sm:grid-cols-2">
      <NumberField label="Código do produto na balança" value={code} min={0} onChange={setCode} />
      <NumberField label={isWeight ? 'Peso (kg)' : 'Preço (R$)'} value={amount} step={isWeight ? 0.005 : 0.01} onChange={setAmount} />
    </div>
    <div className="mt-3 rounded-xl bg-neutral-950 p-4 font-mono text-lg tracking-widest text-white" aria-live="polite">
      {example ? <><span className="text-brand-300">{example.prefix}</span><span>{example.code}</span><span className="text-emerald-300">{example.amount}</span><span className="text-slate-400">{example.check}</span>
        <p className="mt-2 font-sans text-xs tracking-normal text-slate-400">prefixo · código do produto · {isWeight ? 'peso em gramas' : 'preço em centavos'} · dígito verificador</p></>
        : <span className="font-sans text-sm tracking-normal text-red-300">Valores não cabem no formato escolhido.</span>}
    </div>
    <p className="mt-3 text-sm text-slate-500">Para enviar a lista de produtos à balança use <Link href="/scale-file" className="font-semibold text-brand-700 hover:underline">Arquivo para balança</Link>.</p>
  </div>;
}

export function PrintingSection({ value, onChange, disabled }: SectionProps<'printing'>) {
  return <div>
    <Subtitle>Perguntar antes de imprimir</Subtitle>
    <Grid>
      <Toggle label="Venda" checked={value.askPrintSale} disabled={disabled} onChange={askPrintSale => onChange({ askPrintSale })} />
      <Toggle label="Pedido" checked={value.askPrintOrder} disabled={disabled} onChange={askPrintOrder => onChange({ askPrintOrder })} />
      <Toggle label="Ticket de retirada" checked={value.askPrintTicket} disabled={disabled} onChange={askPrintTicket => onChange({ askPrintTicket })} />
    </Grid>
    <Subtitle>Cabeçalho com dados da empresa</Subtitle>
    <Grid>
      <Toggle label="Nos comprovantes" checked={value.companyHeader} disabled={disabled} onChange={companyHeader => onChange({ companyHeader })} />
      <Toggle label="Nas impressões de produção" checked={value.companyHeaderOnProduction} disabled={disabled} onChange={companyHeaderOnProduction => onChange({ companyHeaderOnProduction })} />
      <Toggle label="Nos relatórios" checked={value.companyHeaderOnReports} disabled={disabled} onChange={companyHeaderOnReports => onChange({ companyHeaderOnReports })} />
    </Grid>
    <Subtitle>Papel e fonte</Subtitle>
    <Grid>
      <Select label="Largura do papel" value={value.paper} disabled={disabled} onChange={event => onChange({ paper: event.target.value as typeof value.paper })}><option value="55mm">Bobina 55 mm</option><option value="58mm">Bobina 58 mm</option><option value="80mm">Bobina 80 mm</option><option value="A4">A4</option></Select>
      <NumberField label="Tamanho da fonte (1 a 20)" value={value.fontSize} min={1} max={20} disabled={disabled} onChange={fontSize => onChange({ fontSize })} />
      <Select label="Papel da promissória" value={value.promissoryPaper} disabled={disabled} onChange={event => onChange({ promissoryPaper: event.target.value as typeof value.promissoryPaper })}><option value="A4">A4</option><option value="80mm">Bobina 80 mm</option></Select>
      <Toggle label="Imprimir promissória automaticamente" checked={value.autoPrintPromissory} disabled={disabled} onChange={autoPrintPromissory => onChange({ autoPrintPromissory })} />
    </Grid>
    <Subtitle>Recibos e comprovantes</Subtitle>
    <Grid>
      <NumberField label="Vias do recibo de venda (1 a 3)" value={value.receiptCopies} min={1} max={3} disabled={disabled} onChange={receiptCopies => onChange({ receiptCopies })} />
      <Select label="Vias do comprovante TEF" value={value.tefCopies} disabled={disabled} onChange={event => onChange({ tefCopies: event.target.value as typeof value.tefCopies })}><option value="BOTH">Cliente e estabelecimento</option><option value="CUSTOMER">Somente cliente</option></Select>
      <Field label="Rodapé dos comprovantes" value={value.footer} maxLength={200} disabled={disabled} onChange={event => onChange({ footer: event.target.value })} />
    </Grid>
    <p className="mt-4 text-sm text-slate-500">Impressoras e agentes: <Link href="/production" className="font-semibold text-brand-700 hover:underline">Setores e impressão</Link> · instalação do agente em <Link href="/downloads" className="font-semibold text-brand-700 hover:underline">Downloads</Link>.</p>
  </div>;
}

export function TicketSection({ value, onChange, disabled }: SectionProps<'ticket'>) {
  return <Toggle label="Ticket de retirada" hint="Permite imprimir no PDV e no quadro de pedidos o ticket dos produtos que tenham esta opção habilitada no cadastro. A impressão usa a impressora selecionada no navegador." checked={value.enabled} disabled={disabled} onChange={enabled => onChange({ enabled })} />;
}

export function FinancialSection({ value, onChange, disabled }: SectionProps<'financial'>) {
  const pct = (key: keyof TenantSettings['financial'], label: string, hint?: string, extra: { max?: number; step?: number } = {}) => <NumberField label={label} value={value[key]} hint={hint} max={extra.max ?? 100} step={extra.step ?? 0.1} disabled={disabled} onChange={next => onChange({ [key]: next })} />;
  return <div>
    <Subtitle>Contas em atraso</Subtitle>
    <Grid>{pct('monthlyInterestPercent', 'Juros ao mês (%)')}{pct('latePenaltyPercent', 'Multa por atraso (%)')}{pct('graceDays', 'Carência (dias)', 'Dias sem cobrança após o vencimento.', { max: 365, step: 1 })}</Grid>
    <Subtitle>Antecipação</Subtitle>
    <Grid>{pct('earlyDiscountPercent', 'Desconto por antecipação (%)')}{pct('earlyMinDays', 'Antecedência mínima (dias)', undefined, { max: 365, step: 1 })}</Grid>
    <Subtitle>Parcelamento</Subtitle>
    <Grid>{pct('installmentDays', 'Intervalo entre parcelas (dias)', undefined, { max: 365, step: 1 })}</Grid>
    <p className="mt-4 text-xs text-slate-500">Preferências do módulo financeiro; lançamentos já existentes não são alterados.</p>
  </div>;
}
