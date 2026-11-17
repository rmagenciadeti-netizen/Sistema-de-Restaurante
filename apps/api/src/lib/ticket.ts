export type TicketItem = { quantity: number; name: string; notes?: string | null; extras?: string[] };
export type TicketInput = {
  title: string;
  orderCode: string;
  channel: string;
  tableLabel?: string | null;
  customerName?: string | null;
  createdAt: Date;
  items: TicketItem[];
};

export function paperColumns(paperWidthMm: number): number {
  return paperWidthMm <= 58 ? 32 : 48;
}

function wrap(text: string, width: number, indent = ''): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (indent.length + candidate.length > width && current) {
      lines.push(indent + current);
      current = word;
    } else current = candidate;
  }
  if (current) lines.push(indent + current);
  return lines;
}

const center = (text: string, width: number) => text.length >= width ? text : ' '.repeat(Math.floor((width - text.length) / 2)) + text;

export function renderProductionTicket(input: TicketInput, paperWidthMm = 80): string {
  const width = paperColumns(paperWidthMm);
  const rule = '-'.repeat(width);
  const when = input.createdAt.toISOString().replace('T', ' ').slice(0, 16);
  const lines = [center(input.title.toUpperCase(), width), rule, `Pedido: ${input.orderCode}`, `Canal: ${input.channel}`];
  if (input.tableLabel) lines.push(`Mesa: ${input.tableLabel}`);
  if (input.customerName) lines.push(...wrap(`Cliente: ${input.customerName}`, width));
  lines.push(`Hora: ${when} UTC`, rule);
  for (const item of input.items) {
    lines.push(...wrap(`${item.quantity}x ${item.name}`, width));
    for (const extra of item.extras ?? []) lines.push(...wrap(`+ ${extra}`, width, '  '));
    if (item.notes) lines.push(...wrap(`* ${item.notes}`, width, '  '));
  }
  lines.push(rule);
  return lines.join('\n');
}
