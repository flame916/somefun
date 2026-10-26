const MIGRATION_ID = "R6-MONEY-MIGRATION-01";
// Persisted R5 economy fields with runtime consumers. Unknown similarly named
// metadata (for example rewardWealth) is intentionally preserved verbatim.
const MONEY_KEYS = new Set(["wealth", "fare", "unitPrice", "unitCost", "totalWealth", "buyerCreditWealth", "initialCreditWealth", "wealthAfter", "proceeds", "rentPaid", "realizedNet", "netRealizedWealth"]);
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

function visitMoney(value, path, receipt) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visitMoney(entry, `${path}[${index}]`, receipt));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    const isMarketReservationAmount = key === "amount" && path.includes("buyerCreditReservations");
    const isLeaseAmount = key === "amount" && (path.includes("rentalLedger") || path.includes("furnaceRentalReceipts"));
    const isResourceAmount = key === "amount" && value.resource === "wealth";
    if ((MONEY_KEYS.has(key) || isMarketReservationAmount || isLeaseAmount || isResourceAmount) && typeof item === "number") {
      if (!Number.isSafeInteger(item) || !Number.isSafeInteger(item * 100)) throw new Error(`r6_money_migration_non_integer:${nextPath}`);
      receipt.values.push({ path: nextPath, before: item, after: item * 100 });
      value[key] = item * 100;
      continue;
    }
    if (key === "currency" && item === "wealth") value[key] = "cashWen";
    visitMoney(item, nextPath, receipt);
  }
}

export function migrateR6MoneyDto(input) {
  if (!input || typeof input !== "object" || !input.runtimeState) throw new Error("r6_money_migration_dto_invalid");
  const dto = clone(input);
  const state = dto.runtimeState;
  if (state.moneySchemaVersion === 2 && dto.moneyMigrationReceipt?.id === MIGRATION_ID) return { dto, migrated: false };
  if (dto.namespace !== "r5-qingxu-v1" || state.character?.wealth == null) throw new Error("r6_money_migration_source_unsupported");
  const receipt = { id: MIGRATION_ID, fromSchemaVersion: 1, toSchemaVersion: 2, values: [] };
  const oldCash = Number(state.character.wealth);
  if (!Number.isSafeInteger(oldCash) || !Number.isSafeInteger(oldCash * 100)) throw new Error("r6_money_migration_balance_invalid");
  visitMoney(state, "runtimeState", receipt);
  state.character.cashWen = oldCash * 100;
  delete state.character.wealth;
  state.moneySchemaVersion = 2;
  dto.namespace = "r6-world-life-candidate-v2";
  dto.moneySchemaVersion = 2;
  dto.moneyMigrationReceipt = receipt;
  return { dto, migrated: true };
}
