export type ItemStatus =
  | "UPDATED"
  | "UPDATING"
  | "WAITING_USER_INPUT"
  | "WAITING_USER_ACTION"
  | "LOGIN_ERROR"
  | "OUTDATED"
  | "MERGING"
  | "DELETED";

export type AccountType = "BANK" | "CREDIT";

export type AccountSubtype = "CHECKING_ACCOUNT" | "SAVINGS_ACCOUNT" | "CREDIT_CARD";

export type TransactionType = "DEBIT" | "CREDIT";

export interface AuthResponse {
  apiKey: string;
}

export interface ConnectTokenResponse {
  accessToken: string;
}

export interface PageResponse<T> {
  total: number;
  totalPages: number;
  page: number;
  results: T[];
}

export interface CursorPageResponse<T> {
  results: T[];
  /** Query string pronta da próxima página (ex.: "?accountId=...&after=..."), ou null na última. */
  next: string | null;
}

export interface Connector {
  id: number;
  name: string;
  type: string;
  country: string;
  imageUrl?: string;
}

export interface Item {
  id: string;
  status: ItemStatus;
  connector: Connector | null;
  createdAt: string;
  updatedAt: string;
  lastUpdatedAt: string | null;
}

export interface Account {
  id: string;
  itemId: string;
  type: AccountType;
  subtype: AccountSubtype;
  name: string;
  number: string;
  balance: number;
  currencyCode: string;
  bankData?: { transferNumber?: string | null } | null;
  creditData?: CreditData | null;
}

/** Dados de cartão de crédito (só em contas `CREDIT`). */
export interface CreditData {
  creditLimit?: number | null;
  availableCreditLimit?: number | null;
  /** Fechamento e vencimento da fatura atual. */
  balanceCloseDate?: string | null;
  balanceDueDate?: string | null;
  minimumPayment?: number | null;
}

/** Fatura fechada de cartão de crédito. */
export interface Bill {
  id: string;
  dueDate: string;
  totalAmount: number;
  totalAmountCurrencyCode: string;
  minimumPaymentAmount?: number | null;
  /** Fechamento real da fatura (o `balanceCloseDate` do cartão pode vir nulo). */
  billClosingDate?: string | null;
  financeCharges?: BillFinanceCharge[] | null;
  payments?: BillPayment[] | null;
}

export interface BillFinanceCharge {
  type?: string | null;
  additionalInfo?: string | null;
  amount?: number | null;
  currencyCode?: string | null;
}

export interface BillPayment {
  id?: string;
  valueType?: string | null;
  paymentDate: string;
  paymentMode?: string | null;
  amount: number;
  currencyCode?: string | null;
}

export interface CreditCardMetadata {
  billId?: string | null;
  installmentNumber?: number | null;
  totalInstallments?: number | null;
  purchaseDate?: string | null;
  /** yyyy-mm da fatura (mês de vencimento) em que a Pluggy prevê lançar a transação ainda sem `billId`. */
  billForecastDate?: string | null;
  billPostDate?: string | null;
  transactionDateTime?: string | null;
  paymentType?: string | null;
}

export type InvestmentType = "FIXED_INCOME" | "EQUITY" | "MUTUAL_FUND" | "SECURITY" | "ETF" | "COE";

export interface Investment {
  id: string;
  itemId: string;
  name: string;
  type: InvestmentType;
  subtype?: string | null;
  /** Valor atual líquido da posição. */
  balance: number;
  /** Valor bruto (antes de impostos). */
  amount?: number | null;
  /** Valor aplicado originalmente. */
  amountOriginal?: number | null;
  /** Rendimento bruto acumulado. */
  amountProfit?: number | null;
  /** Rentabilidade do último mês (comum em fundos; caixinhas do Nubank costumam vir sem). */
  lastMonthRate?: number | null;
  /** Data de referência do valor. */
  date?: string | null;
  /** Data da aplicação. */
  purchaseDate?: string | null;
  /** Data de emissão (renda fixa). */
  issueDate?: string | null;
  /** Percentual do indexador (ex.: 100 ou 120 para 100%/120% do CDI). */
  rate?: number | null;
  /** Indexador: CDI, SELIC, IPCA, etc. */
  rateType?: "CDI" | "SELIC" | "DOLAR" | "EURO" | "IGPM" | "IPCA" | null;
  /** Taxa prefixada anual, quando houver. */
  fixedAnnualRate?: number | null;
  currencyCode: string;
  status?: "ACTIVE" | "PENDING" | "TOTAL_WITHDRAWAL" | null;
}

export interface DocumentNumber {
  type: "CPF" | "CNPJ";
  value: string;
}

export interface PaymentParticipant {
  name?: string;
  documentNumber?: DocumentNumber;
  accountNumber?: string;
  branchNumber?: string;
}

export interface PaymentData {
  payer?: PaymentParticipant;
  receiver?: PaymentParticipant;
  reason?: string;
  paymentMethod?: "PIX" | "TED" | "DOC" | "TEV" | "BOLETO";
}

export interface Merchant {
  name?: string;
  businessName?: string;
  cnpj?: string;
  category?: string;
}

export type TransactionStatus = "PENDING" | "POSTED";

export interface Transaction {
  id: string;
  accountId: string;
  date: string;
  description: string;
  descriptionRaw?: string | null;
  /** Valor com sinal; use `type` para saber se é entrada ou saída. */
  amount: number;
  currencyCode: string;
  type: TransactionType;
  /** Presente em cartões Nubank/Pluggy; parcelas futuras de compra estornada costumam ficar PENDING. */
  status?: TransactionStatus | null;
  /** PAGAMENTO, ESTORNO, PAGAMENTO_FATURA, TARIFA, OPERACOES_CREDITO_CONTRATADAS_CARTAO (cartões). */
  operationType?: string | null;
  category: string | null;
  categoryId?: string | null;
  paymentData?: PaymentData | null;
  merchant?: Merchant | null;
  creditCardMetadata?: CreditCardMetadata | null;
}

export interface DateRange {
  from?: string;
  to?: string;
}
