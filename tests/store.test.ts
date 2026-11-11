import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "fin-control-store-"));
process.env.FIN_CONTROL_ROOT = root;

const store = await import("../src/store.ts");

describe("store tags / refunds / aliases", () => {
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  before(async () => {
    // garante estado limpo mesmo se o arquivo já existir
    const data = await store.getTags();
    assert.ok(Array.isArray(data.tags));
  });

  it("cria, atualiza e remove tag", async () => {
    const tag = await store.createTag("Moradia", "blue");
    assert.equal(tag.name, "Moradia");
    assert.equal(tag.color, "blue");

    const updated = await store.updateTag(tag.id, "Casa", "teal");
    assert.equal(updated?.name, "Casa");
    assert.equal(updated?.color, "teal");

    assert.equal(await store.deleteTag(tag.id), true);
    assert.equal(await store.deleteTag(tag.id), false);
  });

  it("grava alias, regra, refund override e recorrente", async () => {
    const tag = await store.createTag("Assinaturas", "purple");
    assert.equal(await store.setRule("doc:1", "Spotify", tag.id), true);
    await store.setAlias("doc:1", "Spotify", "Música");
    await store.setRefund("tx-1", true);
    await store.setRecurring("doc:1", "Spotify", true);

    const data = await store.getTags();
    assert.ok(data.aliases.some((a) => a.key === "doc:1" && a.alias === "Música"));
    assert.ok(data.rules.some((r) => r.key === "doc:1" && r.tagId === tag.id));
    assert.ok(data.refundOverrides.some((r) => r.id === "tx-1" && r.refund === true));
    assert.ok(data.recurring.some((r) => r.key === "doc:1" && r.label === "Spotify"));

    await store.setRefund("tx-1", null);
    await store.setAlias("doc:1", "Spotify", null);
    await store.setRule("doc:1", "Spotify", null);
    await store.setRecurring("doc:1", "Spotify", false);
    await store.deleteTag(tag.id);
  });

  it("filtro por valor/texto e remoção", async () => {
    const tag = await store.createTag("Apps", "green");
    const created = await store.upsertFilter(tag.id, 19.9, "spotify");
    assert.ok(created);
    assert.equal(created?.amount, 19.9);

    const again = await store.upsertFilter(tag.id, null, "netflix", created!.id);
    assert.equal(again?.contains, "netflix");
    assert.equal(again?.amount, null);

    assert.equal(await store.deleteFilter(created!.id), true);
    await store.deleteTag(tag.id);
  });
});
