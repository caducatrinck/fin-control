import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { PluggyApiError, PluggyClient } from "../src/pluggy/client.ts";
import {
  INVALID_CLIENT_ID,
  VALID_CLIENT_ID,
  VALID_CLIENT_SECRET,
  installPluggyFetchMock,
} from "./mock-pluggy.ts";

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
});

describe("PluggyClient.authenticate", () => {
  it("guarda apiKey quando as credenciais são aceitas", async () => {
    restore = installPluggyFetchMock();
    const client = new PluggyClient({ clientId: VALID_CLIENT_ID, clientSecret: VALID_CLIENT_SECRET });
    const key = await client.authenticate();
    assert.equal(key, "test-api-key");
  });

  it("falha com 401 quando a Pluggy recusa", async () => {
    restore = installPluggyFetchMock();
    const client = new PluggyClient({ clientId: INVALID_CLIENT_ID, clientSecret: "wrong" });
    await assert.rejects(() => client.authenticate(), (err: unknown) => {
      assert.ok(err instanceof PluggyApiError);
      assert.equal(err.status, 401);
      return true;
    });
  });

  it("createConnectToken usa a apiKey do login", async () => {
    restore = installPluggyFetchMock();
    const client = new PluggyClient({ clientId: VALID_CLIENT_ID, clientSecret: VALID_CLIENT_SECRET });
    await client.authenticate();
    const token = await client.createConnectToken();
    assert.equal(token, "test-connect-token");
  });
});
