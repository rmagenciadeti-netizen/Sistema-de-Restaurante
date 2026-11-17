export type OperationNature = { id: string; name: string; cfop: string; direction: 'IN' | 'OUT'; finality: 'NORMAL' | 'COMPLEMENTARY' | 'ADJUSTMENT' | 'RETURN'; description?: string | null; active: boolean };
export type CstCorrelation = { id: string; outCst: string; inCst: string; description?: string | null; active: boolean };
export type InvoiceItem = { description: string; ncm?: string | null; cfop?: string | null; quantity: number; unitValue: number; totalValue: number };
export type InvoiceStatus = 'RECEIVED' | 'ENTERED' | 'CANCELLED';
export type ReceivedInvoice = { id: string; accessKey: string; number: string; series: string; supplierName: string; supplierDocument?: string | null; issuedAt: string; totalAmount: string | number; status: InvoiceStatus; enteredAt?: string | null; notes?: string | null; items: InvoiceItem[]; nature?: { id: string; name: string; cfop: string } | null };
export type ParsedInvoice = { accessKey: string; number: string; series: string; issuedAt: string; supplierName: string; supplierDocument: string | null; totalAmount: number; items: InvoiceItem[] };
export type Contingency = { id: string; reason: string; startedAt: string; endedAt?: string | null };
export type ContingencyResponse = { active: Contingency | null; history: Contingency[]; pending: { id: string; kind: string; status: string; error?: string | null; createdAt: string; order?: { code: string; total: string | number } | null }[] };
export type XmlsResponse = {
  received: { id: string; accessKey: string; number: string; supplierName: string; issuedAt: string; totalAmount: string | number; status: InvoiceStatus }[];
  emitted: { id: string; kind: string; status: string; number?: string | null; accessKey?: string | null; documentUrl?: string | null; createdAt: string; order?: { code: string; total: string | number } | null }[];
};
export type Reconciliation = {
  from: string; to: string; truncated: boolean;
  orders: { count: number; total: number }; invoiced: { count: number; total: number };
  withoutDocument: { count: number; total: number; items: { id: string; code: string; total: string | number; createdAt: string }[] };
  documentsByStatus: Record<string, number>; receivedByStatus: Record<string, { count: number; total: number }>;
};
export const directionLabel = { IN: 'Entrada', OUT: 'Saída' } as const;
export const finalityLabel = { NORMAL: 'Normal', COMPLEMENTARY: 'Complementar', ADJUSTMENT: 'Ajuste', RETURN: 'Devolução' } as const;
export const invoiceStatusLabel: Record<InvoiceStatus, string> = { RECEIVED: 'Recebida', ENTERED: 'Lançada', CANCELLED: 'Cancelada' };
