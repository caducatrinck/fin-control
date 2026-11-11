import {
  TAG_COLORS,
  type AccountBalance,
  type ApiRoute,
  type ApiRoutes,
  type CardBill,
  type CardResponse,
  type DateRange,
  type Direction,
  type ErrorResponse,
  type InvestmentBalance,
  type PeriodResponse,
  type PeriodTransaction,
  type RefundLink,
  type PeriodInvestmentIncome,
  type RecurringItem,
  type RecurringResponse,
  type RecurringSuggestion,
  type Tag,
  type TagColor,
  type TagFilter,
  type TagsResponse,
  type WealthPoint,
  type WealthResponse,
} from "../shared/api.ts";
import { cashflowOf, computeTotals, expensesByTag } from "../shared/totals.ts";
import type { ItemStatus } from "../pluggy/types.ts";

type StepId = "step-credentials" | "step-connect" | "step-settings" | "step-app";
type TabId = "summary" | "card" | "recurring" | "tags" | "wealth";
const STEPS: readonly StepId[] = ["step-credentials", "step-connect", "step-settings", "step-app"];
const TABS: readonly TabId[] = ["summary", "card", "recurring", "tags", "wealth"];
/** Abas que dependem do período escolhido; nas demais a seleção de mês fica oculta. */
const PERIOD_TABS: readonly TabId[] = ["summary", "card", "recurring", "tags"];
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"] as const;
const MONTHS_BACK = 12;
const CUSTOM_PERIOD = "custom";
const DRAG_TYPE = "application/x-fin-counterparty";

/** Sem acesso de produção na Pluggy, bancos reais só são acessíveis via MeuPluggy. */
const MEU_PLUGGY_CONNECTOR_ID = 200;
const BANKS_READY_KEY = "fin-control:banks-ready";
const YIELD_INCOME_KEY = "fin-control:include-yield-income";

const STATUS_BADGE: Partial<Record<ItemStatus, string>> = {
  UPDATED: "badge-positive",
  UPDATING: "badge-warning",
  LOGIN_ERROR: "badge-negative",
  OUTDATED: "badge-negative",
};

const TAG_COLOR_LABELS: Record<TagColor, string> = {
  gray: "Cinza",
  red: "Vermelho",
  orange: "Laranja",
  yellow: "Amarelo",
  green: "Verde",
  teal: "Turquesa",
  blue: "Azul",
  purple: "Roxo",
  pink: "Rosa",
};

// Utilitários

function el<T extends HTMLElement = HTMLElement>(id: string, type?: abstract new () => T): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Elemento #${id} não encontrado.`);
  if (type && !(node instanceof type)) throw new Error(`Elemento #${id} não é ${type.name}.`);
  return node as T;
}

function child<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const node = root.querySelector<T & Element>(selector);
  if (!node) throw new Error(`Elemento ${selector} não encontrado.`);
  return node;
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string } = {},
  ...children: Node[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  node.append(...children);
  return node;
}

const money = (value: number, currency = "BRL"): string =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(value);

const signedMoney = (value: number, currency = "BRL"): string => `${value > 0 ? "+" : ""}${money(value, currency)}`;

const date = (iso: string): string => new Date(iso).toLocaleDateString("pt-BR", { timeZone: "UTC" });

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const pad = (n: number): string => String(n).padStart(2, "0");

const toIsoDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const formatIsoDate = (iso: string): string => iso.split("-").reverse().join("/");


function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

// API

type BodyArgs<R extends ApiRoute> = ApiRoutes[R]["body"] extends undefined ? [] : [body: ApiRoutes[R]["body"]];

