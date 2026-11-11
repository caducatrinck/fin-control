import type { Account, AccountType, Transaction } from "./pluggy/types.ts";
import {
  MOVEMENT_PREFIX,
  type Alias,
  type Direction,
  type Movement,
  type PeriodTransaction,
  type RefundLink,
  type TagFilter,
  type TagRule,
} from "./shared/api.ts";
import { isIofText, isRefundCredit, planKeyOf, type RefundMatch } from "./refunds.ts";
export { cashflowOf, computeTotals, expenseImpactOf, expensesByTag, roundMoney } from "./shared/totals.ts";

const INTERNAL_CATEGORY =
  /same person|mesma titularidade|credit card payment|transfer\s*-\s*internal|pagamento de (fatura|cart[aã]o)|investment|investimento/i;
const INTERNAL_DESCRIPTION =
  /pagamento (de )?fatura|pgto\.? fatura|pagamento recebido|valor adicionado na conta por cart[aã]o|valor recebido de investimentos?|aplica[cç][aã]o|resgate|caixinha|\brdb\b|\bcdb\b|tesouro/i;
const SALARY = /sal[aá]rio|salary|payroll|portabilidade|proventos|folha de pagamento|pagamento de sal/i;

const onlyDigits = (value: string): string => value.replace(/\D/g, "");

/** Número da conta só com dígitos e sem zeros à esquerda; ignora a agência ("0001/12345-6" → "123456"). */
function accountKey(value: string | null | undefined): string {
  const lastSegment = value?.split("/").at(-1) ?? "";
  return onlyDigits(lastSegment).replace(/^0+/, "");
}

/** Números das contas conectadas, para distinguir transferências entre elas das que vêm de fora. */
export function connectedAccountKeys(accounts: readonly Account[]): Set<string> {
  const keys = new Set<string>();
  for (const acc of accounts) {
    for (const value of [acc.number, acc.bankData?.transferNumber]) {
      const key = accountKey(value);
      if (key) keys.add(key);
    }
  }
  return keys;
}

