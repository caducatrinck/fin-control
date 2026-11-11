import { PluggyClient } from "../src/pluggy/client.ts";

const pluggy = PluggyClient.fromEnv();

await pluggy.authenticate();
console.log("✔ Autenticado com sucesso\n");

const connectors = await pluggy.searchConnectors("pluggy");
console.log("Conectores encontrados:");
for (const c of connectors.results) console.log(`  [${c.id}] ${c.name} (${c.type})`);

const itemId = process.env.PLUGGY_ITEM_ID;
if (!itemId) {
  console.log("\nPLUGGY_ITEM_ID não definido: rode `npm start` e conecte sua conta bancária pelo navegador.");
  process.exit(0);
}

const item = await pluggy.getItem(itemId);
console.log(`\nItem: ${item.connector?.name} | status: ${item.status} | última atualização: ${item.lastUpdatedAt}`);

const fmt = (d: Date): string => d.toISOString().slice(0, 10);
const to = new Date();
const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

const accounts = await pluggy.listAccounts(itemId);
for (const acc of accounts.results) {
  console.log(`\n=== ${acc.name} (${acc.type}/${acc.subtype}) | saldo: ${acc.balance} ${acc.currencyCode}`);

  const transactions = await pluggy.listTransactions(acc.id, { from: fmt(from), to: fmt(to) });
  console.log(`${transactions.length} transações nos últimos 30 dias`);
  for (const t of transactions.slice(0, 15)) {
    console.log(`  ${t.date.slice(0, 10)}  ${String(t.amount).padStart(10)}  ${t.description}`);
  }
}
