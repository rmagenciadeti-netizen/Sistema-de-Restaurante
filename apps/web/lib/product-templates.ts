import { api, ListResponse } from './api';

export type TemplateGroup = { name: string; minSelect: number; maxSelect: number; options: string[] };
export type ProductTemplate = { key: string; label: string; icon: string; hint: string; groups: TemplateGroup[] };

// Starting points for a new product. Option prices start at R$ 0,00 and are adjusted afterwards in Adicionais e combos.
export const productTemplates: ProductTemplate[] = [
  { key: 'pizza', label: 'Modelo de pizza', icon: '🍕', hint: 'Tamanho obrigatório, borda e adicionais opcionais.', groups: [
    { name: 'Tamanho da pizza', minSelect: 1, maxSelect: 1, options: ['Broto', 'Média', 'Grande', 'Gigante'] },
    { name: 'Borda da pizza', minSelect: 0, maxSelect: 1, options: ['Catupiry', 'Cheddar', 'Chocolate'] },
    { name: 'Adicionais da pizza', minSelect: 0, maxSelect: 5, options: ['Bacon', 'Queijo extra', 'Azeitona', 'Cebola'] },
  ] },
  { key: 'burger', label: 'Modelo de hambúrguer', icon: '🍔', hint: 'Ponto da carne, adicionais e retirada de ingredientes.', groups: [
    { name: 'Ponto da carne', minSelect: 1, maxSelect: 1, options: ['Mal passado', 'Ao ponto', 'Bem passado'] },
    { name: 'Adicionais do hambúrguer', minSelect: 0, maxSelect: 5, options: ['Bacon', 'Queijo extra', 'Ovo', 'Cebola caramelizada'] },
    { name: 'Retirar ingredientes', minSelect: 0, maxSelect: 4, options: ['Sem cebola', 'Sem tomate', 'Sem picles', 'Sem molho'] },
  ] },
  { key: 'acai', label: 'Modelo de açaí', icon: '🫐', hint: 'Tamanho, acompanhamentos e coberturas.', groups: [
    { name: 'Tamanho do açaí', minSelect: 1, maxSelect: 1, options: ['300 ml', '500 ml', '700 ml'] },
    { name: 'Acompanhamentos do açaí', minSelect: 0, maxSelect: 4, options: ['Granola', 'Leite em pó', 'Banana', 'Paçoca'] },
    { name: 'Coberturas do açaí', minSelect: 0, maxSelect: 2, options: ['Leite condensado', 'Chocolate', 'Morango'] },
  ] },
  { key: 'sushi', label: 'Modelo de sushi', icon: '🍣', hint: 'Molhos e acompanhamentos.', groups: [
    { name: 'Molhos do sushi', minSelect: 0, maxSelect: 3, options: ['Shoyu', 'Tarê', 'Agridoce'] },
    { name: 'Acompanhamentos do sushi', minSelect: 0, maxSelect: 3, options: ['Gengibre', 'Wasabi', 'Hashi extra'] },
  ] },
  { key: 'meal', label: 'Modelo de prato feito / marmita', icon: '🍱', hint: 'Tamanho obrigatório e acompanhamentos.', groups: [
    { name: 'Tamanho da marmita', minSelect: 1, maxSelect: 1, options: ['Pequena', 'Média', 'Grande'] },
    { name: 'Acompanhamentos da marmita', minSelect: 0, maxSelect: 3, options: ['Arroz', 'Feijão', 'Farofa', 'Salada', 'Purê'] },
  ] },
  { key: 'combo', label: 'Modelo de combo', icon: '🧺', hint: 'Cadastra o produto; defina os itens do combo em Adicionais e combos.', groups: [] },
];

export const findTemplate = (key: string) => productTemplates.find(template => template.key === key) ?? null;

// Reuses groups that already exist (same name, ignoring case) so templates never fail on duplicates, then links them all to the new product.
export async function attachTemplateGroups(productId: string, groups: TemplateGroup[]) {
  if (groups.length === 0) return;
  const existing = (await api<ListResponse<{ id: string; name: string }>>('/catalog/modifier-groups')).items;
  const ids: string[] = [];
  for (const group of groups) {
    const found = existing.find(item => item.name.toLowerCase() === group.name.toLowerCase());
    if (found) { ids.push(found.id); continue; }
    const created = await api<{ id: string }>('/catalog/modifier-groups', { method: 'POST', body: JSON.stringify({ name: group.name, minSelect: group.minSelect, maxSelect: group.maxSelect, options: group.options.map(name => ({ name, price: 0 })) }) });
    ids.push(created.id);
  }
  await api(`/catalog/products/${productId}/modifier-groups`, { method: 'PUT', body: JSON.stringify({ groupIds: ids }) });
}
