import type { PeriodTotals, PeriodTransaction, TagTotal } from "./api.ts";

export const roundMoney = (value: number): number => Math.round(value * 100) / 100;

/**
 * Fluxo de caixa: entrada/reembolso +, saída −.
 * Reembolso é crédito que volta, então soma positivo e abate o gasto líquido.
 */
export function cashflowOf(t: Pick<PeriodTransaction, "amount" | "direction" | "refund">): number {
  if (t.refund) return t.amount;
  return t.direction === "in" ? t.amount : -t.amount;
}

/** Impacto no gasto do período: saída +, reembolso −, demais 0. */
export function expenseImpactOf(t: Pick<PeriodTransaction, "amount" | "direction" | "refund">): number {
  if (t.refund) return -t.amount;
  if (t.direction === "out") return t.amount;
  return 0;
}

export function computeTotals(transactions: readonly PeriodTransaction[]): PeriodTotals {
  let income = 0;
  let expense = 0;
  let internalCount = 0;
  for (const t of transactions) {
    if (t.internal || t.cancelled) {
      // Parcelas canceladas após estorno ficam fora do gasto (a Pluggy ainda as envia).
      internalCount++;
      continue;
    }
    if (t.refund) expense -= t.amount;
    else if (t.direction === "in") income += t.amount;
    else expense += t.amount;
  }
  return {
    income: roundMoney(income),
    expense: roundMoney(expense),
    net: roundMoney(income - expense),
    internalCount,
  };
}

export function expensesByTag(transactions: readonly PeriodTransaction[]): TagTotal[] {
  const groups = new Map<string | null, TagTotal>();
  for (const t of transactions) {
    if (t.internal || t.cancelled || (t.direction !== "out" && !t.refund)) continue; // cancelled: fora do gasto
    const group = groups.get(t.tagId) ?? { tagId: t.tagId, total: 0, count: 0 };
    group.total += expenseImpactOf(t);
    group.count++;
    groups.set(t.tagId, group);
  }
  // Totais negativos (reembolso sem compra na mesma tag) ficam para a soma bater com `expense`.
  return [...groups.values()]
    .map((g) => ({ ...g, total: roundMoney(g.total) }))
    .filter((g) => g.total !== 0)
    .sort((a, b) => b.total - a.total);
}
