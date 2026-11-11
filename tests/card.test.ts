import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addMonths, buildCard, buildCardBudget, cardStart, detectSalary, reconcileBill } from "../src/card.ts";
import type { Account, Bill, Transaction } from "../src/pluggy/types.ts";
import type { BillOverride, CardSettings, PeriodTransaction } from "../src/shared/api.ts";
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


// Cartão no formato real: CREDIT amount negativo, DEBIT positivo, billForecastDate = mês de vencimento previsto.
const TODAY = new Date(2026, 10, 11);
const NOV_BILL: Bill = {
  id: "bill-nov",
  dueDate: "2026-11-09T00:00:00.000Z",
  billClosingDate: "2026-10-31T00:00:00.000Z",
  totalAmount: 4837.6612,
  totalAmountCurrencyCode: "BRL",
  financeCharges: [],
  payments: [{ paymentDate: "2026-11-02T00:00:00.000Z", amount: 4637.76, valueType: "FULL_PAYMENT" }],
};
const ultraviolet = (): Account =>
  account({
    id: "acc-card",
    type: "CREDIT",
    name: "ultraviolet-black",
    // balanceCloseDate vem null: o fechamento cai no fallback.
    creditData: { balanceCloseDate: null, balanceDueDate: "2026-11-09", creditLimit: 24000 },
  });

function cardTx(
  id: string,
  type: "DEBIT" | "CREDIT",
  amount: number,
  date: string,
  description: string,
  meta: NonNullable<Transaction["creditCardMetadata"]> = {},
  extra: Partial<Transaction> = {},
): Transaction {
  return tx({
    id,
    accountId: "acc-card",
    type,
    amount: type === "CREDIT" ? -Math.abs(amount) : Math.abs(amount),
    date: `${date}T12:00:00.000Z`,
    description,
    status: meta.billId ? "POSTED" : "PENDING",
    operationType: type === "CREDIT" ? "ESTORNO" : "PAGAMENTO",
    creditCardMetadata: meta,
    ...extra,
  });
}

/** Equivalente ao que o servidor faz: PeriodTransaction com valor positivo e sentido. */
function period(t: Transaction, refundLinks: Record<string, string> = {}): PeriodTransaction {
  const origin = refundLinks[t.id];
  return periodTx({
    ...(origin && {
      refundLink: { status: "linked", kind: "exact", purchaseId: origin, purchaseDate: null, purchaseName: null, partial: false, unlinked: false },
    }),
    id: t.id,
    accountId: t.accountId,
    accountName: "ultraviolet-black",
    amount: Math.abs(t.amount),
    direction: t.type === "CREDIT" ? "in" : "out",
    refund: t.type === "CREDIT" && t.operationType === "ESTORNO",
    date: t.date,
    description: t.description,
    displayName: t.description,
    counterpartyKey: `desc:${t.description}`,
    counterpartyName: t.description,
  });
}

function build(
  raw: Transaction[],
  opts: { bills?: Bill[]; settings?: CardSettings; overrides?: BillOverride[]; refundLinks?: Record<string, string> } = {},
): ReturnType<typeof buildCard> {
  return buildCard({
    accounts: [ultraviolet()],
    raw,
    transactions: raw.map((t) => period(t, opts.refundLinks)),
    bills: new Map([["acc-card", opts.bills ?? [NOV_BILL]]]),
    billsAvailable: true,
    range: { from: "2026-12-01", to: "2026-12-31" },
    today: TODAY,
    fixedMonthly: 0,
    ...(opts.settings && { settings: opts.settings }),
    ...(opts.overrides && { billOverrides: opts.overrides }),
  });
}