async function api<R extends ApiRoute>(route: R, ...[body]: BodyArgs<R>): Promise<ApiRoutes[R]["response"]> {
  const [method, path] = route.split(" ") as [string, string];
  const res = await fetch(path, {
    method,
    ...(body !== undefined && {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  const data: unknown = await res.json();
  if (!res.ok) throw new Error((data as Partial<ErrorResponse>).error ?? `Erro ${res.status}`);
  return data as ApiRoutes[R]["response"];
}

// Estado

interface PeriodOption {
  id: string;
  label: string;
  range: DateRange;
}

function monthOptions(): PeriodOption[] {
  const now = new Date();
  const options: PeriodOption[] = [];
  for (let i = MONTHS_BACK - 1; i >= 0; i--) {
    const first = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    const id = `${first.getFullYear()}-${pad(first.getMonth() + 1)}`;
    options.push({
      id,
      label: `${MONTHS[first.getMonth()] ?? ""}/${first.getFullYear()}`,
      range: { from: toIsoDate(first), to: toIsoDate(last) },
    });
  }
  return options;
}

const periodOptions = monthOptions();
const currentMonth = periodOptions[periodOptions.length - 1];
if (!currentMonth) throw new Error("Nenhum período disponível.");

const state: {
  selected: string;
  range: DateRange;
  period: PeriodResponse | null;
  /** Carregado só quando a aba de recorrentes é aberta (busca o histórico de meses anteriores). */
  recurring: RecurringResponse | null;
  /** Não depende do período; carregado ao abrir a aba e recarregado no "Atualizar". */
  wealth: WealthResponse | null;
  /** Carregado só quando a aba da fatura é aberta. */
  card: CardResponse | null;
  tags: TagsResponse;
  tab: TabId;
} = {
  selected: currentMonth.id,
  range: currentMonth.range,
  period: null,
  recurring: null,
  wealth: null,
  card: null,
  tags: { tags: [], rules: [], filters: [], aliases: [], recurring: [], matches: [], refundOverrides: [], refundLinks: [], billOverrides: [], cardSettings: { projectInstallments: false, refundWindowDays: 60 } },
  tab: "summary",
};

const tagById = (): Map<string, Tag> => new Map(state.tags.tags.map((t) => [t.id, t]));

function tagBadge(tag: Tag | undefined): HTMLSpanElement {
  const badge = h("span", { className: tag ? "tag-badge" : "tag-badge is-empty", text: tag?.name ?? "Sem tag" });
  if (tag) badge.dataset.color = tag.color;
  return badge;
}

// Navegação entre etapas

const subtitle = el("subtitle");
const settingsBtn = el("settings-btn", HTMLButtonElement);
const cancelCredentialsBtn = el("cancel-credentials-btn", HTMLButtonElement);

function show(step: StepId, text: string): void {
  for (const id of STEPS) el(id).hidden = id !== step;
  subtitle.textContent = text;
}

async function route(): Promise<void> {
  const { configured, connected } = await api("GET /api/status");
  settingsBtn.hidden = !configured;
  cancelCredentialsBtn.hidden = true;
  if (!configured) return show("step-credentials", "Configuração inicial");
  if (!connected) return show("step-connect", "Falta conectar sua conta bancária");
  show("step-app", "Suas finanças");
  await loadPeriod();
}

// Credenciais

const credentialsForm = el("credentials-form", HTMLFormElement);
const clientIdInput = el("clientId", HTMLInputElement);
const clientSecretInput = el("clientSecret", HTMLInputElement);
const credentialsError = el("credentials-error");

credentialsForm.addEventListener("submit", async (e: SubmitEvent) => {
  e.preventDefault();
  const button = e.submitter instanceof HTMLButtonElement ? e.submitter : null;
  if (button) button.disabled = true;
  credentialsError.textContent = "";
  try {
    await api("POST /api/credentials", { clientId: clientIdInput.value, clientSecret: clientSecretInput.value });
    credentialsForm.reset();
    await route();
  } catch (err) {
    credentialsError.textContent = errorMessage(err);
  } finally {
    if (button) button.disabled = false;
  }
});

window.addEventListener("focus", () => {
  if (!el("step-credentials").hidden && !clientIdInput.value) clientIdInput.focus();
});

// Conexão da conta bancária

const banksReadyBtn = el("banks-ready-btn", HTMLButtonElement);
const connectStep = el("connect-step");

function showConnectStep(): void {
  banksReadyBtn.hidden = true;
  connectStep.hidden = false;
}

if (localStorage.getItem(BANKS_READY_KEY) === "true") showConnectStep();

banksReadyBtn.addEventListener("click", () => {
  localStorage.setItem(BANKS_READY_KEY, "true");
  showConnectStep();
});

async function openConnect(errorEl: HTMLElement): Promise<void> {
  errorEl.textContent = "";
  try {
    const { accessToken } = await api("POST /api/connect-token", {});
    await new PluggyConnect({
      connectToken: accessToken,
      includeSandbox: false,
      connectorIds: [MEU_PLUGGY_CONNECTOR_ID],
      onSuccess: async ({ item }) => {
        await api("POST /api/item", { itemId: item.id });
        await route();
      },
      onError: ({ message }) => {
        errorEl.textContent = `Erro na conexão: ${message}`;
      },
    }).init();
  } catch (err) {
    errorEl.textContent = errorMessage(err);
  }
}

el("connect-btn").addEventListener("click", () => openConnect(el("connect-error")));

// Período

const monthChips = el("month-chips");
const customRangeForm = el("custom-range", HTMLFormElement);
const rangeFrom = el("range-from", HTMLInputElement);
const rangeTo = el("range-to", HTMLInputElement);
const appError = el("app-error");
const itemConnector = el("item-connector");
const itemStatus = el("item-status");
const itemInfo = el("item-info");

function renderChips(): void {
  const chips = [...periodOptions.map((o) => ({ id: o.id, label: o.label })), { id: CUSTOM_PERIOD, label: "Personalizado" }];
  monthChips.replaceChildren(
    ...chips.map(({ id, label }) => {
      const chip = h("button", { className: "chip", text: label });
      chip.type = "button";
      chip.setAttribute("role", "tab");
      chip.dataset.period = id;
      chip.setAttribute("aria-selected", String(state.selected === id));
      return chip;
    }),
  );
  const usesPeriod = PERIOD_TABS.includes(state.tab);
  monthChips.hidden = !usesPeriod;
  customRangeForm.hidden = !usesPeriod || state.selected !== CUSTOM_PERIOD;
}

monthChips.addEventListener("click", (e) => {
  const chip = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-period]") : null;
  const id = chip?.dataset.period;
  if (!id) return;
  if (id === CUSTOM_PERIOD) {
    state.selected = CUSTOM_PERIOD;
    rangeFrom.value = state.range.from;
    rangeTo.value = state.range.to;
    renderChips();
    rangeFrom.focus();
    return;
  }
  const option = periodOptions.find((o) => o.id === id);
  if (!option) return;
  state.selected = option.id;
  state.range = option.range;
  renderChips();
  void loadPeriod();
});

customRangeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (rangeFrom.value > rangeTo.value) {
    appError.textContent = "A data inicial deve ser anterior à final.";
    return;
  }
  state.range = { from: rangeFrom.value, to: rangeTo.value };
  void loadPeriod();
});

el("refresh-btn").addEventListener("click", () => {
  const btn = el("refresh-btn", HTMLButtonElement);
  btn.classList.add("is-loading");
  btn.disabled = true;
  void loadPeriod(true).finally(() => {
    btn.classList.remove("is-loading");
    btn.disabled = false;
  });
});

let loadSeq = 0;

async function loadPeriod(refresh = false): Promise<void> {
  const seq = ++loadSeq;
  appError.textContent = "";
  itemInfo.textContent = refresh ? "Atualizando dados..." : "Buscando dados...";
  try {
    const [period, tags] = await Promise.all([
      api("POST /api/period", { ...state.range, refresh }),
      api("GET /api/tags"),
    ]);
    if (seq !== loadSeq) return;
    state.period = period;
    state.tags = tags;
    state.recurring = null;
    state.card = null;
    if (refresh) state.wealth = null;
    renderAll();
    if (state.tab === "recurring") void loadRecurring(refresh);
    if (state.tab === "card") void loadCard(refresh);
    if (state.tab === "wealth" && !state.wealth) void loadWealth(refresh);
  } catch (err) {
    if (seq !== loadSeq) return;
    itemInfo.textContent = "";
    appError.textContent = errorMessage(err);
  }
}

function renderHeaderInfo(period: PeriodResponse): void {
  const { item, range } = period;
  itemConnector.textContent = item.connector ?? "Conexão";
  itemStatus.hidden = false;
  itemStatus.textContent = item.status;
  itemStatus.className = `badge ${STATUS_BADGE[item.status] ?? ""}`;
  const updated = item.lastUpdatedAt ? new Date(item.lastUpdatedAt).toLocaleString("pt-BR") : "nunca";
  const info = [
    ...(PERIOD_TABS.includes(state.tab) ? [`${formatIsoDate(range.from)} a ${formatIsoDate(range.to)}`] : []),
    `sincronizado em ${updated}`,
  ];
  if (item.status === "UPDATING") info.push("sincronizando, atualize em alguns minutos");
  if (/meupluggy/i.test(item.connector ?? "")) {
    info.push("MeuPluggy atualiza os bancos ~1×/dia — force no meu.pluggy.ai se faltar algo de hoje");
  }
  itemInfo.textContent = info.join(" · ");
}

function renderAll(): void {
  const { period } = state;
  if (!period) return;
  renderHeaderInfo(period);
  renderSummary(period);
  renderTags(period);
}

// Abas

const tabButtons = document.querySelectorAll<HTMLButtonElement>("[data-tab]");

function selectTab(tab: TabId): void {
  state.tab = tab;
  for (const btn of tabButtons) btn.setAttribute("aria-selected", String(btn.dataset.tab === tab));
  for (const id of TABS) el(`panel-${id}`).hidden = id !== tab;
  renderChips();
  if (state.period) renderHeaderInfo(state.period);
  if (tab === "recurring" && !state.recurring) void loadRecurring();
  if (tab === "card" && !state.card) void loadCard();
  if (tab === "wealth" && !state.wealth) void loadWealth();
}

for (const btn of tabButtons) {
  btn.addEventListener("click", () => {
    if (isOneOf(TABS, btn.dataset.tab)) selectTab(btn.dataset.tab);
  });
}

// Resumo

const summarySearch = el("summary-search", HTMLInputElement);
const summarySearchInfo = el("summary-search-info");
const yieldToggleRow = el("yield-toggle-row");
const yieldToggleBtn = el("yield-toggle-btn", HTMLButtonElement);
const yieldToggleHint = el("yield-toggle-hint");

let includeYieldIncome = localStorage.getItem(YIELD_INCOME_KEY) === "true";

function syncYieldToggle(): void {
  yieldToggleBtn.setAttribute("aria-pressed", String(includeYieldIncome));
  yieldToggleBtn.textContent = includeYieldIncome ? "Remover rendimento previsto" : "Incluir rendimento previsto";
}

syncYieldToggle();

yieldToggleBtn.addEventListener("click", () => {
  includeYieldIncome = !includeYieldIncome;
  localStorage.setItem(YIELD_INCOME_KEY, String(includeYieldIncome));
  syncYieldToggle();
  if (state.period) renderSummary(state.period);
});

summarySearch.addEventListener("input", () => {
  if (state.period) renderSummary(state.period);
});

/** Busca por palavras (nome, descrição, tag, categoria) e, opcionalmente, um valor (±1%). */
function matchesSearch(t: PeriodTransaction, words: readonly string[], amount: number | null, tags: Map<string, Tag>): boolean {
  if (amount !== null && Math.abs(t.amount - amount) > Math.max(0.01, amount * 0.01)) return false;
  const haystack = normalize(
    [t.displayName, t.counterpartyName, t.description, t.category ?? "", t.tagId ? (tags.get(t.tagId)?.name ?? "") : "sem tag"].join(" "),
  );
  return words.every((w) => haystack.includes(w));
}

/** Totais e gastos por tag das movimentações encontradas (mesmas regras do servidor: internas fora). */
function summarize(transactions: readonly PeriodTransaction[]): Pick<PeriodResponse, "totals" | "expensesByTag"> {
  return { totals: computeTotals(transactions), expensesByTag: expensesByTag(transactions) };
}

function renderSummary(period: PeriodResponse): void {
  const tags = tagById();
  const query = summarySearch.value.trim();
  const { text, amount } = parseLinkQuery(query);
  const words = normalize(text).split(/\s+/).filter(Boolean);
  const searching = words.length > 0 || amount !== null;
  const transactions = searching
    ? period.transactions.filter((t) => matchesSearch(t, words, amount, tags))
    : period.transactions;
  const { totals, expensesByTag } = searching ? summarize(transactions) : period;
  const yieldIncome = period.investmentIncome;
  const yieldAmount = yieldIncome.expectedMonth;
  const yieldAvailable = yieldAmount !== null && yieldAmount > 0;
  const applyYield = includeYieldIncome && yieldAvailable && !searching;
  const income = totals.income + (applyYield && yieldAmount !== null ? yieldAmount : 0);
  const net = income - totals.expense;

  summarySearchInfo.hidden = !searching;
  summarySearchInfo.textContent = `${transactions.length} ${transactions.length === 1 ? "movimentação encontrada" : "movimentações encontradas"} para "${query}".`;
  for (const details of document.querySelectorAll<HTMLDetailsElement>("#panel-summary details.accordion")) {
    if (searching) details.open = true;
  }

  el("total-income").textContent = money(income);
  el("total-expense").textContent = money(totals.expense);
  const netEl = el("total-net");
  netEl.textContent = money(net);
  netEl.classList.toggle("is-positive", net > 0);
  netEl.classList.toggle("is-negative", net < 0);

  const notes: string[] = [];
  if (totals.internalCount) {
    notes.push(
      `${totals.internalCount} movimentações ficaram fora dos totais (transferências entre contas, fatura, aplicações/resgates ou parcelas canceladas após estorno).`,
    );
  }
  el("internal-note").textContent = notes.join(" ");

  yieldToggleRow.hidden = !yieldAvailable;
  if (yieldAvailable && yieldAmount !== null) {
    const cdi = yieldIncome.cdiAnnual?.toLocaleString("pt-BR") ?? "—";
    yieldToggleHint.textContent = applyYield
      ? `Entradas incluem ${money(yieldAmount)} de rendimento estimado (CDI ${cdi}% a.a., saldo de hoje).`
      : `Rendimento estimado do período: ${money(yieldAmount)} (CDI ${cdi}% a.a., saldo de hoje). Não entra no total até você incluir.`;
  }
  syncYieldToggle();

  const breakdown = el("tag-breakdown");
  if (!expensesByTag.length) {
    breakdown.replaceChildren(h("p", { className: "muted text-sm no-margin", text: "Nenhuma saída no período." }));
  } else {
    breakdown.replaceChildren(
      ...expensesByTag.map((group) => {
        const tag = group.tagId ? tags.get(group.tagId) : undefined;
        const share = totals.expense !== 0 ? (group.total / totals.expense) * 100 : 0;
        const fill = h("span");
        fill.style.width = `${Math.max(0, Math.min(100, Math.abs(share))).toFixed(1)}%`;
        const bar = h("div", { className: "bar" }, fill);
        if (tag) bar.dataset.color = tag.color;
        const amountClass = group.total < 0 ? "amount text-sm is-positive" : "amount text-sm";
        return h(
          "div",
          { className: "bar-row" },
          tagBadge(tag),
          bar,
          h("span", { className: amountClass, text: `${money(group.total)} · ${share.toFixed(0)}%` }),
        );
      }),
    );
  }

  renderMovementGroup(transactions, "in", tags, yieldAvailable && !searching ? yieldIncome : null, applyYield);
  renderMovementGroup(transactions, "out", tags, null, false);
  renderInternalGroup(transactions);
}

/** Transferências internas e parcelas canceladas após estorno: listadas, fora dos totais. */
function renderInternalGroup(transactions: readonly PeriodTransaction[]): void {
  const items = transactions.filter((t) => t.internal || t.cancelled).sort((a, b) => b.amount - a.amount);
  el("internal-count").textContent = `${items.length} ${items.length === 1 ? "movimentação" : "movimentações"}`;
  const rows = items.map((t) =>
    transactionRow(
      t,
      h("td", { className: "col-date", text: date(t.date) }),
      descriptionCell(t),
      h("td", { className: "muted", text: t.accountName }),
      h("td", { className: "col-amount amount muted", text: money(cashflowOf(t)) }),
    ),
  );
  if (!rows.length) {
    const empty = h("td", { className: "muted text-sm", text: "Nenhuma movimentação interna no período." });
    empty.colSpan = 4;
    rows.push(h("tr", {}, empty));
  }
  el("internal-list").replaceChildren(...rows);
}

/** Lista do accordion de entradas ou saídas do período, da maior para a menor (sem as internas). */
function renderMovementGroup(
  transactions: readonly PeriodTransaction[],
  direction: Direction,
  tags: Map<string, Tag>,
  yieldIncome: PeriodInvestmentIncome | null,
  includeYieldInSum: boolean,
): void {
  const prefix = direction === "in" ? "income" : "expense";
  const items = transactions
    .filter(
      (t) =>
        !t.internal &&
        !t.cancelled &&
        (direction === "in" ? t.direction === "in" && !t.refund : t.direction === "out" || t.refund),
    )
    .sort((a, b) => b.amount - a.amount);
  const yieldRows =
    direction === "in" && yieldIncome
      ? yieldIncome.items.map((item) => {
        const row = h(
          "tr",
          {},
          h("td", { className: "col-date", text: item.date ? date(item.date) : "mês" }),
          h(
            "td",
            {},
            h("div", { className: "cell-name" }, h("span", { text: "RECEBIDO - Rendimento previsto" })),
            h("span", {
              className: "subtext",
              text: [
                item.name,
                `${item.rate}% ${item.rateType ?? "CDI"}`,
                `saldo ${money(item.balance)}`,
                item.amountEdited ? "valor editado" : "",
              ]
                .filter(Boolean)
                .join(" · "),
            }),
          ),
          h("td", {}, h("span", { className: "badge", text: item.date || item.amountEdited ? "Ajustado" : "Previsto" })),
          h("td", {
            className: `col-amount amount is-positive${includeYieldInSum ? "" : " muted"}`,
            text: money(item.amount),
          }),
        );
        return row;
      })
      : [];
  const yieldSum = includeYieldInSum ? (yieldIncome?.expectedMonth ?? 0) : 0;
  const sum = items.reduce((acc, t) => acc + (t.refund ? -t.amount : t.amount), 0) + yieldSum;
  const count = items.length + yieldRows.length;

  el(`${prefix}-count`).textContent = `${count} ${count === 1 ? "movimentação" : "movimentações"}`;
  el(`${prefix}-sum`).textContent = money(sum);

  const rows = [
    ...yieldRows,
    ...items.map((t) => {
      // Mesma convenção da soma: entrada +, saída +, reembolso − (para a soma das linhas bater com o total).
      const value = direction === "in" ? t.amount : t.refund ? -t.amount : t.amount;
      return transactionRow(
        t,
        h("td", { className: "col-date", text: date(t.date) }),
        descriptionCell(t),
        h("td", {}, tagBadge(t.tagId ? tags.get(t.tagId) : undefined)),
        h("td", {
          className: `col-amount amount ${value < 0 || direction === "in" ? "is-positive" : "is-negative"}`,
          text: money(value),
        }),
      );
    }),
  ];
  if (!rows.length) {
    const empty = h("td", { className: "muted text-sm", text: "Nenhuma movimentação no período." });
    empty.colSpan = 4;
    rows.push(h("tr", {}, empty));
  }
  el(`${prefix}-list`).replaceChildren(...rows);
}

function balanceRow(acc: AccountBalance): HTMLTableRowElement {
  const amount = h("td", { className: "col-amount amount", text: money(acc.balance, acc.currencyCode) });
  amount.classList.toggle("is-negative", acc.balance < 0);
  return h(
    "tr",
    {},
    h("td", { text: acc.name }),
    h("td", { className: "muted", text: `${acc.type} · ${acc.subtype}` }),
    amount,
  );
}

// Fatura do cartão

const cardInfo = el("card-info");
let cardSeq = 0;

async function loadCard(refresh = false): Promise<void> {
  const seq = ++cardSeq;
  cardInfo.textContent = "Buscando faturas e compras no cartão...";
  try {
    const card = await api("POST /api/card", { ...state.range, refresh });
    if (seq !== cardSeq) return;
    state.card = card;
    renderCard(card);
  } catch (err) {
    if (seq !== cardSeq) return;
    cardInfo.textContent = "";
    appError.textContent = errorMessage(err);
  }
}

/** Valor com que a fatura fechou na Pluggy. A causa de qualquer diferença só aparece na conferência abaixo. */
function closedNote(closedAmount: number | null): string {
  return closedAmount === null ? "" : `fechou em ${money(closedAmount)}`;
}

/** Soma das transações × totalAmount; explica só o que fecha exatamente, o resto fica "sem explicação confirmada". */
function reconciliationText(bill: CardBill | undefined): string {
  const r = bill?.reconciliation;
  if (!r) return "";
  const head = `Transações ${money(r.transactionsTotal)} × fatura ${money(r.totalAmount)}`;
  if (Math.abs(r.difference) < 0.02) return `${head}: confere.`;
  const diff = `diferença de ${signedMoney(r.difference)}`;
  const facts = [
    r.financeCharges ? `encargos ${money(r.financeCharges)}` : "sem encargos informados",
    r.payments.length ? `pagamentos: ${r.payments.map((p) => `${money(p.amount)} em ${formatIsoDate(p.date)}`).join(", ")}` : "sem pagamentos informados",
  ].join("; ");
  return r.explained
    ? `${head}: ${diff}, explicada por ${r.explainedBy.map((e) => `${e.label} (${signedMoney(e.amount)})`).join(" + ")}.`
    : `${head}: ${diff} sem explicação confirmada (${facts}).`;
}

const billDue = (bill: Pick<CardBill, "dueDate" | "estimated">): string =>
  bill.dueDate ? `${bill.estimated ? "vence por volta de" : "vence em"} ${formatIsoDate(bill.dueDate)}` : "";

function renderNextBill(data: CardResponse): void {
  const { next, cards } = data;
  el("card-next-total").textContent = next ? money(next.total) : "—";
  el("card-next-due").textContent = next
    ? [monthLabel(next.month), "valor parcial/estimado da API", billDue(next)].filter(Boolean).join(" · ")
    : "";
  el("card-next-source").textContent = next
    ? next.forecastCount
      ? `${next.forecastCount} lançamentos agrupados pela fatura prevista da Pluggy; os demais, pelo ciclo estimado do cartão.`
      : "Agrupado pelo ciclo estimado do cartão."
    : "";
  el("card-next-projected").textContent =
    next && data.settings.projectInstallments
      ? next.projected.length
        ? `+ ${money(next.projectedTotal)} estimados de ${next.projected.length} parcelas que a API ainda não mandou (${next.projected.map((p) => `${p.description} ${p.installment}`).join(", ")}). Total estimado: ${money(next.total + next.projectedTotal)}.`
        : "Nenhuma parcela ausente a projetar."
      : "";
  const form = el("card-override-form", HTMLFormElement);
  form.hidden = !next || !cards.length;
  const input = el("card-override-input", HTMLInputElement);
  const current = next?.overrides[0]?.amount ?? null;
  input.value = current === null ? "" : String(current);
  el("card-override-clear").hidden = current === null;
  el("card-override-diff").textContent =
    next && next.bankAmount !== null && next.difference !== null
      ? `Banco ${money(next.bankAmount)} − API ${money(next.total)} = ${signedMoney(next.difference)}` +
        (next.differenceWithProjection !== null ? ` (${signedMoney(next.differenceWithProjection)} contando a projeção)` : "")
      : "";
}

function renderCardOptions(data: CardResponse): void {
  el("card-opt-project", HTMLInputElement).checked = data.settings.projectInstallments;
  el("card-opt-window", HTMLInputElement).value = String(data.settings.refundWindowDays);
}

async function saveCardOption(body: ApiRoutes["POST /api/card/settings"]["body"]): Promise<void> {
  appError.textContent = "";
  try {
    await api("POST /api/card/settings", body);
    await loadPeriod();
  } catch (err) {
    appError.textContent = errorMessage(err);
  }
}

el("card-opt-project", HTMLInputElement).addEventListener("change", (e) => {
  void saveCardOption({ projectInstallments: (e.target as HTMLInputElement).checked });
});
el("card-opt-window", HTMLInputElement).addEventListener("change", (e) => {
  void saveCardOption({ refundWindowDays: Number((e.target as HTMLInputElement).value) });
});

async function saveBillOverride(amount: number | null): Promise<void> {
  const next = state.card?.next;
  const accountId = state.card?.cards[0]?.id;
  if (!next || !accountId) return;
  appError.textContent = "";
  try {
    await api("POST /api/card/bill-override", { accountId, month: next.month, amount });
    state.card = null;
    await loadCard();
  } catch (err) {
    appError.textContent = errorMessage(err);
  }
}

el("card-override-form", HTMLFormElement).addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = el("card-override-input", HTMLInputElement).value;
  void saveBillOverride(raw === "" ? null : Number(raw));
});
el("card-override-clear").addEventListener("click", () => void saveBillOverride(null));

