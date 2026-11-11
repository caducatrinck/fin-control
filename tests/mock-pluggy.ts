/** Intercepta `https://api.pluggy.ai` sem rede. Demais URLs seguem o fetch real. */

const PLUGGY = "https://api.pluggy.ai";

export const VALID_CLIENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
export const VALID_CLIENT_SECRET = "valid-secret";
export const INVALID_CLIENT_ID = "11111111-1111-1111-1111-111111111111";

type Json = Record<string, unknown>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseBody(init?: RequestInit): Json {
  if (typeof init?.body !== "string" || !init.body) return {};
  try {
    const parsed: unknown = JSON.parse(init.body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : {};
  } catch {
    return {};
  }
}

/** Credenciais aceitas pelo mock (clientId + secret). */
export function installPluggyFetchMock(options?: {
  validId?: string;
  validSecret?: string;
}): () => void {
  const validId = options?.validId ?? VALID_CLIENT_ID;
  const validSecret = options?.validSecret ?? VALID_CLIENT_SECRET;
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (!url.startsWith(PLUGGY)) return original(input, init);

    const path = url.slice(PLUGGY.length);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = parseBody(init);

    if (path === "/auth" && method === "POST") {
      if (body.clientId === validId && body.clientSecret === validSecret) {
        return jsonResponse(200, { apiKey: "test-api-key" });
      }
      return jsonResponse(401, { codeDescription: "API_KEY_MISSING_OR_INVALID", message: "Invalid credentials" });
    }

    const apiKey = init?.headers && typeof init.headers === "object" && !Array.isArray(init.headers)
      ? (init.headers as Record<string, string>)["X-API-KEY"]
      : undefined;
    if (!apiKey) return jsonResponse(401, { codeDescription: "API_KEY_MISSING_OR_INVALID" });

    if (path === "/connect_token" && method === "POST") {
      return jsonResponse(200, { accessToken: "test-connect-token" });
    }

    return jsonResponse(404, { message: `mock não implementado: ${method} ${path}` });
  }) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
}
