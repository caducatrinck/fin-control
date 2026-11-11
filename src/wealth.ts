import type { Account, Investment, Transaction } from "./pluggy/types.ts";
import type { PeriodInvestmentIncome, WealthPoint, WealthResponse } from "./shared/api.ts";
import { expectedMonthYield } from "./cdi.ts";
import type { InvestmentSnapshot } from "./snapshots.ts";
import { isInvestmentMove } from "./transactions.ts";

/** Meses de histórico no gráfico, contando o atual. */
export const WEALTH_MONTHS = 12;

const round = (value: number): number => Math.round(value * 100) / 100;

/** Primeiro dia do mês que abre o histórico (yyyy-mm-dd). */
export function wealthStart(today: Date): string {
  return new Date(Date.UTC(today.getFullYear(), today.getMonth() - (WEALTH_MONTHS - 1), 1)).toISOString().slice(0, 10);
}

function monthList(today: Date): string[] {
  return Array.from({ length: WEALTH_MONTHS }, (_, i) =>
    new Date(Date.UTC(today.getFullYear(), today.getMonth() - (WEALTH_MONTHS - 1) + i, 1)).toISOString().slice(0, 7),
  );
}

const num = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Rendimento bruto desde a aplicação: o informado pela Pluggy ou valor bruto menos o aplicado. */
function profitOf(i: Investment): number | null {
  const profit = num(i.amountProfit);
  if (profit !== null) return profit;
  const original = num(i.amountOriginal);
  if (original === null || original <= 0) return null;
  return (num(i.amount) ?? i.balance) - original;
}

