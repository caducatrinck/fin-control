import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./paths.ts";

const filePath = (): string => path.join(dataDir(), "yield-overrides.json");
const tmpPath = (): string => path.join(dataDir(), "yield-overrides.json.tmp");

/** Ajuste manual do rendimento previsto de uma posição (valor e/ou data de entrada). */
export interface YieldOverride {
  id: string;
  /** `null` = mantém o valor calculado (CDI × %). */
  amount: number | null;
  /** yyyy-mm-dd; `null` = trata como “mês atual” (comportamento padrão). */
  date: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOverride(value: unknown): YieldOverride | null {
  if (!isRecord(value)) return null;
  const { id, amount, date } = value;
  if (typeof id !== "string" || !id) return null;
  const parsedAmount =
    typeof amount === "number" && Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null;
  const parsedDate = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  if (parsedAmount === null && parsedDate === null) return null;
  return { id, amount: parsedAmount, date: parsedDate };
}

let cache: YieldOverride[] | null = null;
let writing: Promise<void> = Promise.resolve();

async function load(): Promise<YieldOverride[]> {
  if (cache) return cache;
  const content = await readFile(filePath(), "utf8").catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = content ? JSON.parse(content) : null;
  } catch {
    console.error("data/yield-overrides.json inválido; iniciando vazio.");
  }
  const list = isRecord(parsed) && Array.isArray(parsed.overrides) ? parsed.overrides : Array.isArray(parsed) ? parsed : [];
  cache = list.map(parseOverride).filter((o): o is YieldOverride => o !== null);
  return cache;
}

function persist(overrides: YieldOverride[]): Promise<void> {
  writing = writing.then(async () => {
    await mkdir(dataDir(), { recursive: true });
    const tmp = tmpPath();
    await writeFile(tmp, `${JSON.stringify({ overrides }, null, 2)}\n`);
    await rename(tmp, filePath());
  });
  return writing;
}

export async function listYieldOverrides(): Promise<YieldOverride[]> {
  return [...(await load())];
}

/** `amount` e `date` ambos null removem o override. */
export async function setYieldOverride(
  id: string,
  amount: number | null,
  date: string | null,
): Promise<YieldOverride | null> {
  const data = await load();
  const next = data.filter((o) => o.id !== id);
  const parsedAmount =
    amount !== null && Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null;
  const parsedDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  if (parsedAmount === null && parsedDate === null) {
    cache = next;
    await persist(next);
    return null;
  }
  const override: YieldOverride = { id, amount: parsedAmount, date: parsedDate };
  next.push(override);
  cache = next;
  await persist(next);
  return { ...override };
}
