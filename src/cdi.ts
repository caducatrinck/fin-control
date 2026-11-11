/** CDI anual em vigor (BrasilAPI); cache curto para não bater na rede a cada clique. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const BUSINESS_DAYS_PER_MONTH = 21;
const BUSINESS_DAYS_PER_YEAR = 252;

let cached: { at: number; annual: number } | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Taxa CDI anual (%), ex.: 13.65. `null` se a API pública falhar. */
export async function fetchAnnualCdi(): Promise<number | null> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.annual;
  try {
    const res = await fetch("https://brasilapi.com.br/api/taxas/v1/cdi");
    const data: unknown = await res.json();
    const valor = isRecord(data) ? data.valor : undefined;
    if (typeof valor !== "number" || !Number.isFinite(valor) || valor <= 0) return cached?.annual ?? null;
    cached = { at: Date.now(), annual: valor };
    return valor;
  } catch (err) {
    console.warn(`CDI indisponível: ${err instanceof Error ? err.message : String(err)}`);
    return cached?.annual ?? null;
  }
}

/**
 * Rendimento previsto em um mês típico (21 dias úteis) para um CDB a `ratePercent`% do CDI.
 * Ex.: R$ 10.000 a 120% do CDI com CDI a 13,65% a.a.
 */
export function expectedMonthYield(balance: number, ratePercent: number, annualCdiPercent: number): number {
  const cdiDaily = (1 + annualCdiPercent / 100) ** (1 / BUSINESS_DAYS_PER_YEAR) - 1;
  const effectiveDaily = (1 + cdiDaily) ** (ratePercent / 100) - 1;
  return balance * ((1 + effectiveDaily) ** BUSINESS_DAYS_PER_MONTH - 1);
}

export function formatRateLabel(rate: number, rateType: string | null | undefined): string {
  const index = rateType?.trim() || "CDI";
  return `${rate}% ${index}`;
}
