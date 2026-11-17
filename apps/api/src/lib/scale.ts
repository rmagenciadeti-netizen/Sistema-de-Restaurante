import { Prisma } from '@prisma/client';

export type ScaleBarcodeConfig = { prefix: string; codeLength: number; barcodeLength: number; saleType: 'WEIGHT' | 'PRICE' };

export function eanCheckDigit(digits: string): number {
  let sum = 0;
  for (let index = digits.length - 1, weight = 3; index >= 0; index -= 1, weight = weight === 3 ? 1 : 3) sum += Number(digits[index]) * weight;
  return (10 - (sum % 10)) % 10;
}

export type ScaleBarcode = { scaleCode: number; kind: 'WEIGHT' | 'PRICE'; weightKg?: Prisma.Decimal; total?: Prisma.Decimal };

// Labels printed by retail scales: prefix + product code + weight in grams (or price in cents) + EAN check digit.
export function parseScaleBarcode(barcode: string, config: ScaleBarcodeConfig): ScaleBarcode | null {
  const digits = barcode.trim();
  if (!/^\d+$/.test(digits) || digits.length !== config.barcodeLength || !digits.startsWith(config.prefix)) return null;
  if (Number(digits.at(-1)) !== eanCheckDigit(digits.slice(0, -1))) return null;
  const codeStart = config.prefix.length;
  const valueStart = codeStart + config.codeLength;
  const scaleCode = Number(digits.slice(codeStart, valueStart));
  const raw = digits.slice(valueStart, -1);
  if (raw.length === 0) return null;
  const value = new Prisma.Decimal(raw);
  return config.saleType === 'WEIGHT'
    ? { scaleCode, kind: 'WEIGHT', weightKg: value.div(1000) }
    : { scaleCode, kind: 'PRICE', total: value.div(100) };
}

export function buildScaleBarcode(config: ScaleBarcodeConfig, scaleCode: number, value: number): string {
  const valueLength = config.barcodeLength - config.prefix.length - config.codeLength - 1;
  const body = `${config.prefix}${String(scaleCode).padStart(config.codeLength, '0')}${String(Math.round(value)).padStart(valueLength, '0')}`;
  return `${body}${eanCheckDigit(body)}`;
}

export const SCALE_BRANDS = ['TOLEDO', 'FILIZOLA', 'URANO', 'URANO_URF32'] as const;
export type ScaleBrand = typeof SCALE_BRANDS[number];

export type ScaleExportProduct = { scaleCode: number; name: string; price: Prisma.Decimal; sellByWeight: boolean; shelfLifeDays: number | null; department: number | null; notes: string | null };

const ascii = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, ' ');
const field = (text: string, length: number) => ascii(text).slice(0, length).padEnd(length, ' ');
const digits = (value: number, length: number) => String(Math.max(0, Math.round(value))).padStart(length, '0').slice(-length);

// Fixed-width item files for each scale family. The layouts follow the commonly documented price-file formats and must be
// validated against the scale model/firmware in use before production; the file name is returned together with the content.
export function buildScaleFile(brand: ScaleBrand, products: ScaleExportProduct[]): { fileName: string; content: string } {
  const cents = (product: ScaleExportProduct) => product.price.mul(100).toNumber();
  const lines = products.map(product => {
    const type = product.sellByWeight ? '0' : '1';
    switch (brand) {
      case 'TOLEDO': return `${digits(product.department ?? 1, 2)}${type}${digits(product.scaleCode, 6)}${digits(cents(product), 6)}${digits(product.shelfLifeDays ?? 0, 3)}${field(product.name, 50)}`;
      case 'FILIZOLA': return `${digits(product.scaleCode, 6)}${type === '0' ? 'P' : 'U'}${field(product.name, 22)}${digits(cents(product), 7)}${digits(product.shelfLifeDays ?? 0, 3)}`;
      case 'URANO': return `${digits(product.scaleCode, 4)}${type}${field(product.name, 20)}${digits(cents(product), 6)}${digits(product.shelfLifeDays ?? 0, 3)}`;
      case 'URANO_URF32': return `${digits(product.scaleCode, 6)};${type};${ascii(product.name).slice(0, 25)};${product.price.toFixed(2)};${product.shelfLifeDays ?? 0}`;
    }
  });
  const fileName = { TOLEDO: 'ITENSMGV.TXT', FILIZOLA: 'CADTXT.TXT', URANO: 'PRODUTOS.TXT', URANO_URF32: 'URF32.TXT' }[brand];
  return { fileName, content: lines.join('\r\n') + (lines.length ? '\r\n' : '') };
}
