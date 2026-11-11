import type {
  CounterpartyOption,
  DateRange,
  SearchableTransaction,
  PeriodTransaction,
  RecurringBill,
  RecurringItem,
  RecurringMatch,
  RecurringResponse,
  RecurringSuggestion,
} from "./shared/api.ts";
import { normalizeDescription } from "./transactions.ts";

/** Meses completos antes do período usados para médias e sugestões. */
export const HISTORY_MONTHS = 6;
/** Meses com o mesmo padrão (1 pagamento, dia e valor parecidos) para virar sugestão. */
const MIN_PATTERN_MONTHS = 3;
/** Distância máxima, em dias do mês, do dia usual de pagamento. */
const DAY_TOLERANCE = 15;
/** Variação máxima do valor em relação ao valor usual. */
const AMOUNT_TOLERANCE = 0.2;
/** Parte mínima dos meses com pagamento que precisa seguir o padrão. */
const MIN_PATTERN_SHARE = 0.7;
/** Conta manual: variação máxima do valor e distância do vencimento para perguntar "é desta conta?". */
const CANDIDATE_AMOUNT_TOLERANCE = 0.1;
const CANDIDATE_DAY_TOLERANCE = 7;

interface HistoryPayment {
  month: string;
  day: number;
  amount: number;
}

interface MonthlyPattern {
  /** Dia do mês em que costuma ser pago. */
  day: number;
  /** Valor usual (mediana). */
  amount: number;
  /** Meses que seguem o padrão. */
  months: number;
  /** Média dos valores dos meses que seguem o padrão. */
  average: number;
}

const round = (value: number): number => Math.round(value * 100) / 100;

const sum = (values: Iterable<number>): number => {
  let total = 0;
  for (const value of values) total += value;
  return total;
};

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Distância entre dias do mês considerando a virada (dia 30 e dia 1 estão a 2 dias). */
function dayDistance(a: number, b: number): number {
  const diff = Math.abs(a - b);
  return Math.min(diff, 31 - diff);
}

/** Primeiro dia do mês que fica `HISTORY_MONTHS` meses antes do mês de `from` (yyyy-mm-dd). */
export function historyStart(from: string): string {
  const [year = 0, month = 1] = from.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 - HISTORY_MONTHS, 1)).toISOString().slice(0, 10);
}

