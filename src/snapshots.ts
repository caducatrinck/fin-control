import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./paths.ts";

const filePath = (): string => path.join(dataDir(), "investment-snapshots.json");
const tmpPath = (): string => path.join(dataDir(), "investment-snapshots.json.tmp");
/** ~13 meses de uma leitura por dia. */
const MAX_SNAPSHOTS = 400;

export interface InvestmentSnapshot {
  /** yyyy-mm-dd */
  date: string;
  /** Soma dos saldos ativos naquele dia. */
  total: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSnapshot(value: unknown): InvestmentSnapshot | null {
  if (!isRecord(value)) return null;
  const { date, total } = value;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (typeof total !== "number" || !Number.isFinite(total)) return null;
  return { date, total };
}

let cache: InvestmentSnapshot[] | null = null;
let writing: Promise<void> = Promise.resolve();

async function load(): Promise<InvestmentSnapshot[]> {
  if (cache) return cache;
  const content = await readFile(filePath(), "utf8").catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = content ? JSON.parse(content) : null;
  } catch {
    console.error("data/investment-snapshots.json inválido; iniciando vazio.");
  }
  const list = isRecord(parsed) && Array.isArray(parsed.snapshots) ? parsed.snapshots : [];
  cache = list.map(parseSnapshot).filter((s): s is InvestmentSnapshot => s !== null);
  return cache;
}

function persist(snapshots: InvestmentSnapshot[]): Promise<void> {
  writing = writing.then(async () => {
    await mkdir(dataDir(), { recursive: true });
    const tmp = tmpPath();
    await writeFile(tmp, `${JSON.stringify({ snapshots }, null, 2)}\n`);
    await rename(tmp, filePath());
  });
  return writing;
}

/** Snapshots do mais antigo ao mais recente. */
export async function listInvestmentSnapshots(): Promise<InvestmentSnapshot[]> {
  return [...(await load())];
}

/**
 * Grava (ou atualiza) o total de investimentos do dia.
 * Serve de base para medir o rendimento do mês sem chute: Δsaldo − aplicações + resgates.
 */
export async function recordInvestmentSnapshot(date: string, total: number): Promise<InvestmentSnapshot[]> {
  const snapshots = await load();
  const next = snapshots.filter((s) => s.date !== date);
  next.push({ date, total });
  next.sort((a, b) => a.date.localeCompare(b.date));
  cache = next.length > MAX_SNAPSHOTS ? next.slice(next.length - MAX_SNAPSHOTS) : next;
  await persist(cache);
  return [...cache];
}
