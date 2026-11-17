export type OperationNature = { id: string; name: string; cfop: string; direction: 'IN' | 'OUT'; finality: 'NORMAL' | 'COMPLEMENTARY' | 'ADJUSTMENT' | 'RETURN'; description?: string | null; active: boolean; operation?: NatureOperation; destination?: NatureDestination; ufOrigin?: string | null; ufDestination?: string | null; taxRegime?: FiscalIssuer['taxRegime'] | null; taxRuleId?: string | null };
export type NatureOperation = 'SALE' | 'RETURN' | 'TRANSFER' | 'OTHER';
export type NatureDestination = 'ANY' | 'INTERNAL' | 'INTERSTATE';
export const operationLabel: Record<NatureOperation, string> = { SALE: 'Venda', RETURN: 'Devolução', TRANSFER: 'Transferência', OTHER: 'Outras' };
export const destinationLabel: Record<NatureDestination, string> = { ANY: 'Qualquer destino', INTERNAL: 'Dentro do estado', INTERSTATE: 'Interestadual' };
export type CfopDefaults = { saleInternal?: string; saleInterstate?: string; returnInternal?: string; returnInterstate?: string };
export type CstCorrelation = { id: string; outCst: string; inCst: string; description?: string | null; active: boolean };
export type InvoiceItem = { description: string; ncm?: string | null; cfop?: string | null; quantity: number; unitValue: number; totalValue: number };
export type InvoiceStatus = 'RECEIVED' | 'ENTERED' | 'CANCELLED';
export type ReceivedInvoice = { id: string; accessKey: string; number: string; series: string; supplierName: string; supplierDocument?: string | null; issuedAt: string; totalAmount: string | number; status: InvoiceStatus; enteredAt?: string | null; notes?: string | null; items: InvoiceItem[]; nature?: { id: string; name: string; cfop: string } | null };
export type ParsedInvoice = { accessKey: string; number: string; series: string; issuedAt: string; issueDate: string; supplierName: string; supplierDocument: string | null; totalAmount: number; items: InvoiceItem[] };
export type Contingency = { id: string; reason: string; startedAt: string; endedAt?: string | null };
export type ContingencyResponse = { active: Contingency | null; history: Contingency[]; pending: { id: string; kind: string; status: string; error?: string | null; createdAt: string; number?: string | null; series?: string | null; environment: FiscalEnvironment; protocol?: string | null; contingency: boolean; lastAttemptAt?: string | null; attempts: number; order?: { code: string; total: string | number; customerName?: string | null } | null }[] };
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

export type FiscalEnvironment = 'HOMOLOGATION' | 'PRODUCTION';
export const environmentLabel: Record<FiscalEnvironment, string> = { HOMOLOGATION: 'Homologação', PRODUCTION: 'Produção' };
export const fiscalStatusLabel: Record<string, string> = { PENDING: 'Enviando', PROCESSING: 'Sem protocolo / aguardando retorno', CONTINGENCY: 'Em contingência', AUTHORIZED: 'Autorizado', REJECTED: 'Rejeitado', DENIED: 'Denegado', CANCELLED: 'Cancelado' };
export const fiscalStatusTone: Record<string, 'neutral' | 'gold' | 'green' | 'red' | 'blue' | 'amber'> = { PENDING: 'blue', PROCESSING: 'amber', CONTINGENCY: 'gold', AUTHORIZED: 'green', REJECTED: 'red', DENIED: 'red', CANCELLED: 'neutral' };
export const kindLabel: Record<string, string> = { NFCE: 'NFC-e (65)', NFE: 'NF-e (55)' };
export type FiscalEvent = { id: string; type: string; status: string; protocol?: string | null; message?: string | null; sequence?: number | null; createdAt: string };
export const eventTypeLabel: Record<string, string> = { EMISSION: 'Emissão', CONSULT: 'Consulta', CANCEL: 'Cancelamento', CORRECTION: 'Carta de correção', INUTILIZATION: 'Inutilização', CONTINGENCY: 'Contingência', CERTIFICATE: 'Certificado', CONNECTION_TEST: 'Teste de comunicação' };
export type Inutilization = { id: string; environment: FiscalEnvironment; status: 'REGISTERED' | 'REJECTED'; kind: 'NFCE' | 'NFE'; series: string; numberFrom: number; numberTo: number; justification: string; protocol?: string | null; message?: string | null; createdAt: string };
export type PdvMode = 'FISCAL' | 'NON_FISCAL' | 'ASK';
export type FiscalIssuer = { legalName: string; tradeName: string; cnpj: string; stateRegistration: string; municipalRegistration: string; cnae: string; taxRegime: 'SIMPLES_NACIONAL' | 'SIMPLES_EXCESSO' | 'NORMAL' | 'MEI'; street: string; number: string; complement: string; district: string; city: string; cityIbge: string; uf: string; cep: string; country: string; countryCode: string; phone: string; contributorIndicator: '1' | '2' | '9' };
export type FiscalModelConfig = { nature: string; emissionType: 'NORMAL' | 'CONTINGENCY_OFFLINE' | 'EPEC' | 'FS_DA'; finality: '1' | '2' | '3' | '4'; defaultCfop: string; additionalInfo: string };
export type FiscalSettingsView = {
  configured: boolean; environment: FiscalEnvironment; provider: string | null; providers: string[]; hasProviderToken: boolean; cscId: string; hasCscToken: boolean;
  issuer: FiscalIssuer; crt: number; cfop: CfopDefaults; nfe: FiscalModelConfig; nfce: FiscalModelConfig; pdvMode: PdvMode; defaultTaxRuleId: string | null;
  certificate: { state: 'MISSING' | 'VALID' | 'EXPIRING' | 'EXPIRED'; daysLeft: number | null; subject?: string | null; cnpj?: string | null; validFrom?: string | null; validTo?: string | null; uploadedAt?: string | null };
  readiness: { NFCE: string[]; NFE: string[] };
};
