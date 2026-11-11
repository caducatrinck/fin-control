import type { Transaction } from "./pluggy/types.ts";
import { DEFAULT_CARD_SETTINGS } from "./shared/api.ts";

/**
 * Pareamento estorno → compra original.
 *
 * Sinais da Pluggy (cartão): CREDIT vem com `amount` negativo e DEBIT positivo; aqui só o módulo importa
 * (`Math.abs`), então o sinal nunca é aplicado duas vezes. Estornos reais chegam como "Estorno de compra"
 * (operationType ESTORNO) sem nome de loja; só quando o texto traz a loja ("IOF de volta de X",
 * `Crédito de "X"`) dá para casar por nome. Sem par único o estorno fica "pendente de vínculo".
 */

export type RefundMatchKind = "exact" | "partial" | "manual";

export interface RefundMatch {
  refund: Transaction;
  /** Compra original; `null` = pendente de vínculo. */
  purchase: Transaction | null;
  kind: RefundMatchKind | null;
  /** O usuário desvinculou à mão (o automático e a heurística antiga de parcelas não se aplicam). */
  unlinked: boolean;
  /** Parcelas do plano da compra (vazio se não é parcelada). */
  plan: readonly Transaction[];
  /** O estorno, sozinho, cobre a compra/plano inteiro (valor igual). */
  full: boolean;
}

export interface RefundOptions {
  /** Dias máximos entre a compra e o estorno. */
  windowDays: number;
  /** Decisões manuais: id do estorno → id da compra, ou `null` para desvincular. */
  manual?: ReadonlyMap<string, string | null>;
}

