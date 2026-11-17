import { formatMoney } from '../lib/api';
import { channelLabels, lineWeight, methodLabels, orderTitle, type OpsOrder } from '../lib/types-ops';

// Paper sheet that only shows when printing (window.print); the rest of the page uses `print:hidden`.
export function OrderReceipt({ order, serviceFeeName = 'Taxa de serviço' }: { order: OpsOrder; serviceFeeName?: string }) {
  const discount = Number(order.discount ?? 0);
  const line = (label: string, value: string, strong = false) => <div className={`flex justify-between gap-4 ${strong ? 'text-base font-bold' : ''}`}><span>{label}</span><span>{value}</span></div>;
  return <section aria-hidden="true" className="hidden bg-white p-2 font-mono text-[12px] leading-snug text-black print:mx-auto print:block print:w-[78mm]">
    <h2 className="text-center text-base font-bold">Comprovante do pedido {orderTitle(order)}</h2>
    <p className="text-center">{order.code} · {new Date(order.createdAt).toLocaleString('pt-BR')}</p>
    <p className="text-center">{channelLabels[order.channel] ?? order.channel}{order.tableLabel ? ` · ${order.tableLabel}` : ''}{order.customerName ? ` · ${order.customerName}` : ''}</p>
    {order.scheduledFor && <p className="text-center">Agendado para {new Date(order.scheduledFor).toLocaleString('pt-BR')}</p>}
    <hr className="my-2 border-dashed border-black" />
    {order.items.filter(item => !item.parentItemId).map(item => <div key={item.id} className="mb-1">
      <div className="flex justify-between gap-2"><span>{item.quantity}× {item.product.name}{lineWeight(item) ? ` (${lineWeight(item)})` : ''}</span><span>{formatMoney(item.total)}</span></div>
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
