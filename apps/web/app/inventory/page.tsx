'use client';

import { FormEvent, useEffect, useState } from 'react';
import { ApiError, api, ListResponse, Product } from '../../lib/api';
import { AppShell, buttonClass, Field, Notice, panelClass } from '../../components/app-shell';

type Ingredient = {
  id: string;
  name: string;
  unitOfMeasure: string;
  currentStock: number | string;
  minimumStock?: number | string | null;
  unitId?: string | null;
};

type Movement = {
  id: string;
  type: string;
  quantity: number | string;
  note?: string | null;
  createdAt: string;
  ingredient: Ingredient;
};

type RecipeLine = { ingredientId: string; quantity: string };
type Message = { text: string; kind: 'error' | 'success' };

const movementTypes = [
  { value: 'PURCHASE', label: 'Entrada / compra' },
  { value: 'ADJUSTMENT', label: 'Ajuste de baixa' },
  { value: 'WASTE', label: 'Perda / descarte' },
  { value: 'TRANSFER_IN', label: 'Transferência recebida' },
  { value: 'TRANSFER_OUT', label: 'Transferência enviada' },
];

export default function InventoryPage() {
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [message, setMessage] = useState<Message | null>(null);
  const [ingredientForm, setIngredientForm] = useState({ name: '', unitOfMeasure: '', minimumStock: '' });
  const [movementForm, setMovementForm] = useState({ ingredientId: '', type: 'PURCHASE', quantity: '', unitCost: '', note: '' });
  const [productId, setProductId] = useState('');
  const [recipeYield, setRecipeYield] = useState('1');
  const [recipeNotes, setRecipeNotes] = useState('');
  const [recipeLines, setRecipeLines] = useState<RecipeLine[]>([]);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [ingredientResult, productResult, movementResult] = await Promise.all([
        api<ListResponse<Ingredient>>('/inventory/ingredients'),
        api<ListResponse<Product>>('/products'),
        api<ListResponse<Movement>>('/inventory/movements'),
      ]);
      setIngredients(ingredientResult.items);
      setProducts(productResult.items.filter(product => product.active));
      setMovements(movementResult.items);
      setMovementForm(current => ({
        ...current,
        ingredientId: current.ingredientId || ingredientResult.items[0]?.id || '',
      }));
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Erro ao carregar estoque', kind: 'error' });
    }
  }

  useEffect(() => {
    let active = true;
    async function initialLoad() {
      try {
        const [ingredientResult, productResult, movementResult] = await Promise.all([
          api<ListResponse<Ingredient>>('/inventory/ingredients'),
          api<ListResponse<Product>>('/products'),
          api<ListResponse<Movement>>('/inventory/movements'),
        ]);
        if (!active) return;
        setIngredients(ingredientResult.items);
        setProducts(productResult.items.filter(product => product.active));
        setMovements(movementResult.items);
        setMovementForm(current => ({
          ...current,
          ingredientId: current.ingredientId || ingredientResult.items[0]?.id || '',
        }));
      } catch (error) {
        if (active) setMessage({ text: error instanceof Error ? error.message : 'Erro ao carregar estoque', kind: 'error' });
      }
    }
    void initialLoad();
    return () => { active = false; };
  }, []);

  async function addIngredient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api('/inventory/ingredients', {
        method: 'POST',
        body: JSON.stringify({
          name: ingredientForm.name,
          unitOfMeasure: ingredientForm.unitOfMeasure,
          minimumStock: ingredientForm.minimumStock ? Number(ingredientForm.minimumStock) : undefined,
        }),
      });
      setIngredientForm({ name: '', unitOfMeasure: '', minimumStock: '' });
      setMessage({ text: 'Ingrediente cadastrado. Registre uma entrada para atualizar o saldo.', kind: 'success' });
      await load();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Erro ao cadastrar ingrediente', kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function recordMovement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api(`/inventory/ingredients/${movementForm.ingredientId}/movements`, {
        method: 'POST',
        body: JSON.stringify({
          type: movementForm.type,
          quantity: Number(movementForm.quantity),
          unitCost: movementForm.unitCost ? Number(movementForm.unitCost) : undefined,
          note: movementForm.note || undefined,
        }),
      });
      setMovementForm(current => ({ ...current, quantity: '', unitCost: '', note: '' }));
      setMessage({ text: 'Movimentação registrada.', kind: 'success' });
      await load();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Erro ao registrar movimentação', kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function selectProduct(nextProductId: string) {
    setProductId(nextProductId);
    setRecipeYield('1');
    setRecipeNotes('');
    setRecipeLines([]);
    if (!nextProductId) return;
    try {
      const recipe = await api<{
        yield: number | string;
        notes?: string | null;
        ingredients: Array<{ ingredientId: string; quantity: number | string }>;
      }>(`/inventory/recipes/${nextProductId}`);
      setRecipeYield(String(recipe.yield));
      setRecipeNotes(recipe.notes ?? '');
      setRecipeLines(recipe.ingredients.map(line => ({ ingredientId: line.ingredientId, quantity: String(line.quantity) })));
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) {
        setMessage({ text: error instanceof Error ? error.message : 'Erro ao carregar ficha técnica', kind: 'error' });
      }
    }
  }

  async function saveRecipe(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!productId || recipeLines.length === 0 || recipeLines.some(line => !line.ingredientId || Number(line.quantity) <= 0)) {
      setMessage({ text: 'Selecione um produto e informe ao menos um ingrediente com quantidade válida.', kind: 'error' });
      return;
    }
    if (recipeLines.some(line => !recipeIngredients.some(ingredient => ingredient.id === line.ingredientId))) {
      setMessage({ text: 'A ficha contém ingrediente de outra unidade. Remova a linha incompatível antes de salvar.', kind: 'error' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await api(`/inventory/recipes/${productId}`, {
        method: 'PUT',
        body: JSON.stringify({
          yield: Number(recipeYield),
          notes: recipeNotes || undefined,
          ingredients: recipeLines.map(line => ({ ingredientId: line.ingredientId, quantity: Number(line.quantity) })),
        }),
      });
      setMessage({ text: 'Ficha técnica salva. O estoque será consumido ao iniciar o preparo do pedido.', kind: 'success' });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Erro ao salvar ficha técnica', kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const selectedProduct = products.find(product => product.id === productId);
  const recipeIngredients = ingredients.filter(ingredient =>
    selectedProduct?.unitId ? ingredient.unitId === null || ingredient.unitId === selectedProduct.unitId : ingredient.unitId == null,
  );

  return <AppShell title="Estoque e fichas técnicas">
    {message && <Notice message={message.text} kind={message.kind} />}

    <div className="grid gap-6 xl:grid-cols-2">
      <section className={panelClass}>
        <h2 className="mb-4 text-lg font-semibold">Novo ingrediente</h2>
        <form onSubmit={addIngredient} className="grid gap-4 md:grid-cols-2">
          <Field label="Ingrediente" required minLength={2} value={ingredientForm.name} onChange={event => setIngredientForm({ ...ingredientForm, name: event.target.value })} />
          <Field label="Unidade (kg, g, L, un.)" required maxLength={20} value={ingredientForm.unitOfMeasure} onChange={event => setIngredientForm({ ...ingredientForm, unitOfMeasure: event.target.value })} />
          <Field label="Estoque mínimo (opcional)" type="number" min="0" step="0.001" value={ingredientForm.minimumStock} onChange={event => setIngredientForm({ ...ingredientForm, minimumStock: event.target.value })} />
          <div className="flex items-end"><button className={buttonClass} disabled={busy}>Cadastrar ingrediente</button></div>
        </form>
      </section>

      <section className={panelClass}>
        <h2 className="mb-4 text-lg font-semibold">Registrar movimentação</h2>
        <form onSubmit={recordMovement} className="grid gap-4 md:grid-cols-2">
          <label className="text-sm text-slate-300">Ingrediente<select className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" required value={movementForm.ingredientId} onChange={event => setMovementForm({ ...movementForm, ingredientId: event.target.value })}><option value="">Selecione</option>{ingredients.map(ingredient => <option key={ingredient.id} value={ingredient.id}>{ingredient.name} ({ingredient.unitOfMeasure})</option>)}</select></label>
          <label className="text-sm text-slate-300">Tipo<select className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" value={movementForm.type} onChange={event => setMovementForm({ ...movementForm, type: event.target.value })}>{movementTypes.map(type => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label>
          <Field label="Quantidade" type="number" min="0.001" step="0.001" required value={movementForm.quantity} onChange={event => setMovementForm({ ...movementForm, quantity: event.target.value })} />
          <Field label="Custo unitário (opcional)" type="number" min="0" step="0.0001" value={movementForm.unitCost} onChange={event => setMovementForm({ ...movementForm, unitCost: event.target.value })} />
          <Field label="Observação (opcional)" maxLength={500} value={movementForm.note} onChange={event => setMovementForm({ ...movementForm, note: event.target.value })} />
          <div className="flex items-end"><button className={buttonClass} disabled={busy || !movementForm.ingredientId}>Registrar movimentação</button></div>
        </form>
      </section>

      <section className={`${panelClass} xl:col-span-2`}>
        <h2 className="mb-4 text-lg font-semibold">Ficha técnica do produto</h2>
        <form onSubmit={saveRecipe} className="grid gap-4">
          <label className="text-sm text-slate-300">Produto<select className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 md:max-w-xl" value={productId} onChange={event => void selectProduct(event.target.value)}><option value="">Selecione um produto</option>{products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Rendimento da receita (porções)" type="number" min="0.001" step="0.001" required value={recipeYield} onChange={event => setRecipeYield(event.target.value)} />
            <Field label="Observações (opcional)" maxLength={1000} value={recipeNotes} onChange={event => setRecipeNotes(event.target.value)} />
          </div>
          {recipeLines.map((line, index) => <div key={index} className="grid items-end gap-3 md:grid-cols-[1fr_1fr_auto]">
            <label className="text-sm text-slate-300">Ingrediente<select className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" required value={line.ingredientId} onChange={event => setRecipeLines(current => current.map((item, i) => i === index ? { ...item, ingredientId: event.target.value } : item))}><option value="">Selecione</option>{recipeIngredients.map(ingredient => <option key={ingredient.id} value={ingredient.id}>{ingredient.name} ({ingredient.unitOfMeasure})</option>)}</select></label>
            <Field label="Quantidade para o rendimento" type="number" min="0.001" step="0.001" required value={line.quantity} onChange={event => setRecipeLines(current => current.map((item, i) => i === index ? { ...item, quantity: event.target.value } : item))} />
            <button type="button" className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800" onClick={() => setRecipeLines(current => current.filter((_, i) => i !== index))}>Remover</button>
          </div>)}
          {recipeLines.some(line => !recipeIngredients.some(ingredient => ingredient.id === line.ingredientId)) && <p className="text-sm text-amber-300">A ficha existente contém ingrediente de outra unidade. Remova essa linha e selecione um ingrediente compatível.</p>}
          <div className="flex flex-wrap gap-3">
            <button type="button" className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800" disabled={recipeIngredients.length === 0} onClick={() => setRecipeLines(current => [...current, { ingredientId: recipeIngredients[0]?.id ?? '', quantity: '0.001' }])}>Adicionar ingrediente</button>
            <button className={buttonClass} disabled={busy || !productId || recipeLines.length === 0}>Salvar ficha técnica</button>
          </div>
          {productId && recipeIngredients.length === 0 && <p className="text-sm text-amber-300">Cadastre um ingrediente compatível com a unidade do produto para criar a ficha.</p>}
        </form>
      </section>

      <section className={`${panelClass} xl:col-span-2`}>
        <h2 className="mb-4 text-lg font-semibold">Saldo atual ({ingredients.length})</h2>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-slate-400"><tr><th className="p-3">Ingrediente</th><th className="p-3">Unidade</th><th className="p-3">Saldo</th><th className="p-3">Mínimo</th></tr></thead><tbody>{ingredients.map(ingredient => <tr key={ingredient.id} className="border-t border-slate-800"><td className="p-3">{ingredient.name}</td><td className="p-3">{ingredient.unitOfMeasure}</td><td className="p-3">{Number(ingredient.currentStock).toFixed(3)}</td><td className="p-3">{ingredient.minimumStock == null ? '—' : Number(ingredient.minimumStock).toFixed(3)}</td></tr>)}</tbody></table>{ingredients.length === 0 && <p className="p-4 text-slate-400">Nenhum ingrediente cadastrado.</p>}</div>
      </section>

      <section className={`${panelClass} xl:col-span-2`}>
        <h2 className="mb-4 text-lg font-semibold">Movimentações recentes</h2>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-slate-400"><tr><th className="p-3">Data</th><th className="p-3">Ingrediente</th><th className="p-3">Tipo</th><th className="p-3">Quantidade</th><th className="p-3">Observação</th></tr></thead><tbody>{movements.map(movement => <tr key={movement.id} className="border-t border-slate-800"><td className="p-3">{new Date(movement.createdAt).toLocaleString('pt-BR')}</td><td className="p-3">{movement.ingredient.name}</td><td className="p-3">{movementTypes.find(type => type.value === movement.type)?.label ?? (movement.type === 'ORDER_CONSUMPTION' ? 'Consumo do pedido' : movement.type)}</td><td className="p-3">{Number(movement.quantity).toFixed(3)} {movement.ingredient.unitOfMeasure}</td><td className="p-3">{movement.note || '—'}</td></tr>)}</tbody></table>{movements.length === 0 && <p className="p-4 text-slate-400">Nenhuma movimentação registrada.</p>}</div>
      </section>
    </div>
  </AppShell>;
}