// Estornos: "estorno de X em dd/mm" e vínculo manual

const refundDialog = el("refund-link-dialog", HTMLDialogElement);
const refundSelect = el("refund-link-select", HTMLSelectElement);
const refundLinkError = el("refund-link-error");
let refundDialogTarget: string | null = null;

async function setRefundLink(refundId: string, purchaseId: string | null | undefined): Promise<void> {
  appError.textContent = "";
  try {
    await api("POST /api/refunds/link", { refundId, purchaseId });
    await loadPeriod();
  } catch (err) {
    appError.textContent = errorMessage(err);
  }
}

async function openRefundLinkDialog(refundId: string): Promise<void> {
  refundLinkError.textContent = "";
  try {
    const card = state.card ?? (await api("POST /api/card", { ...state.range }));
    state.card = card;
    refundDialogTarget = refundId;
    el("refund-link-hint").textContent = "Escolha a compra que foi estornada (as 300 compras mais recentes do cartão).";
    refundSelect.replaceChildren(
      ...card.linkable.map((p) => {
        const option = document.createElement("option");
        option.value = p.id;
        option.textContent = `${date(p.date)} · ${p.counterpartyName}${p.installment ? ` ${p.installment}` : ""} · ${money(p.amount)}`;
        return option;
      }),
    );
    refundDialog.showModal();
  } catch (err) {
    appError.textContent = errorMessage(err);
  }
}

el("refund-link-form", HTMLFormElement).addEventListener("submit", (e) => {
  e.preventDefault();
  const id = refundDialogTarget;
  if (!id || !refundSelect.value) return;
  refundDialog.close();
  void setRefundLink(id, refundSelect.value);
});
el("cancel-refund-link-btn").addEventListener("click", () => refundDialog.close());

function linkButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = h("button", { className: "btn btn-ghost btn-sm", text: label });
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

/** Linha de apoio do estorno: com quem foi pareado (ou pendente) e as ações de vincular/desvincular. */
function refundNote(refundId: string, link: RefundLink): HTMLElement {
  const text =
    link.status === "linked"
      ? `estorno de ${link.purchaseName ?? "compra"}${link.purchaseDate ? ` em ${date(link.purchaseDate).slice(0, 5)}` : ""}` +
        `${link.partial ? " (parcial)" : ""}${link.kind === "manual" ? " · vínculo manual" : ""}`
      : link.unlinked
        ? "desvinculado (sem compra de origem)"
        : "pendente de vínculo";
  const actions: HTMLElement[] = [linkButton(link.status === "linked" ? "Trocar" : "Vincular", () => void openRefundLinkDialog(refundId))];
  if (link.status === "linked") actions.push(linkButton("Desvincular", () => void setRefundLink(refundId, null)));
  if (link.kind === "manual" || link.unlinked) actions.push(linkButton("Voltar ao automático", () => void setRefundLink(refundId, undefined)));
  return h("span", { className: `subtext${link.status === "pending" ? " is-negative" : ""}` }, document.createTextNode(`${text} `), ...actions);
}

function renderCard(data: CardResponse): void {
  const { selected, next, cards, budget } = data;
  const tags = tagById();
  const single = selected.months.length === 1 ? selected.months[0] : undefined;

  el("card-selected-label").textContent = single ? `Fatura de ${monthLabel(single)}` : "Faturas do período";
  el("card-selected-total").textContent = money(selected.total);
  el("card-selected-due").textContent = [
    selected.estimated ? "prevista" : "fechada",
    closedNote(selected.closedAmount),
    billDue({ dueDate: selected.dueDate, estimated: selected.estimated }),
  ]
    .filter(Boolean)
    .join(" · ");
  el("card-selected-recon").textContent = single ? reconciliationText(data.bills.find((b) => b.month === single)) : "";
  renderNextBill(data);
  renderCardOptions(data);

  const limits = cards.filter((c) => c.availableCreditLimit !== null);
  const available = limits.reduce((acc, c) => acc + (c.availableCreditLimit ?? 0), 0);
  const total = cards.reduce((acc, c) => acc + (c.creditLimit ?? 0), 0);
  el("card-limit").textContent = limits.length ? money(available) : "—";
  el("card-limit-total").textContent = total ? `de ${money(total)}` : "";

  el("card-budget-salary").textContent = budget.salary === null ? "—" : money(budget.salary);
  el("card-budget-salary-source").textContent =
    budget.salarySource === "salary"
      ? "detectado no extrato"
      : budget.salarySource === "largest-income"
        ? "maior entrada do período (não achei texto de salário)"
        : "nenhuma entrada no período";
  el("card-budget-fixed").textContent = money(-budget.fixed);
  const roomEl = el("card-budget-room");
  roomEl.textContent = budget.room === null ? "—" : money(budget.room);
  roomEl.classList.toggle("is-positive", (budget.room ?? 0) > 0);
  roomEl.classList.toggle("is-negative", (budget.room ?? 0) < 0);
  const remEl = el("card-budget-remaining");
  remEl.textContent = budget.remaining === null ? "—" : money(budget.remaining);
  remEl.classList.toggle("is-positive", (budget.remaining ?? 0) > 0);
  remEl.classList.toggle("is-negative", (budget.remaining ?? 0) < 0);
  el("card-budget-remaining-hint").textContent =
    budget.remaining === null
      ? "sem salário para calcular"
      : budget.remaining >= 0
        ? `ainda cabe na fatura (atual ${money(budget.bill)})`
        : `estourou o teto em ${money(-budget.remaining)} (fatura ${money(budget.bill)})`;

  cardInfo.textContent = !cards.length
    ? "Nenhum cartão de crédito nesta conexão."
    : data.billsAvailable
      ? ""
      : "A Pluggy não devolveu faturas fechadas para esta conexão; os valores são previstos pela soma das compras.";

  renderCardChart(data.bills, new Set(selected.months));

  const spenders = el("card-spenders");
  const top = Math.max(...selected.topSpenders.map((s) => Math.abs(s.total)), 0);
  spenders.replaceChildren(
    ...(selected.topSpenders.length
      ? selected.topSpenders.map((s) => {
        const fill = h("span");
        fill.style.width = `${top ? Math.min(100, (Math.abs(s.total) / top) * 100).toFixed(1) : 0}%`;
        const row = h(
          "div",
          { className: "bar-row" },
          h("span", { className: "bar-label", text: s.name }),
          h("div", { className: "bar" }, fill),
          h("span", {
            className: `amount text-sm${s.total < 0 ? " is-positive" : " is-negative"}`,
            text: `${money(s.total)} · ${s.count}x`,
          }),
        );
        row.dataset.key = s.key;
        row.dataset.label = s.name;
        return row;
      })
      : [h("p", { className: "muted text-sm no-margin", text: "Nenhuma compra no período." })]),
  );

  const byTag = el("card-tags");
  byTag.replaceChildren(
    ...(selected.byTag.length
      ? selected.byTag.map((group) => {
        const tag = group.tagId ? tags.get(group.tagId) : undefined;
        const share = selected.total !== 0 ? (group.total / selected.total) * 100 : 0;
        const fill = h("span");
        fill.style.width = `${Math.max(0, Math.min(100, Math.abs(share))).toFixed(1)}%`;
        const bar = h("div", { className: "bar" }, fill);
        if (tag) bar.dataset.color = tag.color;
        return h(
          "div",
          { className: "bar-row" },
          tagBadge(tag),
          bar,
          h("span", {
            className: `amount text-sm${group.total < 0 ? " is-positive" : " is-negative"}`,
            text: `${money(group.total)} · ${share.toFixed(0)}%`,
          }),
        );
      })
      : [h("p", { className: "muted text-sm no-margin", text: "Nenhuma compra no período." })]),
  );

  const rows = selected.purchases.map((p) => {
    const name = h("td", {}, h("span", { text: p.displayName }));
    if (p.installment) name.append(h("span", { className: "subtext", text: `Parcela ${p.installment}` }));
    if (p.refundLink) name.append(refundNote(p.id, p.refundLink));
    const row = h(
      "tr",
      {},
      h("td", { className: "col-date", text: date(p.date) }),
      name,
      h("td", { className: "muted", text: p.cardName }),
      h("td", {}, tagBadge(p.tagId ? tags.get(p.tagId) : undefined)),
      h("td", {
        className: `col-amount amount ${p.amount < 0 ? "is-positive" : "is-negative"}`,
        text: money(p.amount),
      }),
    );
    row.dataset.key = p.counterpartyKey;
    row.dataset.label = p.counterpartyName;
    return row;
  });
  el("card-purchases").replaceChildren(...rows);
  el("card-empty").hidden = rows.length > 0;
}

