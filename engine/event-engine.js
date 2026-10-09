import { createAttributes, applyEffects, clamp } from "./attributes.js";

const REALMS = Object.freeze([
  { key: "mortal", label: "凡人", lifespan: 100, breakthroughTarget: null },
  { key: "qi", label: "炼气", lifespan: 150, breakthroughTarget: 10 },
  { key: "foundation", label: "筑基", lifespan: 220, breakthroughTarget: 13 },
  { key: "golden", label: "金丹", lifespan: 400, breakthroughTarget: 16 },
  { key: "nascent", label: "元婴", lifespan: 700, breakthroughTarget: 19 }
]);
const D20_DIFFICULTIES = Object.freeze({ easy: 7, normal: 10, hard: 13, veryHard: 16, extreme: 19 });
const ACTIVE_PHASES = Object.freeze(["event", "outcome", "preparation", "breakthrough", "fate_window", "karma_knock", "interlude", "cliff", "finished"]);
const GROWTH_ACTIONS = Object.freeze(["action_practice_dao", "action_recover_injury", "action_outing_find_medicine"]);
const GROWTH_DAOS = Object.freeze(["DAO01", "DAO02"]);
const GROWTH_WINDOW_ID = "preparation_window_01";
const BREAKTHROUGH_ID = "breakthrough_timing_01";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function shuffle(list, random) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function weightedPick(items, key = "weight", random) {
  if (!items.length) return null;
  const total = items.reduce((sum, item) => sum + Math.max(0, item[key] ?? 1), 0);
  if (total <= 0) return items[0];
  let roll = random() * total;
  for (const item of items) {
    roll -= Math.max(0, item[key] ?? 1);
    if (roll <= 0) return item;
  }
  return items[items.length - 1];
}

function realmByKey(key) {
  return REALMS.find((realm) => realm.key === key) || REALMS[0];
}

function deriveLedgerState(state) {
  state.age = Math.max(0, Number(state.age || 0));
  state.remainingYears = Math.max(0, Number(state.realmLifespan || 0) - state.age);
  state.deathWindowState = deathWindowState(state.remainingYears);
  return state;
}

function deathWindowState(remainingYears) {
  if (remainingYears <= 0) return "exhausted";
  if (remainingYears <= 5) return "critical";
  if (remainingYears <= 20) return "warning";
  return "ok";
}

function matchesCondition(condition, state, flags) {
  if (!condition) return true;
  if (condition.minAge != null && Number(state.age ?? 0) < condition.minAge) return false;
  if (condition.maxAge != null && Number(state.age ?? 0) > condition.maxAge) return false;
  const requiredAttribute = condition.requiredAttribute;
  if (requiredAttribute && requiredAttribute.name in state) {
    const value = state[requiredAttribute.name];
    if (requiredAttribute.min != null && value < requiredAttribute.min) return false;
    if (requiredAttribute.max != null && value > requiredAttribute.max) return false;
  }
  if (condition.requiredFlag && !flags.has(condition.requiredFlag)) return false;
  if (condition.missingFlag && flags.has(condition.missingFlag)) return false;
  if (condition.requiredAnyFlag?.length && !condition.requiredAnyFlag.some((flag) => flags.has(flag))) return false;
  if (condition.requiredAllFlags?.length && !condition.requiredAllFlags.every((flag) => flags.has(flag))) return false;
  if (condition.requiresPowerSource && state.powerSource !== condition.requiresPowerSource) return false;
  return true;
}

function matchesEvent(event, state, flags) {
  if (!event || !matchesCondition(event.conditions, state, flags)) return false;
  if (event.requiresPowerSource && state.powerSource !== event.requiresPowerSource) return false;
  return true;
}

function normalizeEventWindow(event, state) {
  const window = event?.eventWindow;
  if (!window || typeof window !== "object") return null;
  const id = window.id || `${event.id}_window`;
  const monthsFromNow = Math.max(0, Number(window.monthsFromNow ?? Number(window.yearsFromNow || 0) * 12) || 0);
  const yearsFromNow = monthsFromNow / 12;
  const resolveAtAge = Number(window.resolveAtAge);
  return {
    id,
    eventId: event.id,
    name: window.name || event.title || "天机簿",
    announceAfterEvent: window.announceAfterEvent || event.id,
    resolveAtEvent: window.resolveAtEvent || null,
    monthsFromNow,
    dueAge: Number.isFinite(resolveAtAge) ? resolveAtAge : Number(state.age || 0) + yearsFromNow,
    hint: event.windowHintText || window.hint || "",
    missPath: window.missPath || event.missPath || null,
    avoidPath: window.avoidPath || event.avoidPath || null,
    attendPath: window.attendPath || event.attendPath || null,
    karmaOnAvoid: window.karmaOnAvoid === true,
    reason: window.reason || `时间窗「${window.name || event.title || "天机簿"}」到达结算事件`,
    basis: window.basis || `时间窗依据：${window.name || event.title || "天机簿"} · 预告事件《${window.announceAfterEvent || event.id}》 · 结算事件《${window.resolveAtEvent || event.id}》 · ${monthsFromNow} 个月`,
    unfinishedBusiness: clone(window.unfinishedBusiness || event.unfinishedBusiness || []),
    personLedgerEntry: clone(window.personLedgerEntry || event.personLedgerEntry || null),
    resolved: false,
    outcome: null,
    announced: false,
    resolvedAtEvent: null,
    resolvedAtAge: null,
    resolvedAtWorldYear: null
  };
}

function normalizeLearningRecords(value) {
  return asArray(value).filter(Boolean).map((record) => ({
    id: record.id,
    lifeIndex: Math.max(1, Number(record.lifeIndex) || 1),
    category: record.category || "cultivation",
    name: record.name || record.id || "无名道业",
    rank: record.rank || "凡品",
    stageIndex: clamp(Math.round(Number(record.stageIndex) || 0), 0, 3),
    stages: asArray(record.stages),
    source: record.source || "系统礼包",
    awakened: record.awakened === true,
    current: record.current !== false,
    effect: record.effect || ""
  }));
}

function initialLedger(seedState, startAge, realmKey, realmLifespan) {
  const realm = realmByKey(realmKey);
  const age = Math.max(0, Number(seedState.age ?? startAge) || startAge);
  const lifespan = Math.max(1, Number(seedState.realmLifespan ?? realmLifespan ?? realm.lifespan));
  const remaining = Math.max(0, lifespan - age);
  const worldYear = Number.isFinite(Number(seedState.worldYear)) ? Number(seedState.worldYear) : 1;
  return { age, realm: realm.key, realmLifespan: lifespan, remainingYears: remaining, worldYear, deathWindowState: deathWindowState(remaining), lifespanRescueUsed: seedState.lifespanRescueUsed === true };
}

function rollD20(random) {
  return 1 + Math.floor(random() * 20);
}

