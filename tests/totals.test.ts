import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cashflowOf, computeTotals, expenseImpactOf, expensesByTag, roundMoney } from "../src/shared/totals.ts";
import { periodTx } from "./helpers.ts";

describe("roundMoney", () => {
  it("arredonda para centavos", () => {
    assert.equal(roundMoney(10.005), 10.01);
    assert.equal(roundMoney(10.004), 10);
  });
});

describe("cashflowOf / expenseImpactOf", () => {
  it("saída reduz caixa e aumenta gasto", () => {
    const t = periodTx({ id: "1", amount: 50, direction: "out" });
    assert.equal(cashflowOf(t), -50);
    assert.equal(expenseImpactOf(t), 50);
  });

  it("entrada aumenta caixa e não conta como gasto", () => {
    const t = periodTx({ id: "2", amount: 100, direction: "in" });
    assert.equal(cashflowOf(t), 100);
    assert.equal(expenseImpactOf(t), 0);
  });

  it("reembolso soma no caixa e abate o gasto", () => {
    const t = periodTx({ id: "3", amount: 30, direction: "in", refund: true });
    assert.equal(cashflowOf(t), 30);
    assert.equal(expenseImpactOf(t), -30);
  });
});

describe("computeTotals", () => {
  it("soma income, expense e net", () => {
    const totals = computeTotals([
      periodTx({ id: "in", amount: 1000, direction: "in" }),
      periodTx({ id: "out", amount: 250, direction: "out" }),
      periodTx({ id: "out2", amount: 50, direction: "out" }),
    ]);
    assert.deepEqual(totals, { income: 1000, expense: 300, net: 700, internalCount: 0 });
  });

  it("reembolso reduz expense e mantém income só de entradas normais", () => {
    const totals = computeTotals([
      periodTx({ id: "sal", amount: 5000, direction: "in" }),
      periodTx({ id: "buy", amount: 200, direction: "out" }),
      periodTx({ id: "ref", amount: 50, direction: "in", refund: true }),
    ]);
    assert.equal(totals.income, 5000);
    assert.equal(totals.expense, 150);
    assert.equal(totals.net, 4850);
  });

  it("ignora internas e canceladas no gasto", () => {
    const totals = computeTotals([
      periodTx({ id: "out", amount: 100, direction: "out" }),
      periodTx({ id: "int", amount: 999, direction: "out", internal: true }),
      periodTx({ id: "can", amount: 80, direction: "out", cancelled: true }),
    ]);
    assert.equal(totals.expense, 100);
    assert.equal(totals.internalCount, 2);
  });
});

describe("expensesByTag", () => {
  it("agrupa gastos e abate reembolso da mesma tag", () => {
    const byTag = expensesByTag([
      periodTx({ id: "a", amount: 100, direction: "out", tagId: "food" }),
      periodTx({ id: "b", amount: 40, direction: "out", tagId: "food" }),
      periodTx({ id: "c", amount: 30, direction: "in", refund: true, tagId: "food" }),
      periodTx({ id: "d", amount: 20, direction: "out", tagId: null }),
    ]);
    assert.deepEqual(byTag, [
      { tagId: "food", total: 110, count: 3 },
      { tagId: null, total: 20, count: 1 },
    ]);
  });

  it("não inclui internas nem canceladas", () => {
    const byTag = expensesByTag([
      periodTx({ id: "a", amount: 10, direction: "out", tagId: "x", internal: true }),
      periodTx({ id: "b", amount: 10, direction: "out", tagId: "x", cancelled: true }),
    ]);
    assert.deepEqual(byTag, []);
  });
});