const CASHBACK = /cashback/i;
const REFUND_TEXT = /estorno|reembolso|devolu[cç][aã]o|refund|chargeback|cr[eé]dito de\s*["“]/i;
const IOF = /\biof\b/i;
const INSTALLMENT_SUFFIX = /\s+\d+\s*\/\s*\d+\s*$/;
const DAY_MS = 86_400_000;
const CENTS = 0.02;
/** O débito de IOF às vezes é lançado até 1-2 dias depois do "IOF de volta" (18/08 estorno × 19/08 débito). */
const IOF_POSTING_LEAD_DAYS = 3;
/**
 * Desempate entre compras de mesmo valor (assinatura mensal): vale a mais próxima, só se estiver a até
 * NEAREST_MAX_DAYS do estorno e todas as outras forem pelo menos NEAREST_MARGIN_DAYS mais antigas. Senão, pendente.
 */
const NEAREST_MAX_DAYS = 3;
const NEAREST_MARGIN_DAYS = 7;

const money = (t: Pick<Transaction, "amount">): number => Math.abs(t.amount);
const sameMoney = (a: number, b: number, tolerance = CENTS): boolean => Math.abs(a - b) < tolerance;
const dayOf = (t: Pick<Transaction, "date">): string => t.date.slice(0, 10);
const dayDiff = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

const compact = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");

/** Crédito que o banco manda como devolução: operationType/categoria ESTORNO, ou texto de estorno. Cashback nunca. */
export function isRefundCredit(t: Transaction): boolean {
  if (t.type !== "CREDIT") return false;
  if ([t.category, t.description, t.descriptionRaw].some((x) => x != null && CASHBACK.test(x))) return false;
  if (t.operationType === "ESTORNO" || (t.category != null && /^estorno$/i.test(t.category))) return true;
  return REFUND_TEXT.test(`${t.description} ${t.descriptionRaw ?? ""}`);
}

/** IOF (compra internacional): débito "IOF de compra internacional" ou estorno "IOF de volta de X". */
export const isIofText = (t: Pick<Transaction, "description">): boolean => IOF.test(t.description);

/**
 * Nome da loja citado no texto do estorno, ou "" quando o texto é genérico.
 * "IOF de volta de X" → X; `Crédito de "X"` → X; "Estorno de X" → X; "Estorno de compra" → "".
 * Um crédito ESTORNO que é só o nome ("Cursor, Ai Powered Ide") usa o texto inteiro.
 */
export function refundStoreName(t: Pick<Transaction, "description" | "operationType">): string {
  const text = t.description.trim();
  const iofBack = /^iof de volta de\s+(.+)$/i.exec(text);
  if (iofBack?.[1]) return iofBack[1];
  const credit = /^cr[eé]dito de\s*["“]?(.+?)["”]?$/i.exec(text);
  if (credit?.[1]) return credit[1];
  if (/^estorno de iof/i.test(text) || /^ajuste a cr[eé]dito/i.test(text)) return "";
  const estorno = /^estorno(?:\s+de)?\s+(.+)$/i.exec(text);
  if (estorno?.[1]) return /^compra$/i.test(estorno[1].trim()) ? "" : estorno[1];
  if (/^estorno$/i.test(text)) return "";
  return t.operationType === "ESTORNO" ? text : "";
}

function storeMatches(store: string, purchase: Transaction): boolean {
  const needle = compact(store);
  if (needle.length < 3) return false;
  const names = [purchase.description.replace(INSTALLMENT_SUFFIX, ""), purchase.merchant?.name, purchase.merchant?.businessName];
  return names.some((name) => {
    const hay = name ? compact(name) : "";
    return hay.length >= 3 && (hay.includes(needle) || needle.includes(hay));
  });
}

/** Plano parcelado: conta + instante da compra + nº de parcelas + loja (compras idênticas têm horário distinto). */
export function planKeyOf(t: Transaction): string | null {
  const meta = t.creditCardMetadata;
  const total = meta?.totalInstallments ?? 0;
  const purchase = meta?.purchaseDate;
  if (!purchase || total <= 1) return null;
  return `${t.accountId}|${purchase}|${total}|${t.description.replace(INSTALLMENT_SUFFIX, "").trim().toLowerCase()}`;
}

interface Candidate {
  key: string;
  /** Compra única, ou a parcela mais antiga do plano. */
  rep: Transaction;
  members: Transaction[];
  /** Valor total da compra (parcela × nº de parcelas quando o plano está incompleto: estimativa). */
  capacity: number;
  /** Dia de referência para a janela: a compra (não a parcela). */
  day: string;
  used: number;
  iof: boolean;
}

function isPurchaseDebit(t: Transaction): boolean {
  if (t.type !== "DEBIT") return false;
  const op = t.operationType;
  return op == null || op === "PAGAMENTO" || (op === "TARIFA" && isIofText(t));
}

function buildCandidates(transactions: readonly Transaction[]): { list: Candidate[]; byTx: Map<string, Candidate> } {
  const plans = new Map<string, Transaction[]>();
  const list: Candidate[] = [];
  for (const t of transactions) {
    if (!isPurchaseDebit(t)) continue;
    const key = planKeyOf(t);
    if (key) {
      const members = plans.get(key);
      if (members) members.push(t);
      else plans.set(key, [t]);
    } else {
      list.push({ key: t.id, rep: t, members: [t], capacity: money(t), day: dayOf(t), used: 0, iof: isIofText(t) });
    }
  }
  for (const [key, members] of plans) {
    members.sort((a, b) => (a.creditCardMetadata?.installmentNumber ?? 0) - (b.creditCardMetadata?.installmentNumber ?? 0));
    const rep = members[0];
    if (!rep) continue;
    const total = rep.creditCardMetadata?.totalInstallments ?? members.length;
    const capacity =
      members.length >= total ? members.reduce((acc, m) => acc + money(m), 0) : money(rep) * total;
    list.push({
      key,
      rep,
      members,
      capacity,
      day: (rep.creditCardMetadata?.purchaseDate ?? rep.date).slice(0, 10),
      used: 0,
      iof: false,
    });
  }
  const byTx = new Map<string, Candidate>();
  for (const c of list) for (const m of c.members) byTx.set(m.id, c);
  return { list, byTx };
}

function nearestOf(candidates: readonly Candidate[], refundDay: string): Candidate | undefined {
  const aged = candidates.map((c) => ({ c, age: Math.abs(dayDiff(c.day, refundDay)) })).sort((a, b) => a.age - b.age);
  const [best, second] = aged;
  if (!best || !second || best.age > NEAREST_MAX_DAYS) return undefined;
  return aged.slice(1).every((x) => x.age >= best.age + NEAREST_MARGIN_DAYS) ? best.c : undefined;
}

/**
 * Pareia cada estorno com a compra original (mesma conta). Regras, em ordem:
 * 1. decisão manual (vínculo ou desvínculo) vale sempre;
 * 2. candidatas: mesma conta, compra até o dia do estorno e dentro da janela, com saldo ainda não estornado;
 *    "IOF de volta" só casa com débito de IOF; estorno comum nunca casa com IOF;
 * 3. se o texto traz a loja, a compra precisa citar a loja;
 * 4. valor igual (ao da compra, ou da parcela, ou ao saldo da compra) → par único, ou o mais próximo
 *    (ver `nearestOf`), ou pendente;
 *    valor menor só pareia quando a loja está no texto e o par é único.
 * Estornos são processados do mais antigo ao mais novo, e cada compra só cede o seu saldo.
 */
export function matchRefunds(
  transactions: readonly Transaction[],
  { windowDays, manual }: RefundOptions = { windowDays: DEFAULT_CARD_SETTINGS.refundWindowDays },
): Map<string, RefundMatch> {
  const { list, byTx } = buildCandidates(transactions);
  const refunds = transactions
    .filter(isRefundCredit)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const result = new Map<string, RefundMatch>();

  const link = (refund: Transaction, cand: Candidate, kind: RefundMatchKind): void => {
    const amount = money(refund);
    const remaining = cand.capacity - cand.used;
    cand.used += amount;
    result.set(refund.id, {
      refund,
      purchase: cand.rep,
      kind,
      unlinked: false,
      plan: cand.members.length > 1 || planKeyOf(cand.rep) ? cand.members : [],
      full: sameMoney(amount, remaining, CENTS * Math.max(1, cand.members.length)),
    });
  };
  const pending = (refund: Transaction, unlinked: boolean): void => {
    result.set(refund.id, { refund, purchase: null, kind: null, unlinked, plan: [], full: false });
  };

  for (const refund of refunds) {
    const amount = money(refund);
    const decision = manual?.get(refund.id);
    if (decision === null) {
      pending(refund, true);
      continue;
    }
    if (decision !== undefined) {
      const cand = byTx.get(decision);
      if (cand) link(refund, cand, "manual");
      else pending(refund, false); // compra fora do histórico carregado
      continue;
    }

    const iofRefund = isIofText(refund);
    // O débito de IOF não cita a loja: "IOF de volta de X" casa só por valor/data.
    const store = iofRefund ? "" : refundStoreName(refund);
    const refundDay = dayOf(refund);
    const pool = list.filter((c) => {
      if (c.rep.accountId !== refund.accountId || c.iof !== iofRefund) return false;
      const age = dayDiff(c.day, refundDay);
      if (age > windowDays || age < -(c.iof ? IOF_POSTING_LEAD_DAYS : 0)) return false;
      if (c.capacity - c.used < amount - CENTS) return false;
      return store === "" || storeMatches(store, c.rep);
    });
    const exact = pool.filter(
      (c) => sameMoney(amount, money(c.rep)) || sameMoney(amount, c.capacity - c.used, CENTS * Math.max(1, c.members.length)),
    );
    const only = exact.length === 1 ? exact[0] : nearestOf(exact, refundDay);
    if (only) {
      link(refund, only, "exact");
    } else if (exact.length === 0 && store !== "" && pool.length === 1 && pool[0]) {
      link(refund, pool[0], "partial");
    } else {
      pending(refund, false);
    }
  }
  return result;
}
