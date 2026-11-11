import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRecurring, historyStart } from "../src/recurring.ts";
import { periodTx } from "./helpers.ts";

describe("historyStart", () => {
  it("volta HISTORY_MONTHS meses", () => {
    assert.equal(historyStart("2025-11-01"), "2025-05-01");
  });
});

describe("buildRecurring", () => {
  it("sugere padrão mensal estável e lista contas marcadas", () => {
    const key = "doc:12345678000199";
    const history = ["2025-05", "2025-06", "2025-07", "2025-08", "2025-09", "2025-10"].flatMap((month, i) => [
      periodTx({
        id: `h${i}`,
        amount: 100,
        direction: "out",
        date: `${month}-10T12:00:00.000Z`,
        counterpartyKey: key,
        counterpartyName: "Streaming",
        alias: null,
      }),
    ]);
    const current = [
      periodTx({
        id: "now",
        amount: 100,
        direction: "out",
        date: "2025-11-10T12:00:00.000Z",
        counterpartyKey: key,
        counterpartyName: "Streaming",
      }),
    ];

    const suggested = buildRecurring([...history, ...current], { from: "2025-11-01", to: "2025-11-30" }, [], []);
    assert.ok(suggested.suggestions.some((s) => s.key === key));
    assert.ok((suggested.suggestions.find((s) => s.key === key)?.months ?? 0) >= 3);

    const marked = buildRecurring(
      [...history, ...current],
      { from: "2025-11-01", to: "2025-11-30" },
      [{ id: "bill-1", key, label: "Streaming", expected: 100, day: 10, manual: false, linkLabel: null, matchName: null }],
      [],
    );
    assert.equal(marked.items.length, 1);
    assert.equal(marked.items[0]?.name, "Streaming");
    assert.equal(marked.items[0]?.paid, 100);
    assert.equal(marked.suggestions.some((s) => s.key === key), false);
  });

  it("ignora internas e canceladas", () => {
    const result = buildRecurring(
      [
        periodTx({
          id: "a",
          amount: 50,
          direction: "out",
          internal: true,
          date: "2025-11-05T12:00:00.000Z",
          counterpartyKey: "x",
        }),
        periodTx({
          id: "b",
          amount: 50,
          direction: "out",
          cancelled: true,
          date: "2025-11-05T12:00:00.000Z",
          counterpartyKey: "y",
        }),
      ],
      { from: "2025-11-01", to: "2025-11-30" },
      [],
      [],
    );
    assert.equal(result.suggestions.length, 0);
    assert.equal(result.items.length, 0);
  });
});