describe("próxima fatura por billForecastDate", () => {
  const dec = { billForecastDate: "2026-12" };
  const raw = [
    // 30/10 e 31/10 a Pluggy já põe na fatura de dezembro; o app antigo descartava pela data.
    cardTx("o30", "DEBIT", 100.3, "2026-10-30", "Compra 30/10", dec),
    cardTx("o31", "DEBIT", 115, "2026-10-31", "Compra 31/10", dec),
    cardTx("n1", "DEBIT", 1000, "2026-11-03", "Compra novembro", dec),
    cardTx("est", "CREDIT", 691.24, "2026-11-06", "Estorno de compra", dec),
    cardTx("pg", "CREDIT", 4637.76, "2026-11-02", "Pagamento recebido", dec, { operationType: "PAGAMENTO_FATURA" }),
  ];

  it("soma a fatura prevista, inclusive 30 e 31/10, com o estorno abatendo (sem sinal duplo)", () => {
    const next = build(raw).next;
    assert.equal(next?.month, "2026-12");
    // 100,30 + 115 + 1000 − 691,24 = 524,06 (o "Pagamento recebido" é interno na UI e fica fora).
    assert.equal(next?.total, 524.06);
    assert.equal(next?.estimated, true);
    assert.equal(next?.forecastCount, 4);
  });

  it("sem billForecastDate cai na estimativa pelo ciclo do cartão", () => {
    const noForecast = [cardTx("x", "DEBIT", 80, "2026-11-03", "Compra sem previsão")];
    const next = build(noForecast).next;
    assert.equal(next?.month, "2026-12");
    assert.equal(next?.total, 80);
    assert.equal(next?.forecastCount, 0);
  });

  it("compra de 30/10 com billForecastDate de dezembro não entra na fatura de novembro", () => {
    const result = build(raw);
    const nov = result.bills.find((b) => b.month === "2026-11");
    // Nada foi somado em novembro: sem compras lançadas nele, `total` repete o valor oficial da fatura fechada.
    assert.equal(nov?.total, 4837.66);
    assert.equal(nov?.forecastCount, 0);
  });

  it("valor do banco informado mostra a diferença e a diferença com projeção", () => {
    const result = build(raw, { overrides: [{ accountId: "acc-card", month: "2026-12", amount: 2376 }] });
    assert.equal(result.next?.bankAmount, 2376);
    assert.equal(result.next?.difference, 2376 - 524.06);
    assert.deepEqual(result.next?.overrides, [{ accountId: "acc-card", amount: 2376 }]);
    assert.equal(result.next?.differenceWithProjection, null);
  });

  it("sem valor informado, não há diferença", () => {
    const next = build(raw).next;
    assert.equal(next?.bankAmount, null);
    assert.equal(next?.difference, null);
  });
});

describe("projeção de parcelas ausentes", () => {
  const nov = (n: number, total: number, amount: number, store: string, purchaseDate: string) =>
    cardTx(
      `${store}-${n}`,
      "DEBIT",
      amount,
      "2026-10-20",
      `${store} ${n}/${total}`,
      { billId: "bill-nov", installmentNumber: n, totalInstallments: total, purchaseDate },
    );
  const base = [
    nov(1, 10, 345.63, "Mercado Livre", "2026-10-20T10:00:00.000Z"),
    nov(6, 6, 229.83, "Airbnb", "2026-05-02T10:00:00.000Z"),
    cardTx("avista", "DEBIT", 50, "2026-11-04", "Compra à vista", { billForecastDate: "2026-12" }),
  ];

  it("vem desligada: nada projetado e o total da API não muda", () => {
    const next = build(base).next;
    assert.deepEqual(next?.projected, []);
    assert.equal(next?.projectedTotal, 0);
    assert.equal(next?.total, 50);
  });

  it("ligada: projeta a próxima parcela (n < total), separada do total da API", () => {
    const next = build(base, { settings: { projectInstallments: true, refundWindowDays: 60 } }).next;
    assert.equal(next?.total, 50);
    assert.deepEqual(next?.projected, [
      { accountId: "acc-card", description: "Mercado Livre", installment: "2/10", amount: 345.63 },
    ]);
    assert.equal(next?.projectedTotal, 345.63);
  });

  it("não projeta o que a API já mandou nem a última parcela", () => {
    const withSecond = [
      ...base,
      cardTx("ml2", "DEBIT", 345.63, "2026-11-20", "Mercado Livre 2/10", {
        billForecastDate: "2026-12",
        installmentNumber: 2,
        totalInstallments: 10,
        purchaseDate: "2026-10-20T10:00:00.000Z",
      }),
    ];
    const next = build(withSecond, { settings: { projectInstallments: true, refundWindowDays: 60 } }).next;
    assert.deepEqual(next?.projected, []);
  });

  it("com valor do banco informado, mostra a diferença com e sem a projeção", () => {
    const next = build(base, {
      settings: { projectInstallments: true, refundWindowDays: 60 },
      overrides: [{ accountId: "acc-card", month: "2026-12", amount: 400 }],
    }).next;
    assert.equal(next?.difference, 350);
    assert.equal(next?.differenceWithProjection, 4.37);
  });

  it("não projeta faturas já fechadas", () => {
    const result = build(base, { settings: { projectInstallments: true, refundWindowDays: 60 } });
    assert.deepEqual(result.bills.find((b) => b.month === "2026-11")?.projected, []);
  });
});

