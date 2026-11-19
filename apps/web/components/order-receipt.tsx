import { formatMoney } from '../lib/api';
import { channelLabels, lineWeight, methodLabels, orderTitle, type OpsOrder } from '../lib/types-ops';
import type { TenantSettings } from '../lib/settings';

// Paper sheet that only shows when printing (window.print); the rest of the page uses `print:hidden`.
export function OrderReceipt({ order, serviceFeeName = 'Taxa de serviço', printing, company }: { order: OpsOrder; serviceFeeName?: string; printing?: TenantSettings['printing']; company?: TenantSettings['company'] }) {
  const discount = Number(order.discount ?? 0);
  const line = (label: string, value: string, strong = false) => <div className={`flex justify-between gap-4 ${strong ? 'text-base font-bold' : ''}`}><span>{label}</span><span>{value}</span></div>;
  const width = printing?.paper === 'A4' ? '210mm' : printing?.paper === '58mm' ? '58mm' : printing?.paper === '55mm' ? '55mm' : '80mm';
  const fontSize = 8 + (printing?.fontSize ?? 5);
  const companyLines = printing?.companyHeader && company ? [company.tradeName || company.legalName, company.document, [company.address, company.number, company.district, company.city, company.state].filter(Boolean).join(', '), company.phone].filter(Boolean) : [];
  return <section aria-hidden="true" className="hidden bg-white p-2 font-mono leading-snug text-black print:mx-auto print:block" style={{ width, fontSize: `${fontSize}px` }}>
    {companyLines.length > 0 && <div className="mb-2 text-center">{companyLines.map((value, index) => <p key={`${index}-${value}`}>{value}</p>)}</div>}
    <h2 className="text-center text-base font-bold">Comprovante do pedido {orderTitle(order)}</h2>
    <p className="text-center">{order.code} · {new Date(order.createdAt).toLocaleString('pt-BR')}</p>
    <p className="text-center">{channelLabels[order.channel] ?? order.channel}{order.tableLabel ? ` · ${order.tableLabel}` : ''}{order.customerName ? ` · ${order.customerName}` : ''}</p>
    {order.scheduledFor && <p className="text-center">Agendado para {new Date(order.scheduledFor).toLocaleString('pt-BR')}</p>}
    <hr className="my-2 border-dashed border-black" />
    {order.items.filter(item => !item.parentItemId).map(item => <div key={item.id} className="mb-1">
      <div className="flex justify-between gap-2"><span>{item.quantity}× {item.product.name}{lineWeight(item) ? ` (${lineWeight(item)})` : ''}{item.withPackaging ? ' · Embalagem' : ''}</span><span>{formatMoney(item.total)}</span></div>
      {item.modifiers?.map(modifier => <div key={modifier.id} className="pl-3">+ {modifier.quantity}× {modifier.name}</div>)}
      {item.notes && <div className="pl-3">Obs.: {item.notes}</div>}
    </div>)}
    <hr className="my-2 border-dashed border-black" />
    {line('Sub-total', formatMoney(order.subtotal))}
    {discount > 0 && line('Desconto', `- ${formatMoney(discount)}`)}
    {discount < 0 && line('Acréscimo', formatMoney(-discount))}
    {Number(order.serviceFee ?? 0) > 0 && line(serviceFeeName, formatMoney(order.serviceFee))}
    {Number(order.couvertFee ?? 0) > 0 && line('Couvert artístico', formatMoney(order.couvertFee))}
    {Number(order.deliveryFee ?? 0) > 0 && line('Entrega', formatMoney(order.deliveryFee))}
    {line('Total', formatMoney(order.total), true)}
    {(order.payments ?? []).map(payment => <div key={payment.id}>{line(methodLabels[payment.method] ?? payment.method, formatMoney(payment.amount))}</div>)}
    <p className="mt-3 text-center">Documento sem valor fiscal</p>
  </section>;
}

export function pickupTicketItems(order: OpsOrder) {
  return order.items.filter(item => !item.parentItemId && item.status !== 'CANCELLED' && item.product.pickupTicket);
}

export function PickupTicket({ order, printing }: { order: OpsOrder; printing?: TenantSettings['printing'] }) {
  const width = printing?.paper === 'A4' ? '210mm' : printing?.paper === '58mm' ? '58mm' : printing?.paper === '55mm' ? '55mm' : '80mm';
  return <section aria-hidden="true" className="hidden bg-white p-2 font-mono leading-snug text-black print:mx-auto print:block" style={{ width, fontSize: `${8 + (printing?.fontSize ?? 5)}px`, breakBefore: 'page' }}>
    <h2 className="text-center text-base font-bold">Ticket de retirada</h2>
    <p className="text-center text-xl font-bold">{orderTitle(order)}</p>
    <p className="text-center">{order.code}</p>
    {order.customerName && <p className="text-center">{order.customerName}</p>}
    {order.scheduledFor && <p className="text-center">Agendado para {new Date(order.scheduledFor).toLocaleString('pt-BR')}</p>}
    <hr className="my-2 border-dashed border-black" />
    {pickupTicketItems(order).map(item => <p key={item.id}>{item.quantity}× {item.product.name}{lineWeight(item) ? ` (${lineWeight(item)})` : ''}</p>)}
  </section>;
}
