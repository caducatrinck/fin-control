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
import { isRefundCredit, matchRefunds, planKeyOf, refundStoreName } from "../src/refunds.ts";
import { computeTotals, expensesByTag } from "../src/transactions.ts";
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


// Fixtures no formato real da Pluggy (cartão Nubank): CREDIT com amount NEGATIVO, DEBIT POSITIVO,
// operationType em cada transação e billForecastDate na metadata.
const CARD = "acc-card";
const purchase = (id: string, amount: number, description: string, date: string, extra: Partial<Parameters<typeof tx>[0]> = {}) =>
  tx({ id, accountId: CARD, type: "DEBIT", amount, description, date: `${date}T12:00:00.000Z`, operationType: "PAGAMENTO", status: "PENDING", ...extra });
const refundTx = (id: string, amount: number, description: string, date: string, extra: Partial<Parameters<typeof tx>[0]> = {}) =>
  tx({ id, accountId: CARD, type: "CREDIT", amount: -Math.abs(amount), description, date: `${date}T12:00:00.000Z`, operationType: "ESTORNO", category: "Shopping", status: "PENDING", ...extra });
const installment = (id: string, n: number, total: number, amount: number, store: string, date: string, purchaseDate: string) =>
  purchase(id, amount, `${store} ${n}/${total}`, date, {
    creditCardMetadata: { installmentNumber: n, totalInstallments: total, purchaseDate, billForecastDate: date.slice(0, 7) },
  });

describe("estorno: detecção", () => {
  it("operationType ESTORNO basta, mesmo sem texto de estorno nem conta de cartão", () => {
    const generic = refundTx("r", 12.2, "Cursor, Ai Powered Ide", "2026-11-06", { accountId: "acc-bank" });
    assert.equal(isRefund(generic, "BANK", false), true);
    assert.equal(isRefundCredit(generic), true);
  });

  it("DEBIT/ESTORNO (\"Ajuste a débito\") é gasto, não estorno", () => {
    const adjust = tx({
      id: "adj",
      accountId: CARD,
      type: "DEBIT",
      amount: 3.62,
      description: "Ajuste a débito",
      operationType: "ESTORNO",
      category: "Transfers",
      date: "2026-10-04T12:00:00.000Z",
    });
    assert.equal(isRefundCredit(adjust), false);
    const enriched = enrichTransaction(adjust, emptyCtx());
    assert.equal(enriched.refund, false);
    assert.equal(enriched.direction, "out");
    assert.equal(enriched.amount, 3.62);
  });

  it("\"Pagamento recebido\" (PAGAMENTO_FATURA) não é estorno", () => {
    const paid = tx({
      id: "pay",
      accountId: CARD,
      type: "CREDIT",
      amount: -4637.76,
      description: "Pagamento recebido",
      operationType: "PAGAMENTO_FATURA",
      category: "Credit card payment",
    });
    assert.equal(isRefundCredit(paid), false);
    assert.equal(matchRefunds([paid]).size, 0);
    const enriched = enrichTransaction(paid, emptyCtx());
    assert.equal(enriched.internal, true);
    assert.equal(enriched.refund, false);
    assert.equal(enriched.amount, 4637.76);
  });

  it("cashback não é estorno", () => {
    assert.equal(isRefundCredit(refundTx("c", 5, "Cashback", "2026-11-01")), false);
  });

  it("extrai a loja só quando o texto a traz", () => {
    const store = (description: string) => refundStoreName({ description, operationType: "ESTORNO" });
    assert.equal(store("Estorno de compra"), "");
    assert.equal(store("Estorno de IOF de compra internacional"), "");
    assert.equal(store("Ajuste a crédito"), "");
    assert.equal(store("IOF de volta de Cursor, Ai Powered Ide"), "Cursor, Ai Powered Ide");
    assert.equal(store('Crédito de "SHOPEE *SHPSTECNOLOGIA"'), "SHOPEE *SHPSTECNOLOGIA");
    assert.equal(store("Estorno de Loja X"), "Loja X");
    assert.equal(store("Steamgames.Com"), "Steamgames.Com");
  });
});

