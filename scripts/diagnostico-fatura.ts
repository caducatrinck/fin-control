// Diagnóstico da fatura do cartão com dados reais. Somente leitura.
// Uso: npm run diagnostico:fatura [-- yyyy-mm-dd]  (padrão: 01/10 do ano corrente)
import { PluggyClient } from "../src/pluggy/client.ts";
import type { Bill, Transaction } from "../src/pluggy/types.ts";
import { buildCard } from "../src/card.ts";
import { matchRefunds } from "../src/refunds.ts";
import { DEFAULT_CARD_SETTINGS } from "../src/shared/api.ts";
import { cancelledInstallmentIds, connectedAccountKeys, enrichTransaction } from "../src/transactions.ts";

const itemId = process.env.PLUGGY_ITEM_ID;
if (!itemId) throw new Error("PLUGGY_ITEM_ID não definido");
const from = process.argv[2] ?? `${new Date().getFullYear()}-10-01`;
const to = new Date().toISOString().slice(0, 10);
const pluggy = PluggyClient.fromEnv();
const brl = (n: number): string => n.toFixed(2).padStart(10);

const accounts = (await pluggy.listAccounts(itemId)).results.filter((a) => a.type === "CREDIT");
console.log(`Período ${from} → ${to} | ${accounts.length} cartão(ões) CREDIT\n`);