describe("estorno de compra em fatura fechada", () => {
  const dec = { billForecastDate: "2026-12" };
  const wellhub = cardTx("wh", "DEBIT", 199.9, "2026-10-29", "Wellhub", { billId: "bill-nov" });
  const estorno = cardTx("est", "CREDIT", 199.9, "2026-10-30", "Estorno de compra", dec);
  const outra = cardTx("n1", "DEBIT", 1000, "2026-11-03", "Compra novembro", dec);

  it("pareado a compra de fatura fechada, abate aquela fatura e não entra na próxima", () => {
    const result = build([wellhub, estorno, outra], { refundLinks: { est: "wh" } });
    assert.equal(result.next?.total, 1000);
    assert.equal(result.next?.forecastCount, 1);
    assert.equal(result.bills.find((b) => b.month === "2026-11")?.forecastCount, 0);
    const nov = result.bills.find((b) => b.month === "2026-11");
    // Compra de 199,90 − estorno de 199,90 na fatura de novembro.
    assert.equal(nov?.total, 0);
  });

  it("sem pareamento (ou compra ainda em fatura aberta), continua na próxima fatura", () => {
    assert.equal(build([wellhub, estorno, outra]).next?.total, 800.1);
    const aberta = cardTx("wh", "DEBIT", 199.9, "2026-11-04", "Wellhub", dec);
    assert.equal(build([aberta, estorno, outra], { refundLinks: { est: "wh" } }).next?.total, 1000);
  });
});

describe("reconcileBill", () => {
  const bill = (over: Partial<Bill> = {}): Bill => ({ ...NOV_BILL, totalAmount: 1000, payments: [], financeCharges: [], ...over });
  const inBill = (id: string, type: "DEBIT" | "CREDIT", amount: number, extra: Partial<Transaction> = {}) =>
    cardTx(id, type, amount, "2026-10-10", `t-${id}`, { billId: "bill-nov" }, extra);

  it("confere quando a soma bate, com estorno (CREDIT negativo) abatendo uma única vez", () => {
    const rec = reconcileBill(bill({ totalAmount: 900 }), [
      inBill("a", "DEBIT", 1000),
      inBill("b", "CREDIT", 100),
    ]);
    assert.equal(rec.transactionsTotal, 900);
    assert.equal(rec.difference, 0);
    assert.equal(rec.explained, true);
  });

  it("ignora \"Pagamento recebido\" na soma das compras", () => {
    const rec = reconcileBill(bill({ totalAmount: 1000 }), [
      inBill("a", "DEBIT", 1000),
      inBill("p", "CREDIT", 2241.23, { operationType: "PAGAMENTO_FATURA", description: "Pagamento recebido" }),
    ]);
    assert.equal(rec.transactionsTotal, 1000);
    assert.equal(rec.difference, 0);
  });

  it("explica a diferença com financeCharges quando ela fecha exatamente", () => {
    const rec = reconcileBill(bill({ totalAmount: 1050, financeCharges: [{ type: "IOF", amount: 50 }] }), [inBill("a", "DEBIT", 1000)]);
    assert.equal(rec.difference, 50);
    assert.equal(rec.explained, true);
    assert.deepEqual(rec.explainedBy.map((e) => e.amount), [50]);
  });

  it("explica com pagamento feito até o fechamento quando fecha exatamente", () => {
    const rec = reconcileBill(
      bill({ totalAmount: 800, payments: [{ paymentDate: "2026-10-15T00:00:00.000Z", amount: 200, valueType: "OTHER_PAYMENT" }] }),
      [inBill("a", "DEBIT", 1000)],
    );
    assert.equal(rec.difference, -200);
    assert.equal(rec.explained, true);
    assert.match(rec.explainedBy[0]?.label ?? "", /pagamentos/);
  });

  it("diferença que nada fecha fica sem explicação confirmada (dados reais: 4.837,66 × 4.616,17)", () => {
    const rec = reconcileBill(
      bill({
        totalAmount: 4837.6612,
        payments: [{ paymentDate: "2026-11-02T00:00:00.000Z", amount: 4637.76, valueType: "FULL_PAYMENT" }],
      }),
      [inBill("a", "DEBIT", 4616.17)],
    );
    assert.equal(rec.difference, 221.49);
    assert.equal(rec.explained, false);
    assert.deepEqual(rec.explainedBy, []);
    assert.equal(rec.financeCharges, 0);
    assert.equal(rec.payments.length, 1);
  });

  it("buildCard anexa a conferência só às faturas fechadas", () => {
    const result = build([inBill("a", "DEBIT", 4616.17)]);
    const closed = result.bills.find((b) => b.month === "2026-11");
    assert.equal(closed?.reconciliation?.explained, false);
    assert.equal(result.next?.reconciliation, null);
  });
});
