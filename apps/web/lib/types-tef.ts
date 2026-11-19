export type TefStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'CANCELLED' | 'TIMEOUT' | 'UNKNOWN' | 'ERROR' | 'REVERSED';
export type TefIntegrationStatus = 'NOT_CONFIGURED' | 'AWAITING_CREDENTIALS' | 'CONFIGURED' | 'IN_TESTING' | 'HOMOLOGATED' | 'PRODUCTION_ENABLED' | 'FAILED';
export type TefField = { key: string; label: string; secret?: boolean; required?: boolean; hint?: string; options?: string[] };
export type TefProvider = {
  provider: string; label: string; simulated: boolean; capabilities: { methods: string[]; installments: boolean; query: boolean; cancel: boolean; pix: boolean }; fields: TefField[];
  integrationStatus: TefIntegrationStatus; environment: 'HOMOLOGATION' | 'PRODUCTION'; establishmentCnpj: string; merchantCode: string; logicalNumber: string; terminalId: string; cashRegisterId: string; pinpad: string;
  connection: Record<string, string | number | boolean>; printing: { autoPrint?: boolean; copies?: number; paper?: string; allowReprint?: boolean }; enabledMethods: string[]; acceptedBrands: string[]; financialMapping: Record<string, string>;
  homologationEvidence: string; lastTest: { at: string; ok: boolean | null; message: string | null } | null; credentials: Record<string, boolean>;
};
export type TefTransaction = {
  id: string; orderId: string; orderCode?: string | null; provider: string; simulated: boolean; method: string; amount: string | number; installments: number; status: TefStatus; nsu: string | null; authorizationCode: string | null; cardBrand: string | null;
  pixEndToEnd: string | null; responseMessage: string | null; paymentId: string | null; reversalInProgress: boolean; reversalReason: string | null; reversedAt: string | null; requestedAt: string; completedAt: string | null;
};
export type TefStartResponse = { transaction: TefTransaction; paid: boolean; replayed: boolean };
export type TefReconciliation = {
  period: { from: string; to: string }; unresolved: number; manualPayments: number; notice: string;
  totals: { method: string; brand: string; approved: number; approvedAmount: number; reversed: number; reversedAmount: number; denied: number }[];
  divergences: { type: string; transactionId?: string; paymentId?: string; orderCode: string | null; detail: string }[];
};
export type TefMonitor = { byStatus: { status: TefStatus; count: number; amount: number }[]; stale: { id: string; orderId: string; status: TefStatus; provider: string; amount: string; createdAt: string }[] };
export const TEF_STATUS: Record<TefStatus, { label: string; tone: 'neutral' | 'green' | 'amber' | 'red' | 'blue' }> = {
  PENDING: { label: 'Aguardando', tone: 'blue' }, APPROVED: { label: 'Aprovada', tone: 'green' }, DENIED: { label: 'Negada', tone: 'red' }, CANCELLED: { label: 'Cancelada', tone: 'neutral' },
  TIMEOUT: { label: 'Sem resposta — consultar', tone: 'amber' }, UNKNOWN: { label: 'Desconhecida — revisar', tone: 'amber' }, ERROR: { label: 'Erro', tone: 'red' }, REVERSED: { label: 'Estornada', tone: 'neutral' },
};
export const INTEGRATION_STATUS: Record<TefIntegrationStatus, { label: string; tone: 'neutral' | 'green' | 'amber' | 'red' | 'blue' }> = {
  NOT_CONFIGURED: { label: 'Não configurada', tone: 'neutral' }, AWAITING_CREDENTIALS: { label: 'Aguardando credenciais', tone: 'amber' }, CONFIGURED: { label: 'Configurada', tone: 'blue' },
  IN_TESTING: { label: 'Em testes', tone: 'blue' }, HOMOLOGATED: { label: 'Homologada', tone: 'green' }, PRODUCTION_ENABLED: { label: 'Produção habilitada', tone: 'green' }, FAILED: { label: 'Com falha', tone: 'red' },
};
export const METHOD_LABEL: Record<string, string> = { CREDIT_CARD: 'Crédito', DEBIT_CARD: 'Débito', PIX: 'PIX', VOUCHER: 'Voucher' };
