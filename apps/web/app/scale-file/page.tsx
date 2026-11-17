'use client';

import { useState } from 'react';
import Link from 'next/link';
import { API_BASE, api, errorMessage, formatMoney, ListResponse, tokenStorageKey } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { SCALE_BRAND_OPTIONS, type ScaleBrandValue, type ScaleProduct } from '../../lib/types-catalog';
import { AppShell, buttonClass, Notice, panelClass, Select } from '../../components/app-shell';
import { Badge, DataTable, EmptyState, PageHeader } from '../../components/ui';

export default function ScaleFilePage() {
  const [brand, setBrand] = useState<ScaleBrandValue>('TOLEDO');
  const [items, setItems] = useState<ScaleProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);

  useAutoLoad(async () => {
    try { setItems((await api<ListResponse<ScaleProduct>>('/scale/products')).items); }
    catch (e) { setNotice({ text: errorMessage(e, 'Erro ao carregar os produtos da balança'), kind: 'error' }); }
    finally { setLoading(false); }
  });

  async function generate() {
    setNotice(null); setGenerating(true);
    try {
      const token = localStorage.getItem(tokenStorageKey);
      const response = await fetch(`${API_BASE}/scale/export?brand=${brand}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({} as { message?: string }));
        throw new Error(payload.message ?? 'Não foi possível gerar o arquivo');
      }
      const blob = await response.blob();
      const fileName = /filename="?([^";]+)"?/i.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ?? 'balanca.txt';
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = fileName;
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
      setNotice({ text: `Arquivo ${fileName} gerado com ${items.length} produto(s).`, kind: 'success' });
    } catch (e) { setNotice({ text: errorMessage(e, 'Não foi possível gerar o arquivo'), kind: 'error' }); }
    finally { setGenerating(false); }
  }

  return <AppShell title="Arquivo para balança">
    <PageHeader title="Arquivo para balança" subtitle="Gera o arquivo de itens (.txt) com os produtos marcados como “Enviar para balança”, para importar na balança de etiquetas."
      actions={<Link href="/products" className="text-sm font-semibold text-brand-700 hover:text-brand-600">Cadastrar produtos ›</Link>} />
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <div role="note" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <strong>Valide o layout antes de usar.</strong> Os arquivos seguem formatos de itens comumente documentados, mas cada modelo e firmware de balança pode exigir ajustes.
      Teste a importação com poucos itens no seu equipamento. O sistema não se comunica diretamente com a balança: o arquivo é gerado aqui e importado por você.
    </div>
    <section className={`${panelClass} mb-4`}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-64"><Select label="Marca da balança" value={brand} onChange={event => setBrand(event.target.value as ScaleBrandValue)}>{SCALE_BRAND_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></div>
        <button type="button" className={buttonClass} disabled={generating || items.length === 0} onClick={() => void generate()}>{generating ? 'Gerando...' : 'Gerar arquivo'}</button>
      </div>
      <p className="mt-3 text-xs text-slate-500">Somente produtos ativos com código de balança entram no arquivo. Os preços e nomes são os do cadastro atual.</p>
    </section>
    {loading ? <p className="p-4 text-sm text-slate-500">Carregando...</p>
      : items.length === 0 ? <EmptyState icon="⚖️" title="Nenhum produto será enviado" hint="Marque “Enviar para balança” e informe o código da balança na aba Balança do cadastro de produto." action={<Link href="/products" className={buttonClass}>Ir para produtos</Link>} />
        : <DataTable columns={[{ label: 'Código' }, { label: 'Produto' }, { label: 'Tipo' }, { label: 'Preço' }, { label: 'Depto.' }, { label: 'Validade' }]} footer={`${items.length} produto(s) no arquivo`}>
          {items.map(item => <tr key={item.id}>
            <td className="font-mono">{item.scaleCode}</td><td className="font-semibold">{item.name}</td>
            <td>{item.soldByWeight ? <Badge tone="blue">Peso (kg)</Badge> : <Badge>Unidade</Badge>}</td>
            <td>{formatMoney(item.price)}{item.soldByWeight ? '/kg' : ''}</td><td>{item.scaleDepartment ?? '—'}</td><td>{item.shelfLifeDays == null ? '—' : `${item.shelfLifeDays} dia(s)`}</td>
          </tr>)}
        </DataTable>}
  </AppShell>;
}
