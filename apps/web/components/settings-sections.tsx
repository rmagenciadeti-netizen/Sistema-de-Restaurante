'use client';

import Link from 'next/link';
import { useRef, useState, type ReactNode } from 'react';
import { alwaysVisibleHrefs, menuCatalog } from '../lib/menu-catalog';
import { type TenantSettings } from '../lib/settings';
import { marginSimulation, parseMenuLayout, scaleBarcodeExample, serializeMenuLayout, suggestPassword } from '../lib/settings-helpers';
import { formatMoney } from '../lib/api';
import { Field, inputClass, buttonClass, secondaryButtonClass, Select } from './app-shell';
import { Badge, dangerButtonClass, Toggle } from './ui';
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

export function CompanySection({ value, onChange, disabled }: SectionProps<'company'>) {
  const text = (key: keyof TenantSettings['company'], label: string, extra: { maxLength?: number; placeholder?: string } = {}) => <Field label={label} value={value[key]} disabled={disabled} onChange={event => onChange({ [key]: event.target.value })} {...extra} />;
  return <div>
    <Subtitle>Dados da empresa</Subtitle>
    <Grid>{text('tradeName', 'Nome fantasia', { maxLength: 160 })}{text('legalName', 'Razão social', { maxLength: 160 })}{text('document', 'CNPJ/CPF', { maxLength: 20 })}{text('activity', 'Ramo de atividade', { maxLength: 80, placeholder: 'Ex.: Restaurante' })}</Grid>
    <div className="mt-4">{text('slogan', 'Slogan / frase de destaque', { maxLength: 120 })}</div>
    <Subtitle>Contato</Subtitle>
    <Grid>{text('phone', 'Telefone', { maxLength: 30 })}{text('whatsapp', 'WhatsApp', { maxLength: 30 })}</Grid>
    <Subtitle>Endereço</Subtitle>
    <Grid>{text('zip', 'CEP', { maxLength: 10 })}{text('state', 'UF', { maxLength: 2 })}{text('city', 'Cidade', { maxLength: 80 })}{text('district', 'Bairro', { maxLength: 80 })}{text('address', 'Rua / logradouro', { maxLength: 160 })}{text('number', 'Número', { maxLength: 10 })}</Grid>
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

export function StoreSection({ value, onChange, disabled }: SectionProps<'store'>) {
  return <div>
    <Subtitle>Aparência</Subtitle>
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-sm font-medium text-slate-700">Cor da loja<input type="color" value={value.brandColor} disabled={disabled} onChange={event => onChange({ brandColor: event.target.value })} className="mt-1 block h-11 w-20 cursor-pointer rounded-xl border border-slate-300 bg-white p-1" /></label>
      <label className="text-sm font-medium text-slate-700">Código da cor<input value={value.brandColor} disabled={disabled} maxLength={7} onChange={event => onChange({ brandColor: event.target.value })} className={`${inputClass} w-32 font-mono`} aria-invalid={!/^#[0-9a-fA-F]{6}$/.test(value.brandColor)} /></label>
      <span aria-hidden="true" className="mb-1 inline-block h-9 w-24 rounded-xl border border-slate-200" style={{ backgroundColor: /^#[0-9a-fA-F]{6}$/.test(value.brandColor) ? value.brandColor : '#ffffff' }} />
    </div>
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

export function OrdersSection({ value, onChange, disabled }: SectionProps<'orders'>) {
  return <div>
    <Toggle label="Reiniciar a numeração dos pedidos todo dia" hint="A senha/número do pedido volta para 1 na primeira venda de cada dia. Desligado: a contagem segue sem parar." checked={value.resetCounterDaily} disabled={disabled} onChange={resetCounterDaily => onChange({ resetCounterDaily })} />
    <p className="mt-3 text-xs text-slate-500">O número atual do contador não é exibido nesta versão; ele aparece em cada pedido.</p>
  </div>;
}

export type AdminPasswordControls = { hasPassword: boolean; canManage: boolean; busy: boolean; onSet: (password: string | null) => Promise<boolean> };

export function PdvSection({ value, onChange, disabled, password }: SectionProps<'pdv'> & { password: AdminPasswordControls }) {
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
      <Select label="Largura do papel" value={value.paper} disabled={disabled} onChange={event => onChange({ paper: event.target.value as typeof value.paper })}><option value="58mm">Bobina 58 mm</option><option value="80mm">Bobina 80 mm</option><option value="A4">A4</option></Select>
      <NumberField label="Tamanho da fonte (1 a 20)" value={value.fontSize} min={1} max={20} disabled={disabled} onChange={fontSize => onChange({ fontSize })} />
      <Select label="Papel da promissória" value={value.promissoryPaper} disabled={disabled} onChange={event => onChange({ promissoryPaper: event.target.value as typeof value.promissoryPaper })}><option value="A4">A4</option><option value="80mm">Bobina 80 mm</option></Select>
      <Toggle label="Imprimir promissória automaticamente" checked={value.autoPrintPromissory} disabled={disabled} onChange={autoPrintPromissory => onChange({ autoPrintPromissory })} />
    </Grid>
    <p className="mt-4 text-sm text-slate-500">Impressoras e agentes: <Link href="/production" className="font-semibold text-brand-700 hover:underline">Setores e impressão</Link> · instalação do agente em <Link href="/downloads" className="font-semibold text-brand-700 hover:underline">Downloads</Link>.</p>
  </div>;
}

export function TicketSection({ value, onChange, disabled }: SectionProps<'ticket'>) {
  return <Toggle label="Ticket de retirada" hint="Habilita o ticket/senha para o cliente retirar o pedido. A impressão depende de um agente e impressora configurados." checked={value.enabled} disabled={disabled} onChange={enabled => onChange({ enabled })} />;
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
