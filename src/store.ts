import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_CARD_SETTINGS,
  TAG_COLORS,
  type Alias,
  type BillOverride,
  type CardSettings,
  type RefundLinkOverride,
  type RecurringBill,
  type RecurringMatch,
  type RefundOverride,
  type Tag,
  type TagColor,
  type TagFilter,
  type TagRule,
  type TagsResponse,
} from "./shared/api.ts";
import { dataDir } from "./paths.ts";

const tagsPath = (): string => path.join(dataDir(), "tags.json");
const tagsTmpPath = (): string => path.join(dataDir(), "tags.json.tmp");

type TagsData = TagsResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isTagColor(value: unknown): value is TagColor {
  return typeof value === "string" && (TAG_COLORS as readonly string[]).includes(value);
}

function parseTag(value: unknown): Tag | null {
  if (!isRecord(value)) return null;
  const { id, name, color } = value;
  if (typeof id !== "string" || typeof name !== "string" || !isTagColor(color)) return null;
  return { id, name, color };
}

function parseRule(value: unknown): TagRule | null {
  if (!isRecord(value)) return null;
  const { key, label, tagId } = value;
  if (typeof key !== "string" || typeof label !== "string" || typeof tagId !== "string") return null;
  return { key, label, tagId };
}

function parseAmount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100) / 100;
}

function parseFilter(value: unknown): TagFilter | null {
  if (!isRecord(value)) return null;
  const { id, tagId, amount, contains } = value;
  if (typeof id !== "string" || typeof tagId !== "string") return null;
  const parsedAmount = parseAmount(amount);
  const parsedContains = typeof contains === "string" && contains.trim() ? contains.trim() : null;
  if (parsedAmount === null && parsedContains === null) return null;
  return { id, tagId, amount: parsedAmount, contains: parsedContains };
}

function parseAlias(value: unknown): Alias | null {
  if (!isRecord(value)) return null;
  const { key, label, alias } = value;
  if (typeof key !== "string" || typeof label !== "string" || typeof alias !== "string" || !alias) return null;
  return { key, label, alias };
}

const optionalString = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

function parseRecurring(value: unknown): RecurringBill | null {
  if (!isRecord(value)) return null;
  const { id, key, label, expected, day, manual, linkLabel, matchName } = value;
  const billKey = optionalString(key);
  const billId = optionalString(id) ?? billKey;
  if (!billId || typeof label !== "string") return null;
  return {
    id: billId,
    key: billKey,
    label,
    expected: typeof expected === "number" && expected > 0 ? expected : null,
    day: typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= 31 ? day : null,
    manual: manual === true,
    linkLabel: optionalString(linkLabel),
    matchName: optionalString(matchName),
  };
}

function parseMatch(value: unknown): RecurringMatch | null {
  if (!isRecord(value)) return null;
  const { billId, month, transactionId, paid } = value;
  if (typeof billId !== "string" || typeof month !== "string" || typeof paid !== "boolean") return null;
  return { billId, month, transactionId: optionalString(transactionId), paid };
}

function parseRefundOverride(value: unknown): RefundOverride | null {
  if (!isRecord(value)) return null;
  const { id, refund } = value;
  if (typeof id !== "string" || !id || typeof refund !== "boolean") return null;
  return { id, refund };
}

function parseRefundLink(value: unknown): RefundLinkOverride | null {
  if (!isRecord(value)) return null;
  const { refundId, purchaseId } = value;
  if (typeof refundId !== "string" || !refundId) return null;
  if (purchaseId !== null && (typeof purchaseId !== "string" || !purchaseId)) return null;
  return { refundId, purchaseId };
}

function parseBillOverride(value: unknown): BillOverride | null {
  if (!isRecord(value)) return null;
  const { accountId, month, amount } = value;
  if (typeof accountId !== "string" || !accountId) return null;
  if (typeof month !== "string" || !/^\d{4}-\d{2}$/.test(month)) return null;
  if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
  return { accountId, month, amount: Math.round(amount * 100) / 100 };
}

