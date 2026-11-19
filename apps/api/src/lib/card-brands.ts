// tBand (card brand) codes of the NF-e layout 4.00 table.
const CARD_BRAND_CODE: Record<string, string> = { VISA: '01', MASTERCARD: '02', MASTER: '02', AMEX: '03', AMERICANEXPRESS: '03', SOROCRED: '04', DINERS: '05', DINERSCLUB: '05', ELO: '06', HIPERCARD: '07', AURA: '08', CABAL: '09', OUTROS: '99' };
export const brandCode = (brand: string) => /^\d{2}$/.test(brand) ? brand : CARD_BRAND_CODE[brand.toUpperCase().replace(/[^A-Z]/g, '')] ?? '99';
