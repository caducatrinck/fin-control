import type { AccountSubtype, AccountType, InvestmentType, ItemStatus } from "../pluggy/types.ts";

export interface ErrorResponse {
  error: string;
}

export interface OkResponse {
  ok: true;
}

export interface StatusResponse {
  configured: boolean;
  connected: boolean;
}

export interface CredentialsRequest {
  clientId: string;
  clientSecret: string;
}

export interface ItemRequest {
  itemId: string;
}

export interface ConnectTokenResult {
  accessToken: string;
}

export interface SettingsResponse {
  clientId: string | null;
  itemId: string | null;
}

// Tags

export const TAG_COLORS = ["gray", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"] as const;

export type TagColor = (typeof TAG_COLORS)[number];

export interface Tag {
  id: string;
  name: string;
  color: TagColor;
}

/** Associa um pagador/recebedor (identificado por `key`) a uma tag. */
export interface TagRule {
  key: string;
  label: string;
  tagId: string;
}

/**
 * Filtro condicional: a tag só entra se a movimentação passar em todos os critérios definidos.
 * Ex.: amount=3000 e contains="sergio" → só Pix de R$ 3.000 cujo nome/descrição tenha "sergio".
 * Precisa de pelo menos um critério (`amount` ou `contains`).
 */
export interface TagFilter {
  id: string;
  tagId: string;
  /** Valor exato (positivo). `null` = qualquer valor. */
  amount: number | null;
  /** Texto que deve aparecer no nome/descrição (sem acento/caixa). `null` = qualquer. */
  contains: string | null;
}

/** Descrição personalizada de um pagador/recebedor (ex.: "Barbeiro"), usada no lugar do nome original. */
export interface Alias {
  key: string;
  label: string;
  alias: string;
}

/**
 * Conta recorrente.
 * - Automática (`manual: false`): um pagador/recebedor; qualquer saída para ele no período conta como pagamento.
 * - Manual (`manual: true`): criada pelo usuário com nome, valor e vencimento; pagamentos são confirmados um a um.
 */
export interface RecurringBill {
  /** Nas automáticas é igual a `key`. */
  id: string;
  /** Pagador/recebedor vinculado; `null` = sem vínculo (pagamento marcado à mão). */
  key: string | null;
  /** Nas automáticas, o nome do pagador/recebedor; nas manuais, o que é a conta. */
  label: string;
  /** Valor fixado; `null` = usa a média dos últimos meses. */
  expected: number | null;
  /** Dia do vencimento (só nas manuais). */
  day: number | null;
  manual: boolean;
  /** Nome de quem foi vinculado, para exibir mesmo sem movimentação no período. */
  linkLabel: string | null;
  /** Vínculo por nome (normalizado): vale qualquer saída cujo nome contenha este texto. */
  matchName: string | null;
}

/** Decisão do usuário sobre o pagamento de uma conta manual. */
export interface RecurringMatch {
  billId: string;
  /** yyyy-mm */
  month: string;
  /** `null` = marcado como pago à mão, sem transação. */
  transactionId: string | null;
  /** `false` = "essa transação não é desta conta". */
  paid: boolean;
}

/** Decisão manual sobre uma entrada: `refund: true` abate o gasto; `false` ignora a detecção automática. */
export interface RefundOverride {
  id: string;
  refund: boolean;
}

/** `refund: null` volta à detecção automática. */
export interface SetRefundRequest {
  id: string;
  refund: boolean | null;
}

export interface TagsResponse {
  tags: Tag[];
  rules: TagRule[];
  filters: TagFilter[];
  aliases: Alias[];
  recurring: RecurringBill[];
  matches: RecurringMatch[];
  refundOverrides: RefundOverride[];
}

/** `alias: null` remove a descrição personalizada. */
export interface SetAliasRequest {
  key: string;
  label: string;
  alias: string | null;
}

export interface CreateTagRequest {
  name: string;
  color: TagColor;
}

export interface UpdateTagRequest {
  id: string;
  name: string;
  color: TagColor;
}

export interface DeleteTagRequest {
  id: string;
}

/** `tagId: null` remove a regra do pagador/recebedor. */
export interface SetRuleRequest {
  key: string;
  label: string;
  tagId: string | null;
}

export interface UpsertTagFilterRequest {
  /** Ausente = cria; presente = edita. */
  id?: string;
  tagId: string;
  amount: number | null;
  contains: string | null;
}

export interface DeleteTagFilterRequest {
  id: string;
}

// Período

export interface DateRange {
  /** yyyy-mm-dd, inclusivo */
  from: string;
  /** yyyy-mm-dd, inclusivo */
  to: string;
}

export interface PeriodRequest extends DateRange {
  refresh?: boolean;
}

export type Direction = "in" | "out";

/** received = entrada; paid = compra no cartão ou boleto; transferred = Pix/transferência enviada. */
export type Movement = "received" | "paid" | "transferred";

export const MOVEMENT_PREFIX: Readonly<Record<Movement, string>> = {
  received: "RECEBIDO",
  paid: "PAGO",
  transferred: "TRANSFERIDO",
};

export interface PeriodTransaction {
  id: string;
  accountId: string;
  accountName: string;
  date: string;
  description: string;
  /** Sempre positivo; o sentido está em `direction`. */
  amount: number;
  direction: Direction;
  movement: Movement;
  category: string | null;
  counterpartyKey: string;
  /** Nome original do pagador/recebedor, vindo do banco. */
  counterpartyName: string;
  /** Descrição personalizada, se houver. */
  alias: string | null;
  /** Nome exibido: "<PREFIXO> - <descrição personalizada ou nome original>". */
  displayName: string;
  tagId: string | null;
  /** Transferência entre contas próprias, pagamento de fatura ou aplicação/resgate: fora dos totais. */
  internal: boolean;
  /** Estorno/reembolso: abate o gasto (não conta como renda). Cashback não é estorno. */
  refund: boolean;
  /**
   * Parcela futura de uma compra que já teve estorno na Pluggy/banco.
   * Fora dos totais (a Pluggy ainda manda a parcela como débito PENDING).
   */
  cancelled: boolean;
}

export interface AccountBalance {
  id: string;
  name: string;
  type: AccountType;
  subtype: AccountSubtype;
  balance: number;
  currencyCode: string;
}

export interface TagTotal {
  tagId: string | null;
  total: number;
  count: number;
}

export interface PeriodTotals {
  income: number;
  expense: number;
  net: number;
  internalCount: number;
}

/** Rendimento previsto das caixinhas (CDI × %), opcional no Resumo. */
export interface PeriodInvestmentIncome {
  /** Soma do previsto num mês típico; `null` se nenhuma posição trouxe a % do CDI. */
  expectedMonth: number | null;
  cdiAnnual: number | null;
  items: {
    id: string;
    name: string;
    rate: number;
    rateType: string | null;
    amount: number;
    balance: number;
    /** Data de entrada escolhida pelo usuário; `null` = “mês” (só no mês atual). */
    date: string | null;
    /** Valor foi editado manualmente. */
    amountEdited: boolean;
  }[];
}

export interface SetYieldOverrideRequest {
  id: string;
  /** `null` = volta ao valor calculado. */
  amount: number | null;
  /** yyyy-mm-dd; `null` = volta ao comportamento “mês atual”. */
  date: string | null;
}

export interface PeriodResponse {
  range: DateRange;
  item: {
    connector: string | null;
    status: ItemStatus;
    lastUpdatedAt: string | null;
  };
  accounts: AccountBalance[];
  transactions: PeriodTransaction[];
  totals: PeriodTotals;
  /** Saídas agrupadas por tag, da maior para a menor. `tagId: null` = sem tag. */
  expensesByTag: TagTotal[];
  /** Previsto do mês com base no CDI e na % de cada caixinha; o Resumo só soma se o usuário ligar. */
  investmentIncome: PeriodInvestmentIncome;
}

// Fatura do cartão

export interface CardInfo {
  id: string;
  name: string;
  creditLimit: number | null;
  availableCreditLimit: number | null;
}

/** Fatura por mês de vencimento: fechada (da Pluggy) ou prevista (ainda aberta). */
export interface CardBill {
  /** yyyy-mm do vencimento. */
  month: string;
  /** Total gasto no ciclo (compras menos estornos); pagamentos antecipados não abatem. */
  total: number;
  /** Valor com que a fatura fechou na Pluggy, já descontados os pagamentos antecipados; `null` se ainda aberta. */
  closedAmount: number | null;
  dueDate: string | null;
  estimated: boolean;
}

export interface CardPurchase {
  id: string;
  date: string;
  /** Compra positiva; estorno negativo. */
  amount: number;
  displayName: string;
  counterpartyKey: string;
  counterpartyName: string;
  tagId: string | null;
  cardName: string;
  /** "3/10" em compras parceladas. */
  installment: string | null;
}

export interface CardSpender {
  key: string;
  name: string;
  total: number;
  count: number;
}

export interface CardResponse {
  range: DateRange;
  cards: CardInfo[];
  /** `false` quando a Pluggy não devolveu faturas fechadas: todas são estimadas pelas compras. */
  billsAvailable: boolean;
  /** Últimos 12 meses de vencimento mais o próximo, do mais antigo ao mais novo. */
  bills: CardBill[];
  /** Fatura(s) com vencimento no período selecionado. */
  selected: {
    months: string[];
    total: number;
    closedAmount: number | null;
    dueDate: string | null;
    estimated: boolean;
    purchases: CardPurchase[];
    topSpenders: CardSpender[];
    byTag: TagTotal[];
  };
  /** Próxima fatura (ainda aberta), estimada pelas compras já lançadas. */
  next: CardBill | null;
  /**
   * Teto para a fatura: salário do período − gasto fixo das recorrentes.
   * Sem salário detectado, `room` fica `null`.
   */
  budget: CardBudget;
}

export interface CardBudget {
  /** Soma das entradas que parecem salário; se nenhuma, a maior entrada do período. */
  salary: number | null;
  /** Como o salário foi escolhido. */
  salarySource: "salary" | "largest-income" | null;
  /** Gasto fixo mensal (contas recorrentes). */
  fixed: number;
  /** Quanto a fatura pode chegar: salário − fixos. */
  room: number | null;
  /** Fatura do período selecionado. */
  bill: number;
  /** Folga depois da fatura: room − bill (negativo = estourou o teto). */
  remaining: number | null;
}

// Patrimônio

export interface InvestmentBalance {
  id: string;
  name: string;
  type: InvestmentType;
  /** Valor líquido de hoje (já descontado o IR estimado). */
  balance: number;
  currencyCode: string;
  /** Quanto foi aplicado; `null` se a Pluggy não informar. */
  invested: number | null;
  /** Quanto rendeu desde a aplicação, bruto (antes do IR); `null` se a Pluggy não informar. */
  profit: number | null;
  /** Percentual do indexador (ex.: 100 ou 120); `null` se a Pluggy não informar. */
  rate: number | null;
  /** Indexador (CDI, SELIC…); `null` sem taxa. */
  rateType: string | null;
  /** Rendimento previsto num mês típico (CDI atual × % da caixinha); `null` sem taxa ou sem CDI. */
  expectedMonthProfit: number | null;
  /** Data de entrada do rendimento (ajuste manual); `null` = sem data. */
  yieldDate: string | null;
  /** `true` se o previsto foi editado à mão. */
  yieldEdited: boolean;
}

/** Saldo no fim do mês (ou hoje, no mês atual). */
export interface WealthPoint {
  /** yyyy-mm */
  month: string;
  accounts: number;
  investments: number;
  total: number;
}

export interface WealthResponse {
  /** Todas as contas; as de cartão de crédito ficam fora do total (são dívida). */
  accounts: AccountBalance[];
  investments: InvestmentBalance[];
  /** `false` quando a Pluggy não devolveu investimentos para esta conexão. */
  investmentsAvailable: boolean;
  /**
   * Ajuste manual: o que o Open Finance não trouxe e o usuário somou aos investimentos.
   * `amount` 0 = sem ajuste.
   */
  manual: { amount: number; note: string | null; date: string | null };
  /** Só o que veio da Pluggy (sem o ajuste manual). */
  reportedInvestments: number;
  /** Últimos 12 meses, do mais antigo ao atual. Meses passados são estimados a partir das movimentações. */
  history: WealthPoint[];
  totals: {
    accounts: number;
    /** Investimentos da Pluggy + ajuste manual. */
    investments: number;
    total: number;
    /** Diferença entre o total de hoje e o do primeiro mês do histórico. */
    change: number;
    /** Soma do que os investimentos ativos renderam desde a aplicação (bruto); `null` se nenhum informar. */
    profit: number | null;
    /**
     * Soma do rendimento previsto no mês (CDI oficial × % de cada caixinha).
     * `null` quando nenhuma posição trouxe `rate` da Pluggy ou o CDI não pôde ser lido.
     */
    expectedMonthProfit: number | null;
    /** CDI anual usado no previsto (%), ex.: 13.65. */
    cdiAnnual: number | null;
    /**
     * Rendimento medido no mês atual por snapshot (Δsaldo − aplicações/resgates).
     * `null` até haver um snapshot de outro dia.
     */
    monthProfit: number | null;
    /** Data (yyyy-mm-dd) do snapshot usado como base do `monthProfit`. */
    monthProfitFrom: string | null;
  };
}

export interface SetWealthManualRequest {
  /** `null` ou 0 remove o ajuste. */
  amount: number | null;
  note: string | null;
  /** yyyy-mm-dd; data de entrada do valor adicional. */
  date: string | null;
}

// Contas recorrentes

export interface SetRecurringRequest {
  key: string;
  label: string;
  recurring: boolean;
}

/** `expected: null` volta a usar a média. */
export interface SetExpectedRequest {
  id: string;
  expected: number | null;
}

/** Adiciona pagadores/recebedores (automáticas) e remove contas (por `id`) de uma vez. */
export interface UpdateRecurringRequest {
  add: { key: string; label: string }[];
  remove: string[];
}

/** Vínculo: `key` (pagador/recebedor ou CPF/CNPJ), `matchName` (nome digitado) ou nenhum. */
export interface CreateRecurringRequest {
  label: string;
  expected: number;
  day: number;
  key: string | null;
  matchName: string | null;
  linkLabel: string | null;
  /** Transação escolhida na busca: já fica confirmada como pagamento da conta. */
  paidTransaction: { id: string; month: string } | null;
}

export interface EditRecurringRequest extends CreateRecurringRequest {
  id: string;
}

/** Resposta ao "essa transação é referente a esta conta?". */
export interface ConfirmRecurringRequest {
  billId: string;
  transactionId: string;
  month: string;
  paid: boolean;
}

/** Marca/desmarca como pago à mão uma conta sem vínculo. */
export interface MarkRecurringPaidRequest {
  billId: string;
  month: string;
  paid: boolean;
}

export interface RecurringPayment {
  id: string;
  date: string;
  amount: number;
}

/** Transação que parece ser o pagamento de uma conta manual e aguarda confirmação. */
export interface RecurringCandidate {
  id: string;
  date: string;
  amount: number;
  displayName: string;
}

export interface RecurringItem {
  id: string;
  key: string | null;
  /** Vínculo por nome (contas manuais). */
  matchName: string | null;
  manual: boolean;
  /** Descrição personalizada ou nome original. */
  name: string;
  /** Nome original, vindo do banco. */
  original: string;
  alias: string | null;
  tagId: string | null;
  /** Valor fixado pelo usuário; `null` = usa `average`. */
  expected: number | null;
  /** Média mensal nos meses do histórico em que houve pagamento. */
  average: number;
  /** Meses do histórico com pagamento. */
  months: number;
  /** Vencimento (manuais) ou dia em que costuma ser pago (automáticas); `null` sem histórico. */
  day: number | null;
  /** Total pago no período selecionado. */
  paid: number;
  payments: RecurringPayment[];
  /** Marcada como paga à mão no período (contas sem vínculo). */
  manualPaid: boolean;
  /** Transações que aguardam o "é desta conta?". */
  candidates: RecurringCandidate[];
}

export interface SearchableTransaction {
  id: string;
  date: string;
  amount: number;
  key: string;
  /** Descrição personalizada ou nome original. */
  name: string;
  original: string;
}

/** Pagador/recebedor que já apareceu numa saída, para vincular a uma conta manual. */
export interface CounterpartyOption {
  key: string;
  name: string;
  original: string;
  lastAmount: number;
  lastDate: string;
}

/** Pagador/recebedor pago uma vez por mês, em dia e valor parecidos. */
export interface RecurringSuggestion {
  key: string;
  name: string;
  original: string;
  /** Meses que seguem o padrão. */
  months: number;
  average: number;
  /** Dia do mês em que costuma ser pago. */
  day: number;
}

export interface RecurringResponse {
  range: DateRange;
  /** Quantidade de meses completos antes do período usados para médias e sugestões. */
  historyMonths: number;
  items: RecurringItem[];
  /** Contas com padrão mensal no histórico que ainda não são recorrentes. */
  suggestions: RecurringSuggestion[];
  /** Quem recebeu saídas no histórico + período, da mais recente para a mais antiga. */
  counterparties: CounterpartyOption[];
  /** Saídas do histórico + período, da mais recente para a mais antiga, para buscar por nome e valor. */
  transactions: SearchableTransaction[];
  totals: {
    /** Soma do valor esperado de todas as contas: o gasto fixo mensal. */
    expected: number;
    paid: number;
    /** Valor esperado das contas ainda sem pagamento no período. */
    pending: number;
  };
}

type NoBody = Record<string, never>;

/** Contrato de cada rota: corpo da requisição e resposta de sucesso. */
export interface ApiRoutes {
  "GET /api/status": { body: undefined; response: StatusResponse };
  "GET /api/settings": { body: undefined; response: SettingsResponse };
  "GET /api/tags": { body: undefined; response: TagsResponse };
  "POST /api/credentials": { body: CredentialsRequest; response: OkResponse };
  "POST /api/connect-token": { body: NoBody; response: ConnectTokenResult };
  "POST /api/item": { body: ItemRequest; response: OkResponse };
  "POST /api/disconnect": { body: NoBody; response: OkResponse };
  "POST /api/reset": { body: NoBody; response: OkResponse };
  "POST /api/period": { body: PeriodRequest; response: PeriodResponse };
  "POST /api/wealth": { body: { refresh?: boolean }; response: WealthResponse };
  "POST /api/wealth/manual": { body: SetWealthManualRequest; response: WealthResponse };
  "POST /api/yield/override": { body: SetYieldOverrideRequest; response: OkResponse };
  "POST /api/card": { body: PeriodRequest; response: CardResponse };
  "POST /api/tags/create": { body: CreateTagRequest; response: Tag };
  "POST /api/tags/update": { body: UpdateTagRequest; response: Tag };
  "POST /api/tags/delete": { body: DeleteTagRequest; response: OkResponse };
  "POST /api/rules/set": { body: SetRuleRequest; response: OkResponse };
  "POST /api/filters/upsert": { body: UpsertTagFilterRequest; response: TagFilter };
  "POST /api/filters/delete": { body: DeleteTagFilterRequest; response: OkResponse };
  "POST /api/refunds/set": { body: SetRefundRequest; response: OkResponse };
  "POST /api/aliases/set": { body: SetAliasRequest; response: OkResponse };
  "POST /api/recurring": { body: PeriodRequest; response: RecurringResponse };
  "POST /api/recurring/set": { body: SetRecurringRequest; response: OkResponse };
  "POST /api/recurring/expected": { body: SetExpectedRequest; response: OkResponse };
  "POST /api/recurring/update": { body: UpdateRecurringRequest; response: OkResponse };
  "POST /api/recurring/create": { body: CreateRecurringRequest; response: OkResponse };
  "POST /api/recurring/edit": { body: EditRecurringRequest; response: OkResponse };
  "POST /api/recurring/confirm": { body: ConfirmRecurringRequest; response: OkResponse };
  "POST /api/recurring/mark-paid": { body: MarkRecurringPaidRequest; response: OkResponse };
}

export type ApiRoute = keyof ApiRoutes;