for (const acc of accounts) {
  console.log(`######## ${acc.name} (${acc.id})`);
  console.log("creditData:", JSON.stringify(acc.creditData));
  const bills = await pluggy.listBills(acc.id);
  console.log(`listBills (${bills.length}):`);
  for (const b of bills) console.log("  ", JSON.stringify(b));

  const txs = await pluggy.listTransactions(acc.id, { from, to });
  txs.sort((a, b) => a.date.localeCompare(b.date));
  console.log(`\nTransações (${txs.length}):`);
  for (const t of txs) {
    const m = t.creditCardMetadata;
    console.log(
      [
        t.date.slice(0, 10),
        t.type.padEnd(6),
        brl(t.amount),
        (t.status ?? "-").padEnd(7),
        `bill=${m?.billId ?? "-"}`,
        `parc=${m?.installmentNumber ?? "-"}/${m?.totalInstallments ?? "-"}`,
        `compra=${m?.purchaseDate?.slice(0, 10) ?? "-"}`,
        `cat=${t.category ?? "-"}`,
        `| ${t.description}`,
        t.descriptionRaw && t.descriptionRaw !== t.description ? `| raw: ${t.descriptionRaw}` : "",
      ].join("  "),
    );
  }

  const open = txs.filter((t) => t.status === "PENDING" && !t.creditCardMetadata?.billId);
  // A API manda CREDIT negativo e DEBIT positivo: normaliza pelo tipo para nunca aplicar o sinal duas vezes.
  const sum = (l: Transaction[]): number => l.reduce((a, t) => a + (t.type === "DEBIT" ? Math.abs(t.amount) : -Math.abs(t.amount)), 0);
  const debits = open.filter((t) => t.type === "DEBIT");
  const credits = open.filter((t) => t.type === "CREDIT");
  console.log(`\n--- PENDING sem billId (o que o app chama de próxima fatura) ---`);
  console.log(`débitos: ${debits.length} = ${sum(debits).toFixed(2)} | créditos/estornos: ${credits.length} = ${(-sum(credits)).toFixed(2)} | líquido ${sum(open).toFixed(2)}`);
  console.log(`parcelas (total>1): ${open.filter((t) => (t.creditCardMetadata?.totalInstallments ?? 0) > 1).length}`);
  const noStatus = txs.filter((t) => !t.status);
  console.log(`transações sem status: ${noStatus.length}`);
  const byBill = new Map<string, number>();
  for (const t of txs) byBill.set(t.creditCardMetadata?.billId ?? `(sem bill, ${t.status ?? "-"})`, (byBill.get(t.creditCardMetadata?.billId ?? `(sem bill, ${t.status ?? "-"})`) ?? 0) + (t.type === "DEBIT" ? Math.abs(t.amount) : -Math.abs(t.amount)));
  console.log("soma por billId:", Object.fromEntries([...byBill].map(([k, v]) => [k, +v.toFixed(2)])));

  console.log(`\n--- Candidatos a estorno (CREDIT, ou categoria/descrição de estorno) ---`);
  const re = /estorno|reembolso|devolu|refund|chargeback|cr[eé]dito de/i;
  for (const t of txs.filter((x) => x.type === "CREDIT" || re.test(`${x.category} ${x.description} ${x.descriptionRaw}`))) {
    console.log(`  ${t.date.slice(0, 10)} ${t.type} ${brl(t.amount)} ${t.status ?? "-"} cat=${t.category} id=${t.id.slice(0, 8)} | ${t.description}`);
    const stem = t.description.replace(/estorno de|cr[eé]dito de|["“”]/gi, "").trim().toLowerCase().slice(0, 12);
    for (const o of txs.filter((x) => x.type === "DEBIT" && stem && x.description.toLowerCase().includes(stem))) {
      console.log(`      ↳ candidata: ${o.date.slice(0, 10)} ${brl(o.amount)} ${o.status ?? "-"} parc=${o.creditCardMetadata?.installmentNumber ?? "-"}/${o.creditCardMetadata?.totalInstallments ?? "-"} | ${o.description}`);
    }
  }
  console.log();
}

// --- Próxima fatura como o app calcula agora (mesmo caminho do servidor: pareamento, enrich, buildCard) ---
const allAccounts = (await pluggy.listAccounts(itemId)).results;
const brlFmt = (n: number): string => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const history: Transaction[] = [];
const billsByAccount = new Map<string, Bill[]>();
for (const acc of allAccounts.filter((a) => a.type === "CREDIT")) {
  history.push(...(await pluggy.listTransactions(acc.id, { from: `${new Date().getFullYear() - 1}-06-01`, to })));
  billsByAccount.set(acc.id, await pluggy.listBills(acc.id));
}
const matches = matchRefunds(history, { windowDays: DEFAULT_CARD_SETTINGS.refundWindowDays });
const ctx = {
  accounts: new Map(allAccounts.map((a) => [a.id, a])),
  tagByKey: new Map<string, string>(),
  aliasByKey: new Map<string, string>(),
  filters: [],
  connected: connectedAccountKeys(allAccounts),
  cancelledIds: cancelledInstallmentIds(history, matches),
  refundMatches: matches,
};
const enriched = history.map((t) => enrichTransaction(t, ctx));
const today = new Date();
const bankArg = process.argv[3] ? Number(process.argv[3]) : null;
console.log("\n######## PRÓXIMA FATURA (buildCard)");
console.log(`estornos pareados: ${[...matches.values()].filter((m) => m.purchase).length} | pendentes de vínculo: ${[...matches.values()].filter((m) => !m.purchase).length}`);
for (const m of matches.values()) {
  if (m.purchase || m.refund.date.slice(0, 7) < "2026-10") continue;
  console.log(`  pendente: ${m.refund.date.slice(0, 10)} ${Math.abs(m.refund.amount).toFixed(2)} | ${m.refund.description}`);
}
for (const projectInstallments of [false, true]) {
  const card = buildCard({
    accounts: allAccounts,
    raw: history,
    transactions: enriched,
    bills: billsByAccount,
    billsAvailable: true,
    range: { from: toMonthStart(today), to: to },
    today,
    fixedMonthly: 0,
    settings: { ...DEFAULT_CARD_SETTINGS, projectInstallments },
    billOverrides: bankArg === null || !card0(allAccounts) ? [] : [{ accountId: card0(allAccounts)!, month: nextMonthOf(today), amount: bankArg }],
  });
  const next = card.next;
  console.log(`\nprojeção de parcelas ${projectInstallments ? "LIGADA" : "desligada"}:`);
  console.log(`  Próxima fatura ${next?.month}: ${brlFmt(next?.total ?? 0)} (parcial/estimada; ${next?.forecastCount} lançamentos pela billForecastDate)`);
  if (projectInstallments) {
    for (const p of next?.projected ?? []) console.log(`    + ${p.description} ${p.installment}  ${p.amount.toFixed(2)}`);
    console.log(`  Projetado (estimativa, fora do valor da API): ${brlFmt(next?.projectedTotal ?? 0)} → total estimado ${brlFmt((next?.total ?? 0) + (next?.projectedTotal ?? 0))}`);
  }
  if (next?.bankAmount != null) console.log(`  Banco ${brlFmt(next.bankAmount)} − API = ${brlFmt(next.difference ?? 0)}${next.differenceWithProjection != null ? ` | com projeção: ${brlFmt(next.differenceWithProjection)}` : ""}`);
  if (!projectInstallments) {
    for (const b of card.bills.filter((x) => x.reconciliation).slice(-3)) {
      const r = b.reconciliation!;
      console.log(`  fatura ${b.month}: transações ${r.transactionsTotal.toFixed(2)} × totalAmount ${r.totalAmount.toFixed(2)} → ${r.explained ? `explicada (${r.explainedBy.map((e) => e.label).join(" + ") || "confere"})` : `diferença ${r.difference.toFixed(2)} sem explicação confirmada`}`);
    }
  }
}

function toMonthStart(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function card0(accs: { id: string; type: string }[]): string | undefined {
  return accs.find((a) => a.type === "CREDIT")?.id;
}
function nextMonthOf(d: Date): string {
  const n = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`;
}
