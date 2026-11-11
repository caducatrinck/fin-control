import type { Account, Bill, Transaction } from "./pluggy/types.ts";
import { planKeyOf } from "./refunds.ts";
import {
  DEFAULT_CARD_SETTINGS,
  type BillOverride,
  type BillReconciliation,
  type CardSettings,
  type ProjectedInstallment,
} from "./shared/api.ts";
import type {
  CardBill,
  CardBudget,
  CardInfo,
  CardPurchase,
  CardResponse,
  CardSpender,
  DateRange,
  PeriodTransaction,
  TagTotal,
} from "./shared/api.ts";
import { looksLikeSalary } from "./transactions.ts";

/** Faturas passadas no gráfico, contando a do mês atual. */
export const CARD_MONTHS = 12;

const round = (value: number): number => Math.round(value * 100) / 100;

/** Soma `delta` meses a um yyyy-mm. */
export function addMonths(month: string, delta: number): string {
  const [year = 0, mon = 1] = month.split("-").map(Number);
  return new Date(Date.UTC(year, mon - 1 + delta, 1)).toISOString().slice(0, 7);
}

/** Primeiro dia a buscar: cobre o gráfico e as compras que caem nas faturas do período selecionado. */
export function cardStart(today: Date, from: string): string {
  const current = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  const chart = addMonths(current, -(CARD_MONTHS + 1));
  const selected = addMonths(from.slice(0, 7), -2);
  return `${chart < selected ? chart : selected}-01`;
}

const dayOf = (date: string | null | undefined): number | null => {
  const day = date ? Number(date.slice(8, 10)) : NaN;
  return day >= 1 && day <= 31 ? day : null;
};

interface Cycle {
  closeDay: number | null;
  dueDay: number | null;
}

/** Mês de vencimento estimado de uma compra feita em `date`, pelo dia de fechamento/vencimento do cartão. */
function estimateDueMonth(date: string, { closeDay, dueDay }: Cycle): string {
  const month = date.slice(0, 7);
  if (closeDay === null || dueDay === null) return addMonths(month, 1);
  const closeMonth = Number(date.slice(8, 10)) <= closeDay ? month : addMonths(month, 1);
  return dueDay > closeDay ? closeMonth : addMonths(closeMonth, 1);
}

/** Parcelas futuras às vezes vêm com a data da compra original: empurra para o mês da parcela. */
function installmentDate(t: Transaction): string {
  const meta = t.creditCardMetadata;
  const n = meta?.installmentNumber ?? 1;
  const purchase = meta?.purchaseDate?.slice(0, 10);
  if (n <= 1 || !purchase || purchase.slice(0, 7) !== t.date.slice(0, 7)) return t.date;
  return `${addMonths(t.date.slice(0, 7), n - 1)}${t.date.slice(7, 10)}`;
}

export interface CardInput {
  accounts: readonly Account[];
  raw: readonly Transaction[];
  transactions: readonly PeriodTransaction[];
  bills: ReadonlyMap<string, readonly Bill[]>;
  billsAvailable: boolean;
  range: DateRange;
  today: Date;
  /** Gasto fixo mensal (contas recorrentes). */
  fixedMonthly: number;
  /** Projeção de parcelas ausentes (desligada por padrão) e janela de estornos. */
  settings?: CardSettings;
  /** Valor real da fatura informado pelo usuário, por cartão e mês. */
  billOverrides?: readonly BillOverride[];
}

const FORECAST_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const signed = (t: Pick<Transaction, "type" | "amount">): number => (t.type === "DEBIT" ? Math.abs(t.amount) : -Math.abs(t.amount));

const isBillPayment = (t: Transaction): boolean =>
  t.operationType === "PAGAMENTO_FATURA" || /pagamento recebido/i.test(t.description);

/**
 * Compara a soma das transações da fatura com o `totalAmount` e só "explica" a diferença quando algum item
 * do que a Pluggy informa (encargos, pagamentos) a fecha exatamente (±R$ 0,02). Não inventa causa.
 * Candidatos, com o efeito que teriam sobre o total: encargos (+), pagamentos feitos até o fechamento (−) e
 * "Pagamento recebido" lançado dentro da própria fatura (−).
 */
