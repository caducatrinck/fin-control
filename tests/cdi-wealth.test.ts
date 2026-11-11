import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expectedMonthYield, formatRateLabel } from "../src/cdi.ts";
import {
  applyYieldOverrides,
  buildInvestmentIncome,
  buildWealth,
  measuredProfit,
  wealthStart,
} from "../src/wealth.ts";
import { account, investment, tx } from "./helpers.ts";

describe("cdi", () => {
  it("formatRateLabel usa indexador informado", () => {
    assert.equal(formatRateLabel(120, "CDI"), "120% CDI");
    assert.equal(formatRateLabel(100, null), "100% CDI");
  });

  it("expectedMonthYield cresce com saldo, % CDI e CDI anual", () => {
    const low = expectedMonthYield(10_000, 100, 10);
    const highRate = expectedMonthYield(10_000, 120, 10);
    const highCdi = expectedMonthYield(10_000, 100, 13.65);
    assert.ok(low > 0);
    assert.ok(highRate > low);
    assert.ok(highCdi > low);
  });
});

describe("wealthStart / buildInvestmentIncome", () => {
  it("wealthStart abre 12 meses atrás", () => {
    assert.equal(wealthStart(new Date(Date.UTC(2025, 10, 15))), "2024-12-01");
  });

  it("monta previsto só para posições CDI ativas com rate", () => {
    const income = buildInvestmentIncome(
      [
        investment({ id: "a", name: "Caixinha 100", balance: 10_000, rate: 100 }),
        investment({ id: "b", name: "Caixinha 120", balance: 10_000, rate: 120 }),
        investment({ id: "c", name: "Sem taxa", balance: 10_000, rate: null }),
        investment({ id: "d", name: "Resgatada", balance: 0, rate: 100, status: "TOTAL_WITHDRAWAL" }),
        investment({ id: "e", name: "IPCA", balance: 10_000, rate: 6, rateType: "IPCA" }),
      ],
      13.65,
    );
    assert.equal(income.items.length, 2);
    assert.ok(income.expectedMonth !== null && income.expectedMonth > 0);
    assert.ok((income.items[0]?.amount ?? 0) >= (income.items[1]?.amount ?? 0));
  });

  it("sem CDI devolve items vazios", () => {
    const income = buildInvestmentIncome([investment({ id: "a", name: "X", balance: 1000, rate: 100 })], null);
    assert.deepEqual(income, { expectedMonth: null, cdiAnnual: null, items: [] });
  });
});

describe("applyYieldOverrides", () => {
  const base = buildInvestmentIncome([investment({ id: "a", name: "Caixa", balance: 10_000, rate: 100 })], 13.65);

  it("multiplica pelo número de meses sem override de data", () => {
    const one = applyYieldOverrides(base, [], { from: "2025-11-01", to: "2025-11-30" });
    const three = applyYieldOverrides(base, [], { from: "2025-09-01", to: "2025-11-30" });
    assert.ok(one.expectedMonth !== null && three.expectedMonth !== null);
    assert.ok(Math.abs(three.expectedMonth - one.expectedMonth * 3) < 0.02);
  });

  it("override de valor marca amountEdited", () => {
    const next = applyYieldOverrides(base, [{ id: "a", amount: 99.5, date: null }], {
      from: "2025-11-01",
      to: "2025-11-30",
    });
    assert.equal(next.items[0]?.amount, 99.5);
    assert.equal(next.items[0]?.amountEdited, true);
  });

  it("override com data fora do período some da lista", () => {
    const next = applyYieldOverrides(base, [{ id: "a", amount: 50, date: "2025-01-15" }], {
      from: "2025-11-01",
      to: "2025-11-30",
    });
    assert.equal(next.items.length, 0);
    assert.equal(next.expectedMonth, null);
  });
});

describe("measuredProfit", () => {
  it("null sem snapshot anterior", () => {
    assert.equal(measuredProfit(1000, "2025-11-10", [], []), null);
  });

  it("Δ saldo menos fluxo de aplicação/resgate", () => {
    const profit = measuredProfit(
      12_000,
      "2025-11-10",
      [{ date: "2025-11-01", total: 10_000 }],
      [
        tx({
          id: "app",
          type: "DEBIT",
          amount: -500,
          description: "Aplicação caixinha",
          date: "2025-11-05T12:00:00.000Z",
          category: "Investment",
        }),
      ],
    );
    // 12000 - 10000 + (-500) = 1500? signed debit = -500, formula: now - baseline + flow
    // flow = signed(DEBIT aplicação) = -500
    // 12000 - 10000 + (-500) = 1500
    assert.deepEqual(profit, { amount: 1500, from: "2025-11-01" });
  });
});

describe("buildWealth", () => {
  it("soma contas + investimentos + manual e exclui cartão do total de contas", () => {
    const wealth = buildWealth(
      [
        account({ id: "bank", type: "BANK", name: "Conta", balance: 2000 }),
        account({ id: "card", type: "CREDIT", name: "Cartão", balance: -800 }),
      ],
      [investment({ id: "inv", name: "CDB", balance: 3000, amountOriginal: 2800, amountProfit: 200, rate: 100 })],
      true,
      [],
      new Date(2025, 10, 15),
      [{ date: "2025-11-01", total: 2900 }],
      13.65,
      { amount: 500, note: "fora do OF", date: "2025-11-01" },
    );

    assert.equal(wealth.totals.accounts, 2000);
    assert.equal(wealth.reportedInvestments, 3000);
    assert.equal(wealth.totals.investments, 3500);
    assert.equal(wealth.totals.total, 5500);
    assert.equal(wealth.manual.amount, 500);
    assert.equal(wealth.totals.monthProfit, 100);
    assert.ok(wealth.totals.expectedMonthProfit !== null);
  });
});