/** Dia do mês que tem mais pagamentos a até `DAY_TOLERANCE` dias dele. */
function usualDay(days: readonly number[]): number | null {
  let best: number | null = null;
  let bestCount = 0;
  for (const center of days) {
    const count = days.filter((d) => dayDistance(d, center) <= DAY_TOLERANCE).length;
    if (count > bestCount) {
      best = center;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Conta mensal: no máximo um pagamento por mês, em dia parecido e com valor parecido.
 * Quem aparece várias vezes no mesmo mês (restaurante, transporte) não tem padrão.
 */
function monthlyPattern(payments: readonly HistoryPayment[]): MonthlyPattern | null {
  const byMonth = new Map<string, HistoryPayment[]>();
  for (const p of payments) byMonth.set(p.month, [...(byMonth.get(p.month) ?? []), p]);

  const single = [...byMonth.values()].filter((list) => list.length === 1).flat();
  if (single.length < MIN_PATTERN_MONTHS || single.length < byMonth.size * MIN_PATTERN_SHARE) return null;

  const day = usualDay(single.map((p) => p.day));
  if (day === null) return null;
  const amount = median(single.map((p) => p.amount));
  const matching = single.filter(
    (p) => dayDistance(p.day, day) <= DAY_TOLERANCE && Math.abs(p.amount - amount) <= amount * AMOUNT_TOLERANCE,
  );
  if (matching.length < MIN_PATTERN_MONTHS || matching.length < byMonth.size * MIN_PATTERN_SHARE) return null;

  return {
    day,
    amount: round(amount),
    months: matching.length,
    average: round(sum(matching.map((p) => p.amount)) / matching.length),
  };
}

/** Meses (yyyy-mm) cobertos pelo período. */
function monthsBetween({ from, to }: DateRange): Set<string> {
  const months = new Set<string>();
  const [year = 0, month = 1] = from.split("-").map(Number);
  for (let i = 0; ; i++) {
    const current = new Date(Date.UTC(year, month - 1 + i, 1)).toISOString().slice(0, 7);
    if (current > to.slice(0, 7)) break;
    months.add(current);
  }
  return months;
}

function monthlyAverage(payments: readonly HistoryPayment[]): { average: number; months: number } {
  const totals = new Map<string, number>();
  for (const p of payments) totals.set(p.month, (totals.get(p.month) ?? 0) + p.amount);
  return { average: totals.size ? round(sum(totals.values()) / totals.size) : 0, months: totals.size };
}

/**
 * Monta a aba de recorrentes a partir das saídas (sem as internas) do histórico + período.
 * `transactions` deve cobrir de `historyStart(range.from)` até `range.to`.
 */
export function buildRecurring(
  transactions: readonly PeriodTransaction[],
  range: DateRange,
  bills: readonly RecurringBill[],
  matches: readonly RecurringMatch[],
): RecurringResponse {
  const historyByKey = new Map<string, HistoryPayment[]>();
  const paymentsByKey = new Map<string, PeriodTransaction[]>();
  const latestByKey = new Map<string, PeriodTransaction>();
  const searchable: SearchableTransaction[] = [];

  for (const t of transactions) {
    if (t.direction !== "out" || t.internal || t.cancelled) continue;
    searchable.push({
      id: t.id,
      date: t.date,
      amount: t.amount,
      key: t.counterpartyKey,
      name: t.alias ?? t.counterpartyName,
      original: t.counterpartyName,
    });
    const key = t.counterpartyKey;
    const date = t.date.slice(0, 10);
    const latest = latestByKey.get(key);
    if (!latest || latest.date < t.date) latestByKey.set(key, t);

    if (date >= range.from && date <= range.to) {
      paymentsByKey.set(key, [...(paymentsByKey.get(key) ?? []), t]);
    } else if (date < range.from) {
      const payment = { month: date.slice(0, 7), day: Number(date.slice(8, 10)), amount: t.amount };
      historyByKey.set(key, [...(historyByKey.get(key) ?? []), payment]);
    }
  }

  const current = [...paymentsByKey.values()].flat();
  const currentById = new Map(current.map((t) => [t.id, t]));
  /** Vínculo por pagador/recebedor (`key`) ou por nome contido no nome/descrição da transação. */
  const isLinked = (bill: RecurringBill, t: PeriodTransaction): boolean => {
    if (bill.key) return t.counterpartyKey === bill.key;
    if (!bill.matchName) return false;
    const name = bill.matchName;
    return [t.counterpartyName, t.alias ?? "", t.description].some((text) => normalizeDescription(text).includes(name));
  };
  const rangeMonths = monthsBetween(range);
  /** Transações já confirmadas como pagamento de alguma conta manual não são sugeridas para outra. */
  const claimed = new Set(matches.filter((m) => m.paid && m.transactionId).map((m) => m.transactionId));

  const items: RecurringItem[] = bills.map((bill) => {
    const latest = bill.key ? latestByKey.get(bill.key) : undefined;
    const history = bill.key ? (historyByKey.get(bill.key) ?? []) : [];
    const base = {
      id: bill.id,
      key: bill.key,
      matchName: bill.matchName,
      manual: bill.manual,
      alias: latest?.alias ?? null,
      tagId: latest?.tagId ?? null,
      expected: bill.expected,
      ...monthlyAverage(history),
    };

    if (!bill.manual) {
      const payments = [...(bill.key ? (paymentsByKey.get(bill.key) ?? []) : [])].sort((a, b) =>
        a.date.localeCompare(b.date),
      );
      return {
        ...base,
        name: latest ? (latest.alias ?? latest.counterpartyName) : bill.label,
        original: latest?.counterpartyName ?? bill.label,
        day: usualDay(history.map((p) => p.day)),
        paid: round(sum(payments.map((p) => p.amount))),
        payments: payments.map(({ id, date, amount }) => ({ id, date, amount })),
        manualPaid: false,
        candidates: [],
      };
    }

    const own = matches.filter((m) => m.billId === bill.id);
    const payments = own
      .filter((m) => m.paid && m.transactionId)
      .map((m) => currentById.get(m.transactionId ?? ""))
      .filter((t) => t !== undefined)
      .sort((a, b) => a.date.localeCompare(b.date));
    const manualPaid = own.some((m) => m.paid && m.transactionId === null && rangeMonths.has(m.month));
    const decided = new Set(own.map((m) => m.transactionId));
    const expected = bill.expected ?? base.average;
    const candidates =
      payments.length || manualPaid
        ? []
        : current.filter(
            (t) =>
              isLinked(bill, t) &&
              !decided.has(t.id) &&
              !claimed.has(t.id) &&
              (!expected || Math.abs(t.amount - expected) <= expected * CANDIDATE_AMOUNT_TOLERANCE) &&
              (bill.day === null || dayDistance(Number(t.date.slice(8, 10)), bill.day) <= CANDIDATE_DAY_TOLERANCE),
          );

    return {
      ...base,
      name: bill.label,
      original: latest?.counterpartyName ?? bill.linkLabel ?? "",
      day: bill.day,
      paid: round(sum(payments.map((p) => p.amount)) + (manualPaid ? expected : 0)),
      payments: payments.map(({ id, date, amount }) => ({ id, date, amount })),
      manualPaid,
      candidates: candidates.map(({ id, date, amount, displayName }) => ({ id, date, amount, displayName })),
    };
  });

  const counterparties: CounterpartyOption[] = [...latestByKey.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((t) => ({
      key: t.counterpartyKey,
      name: t.alias ?? t.counterpartyName,
      original: t.counterpartyName,
      lastAmount: t.amount,
      lastDate: t.date,
    }));

  const expectedOf = (item: RecurringItem): number => item.expected ?? item.average;
  items.sort((a, b) => Number(a.paid > 0) - Number(b.paid > 0) || expectedOf(b) - expectedOf(a));

  const billKeys = new Set(bills.map((b) => b.key).filter((k) => k !== null));
  const suggestions: RecurringSuggestion[] = [];
  for (const [key, history] of historyByKey) {
    if (billKeys.has(key)) continue;
    const pattern = monthlyPattern(history);
    const latest = latestByKey.get(key);
    if (!pattern || !latest) continue;
    suggestions.push({
      key,
      name: latest.alias ?? latest.counterpartyName,
      original: latest.counterpartyName,
      months: pattern.months,
      average: pattern.average,
      day: pattern.day,
    });
  }
  suggestions.sort((a, b) => b.months - a.months || b.average - a.average);

  return {
    range,
    historyMonths: HISTORY_MONTHS,
    items,
    suggestions,
    counterparties,
    transactions: searchable.sort((a, b) => b.date.localeCompare(a.date)),
    totals: {
      expected: round(sum(items.map(expectedOf))),
      paid: round(sum(items.map((i) => i.paid))),
      pending: round(sum(items.filter((i) => i.paid === 0).map(expectedOf))),
    },
  };
}