export function reconcileBill(bill: Bill, raw: readonly Transaction[]): BillReconciliation {
  const mine = raw.filter((t) => t.creditCardMetadata?.billId === bill.id);
  const transactionsTotal = round(mine.filter((t) => !isBillPayment(t)).reduce((acc, t) => acc + signed(t), 0));
  const received = round(mine.filter(isBillPayment).reduce((acc, t) => acc + Math.abs(t.amount), 0));
  const financeCharges = round((bill.financeCharges ?? []).reduce((acc, f) => acc + Math.abs(f.amount ?? 0), 0));
  const payments = (bill.payments ?? []).map((p) => ({
    date: p.paymentDate.slice(0, 10),
    amount: round(p.amount),
    kind: p.valueType ?? null,
  }));
  const closing = bill.billClosingDate?.slice(0, 10) ?? null;
  const early = round(payments.filter((p) => closing !== null && p.date <= closing).reduce((acc, p) => acc + p.amount, 0));
  const difference = round(bill.totalAmount - transactionsTotal);

  const candidates: { label: string; amount: number }[] = [];
  if (financeCharges) candidates.push({ label: "encargos financeiros (financeCharges)", amount: financeCharges });
  if (early) candidates.push({ label: "pagamentos feitos até o fechamento (payments)", amount: -early });
  if (received) candidates.push({ label: "\"Pagamento recebido\" lançado na própria fatura", amount: -received });

  let explainedBy: { label: string; amount: number }[] = [];
  let explained = Math.abs(difference) < 0.02;
  if (!explained) {
    // Poucos candidatos: testa todos os subconjuntos, do menor para o maior.
    const subsets: { label: string; amount: number }[][] = [];
    for (let mask = 1; mask < 1 << candidates.length; mask++) {
      subsets.push(candidates.filter((_, i) => mask & (1 << i)));
    }
    subsets.sort((a, b) => a.length - b.length);
    const hit = subsets.find((set) => Math.abs(set.reduce((acc, c) => acc + c.amount, 0) - difference) < 0.02);
    if (hit) {
      explainedBy = hit;
      explained = true;
    }
  }
  return { transactionsTotal, totalAmount: round(bill.totalAmount), difference, financeCharges, payments, explainedBy, explained };
}

/** Fatura fechada: fechamento real já passou (sem ele, vencimento já passou). */
function isBillClosed(bill: Bill, todayIso: string): boolean {
  return (bill.billClosingDate ?? bill.dueDate).slice(0, 10) <= todayIso;
}

/** Salário do período: entradas que parecem salário; senão a maior entrada. */
export function detectSalary(transactions: readonly PeriodTransaction[], range: DateRange): Pick<CardBudget, "salary" | "salarySource"> {
  const inRange = transactions.filter(
    (t) =>
      !t.internal &&
      !t.cancelled &&
      !t.refund &&
      t.direction === "in" &&
      t.date.slice(0, 10) >= range.from &&
      t.date.slice(0, 10) <= range.to,
  );
  const salaryHits = inRange.filter(looksLikeSalary);
  if (salaryHits.length) {
    return { salary: round(salaryHits.reduce((acc, t) => acc + t.amount, 0)), salarySource: "salary" };
  }
  const largest = inRange.reduce<PeriodTransaction | null>((best, t) => (!best || t.amount > best.amount ? t : best), null);
  return largest ? { salary: round(largest.amount), salarySource: "largest-income" } : { salary: null, salarySource: null };
}

export function buildCardBudget(
  salary: number | null,
  salarySource: CardBudget["salarySource"],
  fixedMonthly: number,
  bill: number,
): CardBudget {
  const fixed = round(Math.max(0, fixedMonthly));
  const room = salary === null ? null : round(salary - fixed);
  return {
    salary,
    salarySource,
    fixed,
    room,
    bill: round(bill),
    remaining: room === null ? null : round(room - bill),
  };
}

/**
 * Faturas por mês de vencimento, somando todos os cartões.
 * Cada compra vai para a fatura informada pela Pluggy (`billId`) ou, sem ela, para a estimada pelo ciclo do cartão.
 * `total` é a soma das compras menos estornos (bate com a lista). `closedAmount` é o valor oficial da fatura
 * na Pluggy; a UI explica a diferença (pagamento antecipado ou encargos fora das compras).
 */
