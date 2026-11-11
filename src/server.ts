import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { PluggyClient, PluggyApiError } from "./pluggy/client.ts";
import type { Account, Bill, Investment, Item, ItemStatus, Transaction } from "./pluggy/types.ts";
import { readEnv, updateEnv, type AppEnv } from "./env.ts";
import * as store from "./store.ts";
import {
  aliasIndex,
  cancelledInstallmentIds,
  computeTotals,
  connectedAccountKeys,
  enrichTransaction,
  expensesByTag,
  normalizeDescription,
  tagIndex,
} from "./transactions.ts";
import { matchRefunds } from "./refunds.ts";
import { buildRecurring, historyStart } from "./recurring.ts";
import { buildInvestmentIncome, applyYieldOverrides, buildWealth, wealthStart } from "./wealth.ts";
import { listInvestmentSnapshots, recordInvestmentSnapshot } from "./snapshots.ts";
import { getWealthManual, setWealthManual } from "./manual-wealth.ts";
import { listYieldOverrides, setYieldOverride } from "./yield-overrides.ts";
import { fetchAnnualCdi } from "./cdi.ts";
import { addMonths, buildCard, cardStart } from "./card.ts";
import type {
  ApiRoute,
  ApiRoutes,
  ConfirmRecurringRequest,
  CreateRecurringRequest,
  CreateTagRequest,
  CredentialsRequest,
  DeleteTagFilterRequest,
  DeleteTagRequest,
  EditRecurringRequest,
  ErrorResponse,
  ItemRequest,
  MarkRecurringPaidRequest,
  PeriodRequest,
  PeriodTransaction,
  SetAliasRequest,
  SetExpectedRequest,
  SetRecurringRequest,
  SetRefundRequest,
  SetRefundLinkRequest,
  SetBillOverrideRequest,
  SetCardSettingsRequest,
  CardSettings,
  SetRuleRequest,
  SetWealthManualRequest,
  SetYieldOverrideRequest,
  TagsResponse,
  UpdateRecurringRequest,
  UpdateTagRequest,
  UpsertTagFilterRequest,
} from "./shared/api.ts";

const PORT = Number(process.env.PORT) || 3000;
const HOST = "127.0.0.1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_TAG_NAME = 40;
const MAX_ALIAS = 60;
const MAX_BATCH = 500;

const SRC_DIR = new URL("./", import.meta.url);
const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

let env: AppEnv = await readEnv();
let pluggy: PluggyClient | null = createClient(env);

