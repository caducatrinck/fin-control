import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cancelledInstallmentIds,
  connectedAccountKeys,
  enrichTransaction,
  internalReason,
  isRefund,
  looksLikeSalary,
  matchesTagFilter,
  normalizeDescription,
  type EnrichContext,
} from "../src/transactions.ts";
import { account, tagFilter, tx } from "./helpers.ts";

const emptyCtx = (over: Partial<EnrichContext> = {}): EnrichContext => ({
  accounts: new Map([["acc-bank", { name: "Conta", type: "BANK" }], ["acc-card", { name: "Cartão", type: "CREDIT" }]]),
  tagByKey: new Map(),
  aliasByKey: new Map(),
  filters: [],
  connected: new Set(["123456"]),
  ...over,
});

describe("normalizeDescription", () => {
  it("remove acentos, números e pontuação", () => {
    assert.equal(normalizeDescription("PIX ENVIADO - João 12/09"), "pix enviado joao");
  });
});

describe("connectedAccountKeys", () => {
  it("extrai só dígitos da conta sem zeros à esquerda", () => {
    const keys = connectedAccountKeys([
      account({ id: "1", type: "BANK", name: "Nubank", number: "0001/012345-6" }),
      account({
        id: "2",
        type: "BANK",
        name: "Outra",
        number: "99",
        bankData: { transferNumber: "0001/000099-0" },
      }),
    ]);
    assert.ok(keys.has("123456"));
    assert.ok(keys.has("99"));
  });
});

describe("looksLikeSalary", () => {
  it("reconhece salário em entrada não interna", () => {
    assert.equal(
      looksLikeSalary({
        direction: "in",
        internal: false,
        category: null,
        description: "Pagamento de salário",
        displayName: "x",
        counterpartyName: "Empresa",
      }),
      true,
    );
  });

  it("ignora saída e internas", () => {
    assert.equal(
      looksLikeSalary({
        direction: "out",
        internal: false,
        category: null,
        description: "Salário",
        displayName: "x",
        counterpartyName: "x",
      }),
      false,
    );
  });
});

describe("internalReason", () => {
  it("marca transferência entre contas próprias conectadas", () => {
    const t = tx({
      id: "1",
      type: "DEBIT",
      amount: -100,
      description: "Pix enviado",
      paymentData: {
        payer: { documentNumber: { type: "CPF", value: "12345678901" }, accountNumber: "123456" },
        receiver: { documentNumber: { type: "CPF", value: "123.456.789-01" }, accountNumber: "999" },
      },
    });
    assert.match(internalReason(t, new Set(["123456", "999"])) ?? "", /contas próprias/);
  });

  it("não marca salário como interno", () => {
    const t = tx({
      id: "2",
      type: "CREDIT",
      amount: 5000,
      description: "Pagamento de salário",
      category: "Salary",
    });
    assert.equal(internalReason(t, new Set()), null);
  });

  it("marca pagamento de fatura pela descrição", () => {
    const t = tx({
      id: "3",
      type: "DEBIT",
      amount: -800,
      description: "Pagamento de fatura Nubank",
    });
    assert.match(internalReason(t, new Set()) ?? "", /descrição/);
  });
});

describe("isRefund", () => {
  it("crédito no cartão é estorno (exceto cashback)", () => {
    assert.equal(
      isRefund(tx({ id: "1", type: "CREDIT", amount: 20, description: "Estorno loja", accountId: "acc-card" }), "CREDIT", false),
      true,
    );
    assert.equal(
      isRefund(tx({ id: "2", type: "CREDIT", amount: 5, description: "Cashback Nubank", accountId: "acc-card" }), "CREDIT", false),
      false,
    );
  });

  it("na conta corrente só com texto de estorno", () => {
    assert.equal(
      isRefund(tx({ id: "3", type: "CREDIT", amount: 20, description: "Pix recebido" }), "BANK", false),
      false,
    );
    assert.equal(
      isRefund(tx({ id: "4", type: "CREDIT", amount: 20, description: "Estorno Pix" }), "BANK", false),
      true,
    );
  });

  it("nunca em débito, interno ou salário", () => {
    assert.equal(isRefund(tx({ id: "5", type: "DEBIT", amount: -10, description: "Estorno" }), "CREDIT", false), false);
    assert.equal(isRefund(tx({ id: "6", type: "CREDIT", amount: 10, description: "Estorno" }), "CREDIT", true), false);
    assert.equal(
      isRefund(tx({ id: "7", type: "CREDIT", amount: 5000, description: "Salário", category: "Salary" }), "CREDIT", false),
      false,
    );
  });
});

