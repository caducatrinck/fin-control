import type {
  Account,
  AuthResponse,
  Bill,
  Connector,
  ConnectTokenResponse,
  CursorPageResponse,
  DateRange,
  Investment,
  Item,
  PageResponse,
  Transaction,
} from "./types.ts";

const BASE_URL = "https://api.pluggy.ai";

/**
 * Compra internacional vem com `amount` na moeda da compra (ex.: US$ 7,50) e o valor cobrado na conta em
 * `amountInAccountCurrency` (R$ 39,03). O app inteiro soma `amount`, então trocamos aqui e guardamos o original.
 */
export function toAccountCurrency(t: Transaction): Transaction {
  const converted = t.amountInAccountCurrency;
  if (typeof converted !== "number" || !Number.isFinite(converted)) return t;
  const sign = t.amount < 0 || (t.amount === 0 && converted < 0) ? -1 : 1;
  return {
    ...t,
    amount: sign * Math.abs(converted),
    originalAmount: t.amount,
    originalCurrencyCode: t.currencyCode,
  };
}

function isApiKeyError(status: number, data: unknown): boolean {
  if (status !== 401 && status !== 403) return false;
  if (!data || typeof data !== "object") return true;
  const code = "codeDescription" in data ? data.codeDescription : undefined;
  return code === undefined || code === "API_KEY_MISSING_OR_INVALID";
}

export interface PluggyCredentials {
  clientId: string;
  clientSecret: string;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  auth?: boolean;
}

export class PluggyApiError extends Error {
  readonly status: number;
  readonly data: unknown;

  constructor(message: string, status: number, data: unknown) {
    super(message);
    this.name = "PluggyApiError";
    this.status = status;
    this.data = data;
  }
}

export class PluggyClient {
  readonly #clientId: string;
  readonly #clientSecret: string;
  #apiKey: string | null = null;

  constructor({ clientId, clientSecret }: PluggyCredentials) {
    if (!clientId || !clientSecret) {
      throw new Error("PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET são obrigatórios (veja .env.example).");
    }
    this.#clientId = clientId;
    this.#clientSecret = clientSecret;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): PluggyClient {
    return new PluggyClient({
      clientId: env.PLUGGY_CLIENT_ID ?? "",
      clientSecret: env.PLUGGY_CLIENT_SECRET ?? "",
    });
  }

  async #request<T>(
    path: string,
    { method = "GET", body, auth = true }: RequestOptions = {},
    retried = false,
  ): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (auth) headers["X-API-KEY"] = this.#apiKey ?? (await this.authenticate());

    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`${BASE_URL}${path}`, init);
    const data: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (auth && !retried && isApiKeyError(res.status, data)) {
        this.#apiKey = null;
        return this.#request(path, { method, body, auth }, true);
      }
      throw new PluggyApiError(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`, res.status, data);
    }
    return data as T;
  }

  async authenticate(): Promise<string> {
    const { apiKey } = await this.#request<AuthResponse>("/auth", {
      method: "POST",
      body: { clientId: this.#clientId, clientSecret: this.#clientSecret },
      auth: false,
    });
    this.#apiKey = apiKey;
    return apiKey;
  }

  async createConnectToken({ itemId }: { itemId?: string } = {}): Promise<string> {
    const { accessToken } = await this.#request<ConnectTokenResponse>("/connect_token", {
      method: "POST",
      body: itemId ? { itemId } : {},
    });
    return accessToken;
  }

  searchConnectors(name: string): Promise<PageResponse<Connector>> {
    return this.#request(`/connectors?name=${encodeURIComponent(name)}`);
  }

  getItem(itemId: string): Promise<Item> {
    return this.#request(`/items/${encodeURIComponent(itemId)}`);
  }

  /** Dispara sync com o banco (Open Finance / connector). Body vazio reusa as credenciais guardadas. */
  updateItem(itemId: string): Promise<Item> {
    return this.#request(`/items/${encodeURIComponent(itemId)}`, { method: "PATCH", body: {} });
  }

  listAccounts(itemId: string): Promise<PageResponse<Account>> {
    return this.#request(`/accounts?itemId=${encodeURIComponent(itemId)}`);
  }

  async listBills(accountId: string): Promise<Bill[]> {
    const data: PageResponse<Bill> = await this.#request(`/bills?accountId=${encodeURIComponent(accountId)}`);
    return data.results;
  }

  async listInvestments(itemId: string): Promise<Investment[]> {
    const all: Investment[] = [];
    for (let page = 1; ; page++) {
      const params = new URLSearchParams({ itemId, page: String(page), pageSize: "500" });
      const data: PageResponse<Investment> = await this.#request(`/investments?${params}`);
      all.push(...data.results);
      if (page >= data.totalPages) return all;
    }
  }

  async listTransactions(accountId: string, { from, to }: DateRange = {}): Promise<Transaction[]> {
    const params = new URLSearchParams({ accountId });
    if (from) params.set("dateFrom", from);
    if (to) params.set("dateTo", to);

    const all: Transaction[] = [];
    const seen = new Set<string>();
    let query: string | null = `?${params}`;
    while (query && !seen.has(query)) {
      seen.add(query);
      const page: CursorPageResponse<Transaction> = await this.#request(`/v2/transactions${query}`);
      all.push(...page.results.map(toAccountCurrency));
      query = page.next?.startsWith("http") ? new URL(page.next).search : page.next;
    }
    return all;
  }
}
