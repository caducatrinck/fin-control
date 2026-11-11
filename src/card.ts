import type { Account, Bill, Transaction } from "./pluggy/types.ts";
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
export function buildCard({
  accounts,
  raw,
  transactions,
  bills,
  billsAvailable,
  range,
  today,
  fixedMonthly,
}: CardInput): CardResponse {
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

  const purchases = transactions
    // Compra (saída) ou reembolso; parcela cancelada / crédito marcado como entrada ficam fora.
    .filter((t) => cycles.has(t.accountId) && !t.internal && !t.cancelled && (t.direction === "out" || t.refund))
    .map((t) => {
      const source = rawById.get(t.id);
      const meta = source?.creditCardMetadata;
      const bill = meta?.billId ? billById.get(meta.billId) : undefined;
      const cycle = cycles.get(t.accountId) ?? { closeDay: null, dueDay: null };
      const dueMonth = bill ? bill.dueDate.slice(0, 7) : estimateDueMonth(source ? installmentDate(source) : t.date, cycle);
      const total = meta?.totalInstallments ?? 0;
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
      };
      return { purchase, dueMonth };
    });

  const estimatedByMonth = new Map<string, number>();
  for (const { purchase, dueMonth } of purchases) {
    estimatedByMonth.set(dueMonth, (estimatedByMonth.get(dueMonth) ?? 0) + purchase.amount);
  }
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
  const billFor = (month: string): CardBill => {
    const official = officialByMonth.get(month);
    const spent = estimatedByMonth.get(month);
    if (official) {
      // `total` = soma das compras/estornos (bate com a lista). `closedAmount` = valor oficial da fatura.
      return {
        month,
        total: round(spent ?? official.total),
        closedAmount: round(official.total),
        dueDate: official.dueDate,
        estimated: false,
      };
    }
    const day = dueDays.length ? Math.min(...dueDays) : null;
    return {
      month,
      total: round(spent ?? 0),
      closedAmount: null,
      dueDate: day === null ? null : `${month}-${String(day).padStart(2, "0")}`,
      estimated: true,
    };
  };

  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
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
    budget: buildCardBudget(salary, salarySource, fixedMonthly, billTotal),
  };
}