describe("matchRefunds", () => {
  it("estorno de 199,90 (30/10, sem loja) casa com a compra Wellhub de 199,90 (29/10), categoria diferente", () => {
    const wellhub = purchase("wellhub", 199.9, "Wellhub", "2026-10-29", { category: "Gyms and fitness centers" });
    const other = purchase("other", 87.1, "Mercado", "2026-10-28");
    const refund = refundTx("r1", 199.9, "Estorno de compra", "2026-10-30");
    const match = matchRefunds([other, wellhub, refund]).get("r1");
    assert.equal(match?.purchase?.id, "wellhub");
    assert.equal(match?.kind, "exact");
  });

  it("assinatura mensal de mesmo valor: o estorno um dia depois fica com a compra mais próxima", () => {
    const wellhub = (id: string, date: string) => purchase(id, 199.9, "Wellhub Cadu Catrinck", date, { category: "Gyms and fitness centers" });
    const list = [wellhub("w-ago", "2026-08-29"), wellhub("w-set", "2026-09-29"), wellhub("w-out", "2026-10-29"), refundTx("r", 199.9, "Estorno de compra", "2026-10-30")];
    const match = matchRefunds(list).get("r");
    assert.equal(match?.purchase?.id, "w-out");
    assert.equal(match?.kind, "exact");
  });

  it("mesmo valor em datas parecidas (sem folga de 7 dias) continua pendente", () => {
    const list = [
      purchase("a", 199.9, "Wellhub", "2026-10-26"),
      purchase("b", 199.9, "Wellhub", "2026-10-29"),
      refundTx("r", 199.9, "Estorno de compra", "2026-10-30"),
    ];
    assert.equal(matchRefunds(list).get("r")?.purchase, null);
  });

  it("estorno de 691,24 sem compra única fica pendente de vínculo", () => {
    const list = [
      purchase("a", 500, "Loja A", "2026-10-01"),
      purchase("b", 650, "Loja B", "2026-10-02"),
      refundTx("r2", 691.24, "Estorno de compra", "2026-11-06"),
    ];
    const match = matchRefunds(list).get("r2");
    assert.equal(match?.purchase, null);
    assert.equal(match?.kind, null);
    assert.equal(match?.unlinked, false);
  });

  it("vários candidatos de mesmo valor: pendente, nunca chuta", () => {
    const list = [
      purchase("a", 50, "Loja A", "2026-10-01"),
      purchase("b", 50, "Loja B", "2026-10-02"),
      refundTx("r", 50, "Estorno de compra", "2026-10-05"),
    ];
    assert.equal(matchRefunds(list).get("r")?.purchase, null);
  });

  it("com loja no texto, filtra pela loja e desempata", () => {
    const list = [
      purchase("a", 79.88, "Cursor, Ai Powered Ide", "2026-10-01"),
      purchase("b", 79.88, "Outra Loja", "2026-10-02"),
      refundTx("r", 79.88, 'Crédito de "CURSOR, AI POWERED IDE"', "2026-10-05"),
    ];
    assert.equal(matchRefunds(list).get("r")?.purchase?.id, "a");
  });

  it("estorno parcial só pareia quando a loja está no texto e o par é único", () => {
    const withStore = [
      purchase("a", 173.06, "Shopee *Shpstecnologia", "2026-10-01"),
      refundTx("r", 100, 'Crédito de "SHOPEE *SHPSTECNOLOGIA"', "2026-10-05"),
    ];
    const partial = matchRefunds(withStore).get("r");
    assert.equal(partial?.purchase?.id, "a");
    assert.equal(partial?.kind, "partial");
    assert.equal(partial?.full, false);

    const noStore = [
      purchase("a", 173.06, "Shopee *Shpstecnologia", "2026-10-01"),
      refundTx("r", 100, "Estorno de compra", "2026-10-05"),
    ];
    assert.equal(matchRefunds(noStore).get("r")?.purchase, null);
  });

  it("estorno parcial consome o saldo da compra: o segundo não cabe", () => {
    const list = [
      purchase("a", 100, "Loja Z", "2026-10-01"),
      refundTx("r1", 60, "Estorno de Loja Z", "2026-10-02"),
      refundTx("r2", 60, "Estorno de Loja Z", "2026-10-03"),
    ];
    const result = matchRefunds(list);
    assert.equal(result.get("r1")?.purchase?.id, "a");
    assert.equal(result.get("r2")?.purchase, null);
  });

  it("IOF de volta casa com o IOF de compra internacional, não com a compra", () => {
    const list = [
      purchase("cursor", 3.94, "Cursor, Ai Powered Ide", "2026-02-28"),
      purchase("iof", 3.94, "IOF de compra internacional", "2026-02-28", { operationType: "TARIFA", category: "Tax on financial operations" }),
      refundTx("r", 3.94, "IOF de volta de Cursor, Ai Powered Ide", "2026-03-02", { category: "Tax on financial operations" }),
    ];
    assert.equal(matchRefunds(list).get("r")?.purchase?.id, "iof");
  });

  it("IOF debitado 1 dia depois do estorno (18/08 × 19/08) ainda casa; compra comum não", () => {
    const iof = purchase("iof", 3.91, "IOF de compra internacional", "2026-08-19", { operationType: "TARIFA", category: "Tax on financial operations" });
    const iofRefund = refundTx("r", 3.91, "IOF de volta de Cursor, Ai Powered Ide", "2026-08-18", { category: "Tax on financial operations" });
    assert.equal(matchRefunds([iof, iofRefund]).get("r")?.purchase?.id, "iof");
    const later = purchase("p", 80, "Loja", "2026-08-19");
    assert.equal(matchRefunds([later, refundTx("r2", 80, "Estorno de compra", "2026-08-18")]).get("r2")?.purchase, null);
  });

  it("estorno comum nunca casa com débito de IOF", () => {
    const list = [
      purchase("iof", 3.62, "IOF de compra internacional", "2026-08-31", { operationType: "TARIFA", category: "Tax on financial operations" }),
      refundTx("r", 3.62, "Estorno de compra", "2026-09-01"),
    ];
    assert.equal(matchRefunds(list).get("r")?.purchase, null);
  });

  it("IOFs de mesmo valor em meses diferentes: cada estorno pega o seu", () => {
    const iof = (id: string, date: string) =>
      purchase(id, 3.62, "IOF de compra internacional", date, { operationType: "TARIFA", category: "Tax on financial operations" });
    const list = [
      iof("iof-ago", "2026-08-31"),
      refundTx("r-ago", 3.62, "IOF de volta de Openai *Chatgpt Subscr", "2026-08-31"),
      iof("iof-set", "2026-09-30"),
      refundTx("r-set", 3.62, "IOF de volta de Openai *Chatgpt Subscr", "2026-09-30"),
    ];
    const result = matchRefunds(list);
    assert.equal(result.get("r-ago")?.purchase?.id, "iof-ago");
    assert.equal(result.get("r-set")?.purchase?.id, "iof-set");
  });

  it("janela configurável entre compra e estorno", () => {
    const list = [purchase("a", 80, "Loja", "2026-07-01"), refundTx("r", 80, "Estorno de compra", "2026-09-29")];
    assert.equal(matchRefunds(list, { windowDays: 60 }).get("r")?.purchase, null);
    assert.equal(matchRefunds(list, { windowDays: 120 }).get("r")?.purchase?.id, "a");
  });

  it("não pareia com compra posterior ao estorno nem de outra conta", () => {
    const later = [purchase("a", 80, "Loja", "2026-10-10"), refundTx("r", 80, "Estorno de compra", "2026-10-05")];
    assert.equal(matchRefunds(later).get("r")?.purchase, null);
    const otherAccount = [
      purchase("a", 80, "Loja", "2026-10-01", { accountId: "outro-cartao" }),
      refundTx("r", 80, "Estorno de compra", "2026-10-05"),
    ];
    assert.equal(matchRefunds(otherAccount).get("r")?.purchase, null);
  });

  it("vínculo manual vale mesmo fora da janela e do valor; desvínculo desliga o automático", () => {
    const list = [
      purchase("old", 900, "Loja Antiga", "2026-01-10"),
      purchase("wellhub", 199.9, "Wellhub", "2026-10-29"),
      refundTx("r1", 691.24, "Estorno de compra", "2026-11-06"),
      refundTx("r2", 199.9, "Estorno de compra", "2026-10-30"),
    ];
    const result = matchRefunds(list, { windowDays: 60, manual: new Map<string, string | null>([["r1", "old"], ["r2", null]]) });
    assert.equal(result.get("r1")?.purchase?.id, "old");
    assert.equal(result.get("r1")?.kind, "manual");
    assert.equal(result.get("r2")?.purchase, null);
    assert.equal(result.get("r2")?.unlinked, true);
  });

  it("compras idênticas com purchaseDate de horário distinto não são duplicatas nem um mesmo plano", () => {
    const ticket = (id: string, time: string) =>
      installment(id, 5, 6, 72.5, "Ec *Ticketmaster", "2026-11-08", `2026-06-08T${time}.001Z`);
    const four = [ticket("t1", "22:48:21"), ticket("t2", "22:49:02"), ticket("t3", "22:50:40"), ticket("t4", "22:51:13")];
    assert.equal(new Set(four.map((t) => planKeyOf(t))).size, 4);
    // Estorno de 72,50 sem loja: quatro compras igualmente candidatas → pendente.
    const result = matchRefunds([...four, refundTx("r", 72.5, "Estorno de compra", "2026-11-09")]);
    assert.equal(result.get("r")?.purchase, null);
    // Nenhuma é cancelada por existir outra igual.
    assert.equal(cancelledInstallmentIds(four).size, 0);
  });
});

