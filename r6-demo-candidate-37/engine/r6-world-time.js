const MAX_TICK = 412316860415;
const TICKS_PER_DAY = 96;
const SHICHEN = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"];

export function isValidWorldTick(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TICK;
}

export function projectWorldTime(worldTick) {
  if (!isValidWorldTick(worldTick)) throw new Error("invalid_world_tick");
  const worldDay = Math.floor(worldTick / TICKS_PER_DAY);
  const tickWithinDay = worldTick % TICKS_PER_DAY;
  const shichenIndex = Math.floor(((tickWithinDay + 4) % TICKS_PER_DAY) / 8);
  return { worldDay, tickWithinDay, shichen: SHICHEN[shichenIndex], ke: ((tickWithinDay + 4) % 8) + 1,
    hour: Math.floor(tickWithinDay / 4), minute: (tickWithinDay % 4) * 15 };
}

export function formatWorldTime(worldTick, calendar = {}) {
  const { worldDay, shichen, ke } = projectWorldTime(worldTick);
  const daysPerMonth = Number(calendar.daysPerMonth || 30), monthsPerYear = Number(calendar.monthsPerYear || 12);
  const daysPerYear = daysPerMonth * monthsPerYear;
  const absoluteDay = Number(calendar.epochYear ?? 1000) * daysPerYear + worldDay - Number(calendar.epochDay || 0);
  const year = Math.floor(absoluteDay / daysPerYear);
  const month = Math.floor((absoluteDay % daysPerYear) / daysPerMonth) + 1;
  const day = absoluteDay % daysPerMonth + 1;
  return `第${year}年${month}月${day}日 ${shichen}时第${ke}刻`;
}

export function findActionDuration(contract, { eventId, choiceId, actionId, operation, context } = {}) {
  const rows = contract?.timeContract?.actionDurationTable;
  if (!Array.isArray(rows)) throw new Error("r6_time_contract_action_table_missing");
  const matches = rows.filter((row) => {
    if (eventId && choiceId && row.eventId === eventId && row.choiceId === choiceId) return true;
    if (!actionId || (row.actionId !== actionId && row.sourceActionId !== actionId)) return false;
    if (row.sourceOperation && operation !== row.sourceOperation) {
      if (operation !== undefined) return false;
      if (actionId === "r4_action_travel") return Number(context?.days) === (row.sourceOperation === "near.days" ? 7 : 30);
      if (actionId === "r4_action_practice") return row.sourceOperation === "practice.days" ? context?.mode !== "study" : context?.mode === "study";
      if (actionId === "r4_action_array") return row.sourceOperation === "deploy.days" ? context?.mode !== "study" : context?.mode === "study";
      return false;
    }
    if (actionId === "r4_action_travel" && row.sourceOperation) return Number(context?.days) === (row.sourceOperation === "near.days" ? 7 : 30);
    if (actionId === "r4_action_practice" && row.sourceOperation) return row.sourceOperation === "practice.days" ? context?.mode !== "study" : context?.mode === "study";
    if (actionId === "r4_action_array" && row.sourceOperation) return row.sourceOperation === "deploy.days" ? context?.mode !== "study" : context?.mode === "study";
    return true;
  });
  if (matches.length > 1) throw new Error(`r6_time_duration_ambiguous:${actionId || eventId}`);
  return matches.length ? matches[0].durationTicks : null;
}

function safeDay(value) { return Number.isSafeInteger(value) && value >= 0 && value <= Math.floor(MAX_TICK / TICKS_PER_DAY); }

