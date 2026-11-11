import type { Account, Investment, Transaction } from "../src/pluggy/types.ts";
import type { PeriodTransaction, TagFilter } from "../src/shared/api.ts";

export function tx(partial: Partial<Transaction> & Pick<Transaction, "id" | "type" | "amount" | "description">): Transaction {
  return {
    accountId: "acc-bank",
    date: "2025-11-01T12:00:00.000Z",
    currencyCode: "BRL",
    category: null,
    ...partial,
  };
}

export function account(partial: Partial<Account> & Pick<Account, "id" | "type" | "name">): Account {
  return {
    itemId: "item-1",
    subtype: partial.type === "CREDIT" ? "CREDIT_CARD" : "CHECKING_ACCOUNT",
    number: "12345-6",
    balance: 0,
    currencyCode: "BRL",
    ...partial,
  };
}

export function periodTx(
  partial: Partial<PeriodTransaction> & Pick<PeriodTransaction, "id" | "amount" | "direction">,
): PeriodTransaction {
  return {
    accountId: "acc-bank",
    accountName: "Conta",
    date: "2025-11-01T12:00:00.000Z",
    description: "x",
    movement: partial.direction === "in" ? "received" : "paid",
    category: null,
    counterpartyKey: `key-${partial.id}`,
    counterpartyName: "Fulano",
    alias: null,
    displayName: "Pago - Fulano",
    tagId: null,
    internal: false,
    refund: false,
    refundLink: null,
    cancelled: false,
    ...partial,
  };
}

export function investment(partial: Partial<Investment> & Pick<Investment, "id" | "name" | "balance">): Investment {
  return {
    itemId: "item-1",
    type: "FIXED_INCOME",
    currencyCode: "BRL",
    status: "ACTIVE",
    rate: 100,
    rateType: "CDI",
    ...partial,
  };
}

export function tagFilter(partial: Partial<TagFilter> & Pick<TagFilter, "id" | "tagId">): TagFilter {
  return {
    amount: null,
    contains: null,
    ...partial,
  };
}