describe("estorno x parcelas", () => {
  const plan = (purchaseDate = "2026-09-01T10:00:00.000Z") => [
    installment("s1", 1, 3, 50.73, "Shopee *Shpstecnologia", "2026-09-05", purchaseDate),
    installment("s2", 2, 3, 50.73, "Shopee *Shpstecnologia", "2026-10-05", purchaseDate),
    installment("s3", 3, 3, 50.73, "Shopee *Shpstecnologia", "2026-11-05", purchaseDate),
  ];

  it("estorno parcial abate a parcela e NÃO cancela o plano", () => {
    const list = [...plan(), refundTx("r", 46, 'Crédito de "SHOPEE *SHPSTECNOLOGIA"', "2026-09-20")];
    const matches = matchRefunds(list);
    assert.equal(matches.get("r")?.kind, "partial");
    assert.equal(cancelledInstallmentIds(list, matches).size, 0);
    const enriched = enrichTransaction(list[3]!, emptyCtx({ refundMatches: matches }));
    assert.equal(enriched.refundLink?.partial, true);
    assert.equal(enriched.refundLink?.status, "linked");
  });

  it("estorno que cobre o total do plano cancela as parcelas seguintes", () => {
    const list = [...plan(), refundTx("r", 152.19, 'Crédito de "SHOPEE *SHPSTECNOLOGIA"', "2026-09-20")];
    const matches = matchRefunds(list);
    assert.equal(matches.get("r")?.full, true);
    const cancelled = cancelledInstallmentIds(list, matches);
    assert.deepEqual([...cancelled].sort(), ["s2", "s3"]);
  });

  it("dois estornos parciais que somam o total cancelam o plano", () => {
    const list = [
      ...plan(),
      refundTx("r1", 100, 'Crédito de "SHOPEE *SHPSTECNOLOGIA"', "2026-09-20"),
      refundTx("r2", 52.19, 'Crédito de "SHOPEE *SHPSTECNOLOGIA"', "2026-09-22"),
    ];
    const cancelled = cancelledInstallmentIds(list, matchRefunds(list));
    assert.deepEqual([...cancelled].sort(), ["s2", "s3"]);
  });

  it("estorno igual a uma parcela é parcial: não cancela com pareamento (sem pareamento vale a heurística antiga)", () => {
    const list = [...plan(), refundTx("r", 50.73, "Estorno de compra", "2026-09-20")];
    const matches = matchRefunds(list);
    assert.equal(cancelledInstallmentIds(list, matches).size, 0);
    assert.deepEqual([...cancelledInstallmentIds(list)].sort(), ["s2", "s3"]);
  });

  it("estorno desvinculado à mão não cancela parcelas", () => {
    const list = [...plan(), refundTx("r", 50.73, "Estorno de compra", "2026-09-20")];
    const matches = matchRefunds(list, { windowDays: 60, manual: new Map([["r", null]]) });
    assert.equal(cancelledInstallmentIds(list, matches).size, 0);
  });
});