/** Descrição sem acentos, números, pontuação e espaços extras: "PIX ENVIADO - João 12/09" → "pix enviado joao". */
export function normalizeDescription(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const directionOf = (t: Transaction): Direction => (t.type === "CREDIT" ? "in" : "out");

function isSamePerson(t: Transaction): boolean {
  const payerDoc = t.paymentData?.payer?.documentNumber?.value;
  const receiverDoc = t.paymentData?.receiver?.documentNumber?.value;
  return Boolean(payerDoc && receiverDoc && onlyDigits(payerDoc) === onlyDigits(receiverDoc));
}

const OPERATION = /^(transfer[eê]ncia|pix|ted|doc|tev|pagamento|compra|dep[oó]sito|recebimento|envio)\b/i;

/** "Transferência Recebida|FULANO" ou "Transferência enviada pelo Pix - FULANO - CPF - BANCO" viram "FULANO". */
function nameFromDescription(description: string): string {
  const parts = description
    .split(/\s*\|\s*|\s+[-–]\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const [operation, name] = parts;
  return operation && name && OPERATION.test(operation) ? name : description;
}

function counterparty(t: Transaction, direction: Direction): { key: string; name: string } {
  const participant = direction === "out" ? t.paymentData?.receiver : t.paymentData?.payer;
  const document = participant?.documentNumber?.value ?? t.merchant?.cnpj;
  const name =
    [participant?.name, t.merchant?.businessName, t.merchant?.name, nameFromDescription(t.description), t.description]
      .map((value) => value?.trim())
      .find((value) => value) ?? "Sem nome";

  const digits = document ? onlyDigits(document) : "";

  // Contas próprias se distinguem pela agência/conta: a conta-salário de outro banco não se mistura com as demais.
  if (digits && isSamePerson(t)) {
    const account = [participant?.branchNumber, participant?.accountNumber].filter(Boolean).join("/");
    return {
      key: `self:${digits}:${account || normalizeDescription(t.description)}`,
      name: account ? `${name} (conta própria ${account})` : `${name} (conta própria)`,
    };
  }

  if (digits.length === 11 || digits.length === 14) return { key: `doc:${digits}`, name };

  const normalized = normalizeDescription(t.description);
  return { key: `desc:${normalized || t.id}`, name };
}

function isSalary(t: Transaction): boolean {
  if (t.type !== "CREDIT") return false;
  return [t.category, t.description, t.descriptionRaw].some((text) => text != null && SALARY.test(text));
}

/** Entrada que parece salário (texto do extrato ou nome exibido). */
export function looksLikeSalary(
  t: Pick<PeriodTransaction, "direction" | "internal" | "category" | "description" | "displayName" | "counterpartyName">,
): boolean {
  if (t.internal || t.direction !== "in") return false;
  return [t.category, t.description, t.displayName, t.counterpartyName].some((text) => text != null && SALARY.test(text));
}

/**
 * Entrada vinda de uma conta própria que não está conectada (ex.: conta-salário em outro banco):
 * é dinheiro novo chegando, não transferência entre contas acompanhadas pelo app.
 */
function isFromUnconnectedOwnAccount(t: Transaction, connected: ReadonlySet<string>): boolean {
  if (directionOf(t) !== "in") return false;
  const source = accountKey(t.paymentData?.payer?.accountNumber);
  return source !== "" && !connected.has(source);
}

/** Motivo pelo qual a movimentação é considerada interna, ou null se ela conta nos totais. */
export function internalReason(t: Transaction, connected: ReadonlySet<string>): string | null {
  if (isSalary(t)) return null;
  if (isSamePerson(t)) {
    if (isFromUnconnectedOwnAccount(t, connected)) return null;
    return "transferência entre contas próprias conectadas";
  }
  const category = t.category ? INTERNAL_CATEGORY.exec(t.category) : null;
  if (category) return `categoria "${t.category}"`;
  const description = INTERNAL_DESCRIPTION.exec(t.description);
  if (description) return `descrição contém "${description[0]}"`;
  return null;
}

/** Cashback é renda/benefício, não estorno de uma compra. */
const CASHBACK = /cashback/i;
const REFUND = /estorno|reembolso|devolu[cç][aã]o|refund|chargeback/i;

function textFields(t: Transaction): readonly (string | null | undefined)[] {
  return [t.category, t.description, t.descriptionRaw];
}

/**
 * Estorno ou reembolso: crédito no cartão (exceto cashback e pagamento de fatura) ou entrada cujo texto indica devolução.
 * Salário e movimentações internas nunca são estorno.
 */
export function isRefund(t: Transaction, accountType: AccountType, internal: boolean): boolean {
  if (t.type !== "CREDIT" || internal || isSalary(t)) return false;
  if (textFields(t).some((text) => text != null && CASHBACK.test(text))) return false;
  if (accountType === "CREDIT") return true;
  if (t.operationType === "ESTORNO" || (t.category != null && /^estorno$/i.test(t.category))) return true;
  return textFields(t).some((text) => text != null && REFUND.test(text));
}

/** Decisão manual vale só para entradas fora dos totais internos; sem ela, vale a detecção automática. */
function refundOf(
  t: Transaction,
  accountType: AccountType,
  internal: boolean,
  overrides: ReadonlyMap<string, boolean> | undefined,
): boolean {
  const manual = overrides?.get(t.id);
  if (manual === undefined) return isRefund(t, accountType, internal);
  return manual && t.type === "CREDIT" && !internal;
}

const INVESTMENT_CATEGORY = /investment|investimento/i;
const INVESTMENT_DESCRIPTION = /valor recebido de investimentos?|aplica[cç][aã]o|resgate|caixinha|\brdb\b|\bcdb\b|tesouro/i;

/** Aplicação (saída da conta) ou resgate (entrada na conta) de investimento. */
export function isInvestmentMove(t: Transaction): boolean {
  return (t.category !== null && INVESTMENT_CATEGORY.test(t.category)) || INVESTMENT_DESCRIPTION.test(t.description);
}

/** Compras no cartão e boletos são "pagas"; Pix/transferências são "transferidas". */
function movementOf(t: Transaction, direction: Direction, accountType: AccountType): Movement {
  if (direction === "in") return "received";
  if (accountType === "CREDIT" || t.paymentData?.paymentMethod === "BOLETO") return "paid";
  if (t.paymentData?.paymentMethod) return "transferred";
  return t.merchant ? "paid" : "transferred";
}

export interface EnrichContext {
  accounts: ReadonlyMap<string, Pick<Account, "name" | "type">>;
  tagByKey: ReadonlyMap<string, string>;
  aliasByKey: ReadonlyMap<string, string>;
  filters: readonly TagFilter[];
  connected: ReadonlySet<string>;
  /** Decisão manual por transação: true = reembolso, false = não é. */
  refundById?: ReadonlyMap<string, boolean>;
  /** Parcelas futuras de compra já estornada (Pluggy ainda envia como débito). */
  cancelledIds?: ReadonlySet<string>;
  /** Estorno → compra original (ver `matchRefunds`); o estorno herda a tag e o nome da compra. */
  refundMatches?: ReadonlyMap<string, RefundMatch>;
}

const sameMoney = (a: number, b: number): boolean => Math.abs(Math.abs(a) - Math.abs(b)) < 0.02;

function plansOf(transactions: readonly Transaction[]): Map<string, Transaction[]> {
  const byPlan = new Map<string, Transaction[]>();
  for (const t of transactions) {
    if (t.type !== "DEBIT") continue;
    const key = planKeyOf(t);
    if (!key) continue;
    const list = byPlan.get(key);
    if (list) list.push(t);
    else byPlan.set(key, [t]);
  }
  return byPlan;
}

/** Parcelas posteriores ao estorno que nunca viraram fatura, com a fatura prevista de alguma já encerrada. */
function isStranded(later: readonly Transaction[], currentMonth: string, todayIso: string): boolean {
  const due = later.filter((t) => t.date.slice(0, 10) <= todayIso);
  if (due.length === 0 || due.some((t) => t.creditCardMetadata?.billId)) return false;
  return due.some((t) => {
    const forecast = t.creditCardMetadata?.billForecastDate;
    return forecast !== undefined && forecast !== null && forecast.slice(0, 7) < currentMonth;
  });
}

/**
 * Parcelas após um estorno que bate com a 1ª parcela do plano.
 * Nubank cancela o resto no app, mas a Pluggy segue mandando débitos PENDING.
 *
 * Sem `matches`, vale só essa heurística (estorno de valor igual ao da 1ª parcela).
 * Com `matches` (pareamento por conta/valor/loja/janela + decisões manuais):
 * - estorno vinculado a um plano cancela o resto só quando cobre o total do plano (somando estornos
 *   parciais); estorno parcial, inclusive de valor igual a uma parcela, só abate e não cancela nada;
 * - estorno pendente ou desvinculado à mão nunca cancela;
 * - exceção: estorno parcial também cancela o resto quando o plano está "encalhado", isto é, as parcelas
 *   posteriores nunca viraram fatura (sem `billId`) mesmo com a fatura prevista pela Pluggy já fechada.
 *   Parcela cobrada de verdade ganha `billId`; a que fica PENDING para sempre é o plano cancelado no banco.
 */
export function cancelledInstallmentIds(
  transactions: readonly Transaction[],
  matches?: ReadonlyMap<string, RefundMatch>,
  today: Date = new Date(),
): Set<string> {
  const currentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  const todayIso = `${currentMonth}-${String(today.getDate()).padStart(2, "0")}`;
  const byPlan = plansOf(transactions);
  const cancelled = new Set<string>();

  if (matches) {
    const refundedByPlan = new Map<string, { sum: number; lastDay: string; full: boolean }>();
    for (const m of matches.values()) {
      if (!m.purchase || m.plan.length === 0) continue;
      const key = planKeyOf(m.purchase);
      if (!key) continue;
      const acc = refundedByPlan.get(key) ?? { sum: 0, lastDay: "", full: false };
      acc.sum += Math.abs(m.refund.amount);
      acc.full ||= m.full;
      const day = m.refund.date.slice(0, 10);
      if (day > acc.lastDay) acc.lastDay = day;
      refundedByPlan.set(key, acc);
    }
    for (const [key, acc] of refundedByPlan) {
      const members = byPlan.get(key) ?? [];
      const first = [...members].sort(
        (a, b) => (a.creditCardMetadata?.installmentNumber ?? 0) - (b.creditCardMetadata?.installmentNumber ?? 0),
      )[0];
      const total = first ? Math.abs(first.amount) * (first.creditCardMetadata?.totalInstallments ?? members.length) : 0;
      const covers = acc.full || acc.sum >= total - 0.02 * Math.max(1, members.length);
      const later = members.filter((t) => t.date.slice(0, 10) > acc.lastDay);
      if (!covers && !isStranded(later, currentMonth, todayIso)) continue;
      for (const t of later) cancelled.add(t.id);
    }
  }

  // Heurística antiga (estorno de valor igual à 1ª parcela cancela o resto): só sem pareamento.
  const credits = matches ? [] : transactions.filter(isRefundCredit);

  for (const installments of byPlan.values()) {
    const sorted = [...installments].sort(
      (a, b) => (a.creditCardMetadata?.installmentNumber ?? 0) - (b.creditCardMetadata?.installmentNumber ?? 0),
    );
    const first = sorted[0];
    if (!first) continue;
    const purchaseDate = first.creditCardMetadata?.purchaseDate?.slice(0, 10) ?? first.date.slice(0, 10);
    const refund = credits.find(
      (c) =>
        c.accountId === first.accountId &&
        sameMoney(c.amount, first.amount) &&
        c.date.slice(0, 10) >= purchaseDate,
    );
    if (!refund) continue;
    const refundDay = refund.date.slice(0, 10);
    for (const t of sorted) {
      if (t.date.slice(0, 10) > refundDay) cancelled.add(t.id);
    }
  }
  return cancelled;
}

const sameCents = (a: number, b: number): boolean => Math.round(a * 100) === Math.round(b * 100);

/** Critérios do filtro são AND: todos os definidos precisam bater. */
export function matchesTagFilter(
  filter: TagFilter,
  amount: number,
  texts: readonly string[],
): boolean {
  if (filter.amount === null && !filter.contains) return false;
  if (filter.amount !== null && !sameCents(amount, filter.amount)) return false;
  if (filter.contains) {
    const needle = normalizeDescription(filter.contains);
    if (!needle) return false;
    const haystack = texts.map(normalizeDescription).join(" ");
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/** Filtro condicional tem prioridade sobre a regra por pagador/recebedor. */
function resolveTagId(
  key: string,
  amount: number,
  texts: readonly string[],
  ctx: EnrichContext,
): string | null {
  const hit = ctx.filters.find((f) => matchesTagFilter(f, amount, texts));
  if (hit) return hit.tagId;
  return ctx.tagByKey.get(key) ?? null;
}

function refundLinkOf(match: RefundMatch, ctx: EnrichContext): RefundLink {
  const { purchase, kind, refund } = match;
  if (!purchase || !kind) {
    return {
      status: "pending",
      kind: null,
      purchaseId: null,
      purchaseDate: null,
      purchaseName: null,
      partial: false,
      unlinked: match.unlinked,
    };
  }
  const { key, name } = counterparty(purchase, "out");
  return {
    status: "linked",
    kind,
    purchaseId: purchase.id,
    purchaseDate: purchase.creditCardMetadata?.purchaseDate ?? purchase.date,
    purchaseName: ctx.aliasByKey.get(key) ?? name,
    partial: !match.full && Math.abs(refund.amount) < Math.abs(purchase.amount) - 0.02,
    unlinked: false,
  };
}

export function enrichTransaction(t: Transaction, ctx: EnrichContext): PeriodTransaction {
  const account = ctx.accounts.get(t.accountId);
  const direction = directionOf(t);
  const movement = movementOf(t, direction, account?.type ?? "BANK");
  const own = counterparty(t, direction);
  const amount = Math.abs(t.amount);
  const cancelled = ctx.cancelledIds?.has(t.id) === true;
  const internal = !cancelled && internalReason(t, ctx.connected) !== null;
  const refund = !cancelled && refundOf(t, account?.type ?? "BANK", internal, ctx.refundById);
  const match = refund ? ctx.refundMatches?.get(t.id) : undefined;
  const purchase = match?.purchase ?? null;
  // Estorno vinculado herda a identidade e a tag da compra (menos o IOF, que tem texto próprio mais útil).
  const inherit = purchase !== null && !isIofText(purchase) ? counterparty(purchase, "out") : null;
  const { key, name } = inherit ?? own;
  const alias = ctx.aliasByKey.get(key) ?? null;
  const purchaseTag = purchase
    ? resolveTagId(counterparty(purchase, "out").key, Math.abs(purchase.amount), [counterparty(purchase, "out").name, purchase.description], ctx)
    : null;
  const prefix = cancelled ? "CANCELADA" : refund ? "ESTORNO" : MOVEMENT_PREFIX[movement];
  return {
    id: t.id,
    accountId: t.accountId,
    accountName: account?.name ?? "Conta",
    date: t.date,
    description: t.description,
    amount,
    direction,
    movement,
    category: t.category,
    counterpartyKey: key,
    counterpartyName: name,
    alias,
    displayName: `${prefix} - ${alias ?? name}`,
    tagId: purchaseTag ?? resolveTagId(key, amount, [name, alias ?? "", t.description], ctx),
    internal,
    refund,
    refundLink: match ? refundLinkOf(match, ctx) : null,
    cancelled,
  };
}

export function tagIndex(rules: readonly TagRule[]): Map<string, string> {
  return new Map(rules.map((r) => [r.key, r.tagId]));
}

export function aliasIndex(aliases: readonly Alias[]): Map<string, string> {
  return new Map(aliases.map((a) => [a.key, a.alias]));
}