export const MAX_REFUND_WINDOW_DAYS = 365;

function parseCardSettings(value: unknown): CardSettings {
  if (!isRecord(value)) return { ...DEFAULT_CARD_SETTINGS };
  const { projectInstallments, refundWindowDays } = value;
  return {
    projectInstallments: projectInstallments === true,
    refundWindowDays:
      typeof refundWindowDays === "number" &&
      Number.isInteger(refundWindowDays) &&
      refundWindowDays >= 1 &&
      refundWindowDays <= MAX_REFUND_WINDOW_DAYS
        ? refundWindowDays
        : DEFAULT_CARD_SETTINGS.refundWindowDays,
  };
}

function emptyData(): TagsData {
  return {
    tags: [],
    rules: [],
    filters: [],
    aliases: [],
    recurring: [],
    matches: [],
    refundOverrides: [],
    refundLinks: [],
    billOverrides: [],
    cardSettings: { ...DEFAULT_CARD_SETTINGS },
  };
}

function parseData(value: unknown): TagsData {
  if (!isRecord(value)) return emptyData();
  const tags = Array.isArray(value.tags) ? value.tags.map(parseTag).filter((t) => t !== null) : [];
  const tagIds = new Set(tags.map((t) => t.id));
  const rules = Array.isArray(value.rules)
    ? value.rules.map(parseRule).filter((r) => r !== null && tagIds.has(r.tagId))
    : [];
  const filters = Array.isArray(value.filters)
    ? value.filters.map(parseFilter).filter((f) => f !== null && tagIds.has(f.tagId))
    : [];
  const aliases = Array.isArray(value.aliases) ? value.aliases.map(parseAlias).filter((a) => a !== null) : [];
  const recurring = Array.isArray(value.recurring)
    ? value.recurring.map(parseRecurring).filter((r) => r !== null)
    : [];
  const billIds = new Set(recurring.map((r) => r.id));
  const matches = Array.isArray(value.matches)
    ? value.matches.map(parseMatch).filter((m) => m !== null && billIds.has(m.billId))
    : [];
  const refundOverrides = Array.isArray(value.refundOverrides)
    ? value.refundOverrides.map(parseRefundOverride).filter((r) => r !== null)
    : [];
  const refundLinks = Array.isArray(value.refundLinks) ? value.refundLinks.map(parseRefundLink).filter((r) => r !== null) : [];
  const billOverrides = Array.isArray(value.billOverrides)
    ? value.billOverrides.map(parseBillOverride).filter((r) => r !== null)
    : [];
  return {
    tags,
    refundOverrides,
    refundLinks,
    billOverrides,
    cardSettings: parseCardSettings(value.cardSettings),
    rules: rules as TagRule[],
    filters: filters as TagFilter[],
    aliases,
    recurring,
    matches: matches as RecurringMatch[],
  };
}

let cache: TagsData | null = null;
let writing: Promise<void> = Promise.resolve();

async function load(): Promise<TagsData> {
  if (cache) return cache;
  const content = await readFile(tagsPath(), "utf8").catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = content ? JSON.parse(content) : null;
  } catch {
    console.error("data/tags.json inválido; iniciando vazio.");
  }
  cache = parseData(parsed);
  return cache;
}

/** Grava de forma atômica e em série, para não corromper o arquivo com gravações simultâneas. */
function persist(data: TagsData): Promise<void> {
  writing = writing.then(async () => {
    await mkdir(dataDir(), { recursive: true });
    const tmp = tagsTmpPath();
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
    await rename(tmp, tagsPath());
  });
  return writing;
}

