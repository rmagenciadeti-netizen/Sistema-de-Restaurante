const ESC = 0x1b;
const GS = 0x1d;

// Printers rarely share Unicode support; accents are folded to ASCII so output is readable on any codepage.
export function toPrinterText(text) {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x09\x0a\x20-\x7e]/g, '?');
}

export function buildEscPos({ content, autoCut = true, cashDrawer = false }) {
  const parts = [Buffer.from([ESC, 0x40])];
  parts.push(Buffer.from(`${toPrinterText(content)}\n\n\n`, 'ascii'));
  if (autoCut) parts.push(Buffer.from([GS, 0x56, 0x42, 0x00]));
  if (cashDrawer) parts.push(Buffer.from([ESC, 0x70, 0x00, 0x19, 0xfa]));
  return Buffer.concat(parts);
}