function normalizeGrowthState(value, defaults = {}) {
  const source = value && typeof value === "object" ? value : {};
  const daoId = GROWTH_DAOS.includes(source.daoId) ? source.daoId : (defaults.daoId || "DAO01");
  const usedActions = asArray(source.usedActions).filter((id, index, list) => GROWTH_ACTIONS.includes(id) && list.indexOf(id) === index).slice(0, 3);
  const breakthroughState = ["available", "succeeded", "failed", "skipped"].includes(source.breakthroughState)
    ? source.breakthroughState
    : "available";
  return {
    daoId,
    daoMastery: clamp(Math.round(Number(source.daoMastery ?? defaults.daoMastery ?? 0)), 0, 3),
    medicine: clamp(Math.round(Number(source.medicine ?? defaults.medicine ?? 0)), 0, 1),
    actionSlotsRemaining: clamp(Math.round(Number(source.actionSlotsRemaining ?? 3 - usedActions.length)), 0, 3),
    usedActions,
    breakthroughState,
    breakthroughTimingId: source.breakthroughTimingId || BREAKTHROUGH_ID,
    crisisApproach: source.crisisApproach || null,
    windowPressure: source.windowPressure === "late_window" ? "late_window" : "on_time"
  };
}

function resolveCheck(option, state, random, manualRoll) {
  const check = option.d20 || option.check || null;
  if (!check) return null;
  const target = Number(check.target ?? option.checkTarget ?? D20_DIFFICULTIES.normal);
  const baseModifier = check.modifier != null
    ? Number(check.modifier)
    : check.modifierSource === "aptitude" || option.checkType === "study"
      ? Math.floor(Number(state.aptitude || 0) / 2)
      : 0;
  const penalty = Math.min(2, Number(state.checkPenalty?.[check.id || option.id] || 0));
  const roll = manualRoll == null ? rollD20(random) : clamp(Math.round(Number(manualRoll)), 1, 20);
  const modifier = baseModifier;
  const total = roll + modifier;
  const success = roll === 20 || (roll !== 1 && total >= target + penalty);
  return { roll, modifier, total, target: target + penalty, baseTarget: target, penalty, success, extreme: roll === 1 ? "disaster" : roll === 20 ? "greatSuccess" : null, kind: check.kind || null, id: check.id || option.id || null };
}

function resolveOptionResult(option, state, random, manualRoll, resultTexts = {}) {
  const check = resolveCheck(option, state, random, manualRoll);
  let success;
  if (check) {
    success = check.success;
  } else {
    const rate = option.successRate == null ? 1 : Number(option.successRate);
    const roll = manualRoll == null ? random() : Number(manualRoll);
    success = roll <= rate;
  }
  const baseEffects = option.semantic === "sacrifice"
    ? (success ? option.effects || {} : option.failureEffects || {})
    : (success ? option.effects || {} : option.failureEffects || option.effects || {});
  const effects = { ...baseEffects };
  if (option.semantic === "sacrifice") {
    if (success) {
      effects.power = Math.round(Number(state.power || 0) * 0.2) - Number(state.power || 0);
    } else {
      const current = Number(state.power || 0);
      effects.power = -Math.round(current * 0.7);
      effects.health = (Number(effects.health) || 0) - 12;
      effects.sanity = (Number(effects.sanity) || 0) - 10;
    }
  }
  return {
    success,
    effects,
    d20: check,
    text: success
      ? option.resultText ?? resultTexts.resultText ?? ""
      : option.failureText ?? option.resultText ?? resultTexts.failureText ?? resultTexts.resultText ?? "",
    label: success ? option.resultLabel || "成" : option.failureLabel || "败",
    riskTag: option.riskTag || option.semantic || (option.successRate < 1 ? "risky" : "safe"),
    semantic: option.semantic || option.riskTag || "safe",
    resultTone: option.semantic === "sacrifice" ? "sacrifice" : success ? "success" : "failure"
  };
}

function applyRealmProgress(state, check) {
  if (!check || check.kind !== "breakthrough") return null;
  const index = REALMS.findIndex((realm) => realm.key === state.realm);
  const current = REALMS[Math.max(0, index)];
  const next = REALMS[index + 1];
  if (!check.success || !next) {
    const key = check.id || state.realm;
    state.checkPenalty = { ...(state.checkPenalty || {}), [key]: Math.min(2, Number(state.checkPenalty?.[key] || 0) + 1) };
    return { from: current.key, to: current.key, label: current.label, changed: false };
  }
  state.realm = next.key;
  state.realmLifespan = next.lifespan;
  state.remainingYears = Math.max(0, next.lifespan - Number(state.age || 0));
  state.deathWindowState = deathWindowState(state.remainingYears);
  return { from: current.key, to: next.key, label: next.label, changed: true };
}