export async function getTags(): Promise<TagsData> {
  const data = await load();
  return {
    tags: [...data.tags],
    rules: [...data.rules],
    filters: data.filters.map((f) => ({ ...f })),
    aliases: [...data.aliases],
    recurring: data.recurring.map((r) => ({ ...r })),
    matches: data.matches.map((m) => ({ ...m })),
    refundOverrides: data.refundOverrides.map((r) => ({ ...r })),
    refundLinks: data.refundLinks.map((r) => ({ ...r })),
    billOverrides: data.billOverrides.map((r) => ({ ...r })),
    cardSettings: { ...data.cardSettings },
  };
}

function removeBills(data: TagsData, shouldRemove: (bill: RecurringBill) => boolean): void {
  const removed = new Set(data.recurring.filter(shouldRemove).map((r) => r.id));
  data.recurring = data.recurring.filter((r) => !removed.has(r.id));
  data.matches = data.matches.filter((m) => !removed.has(m.billId));
}

/** Pelo botão direito: liga/desliga todas as contas vinculadas ao pagador/recebedor. */
export async function setRecurring(key: string, label: string, recurring: boolean): Promise<void> {
  if (recurring) return updateRecurring([{ key, label }], []);
  const data = await load();
  removeBills(data, (r) => r.key === key);
  await persist(data);
}

/** `add` cria contas automáticas por pagador/recebedor; `remove` recebe ids de contas. */
export async function updateRecurring(
  add: readonly { key: string; label: string }[],
  remove: readonly string[],
): Promise<void> {
  const data = await load();
  const removed = new Set(remove);
  removeBills(data, (r) => removed.has(r.id));
  for (const { key, label } of add) {
    if (data.recurring.some((r) => r.key === key)) continue;
    data.recurring.push({
      id: key,
      key,
      label,
      expected: null,
      day: null,
      manual: false,
      linkLabel: null,
      matchName: null,
    });
  }
  await persist(data);
}

type ManualBillFields = Pick<RecurringBill, "label" | "expected" | "day" | "key" | "linkLabel" | "matchName">;

/** Retorna o id da conta criada. */
export async function createRecurring(bill: ManualBillFields): Promise<string> {
  const data = await load();
  const id = `manual:${randomUUID()}`;
  data.recurring.push({ ...bill, id, manual: true });
  await persist(data);
  return id;
}

/** Edita uma conta manual. Se o vínculo mudar, as decisões de "é desta conta?" são descartadas. */
export async function editRecurring(id: string, fields: ManualBillFields): Promise<boolean> {
  const data = await load();
  const bill = data.recurring.find((r) => r.id === id && r.manual);
  if (!bill) return false;
  const linkChanged = bill.key !== fields.key || bill.matchName !== fields.matchName;
  Object.assign(bill, fields);
  if (linkChanged) data.matches = data.matches.filter((m) => m.billId !== id || m.transactionId === null);
  await persist(data);
  return true;
}

export async function setExpected(id: string, expected: number | null): Promise<boolean> {
  const data = await load();
  const bill = data.recurring.find((r) => r.id === id);
  if (!bill) return false;
  bill.expected = expected;
  await persist(data);
  return true;
}

/**
 * Registra a decisão sobre um pagamento. Com `transactionId`, confirma ou recusa a transação;
 * sem, marca (`paid: true`) ou desmarca (`paid: false`) o pagamento manual do mês.
 */
export async function setMatch(
  billId: string,
  month: string,
  transactionId: string | null,
  paid: boolean,
): Promise<boolean> {
  const data = await load();
  if (!data.recurring.some((r) => r.id === billId)) return false;
  const same = (m: RecurringMatch): boolean =>
    m.billId === billId && (transactionId ? m.transactionId === transactionId : m.month === month && m.transactionId === null);
  data.matches = data.matches.filter((m) => !same(m));
  if (transactionId || paid) data.matches.push({ billId, month, transactionId, paid });
  await persist(data);
  return true;
}

