import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  VALID_CLIENT_ID,
  VALID_CLIENT_SECRET,
  installPluggyFetchMock,
} from "./mock-pluggy.ts";

const root = await mkdtemp(path.join(os.tmpdir(), "fin-control-login-"));
process.env.FIN_CONTROL_ROOT = root;
process.env.PORT = "0";

const restoreFetch = installPluggyFetchMock();
const { startServer, stopServer } = await import("../src/server.ts");
const started = await startServer({ openBrowser: false, port: 0 });

before(async () => {
  // Garante estado limpo no início da suíte.
  await api("POST", "/api/reset", {});
});

after(async () => {
  await stopServer();
  restoreFetch();
  await rm(root, { recursive: true, force: true });
});

async function api(method: string, pathname: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${started.url}${pathname}`, init);
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

describe("login Pluggy via /api/credentials", () => {
  it("recusa credenciais inválidas com 401 e não configura", async () => {
    const { status, json } = await api("POST", "/api/credentials", {
      clientId: "11111111-1111-1111-1111-111111111111",
      clientSecret: "wrong-secret",
    });
    assert.equal(status, 401);
    assert.deepEqual(json, { error: "A Pluggy recusou essas credenciais. Confira os valores no Dashboard." });

    const st = await api("GET", "/api/status");
    assert.deepEqual(st.json, { configured: false, connected: false });
  });

  it("aceita credenciais válidas, grava .env e marca configured", async () => {
    const { status, json } = await api("POST", "/api/credentials", {
      clientId: VALID_CLIENT_ID,
      clientSecret: VALID_CLIENT_SECRET,
    });
    assert.equal(status, 200);
    assert.deepEqual(json, { ok: true });

    const st = await api("GET", "/api/status");
    assert.deepEqual(st.json, { configured: true, connected: false });

    const settings = await api("GET", "/api/settings");
    assert.equal(settings.status, 200);
    const body = settings.json as { clientId: string | null; itemId: string | null };
    assert.equal(body.itemId, null);
    assert.ok(body.clientId?.startsWith("aaaaaaaa-"));
    assert.ok(body.clientId?.includes("••••"));

    const envFile = await readFile(path.join(root, ".env"), "utf8");
    assert.match(envFile, new RegExp(`PLUGGY_CLIENT_ID=${VALID_CLIENT_ID}`));
    assert.match(envFile, new RegExp(`PLUGGY_CLIENT_SECRET=${VALID_CLIENT_SECRET}`));
  });

  it("com credenciais, connect-token funciona; period ainda exige item", async () => {
    const token = await api("POST", "/api/connect-token", {});
    assert.equal(token.status, 200);
    assert.deepEqual(token.json, { accessToken: "test-connect-token" });

    const period = await api("POST", "/api/period", { from: "2025-11-01", to: "2025-11-30" });
    assert.equal(period.status, 409);
    assert.deepEqual(period.json, { error: "Nenhuma conta bancária conectada." });
  });

  it("salvar itemId marca connected; reset limpa tudo", async () => {
    const itemId = "99999999-9999-9999-9999-999999999999";
    const item = await api("POST", "/api/item", { itemId });
    assert.equal(item.status, 200);

    const connected = await api("GET", "/api/status");
    assert.deepEqual(connected.json, { configured: true, connected: true });

    const settings = await api("GET", "/api/settings");
    assert.equal((settings.json as { itemId: string | null }).itemId, itemId);

    const reset = await api("POST", "/api/reset", {});
    assert.equal(reset.status, 200);

    const after = await api("GET", "/api/status");
    assert.deepEqual(after.json, { configured: false, connected: false });

    const envFile = await readFile(path.join(root, ".env"), "utf8");
    assert.match(envFile, /PLUGGY_CLIENT_ID=$/m);
    assert.match(envFile, /PLUGGY_CLIENT_SECRET=$/m);
    assert.match(envFile, /PLUGGY_ITEM_ID=$/m);
  });
});