describe("cancelledInstallmentIds", () => {
  it("cancela parcelas futuras após estorno que bate com a 1ª", () => {
    const purchase = "2025-10-01";
    const list = [
      tx({
        id: "p1",
        type: "DEBIT",
        amount: -100,
        description: "Airbnb 1/3",
        accountId: "acc-card",
        date: "2025-10-05T12:00:00.000Z",
        creditCardMetadata: { installmentNumber: 1, totalInstallments: 3, purchaseDate: purchase },
      }),
      tx({
        id: "p2",
        type: "DEBIT",
        amount: -100,
        description: "Airbnb 2/3",
        accountId: "acc-card",
        date: "2025-11-05T12:00:00.000Z",
        creditCardMetadata: { installmentNumber: 2, totalInstallments: 3, purchaseDate: purchase },
      }),
      tx({
        id: "p3",
        type: "DEBIT",
        amount: -100,
        description: "Airbnb 3/3",
        accountId: "acc-card",
        date: "2025-12-05T12:00:00.000Z",
        creditCardMetadata: { installmentNumber: 3, totalInstallments: 3, purchaseDate: purchase },
      }),
      tx({
        id: "ref",
        type: "CREDIT",
        amount: 100,
        description: "Estorno Airbnb",
        accountId: "acc-card",
        date: "2025-10-20T12:00:00.000Z",
      }),
    ];
    const cancelled = cancelledInstallmentIds(list);
    assert.equal(cancelled.has("p1"), false);
    assert.equal(cancelled.has("p2"), true);
    assert.equal(cancelled.has("p3"), true);
  });

  it("não cancela sem estorno correspondente", () => {
    const list = [
      tx({
        id: "p1",
        type: "DEBIT",
        amount: -72.5,
        description: "TicketMaster 1/6",
        accountId: "acc-card",
        date: "2025-09-01T12:00:00.000Z",
        creditCardMetadata: { installmentNumber: 1, totalInstallments: 6, purchaseDate: "2025-09-01" },
      }),
      tx({
        id: "p2",
        type: "DEBIT",
        amount: -72.5,
        description: "TicketMaster 2/6",
        accountId: "acc-card",
        date: "2025-10-01T12:00:00.000Z",
        creditCardMetadata: { installmentNumber: 2, totalInstallments: 6, purchaseDate: "2025-09-01" },
      }),
    ];
    assert.equal(cancelledInstallmentIds(list).size, 0);
  });
});

describe("matchesTagFilter", () => {
  it("exige AND de valor e texto", () => {
    const filter = tagFilter({ id: "f1", tagId: "t1", amount: 19.9, contains: "Spotify" });
    assert.equal(matchesTagFilter(filter, 19.9, ["Pagamento Spotify"]), true);
    assert.equal(matchesTagFilter(filter, 19.9, ["Netflix"]), false);
    assert.equal(matchesTagFilter(filter, 20, ["Spotify"]), false);
  });
});

describe("enrichTransaction", () => {
  it("marca estorno no cartão e prefixa displayName", () => {
    const enriched = enrichTransaction(
      tx({
        id: "c1",
        accountId: "acc-card",
        type: "CREDIT",
        amount: 40,
        description: "Devolução loja",
      }),
      emptyCtx(),
    );
    assert.equal(enriched.refund, true);
    assert.equal(enriched.direction, "in");
    assert.match(enriched.displayName, /^ESTORNO -/);
  });

  it("respeita override manual de reembolso", () => {
    const base = tx({
      id: "m1",
      type: "CREDIT",
      amount: 25,
      description: "Pix recebido",
    });
    assert.equal(enrichTransaction(base, emptyCtx()).refund, false);
    assert.equal(
      enrichTransaction(base, emptyCtx({ refundById: new Map([["m1", true]]) })).refund,
      true,
    );
  });

  it("parcela cancelada não é interna nem reembolso", () => {
    const enriched = enrichTransaction(
      tx({
        id: "p2",
        accountId: "acc-card",
        type: "DEBIT",
        amount: -100,
        description: "Airbnb 2/3",
      }),
      emptyCtx({ cancelledIds: new Set(["p2"]) }),
    );
    assert.equal(enriched.cancelled, true);
    assert.equal(enriched.internal, false);
    assert.equal(enriched.refund, false);
    assert.match(enriched.displayName, /^CANCELADA -/);
  });

  it("aplica alias e tag por regra", () => {
    const enriched = enrichTransaction(
      tx({
        id: "x",
        type: "DEBIT",
        amount: -50,
        description: "Compra",
        merchant: { name: "Padaria", cnpj: "12345678000199" },
      }),
      emptyCtx({
        aliasByKey: new Map([["doc:12345678000199", "Pão diário"]]),
        tagByKey: new Map([["doc:12345678000199", "food"]]),
      }),
    );
    assert.equal(enriched.alias, "Pão diário");
    assert.equal(enriched.tagId, "food");
    assert.match(enriched.displayName, /Pão diário/);
  });
});
