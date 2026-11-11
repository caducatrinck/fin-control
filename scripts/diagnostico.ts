import { PluggyClient } from "../src/pluggy/client.ts";
import type { PaymentParticipant, Transaction } from "../src/pluggy/types.ts";
import { connectedAccountKeys, internalReason } from "../src/transactions.ts";

const DAYS = 90;
const MIN_AMOUNT = 1000;

const itemId = process.env.PLUGGY_ITEM_ID;
if (!itemId) {
  console.log("PLUGGY_ITEM_ID não definido: conecte sua conta bancária pelo app (npm start) primeiro.");
  process.exit(1);
}

const pluggy = PluggyClient.fromEnv();
const fmt = (d: Date): string => d.toISOString().slice(0, 10);
const to = new Date();
const from = new Date(to.getTime() - DAYS * 24 * 60 * 60 * 1000);

const mask = (doc: string | undefined): string => {
  const digits = doc?.replace(/\D/g, "") ?? "";
  return digits ? `${digits.slice(0, 3)}***${digits.slice(-2)}` : "-";
};

const participant = (p: PaymentParticipant | undefined): string =>
  p ? `${p.name ?? "?"} [${mask(p.documentNumber?.value)}] ag ${p.branchNumber ?? "-"} cc ${p.accountNumber ?? "-"}` : "-";

function describe(t: Transaction, accountName: string, connected: ReadonlySet<string>): string {
  const reason = internalReason(t, connected);
  return [
    `${t.date.slice(0, 10)}  ${t.type.padEnd(6)}  ${t.amount.toFixed(2).padStart(10)}  [${accountName}]`,
    `    descrição: ${t.description}${t.descriptionRaw && t.descriptionRaw !== t.description ? ` | bruta: ${t.descriptionRaw}` : ""}`,
    `    categoria: ${t.category ?? "-"} (${t.categoryId ?? "-"})`,
    `    pagador:   ${participant(t.paymentData?.payer)}`,
    `    recebedor: ${participant(t.paymentData?.receiver)}`,
    `    método:    ${t.paymentData?.paymentMethod ?? "-"}`,
    `    fin-control: ${reason ? `INTERNA (${reason})` : "conta nos totais"}`,
  ].join("\n");
}

const item = await pluggy.getItem(itemId);
console.log(`Conexão: ${item.connector?.name ?? "?"} | status ${item.status} | última sincronização ${item.lastUpdatedAt ?? "nunca"}`);
console.log(`Período: ${fmt(from)} a ${fmt(to)}\n`);

const accounts = await pluggy.listAccounts(itemId);
const connected = connectedAccountKeys(accounts.results);
console.log(`Contas conectadas (números): ${[...connected].join(", ") || "-"}\n`);
for (const acc of accounts.results) {
  const transactions = await pluggy.listTransactions(acc.id, { from: fmt(from), to: fmt(to) });
  const dates = transactions.map((t) => t.date.slice(0, 10)).sort();
  console.log(`=== ${acc.name} (${acc.type}/${acc.subtype}) | saldo ${acc.balance} ${acc.currencyCode}`);
  console.log(`    ${transactions.length} transações | mais antiga ${dates[0] ?? "-"} | mais recente ${dates.at(-1) ?? "-"}`);

  const credits = transactions.filter((t) => t.type === "CREDIT").length;
  console.log(`    ${credits} entradas (CREDIT) e ${transactions.length - credits} saídas (DEBIT)\n`);

  const big = transactions
    .filter((t) => Math.abs(t.amount) >= MIN_AMOUNT)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!big.length) console.log(`    Nenhuma movimentação acima de ${MIN_AMOUNT} no período.\n`);
  for (const t of big) console.log(`${describe(t, acc.name, connected)}\n`);
}
