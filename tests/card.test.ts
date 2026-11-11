import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addMonths, buildCard, buildCardBudget, cardStart, detectSalary } from "../src/card.ts";
import { account, periodTx, tx } from "./helpers.ts";

describe("addMonths / cardStart", () => {
  it("soma e subtrai meses no calendário UTC", () => {
    assert.equal(addMonths("2025-01", 1), "2025-02");
    assert.equal(addMonths("2025-01", -1), "2024-12");
  });

  it("cardStart cobre histórico e seleção", () => {
    const start = cardStart(new Date(2025, 10, 15), "2025-11-01");
    assert.match(start, /^\d{4}-\d{2}-01$/);
    assert.ok(start < "2025-11-01");
  });
});

describe("detectSalary", () => {
  const range = { from: "2025-11-01", to: "2025-11-30" };

  it("prefere entradas que parecem salário", () => {
    const result = detectSalary(
      [
        periodTx({ id: "a", amount: 8000, direction: "in", description: "Pagamento de salário", date: "2025-11-05T12:00:00.000Z" }),
        periodTx({ id: "b", amount: 9000, direction: "in", description: "Pix recebido", date: "2025-11-06T12:00:00.000Z" }),
      ],
      range,
    );
    assert.equal(result.salary, 8000);
    assert.equal(result.salarySource, "salary");
  });

  it("senão usa a maior entrada do período", () => {
    const result = detectSalary(
      [
        periodTx({ id: "a", amount: 1000, direction: "in", date: "2025-11-05T12:00:00.000Z" }),
        periodTx({ id: "b", amount: 2500, direction: "in", date: "2025-11-06T12:00:00.000Z" }),
      ],
      range,
    );
    assert.equal(result.salary, 2500);
    assert.equal(result.salarySource, "largest-income");
  });

  it("ignora internas, canceladas e reembolsos", () => {
    const result = detectSalary(
      [
        periodTx({ id: "a", amount: 5000, direction: "in", internal: true, date: "2025-11-05T12:00:00.000Z" }),
        periodTx({ id: "b", amount: 4000, direction: "in", refund: true, date: "2025-11-05T12:00:00.000Z" }),
      ],
      range,
    );
    assert.equal(result.salary, null);
    assert.equal(result.salarySource, null);
  });
});

describe("buildCardBudget", () => {
  it("calcula folga e restante da fatura", () => {
    const budget = buildCardBudget(5000, "salary", 1200, 800);
    assert.deepEqual(budget, {
      salary: 5000,
      salarySource: "salary",
      fixed: 1200,
      room: 3800,
      bill: 800,
      remaining: 3000,
    });
  });

  it("sem salário deixa room/remaining nulos", () => {
    const budget = buildCardBudget(null, null, 100, 50);
    assert.equal(budget.room, null);
    assert.equal(budget.remaining, null);
  });
});

describe("buildCard", () => {
  it("soma compras do cartão no mês selecionado e abate estorno", () => {
    const card = account({
      id: "acc-card",
      type: "CREDIT",
      name: "Nubank",
      creditData: { balanceCloseDate: "2025-11-10", balanceDueDate: "2025-11-17", creditLimit: 5000 },
    });
    const raw = [
      tx({
        id: "buy",
        accountId: "acc-card",
        type: "DEBIT",
        amount: -200,
        description: "Loja",
        date: "2025-11-02T12:00:00.000Z",
      }),
      tx({
        id: "ref",
        accountId: "acc-card",
        type: "CREDIT",
        amount: 50,
        description: "Estorno Loja",
        date: "2025-11-03T12:00:00.000Z",
      }),
    ];
    const transactions = [
      periodTx({
        id: "buy",
        accountId: "acc-card",
        accountName: "Nubank",
        amount: 200,
        direction: "out",
        date: "2025-11-02T12:00:00.000Z",
        displayName: "Pago - Loja",
        counterpartyKey: "loja",
        counterpartyName: "Loja",
      }),
      periodTx({
        id: "ref",
        accountId: "acc-card",
        accountName: "Nubank",
        amount: 50,
        direction: "in",
        refund: true,
        date: "2025-11-03T12:00:00.000Z",
        displayName: "ESTORNO - Loja",
        counterpartyKey: "loja",
        counterpartyName: "Loja",
      }),
    ];

    const result = buildCard({
      accounts: [card],
      raw,
      transactions,
      bills: new Map(),
      billsAvailable: false,
      range: { from: "2025-11-01", to: "2025-11-30" },
      today: new Date(2025, 10, 15),
      fixedMonthly: 0,
    });

    assert.equal(result.cards.length, 1);
    assert.equal(result.selected.total, 150);
    assert.equal(result.selected.purchases.length, 2);
    assert.ok(result.selected.purchases.some((p) => p.amount === -50));
  });
});