function createClient({ PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET }: AppEnv): PluggyClient | null {
  if (!PLUGGY_CLIENT_ID || !PLUGGY_CLIENT_SECRET) return null;
  return new PluggyClient({ clientId: PLUGGY_CLIENT_ID, clientSecret: PLUGGY_CLIENT_SECRET });
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function requireClient(): PluggyClient {
  if (!pluggy) throw new HttpError(409, "Credenciais da Pluggy não configuradas.");
  return pluggy;
}

// Cache dos dados brutos da Pluggy por período (as tags são aplicadas a cada resposta).

interface RawPeriod {
  at: number;
  item: Item;
  accounts: Account[];
  transactions: Transaction[];
  /** Histórico completo (cartão com meses a mais): estornos podem ser de compras de períodos anteriores. */
  history?: Transaction[];
}

const periodCache = new Map<string, RawPeriod>();

const investmentCache = new Map<string, { at: number; investments: Investment[]; available: boolean }>();

const billCache = new Map<string, { at: number; bills: Map<string, Bill[]>; available: boolean }>();

function clearCache(): void {
  periodCache.clear();
  investmentCache.clear();
  billCache.clear();
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const SYNC_IN_PROGRESS: ReadonlySet<ItemStatus> = new Set(["UPDATING", "MERGING"]);
const SYNC_NEEDS_USER: ReadonlySet<ItemStatus> = new Set(["WAITING_USER_INPUT", "WAITING_USER_ACTION"]);
const SYNC_TIMEOUT_MS = 90_000;
const SYNC_DEBOUNCE_MS = 20_000;
/** Connector 200 = MeuPluggy: o PATCH /items não funciona; o sync é do MeuPluggy (a cada ~24h). */
const MEU_PLUGGY_CONNECTOR_ID = 200;
let lastSyncAt = 0;

function isMeuPluggyItem(item: Item): boolean {
  return item.connector?.id === MEU_PLUGGY_CONNECTOR_ID || /meupluggy/i.test(item.connector?.name ?? "");
}

function isMeuPluggyUpdateBlocked(err: unknown): boolean {
  if (!(err instanceof PluggyApiError) || err.status !== 400) return false;
  const message =
    typeof err.data === "object" && err.data !== null && "message" in err.data
      ? String((err.data as { message: unknown }).message)
      : err.message;
  return /meupluggy.*cant be updated|can't be updated|cannot be updated/i.test(message);
}

/**
 * Pede à Pluggy um sync novo com o banco e espera terminar.
 * MeuPluggy: não dá para forçar via API — só limpa o cache local e relê o que já veio do MeuPluggy.
 */
async function syncItem(itemId: string): Promise<Item> {
  const client = requireClient();
  let item = await client.getItem(itemId);

  if (isMeuPluggyItem(item)) {
    clearCache();
    lastSyncAt = Date.now();
    console.log(
      `MeuPluggy: sync manual pela API não é permitido. Relendo dados (último sync Pluggy: ${item.lastUpdatedAt ?? "nunca"}).`,
    );
    return item;
  }

  if (!SYNC_IN_PROGRESS.has(item.status)) {
    console.log(`Sincronizando item ${itemId} com o banco (último sync: ${item.lastUpdatedAt ?? "nunca"})...`);
    try {
      item = await client.updateItem(itemId);
    } catch (err) {
      if (isMeuPluggyUpdateBlocked(err)) {
        clearCache();
        lastSyncAt = Date.now();
        console.warn("MeuPluggy bloqueou o PATCH; relendo dados locais da Pluggy.");
        return client.getItem(itemId);
      }
      throw err;
    }
  } else {
    console.log(`Item ${itemId} já está sincronizando (${item.status})...`);
  }

  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  while (SYNC_IN_PROGRESS.has(item.status)) {
    if (Date.now() > deadline) {
      throw new HttpError(504, "A sincronização com o banco demorou demais. Tente de novo em alguns minutos.");
    }
    await sleep(2000);
    item = await client.getItem(itemId);
  }

  if (SYNC_NEEDS_USER.has(item.status)) {
    throw new HttpError(409, "O banco pediu confirmação no app. Abra Configurações e reconecte a conta.");
  }
  if (item.status === "LOGIN_ERROR") {
    throw new HttpError(409, "Erro de login no banco. Abra Configurações e reconecte a conta.");
  }

  clearCache();
  console.log(`✔ Sync concluído (${item.status}); lastUpdatedAt=${item.lastUpdatedAt ?? "—"}`);
  lastSyncAt = Date.now();
  return item;
}

/** Em refresh, sync uma vez (evita PATCH repetido se várias abas pedirem ao mesmo tempo). */
async function ensureSynced(itemId: string, refresh: boolean): Promise<void> {
  if (!refresh) return;
  if (Date.now() - lastSyncAt < SYNC_DEBOUNCE_MS) {
    clearCache();
    return;
  }
  await syncItem(itemId);
}

/** Faturas fechadas de cada cartão; se a Pluggy não as oferecer, segue só com estimativas (available: false). */
async function fetchBills(
  itemId: string,
  accounts: readonly Account[],
  refresh: boolean,
): Promise<{ bills: Map<string, Bill[]>; available: boolean }> {
  const cached = billCache.get(itemId);
  if (cached && !refresh && Date.now() - cached.at < CACHE_TTL_MS) return cached;
  const client = requireClient();
  const bills = new Map<string, Bill[]>();
  let available = true;
  await Promise.all(
    accounts
      .filter((a) => a.type === "CREDIT")
      .map(async (a) => {
        try {
          bills.set(a.id, await client.listBills(a.id));
        } catch (err) {
          available = false;
          console.warn(`Faturas indisponíveis (${a.name}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
  );
  if ([...bills.values()].every((list) => list.length === 0)) available = false;
  const entry = { at: Date.now(), bills, available };
  billCache.set(itemId, entry);
  return entry;
}

/** Resumo no terminal do que a Pluggy devolveu, para conferir com o app do banco. */
function logInvestments(investments: readonly Investment[]): void {
  const brl = (v: number | null | undefined): string => (v ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  console.log(`Investimentos recebidos da Pluggy: ${investments.length}`);
  for (const i of investments) {
    const lucro =
      i.amountProfit ??
      (typeof i.amountOriginal === "number" && i.amountOriginal > 0
        ? (typeof i.amount === "number" ? i.amount : i.balance) - i.amountOriginal
        : null);
    console.log(
      `  · ${i.name} | ${i.type}${i.subtype ? `/${i.subtype}` : ""} | status ${i.status ?? "—"} | saldo ${brl(i.balance)} | bruto ${brl(i.amount)}` +
        ` | aplicado ${i.amountOriginal ?? "—"} | lucro ${lucro === null ? "—" : brl(lucro)} | taxa mês ${i.lastMonthRate ?? "—"}` +
        ` | compra ${i.purchaseDate?.slice(0, 10) ?? i.issueDate?.slice(0, 10) ?? "—"}` +
        ` | ${i.rate != null ? `${i.rate}% ${i.rateType ?? ""}`.trim() : "sem %"}` +
        `${i.fixedAnnualRate != null ? ` | pré ${i.fixedAnnualRate}%` : ""}`,
    );
  }
  const total = investments.filter((i) => i.status !== "TOTAL_WITHDRAWAL").reduce((acc, i) => acc + i.balance, 0);
  console.log(`  Total considerado: ${brl(total)}`);
}

/** Investimentos da conexão; se a Pluggy não os oferecer para ela, segue sem (available: false). */
async function fetchInvestments(itemId: string, refresh: boolean): Promise<{ investments: Investment[]; available: boolean }> {
  const cached = investmentCache.get(itemId);
  if (cached && !refresh && Date.now() - cached.at < CACHE_TTL_MS) return cached;
  let entry: { at: number; investments: Investment[]; available: boolean };
  try {
    entry = { at: Date.now(), investments: await requireClient().listInvestments(itemId), available: true };
    logInvestments(entry.investments);
  } catch (err) {
    console.warn(`Investimentos indisponíveis: ${err instanceof Error ? err.message : String(err)}`);
    entry = { at: Date.now(), investments: [], available: false };
  }
  investmentCache.set(itemId, entry);
  return entry;
}

/** Cartão precisa de histórico antes do período para achar o estorno que cancela parcelas futuras. */
const CREDIT_LOOKBACK_MONTHS = 8;

async function fetchPeriod(itemId: string, from: string, to: string, refresh: boolean): Promise<RawPeriod> {
  const key = `${itemId}|${from}|${to}`;
  const cached = periodCache.get(key);
  if (cached && !refresh && Date.now() - cached.at < CACHE_TTL_MS) return cached;

  const client = requireClient();
  const [item, accounts] = await Promise.all([client.getItem(itemId), client.listAccounts(itemId)]);
  const creditFrom = `${addMonths(from.slice(0, 7), -CREDIT_LOOKBACK_MONTHS)}-01`;
  const perAccount = await Promise.all(
    accounts.results.map((acc) => {
      const start = acc.type === "CREDIT" && creditFrom < from ? creditFrom : from;
      return client.listTransactions(acc.id, { from: start, to });
    }),
  );
  const all = perAccount.flat();
  // Guarda só o período pedido; o pareamento de estornos e o cancelamento de parcelas usam o histórico completo.
  const inRange = all.filter((t) => {
    const day = t.date.slice(0, 10);
    return day >= from && day <= to;
  });
  const raw: RawPeriod = {
    at: Date.now(),
    item,
    accounts: accounts.results,
    transactions: inRange,
    history: all,
  };
  periodCache.set(key, raw);
  return raw;
}

const toLocalIsoDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function requireItemId(): string {
  const itemId = env.PLUGGY_ITEM_ID;
  if (!itemId) throw new HttpError(409, "Nenhuma conta bancária conectada.");
  return itemId;
}

/** Aplica tags, descrições e classificação às transações brutas, da mais recente para a mais antiga. */
function enrichAll(
  raw: RawPeriod,
  { rules, filters, aliases, refundOverrides, refundLinks, cardSettings }: TagsResponse,
): PeriodTransaction[] {
  const history = raw.history ?? raw.transactions;
  const refundMatches = matchRefunds(history, {
    windowDays: cardSettings.refundWindowDays,
    manual: new Map(refundLinks.map((l) => [l.refundId, l.purchaseId])),
  });
  const cancelledIds = cancelledInstallmentIds(history, refundMatches);
  const ctx = {
    accounts: new Map(raw.accounts.map((a) => [a.id, a])),
    tagByKey: tagIndex(rules),
    aliasByKey: aliasIndex(aliases),
    filters,
    connected: connectedAccountKeys(raw.accounts),
    refundById: new Map(refundOverrides.map((r) => [r.id, r.refund])),
    cancelledIds,
    refundMatches,
  };
  return raw.transactions.map((t) => enrichTransaction(t, ctx)).sort((a, b) => b.date.localeCompare(a.date));
}

// Validação dos corpos

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(body: unknown, field: string): string {
  const value = isRecord(body) ? body[field] : undefined;
  return typeof value === "string" ? value.trim() : "";
}

function parseCredentials(body: unknown): CredentialsRequest {
  const clientId = stringField(body, "clientId");
  const clientSecret = stringField(body, "clientSecret");
  if (!UUID.test(clientId)) throw new HttpError(400, "O Client ID deve estar no formato UUID (copie do Dashboard).");
  if (!clientSecret) throw new HttpError(400, "Informe o Client Secret.");
  return { clientId, clientSecret };
}

function parseItem(body: unknown): ItemRequest {
  const itemId = stringField(body, "itemId");
  if (!UUID.test(itemId)) throw new HttpError(400, "itemId inválido.");
  return { itemId };
}

function parsePeriod(body: unknown): Required<PeriodRequest> {
  const from = stringField(body, "from");
  const to = stringField(body, "to");
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) throw new HttpError(400, "Datas devem estar no formato aaaa-mm-dd.");
  if (from > to) throw new HttpError(400, "A data inicial deve ser anterior à final.");
  const refresh = isRecord(body) && body.refresh === true;
  return { from, to, refresh };
}

function parseTagName(body: unknown): string {
  const name = stringField(body, "name");
  if (!name) throw new HttpError(400, "Informe o nome da tag.");
  if (name.length > MAX_TAG_NAME) throw new HttpError(400, `O nome da tag pode ter até ${MAX_TAG_NAME} caracteres.`);
  return name;
}

function parseTagColor(body: unknown): CreateTagRequest["color"] {
  const color = isRecord(body) ? body.color : undefined;
  if (!store.isTagColor(color)) throw new HttpError(400, "Cor de tag inválida.");
  return color;
}

function parseCreateTag(body: unknown): CreateTagRequest {
  return { name: parseTagName(body), color: parseTagColor(body) };
}

function parseUpdateTag(body: unknown): UpdateTagRequest {
  const id = stringField(body, "id");
  if (!id) throw new HttpError(400, "Tag inválida.");
  return { id, name: parseTagName(body), color: parseTagColor(body) };
}

function parseDeleteTag(body: unknown): DeleteTagRequest {
  const id = stringField(body, "id");
  if (!id) throw new HttpError(400, "Tag inválida.");
  return { id };
}

function parseSetRule(body: unknown): SetRuleRequest {
  const key = stringField(body, "key");
  const label = stringField(body, "label");
  const rawTagId = isRecord(body) ? body.tagId : undefined;
  if (!key) throw new HttpError(400, "Pagador/recebedor inválido.");
  if (rawTagId !== null && typeof rawTagId !== "string") throw new HttpError(400, "Tag inválida.");
  return { key, label: label || key, tagId: rawTagId };
}

function parseOptionalAmount(body: unknown, field: string): number | null {
  if (!isRecord(body) || body[field] === null || body[field] === undefined || body[field] === "") return null;
  const value = typeof body[field] === "number" ? body[field] : Number(body[field]);
  if (!Number.isFinite(value) || value <= 0) throw new HttpError(400, "Valor do filtro inválido.");
  return Math.round(value * 100) / 100;
}

function parseUpsertFilter(body: unknown): UpsertTagFilterRequest {
  const tagId = stringField(body, "tagId");
  if (!tagId) throw new HttpError(400, "Tag inválida.");
  const id = stringField(body, "id");
  const amount = parseOptionalAmount(body, "amount");
  const contains = stringField(body, "contains") || null;
  if (amount === null && !contains) throw new HttpError(400, "Informe o valor e/ou o texto do filtro.");
  if (contains && contains.length > 80) throw new HttpError(400, "O texto do filtro pode ter até 80 caracteres.");
  return id ? { id, tagId, amount, contains } : { tagId, amount, contains };
}

function parseDeleteFilter(body: unknown): DeleteTagFilterRequest {
  const id = stringField(body, "id");
  if (!id) throw new HttpError(400, "Filtro inválido.");
  return { id };
}

function parseWealthManual(body: unknown): SetWealthManualRequest {
  const note = stringField(body, "note") || null;
  if (note && note.length > 80) throw new HttpError(400, "A nota pode ter até 80 caracteres.");
  const dateRaw = stringField(body, "date");
  const date = dateRaw || null;
  if (date && !ISO_DATE.test(date)) throw new HttpError(400, "Data deve estar no formato aaaa-mm-dd.");
  if (!isRecord(body) || body.amount === null || body.amount === undefined || body.amount === "") {
    return { amount: null, note, date };
  }
  const value = typeof body.amount === "number" ? body.amount : Number(body.amount);
  if (!Number.isFinite(value) || value < 0) throw new HttpError(400, "Valor do ajuste inválido.");
  return { amount: value === 0 ? null : Math.round(value * 100) / 100, note, date };
}

function parseYieldOverride(body: unknown): SetYieldOverrideRequest {
  const id = stringField(body, "id");
  if (!id) throw new HttpError(400, "Investimento inválido.");
  const dateRaw = stringField(body, "date");
  const date = dateRaw || null;
  if (date && !ISO_DATE.test(date)) throw new HttpError(400, "Data deve estar no formato aaaa-mm-dd.");

  if (!isRecord(body) || body.amount === null || body.amount === undefined || body.amount === "") {
    return { id, amount: null, date };
  }
  const value = typeof body.amount === "number" ? body.amount : Number(body.amount);
  if (!Number.isFinite(value) || value <= 0) throw new HttpError(400, "Valor do rendimento inválido.");
  return { id, amount: Math.round(value * 100) / 100, date };
}

function parseSetAlias(body: unknown): SetAliasRequest {
  const key = stringField(body, "key");
  const label = stringField(body, "label");
  const alias = stringField(body, "alias");
  if (!key) throw new HttpError(400, "Pagador/recebedor inválido.");
  if (alias.length > MAX_ALIAS) throw new HttpError(400, `A descrição pode ter até ${MAX_ALIAS} caracteres.`);
  return { key, label: label || key, alias: alias || null };
}

function parseSetRefund(body: unknown): SetRefundRequest {
  const id = stringField(body, "id");
  const refund = isRecord(body) ? body.refund : undefined;
  if (!id) throw new HttpError(400, "Transação inválida.");
  if (refund !== null && typeof refund !== "boolean") throw new HttpError(400, "Informe se é reembolso.");
  return { id, refund };
}

function parseSetRefundLink(body: unknown): SetRefundLinkRequest {
  const refundId = stringField(body, "refundId");
  if (!refundId) throw new HttpError(400, "Estorno inválido.");
  const purchaseId = isRecord(body) ? body.purchaseId : undefined;
  if (purchaseId !== undefined && purchaseId !== null && (typeof purchaseId !== "string" || !purchaseId)) {
    throw new HttpError(400, "Compra inválida.");
  }
  return { refundId, purchaseId };
}

function parseSetBillOverride(body: unknown): SetBillOverrideRequest {
  const accountId = stringField(body, "accountId");
  const month = stringField(body, "month");
  const amount = isRecord(body) ? body.amount : undefined;
  if (!accountId || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, "Cartão ou mês inválido.");
  if (amount !== null && (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0)) {
    throw new HttpError(400, "Informe um valor válido para a fatura.");
  }
  return { accountId, month, amount };
}

function parseSetCardSettings(body: unknown): SetCardSettingsRequest {
  const project = isRecord(body) ? body.projectInstallments : undefined;
  const window = isRecord(body) ? body.refundWindowDays : undefined;
  if (project !== undefined && typeof project !== "boolean") throw new HttpError(400, "Opção inválida.");
  if (
    window !== undefined &&
    (typeof window !== "number" || !Number.isInteger(window) || window < 1 || window > store.MAX_REFUND_WINDOW_DAYS)
  ) {
    throw new HttpError(400, `A janela deve ter entre 1 e ${store.MAX_REFUND_WINDOW_DAYS} dias.`);
  }
  return { projectInstallments: project, refundWindowDays: window };
}

function parseSetRecurring(body: unknown): SetRecurringRequest {
  const key = stringField(body, "key");
  const label = stringField(body, "label");
  const recurring = isRecord(body) ? body.recurring : undefined;
  if (!key) throw new HttpError(400, "Pagador/recebedor inválido.");
  if (typeof recurring !== "boolean") throw new HttpError(400, "Informe se é recorrente.");
  return { key, label: label || key, recurring };
}

function parseUpdateRecurring(body: unknown): UpdateRecurringRequest {
  const rawAdd = isRecord(body) ? body.add : undefined;
  const rawRemove = isRecord(body) ? body.remove : undefined;
  if (!Array.isArray(rawAdd) || !Array.isArray(rawRemove) || rawAdd.length + rawRemove.length > MAX_BATCH) {
    throw new HttpError(400, "Lista de contas inválida.");
  }
  const add = rawAdd.map((entry: unknown) => {
    const key = stringField(entry, "key");
    if (!key) throw new HttpError(400, "Pagador/recebedor inválido.");
    return { key, label: stringField(entry, "label") || key };
  });
  const remove = rawRemove.map((key: unknown) => {
    if (typeof key !== "string" || !key) throw new HttpError(400, "Pagador/recebedor inválido.");
    return key;
  });
  return { add, remove };
}

function parseAmount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1e9) {
    throw new HttpError(400, "Informe um valor maior que zero.");
  }
  return Math.round(value * 100) / 100;
}

function parseBillId(body: unknown): string {
  const id = stringField(body, "billId") || stringField(body, "id");
  if (!id) throw new HttpError(400, "Conta recorrente inválida.");
  return id;
}

function parseMonth(body: unknown): string {
  const month = stringField(body, "month");
  if (!MONTH.test(month)) throw new HttpError(400, "Mês deve estar no formato aaaa-mm.");
  return month;
}

function parseSetExpected(body: unknown): SetExpectedRequest {
  const id = parseBillId(body);
  const expected = isRecord(body) ? body.expected : undefined;
  return { id, expected: expected === null ? null : parseAmount(expected) };
}

function parseCreateRecurring(body: unknown): CreateRecurringRequest {
  const label = stringField(body, "label");
  if (!label) throw new HttpError(400, "Informe o que é a conta.");
  if (label.length > MAX_ALIAS) throw new HttpError(400, `O nome pode ter até ${MAX_ALIAS} caracteres.`);
  const day = isRecord(body) ? body.day : undefined;
  if (typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 31) {
    throw new HttpError(400, "O dia do vencimento deve ser entre 1 e 31.");
  }
  const key = stringField(body, "key") || null;
  const matchName = key ? null : normalizeDescription(stringField(body, "matchName")) || null;
  if (matchName && matchName.length < 3) throw new HttpError(400, "O nome para vincular precisa ter pelo menos 3 letras.");
  return {
    label,
    expected: parseAmount(isRecord(body) ? body.expected : undefined),
    day,
    key,
    matchName,
    linkLabel: key || matchName ? stringField(body, "linkLabel") || null : null,
    paidTransaction: parsePaidTransaction(isRecord(body) ? body.paidTransaction : undefined),
  };
}

function parsePaidTransaction(value: unknown): CreateRecurringRequest["paidTransaction"] {
  if (value === null || value === undefined) return null;
  const id = stringField(value, "id");
  if (!id) throw new HttpError(400, "Transação inválida.");
  return { id, month: parseMonth(value) };
}

function parseEditRecurring(body: unknown): EditRecurringRequest {
  return { ...parseCreateRecurring(body), id: parseBillId(body) };
}

function parseConfirmRecurring(body: unknown): ConfirmRecurringRequest {
  const transactionId = stringField(body, "transactionId");
  const paid = isRecord(body) ? body.paid : undefined;
  if (!transactionId) throw new HttpError(400, "Transação inválida.");
  if (typeof paid !== "boolean") throw new HttpError(400, "Informe se a transação é desta conta.");
  return { billId: parseBillId(body), transactionId, month: parseMonth(body), paid };
}

function parseMarkPaid(body: unknown): MarkRecurringPaidRequest {
  const paid = isRecord(body) ? body.paid : undefined;
  if (typeof paid !== "boolean") throw new HttpError(400, "Informe se foi pago.");
  return { billId: parseBillId(body), month: parseMonth(body), paid };
}

// Rotas

type Handlers = { [R in ApiRoute]: (body: unknown) => Promise<ApiRoutes[R]["response"]> };

const routes: Handlers = {
  "GET /api/status": async () => ({
    configured: pluggy !== null,
    connected: pluggy !== null && Boolean(env.PLUGGY_ITEM_ID),
  }),

  "POST /api/credentials": async (body) => {
    const { clientId, clientSecret } = parseCredentials(body);
    const candidate = new PluggyClient({ clientId, clientSecret });
    try {
      await candidate.authenticate();
    } catch {
      throw new HttpError(401, "A Pluggy recusou essas credenciais. Confira os valores no Dashboard.");
    }
    const appChanged = Boolean(env.PLUGGY_CLIENT_ID) && env.PLUGGY_CLIENT_ID !== clientId;
    await updateEnv({
      PLUGGY_CLIENT_ID: clientId,
      PLUGGY_CLIENT_SECRET: clientSecret,
      ...(appChanged && { PLUGGY_ITEM_ID: "" }),
    });
    env = await readEnv();
    pluggy = candidate;
    clearCache();
    console.log("✔ Credenciais validadas e salvas no .env");
    return { ok: true };
  },

  "GET /api/settings": async () => ({
    clientId: env.PLUGGY_CLIENT_ID ? `${env.PLUGGY_CLIENT_ID.slice(0, 8)}-••••` : null,
    itemId: env.PLUGGY_ITEM_ID ?? null,
  }),

  "POST /api/disconnect": async () => {
    await updateEnv({ PLUGGY_ITEM_ID: "" });
    env = await readEnv();
    clearCache();
    console.log("✔ Conta bancária desconectada");
    return { ok: true };
  },

  "POST /api/reset": async () => {
    await updateEnv({ PLUGGY_CLIENT_ID: "", PLUGGY_CLIENT_SECRET: "", PLUGGY_ITEM_ID: "" });
    env = await readEnv();
    pluggy = null;
    clearCache();
    console.log("✔ Credenciais e conta bancária removidas do .env");
    return { ok: true };
  },

  "POST /api/connect-token": async () => ({
    accessToken: await requireClient().createConnectToken(),
  }),

  "POST /api/item": async (body) => {
    const { itemId } = parseItem(body);
    await updateEnv({ PLUGGY_ITEM_ID: itemId });
    env = await readEnv();
    clearCache();
    console.log(`✔ Conta bancária conectada: item ${itemId} salvo no .env`);
    return { ok: true };
  },

  "POST /api/period": async (body) => {
    const { from, to, refresh } = parsePeriod(body);
    const itemId = requireItemId();
    await ensureSynced(itemId, refresh);
    const [raw, data, { investments }, cdiAnnual, yieldOverrides] = await Promise.all([
      fetchPeriod(itemId, from, to, refresh),
      store.getTags(),
      fetchInvestments(itemId, refresh),
      fetchAnnualCdi(),
      listYieldOverrides(),
    ]);
    const transactions = enrichAll(raw, data);
    const investmentIncome = applyYieldOverrides(
      buildInvestmentIncome(investments, cdiAnnual),
      yieldOverrides,
      { from, to },
    );

    return {
      range: { from, to },
      item: {
        connector: raw.item.connector?.name ?? null,
        status: raw.item.status,
        lastUpdatedAt: raw.item.lastUpdatedAt,
      },
      accounts: raw.accounts.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        subtype: a.subtype,
        balance: a.balance,
        currencyCode: a.currencyCode,
      })),
      transactions,
      totals: computeTotals(transactions),
      expensesByTag: expensesByTag(transactions),
      investmentIncome,
    };
  },

  "POST /api/wealth": async (body) => {
    const refresh = isRecord(body) && body.refresh === true;
    const itemId = requireItemId();
    await ensureSynced(itemId, refresh);
    const today = new Date();
    const [raw, { investments, available }, cdiAnnual, manual, yieldOverrides] = await Promise.all([
      fetchPeriod(itemId, wealthStart(today), toLocalIsoDate(today), refresh),
      fetchInvestments(itemId, refresh),
      fetchAnnualCdi(),
      getWealthManual(),
      listYieldOverrides(),
    ]);
    const active = investments.filter((i) => i.status !== "TOTAL_WITHDRAWAL");
    const total = active.reduce((acc, i) => acc + i.balance, 0);
    const snapshots = available
      ? await recordInvestmentSnapshot(toLocalIsoDate(today), total)
      : await listInvestmentSnapshots();
    return buildWealth(raw.accounts, investments, available, raw.transactions, today, snapshots, cdiAnnual, manual, yieldOverrides);
  },

  "POST /api/wealth/manual": async (body) => {
    const { amount, note, date } = parseWealthManual(body);
    await setWealthManual(amount, note, date);
    const itemId = requireItemId();
    const today = new Date();
    const [raw, { investments, available }, cdiAnnual, manual, yieldOverrides] = await Promise.all([
      fetchPeriod(itemId, wealthStart(today), toLocalIsoDate(today), false),
      fetchInvestments(itemId, false),
      fetchAnnualCdi(),
      getWealthManual(),
      listYieldOverrides(),
    ]);
    const active = investments.filter((i) => i.status !== "TOTAL_WITHDRAWAL");
    const total = active.reduce((acc, i) => acc + i.balance, 0);
    const snapshots = available
      ? await recordInvestmentSnapshot(toLocalIsoDate(today), total)
      : await listInvestmentSnapshots();
    return buildWealth(raw.accounts, investments, available, raw.transactions, today, snapshots, cdiAnnual, manual, yieldOverrides);
  },

  "POST /api/yield/override": async (body) => {
    const { id, amount, date } = parseYieldOverride(body);
    await setYieldOverride(id, amount, date);
    return { ok: true };
  },

  "POST /api/card": async (body) => {
    const { from, to, refresh } = parsePeriod(body);
    const itemId = requireItemId();
    await ensureSynced(itemId, refresh);
    const today = new Date();
    const cardFrom = cardStart(today, from);
    const recFrom = historyStart(from);
    const fetchFrom = cardFrom < recFrom ? cardFrom : recFrom;
    const [raw, data] = await Promise.all([
      fetchPeriod(itemId, fetchFrom, toLocalIsoDate(today), refresh),
      store.getTags(),
    ]);
    const transactions = enrichAll(raw, data);
    const [{ bills, available }, recurring] = await Promise.all([
      fetchBills(itemId, raw.accounts, refresh),
      Promise.resolve(buildRecurring(transactions, { from, to }, data.recurring, data.matches)),
    ]);
    return buildCard({
      accounts: raw.accounts,
      raw: raw.transactions,
      transactions,
      bills,
      billsAvailable: available,
      range: { from, to },
      today,
      fixedMonthly: recurring.totals.expected,
      settings: data.cardSettings,
      billOverrides: data.billOverrides,
    });
  },

  "GET /api/tags": () => store.getTags(),

  "POST /api/tags/create": async (body) => {
    const { name, color } = parseCreateTag(body);
    return store.createTag(name, color);
  },

  "POST /api/tags/update": async (body) => {
    const { id, name, color } = parseUpdateTag(body);
    const tag = await store.updateTag(id, name, color);
    if (!tag) throw new HttpError(404, "Tag não encontrada.");
    return tag;
  },

  "POST /api/tags/delete": async (body) => {
    const { id } = parseDeleteTag(body);
    if (!(await store.deleteTag(id))) throw new HttpError(404, "Tag não encontrada.");
    return { ok: true };
  },

  "POST /api/rules/set": async (body) => {
    const { key, label, tagId } = parseSetRule(body);
    if (!(await store.setRule(key, label, tagId))) throw new HttpError(404, "Tag não encontrada.");
    return { ok: true };
  },

  "POST /api/filters/upsert": async (body) => {
    const { id, tagId, amount, contains } = parseUpsertFilter(body);
    const filter = await store.upsertFilter(tagId, amount, contains, id);
    if (!filter) throw new HttpError(404, id ? "Filtro não encontrado." : "Tag não encontrada.");
    return filter;
  },

  "POST /api/filters/delete": async (body) => {
    const { id } = parseDeleteFilter(body);
    if (!(await store.deleteFilter(id))) throw new HttpError(404, "Filtro não encontrado.");
    return { ok: true };
  },

  "POST /api/aliases/set": async (body) => {
    const { key, label, alias } = parseSetAlias(body);
    await store.setAlias(key, label, alias);
    return { ok: true };
  },

  "POST /api/refunds/set": async (body) => {
    const { id, refund } = parseSetRefund(body);
    await store.setRefund(id, refund);
    return { ok: true };
  },

  "POST /api/refunds/link": async (body) => {
    const { refundId, purchaseId } = parseSetRefundLink(body);
    await store.setRefundLink(refundId, purchaseId);
    return { ok: true };
  },

  "POST /api/card/settings": async (body) => {
    const { projectInstallments, refundWindowDays } = parseSetCardSettings(body);
    const patch: Partial<CardSettings> = {};
    if (projectInstallments !== undefined) patch.projectInstallments = projectInstallments;
    if (refundWindowDays !== undefined) patch.refundWindowDays = refundWindowDays;
    await store.setCardSettings(patch);
    return { ok: true };
  },

  "POST /api/card/bill-override": async (body) => {
    const { accountId, month, amount } = parseSetBillOverride(body);
    await store.setBillOverride(accountId, month, amount);
    return { ok: true };
  },

  "POST /api/recurring": async (body) => {
    const { from, to, refresh } = parsePeriod(body);
    const itemId = requireItemId();
    await ensureSynced(itemId, refresh);
    const [raw, data] = await Promise.all([fetchPeriod(itemId, historyStart(from), to, refresh), store.getTags()]);
    return buildRecurring(enrichAll(raw, data), { from, to }, data.recurring, data.matches);
  },

  "POST /api/recurring/set": async (body) => {
    const { key, label, recurring } = parseSetRecurring(body);
    await store.setRecurring(key, label, recurring);
    return { ok: true };
  },

  "POST /api/recurring/expected": async (body) => {
    const { id, expected } = parseSetExpected(body);
    if (!(await store.setExpected(id, expected))) throw new HttpError(404, "Conta recorrente não encontrada.");
    return { ok: true };
  },

  "POST /api/recurring/create": async (body) => {
    const { paidTransaction, ...fields } = parseCreateRecurring(body);
    const id = await store.createRecurring(fields);
    if (paidTransaction) await store.setMatch(id, paidTransaction.month, paidTransaction.id, true);
    return { ok: true };
  },

  "POST /api/recurring/edit": async (body) => {
    const { id, paidTransaction, ...fields } = parseEditRecurring(body);
    if (!(await store.editRecurring(id, fields))) throw new HttpError(404, "Conta recorrente não encontrada.");
    if (paidTransaction) await store.setMatch(id, paidTransaction.month, paidTransaction.id, true);
    return { ok: true };
  },

  "POST /api/recurring/confirm": async (body) => {
    const { billId, transactionId, month, paid } = parseConfirmRecurring(body);
    if (!(await store.setMatch(billId, month, transactionId, paid))) {
      throw new HttpError(404, "Conta recorrente não encontrada.");
    }
    return { ok: true };
  },

  "POST /api/recurring/mark-paid": async (body) => {
    const { billId, month, paid } = parseMarkPaid(body);
    if (!(await store.setMatch(billId, month, null, paid))) throw new HttpError(404, "Conta recorrente não encontrada.");
    return { ok: true };
  },

  "POST /api/recurring/update": async (body) => {
    const { add, remove } = parseUpdateRecurring(body);
    await store.updateRecurring(add, remove);
    return { ok: true };
  },
};

function isApiRoute(key: string): key is ApiRoute {
  return Object.hasOwn(routes, key);
}

// HTTP

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new HttpError(400, "JSON inválido.");
  }
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, status: number, error: string): void {
  send(res, status, { error } satisfies ErrorResponse);
}

/**
 * Serve arquivos de src/web e os módulos de src/shared importados pelo navegador.
 * `/<nome>.js` é gerado de `src/web/<nome>.ts`; `/shared/<nome>.ts` é servido já sem tipos.
 */
function resolveStatic(pathname: string): { file: URL; type: string; strip: boolean } | null {
  const name = pathname === "/" ? "index.html" : pathname.slice(1);
  const shared = /^shared\/[\w-]+\.ts$/.exec(name);
  if (shared) return { file: new URL(name, SRC_DIR), type: STATIC_TYPES[".ts"] ?? "", strip: true };

  if (!/^[\w-]+\.(html|css|js|svg)$/.test(name)) return null;
  const ext = name.slice(name.lastIndexOf("."));
  const type = STATIC_TYPES[ext];
  if (!type) return null;
  if (ext === ".js") return { file: new URL(`web/${name.replace(/\.js$/, ".ts")}`, SRC_DIR), type, strip: true };
  return { file: new URL(`web/${name}`, SRC_DIR), type, strip: false };
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const target = resolveStatic(pathname);
  if (!target) return sendError(res, 404, "Arquivo não encontrado.");
  try {
    const content = target.strip
      ? stripTypeScriptTypes(await readFile(target.file, "utf8"))
      : await readFile(target.file);
    res.writeHead(200, { "Content-Type": target.type, "Cache-Control": "no-cache" });
    res.end(content);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(err);
    sendError(res, 404, "Arquivo não encontrado.");
  }
}

/** Só aceita Host local: bloqueia DNS rebinding (site malicioso apontando o próprio domínio para 127.0.0.1). */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

const server: Server = createServer(async (req, res) => {
  if (!LOCAL_HOST.test(req.headers.host ?? "")) return sendError(res, 403, "Host não permitido.");
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const method = req.method ?? "GET";

  if (method === "GET" && !url.pathname.startsWith("/api/")) return serveStatic(url.pathname, res);

  const key = `${method} ${url.pathname}`;
  if (!isApiRoute(key)) return sendError(res, 404, "Rota não encontrada.");

  const origin = req.headers.origin;
  if (method !== "GET" && origin && origin !== `http://${req.headers.host}`) {
    return sendError(res, 403, "Origem não permitida.");
  }

  try {
    const body = method === "POST" ? await readJson(req) : undefined;
    send(res, 200, await routes[key](body));
  } catch (err) {
    if (err instanceof HttpError) return sendError(res, err.status, err.message);
    console.error(err);
    sendError(res, 500, err instanceof Error ? err.message : "Erro interno.");
  }
});

function openBrowser(url: string): void {
  const [cmd, args]: [string, string[]] = process.env.WSL_DISTRO_NAME
    ? ["cmd.exe", ["/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

export type StartServerOptions = {
  host?: string;
  port?: number;
  openBrowser?: boolean;
};

export type StartedServer = {
  url: string;
  host: string;
  port: number;
};

/** Sobe o HTTP. Idempotente se já estiver escutando. */
export function startServer(options: StartServerOptions = {}): Promise<StartedServer> {
  const host = options.host ?? HOST;
  const port = options.port ?? PORT;
  if (server.listening) {
    const addr = server.address();
    if (addr && typeof addr === "object") {
      const url = `http://localhost:${addr.port}`;
      return Promise.resolve({ url, host: addr.address, port: addr.port });
    }
  }
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Endereço do servidor indisponível."));
        return;
      }
      const url = `http://localhost:${addr.port}`;
      console.log(`fin-control rodando em ${url}`);
      if (options.openBrowser) openBrowser(url);
      resolve({ url, host: addr.address, port: addr.port });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export function stopServer(): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

const isDirectRun =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  await startServer({ openBrowser: !process.argv.includes("--no-open") });
}