function createSession(config, content, seedState, restoreData, randomFn) {
  const template = clone(config);
  const pack = clone(content);
  // R3.1 feedback is content-owned. Older packs remain valid when the
  // option-level sidecar is absent.
  for (const event of pack.events || []) {
    const feedback = pack.optionFeedback?.[event.id];
    if (!Array.isArray(feedback)) continue;
    event.options = (event.options || []).map((option, index) => ({ ...option, ...(feedback[index] || {}) }));
  }
  const engine = template.engine || {};
  const activePractice = pack.activePractice && typeof pack.activePractice === "object" ? pack.activePractice : null;
  const hasActivePractice = Boolean(activePractice && activePractice.windowId === GROWTH_WINDOW_ID);
  const random = typeof randomFn === "function" ? randomFn : Math.random;
  const stageSequence = asArray(engine.stageSequence);
  const counts = engine.eventsPerStage || {};
  const attributeConfig = template.attributes || {};
  const attrs = createAttributes(attributeConfig);
  const seed = seedState || {};
  const state = { ...attrs.state, ...(seed.attributes || seed) };
  if (restoreData?.state) Object.assign(state, restoreData.state);
  const ageConfig = engine.age || {};
  const startAge = Number(ageConfig.start ?? 16);
  if (ageConfig.enabled !== false && state.age == null) state.age = startAge;
  const ledger = { ...initialLedger(state, startAge, state.realm || "mortal", state.realmLifespan) };
  Object.assign(state, ledger);
  state.cycle = Number(restoreData?.cycle ?? seed.cycle ?? 1);
  state.livesInCycle = Number(restoreData?.livesInCycle ?? seed.livesInCycle ?? 1);
  state.powerSource = restoreData?.powerSource ?? seed.powerSource ?? "system";
  state.systemGuidanceState = restoreData?.systemGuidanceState ?? seed.systemGuidanceState ?? (state.livesInCycle === 1 ? "guided" : "quiet");
  state.fourDims = { naturalTalent: 0, aptitude: 0, bloodline: 0, fortune: 0, ...(restoreData?.fourDims || seed.fourDims || {}) };
  const fortuneRerollLimit = Math.min(5, Math.floor(Number(state.fourDims.fortune || 0) / 2));
  state.fortuneUsesRemaining = restoreData?.fortuneUsesRemaining == null
    ? Math.min(fortuneRerollLimit, Math.max(0, Number(seed.fortuneUsesRemaining ?? fortuneRerollLimit) || 0))
    : Math.min(fortuneRerollLimit, Math.max(0, Number(restoreData.fortuneUsesRemaining) || 0));
  state.birthProfile = clone(restoreData?.birthProfile || seed.birthProfile || null);
  state.checkPenalty = clone(restoreData?.checkPenalty || seed.checkPenalty || {});
  state.memoryFragments = clone(restoreData?.memoryFragments || seed.memoryFragments || []);
  state.unfinishedBusiness = clone(restoreData?.unfinishedBusiness || seed.unfinishedBusiness || []);
  state.grudgeAnchors = clone(restoreData?.grudgeAnchors || seed.grudgeAnchors || []);
  state.personLedger = clone(restoreData?.personLedger || seed.personLedger || []);
  state.karmaDeferred = clone(restoreData?.karmaDeferred || seed.karmaDeferred || null);
  state.blackMark = restoreData?.blackMark === true || seed.blackMark === true;
  state.lifespanRescueUsed = restoreData?.lifespanRescueUsed === true || seed.lifespanRescueUsed === true;
  if (hasActivePractice) {
    state.growthState = normalizeGrowthState(
      restoreData?.growthState || seed.growthState || state.growthState,
      { daoId: activePractice.defaultDaoId, medicine: activePractice.startMedicine }
    );
  }
  const flags = new Set(restoreData?.flags || seed.flags || []);
  const history = clone(restoreData?.history || []);
  const timeline = clone(restoreData?.timeline || seed.timeline || []);
  const learningRecords = normalizeLearningRecords(restoreData?.learningRecords || seed.learningRecords || template.learningSystem?.initialRecords || []);
  const pendingWindows = clone(restoreData?.pendingWindows || seed.pendingWindows || []);
  const usedEventIds = new Set(restoreData?.usedEventIds || []);
  const poolByStage = new Map();
  for (const event of pack.events || []) {
    if (!poolByStage.has(event.stage)) poolByStage.set(event.stage, []);
    poolByStage.get(event.stage).push(event);
  }

  let stageIndex = Number(restoreData?.stageIndex ?? 0);
  let eventIndexInStage = Number(restoreData?.eventIndexInStage ?? 0);
  let currentEvent = restoreData?.currentEventId ? (pack.events || []).find((event) => event.id === restoreData.currentEventId) || null : null;
  let phase = ACTIVE_PHASES.includes(restoreData?.phase) ? restoreData.phase : "event";
  let activeWindow = null;
  let pendingOutcome = clone(restoreData?.pendingOutcome || null);
  let stageChanged = false;
  let finished = false;

  function currentStage() { return stageSequence[stageIndex] || null; }

  function targetCountForStage(stageId) {
    const stageConfig = template.stages?.[stageId];
    const countConfig = counts[stageId] || {};
    const max = countConfig.max ?? stageConfig?.maxEvents ?? 4;
    const min = countConfig.min ?? stageConfig?.minEvents ?? Math.min(max, 3);
    return Math.min(max, Math.max(min, (poolByStage.get(stageId) || []).length));
  }

  function drawEvent() {
    const stageId = currentStage();
    if (!stageId) return null;
    if (hasActivePractice && stageId === "act2") {
      const herb = (pack.events || []).find((event) => event.id === "act2_herb_shelter");
      if (herb && !usedEventIds.has(herb.id) && matchesEvent(herb, state, flags)) {
        usedEventIds.add(herb.id);
        eventIndexInStage += 1;
        return herb;
      }
      if (usedEventIds.has("act2_herb_shelter") && !usedEventIds.has("act2_first_blood")) return null;
    }
    const guaranteed = engine.guaranteedEvents?.[stageId] || [];
    const guaranteedEvent = guaranteed.map((id) => (pack.events || []).find((event) => event.id === id)).find((event) => event && !usedEventIds.has(event.id) && matchesEvent(event, state, flags));
    if (guaranteedEvent) {
      usedEventIds.add(guaranteedEvent.id);
      eventIndexInStage += 1;
      return guaranteedEvent;
    }
    let pool = (poolByStage.get(stageId) || []).filter((event) => matchesEvent(event, state, flags));
    if (engine.noRepeatWithinRun !== false) pool = pool.filter((event) => !usedEventIds.has(event.id));
    if (!pool.length) pool = (poolByStage.get(stageId) || []).filter((event) => !usedEventIds.has(event.id) && matchesEvent(event, state, flags));
    if (!pool.length) return null;
    const picked = engine.weightedDraw === false ? shuffle(pool, random)[0] : weightedPick(pool, "weight", random);
    usedEventIds.add(picked.id);
    eventIndexInStage += 1;
    return picked;
  }

  function ledgerSnapshot() {
    const realm = realmByKey(state.realm);
    return {
      age: state.age,
      realm: state.realm,
      realmLabel: realm.label,
      realmLifespan: state.realmLifespan,
      remainingYears: state.remainingYears,
      worldYear: state.worldYear,
      deathWindowState: state.deathWindowState,
      warningText: state.deathWindowState === "exhausted" ? "寿元已尽" : state.deathWindowState === "critical" ? "寿元危急" : state.deathWindowState === "warning" ? "寿元将尽" : "寿元安稳"
    };
  }

  function snapshot() {
    const stageId = currentStage();
    const attributes = {};
    for (const key of Object.keys(attributeConfig)) attributes[key] = state[key];
    return {
      templateId: template.id,
      stageId,
      stageIndex,
      currentEventId: currentEvent?.id || null,
      stageLabel: stageId ? template.stages?.[stageId]?.label || stageId : null,
      stageProgress: stageId ? `${Math.min(eventIndexInStage, targetCountForStage(stageId))}/${targetCountForStage(stageId)}` : "0/0",
      totalEvents: history.length + (currentEvent ? 1 : 0),
      maxEvents: engine.maxEvents,
      attributes,
      flags: [...flags],
      history: clone(history),
      timeline: clone(timeline),
      usedEventIds: [...usedEventIds],
      state: clone(state),
      ledger: ledgerSnapshot(),
      phase,
      cycle: state.cycle,
      livesInCycle: state.livesInCycle,
      learningRecords: clone(learningRecords),
      pendingWindows: clone(pendingWindows),
      growthState: hasActivePractice ? clone(state.growthState) : null,
      unfinishedBusiness: clone(state.unfinishedBusiness),
      memoryFragments: clone(state.memoryFragments),
      fourDims: clone(state.fourDims),
      birthProfile: clone(state.birthProfile),
      pendingOutcome: clone(pendingOutcome)
    };
  }

  function advanceLedger(years, context = {}) {
    const previous = ledgerSnapshot();
    const explicitMonths = context.months == null ? null : Number(context.months);
    const months = Math.max(0, explicitMonths == null ? (Number(years) || 0) * 12 : explicitMonths);
    const amount = months / 12;
    state.age = Number(state.age || 0) + amount;
    state.worldYear = Number(state.worldYear || 1) + amount;
    deriveLedgerState(state);
    const entry = {
      months,
      years: amount,
      fromAge: previous.age,
      toAge: state.age,
      fromWorldYear: previous.worldYear,
      toWorldYear: state.worldYear,
      previous,
      current: ledgerSnapshot(),
      reason: months > 0 ? context.reason || `事件《${context.eventTitle || "当前事件"}》推进叙事时间` : "",
      basis: months > 0 ? context.basis || `事件依据：${context.eventTitle || context.eventId || "当前事件"}` : "",
      source: context.source || "event",
      eventId: context.eventId || null,
      eventTitle: context.eventTitle || null,
      optionLabel: context.optionLabel || null,
      windowId: context.windowId || null,
      windowName: context.windowName || null,
      daoId: context.daoId || null,
      daoName: context.daoName || null
    };
    if (months > 0) timeline.push(entry);
    return entry;
  }

  function addUnfinished(items) {
    for (const item of asArray(items)) {
      if (!item) continue;
      if (!state.unfinishedBusiness.includes(item)) state.unfinishedBusiness.push(item);
    }
    if (state.unfinishedBusiness.length > 5) state.unfinishedBusiness = state.unfinishedBusiness.slice(-5);
  }

  function addPersonLedger(entry) {
    if (!entry) return;
    const normalized = {
      ...clone(entry),
      character: entry.character || entry.person || "",
      person: entry.person || entry.character || ""
    };
    const key = `${normalized.character}:${normalized.slice || ""}`;
    if (!state.personLedger.some((item) => `${item.character || item.person || ""}:${item.slice || ""}` === key)) state.personLedger.push(normalized);
  }

  function registerWindow(event) {
    const window = normalizeEventWindow(event, state);
    if (!window) return;
    const existing = pendingWindows.find((item) => item.id === window.id);
    if (existing) return;
    pendingWindows.push({ ...window, announced: true });
  }

  function registerWindowsAnnouncedAfter(eventId) {
    for (const event of pack.events || []) {
      const window = event.eventWindow;
      if (!window || typeof window !== "object") continue;
      if ((window.announceAfterEvent || event.id) !== eventId) continue;
      registerWindow(event);
    }
  }

  function growthActionMonths() {
    const windowStart = timeline.reduce((lastIndex, entry, index) => entry.eventId === "act2_herb_shelter" ? index : lastIndex, -1);
    return timeline
      .slice(windowStart + 1)
      .filter((entry) => entry.source === "growth_action")
      .reduce((sum, entry) => sum + Number(entry.months || 0), 0);
  }

  function updateGrowthPressure() {
    if (!hasActivePractice) return;
    state.growthState.windowPressure = growthActionMonths() > 24 ? "late_window" : "on_time";
  }

  function crisisOptions() {
    const growth = state.growthState;
    const lateText = growth.windowPressure === "late_window" ? "准备过久，后续机会已变冷。" : "准备仍在窗口时限内。";
    const options = [];
    const canFortify = growth.daoId === "DAO01" && (growth.breakthroughState === "succeeded" || (Number(state.power || 0) >= 40 && Number(state.health || 0) >= 45));
    const canAlchemy = growth.daoId === "DAO02" && (growth.breakthroughState === "succeeded" || (growth.medicine >= 1 && growth.daoMastery >= 1));
    if (canFortify) options.push({
      label: "以五行镇岳诀镇压首杀现场",
      effects: { power: 4, fame: 5, health: -4 },
      successRate: 1,
      semantic: "growth",
      growthCrisis: "fortify",
      unlockFlag: "dao01_crisis_fortify",
      resultText: `你以镇岳诀压住村口的第一具尸体，${lateText}`,
      bridgeText: "村口守望的旗子立了起来，宗门巡逻队不得不先查旧案。"
    });
    if (canAlchemy) options.push({
      label: "以丹术处理伤口与证人",
      effects: { health: 8, bond: 5, fame: 3 },
      successRate: 1,
      semantic: "growth",
      growthCrisis: "alchemy",
      consumeMedicine: growth.breakthroughState !== "succeeded",
      unlockFlag: "dao02_crisis_alchemy",
      resultText: `你把药火压进伤口，先保住证人的气息，${lateText}`,
      bridgeText: "药棚留下了可追溯的炉火印，天香谷的试炼塔因此向你打开一条窄门。"
    });
    if (Number(state.health || 0) >= 25) options.push({
      label: "先护住活人，退让换取三天",
      effects: { bond: 5, fame: -2, health: -2 },
      successRate: 1,
      semantic: "safe",
      growthCrisis: "retreat",
      unlockFlag: "act2_retreat",
      resultText: "你把活人推出村口，放弃追问令符的机会，至少没有让更多人倒下。",
      bridgeText: "村口暂时安静，却有人记住了你退让的那一刻；两条专属道路都还隔着一层雾。"
    });
    if (Number(state.health || 0) < 25) options.push({
      label: "状态崩溃，只求把人推出火线",
      effects: { health: -Number(state.health || 0), sanity: -5 },
      successRate: 1,
      semantic: "collapse",
      growthCrisis: "collapse",
      unlockFlag: "act2_collapse",
      resultText: "你已经撑不住了，只来得及把最后一个活人推离村口。",
      bridgeText: "重伤压垮了剩下的路，因果在此世提前收束。"
    });
    return options;
  }

  function activateCrisisEvent() {
    const base = (pack.events || []).find((event) => event.id === "act2_first_blood");
    if (!base) return false;
    currentEvent = clone(base);
    currentEvent.options = crisisOptions();
    if (!usedEventIds.has(currentEvent.id)) {
      usedEventIds.add(currentEvent.id);
      eventIndexInStage += 1;
    }
    phase = "event";
    stageChanged = false;
    return true;
  }

  function growthResult(record, snapshotResult = snapshot()) {
    return { result: record, snapshot: snapshotResult, phase, finished: false };
  }

  function chooseGrowthAction(actionId, manualRoll) {
    if (!hasActivePractice || phase !== "preparation") return { error: "growth_window_not_active" };
    const growth = state.growthState;
    if (!GROWTH_ACTIONS.includes(actionId)) return { error: "unknown_growth_action" };
    if (growth.actionSlotsRemaining <= 0) return { error: "no_action_slots" };
    if (growth.usedActions.includes(actionId)) return { error: "growth_action_already_used" };
    if (actionId === "action_practice_dao" && Number(state.health || 0) < 30) return { error: "health_too_low_to_practice" };

    const beforeGrowth = clone(growth);
    const daoId = growth.daoId;
    let months = 0;
    let success = true;
    let effects = {};
    let growthChanges = {};
    let resultText = "";
    let optionLabel = "";
    if (actionId === "action_practice_dao") {
      months = 12;
      optionLabel = "研修当前道业";
      effects = daoId === "DAO01" ? { power: 10, health: -2 } : { power: 8, health: -1 };
      growth.daoMastery = Math.min(3, growth.daoMastery + 1);
      const record = learningRecords.find((item) => item.id === daoId.toLowerCase() && item.current !== false);
      if (record) {
        record.stageIndex = Math.min(3, Number(record.stageIndex || 0) + 1);
        record.rank = record.stages?.[record.stageIndex] || record.rank;
      }
      growthChanges = { daoMastery: `${beforeGrowth.daoMastery} → ${growth.daoMastery}` };
      resultText = daoId === "DAO01" ? "你把五行镇岳诀压进骨缝，修为上涨，却让伤势更沉。" : "你照着丹术调息，修为缓慢上涨，药火也更懂得如何护住经脉。";
    } else if (actionId === "action_recover_injury") {
      const hasMedicine = growth.medicine >= 1;
      months = hasMedicine ? 6 : 12;
      optionLabel = "处理伤势";
      effects = { health: daoId === "DAO01" ? 16 : 18, ...(hasMedicine ? {} : { power: -2 }) };
      if (hasMedicine) growth.medicine -= 1;
      growthChanges = { medicine: `${beforeGrowth.medicine} → ${growth.medicine}` };
      resultText = hasMedicine ? "药材化开，伤口终于不再往外渗血。" : "没有药材，你只能用更长的时间养伤，修为也因此松动。";
    } else {
      months = 8;
      optionLabel = "有目的外出寻药";
      const health = Number(state.health || 0);
      const successRate = health >= 60 ? 0.8 : health >= 30 ? 0.6 : 0.35;
      const sample = manualRoll == null ? random() : Number(manualRoll);
      success = sample <= successRate;
      if (success) {
        growth.medicine = Math.min(1, growth.medicine + 1);
        growthChanges = { medicine: `${beforeGrowth.medicine} → ${growth.medicine}` };
        resultText = "你沿着雨水冲出的药痕找回一份完整药材，回村时伤势还撑得住。";
      } else {
        effects = { health: daoId === "DAO02" && growth.daoMastery >= 1 ? -4 : -8 };
        resultText = "药材没找到，你反倒在山沟里摔出一道新伤。";
      }
    }
    const applied = applyEffects(state, attributeConfig, effects, "growth_action");
    growth.usedActions.push(actionId);
    growth.actionSlotsRemaining = Math.max(0, growth.actionSlotsRemaining - 1);
    const record = {
      eventId: GROWTH_WINDOW_ID,
      actionId,
      eventTitle: "准备窗口",
      optionLabel,
      success,
      semantic: "growth",
      riskTag: actionId === "action_outing_find_medicine" ? "risky" : "development",
      effects: applied.applied,
      growthChanges,
      resultText,
      bridgeText: growth.actionSlotsRemaining > 0 ? `准备窗口还剩 ${growth.actionSlotsRemaining} 次行动。` : "行动槽已用尽，突破时机在等你决定。",
      timeAdvance: null,
      windowTimeAdvances: [],
      growthState: clone(growth)
    };
    pendingOutcome = { kind: "growth_action", ...record, beforeGrowth, months };
    phase = "outcome";
    return growthResult(record, snapshot());
  }

  function continueGrowthOutcome() {
    const outcome = pendingOutcome;
    const timeAdvance = advanceLedger(outcome.months / 12, {
      source: "growth_action",
      months: outcome.months,
      eventId: GROWTH_WINDOW_ID,
      eventTitle: "准备窗口",
      optionLabel: outcome.optionLabel,
      daoId: state.growthState.daoId,
      daoName: state.growthState.daoId === "DAO01" ? "五行镇岳诀" : "星芒九转丹术",
      reason: `${outcome.optionLabel}耗时 ${outcome.months} 个月`,
      basis: `准备窗口依据：${outcome.actionId}`
    });
    updateGrowthPressure();
    const record = { ...outcome, timeAdvance, growthState: clone(state.growthState) };
    delete record.kind;
    delete record.beforeGrowth;
    delete record.months;
    pendingOutcome = null;
    if (Number(state.health || 0) <= 0 || Number(state.sanity || 0) <= 0) phase = "cliff";
    else if (state.growthState.actionSlotsRemaining <= 0) phase = "breakthrough";
    else phase = "preparation";
    return { kind: "growth_resolved", ...record, snapshot: snapshot(), phase, finished: false };
  }

  function finishPreparation() {
    if (!hasActivePractice || phase !== "preparation") return { error: "growth_window_not_active" };
    phase = "breakthrough";
    return { kind: "breakthrough", timingId: BREAKTHROUGH_ID, snapshot: snapshot(), growthState: clone(state.growthState), phase };
  }

  function resolveBreakthrough(choice, manualRoll) {
    if (!hasActivePractice || phase !== "breakthrough") return { error: "breakthrough_not_ready" };
    const growth = state.growthState;
    if (growth.breakthroughState !== "available") return { error: "breakthrough_already_resolved" };
    if (choice === "skip") {
      growth.breakthroughState = "skipped";
      const record = { eventId: BREAKTHROUGH_ID, eventTitle: "突破时机", optionLabel: "暂不突破", success: true, semantic: "growth", effects: {}, resultText: "你暂时按住突破的念头，先去面对村口的血光。", bridgeText: "没有人能替你保存这次时机，接下来的危机只看你现在的状态。", growthState: clone(growth) };
      activateCrisisEvent();
      return growthResult(record);
    }
    const power = Number(state.power || 0);
    const health = Number(state.health || 0);
    if (power < 28 || health < 35) return { error: "breakthrough_conditions_unmet", required: { power: 28, health: 35 }, actual: { power, health } };
    const daoId = growth.daoId;
    const hasMedicine = daoId === "DAO02" && growth.medicine >= 1;
    const daoModifier = daoId === "DAO01" ? (health >= 60 ? 2 : -1) : (hasMedicine ? 2 : -1);
    if (hasMedicine) growth.medicine -= 1;
    const roll = manualRoll == null ? rollD20(random) : clamp(Math.round(Number(manualRoll)), 1, 20);
    const modifier = Math.floor(power / 10) + daoModifier;
    const total = roll + modifier;
    const success = roll === 20 || (roll !== 1 && total >= 17);
    const d20 = { id: BREAKTHROUGH_ID, kind: "breakthrough", roll, modifier, total, target: 17, baseTarget: 17, penalty: 0, success, extreme: roll === 1 ? "disaster" : roll === 20 ? "greatSuccess" : null };
    const effects = success
      ? (daoId === "DAO01" ? { power: 12, health: -6 } : { power: 10, health: 4 })
      : (daoId === "DAO01" ? { health: -10, power: -4 } : { health: -7 });
    const applied = applyEffects(state, attributeConfig, effects, "breakthrough");
    growth.breakthroughState = success ? "succeeded" : "failed";
    if (success) flags.add(daoId === "DAO01" ? "dao01_breakthrough" : "dao02_alchemy_breakthrough");
    else flags.add(daoId === "DAO01" ? "breakthrough_backlash" : "damaged_elixir");
    const record = {
      eventId: BREAKTHROUGH_ID,
      eventTitle: "突破时机",
      optionLabel: "尝试突破",
      success,
      semantic: "growth",
      riskTag: "risky",
      effects: applied.applied,
      growthChanges: { medicine: daoId === "DAO02" ? `${hasMedicine ? 1 : 0} → ${growth.medicine}` : undefined },
      resultText: success
        ? (daoId === "DAO01" ? "镇岳诀压过血气，你在村口之前先把自己的关口推开。" : "丹火逆转经脉，星芒九转丹术把药材炼成了护住命门的火。")
        : (daoId === "DAO01" ? "镇岳诀反噬，修为倒退，伤势在关口撕开。" : "丹火散乱，药材化灰，伤势又添一层。"),
      bridgeText: "突破的结果已经写进此世，村口的第一滴血不会等你第二次尝试。",
      d20,
      growthState: clone(growth)
    };
    activateCrisisEvent();
    return growthResult(record);
  }

  function collectDueWindow() {
    return pendingWindows.find((window) => !window.resolved && !window.resolveAtEvent && Number(state.age || 0) >= Number(window.dueAge || 0)) || null;
  }

  function karmaDue() {
    return state.karmaDeferred && !state.karmaDeferred.resolved && Number(state.age || 0) >= Number(state.karmaDeferred.dueAge || 0);
  }

  function nextAfterStage() {
    if (stageIndex < stageSequence.length - 1) {
      stageIndex += 1;
      eventIndexInStage = 0;
      stageChanged = true;
      currentEvent = drawEvent();
      phase = stageChanged ? "interlude" : currentEvent ? "event" : "finished";
      return;
    }
    currentEvent = null;
    phase = "finished";
  }

  function scheduleNext() {
    const dueWindow = collectDueWindow();
    if (dueWindow) {
      activeWindow = dueWindow;
      phase = "fate_window";
      return;
    }
    if (karmaDue()) {
      phase = "karma_knock";
      return;
    }
    if (Number(state.health || 0) <= 0 || Number(state.sanity || 0) <= 0 || Number(state.remainingYears || 0) <= 0) {
      currentEvent = null;
      phase = "cliff";
      return;
    }
    if (!currentEvent) {
      const done = eventIndexInStage >= targetCountForStage(currentStage()) || history.length >= Number(engine.maxEvents || Infinity);
      if (done) nextAfterStage();
      else currentEvent = drawEvent();
    }
    if (currentEvent) {
      if (phase !== "interlude" && phase !== "event") phase = "event";
    } else {
      phase = "finished";
    }
  }

  function advance() {
    if (pendingOutcome) {
      if (pendingOutcome.kind === "growth_action") return continueGrowthOutcome();
      const continuation = continueOutcome();
      if (continuation.error) return continuation;
      if (continuation.phase === "finished") return { kind: "finished", continued: continuation, snapshot: continuation.snapshot };
      const next = advance();
      return { ...next, continued: continuation, bridgeText: continuation.bridgeText, outcome: continuation.record };
    }
    if (phase === "interlude") {
      phase = currentEvent ? "event" : "finished";
      return { kind: "interlude", snapshot: snapshot() };
    }
    if (phase === "preparation") return { kind: "preparation", windowId: GROWTH_WINDOW_ID, snapshot: snapshot(), growthState: clone(state.growthState), phase };
    if (phase === "breakthrough") return { kind: "breakthrough", timingId: BREAKTHROUGH_ID, snapshot: snapshot(), growthState: clone(state.growthState), phase };
    if (phase === "fate_window") return { kind: "fate_window", window: activeWindow || collectDueWindow(), snapshot: snapshot() };
    if (phase === "karma_knock") return { kind: "karma_knock", karma: clone(state.karmaDeferred), snapshot: snapshot() };
    if (phase === "cliff") return { kind: "cliff", reason: healthZeroReason(), snapshot: snapshot() };
    if (phase === "event" && currentEvent) return { kind: "event", event: currentEvent, snapshot: snapshot() };
    if (finished) return { kind: "finished", snapshot: snapshot() };
    if (phase === "finished") {
      scheduleNext();
      if (phase !== "finished") return advance();
      return { kind: "finished", snapshot: snapshot() };
    }
    currentEvent = drawEvent();
    phase = currentEvent ? "event" : "finished";
    return advance();
  }

  function healthZeroReason() {
    if (Number(state.health || 0) <= 0) return "health_zero";
    if (Number(state.sanity || 0) <= 0) return "sanity_zero";
    if (Number(state.remainingYears || 0) <= 0) return "lifespan_exhausted";
    return "mid_life_stop";
  }

  function chooseOption(optionIndex, manualRoll) {
    if (pendingOutcome) return { error: "outcome_pending" };
    if (!currentEvent) return { error: "no_active_event" };
    const option = currentEvent.options?.[optionIndex];
    if (!option) return { error: "invalid_option" };
    const previousStage = currentStage();
    const beforeState = clone(state);
    const beforeFlags = [...flags];
    const resolved = resolveOptionResult(option, state, random, manualRoll, {
      resultText: currentEvent.resultText,
      failureText: currentEvent.failureText
    });
    const appliedResult = applyEffects(state, attributeConfig, resolved.effects, "option");
    let growthChanges = null;
    if (currentEvent.id === "act2_first_blood" && option.growthCrisis) {
      state.growthState.crisisApproach = option.growthCrisis;
      if (option.growthCrisis === "alchemy" && option.consumeMedicine) {
        const beforeMedicine = state.growthState.medicine;
        state.growthState.medicine = Math.max(0, beforeMedicine - 1);
        growthChanges = { medicine: `${beforeMedicine} → ${state.growthState.medicine}` };
      }
      updateGrowthPressure();
    }
    if (resolved.success && option.unlockFlag) flags.add(option.unlockFlag);
    if (!resolved.success && option.failureUnlockFlag) flags.add(option.failureUnlockFlag);
    const realmProgress = applyRealmProgress(state, resolved.d20);
    const record = {
      eventId: currentEvent.id,
      eventTitle: currentEvent.title,
      optionIndex,
      optionLabel: option.label,
      success: resolved.success,
      riskTag: resolved.riskTag,
      semantic: resolved.semantic,
      effects: appliedResult.applied,
      growthChanges,
      warnings: appliedResult.warnings,
      resultText: resolved.text,
      d20: resolved.d20,
      realmProgress,
      timeAdvance: null,
      windowTimeAdvances: [],
      unlockFlag: resolved.success ? option.unlockFlag || null : null,
      failureUnlockFlag: !resolved.success ? option.failureUnlockFlag || null : null,
      branchFlags: [resolved.success ? option.unlockFlag : option.failureUnlockFlag].filter(Boolean),
      bridgeText: option.bridgeText || currentEvent.bridgeText || null,
      resultSource: resolved.success ? (option.resultText ? "option" : "event-fallback") : (option.failureText || option.resultText ? "option" : "event-fallback"),
      timeBeats: clone(currentEvent.timeBeats || []),
      nextEventTrigger: currentEvent.nextEventTrigger || null,
      stageId: previousStage,
      timeWindowId: currentEvent.eventWindow?.id || null
    };
    pendingOutcome = {
      eventId: currentEvent.id,
      eventTitle: currentEvent.title,
      optionIndex,
      optionLabel: option.label,
      record,
      beforeState,
      beforeFlags,
      bridgeText: record.bridgeText,
      timeBeats: record.timeBeats,
      nextEventTrigger: record.nextEventTrigger
    };
    phase = "outcome";
    return { record, d20: resolved.d20, snapshot: snapshot(), phase, finished: false };
  }

  function resolveEventWindowsFor(eventId, eventRecord) {
    const advances = [];
    for (const window of pendingWindows) {
      if (window.resolved || window.resolveAtEvent !== eventId) continue;
      const currentAge = Number(state.age || 0);
      const months = Math.max(0, (Number(window.dueAge || currentAge) - currentAge) * 12);
      const timeAdvance = advanceLedger(months / 12, {
        source: "event_window",
        months,
        eventId,
        eventTitle: window.name,
        windowId: window.id,
        windowName: window.name,
        optionLabel: eventRecord?.optionLabel || null,
        reason: window.reason,
        basis: window.basis
      });
      window.resolved = true;
      window.outcome = "resolved_at_event";
      window.resolvedAtEvent = eventId;
      window.resolvedAtAge = state.age;
      window.resolvedAtWorldYear = state.worldYear;
      addUnfinished(window.unfinishedBusiness);
      addPersonLedger(window.personLedgerEntry);
      advances.push(timeAdvance);
    }
    return advances;
  }

  function continueOutcome() {
    if (pendingOutcome?.kind === "growth_action") return continueGrowthOutcome();
    if (!pendingOutcome) return { error: "no_pending_outcome" };
    const outcome = pendingOutcome;
    const event = (pack.events || []).find((item) => item.id === outcome.eventId);
    if (!event) return { error: "pending_event_not_found" };

    const previousStage = currentStage();
    const lifeAdvance = event.lifeAdvance && typeof event.lifeAdvance === "object" ? event.lifeAdvance : null;
    const timeAdvance = lifeAdvance
      ? advanceLedger(Number(lifeAdvance.months || 0) / 12, {
          source: lifeAdvance.source || "event",
          months: Number(lifeAdvance.months || 0),
          eventId: event.id,
          eventTitle: event.title,
          optionLabel: outcome.optionLabel,
          reason: lifeAdvance.reason,
          basis: lifeAdvance.basis
        })
      : null;

    registerWindowsAnnouncedAfter(event.id);
    const windowTimeAdvances = resolveEventWindowsFor(event.id, outcome.record);

    if (outcome.record.success && event.memoryFragment) state.memoryFragments.push(event.memoryFragment);
    addUnfinished(event.unfinishedBusiness);
    addPersonLedger(event.personLedgerEntry);

    const record = {
      ...outcome.record,
      timeAdvance,
      windowTimeAdvances,
      bridgeText: outcome.record.bridgeText || event.bridgeText || null,
      timeBeats: clone(event.timeBeats || outcome.timeBeats || []),
      nextEventTrigger: event.nextEventTrigger || outcome.nextEventTrigger || null,
      branchFlags: outcome.record.branchFlags || []
    };
    history.push(record);

    if (hasActivePractice && event.id === "act2_herb_shelter") {
      pendingOutcome = null;
      currentEvent = null;
      phase = "preparation";
      stageChanged = false;
      updateGrowthPressure();
      return {
        kind: "outcome",
        record,
        timeAdvance,
        windowTimeAdvances,
        bridgeText: "药棚保住后，恶徒发现村里多了一个会配药的外乡人；你还有三次准备机会。",
        timeBeats: record.timeBeats,
        nextEventTrigger: "准备窗口结束后，村口的第一滴血会逼你交出答案。",
        stageChanged,
        snapshot: snapshot(),
        phase,
        finished: false,
        preparationWindow: GROWTH_WINDOW_ID
      };
    }

    pendingOutcome = null;
    currentEvent = null;
    phase = "event";
    stageChanged = false;
    const done = eventIndexInStage >= targetCountForStage(previousStage) || history.length >= Number(engine.maxEvents || Infinity);
    if (done) nextAfterStage();
    else {
      currentEvent = drawEvent();
      phase = currentEvent ? "event" : "finished";
    }
    scheduleNext();
    finished = phase === "finished";

    return {
      kind: "outcome",
      record,
      timeAdvance,
      windowTimeAdvances,
      bridgeText: record.bridgeText,
      timeBeats: record.timeBeats,
      nextEventTrigger: record.nextEventTrigger,
      stageChanged,
      snapshot: snapshot(),
      phase,
      finished
    };
  }

  function resolveWindow(choice, manualRoll) {
    const window = activeWindow || collectDueWindow();
    if (!window) return { error: "no_active_window" };
    const target = choice === "attend" ? window.attendPath : choice === "avoid" ? window.avoidPath : window.missPath;
    const path = target || window.missPath || { label: choice, consequence: "此约已错过。", effects: {}, timeAdvanceYears: 0 };
    const option = { label: path.label || (choice === "attend" ? "应约赴会" : choice === "avoid" ? "主动避开" : "闭关错过"), effects: path.effects || {}, failureEffects: path.failureEffects || path.effects || {}, successRate: path.successRate ?? 1, d20: path.d20 || null, semantic: path.semantic || "safe", resultText: path.consequence || path.resultText || "", failureText: path.failureText || path.consequence || "" };
    const resolved = resolveOptionResult(option, state, random, manualRoll);
    const applied = applyEffects(state, attributeConfig, resolved.effects, "window");
    const choiceLabel = option.label || (choice === "attend" ? "应约赴会" : choice === "avoid" ? "主动避开" : "闭关错过");
    const timeAdvance = advanceLedger(path.timeAdvanceYears || 0, {
      source: "event_window",
      eventId: window.eventId,
      eventTitle: window.name,
      windowId: window.id,
      windowName: window.name,
      optionLabel: choiceLabel,
      reason: path.timeAdvanceReason || `处理时间窗「${window.name}」的「${choiceLabel}」分支`,
      basis: path.timeAdvanceBasis || `时间窗依据：事件《${window.name}》· 应期 ${window.dueAge} 岁 · 分支「${choiceLabel}」`
    });
    window.resolved = true;
    window.outcome = choice;
    if (choice === "attend") flags.add(`${window.id}_attended`);
    if (choice === "miss") flags.add(`${window.id}_missed`);
    if (choice === "avoid") flags.add(`${window.id}_avoided`);
    addUnfinished([...window.unfinishedBusiness, ...(path.unfinishedBusiness || [])]);
    addPersonLedger(window.personLedgerEntry);
    if (choice === "avoid" && window.karmaOnAvoid) {
      state.karmaDeferred = { id: `${window.id}_karma`, dueAge: Number(state.age || 0) + 4, resolved: false, sourceWindowId: window.id };
    }
    activeWindow = null;
    scheduleNext();
    return { record: { eventId: window.id, eventTitle: window.name, optionLabel: option.label, success: resolved.success, effects: applied.applied, resultText: resolved.text, d20: resolved.d20, timeAdvance, semantic: option.semantic, riskTag: option.semantic, stageId: currentStage(), bridgeText: path.bridgeText || null }, snapshot: snapshot(), phase, finished: phase === "finished" };
  }

  function resolveKarma(choice, manualRoll) {
    const karma = state.karmaDeferred;
    if (!karma) return { error: "no_active_karma" };
    let option;
    if (choice === "break") option = { label: "破关迎劫", effects: { fame: 8, power: 8 }, failureEffects: { health: -25, sanity: -15 }, d20: { id: "karma_break", target: 16, kind: "breakthrough" }, resultText: "你迎着劫光破关，天道在门前让出一条路。", failureText: "劫光贯穿经脉，你从关口坠落。", semantic: "risky" };
    else if (choice === "suppress") option = { label: "强行压劫", effects: { health: -6, sanity: -8 }, failureEffects: { health: -18, sanity: -16 }, d20: { id: "karma_suppress", target: 13 }, resultText: "你把劫气按回丹田，身上却留下终身黑纹。", failureText: "劫气反噬，黑纹沿经脉炸开。", semantic: "risky" };
    else option = { label: "以命避劫", effects: {}, successRate: 1, resultText: "你以寿命换出一线生机，此劫转入下一世继续回响。", semantic: "sacrifice" };
    const resolved = resolveOptionResult(option, state, random, manualRoll);
    const applied = applyEffects(state, attributeConfig, resolved.effects, "karma");
    let lifespanCost = 0;
    if (choice === "avoid") {
      lifespanCost = Math.max(5, Math.ceil(Number(state.remainingYears || 0) * 0.3));
      state.realmLifespan = Math.max(0, Number(state.realmLifespan || 0) - lifespanCost);
      deriveLedgerState(state);
    }
    if (choice === "suppress" && resolved.success) state.blackMark = true;
    if (choice === "break" && resolved.success) {
      const progress = applyRealmProgress(state, { ...resolved.d20, success: true });
      state.realm = progress?.to || state.realm;
    }
    flags.add(`karma_${choice}`);
    karma.resolved = true;
    scheduleNext();
    return { record: { eventId: karma.id, eventTitle: "劫敲门", optionLabel: option.label, success: resolved.success, effects: applied.applied, resultText: resolved.text, d20: resolved.d20, semantic: option.semantic, riskTag: option.semantic, lifespanCost, stageId: currentStage() }, snapshot: snapshot(), phase, finished: phase === "finished" };
  }

  function resolveCliff(action, manualRoll) {
    if (action === "rescue" && !state.lifespanRescueUsed) {
      state.lifespanRescueUsed = true;
      const nextRealm = REALMS[Math.min(REALMS.length - 1, REALMS.findIndex((realm) => realm.key === state.realm) + 1)];
      const target = nextRealm?.breakthroughTarget || 19;
      const resolved = resolveOptionResult({ label: "以命冲关", effects: { power: 8 }, failureEffects: { health: -100 }, d20: { id: "lifespan_rescue", target, kind: "breakthrough" }, resultText: "你以命叩关，寿元重新燃起。", failureText: "最后一口气散在关口，此生落幕。", semantic: "risky" }, state, random, manualRoll);
      const applied = applyEffects(state, attributeConfig, resolved.effects, "cliff");
      applyRealmProgress(state, resolved.d20);
      if (resolved.success) {
        state.remainingYears = Math.max(1, Number(state.realmLifespan || 0) - Number(state.age || 0));
        state.deathWindowState = deathWindowState(state.remainingYears);
        phase = "event";
        if (!currentEvent) currentEvent = drawEvent();
      } else {
        finished = true;
        phase = "finished";
      }
      return { record: { eventId: "lifespan_rescue", eventTitle: "以命冲关", optionLabel: "以命冲关", success: resolved.success, effects: applied.applied, resultText: resolved.text, d20: resolved.d20, semantic: "risky", stageId: currentStage() }, snapshot: snapshot(), finished, phase };
    }
    finished = true;
    phase = "finished";
    return { snapshot: snapshot(), finished: true, phase };
  }

  function practiceDao(daoId, mode, manualRoll) {
    const record = learningRecords.find((item) => item.id === daoId && item.current !== false);
    if (!record) return { error: "dao_not_available" };
    if (!record.awakened && record.lifeIndex < state.livesInCycle) return { error: "dao_not_awakened" };
    const stageIndex = clamp(Number(record.stageIndex || 0), 0, 3);
    if (stageIndex >= 3) return { error: "dao_complete" };
    const conservative = mode !== "risky";
    const target = conservative ? D20_DIFFICULTIES.easy : (stageIndex >= 2 ? 16 : 13);
    const option = { label: conservative ? "保守练习" : "冒险研修", effects: { power: 8, sanity: -2 }, failureEffects: { health: conservative ? -5 : -12, sanity: conservative ? -4 : -10 }, d20: { id: `dao_${daoId}_${stageIndex}`, target, modifierSource: "aptitude", kind: "study" }, resultText: "研修有进，你对这门道业有了新的领会。", failureText: "研修受阻，经脉与心神都受了损伤。" };
    const resolved = resolveOptionResult(option, state, random, manualRoll);
    const applied = applyEffects(state, attributeConfig, resolved.effects, "study");
    const years = conservative ? 1 : 2;
    const practiceLabel = conservative ? "保守练习" : "冒险研修";
    const timeAdvance = advanceLedger(years, {
      source: "dao_practice",
      daoId,
      daoName: record.name,
      optionLabel: practiceLabel,
      reason: `${practiceLabel}「${record.name}」耗时 ${years} 年`,
      basis: `道业依据：${record.name} · ${practiceLabel}`
    });
    if (resolved.success) {
      record.stageIndex = Math.min(3, stageIndex + 1);
      record.rank = record.stages?.[record.stageIndex] || record.rank;
    }
    const result = { daoId, success: resolved.success, d20: resolved.d20, effects: applied.applied, resultText: resolved.text, timeAdvance, record: clone(record) };
    return { result, snapshot: snapshot(), phase };
  }

  function getFortuneRerolls() {
    return Math.max(0, Number(state.fortuneUsesRemaining || 0));
  }

  function useFortuneReroll(originalRoll) {
    if (!pendingOutcome) return { error: "no_pending_outcome", fortuneUsesRemaining: getFortuneRerolls() };
    if (!pendingOutcome.record?.d20) return { error: "no_rerollable_check", fortuneUsesRemaining: getFortuneRerolls() };
    if (getFortuneRerolls() <= 0) return { error: "no_fortune_rerolls", fortuneUsesRemaining: 0 };
    const reroll = pendingOutcome;
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, clone(reroll.beforeState));
    flags.clear();
    for (const flag of reroll.beforeFlags) flags.add(flag);
    state.fortuneUsesRemaining = Math.max(0, Number(state.fortuneUsesRemaining || 0) - 1);
    pendingOutcome = null;
    const result = chooseOption(reroll.optionIndex, originalRoll);
    if (result.error) return result;
    return { ...result, rerolled: true, fortuneUsesRemaining: getFortuneRerolls() };
  }

  function start() {
    stageIndex = 0;
    eventIndexInStage = 0;
    stageChanged = false;
    finished = false;
    pendingOutcome = null;
    activeWindow = null;
    currentEvent = drawEvent();
    phase = currentEvent ? "event" : "finished";
    return snapshot();
  }

  return {
    start,
    advance,
    chooseOption,
    continueOutcome,
    resolveWindow,
    resolveKarma,
    resolveCliff,
    chooseGrowthAction,
    finishPreparation,
    resolveBreakthrough,
    selectGrowthDao(daoId) {
      if (!hasActivePractice || phase !== "preparation") return { error: "growth_window_not_active" };
      if (!GROWTH_DAOS.includes(daoId)) return { error: "unknown_growth_dao" };
      if (state.growthState.usedActions.length > 0) return { error: "growth_dao_locked_after_action" };
      state.growthState.daoId = daoId;
      return { ok: true, growthState: clone(state.growthState), snapshot: snapshot() };
    },
    practiceDao,
    useFortuneReroll,
    getFortuneRerolls,
    snapshot,
    getCurrentEvent: () => currentEvent,
    getState: () => state,
    getFlags: () => flags,
    getLearningRecords: () => clone(learningRecords),
    getLedger: () => ledgerSnapshot(),
    getPendingWindows: () => clone(pendingWindows)
  };
}

export { createSession, weightedPick, matchesCondition, REALMS, D20_DIFFICULTIES, deathWindowState, rollD20 };