/** Barras por mês de vencimento; clicar numa barra seleciona aquele mês. */
function renderCardChart(bills: readonly CardBill[], selected: ReadonlySet<string>): void {
  const width = 720;
  const height = 240;
  const pad = CHART_PAD;
  const max = Math.max(...bills.map((b) => b.total), 0) || 1;
  const slot = (width - pad.left - pad.right) / Math.max(1, bills.length);
  const barWidth = Math.min(40, slot * 0.64);
  const y = (v: number): number => pad.top + ((max - Math.max(0, v)) * (height - pad.top - pad.bottom)) / max;

  const grid = [0, 1, 2, 3, 4].map((i) => {
    const v = (max * i) / 4;
    return svg(
      "g",
      { class: "chart-grid" },
      svg("line", { x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v) }),
      svg("text", { x: pad.left - 8, y: y(v) + 4, "text-anchor": "end" }, document.createTextNode(compactMoney(v))),
    );
  });
  const bars = bills.map((b, i) => {
    const cx = pad.left + slot * i + slot / 2;
    const top = y(b.total);
    const classes = ["chart-bar", b.estimated ? "is-estimated" : "", selected.has(b.month) ? "is-selected" : ""];
    const group = svg(
      "g",
      { class: classes.filter(Boolean).join(" "), "data-bill-month": b.month },
      svg("rect", { class: "chart-bar-hit", x: pad.left + slot * i, y: pad.top, width: slot, height: height - pad.top - pad.bottom }),
      svg("rect", { x: cx - barWidth / 2, y: top, width: barWidth, height: Math.max(1, height - pad.bottom - top), rx: 3 }),
      svg("text", { class: "chart-label", x: cx, y: height - 8, "text-anchor": "middle" }, document.createTextNode(monthLabel(b.month))),
      svg(
        "title",
        {},
        document.createTextNode(
          [`${monthLabel(b.month)}: ${money(b.total)}`, b.estimated ? "parcial/estimada" : closedNote(b.closedAmount)]
            .filter(Boolean)
            .join(" · "),
        ),
      ),
    );
    return group;
  });

  el("card-chart").replaceChildren(
    svg(
      "svg",
      { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "Faturas do cartão por mês de vencimento" },
      ...grid,
      ...bars,
    ),
  );
}

el("card-chart").addEventListener("click", (e) => {
  const bar = e.target instanceof Element ? e.target.closest<SVGGElement>("[data-bill-month]") : null;
  const month = bar?.dataset.billMonth;
  if (!month) return;
  const option = periodOptions.find((o) => o.id === month);
  if (option) {
    state.selected = option.id;
    state.range = option.range;
  } else {
    const [year = 0, m = 1] = month.split("-").map(Number);
    state.selected = CUSTOM_PERIOD;
    state.range = { from: `${month}-01`, to: toIsoDate(new Date(year, m, 0)) };
    rangeFrom.value = state.range.from;
    rangeTo.value = state.range.to;
  }
  renderChips();
  void loadPeriod();
});

// Patrimônio

const wealthInfo = el("wealth-info");
let wealthSeq = 0;

const INVESTMENT_TYPE_LABELS: Record<InvestmentBalance["type"], string> = {
  FIXED_INCOME: "Renda fixa",
  EQUITY: "Ações",
  MUTUAL_FUND: "Fundo",
  SECURITY: "Previdência",
  ETF: "ETF",
  COE: "COE",
};

async function loadWealth(refresh = false): Promise<void> {
  const seq = ++wealthSeq;
  wealthInfo.textContent = "Buscando saldos e os últimos 12 meses...";
  try {
    const wealth = await api("POST /api/wealth", { refresh });
    if (seq !== wealthSeq) return;
    state.wealth = wealth;
    renderWealth(wealth);
  } catch (err) {
    if (seq !== wealthSeq) return;
    wealthInfo.textContent = "";
    appError.textContent = errorMessage(err);
  }
}