export function migrateR6WorldTimeDto(sourceDto) {
  const dto = structuredClone(sourceDto), state = dto?.runtimeState;
  if (!state || !state.character || !state.world) throw new Error("r6_time_migration_runtime_state_missing");
  state.r6TimeMigrationReceipts ||= {};
  const receiptKey = `${state.worldId || state.world?.id}:${state.character.id}:${state.character.lifeIndex || 1}:2`;
  if (state.r6TimeSchemaVersion >= 3 && state.r6TimeMigrationReceipts[receiptKey]) return { dto, warnings: [], migrated: false };
  const warnings = [];
  let worldTick;
  if (state.worldTick !== undefined) {
    if (!isValidWorldTick(state.worldTick)) throw new Error("r6_time_migration_invalid_worldTick");
    if (state.worldDay !== undefined && state.worldDay !== Math.floor(state.worldTick / TICKS_PER_DAY)) warnings.push("runtimeState.worldDay 与权威 worldTick 不一致；已按 worldTick 重算投影日。");
    worldTick = state.worldTick;
  } else {
    if (!safeDay(state.worldDay)) throw new Error("r6_time_migration_source_runtimeState.worldDay_missing_or_invalid");
    worldTick = state.worldDay * TICKS_PER_DAY;
  }
  const character = state.character;
  if (character.birthDay !== undefined && safeDay(character.birthDay)) {
    character.lifeStartWorldTick = character.birthDay * TICKS_PER_DAY;
    if (Number.isSafeInteger(character.ageDays) && character.ageDays !== Math.floor(worldTick / TICKS_PER_DAY) - character.birthDay) warnings.push("character.birthDay 与 character.ageDays 不一致；保留 birthDay 并重算派生年龄。");
  } else if (Number.isSafeInteger(character.ageDays) && character.ageDays >= 0 && isValidWorldTick(worldTick - character.ageDays * TICKS_PER_DAY)) character.lifeStartWorldTick = worldTick - character.ageDays * TICKS_PER_DAY;
  else if (!isValidWorldTick(character.lifeStartWorldTick)) warnings.push("缺少 character.birthDay/ageDays 锚点；世界时钟已迁移，年龄待核。");
  if (character.lifeStartWorldTick !== undefined && !isValidWorldTick(character.lifeStartWorldTick)) throw new Error("r6_time_migration_invalid_character.lifeStartWorldTick");
  state.worldTick = worldTick; state.worldDay = Math.floor(worldTick / TICKS_PER_DAY); state.world.worldDay = state.worldDay;
  character.ageDays = character.lifeStartWorldTick === undefined ? character.ageDays : Math.floor((worldTick - character.lifeStartWorldTick) / TICKS_PER_DAY);
  if (character.birthDay === undefined && character.lifeStartWorldTick !== undefined) character.birthDay = Math.floor(character.lifeStartWorldTick / TICKS_PER_DAY);
  const tx = state.inFlightTransaction;
  if (tx) {
    if (safeDay(tx.startedDay) && safeDay(tx.targetDay) && tx.targetDay >= tx.startedDay) {
      tx.startedAtTick ??= tx.startedDay * TICKS_PER_DAY; tx.targetAtTick ??= tx.targetDay * TICKS_PER_DAY; tx.durationTicks ??= tx.targetAtTick - tx.startedAtTick;
      if (![tx.startedAtTick, tx.targetAtTick, tx.durationTicks].every(isValidWorldTick) || tx.targetAtTick < tx.startedAtTick) throw new Error("r6_time_migration_invalid_inFlightTransaction_day_fields");
    } else if (!isValidWorldTick(tx.startedAtTick) || !isValidWorldTick(tx.targetAtTick) || tx.targetAtTick < tx.startedAtTick) {
      tx.r6TimeReconciliation = { status: "needs_reconciliation", reason: "inFlightTransaction 缺少可验证的 startedDay/targetDay 或精确 tick；本事务暂停，其他存档继续迁移。" };
      warnings.push("inFlightTransaction 时间字段缺失/非法；该事务待核，不自动续做或结算。");
    }
  }
  const permit = character.permits?.furnace;
  if (permit && permit.issuedDay !== undefined && permit.validDays !== undefined) {
    if (!safeDay(permit.issuedDay) || !Number.isSafeInteger(permit.validDays) || permit.validDays < 0 || permit.issuedDay + permit.validDays + 1 > Math.floor(MAX_TICK / TICKS_PER_DAY)) throw new Error("r6_time_migration_invalid_character.permits.furnace_issuedDay_validDays");
    permit.issuedAtTick ??= permit.issuedDay * TICKS_PER_DAY; permit.expiresAtTickExclusive ??= (permit.issuedDay + permit.validDays + 1) * TICKS_PER_DAY;
  }
  for (const lease of character.portableFurnaceLeases || []) {
    if (lease.issuedDay !== undefined) {
      if (!safeDay(lease.issuedDay)) throw new Error("r6_time_migration_invalid_portableFurnaceLease_issuedDay");
      lease.issuedAtTick ??= lease.issuedDay * TICKS_PER_DAY;
    }
    if (lease.expiresAtTickExclusive === undefined) {
      if (Number.isSafeInteger(lease.issuedAtTick)) lease.expiresAtTickExclusive = lease.issuedAtTick + 30 * TICKS_PER_DAY;
      else if (safeDay(lease.expiresDay)) lease.expiresAtTickExclusive = (lease.expiresDay + 1) * TICKS_PER_DAY;
    }
  }
  state.r6TimeMigrationReceipts[receiptKey] = { id: "R6-TIME-MIGRATION-01", sourceSchemaVersion: 2, worldTick, status: "committed" };
  state.r6TimeMigrationWarnings = [...new Set([...(state.r6TimeMigrationWarnings || []), ...warnings])]; state.r6TimeSchemaVersion = 3; dto.timeSchemaVersion = 3;
  if (dto.world && typeof dto.world === "object") dto.world = { ...dto.world, worldDay: state.worldDay };
  return { dto, warnings, migrated: true };
}
