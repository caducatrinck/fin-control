import "./quiet.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "fin-control-api-"));
process.env.FIN_CONTROL_ROOT = root;
process.env.PORT = "0";

const { startServer, stopServer } = await import("../src/server.ts");
const started = await startServer({ openBrowser: false, port: 0 });

after(async () => {
  await stopServer();
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

describe("API sem credenciais / sem conta", () => {
  it("GET /api/status mostra não configurado e não conectado", async () => {
    const { status, json } = await api("GET", "/api/status");
    assert.equal(status, 200);
    assert.deepEqual(json, { configured: false, connected: false });
  });

  it("GET /api/settings sem clientId/itemId", async () => {
    const { status, json } = await api("GET", "/api/settings");
    assert.equal(status, 200);
    assert.deepEqual(json, { clientId: null, itemId: null });
  });

  it("POST /api/period exige conta conectada", async () => {
    const { status, json } = await api("POST", "/api/period", {
      from: "2025-11-01",
      to: "2025-11-30",
    });
    assert.equal(status, 409);
    assert.deepEqual(json, { error: "Nenhuma conta bancária conectada." });
  });

  it("POST /api/connect-token exige credenciais", async () => {
    const { status, json } = await api("POST", "/api/connect-token", {});
    assert.equal(status, 409);
    assert.deepEqual(json, { error: "Credenciais da Pluggy não configuradas." });
  });

  it("POST /api/wealth exige conta conectada", async () => {
    const { status, json } = await api("POST", "/api/wealth", {});
    assert.equal(status, 409);
    assert.deepEqual(json, { error: "Nenhuma conta bancária conectada." });
  });

  it("POST /api/credentials rejeita body inválido", async () => {
    const badUuid = await api("POST", "/api/credentials", {
      clientId: "nao-e-uuid",
      clientSecret: "secret",
    });
    assert.equal(badUuid.status, 400);

    const missingSecret = await api("POST", "/api/credentials", {
      clientId: "11111111-1111-1111-1111-111111111111",
      clientSecret: "",
    });
    assert.equal(missingSecret.status, 400);
  });

  it("GET /api/tags funciona offline (store local)", async () => {
    const { status, json } = await api("GET", "/api/tags");
    assert.equal(status, 200);
    assert.ok(json && typeof json === "object");
    const data = json as { tags: unknown[] };
    assert.ok(Array.isArray(data.tags));
  });

  it("POST /api/item valida UUID mesmo sem Pluggy", async () => {
    const { status, json } = await api("POST", "/api/item", { itemId: "x" });
    assert.equal(status, 400);
    assert.deepEqual(json, { error: "itemId inválido." });
  });
});

describe("API com itemId no .env mas sem credenciais Pluggy", () => {
  it("continua sem configured até haver client id/secret válidos em memória", async () => {
    // Só gravar itemId no disco não cria o client (precisa de credentials).
    await writeFile(
      path.join(root, ".env"),
      "PLUGGY_ITEM_ID=11111111-1111-1111-1111-111111111111\n",
      "utf8",
    );
    const { status, json } = await api("GET", "/api/status");
    assert.equal(status, 200);
    // env em memória ainda é o do boot (vazio) até updateEnv/credentials.
    assert.deepEqual(json, { configured: false, connected: false });
  });
});

describe("proteção contra DNS rebinding", () => {
  it("recusa Host que não seja local", async () => {
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: started.port, path: "/api/settings", headers: { Host: `evil.example:${started.port}` } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);
  });
});