function renderWealth(data: WealthResponse): void {
  const { totals, history, manual, reportedInvestments } = data;
  el("wealth-total").textContent = money(totals.total);
  el("wealth-accounts").textContent = money(totals.accounts);
  el("wealth-investments").textContent = data.investmentsAvailable || manual.amount > 0 ? money(totals.investments) : "—";
  const change = el("wealth-change");
  const first = history[0];
  change.textContent = first
    ? `${totals.change >= 0 ? "+" : ""}${money(totals.change)} desde ${monthLabel(first.month)}`
    : "";
  change.classList.toggle("is-positive", totals.change > 0);
  change.classList.toggle("is-negative", totals.change < 0);

  const profit = el("wealth-profit");
  const expected = totals.expectedMonthProfit;
  profit.textContent = expected === null ? "—" : signedMoney(expected);
  profit.classList.toggle("is-positive", (expected ?? 0) > 0);
  profit.classList.toggle("is-negative", (expected ?? 0) < 0);

  const rateHint =
    expected !== null && totals.cdiAnnual !== null
      ? `CDI a ${totals.cdiAnnual.toLocaleString("pt-BR")}% a.a. · 21 dias úteis`
      : expected === null
        ? "a Pluggy não mandou a % do CDI de cada caixinha"
        : "";
  const lifetime =
    totals.profit === null ? "" : `acumulado ${signedMoney(totals.profit)} desde a aplicação`;
  el("wealth-profit-month").textContent = [rateHint, lifetime].filter(Boolean).join(" · ");

  const info: string[] = [];
  if (!data.investmentsAvailable) {
    info.push("A Pluggy não devolveu investimentos para esta conexão; o total considera só o saldo das contas.");
  } else if (expected === null && data.investments.some((i) => i.balance > 0)) {
    info.push(
      "O Open Finance não trouxe a taxa (% do CDI) das caixinhas; sem isso o previsto do mês não aparece. No terminal, ao atualizar, confira se alguma linha mostra \"120% CDI\" ou \"sem %\".",
    );
  }
  if (totals.monthProfit !== null && totals.monthProfitFrom) {
    info.push(
      `Medido desde ${formatIsoDate(totals.monthProfitFrom)}: ${signedMoney(totals.monthProfit)} (saldo − aplicações/resgates).`,
    );
  }
  info.push("O ajuste manual aparece na tabela de investimentos; botão direito para editar valor e data.");
  wealthInfo.textContent = info.join(" ");

  const summary = el("wealth-manual-summary");
  if (manual.amount > 0) {
    summary.textContent = [
      `+${money(manual.amount)} somados aos ${money(reportedInvestments)} do Open Finance`,
      manual.date ? `em ${date(manual.date)}` : "",
      manual.note ? `(${manual.note})` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  } else {
    summary.textContent = `Open Finance: ${money(reportedInvestments)}. Sem ajuste manual.`;
  }
  el("wealth-manual-btn", HTMLButtonElement).textContent = manual.amount > 0 ? "Editar ajuste" : "Definir valor";

  renderWealthChart(history, data.investmentsAvailable || manual.amount > 0);

  el("balances").replaceChildren(...data.accounts.map(balanceRow));
  el("investments-card").hidden = data.investments.length === 0 && manual.amount <= 0;
  const rows = data.investments.map((inv) => {
    const rateLabel =
      inv.rate === null ? "—" : `${inv.rate}%${inv.rateType ? ` ${inv.rateType}` : ""}`;
    return h(
      "tr",
      {},
      h("td", { text: inv.name }),
      h("td", { className: "muted", text: INVESTMENT_TYPE_LABELS[inv.type] }),
      h("td", { className: "muted", text: rateLabel }),
      h("td", {
        className: `col-amount amount ${(inv.expectedMonthProfit ?? 0) > 0 ? "is-positive" : "muted"}`,
        text: inv.expectedMonthProfit === null ? "—" : signedMoney(inv.expectedMonthProfit, inv.currencyCode),
      }),
      h("td", { className: "col-amount amount muted", text: inv.invested === null ? "—" : money(inv.invested, inv.currencyCode) }),
      h("td", {
        className: `col-amount amount ${(inv.profit ?? 0) > 0 ? "is-positive" : (inv.profit ?? 0) < 0 ? "is-negative" : "muted"}`,
        text: inv.profit === null ? "—" : signedMoney(inv.profit, inv.currencyCode),
      }),
      h("td", { className: "col-amount amount", text: money(inv.balance, inv.currencyCode) }),
    );
  });
  if (manual.amount > 0) {
    const label = [
      "Ajuste manual",
      manual.note,
      manual.date ? `entrada ${date(manual.date)}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const row = h(
      "tr",
      { className: "manual-row" },
      h("td", { text: label }),
      h("td", { className: "muted", text: "Manual" }),
      h("td", { className: "muted", text: "—" }),
      h("td", { className: "col-amount amount muted", text: "—" }),
      h("td", { className: "col-amount amount muted", text: "—" }),
      h("td", { className: "col-amount amount muted", text: "—" }),
      h("td", { className: "col-amount amount", text: money(manual.amount) }),
    );
    row.dataset.manualAdjust = "1";
    row.dataset.label = "Ajuste manual";
    row.title = "Botão direito para editar valor e data";
    rows.push(row);
  }
  el("investments").replaceChildren(...rows);
}

const wealthManualDialog = el("wealth-manual-dialog", HTMLDialogElement);
const wealthManualForm = el("wealth-manual-form", HTMLFormElement);
const wealthManualAmount = el("wealth-manual-amount", HTMLInputElement);
const wealthManualDate = el("wealth-manual-date", HTMLInputElement);
const wealthManualNote = el("wealth-manual-note", HTMLInputElement);
const wealthManualError = el("wealth-manual-error");

function openWealthManualDialog(): void {
  const current = state.wealth?.manual;
  wealthManualError.textContent = "";
  wealthManualAmount.value = current && current.amount > 0 ? String(current.amount) : "";
  wealthManualDate.value = current?.date || toIsoDate(new Date());
  wealthManualNote.value = current?.note ?? "";
  wealthManualDialog.showModal();
  wealthManualAmount.focus();
}

el("wealth-manual-btn").addEventListener("click", () => openWealthManualDialog());
el("cancel-wealth-manual-btn").addEventListener("click", () => wealthManualDialog.close());

el("wealth-manual-clear-btn").addEventListener("click", async () => {
  wealthManualError.textContent = "";
  try {
    const wealth = await api("POST /api/wealth/manual", { amount: null, note: null, date: null });
    state.wealth = wealth;
    wealthManualDialog.close();
    renderWealth(wealth);
  } catch (err) {
    wealthManualError.textContent = errorMessage(err);
  }
});

wealthManualForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  wealthManualError.textContent = "";
  const raw = wealthManualAmount.value.trim().replace(",", ".");
  const amount = raw === "" ? null : Number(raw);
  const dateValue = wealthManualDate.value;
  if (amount === null || !Number.isFinite(amount) || amount <= 0) {
    wealthManualError.textContent = "Informe um valor maior que zero.";
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
    wealthManualError.textContent = "Informe a data de entrada.";
    return;
  }
  try {
    const wealth = await api("POST /api/wealth/manual", {
      amount,
      note: wealthManualNote.value.trim() || null,
      date: dateValue,
    });
    state.wealth = wealth;
    wealthManualDialog.close();
    renderWealth(wealth);
  } catch (err) {
    wealthManualError.textContent = errorMessage(err);
  }
});

const monthLabel = (month: string): string => {
  const [year = "", m = "1"] = month.split("-");
  return `${MONTHS[Number(m) - 1] ?? ""}/${year.slice(2)}`;
};

const compactMoney = (value: number): string =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", notation: "compact", maximumFractionDigits: 1 }).format(value);

const SVG_NS = "http://www.w3.org/2000/svg";

/** Margens internas dos gráficos: a esquerda cabe o rótulo mais longo do eixo ("R$ 999,9 mil"); a direita, meio rótulo de mês. */
const CHART_PAD = { top: 16, right: 28, bottom: 28, left: 92 } as const;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, ...children: Node[]): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  node.append(...children);
  return node;
}

interface ChartSeries {
  id: "total" | "accounts" | "investments";
  label: string;
  value: (p: WealthPoint) => number;
}

/** Gráfico de linhas em SVG: total, contas e investimentos por mês. */
function renderWealthChart(history: readonly WealthPoint[], withInvestments: boolean): void {
  const series: ChartSeries[] = [
    { id: "total", label: "Total", value: (p) => p.total },
    { id: "accounts", label: "Contas", value: (p) => p.accounts },
    ...(withInvestments ? [{ id: "investments" as const, label: "Investimentos", value: (p: WealthPoint) => p.investments }] : []),
  ];

  el("wealth-legend").replaceChildren(
    ...series.map((s) => h("span", { className: `legend-item legend-${s.id}`, text: s.label })),
  );

  const width = 720;
  const height = 260;
  const pad = CHART_PAD;
  const values = history.flatMap((p) => series.map((s) => s.value(p)));
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const x = (i: number): number => pad.left + (i * (width - pad.left - pad.right)) / Math.max(1, history.length - 1);
  const y = (v: number): number => pad.top + ((max - v) * (height - pad.top - pad.bottom)) / span;

  const grid = [0, 1, 2, 3, 4].map((i) => {
    const v = min + (span * i) / 4;
    return svg(
      "g",
      { class: "chart-grid" },
      svg("line", { x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v) }),
      svg("text", { x: pad.left - 8, y: y(v) + 4, "text-anchor": "end" }, document.createTextNode(compactMoney(v))),
    );
  });
  const labels = history.map((p, i) =>
    svg("text", { class: "chart-label", x: x(i), y: height - 8, "text-anchor": "middle" }, document.createTextNode(monthLabel(p.month))),
  );
  const lines = series.map((s) => {
    const points = history.map((p, i) => `${x(i).toFixed(1)},${y(s.value(p)).toFixed(1)}`).join(" ");
    const dots = history.map((p, i) =>
      svg(
        "circle",
        { cx: x(i), cy: y(s.value(p)), r: 3 },
        svg("title", {}, document.createTextNode(`${s.label} · ${monthLabel(p.month)}: ${money(s.value(p))}`)),
      ),
    );
    return svg("g", { class: `chart-series chart-${s.id}` }, svg("polyline", { points }), ...dots);
  });

  const chart = svg(
    "svg",
    { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "Evolução do patrimônio nos últimos 12 meses" },
    ...grid,
    ...labels,
    ...lines,
  );
  el("wealth-chart").replaceChildren(chart);
}

// Linhas de movimentação

/** Linha de movimentação; guarda o pagador/recebedor para o menu do botão direito. */
function transactionRow(t: PeriodTransaction, ...cells: HTMLTableCellElement[]): HTMLTableRowElement {
  const row = h("tr", {}, ...cells);
  row.dataset.key = t.counterpartyKey;
  row.dataset.label = t.alias ?? t.counterpartyName;
  if (t.direction === "in" && !t.internal) {
    row.dataset.txnId = t.id;
    row.dataset.txnRefund = t.refund ? "1" : "0";
  }
  return row;
}

const EYE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
  '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';

/** Nome exibido ("PAGO - Barbeiro"); o nome completo original aparece no botão de olho. */
function descriptionCell(t: PeriodTransaction): HTMLTableCellElement {
  const original = [t.counterpartyName, t.description]
    .filter((text, i, all) => text && all.indexOf(text) === i)
    .join(" · ");
  const reveal = h("button", { className: "reveal-btn" });
  reveal.type = "button";
  reveal.title = "Mostrar nome completo";
  reveal.setAttribute("aria-pressed", "false");
  reveal.dataset.reveal = "";
  reveal.innerHTML = EYE_ICON;
  const details = h("span", { className: "subtext", text: original });
  details.hidden = true;
  const cell = h("td", {}, h("div", { className: "cell-name" }, h("span", { text: t.displayName }), reveal), details);
  if (t.refundLink) cell.append(refundNote(t.id, t.refundLink));
  return cell;
}

document.addEventListener("click", (e) => {
  const btn = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-reveal]") : null;
  const details = btn?.closest("td")?.querySelector<HTMLElement>(".subtext");
  if (!btn || !details) return;
  details.hidden = !details.hidden;
  btn.setAttribute("aria-pressed", String(!details.hidden));
  btn.title = details.hidden ? "Mostrar nome completo" : "Ocultar nome completo";
});

// Tags

interface CounterpartyGroup {
  key: string;
  name: string;
  count: number;
  total: number;
  tagId: string | null;
}

interface DragPayload {
  key: string;
  label: string;
}

function groupCounterparties(transactions: readonly PeriodTransaction[]): Map<string, CounterpartyGroup> {
  const groups = new Map<string, CounterpartyGroup>();
  for (const t of transactions) {
    if (t.internal || t.cancelled) continue;
    const group = groups.get(t.counterpartyKey) ?? {
      key: t.counterpartyKey,
      name: t.alias ?? t.counterpartyName,
      count: 0,
      total: 0,
      tagId: t.tagId,
    };
    group.count++;
    group.total += cashflowOf(t);
    groups.set(t.counterpartyKey, group);
  }
  return groups;
}

function counterpartyItem(payload: DragPayload, total: number | null, count: number, removable: boolean): HTMLLIElement {
  const amount = h("span", {
    className: `amount text-sm ${total === null ? "muted" : total < 0 ? "is-negative" : "is-positive"}`,
    text: total === null ? "sem movimentação" : `${money(total)} · ${count}x`,
  });
  const item = h("li", { className: "counterparty" }, h("span", { className: "name", text: payload.label }), amount);
  item.title = payload.label;
  item.draggable = true;
  item.dataset.key = payload.key;
  item.dataset.label = payload.label;
  if (removable) {
    const remove = h("button", { className: "btn btn-ghost remove", text: "×" });
    remove.type = "button";
    remove.title = "Remover desta tag";
    remove.dataset.removeKey = payload.key;
    item.append(remove);
  } else {
    item.append(h("span"));
  }
  return item;
}

function filterSummary(filter: TagFilter): string {
  const parts: string[] = [];
  if (filter.amount !== null) parts.push(`só ${money(filter.amount)}`);
  if (filter.contains) parts.push(`nome com "${filter.contains}"`);
  return parts.join(" · ") || "Filtro";
}

function filterItem(filter: TagFilter): HTMLLIElement {
  const item = h("li", { className: "filter-item" });
  item.append(h("span", { className: "summary", text: filterSummary(filter) }));
  const remove = h("button", { className: "btn btn-ghost btn-sm remove", text: "×" });
  remove.type = "button";
  remove.title = "Remover filtro";
  remove.dataset.removeFilter = filter.id;
  item.append(remove);
  return item;
}

function renderTags(period: PeriodResponse): void {
  const groups = groupCounterparties(period.transactions);

  const untagged = [...groups.values()].filter((g) => g.tagId === null).sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  el("untagged-list").replaceChildren(
    ...untagged.map((g) => counterpartyItem({ key: g.key, label: g.name }, g.total, g.count, false)),
  );
  el("untagged-count").textContent = `${untagged.length}`;

  const template = el("tag-card-template", HTMLTemplateElement);
  const cards = state.tags.tags.map((tag) => {
    const node = template.content.cloneNode(true) as DocumentFragment;
    const card = child(node, ".tag-card");
    card.dataset.dropTag = tag.id;
    card.dataset.color = tag.color;
    child(node, ".tag-badge").textContent = tag.name;
    child<HTMLButtonElement>(node, ".edit").dataset.editTag = tag.id;
    child<HTMLButtonElement>(node, ".add-filter").dataset.addFilter = tag.id;

    const filters = state.tags.filters.filter((f) => f.tagId === tag.id);
    child(node, ".filter-list").replaceChildren(...filters.map(filterItem));

    const rules = state.tags.rules.filter((r) => r.tagId === tag.id);
    let total = 0;
    const items = rules
      .map((rule) => ({ rule, group: groups.get(rule.key) }))
      .sort((a, b) => Math.abs(b.group?.total ?? 0) - Math.abs(a.group?.total ?? 0))
      .map(({ rule, group }) => {
        total += group?.total ?? 0;
        return counterpartyItem({ key: rule.key, label: group?.name ?? rule.label }, group?.total ?? null, group?.count ?? 0, true);
      });

    // Totais do período: regras por pessoa + movimentações que bateram só no filtro
    const filterTagged = period.transactions.filter(
      (t) => !t.internal && !t.cancelled && t.tagId === tag.id && !rules.some((r) => r.key === t.counterpartyKey),
    );
    for (const t of filterTagged) total += cashflowOf(t);

    child(node, ".counterparty-list").replaceChildren(...items);

    const totalEl = child(node, ".total");
    totalEl.textContent = rules.length || filters.length ? money(total) : "";
    totalEl.classList.toggle("is-negative", total < 0);
    totalEl.classList.toggle("is-positive", total > 0);
    return node;
  });

  const noTags = el("no-tags");
  noTags.hidden = cards.length > 0;
  el("tag-cards").replaceChildren(noTags, ...cards);
}

async function assignTag(payload: DragPayload, tagId: string | null): Promise<void> {
  appError.textContent = "";
  try {
    await api("POST /api/rules/set", { key: payload.key, label: payload.label, tagId });
    await loadPeriod();
  } catch (err) {
    appError.textContent = errorMessage(err);
  }
}

function parseDragPayload(raw: string): DragPayload | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { key, label } = value as Record<string, unknown>;
    return typeof key === "string" && typeof label === "string" ? { key, label } : null;
  } catch {
    return null;
  }
}

const tagsPanel = el("panel-tags");
const dropzoneOf = (target: EventTarget | null): HTMLElement | null =>
  target instanceof Element ? target.closest<HTMLElement>("[data-drop-tag]") : null;

tagsPanel.addEventListener("dragstart", (e) => {
  const item = e.target instanceof Element ? e.target.closest<HTMLElement>(".counterparty") : null;
  const key = item?.dataset.key;
  const label = item?.dataset.label;
  if (!item || !key || !label || !e.dataTransfer) return;
  e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ key, label } satisfies DragPayload));
  e.dataTransfer.effectAllowed = "move";
  item.classList.add("is-dragging");
});

tagsPanel.addEventListener("dragend", (e) => {
  if (e.target instanceof Element) e.target.classList.remove("is-dragging");
  for (const zone of tagsPanel.querySelectorAll(".is-over")) zone.classList.remove("is-over");
});

tagsPanel.addEventListener("dragover", (e) => {
  const zone = dropzoneOf(e.target);
  if (!zone || !e.dataTransfer?.types.includes(DRAG_TYPE)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  zone.classList.add("is-over");
});

tagsPanel.addEventListener("dragleave", (e) => {
  const zone = dropzoneOf(e.target);
  if (zone && !(e.relatedTarget instanceof Node && zone.contains(e.relatedTarget))) zone.classList.remove("is-over");
});

tagsPanel.addEventListener("drop", (e) => {
  const zone = dropzoneOf(e.target);
  if (!zone || !e.dataTransfer) return;
  e.preventDefault();
  zone.classList.remove("is-over");
  const payload = parseDragPayload(e.dataTransfer.getData(DRAG_TYPE));
  if (!payload) return;
  const tagId = zone.dataset.dropTag || null;
  const current = state.tags.rules.find((r) => r.key === payload.key)?.tagId ?? null;
  if (current !== tagId) void assignTag(payload, tagId);
});

tagsPanel.addEventListener("click", (e) => {
  if (!(e.target instanceof Element)) return;
  const remove = e.target.closest<HTMLElement>("[data-remove-key]");
  const key = remove?.dataset.removeKey;
  if (remove && key) {
    void assignTag({ key, label: remove.closest<HTMLElement>(".counterparty")?.dataset.label ?? key }, null);
    return;
  }
  const removeFilterId = e.target.closest<HTMLElement>("[data-remove-filter]")?.dataset.removeFilter;
  if (removeFilterId) {
    void deleteTagFilter(removeFilterId);
    return;
  }
  const addFilterTagId = e.target.closest<HTMLElement>("[data-add-filter]")?.dataset.addFilter;
  if (addFilterTagId && tagById().has(addFilterTagId)) {
    openFilterDialog(addFilterTagId);
    return;
  }
  const tagId = e.target.closest<HTMLElement>("[data-edit-tag]")?.dataset.editTag;
  const tag = tagId ? tagById().get(tagId) : undefined;
  if (tag) openTagDialog(tag);
});

// Diálogo de filtro (valor / nome)

const filterDialog = el("filter-dialog", HTMLDialogElement);
const filterForm = el("filter-form", HTMLFormElement);
const filterAmountInput = el("filter-amount", HTMLInputElement);
const filterContainsInput = el("filter-contains", HTMLInputElement);
const filterError = el("filter-error");
let filterTagId: string | null = null;

function openFilterDialog(tagId: string): void {
  filterTagId = tagId;
  filterError.textContent = "";
  const tag = tagById().get(tagId);
  el("filter-dialog-title").textContent = tag ? `Filtro · ${tag.name}` : "Filtro da tag";
  filterAmountInput.value = "";
  filterContainsInput.value = "";
  filterDialog.showModal();
  filterAmountInput.focus();
}

async function deleteTagFilter(id: string): Promise<void> {
  appError.textContent = "";
  try {
    await api("POST /api/filters/delete", { id });
    await loadPeriod();
  } catch (err) {
    appError.textContent = errorMessage(err);
  }
}

el("cancel-filter-btn").addEventListener("click", () => filterDialog.close());

filterForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!filterTagId) return;
  filterError.textContent = "";
  const amountRaw = filterAmountInput.value.trim();
  const amount = amountRaw ? Number(amountRaw.replace(",", ".")) : null;
  const contains = filterContainsInput.value.trim() || null;
  if (amount === null && !contains) {
    filterError.textContent = "Informe o valor e/ou o texto.";
    return;
  }
  if (amount !== null && (!Number.isFinite(amount) || amount <= 0)) {
    filterError.textContent = "Valor inválido.";
    return;
  }
  try {
    await api("POST /api/filters/upsert", { tagId: filterTagId, amount, contains });
    filterDialog.close();
    await loadPeriod();
  } catch (err) {
    filterError.textContent = errorMessage(err);
  }
});

// Diálogo de tag

const tagDialog = el("tag-dialog", HTMLDialogElement);
const tagForm = el("tag-form", HTMLFormElement);
const tagNameInput = el("tag-name", HTMLInputElement);
const tagColors = el("tag-colors");
const tagError = el("tag-error");
const deleteTagBtn = el("delete-tag-btn", HTMLButtonElement);
let editingTag: Tag | null = null;
/** Pagador/recebedor que recebe a tag recém-criada (quando criada pelo menu do botão direito). */
let assignOnCreate: DragPayload | null = null;

tagColors.replaceChildren(
  ...TAG_COLORS.map((color) => {
    const input = h("input");
    input.type = "radio";
    input.name = "tag-color";
    input.value = color;
    input.setAttribute("aria-label", TAG_COLOR_LABELS[color]);
    const label = h("label", { className: "swatch" }, input, h("span"));
    label.dataset.color = color;
    label.title = TAG_COLOR_LABELS[color];
    return label;
  }),
);

function selectedColor(): TagColor {
  const value = tagForm.querySelector<HTMLInputElement>('input[name="tag-color"]:checked')?.value;
  return isOneOf(TAG_COLORS, value) ? value : "gray";
}

function nextFreeColor(): TagColor {
  const used = new Set(state.tags.tags.map((t) => t.color));
  return TAG_COLORS.find((c) => !used.has(c) && c !== "gray") ?? "gray";
}

function openTagDialog(tag: Tag | null, assignTo: DragPayload | null = null): void {
  editingTag = tag;
  assignOnCreate = tag ? null : assignTo;
  tagError.textContent = "";
  el("tag-dialog-title").textContent = tag ? "Editar tag" : assignTo ? `Nova tag para ${assignTo.label}` : "Nova tag";
  tagNameInput.value = tag?.name ?? "";
  const color = tag?.color ?? nextFreeColor();
  for (const input of tagForm.querySelectorAll<HTMLInputElement>('input[name="tag-color"]')) {
    input.checked = input.value === color;
  }
  deleteTagBtn.hidden = !tag;
  tagDialog.showModal();
  tagNameInput.focus();
}

el("new-tag-btn").addEventListener("click", () => openTagDialog(null));
el("cancel-tag-btn").addEventListener("click", () => tagDialog.close());

tagForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  tagError.textContent = "";
  const name = tagNameInput.value.trim();
  const color = selectedColor();
  try {
    if (editingTag) await api("POST /api/tags/update", { id: editingTag.id, name, color });
    else {
      const created = await api("POST /api/tags/create", { name, color });
      if (assignOnCreate) {
        await api("POST /api/rules/set", { key: assignOnCreate.key, label: assignOnCreate.label, tagId: created.id });
      }
    }
    tagDialog.close();
    await loadPeriod();
  } catch (err) {
    tagError.textContent = errorMessage(err);
  }
});

deleteTagBtn.addEventListener("click", async () => {
  if (!editingTag) return;
  if (!confirm(`Excluir a tag "${editingTag.name}"? Os pagadores/recebedores dela voltam para "Sem tag".`)) return;
  try {
    await api("POST /api/tags/delete", { id: editingTag.id });
    tagDialog.close();
    await loadPeriod();
  } catch (err) {
    tagError.textContent = errorMessage(err);
  }
});

// Contas recorrentes

const recurringInfo = el("recurring-info");
let recurringSeq = 0;

async function loadRecurring(refresh = false): Promise<RecurringResponse | null> {
  const seq = ++recurringSeq;
  recurringInfo.textContent = "Buscando os últimos meses...";
  try {
    const recurring = await api("POST /api/recurring", { ...state.range, refresh });
    if (seq !== recurringSeq) return null;
    state.recurring = recurring;
    renderRecurring(recurring);
    return recurring;
  } catch (err) {
    if (seq !== recurringSeq) return null;
    recurringInfo.textContent = "";
    appError.textContent = errorMessage(err);
    return null;
  }
}

const expectedOf = (item: Pick<RecurringItem, "expected" | "average">): number => item.expected ?? item.average;

/** Janela de uma semana em volta do dia usual, com virada de mês: dia 30 vira "entre dia 27 e 2". */
function weekWindow(day: number): string {
  const wrap = (d: number): number => ((d - 1 + 31) % 31) + 1;
  return `entre dia ${wrap(day - 3)} e ${wrap(day + 3)}`;
}

const isPaid = (item: RecurringItem): boolean => item.paid > 0 || item.manualPaid;

const isRecurring = (key: string): boolean => state.tags.recurring.some((r) => r.key === key);

function renderRecurring(data: RecurringResponse): void {
  const { totals, items, historyMonths } = data;
  el("recurring-expected").textContent = money(totals.expected);
  el("recurring-paid").textContent = money(-totals.paid);
  el("recurring-pending").textContent = money(totals.pending);

  const paidCount = items.filter(isPaid).length;
  recurringInfo.textContent = items.length
    ? `${paidCount} de ${items.length} contas pagas no período. Médias calculadas com os ${historyMonths} meses anteriores.`
    : "";

  const tags = tagById();
  el("recurring-list").replaceChildren(...items.map((item) => recurringRow(item, tags)));
  el("recurring-empty").hidden = items.length > 0;
}

function smallButton(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const btn = h("button", { className: `btn btn-sm ${className}`, text });
  btn.type = "button";
  btn.addEventListener("click", onClick);
  return btn;
}

/** Mês de referência para o "marcar pago" das contas sem vínculo. */
const periodMonth = (): string => state.range.from.slice(0, 7);

async function recurringAction(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    await loadPeriod();
  } catch (err) {
    appError.textContent = errorMessage(err);
  }
}

/** "Esta transação é desta conta?": Sim marca como paga; Não descarta a transação para esta conta. */
function matchPrompt(item: RecurringItem): HTMLDivElement | null {
  const candidate = item.candidates[0];
  if (!candidate) return null;
  const answer = (paid: boolean) => () =>
    void recurringAction(() =>
      api("POST /api/recurring/confirm", {
        billId: item.id,
        transactionId: candidate.id,
        month: candidate.date.slice(0, 7),
        paid,
      }),
    );
  return h(
    "div",
    { className: "match-prompt" },
    h("span", {
      text: `${money(candidate.amount)} em ${date(candidate.date).slice(0, 5)} (${candidate.displayName}) é desta conta?`,
    }),
    smallButton("Sim", "btn-secondary", answer(true)),
    smallButton("Não", "btn-ghost", answer(false)),
  );
}

function paymentText(item: RecurringItem): string {
  if (item.payments.length) return item.payments.map((p) => date(p.date).slice(0, 5)).join(", ");
  if (item.manualPaid) return "marcado à mão";
  if (item.day === null) return "—";
  return item.manual ? `vence dia ${item.day}` : `costuma ser ${weekWindow(item.day)}`;
}

function recurringRow(item: RecurringItem, tags: Map<string, Tag>): HTMLTableRowElement {
  const paid = isPaid(item);
  const nameCell = h("td", {}, h("span", { text: item.name }));
  if (item.manual) {
    const link = item.matchName
      ? `vinculada ao nome "${item.original}"`
      : item.original
        ? `vinculada a ${item.original}`
        : "sem vínculo";
    nameCell.append(h("span", { className: "subtext", text: link }));
  }
  const tag = item.tagId ? tags.get(item.tagId) : undefined;
  if (tag) nameCell.append(h("div", {}, tagBadge(tag)));
  const prompt = matchPrompt(item);
  if (prompt) nameCell.append(prompt);

  const statusCell = h(
    "td",
    {},
    h("span", { className: `badge ${paid ? "badge-positive" : "badge-warning"}`, text: paid ? "Pago" : "Pendente" }),
  );
  if (item.manual && !item.payments.length) {
    const toggle = (value: boolean) => () =>
      void recurringAction(() => api("POST /api/recurring/mark-paid", { billId: item.id, month: periodMonth(), paid: value }));
    statusCell.append(
      h("div", {}, item.manualPaid ? smallButton("Desmarcar", "btn-ghost", toggle(false)) : smallButton("Marcar pago", "btn-ghost", toggle(true))),
    );
  }

  const valueBtn = h(
    "button",
    { className: "value-btn" },
    h("span", { className: "amount", text: money(expectedOf(item)) }),
    h("span", {
      className: "subtext",
      text: item.expected === null ? `média de ${item.months} meses` : item.manual ? "valor da conta" : "valor fixado",
    }),
  );
  valueBtn.type = "button";
  valueBtn.title = "Alterar valor esperado";
  valueBtn.addEventListener("click", () => openExpectedDialog(item));

  const removeBtn = smallButton("Remover", "btn-ghost", () => {
    if (!confirm(`Remover "${item.name}" das contas recorrentes?`)) return;
    void recurringAction(() => api("POST /api/recurring/update", { add: [], remove: [item.id] }));
  });
  removeBtn.title = "Deixar de acompanhar como recorrente";

  const row = h(
    "tr",
    {},
    nameCell,
    statusCell,
    h("td", { className: "muted text-sm", text: paymentText(item) }),
    h("td", { className: "col-amount" }, valueBtn),
    h("td", {
      className: `col-amount amount ${paid ? "is-negative" : "muted"}`,
      text: paid ? money(-(item.paid || expectedOf(item))) : "—",
    }),
    h("td", { className: "col-amount" }, removeBtn),
  );
  if (item.key) row.dataset.key = item.key;
  row.dataset.label = item.manual ? item.original || item.name : item.name;
  if (item.manual) row.dataset.billId = item.id;
  return row;
}

// Carregar transações que se repetem (modal)

const scanDialog = el("scan-dialog", HTMLDialogElement);
const scanList = el("scan-list");
const scanInfo = el("scan-info");
const scanError = el("scan-error");
const scanAll = el("scan-all", HTMLInputElement);
const saveScanBtn = el("save-scan-btn", HTMLButtonElement);

const scanBoxes = (): HTMLInputElement[] => [...scanList.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];

/** Checkboxes cujo estado difere do salvo (`data-initial`): o que será adicionado ou removido. */
const scanChanges = (): { add: HTMLInputElement[]; remove: HTMLInputElement[] } => {
  const boxes = scanBoxes();
  return {
    add: boxes.filter((b) => b.checked && b.dataset.initial !== "true"),
    remove: boxes.filter((b) => !b.checked && b.dataset.initial === "true"),
  };
};

function updateScanSelection(): void {
  const boxes = scanBoxes();
  const selected = boxes.filter((b) => b.checked).length;
  const { add, remove } = scanChanges();
  const changes = [add.length && `+${add.length} a adicionar`, remove.length && `−${remove.length} a remover`].filter(Boolean);
  el("scan-selected").textContent = [`${selected} marcada${selected === 1 ? "" : "s"}`, ...changes].join(" · ");
  scanAll.checked = boxes.length > 0 && selected === boxes.length;
  scanAll.indeterminate = selected > 0 && selected < boxes.length;
  saveScanBtn.disabled = add.length + remove.length === 0;
}

interface ScanEntry {
  /** Id da conta (já recorrentes) ou chave do pagador/recebedor (encontradas). */
  id: string;
  name: string;
  original: string;
  day: number | null;
  months: number;
  amount: number;
  recurring: boolean;
}

function scanItem(entry: ScanEntry, historyMonths: number): HTMLLIElement {
  const box = h("input");
  box.type = "checkbox";
  box.value = entry.id;
  box.dataset.label = entry.original;
  box.dataset.initial = String(entry.recurring);
  box.checked = entry.recurring;
  const pattern = entry.months
    ? [entry.day === null ? "" : `todo mês ${weekWindow(entry.day)}`, `em ${entry.months} de ${historyMonths} meses`]
    : ["sem pagamentos nos meses anteriores"];
  const info = h(
    "div",
    { className: "stack-tight" },
    h("span", { className: "name", text: entry.name }),
    h("span", { className: "subtext", text: pattern.filter(Boolean).join(" · ") }),
  );
  info.title = entry.original;
  const amount = h("span", { className: "amount text-sm", text: `${money(entry.amount)}/mês` });
  return h("li", {}, h("label", { className: "suggestion" }, box, info, amount));
}

const scanHeading = (text: string): HTMLLIElement => h("li", { className: "eyebrow scan-heading", text });

function renderScan(data: RecurringResponse): void {
  const { items, suggestions, historyMonths } = data;
  const current: ScanEntry[] = items.map((i) => ({
    id: i.id,
    name: i.name,
    original: i.original,
    day: i.day,
    months: i.months,
    amount: expectedOf(i),
    recurring: true,
  }));
  const found: ScanEntry[] = suggestions.map((s: RecurringSuggestion) => ({
    id: s.key,
    name: s.name,
    original: s.original,
    day: s.day,
    months: s.months,
    amount: s.average,
    recurring: false,
  }));

  el("scan-count").textContent = found.length ? `${found.length} encontradas` : "";
  scanInfo.textContent = found.length
    ? `Pagamentos feitos uma vez por mês, com valor parecido, nos ${historyMonths} meses anteriores ao período. Marque os que são contas recorrentes; desmarque para remover.`
    : `Nenhum pagamento novo com padrão mensal nos ${historyMonths} meses anteriores ao período.`;
  scanList.replaceChildren(
    ...(current.length ? [scanHeading("Já recorrentes"), ...current.map((e) => scanItem(e, historyMonths))] : []),
    ...(found.length ? [scanHeading("Encontradas"), ...found.map((e) => scanItem(e, historyMonths))] : []),
  );
  el("scan-toolbar").hidden = current.length + found.length === 0;
  updateScanSelection();
}

const scanBtn = el("scan-recurring-btn", HTMLButtonElement);

scanBtn.addEventListener("click", async () => {
  scanBtn.disabled = true;
  scanBtn.classList.add("is-loading");
  appError.textContent = "";
  try {
    const recurring = await loadRecurring(true);
    if (!recurring) return;
    scanError.textContent = "";
    renderScan(recurring);
    scanDialog.showModal();
  } finally {
    scanBtn.disabled = false;
    scanBtn.classList.remove("is-loading");
  }
});

scanList.addEventListener("change", updateScanSelection);
scanAll.addEventListener("change", () => {
  for (const box of scanBoxes()) box.checked = scanAll.checked;
  updateScanSelection();
});
el("cancel-scan-btn", HTMLButtonElement).addEventListener("click", () => scanDialog.close());

el("scan-form", HTMLFormElement).addEventListener("submit", async (e) => {
  e.preventDefault();
  const changes = scanChanges();
  const add = changes.add.map((b) => ({ key: b.value, label: b.dataset.label ?? b.value }));
  const remove = changes.remove.map((b) => b.value);
  if (!add.length && !remove.length) return;
  saveScanBtn.disabled = true;
  try {
    await api("POST /api/recurring/update", { add, remove });
    scanDialog.close();
    await loadPeriod();
  } catch (err) {
    scanError.textContent = errorMessage(err);
    saveScanBtn.disabled = false;
  }
});

async function setRecurring(key: string, label: string, recurring: boolean): Promise<void> {
  try {
    await api("POST /api/recurring/set", { key, label, recurring });
    await loadPeriod();
  } catch (err) {
    appError.textContent = errorMessage(err);
  }
}

const expectedDialog = el("expected-dialog", HTMLDialogElement);
const expectedInput = el("expected-input", HTMLInputElement);
const expectedError = el("expected-error");
let expectedTarget: RecurringItem | null = null;

function openExpectedDialog(item: RecurringItem): void {
  expectedTarget = item;
  el("expected-name").textContent = item.name;
  el("expected-average").textContent = item.months
    ? `A média dos meses com pagamento é ${money(item.average)}.`
    : "Ainda não há pagamentos anteriores para calcular a média.";
  expectedInput.value = expectedOf(item) ? expectedOf(item).toFixed(2) : "";
  expectedError.textContent = "";
  el("expected-average-btn", HTMLButtonElement).hidden = item.expected === null || item.manual;
  expectedDialog.showModal();
  expectedInput.select();
}

async function saveExpected(expected: number | null): Promise<void> {
  if (!expectedTarget) return;
  try {
    await api("POST /api/recurring/expected", { id: expectedTarget.id, expected });
    expectedDialog.close();
    await loadPeriod();
  } catch (err) {
    expectedError.textContent = errorMessage(err);
  }
}

el("expected-form", HTMLFormElement).addEventListener("submit", (e) => {
  e.preventDefault();
  const value = expectedInput.valueAsNumber;
  if (!Number.isFinite(value) || value <= 0) {
    expectedError.textContent = "Informe um valor maior que zero.";
    return;
  }
  void saveExpected(value);
});
el("expected-average-btn", HTMLButtonElement).addEventListener("click", () => void saveExpected(null));
el("cancel-expected-btn", HTMLButtonElement).addEventListener("click", () => expectedDialog.close());

// Adicionar conta recorrente (manual)

const createDialog = el("create-recurring-dialog", HTMLDialogElement);
const createForm = el("create-recurring-form", HTMLFormElement);
const createError = el("create-recurring-error");
const billLabel = el("bill-label", HTMLInputElement);
const billAmount = el("bill-amount", HTMLInputElement);
const billDay = el("bill-day", HTMLInputElement);
const billLink = el("bill-link", HTMLInputElement);
const billLinkResults = el("bill-link-results");
const billLinkPicked = el("bill-link-picked");
const MAX_LINK_RESULTS = 8;

/** Vínculo escolhido: pagador/recebedor ou CPF/CNPJ (`key`), ou nome digitado (`matchName`). */
interface PickedLink {
  key: string | null;
  matchName: string | null;
  label: string;
}

let pickedLink: PickedLink | null = null;
/** Transação escolhida na busca por nome + valor: vira o pagamento confirmado da conta. */
let pickedTransaction: { id: string; month: string } | null = null;
/** Conta manual em edição; `null` = cadastro novo. */
let editingBillId: string | null = null;

const normalize = (text: string): string =>
  text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

function formatDocument(digits: string): string {
  return digits.length === 11
    ? digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4")
    : digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
}

function pickLink(link: PickedLink, detail: string): void {
  pickedLink = link;
  pickedTransaction = null;
  const { label } = link;
  el("bill-link-name").textContent = label;
  el("bill-link-detail").textContent = detail;
  billLinkPicked.hidden = false;
  billLink.hidden = true;
  billLink.value = "";
  billLinkResults.replaceChildren();
}

function clearLink(): void {
  pickedLink = null;
  pickedTransaction = null;
  billLinkPicked.hidden = true;
  billLink.hidden = false;
  billLink.focus();
}

function linkResult(text: string, detail: string, onPick: () => void): HTMLLIElement {
  const btn = h("button", {}, h("span", { text }), h("span", { className: "subtext", text: detail }));
  btn.type = "button";
  btn.addEventListener("click", onPick);
  return h("li", {}, btn);
}

function renderLinkResults(): void {
  const query = billLink.value.trim();
  const options = state.recurring?.counterparties ?? [];
  const digits = query.replace(/\D/g, "");
  const isDocument = /^[\d.\-/\s]+$/.test(query) && (digits.length === 11 || digits.length === 14);

  if (isDocument) {
    const key = `doc:${digits}`;
    const known = options.find((o) => o.key === key);
    const label = known?.name ?? formatDocument(digits);
    const detail = known ? `${digits.length === 11 ? "CPF" : "CNPJ"} já visto nas movimentações` : "ainda sem movimentações";
    billLinkResults.replaceChildren(
      linkResult(`Vincular a ${label}`, detail, () => pickLink({ key, matchName: null, label }, detail)),
    );
    return;
  }
  const { text, amount } = parseLinkQuery(query);
  if (amount !== null) {
    renderTransactionResults(text, amount);
    return;
  }
  if (query.length < 2) {
    billLinkResults.replaceChildren();
    return;
  }
  const q = normalize(query);
  const matches = options
    .filter((o) => normalize(o.name).includes(q) || normalize(o.original).includes(q))
    .slice(0, MAX_LINK_RESULTS);
  const byName =
    query.length >= 3
      ? [
        linkResult(`Vincular pelo nome "${query}"`, NAME_LINK_DETAIL, () =>
          pickLink({ key: null, matchName: query, label: query }, NAME_LINK_DETAIL),
        ),
      ]
      : [];
  billLinkResults.replaceChildren(
    ...matches.map((o) => {
      const detail = `último: ${money(o.lastAmount)} em ${date(o.lastDate)}`;
      return linkResult(o.name, detail, () => {
        pickLink({ key: o.key, matchName: null, label: o.name }, o.name === o.original ? detail : `${o.original} · ${detail}`);
        if (!billAmount.value) billAmount.value = o.lastAmount.toFixed(2);
        if (!billDay.value) billDay.value = String(Number(o.lastDate.slice(8, 10)));
      });
    }),
    ...byName,
  );
}

const NAME_LINK_DETAIL = "vale qualquer saída com esse nome";
/** Na busca com valor, mostra transações até 10% acima ou abaixo do valor digitado. */
const SEARCH_AMOUNT_TOLERANCE = 0.1;

/** Converte "3000", "3.000", "3.000,50", "R$3000" em número. */
function parseAmountToken(token: string): number | null {
  const raw = token.replace(/^r\$/i, "");
  if (!/^\d[\d.,]*$/.test(raw)) return null;
  let normalized = raw;
  if (raw.includes(",")) normalized = raw.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(raw)) normalized = raw.replace(/\./g, "");
  const value = Number(normalized);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** "Julio 3000" → texto "Julio" e valor 3000. */
function parseLinkQuery(query: string): { text: string; amount: number | null } {
  const words: string[] = [];
  let foundAmount: number | null = null;
  for (const token of query.split(/\s+/).filter(Boolean)) {
    if (foundAmount === null) {
      const parsed = parseAmountToken(token);
      if (parsed !== null) {
        foundAmount = parsed;
        continue;
      }
    }
    words.push(token);
  }
  return { text: words.join(" "), amount: foundAmount };
}

function renderTransactionResults(text: string, amount: number): void {
  const q = normalize(text);
  const matches = (state.recurring?.transactions ?? [])
    .filter((t) => Math.abs(t.amount - amount) <= amount * SEARCH_AMOUNT_TOLERANCE)
    .filter((t) => !q || normalize(t.name).includes(q) || normalize(t.original).includes(q))
    .sort((a, b) => Math.abs(a.amount - amount) - Math.abs(b.amount - amount) || b.date.localeCompare(a.date))
    .slice(0, MAX_LINK_RESULTS);
  if (!matches.length) {
    const who = text ? ` para "${text}"` : "";
    billLinkResults.replaceChildren(
      h("li", { className: "muted text-sm", text: `Nenhuma saída de cerca de ${money(amount)}${who} nos últimos meses.` }),
    );
    return;
  }
  billLinkResults.replaceChildren(
    ...matches.map((t) => {
      const detail = [date(t.date), t.name === t.original ? "" : t.original].filter(Boolean).join(" · ");
      return linkResult(`${t.name} — ${money(t.amount)}`, detail, () => {
        pickLink({ key: t.key, matchName: null, label: t.name }, `pagamento de ${money(t.amount)} em ${date(t.date)}`);
        pickedTransaction = { id: t.id, month: t.date.slice(0, 7) };
        billAmount.value = t.amount.toFixed(2);
        billDay.value = String(Number(t.date.slice(8, 10)));
        if (!billLabel.value.trim()) billLabel.value = t.name;
      });
    }),
  );
}

function openBillDialog(item: RecurringItem | null): void {
  editingBillId = item?.id ?? null;
  createForm.reset();
  createError.textContent = "";
  pickedLink = null;
  pickedTransaction = null;
  billLinkPicked.hidden = true;
  billLink.hidden = false;
  billLinkResults.replaceChildren();
  el("create-recurring-title").textContent = item ? "Editar conta recorrente" : "Adicionar conta recorrente";
  el("create-recurring-submit").textContent = item ? "Salvar" : "Adicionar";
  if (item) {
    billLabel.value = item.name;
    billAmount.value = expectedOf(item).toFixed(2);
    billDay.value = item.day === null ? "" : String(item.day);
    if (item.key) pickLink({ key: item.key, matchName: null, label: item.original || item.key }, "pagador/recebedor vinculado");
    else if (item.matchName) pickLink({ key: null, matchName: item.original || item.matchName, label: item.original || item.matchName }, NAME_LINK_DETAIL);
  }
  createDialog.showModal();
  billLabel.focus();
  if (!state.recurring) void loadRecurring();
}

billLink.addEventListener("input", renderLinkResults);
el("bill-link-clear", HTMLButtonElement).addEventListener("click", clearLink);
el("cancel-create-recurring-btn", HTMLButtonElement).addEventListener("click", () => createDialog.close());

el("add-recurring-btn", HTMLButtonElement).addEventListener("click", () => openBillDialog(null));

createForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const expected = billAmount.valueAsNumber;
  const day = billDay.valueAsNumber;
  if (!Number.isFinite(expected) || expected <= 0) {
    createError.textContent = "Informe um valor maior que zero.";
    return;
  }
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    createError.textContent = "O dia do vencimento deve ser entre 1 e 31.";
    return;
  }
  const fields = {
    label: billLabel.value.trim(),
    expected,
    day,
    key: pickedLink?.key ?? null,
    matchName: pickedLink?.matchName ?? null,
    linkLabel: pickedLink?.label ?? null,
    paidTransaction: pickedTransaction,
  };
  try {
    if (editingBillId) await api("POST /api/recurring/edit", { ...fields, id: editingBillId });
    else await api("POST /api/recurring/create", fields);
    createDialog.close();
    await loadPeriod();
  } catch (err) {
    createError.textContent = errorMessage(err);
  }
});

// Menu de tags (botão direito nas movimentações)

const tagMenu = el("tag-menu");
const tagMenuTags = el("tag-menu-tags");
const tagMenuRemove = el("tag-menu-remove", HTMLButtonElement);
const tagMenuRemoveSep = el("tag-menu-remove-sep");
/** `key` vazio = conta manual sem vínculo (só "Editar conta" aparece). */
interface MenuTarget extends DragPayload {
  original: string;
  alias: string | null;
  billId: string | null;
  yieldId: string | null;
  yieldAmount: number | null;
  yieldDate: string | null;
  manualAdjust: boolean;
  /** Entrada que pode ser marcada (ou desmarcada) como reembolso. */
  txn?: { id: string; refund: boolean } | null;
}

let menuTarget: MenuTarget | null = null;

function closeTagMenu(): void {
  tagMenu.hidden = true;
  menuTarget = null;
}

function openTagMenu(target: MenuTarget, x: number, y: number): void {
  menuTarget = target;
  const isYield = Boolean(target.yieldId);
  const isManual = target.manualAdjust;
  const current =
    !isYield && !isManual && target.key ? state.tags.rules.find((r) => r.key === target.key)?.tagId ?? null : null;
  el("tag-menu-title").textContent = target.label;
  el("tag-menu-recurring").textContent = isRecurring(target.key) ? "Remover de recorrentes" : "Marcar como recorrente";

  tagMenuTags.replaceChildren(
    ...state.tags.tags.map((tag) => {
      const item = h("button", { className: "menu-item" }, tagBadge(tag));
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.dataset.menuTag = tag.id;
      if (tag.id === current) item.append(h("span", { className: "check", text: "✓" }));
      return item;
    }),
  );
  if (!state.tags.tags.length) {
    tagMenuTags.replaceChildren(h("p", { className: "muted text-sm menu-header", text: "Nenhuma tag ainda." }));
  }
  tagMenuRemove.hidden = current === null;
  tagMenuRemoveSep.hidden = current === null;
  el("tag-menu-manual").hidden = !isManual;
  el("tag-menu-yield").hidden = !isYield;
  el("tag-menu-refund").hidden = !target.txn;
  el("tag-menu-refund-btn").textContent = target.txn?.refund ? "Não é reembolso (contar como entrada)" : "Marcar como reembolso";
  el("tag-menu-bill").hidden = target.billId === null || isYield || isManual;
  el("tag-menu-bill-sep").hidden = !target.key || isYield || isManual;
  el("tag-menu-counterparty").hidden = !target.key || isYield || isManual;

  tagMenu.hidden = false;
  const { width, height } = tagMenu.getBoundingClientRect();
  tagMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
  tagMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
  const first = [...tagMenu.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.offsetParent !== null);
  first?.focus();
}

document.addEventListener("contextmenu", (e) => {
  const node =
    e.target instanceof Element
      ? e.target.closest<HTMLElement>("[data-manual-adjust], [data-yield-id], [data-key], [data-bill-id]")
      : null;
  if (!node) return closeTagMenu();

  if (node.dataset.manualAdjust === "1") {
    e.preventDefault();
    openTagMenu(
      {
        key: "",
        label: "Ajuste manual",
        original: "Ajuste manual",
        alias: null,
        billId: null,
        yieldId: null,
        yieldAmount: null,
        yieldDate: null,
        manualAdjust: true,
      },
      e.clientX,
      e.clientY,
    );
    return;
  }

  const yieldId = node.dataset.yieldId;
  if (yieldId) {
    e.preventDefault();
    const rawAmount = node.dataset.yieldAmount ?? "";
    const amount = rawAmount ? Number(rawAmount) : NaN;
    openTagMenu(
      {
        key: "",
        label: node.dataset.label || "Rendimento previsto",
        original: node.dataset.label || "Rendimento previsto",
        alias: null,
        billId: null,
        yieldId,
        yieldAmount: Number.isFinite(amount) && amount > 0 ? amount : null,
        yieldDate: node.dataset.yieldDate || null,
        manualAdjust: false,
      },
      e.clientX,
      e.clientY,
    );
    return;
  }

  const key = node.dataset.key ?? "";
  const label = node.dataset.label;
  const billId = node.dataset.billId ?? null;
  if (!label || (!key && !billId)) return closeTagMenu();
  e.preventDefault();
  openTagMenu(
    {
      ...menuTargetFor(key, label),
      billId,
      yieldId: null,
      yieldAmount: null,
      yieldDate: null,
      manualAdjust: false,
      txn: node.dataset.txnId ? { id: node.dataset.txnId, refund: node.dataset.txnRefund === "1" } : null,
    },
    e.clientX,
    e.clientY,
  );
});

/** Nome original e descrição atual do pagador/recebedor, para qualquer lista da página. */
function menuTargetFor(key: string, label: string): MenuTarget {
  const alias = key ? state.tags.aliases.find((a) => a.key === key) : undefined;
  const original =
    (key && state.period?.transactions.find((t) => t.counterpartyKey === key)?.counterpartyName) ||
    (key && state.recurring?.items.find((i) => i.key === key)?.original) ||
    (key && state.recurring?.suggestions.find((s) => s.key === key)?.original) ||
    alias?.label ||
    label;
  return {
    key,
    label,
    original,
    alias: alias?.alias ?? null,
    billId: null,
    yieldId: null,
    yieldAmount: null,
    yieldDate: null,
    manualAdjust: false,
  };
}

tagMenu.addEventListener("click", (e) => {
  const item = e.target instanceof Element ? e.target.closest<HTMLElement>(".menu-item") : null;
  const target = menuTarget;
  if (!item || !target) return;
  closeTagMenu();
  if (item.dataset.menuAction === "edit-manual") {
    openWealthManualDialog();
    return;
  }
  if (item.dataset.menuAction === "clear-manual") {
    void (async () => {
      appError.textContent = "";
      try {
        const wealth = await api("POST /api/wealth/manual", { amount: null, note: null, date: null });
        state.wealth = wealth;
        renderWealth(wealth);
      } catch (err) {
        appError.textContent = errorMessage(err);
      }
    })();
    return;
  }
  if (item.dataset.menuAction === "edit-yield" && target.yieldId) {
    openYieldDialog(target);
    return;
  }
  if (item.dataset.menuAction === "reset-yield" && target.yieldId) {
    void resetYieldOverride(target.yieldId);
    return;
  }
  if (item.dataset.menuAction === "edit-bill") {
    const bill = state.recurring?.items.find((i) => i.id === target.billId);
    if (bill) openBillDialog(bill);
    return;
  }
  if (item.dataset.menuAction === "toggle-refund" && target.txn) {
    const { id, refund } = target.txn;
    void (async () => {
      appError.textContent = "";
      try {
        await api("POST /api/refunds/set", { id, refund: !refund });
        await loadPeriod();
      } catch (err) {
        appError.textContent = errorMessage(err);
      }
    })();
    return;
  }
  if (!target.key) return;
  if (item.dataset.menuAction === "new") return openTagDialog(null, target);
  if (item.dataset.menuAction === "alias") return openAliasDialog(target);
  if (item.dataset.menuAction === "recurring") {
    return void setRecurring(target.key, target.original, !isRecurring(target.key));
  }
  if (item.dataset.menuAction === "remove") return void assignTag(target, null);
  const tagId = item.dataset.menuTag;
  if (!tagId) return;
  const current = state.tags.rules.find((r) => r.key === target.key)?.tagId ?? null;
  void assignTag(target, tagId === current ? null : tagId);
});

// Diálogo de rendimento previsto

const yieldDialog = el("yield-dialog", HTMLDialogElement);
const yieldForm = el("yield-form", HTMLFormElement);
const yieldAmountInput = el("yield-amount", HTMLInputElement);
const yieldDateInput = el("yield-date", HTMLInputElement);
const yieldError = el("yield-error");
let yieldEditId: string | null = null;

function openYieldDialog(target: MenuTarget): void {
  if (!target.yieldId) return;
  yieldEditId = target.yieldId;
  yieldError.textContent = "";
  el("yield-dialog-title").textContent = `Rendimento · ${target.label}`;
  yieldAmountInput.value = target.yieldAmount !== null ? String(target.yieldAmount) : "";
  yieldDateInput.value = target.yieldDate || toIsoDate(new Date());
  yieldDialog.showModal();
  yieldAmountInput.focus();
}

async function resetYieldOverride(id: string): Promise<void> {
  appError.textContent = "";
  try {
    await api("POST /api/yield/override", { id, amount: null, date: null });
    await reloadAfterYieldEdit();
  } catch (err) {
    appError.textContent = errorMessage(err);
  }
}

async function reloadAfterYieldEdit(): Promise<void> {
  if (state.tab === "wealth") await loadWealth();
  else await loadPeriod();
  if (state.wealth && state.tab === "wealth") renderWealth(state.wealth);
}

el("cancel-yield-btn").addEventListener("click", () => yieldDialog.close());

yieldForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!yieldEditId) return;
  yieldError.textContent = "";
  const amount = Number(yieldAmountInput.value.replace(",", "."));
  const dateValue = yieldDateInput.value;
  if (!Number.isFinite(amount) || amount <= 0) {
    yieldError.textContent = "Informe um valor maior que zero.";
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
    yieldError.textContent = "Informe a data de entrada.";
    return;
  }
  try {
    await api("POST /api/yield/override", { id: yieldEditId, amount, date: dateValue });
    yieldDialog.close();
    await reloadAfterYieldEdit();
  } catch (err) {
    yieldError.textContent = errorMessage(err);
  }
});

// Descrição (apelido do pagador/recebedor)

const aliasDialog = el("alias-dialog", HTMLDialogElement);
const aliasInput = el("alias-input", HTMLInputElement);
const aliasError = el("alias-error");
const removeAliasBtn = el("remove-alias-btn", HTMLButtonElement);
let aliasTarget: MenuTarget | null = null;

function openAliasDialog(target: MenuTarget): void {
  aliasTarget = target;
  el("alias-original").textContent = target.original;
  aliasInput.value = target.alias ?? "";
  aliasError.textContent = "";
  removeAliasBtn.hidden = target.alias === null;
  aliasDialog.showModal();
  aliasInput.focus();
}

async function saveAlias(alias: string | null): Promise<void> {
  if (!aliasTarget) return;
  try {
    await api("POST /api/aliases/set", { key: aliasTarget.key, label: aliasTarget.original, alias });
    aliasDialog.close();
    await loadPeriod();
  } catch (err) {
    aliasError.textContent = errorMessage(err);
  }
}

el("alias-form", HTMLFormElement).addEventListener("submit", (e) => {
  e.preventDefault();
  void saveAlias(aliasInput.value.trim() || null);
});
removeAliasBtn.addEventListener("click", () => void saveAlias(null));
el("cancel-alias-btn", HTMLButtonElement).addEventListener("click", () => aliasDialog.close());

document.addEventListener("mousedown", (e) => {
  if (!tagMenu.hidden && !(e.target instanceof Node && tagMenu.contains(e.target))) closeTagMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !tagMenu.hidden) closeTagMenu();
});
window.addEventListener("resize", closeTagMenu);
window.addEventListener(
  "scroll",
  (e) => {
    if (!tagMenu.hidden && !(e.target instanceof Node && tagMenu.contains(e.target))) closeTagMenu();
  },
  true,
);

// Configurações

const settingsError = el("settings-error");
const disconnectBtn = el("disconnect-btn", HTMLButtonElement);

async function openSettings(): Promise<void> {
  settingsError.textContent = "";
  const { clientId, itemId } = await api("GET /api/settings");
  el("settings-client").textContent = clientId ?? "não configurada";
  el("settings-item").textContent = itemId ?? "nenhuma";
  disconnectBtn.disabled = !itemId;
  el("reconnect-btn", HTMLButtonElement).disabled = !clientId;
  show("step-settings", "Configurações");
}

async function settingsAction(action: "POST /api/disconnect" | "POST /api/reset", confirmation: string): Promise<void> {
  if (!confirm(confirmation)) return;
  try {
    await api(action, {});
    await route();
  } catch (err) {
    settingsError.textContent = errorMessage(err);
  }
}

settingsBtn.addEventListener("click", () => openSettings());
el("close-settings-btn").addEventListener("click", () => route());
el("reconnect-btn").addEventListener("click", () => openConnect(settingsError));
el("change-credentials-btn").addEventListener("click", () => {
  cancelCredentialsBtn.hidden = false;
  show("step-credentials", "Trocar credenciais");
});
cancelCredentialsBtn.addEventListener("click", () => openSettings());
disconnectBtn.addEventListener("click", () =>
  settingsAction("POST /api/disconnect", "Desconectar a conta bancária? Você poderá conectar de novo depois."),
);
el("reset-btn").addEventListener("click", () =>
  settingsAction("POST /api/reset", "Remover as credenciais da Pluggy e a conta bancária conectada?"),
);

// Início

renderChips();
selectTab(state.tab);
route().catch((err: unknown) => {
  subtitle.textContent = `Erro: ${errorMessage(err)}`;
});
