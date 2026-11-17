export function parseQuantity(value: string | number, fractional: boolean, max: number): number | null {
  const text = String(value).trim().replace(',', '.');
  if (!(fractional ? /^\d+(?:\.\d{1,3})?$/ : /^\d+$/).test(text)) return null;
  const quantity = Number(text);
  return Number.isFinite(quantity) && quantity > 0 && quantity <= max ? quantity : null;
}