function sumKnown(values: readonly (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? round(known.reduce((acc, v) => acc + v, 0)) : null;
}

const signed = (t: Transaction): number => (t.type === "CREDIT" ? Math.abs(t.amount) : -Math.abs(t.amount));

const toIsoDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Rendimento previsto (CDI × % de cada caixinha) para o Resumo e o Patrimônio.
 * Só entra posição com `rate` da Pluggy e indexador CDI (ou sem indexador informado).
 */
export function buildInvestmentIncome(investments: readonly Investment[], cdiAnnual: number | null): PeriodInvestmentIncome {
  const items: PeriodInvestmentIncome["items"] = [];
  if (cdiAnnual === null) return { expectedMonth: null, cdiAnnual: null, items };

  for (const i of investments) {
    if (i.status === "TOTAL_WITHDRAWAL") continue;
    const rate = num(i.rate);
    if (rate === null) continue;
    if (i.rateType != null && i.rateType !== "CDI") continue;
    items.push({
      id: i.id,
      name: i.name.trim() || "Investimento",
      rate,
      rateType: i.rateType ?? "CDI",
      amount: round(expectedMonthYield(i.balance, rate, cdiAnnual)),
      balance: i.balance,
      date: null,
      amountEdited: false,
    });
  }
  items.sort((a, b) => b.amount - a.amount);
  return {
    expectedMonth: items.length ? round(items.reduce((acc, row) => acc + row.amount, 0)) : null,
    cdiAnnual,
    items,
  };
}

/**
 * Aplica overrides (valor/data) e filtra o que entra no período.
 * Sem data: vale para qualquer período; o previsto mensal é multiplicado pelos meses do período
 * (estimativa com o saldo de hoje). Com data: só se cair em `[from, to]`.
 */
export function applyYieldOverrides(
  income: PeriodInvestmentIncome,
  overrides: readonly { id: string; amount: number | null; date: string | null }[],
  range: { from: string; to: string },
): PeriodInvestmentIncome {
  const byId = new Map(overrides.map((o) => [o.id, o]));
  const [fromYear = 0, fromMonth = 1] = range.from.split("-").map(Number);
  const [toYear = 0, toMonth = 1] = range.to.split("-").map(Number);
  const months = Math.max(1, (toYear - fromYear) * 12 + (toMonth - fromMonth) + 1);

  const items = income.items
    .map((item) => {
      const override = byId.get(item.id);
      if (!override) return { ...item, amount: round(item.amount * months) };
      const base = override.amount !== null ? override.amount : round(item.amount * (override.date ? 1 : months));
      return {
        ...item,
        amount: base,
        date: override.date,
        amountEdited: override.amount !== null,
      };
    })
    .filter((item) => {
      if (item.date) return item.date >= range.from && item.date <= range.to;
      return true;
    })
    .sort((a, b) => b.amount - a.amount);

  return {
    expectedMonth: items.length ? round(items.reduce((acc, row) => acc + row.amount, 0)) : null,
    cdiAnnual: income.cdiAnnual,
    items,
  };
}

/**
 * Rendimento medido desde um snapshot anterior:
 * variação do total de investimentos menos o efeito de aplicações e resgates no extrato.
 * Sem snapshot de outro dia, devolve `null` (nada inventado).
 */
export function measuredProfit(
  investmentsNow: number,
  today: string,
  snapshots: readonly InvestmentSnapshot[],
  transactions: readonly Transaction[],
): { amount: number; from: string } | null {
  const prior = snapshots.filter((s) => s.date < today);
  if (!prior.length) return null;

  const monthStart = `${today.slice(0, 7)}-01`;
  const atMonthStart = [...prior].reverse().find((s) => s.date <= monthStart);
  const baseline = atMonthStart ?? prior[prior.length - 1];
  if (!baseline) return null;

  const flow = transactions
    .filter((t) => isInvestmentMove(t) && t.date.slice(0, 10) > baseline.date && t.date.slice(0, 10) <= today)
    .reduce((acc, t) => acc + signed(t), 0);

  return { amount: round(investmentsNow - baseline.total + flow), from: baseline.date };
}

/**
 * Saldos no fim de cada mês, reconstruídos de trás para frente a partir do saldo de hoje:
 * - contas: saldo atual menos as movimentações posteriores ao mês;
 * - investimentos: valor atual menos aplicações e mais resgates posteriores (sem os rendimentos do período).
 * Cartões de crédito ficam de fora (são dívida, não dinheiro guardado).
 * `manual` soma ao total de investimentos o que o Open Finance não trouxe.
 */
export function buildWealth(
  accounts: readonly Account[],
  investments: readonly Investment[],
  investmentsAvailable: boolean,
  transactions: readonly Transaction[],
  today: Date,
  snapshots: readonly InvestmentSnapshot[] = [],
  cdiAnnual: number | null = null,
  manual: { amount: number; note: string | null; date: string | null } = { amount: 0, note: null, date: null },
  yieldOverrides: readonly { id: string; amount: number | null; date: string | null }[] = [],
): WealthResponse {
  const bankIds = new Set(accounts.filter((a) => a.type === "BANK").map((a) => a.id));
  const bankNow = accounts.filter((a) => a.type === "BANK").reduce((acc, a) => acc + a.balance, 0);
  const active = investments.filter((i) => i.status !== "TOTAL_WITHDRAWAL");
  const reportedInvestments = active.reduce((acc, a) => acc + a.balance, 0);
  const manualAmount = manual.amount > 0 ? round(manual.amount) : 0;
  const investmentsNow = reportedInvestments + manualAmount;
  const bankMoves = transactions.filter((t) => bankIds.has(t.accountId));
  const todayIso = toIsoDate(today);
  const month = measuredProfit(reportedInvestments, todayIso, snapshots, transactions);
  const income = buildInvestmentIncome(investments, cdiAnnual);
  const byId = new Map(income.items.map((row) => [row.id, row]));
  const overrideById = new Map(yieldOverrides.map((o) => [o.id, o]));

  const months = monthList(today);
  const history: WealthPoint[] = months.map((monthKey, i) => {
    if (i === months.length - 1) {
      return { month: monthKey, accounts: round(bankNow), investments: round(investmentsNow), total: round(bankNow + investmentsNow) };
    }
    const after = bankMoves.filter((t) => t.date.slice(0, 7) > monthKey);
    const accountsAt = bankNow - after.reduce((acc, t) => acc + signed(t), 0);
    const investmentsAt = Math.max(
      0,
      reportedInvestments + after.filter(isInvestmentMove).reduce((acc, t) => acc + signed(t), 0),
    );
    return {
      month: monthKey,
      accounts: round(accountsAt),
      investments: round(investmentsAt),
      total: round(accountsAt + investmentsAt),
    };
  });

  const first = history[0]?.total ?? 0;
  const total = bankNow + investmentsNow;

  const investmentRows = active
    .map((i) => {
      const profit = profitOf(i);
      const projected = byId.get(i.id);
      const override = overrideById.get(i.id);
      const edited = override !== undefined && override.amount !== null;
      const expected = edited ? override.amount : (projected?.amount ?? null);
      return {
        id: i.id,
        name: i.name,
        type: i.type,
        balance: i.balance,
        currencyCode: i.currencyCode,
        invested: num(i.amountOriginal),
        profit: profit === null ? null : round(profit),
        rate: projected?.rate ?? num(i.rate),
        rateType: projected?.rateType ?? i.rateType ?? null,
        expectedMonthProfit: expected === null ? null : round(expected),
        yieldDate: override?.date ?? null,
        yieldEdited: Boolean(edited),
      };
    })
    .sort((a, b) => b.balance - a.balance);

  const expectedMonthProfit = sumKnown(investmentRows.map((row) => row.expectedMonthProfit));

  return {
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      subtype: a.subtype,
      balance: a.balance,
      currencyCode: a.currencyCode,
    })),
    investments: investmentRows,
    investmentsAvailable,
    manual: {
      amount: manualAmount,
      note: manualAmount > 0 ? manual.note : null,
      date: manualAmount > 0 ? manual.date : null,
    },
    reportedInvestments: round(reportedInvestments),
    history,
    totals: {
      accounts: round(bankNow),
      investments: round(investmentsNow),
      total: round(total),
      change: round(total - first),
      profit: sumKnown(active.map(profitOf)),
      expectedMonthProfit,
      cdiAnnual,
      monthProfit: month?.amount ?? null,
      monthProfitFrom: month?.from ?? null,
    },
  };
}
