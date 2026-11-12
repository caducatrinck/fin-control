import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toAccountCurrency } from "../src/pluggy/client.ts";
import { tx } from "./helpers.ts";

describe("toAccountCurrency (compras internacionais)", () => {
  it("usa o valor cobrado em reais e guarda o original (Unity US$ 7,50 → R$ 39,03)", () => {
    const t = toAccountCurrency(
      tx({ id: "unity", type: "DEBIT", amount: 7.5, currencyCode: "USD", amountInAccountCurrency: 39.03, description: "Unity" }),
    );
    assert.equal(t.amount, 39.03);
    assert.equal(t.originalAmount, 7.5);
    assert.equal(t.originalCurrencyCode, "USD");
  });

  it("mantém o sinal de créditos", () => {
    const t = toAccountCurrency(
      tx({ id: "c", type: "CREDIT", amount: -2, currencyCode: "USD", amountInAccountCurrency: 10.4, description: "Estorno" }),
    );
    assert.equal(t.amount, -10.4);
  });

  it("não mexe em transações em reais (amountInAccountCurrency nulo)", () => {
    const original = tx({ id: "brl", type: "DEBIT", amount: 371.97, amountInAccountCurrency: null, description: "Zupper 1/2" });
    assert.equal(toAccountCurrency(original), original);
  });
});