export async function setRefund(id: string, refund: boolean | null): Promise<void> {
  const data = await load();
  data.refundOverrides = data.refundOverrides.filter((r) => r.id !== id);
  if (refund !== null) data.refundOverrides.push({ id, refund });
  await persist(data);
}

/** `purchaseId` undefined volta ao pareamento automático; `null` desvincula; string vincula à mão. */
export async function setRefundLink(refundId: string, purchaseId: string | null | undefined): Promise<void> {
  const data = await load();
  data.refundLinks = data.refundLinks.filter((r) => r.refundId !== refundId);
  if (purchaseId !== undefined) data.refundLinks.push({ refundId, purchaseId });
  await persist(data);
}

/** `amount: null` remove o valor informado daquele cartão e mês. */
export async function setBillOverride(accountId: string, month: string, amount: number | null): Promise<void> {
  const data = await load();
  data.billOverrides = data.billOverrides.filter((o) => !(o.accountId === accountId && o.month === month));
  if (amount !== null) data.billOverrides.push({ accountId, month, amount: Math.round(amount * 100) / 100 });
  await persist(data);
}

export async function setCardSettings(patch: Partial<CardSettings>): Promise<CardSettings> {
  const data = await load();
  data.cardSettings = parseCardSettings({ ...data.cardSettings, ...patch });
  await persist(data);
  return { ...data.cardSettings };
}

export async function setAlias(key: string, label: string, alias: string | null): Promise<void> {
  const data = await load();
  data.aliases = data.aliases.filter((a) => a.key !== key);
  if (alias) data.aliases.push({ key, label, alias });
  await persist(data);
}

export async function createTag(name: string, color: TagColor): Promise<Tag> {
  const data = await load();
  const tag: Tag = { id: randomUUID(), name, color };
  data.tags.push(tag);
  await persist(data);
  return tag;
}

export async function updateTag(id: string, name: string, color: TagColor): Promise<Tag | null> {
  const data = await load();
  const tag = data.tags.find((t) => t.id === id);
  if (!tag) return null;
  tag.name = name;
  tag.color = color;
  await persist(data);
  return { ...tag };
}

export async function deleteTag(id: string): Promise<boolean> {
  const data = await load();
  const before = data.tags.length;
  data.tags = data.tags.filter((t) => t.id !== id);
  if (data.tags.length === before) return false;
  data.rules = data.rules.filter((r) => r.tagId !== id);
  data.filters = data.filters.filter((f) => f.tagId !== id);
  await persist(data);
  return true;
}

export async function setRule(key: string, label: string, tagId: string | null): Promise<boolean> {
  const data = await load();
  if (tagId !== null && !data.tags.some((t) => t.id === tagId)) return false;
  data.rules = data.rules.filter((r) => r.key !== key);
  if (tagId !== null) data.rules.push({ key, label, tagId });
  await persist(data);
  return true;
}

export async function upsertFilter(
  tagId: string,
  amount: number | null,
  contains: string | null,
  id?: string,
): Promise<TagFilter | null> {
  const data = await load();
  if (!data.tags.some((t) => t.id === tagId)) return null;
  const parsedAmount = parseAmount(amount);
  const parsedContains = contains?.trim() || null;
  if (parsedAmount === null && parsedContains === null) return null;

  if (id) {
    const existing = data.filters.find((f) => f.id === id);
    if (!existing) return null;
    existing.tagId = tagId;
    existing.amount = parsedAmount;
    existing.contains = parsedContains;
    await persist(data);
    return { ...existing };
  }

  const filter: TagFilter = { id: randomUUID(), tagId, amount: parsedAmount, contains: parsedContains };
  data.filters.push(filter);
  await persist(data);
  return filter;
}

export async function deleteFilter(id: string): Promise<boolean> {
  const data = await load();
  const before = data.filters.length;
  data.filters = data.filters.filter((f) => f.id !== id);
  if (data.filters.length === before) return false;
  await persist(data);
  return true;
}