export function buildCard(input: CardInput): CardResponse {
  const { accounts, raw, transactions, bills, billsAvailable, range, today, fixedMonthly } = input;
  const credit = accounts.filter((a) => a.type === "CREDIT");
  const cycles = new Map<string, Cycle>(
    credit.map((a) => [
      a.id,
      { closeDay: dayOf(a.creditData?.balanceCloseDate), dueDay: dayOf(a.creditData?.balanceDueDate) },
    ]),
  );
  const billById = new Map<string, Bill>();
  for (const list of bills.values()) for (const bill of list) billById.set(bill.id, bill);
  const rawById = new Map(raw.map((t) => [t.id, t]));
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const purchases = transactions
    // Compra (saída) ou reembolso; parcela cancelada / crédito marcado como entrada ficam fora.
    .filter((t) => cycles.has(t.accountId) && !t.internal && !t.cancelled && (t.direction === "out" || t.refund))
    .map((t) => {
      const source = rawById.get(t.id);
      const meta = source?.creditCardMetadata;
      const bill = meta?.billId ? billById.get(meta.billId) : undefined;
      const cycle = cycles.get(t.accountId) ?? { closeDay: null, dueDay: null };
      const total = meta?.totalInstallments ?? 0;
      const forecast = meta?.billForecastDate && FORECAST_MONTH.test(meta.billForecastDate) ? meta.billForecastDate : null;
      // Fatura da Pluggy > mês previsto pela própria Pluggy (billForecastDate) > estimativa pelo ciclo do cartão.
      let dueMonth = bill
        ? bill.dueDate.slice(0, 7)
        : (forecast ?? estimateDueMonth(source ? installmentDate(source) : t.date, cycle));
      let forecasted = !bill && forecast !== null;
      // Estorno sem fatura própria pareado a uma compra de fatura já FECHADA: o banco abate aquela fatura
      // (o pagamento sai líquido do estorno), então ele não pode pesar de novo na próxima.
      if (t.refund && !bill && t.refundLink?.status === "linked" && t.refundLink.purchaseId) {
        const originBillId = rawById.get(t.refundLink.purchaseId)?.creditCardMetadata?.billId;
        const originBill = originBillId ? billById.get(originBillId) : undefined;
        if (originBill && isBillClosed(originBill, todayIso) && originBill.dueDate.slice(0, 7) < dueMonth) {
          dueMonth = originBill.dueDate.slice(0, 7);
          forecasted = false;
        }
      }
      const purchase: CardPurchase = {
        id: t.id,
        date: t.date,
        amount: t.refund ? -t.amount : t.amount,
        displayName: t.displayName,
        counterpartyKey: t.counterpartyKey,
        counterpartyName: t.counterpartyName,
        tagId: t.tagId,
        cardName: t.accountName,
        installment: total > 1 ? `${meta?.installmentNumber ?? 1}/${total}` : null,
        refundLink: t.refundLink,
      };
      return { purchase, dueMonth, accountId: t.accountId, forecasted, source };
    });

  const estimatedByMonth = new Map<string, number>();
  const cardTotalByMonth = new Map<string, Map<string, number>>();
  const forecastCountByMonth = new Map<string, number>();
  for (const { purchase, dueMonth, accountId, forecasted } of purchases) {
    estimatedByMonth.set(dueMonth, (estimatedByMonth.get(dueMonth) ?? 0) + purchase.amount);
    const perCard = cardTotalByMonth.get(dueMonth) ?? new Map<string, number>();
    perCard.set(accountId, (perCard.get(accountId) ?? 0) + purchase.amount);
    cardTotalByMonth.set(dueMonth, perCard);
    if (forecasted) forecastCountByMonth.set(dueMonth, (forecastCountByMonth.get(dueMonth) ?? 0) + 1);
  }
  const billsByMonth = new Map<string, Bill[]>();
  for (const bill of billById.values()) {
    const month = bill.dueDate.slice(0, 7);
    billsByMonth.set(month, [...(billsByMonth.get(month) ?? []), bill]);
  }
  const settings = input.settings ?? DEFAULT_CARD_SETTINGS;
  const overrides = input.billOverrides ?? [];

  // Planos conhecidos (todos os números de parcela vistos), para não projetar o que a API já tem ou cancelou.
  const knownNumbers = new Map<string, Set<number>>();
  for (const t of raw) {
    const key = t.type === "DEBIT" ? planKeyOf(t) : null;
    if (!key) continue;
    const numbers = knownNumbers.get(key) ?? new Set<number>();
    numbers.add(t.creditCardMetadata?.installmentNumber ?? 0);
    knownNumbers.set(key, numbers);
  }
  /** Próxima parcela de planos com n < total na fatura anterior que ainda não existe na API. É estimativa. */
  const projectionFor = (month: string): ProjectedInstallment[] => {
    const latest = new Map<string, { source: Transaction; accountId: string }>();
    for (const p of purchases) {
      if (p.dueMonth !== addMonths(month, -1) || !p.source || p.source.type !== "DEBIT") continue;
      const key = planKeyOf(p.source);
      if (!key) continue;
      const n = p.source.creditCardMetadata?.installmentNumber ?? 0;
      const prev = latest.get(key);
      if (!prev || n > (prev.source.creditCardMetadata?.installmentNumber ?? 0)) latest.set(key, { source: p.source, accountId: p.accountId });
    }
    const out: ProjectedInstallment[] = [];
    for (const [key, { source, accountId }] of latest) {
      const n = source.creditCardMetadata?.installmentNumber ?? 0;
      const total = source.creditCardMetadata?.totalInstallments ?? 0;
      if (n < 1 || n >= total || knownNumbers.get(key)?.has(n + 1)) continue;
      out.push({
        accountId,
        description: source.description.replace(/\s+\d+\s*\/\s*\d+\s*$/, "").trim(),
        installment: `${n + 1}/${total}`,
        amount: round(Math.abs(source.amount)),
      });
    }
    return out.sort((a, b) => b.amount - a.amount);
  };
  const officialByMonth = new Map<string, { total: number; dueDate: string }>();
  for (const bill of billById.values()) {
    const month = bill.dueDate.slice(0, 7);
    const prev = officialByMonth.get(month);
    officialByMonth.set(month, {
      total: (prev?.total ?? 0) + bill.totalAmount,
      dueDate: prev && prev.dueDate < bill.dueDate ? prev.dueDate : bill.dueDate.slice(0, 10),
    });
  }
  const dueDays = [...cycles.values()].map((c) => c.dueDay).filter((d): d is number => d !== null);
  const creditIds = credit.map((a) => a.id);
  /** Campos comuns da fatura: valor informado pelo usuário, projeção (opcional) e conferência da fatura fechada. */
  const extras = (
    month: string,
    total: number,
    open: boolean,
  ): Omit<CardBill, "month" | "total" | "closedAmount" | "dueDate" | "estimated"> => {
    const mine = overrides.filter((o) => o.month === month && creditIds.includes(o.accountId));
    const perCard = cardTotalByMonth.get(month);
    const bankAmount = mine.length
      ? round(creditIds.reduce((acc, id) => acc + (mine.find((o) => o.accountId === id)?.amount ?? perCard?.get(id) ?? 0), 0))
      : null;
    const projected = open && settings.projectInstallments ? projectionFor(month) : [];
    const projectedTotal = round(projected.reduce((acc, p) => acc + p.amount, 0));
    const recs = (billsByMonth.get(month) ?? []).map((b) => reconcileBill(b, raw));
    const first = recs[0];
    const reconciliation: BillReconciliation | null =
      recs.length === 1 && first
        ? first
        : recs.length > 1
          ? {
              transactionsTotal: round(recs.reduce((acc, r) => acc + r.transactionsTotal, 0)),
              totalAmount: round(recs.reduce((acc, r) => acc + r.totalAmount, 0)),
              difference: round(recs.reduce((acc, r) => acc + r.difference, 0)),
              financeCharges: round(recs.reduce((acc, r) => acc + r.financeCharges, 0)),
              payments: recs.flatMap((r) => r.payments),
              explainedBy: [],
              explained: recs.every((r) => r.explained),
            }
          : null;
    return {
      bankAmount,
      difference: bankAmount === null ? null : round(bankAmount - total),
      overrides: mine.map((o) => ({ accountId: o.accountId, amount: o.amount })),
      forecastCount: forecastCountByMonth.get(month) ?? 0,
      projected,
      projectedTotal,
      differenceWithProjection: bankAmount === null || !projected.length ? null : round(bankAmount - (total + projectedTotal)),
      reconciliation,
    };
  };
  const billFor = (month: string): CardBill => {
    const official = officialByMonth.get(month);
    const spent = estimatedByMonth.get(month);
    if (official) {
      // `total` = soma das compras/estornos (bate com a lista). `closedAmount` = valor oficial da fatura.
      const total = round(spent ?? official.total);
      return {
        month,
        total,
        closedAmount: round(official.total),
        dueDate: official.dueDate,
        estimated: false,
        ...extras(month, total, false),
      };
    }
    const day = dueDays.length ? Math.min(...dueDays) : null;
    const total = round(spent ?? 0);
    return {
      month,
      total,
      closedAmount: null,
      dueDate: day === null ? null : `${month}-${String(day).padStart(2, "0")}`,
      estimated: true,
      ...extras(month, total, true),
    };
  };

  const current = todayIso.slice(0, 7);
  const openMonths = credit.map((a) => estimateDueMonth(todayIso, cycles.get(a.id) ?? { closeDay: null, dueDay: null }));
  const nextMonth = openMonths.sort()[0] ?? addMonths(current, 1);
  const lastMonth = nextMonth > addMonths(current, 1) ? nextMonth : addMonths(current, 1);
  const history: CardBill[] = [];
  for (let month = addMonths(current, -(CARD_MONTHS - 1)); month <= lastMonth; month = addMonths(month, 1)) {
    history.push(billFor(month));
  }

  const months: string[] = [];
  for (let month = range.from.slice(0, 7); month <= range.to.slice(0, 7); month = addMonths(month, 1)) months.push(month);
  const monthSet = new Set(months);
  const selectedBills = months.map(billFor);
  const selectedPurchases = purchases
    .filter((p) => monthSet.has(p.dueMonth))
    .map((p) => p.purchase)
    .sort((a, b) => b.amount - a.amount);

  const spenders = new Map<string, CardSpender>();
  const tags = new Map<string | null, TagTotal>();
  for (const p of selectedPurchases) {
    const spender = spenders.get(p.counterpartyKey) ?? { key: p.counterpartyKey, name: p.displayName, total: 0, count: 0 };
    spender.total += p.amount;
    spender.count += 1;
    spenders.set(p.counterpartyKey, spender);
    const tag = tags.get(p.tagId) ?? { tagId: p.tagId, total: 0, count: 0 };
    tag.total += p.amount;
    tag.count += 1;
    tags.set(p.tagId, tag);
  }

  const cards: CardInfo[] = credit.map((a) => ({
    id: a.id,
    name: a.name,
    creditLimit: a.creditData?.creditLimit ?? null,
    availableCreditLimit: a.creditData?.availableCreditLimit ?? null,
  }));
  const next = credit.length ? billFor(nextMonth) : null;
  const billTotal = round(selectedBills.reduce((acc, b) => acc + b.total, 0));
  const { salary, salarySource } = detectSalary(transactions, range);

  return {
    range,
    cards,
    billsAvailable,
    bills: history,
    selected: {
      months,
      total: billTotal,
      closedAmount: selectedBills.every((b) => b.closedAmount !== null)
        ? round(selectedBills.reduce((acc, b) => acc + (b.closedAmount ?? 0), 0))
        : null,
      dueDate: selectedBills.length === 1 ? (selectedBills[0]?.dueDate ?? null) : null,
      estimated: selectedBills.some((b) => b.estimated),
      purchases: selectedPurchases,
      topSpenders: [...spenders.values()]
        .filter((s) => s.total !== 0)
        .map((s) => ({ ...s, total: round(s.total) }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 10),
      byTag: [...tags.values()]
        .filter((t) => t.total !== 0)
        .map((t) => ({ ...t, total: round(t.total) }))
        .sort((a, b) => b.total - a.total),
    },
    next,
    settings,
    linkable: purchases
      .map((p) => p.purchase)
      .filter((p) => p.amount > 0)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 300),
    budget: buildCardBudget(salary, salarySource, fixedMonthly, billTotal),
  };
}
