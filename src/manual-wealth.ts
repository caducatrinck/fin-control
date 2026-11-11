import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./paths.ts";

const filePath = (): string => path.join(dataDir(), "wealth-manual.json");
const tmpPath = (): string => path.join(dataDir(), "wealth-manual.json.tmp");

/** Valor que o Open Finance não trouxe e o usuário acrescenta no Patrimônio. */
export interface WealthManual {
  /** Quanto somar aos investimentos (positivo). `0` = sem ajuste. */
  amount: number;
  /** Motivo curto, ex.: "caixinhas fora do OF". */
  note: string | null;
  /** Data de entrada do valor (yyyy-mm-dd). */
  date: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManual(value: unknown): WealthManual {
  if (!isRecord(value)) return { amount: 0, note: null, date: null };
  const amount =
    typeof value.amount === "number" && Number.isFinite(value.amount) && value.amount > 0
      ? Math.round(value.amount * 100) / 100
      : 0;
  const note = typeof value.note === "string" && value.note.trim() ? value.note.trim().slice(0, 80) : null;
  const date = typeof value.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.date) ? value.date : null;
  return { amount, note: amount > 0 ? note : null, date: amount > 0 ? date : null };
}

let cache: WealthManual | null = null;
let writing: Promise<void> = Promise.resolve();

async function load(): Promise<WealthManual> {
  if (cache) return cache;
  const content = await readFile(filePath(), "utf8").catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = content ? JSON.parse(content) : null;
  } catch {
    console.error("data/wealth-manual.json inválido; iniciando zerado.");
  }
  cache = parseManual(parsed);
  return cache;
}

function persist(data: WealthManual): Promise<void> {
  writing = writing.then(async () => {
    await mkdir(dataDir(), { recursive: true });
    const tmp = tmpPath();
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
    await rename(tmp, filePath());
  });
  return writing;
}

export async function getWealthManual(): Promise<WealthManual> {
  const data = await load();
  return { ...data };
}

/** `amount` null ou ≤ 0 remove o ajuste. */
export async function setWealthManual(
  amount: number | null,
  note: string | null,
  date: string | null,
): Promise<WealthManual> {
  const nextAmount =
    amount !== null && Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : 0;
  const next: WealthManual = {
    amount: nextAmount,
    note: nextAmount > 0 && note?.trim() ? note.trim().slice(0, 80) : null,
    date: nextAmount > 0 && date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
  };
  cache = next;
  await persist(next);
  return { ...next };
}