describe("estorno herda tag e abate a categoria original em outro mês", () => {
  it("tag da compra de outubro abate no gasto de novembro", () => {
    const wellhub = purchase("wellhub", 199.9, "Wellhub", "2026-10-29", { category: "Gyms and fitness centers" });
    const refund = refundTx("r", 199.9, "Estorno de compra", "2026-11-02");
    const matches = matchRefunds([wellhub, refund]);
    const ctx = emptyCtx({ refundMatches: matches, tagByKey: new Map([["desc:wellhub", "tag-saude"]]) });
    const enrichedRefund = enrichTransaction(refund, ctx);
    assert.equal(enrichedRefund.tagId, "tag-saude");
    assert.equal(enrichedRefund.refund, true);
    assert.equal(enrichedRefund.amount, 199.9);
    assert.equal(enrichedRefund.displayName, "ESTORNO - Wellhub");
    assert.equal(enrichedRefund.refundLink?.purchaseName, "Wellhub");
    assert.equal(enrichedRefund.refundLink?.purchaseDate, "2026-10-29T12:00:00.000Z");

    // Em novembro só existe o estorno: a categoria original fica negativa, sem sinal duplo.
    const november = [enrichedRefund];
    assert.deepEqual(expensesByTag(november), [{ tagId: "tag-saude", total: -199.9, count: 1 }]);
    assert.equal(computeTotals(november).expense, -199.9);
  });

  it("estorno pendente fica sem tag herdada e marcado como pendente", () => {
    const refund = refundTx("r", 691.24, "Estorno de compra", "2026-11-06");
    const enriched = enrichTransaction(refund, emptyCtx({ refundMatches: matchRefunds([refund]) }));
    assert.equal(enriched.tagId, null);
    assert.equal(enriched.refundLink?.status, "pending");
    assert.equal(enriched.refundLink?.unlinked, false);
  });
});
