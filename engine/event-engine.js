import { createAttributes, applyEffects } from "./attributes.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function shuffle(list, random) {
  const rand = typeof random === "function" ? random : Math.random;
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function weightedPick(items, key = "weight", random) {
  const rand = typeof random === "function" ? random : Math.random;
  if (!items.length) return null;
  const total = items.reduce((sum, item) => sum + Math.max(0, item[key] ?? 1), 0);
  if (total <= 0) return items[0];
  let roll = rand() * total;
  for (const item of items) {
    roll -= Math.max(0, item[key] ?? 1);
    if (roll <= 0) return item;
  }
  return items[items.length - 1];
}

function matchesCondition(condition, state, flags) {
  if (!condition) return true;
  if (condition.minAge != null && (state.age ?? 0) < condition.minAge) return false;

  const requiredAttribute = condition.requiredAttribute;
  if (requiredAttribute && requiredAttribute.name in state) {
    const value = state[requiredAttribute.name];
    if (requiredAttribute.min != null && value < requiredAttribute.min) return false;
    if (requiredAttribute.max != null && value > requiredAttribute.max) return false;
  }
  if (condition.requiredFlag && !flags.has(condition.requiredFlag)) return false;
  if (condition.requiredAnyFlag && condition.requiredAnyFlag.length) {
    if (!condition.requiredAnyFlag.some((flag) => flags.has(flag))) return false;
  }
  if (condition.requiredAllFlags) {
    if (!condition.requiredAllFlags.every((flag) => flags.has(flag))) return false;
  }
  return true;
}

function resolveOptionResult(option, roll) {
  const rate = option.successRate == null ? 1 : option.successRate;
  const success = roll <= rate;
  const base = option.successRateBase;
  let adjustedRate = rate;
  if (base != null) {
    const shift = option.successRateShift ?? 0;
    const counter = eventCounterStyleFor(option);
    adjustedRate = base + (counter === "win" ? shift : counter === "lose" ? -shift : 0);
    adjustedRate = Math.max(0.2, Math.min(0.9, adjustedRate));
  }
  const actualRate = base != null ? adjustedRate : rate;
  const successByActual = roll <= actualRate;
  return {
    success: base != null ? successByActual : success,
    effects: (base != null ? successByActual : success)
      ? option.effects || {}
      : option.failureEffects || option.effects || {},
    text: (base != null ? successByActual : success)
      ? option.resultText || ""
      : option.failureText || option.resultText || "",
    riskTag: option.riskTag || (actualRate < 1 ? "risky" : "safe")
  };
}

function eventCounterStyleFor(option) {
  const style = option.style;
  if (!style) return null;
  const beats = option.beats || [];
  const loses = option.losesTo || [];
  if (beats.includes(style) || loses.includes(style)) {
    return beats.includes(style) ? "win" : "lose";
  }
  return null;
}

function resolveBeats(option) {
  const style = option.style;
  if (!style) return null;
  const beats = option.beats || [];
  const loses = option.losesTo || [];
  if (beats.includes(style)) return "win";
  if (loses.includes(style)) return "lose";
  return null;
}

function createSession(config, content, seedState, restoreData, randomFn) {
  const template = clone(config);
  const pack = clone(content);
  const engine = template.engine;
  const random = typeof randomFn === "function" ? randomFn : Math.random;
  const stageSequence = engine.stageSequence.slice();
  const counts = engine.eventsPerStage || {};
  const attributeConfig = template.attributes;
  const attrs = createAttributes(attributeConfig);
  const state = { ...attrs.state, ...(seedState || {}) };
  const ageConfig = engine.age || {};
  if (ageConfig.enabled !== false && state.age == null) {
    state.age = ageConfig.start ?? 12;
  }
  const flags = new Set();

  const usedEventIds = new Set(restoreData?.usedEventIds || []);
  const poolByStage = new Map();
  for (const event of pack.events) {
    if (!poolByStage.has(event.stage)) poolByStage.set(event.stage, []);
    poolByStage.get(event.stage).push(event);
  }

  const history = restoreData?.history ? clone(restoreData.history) : [];
  let stageIndex = restoreData?.stageIndex ?? 0;
  let eventIndexInStage = restoreData?.eventIndexInStage ?? 0;
  let currentEvent = restoreData?.currentEventId
    ? pack.events.find((event) => event.id === restoreData.currentEventId) || null
    : null;

  if (restoreData?.state) {
    Object.assign(state, restoreData.state);
  }
  for (const flag of restoreData?.flags || []) {
    flags.add(flag);
  }

  function currentStage() {
    return stageSequence[stageIndex] || null;
  }

  function refreshAgeForStage() {
    if (ageConfig.enabled === false || !ageConfig.stepPerStage) return;
    let age = ageConfig.start ?? state.age ?? 12;
    for (let i = 0; i < stageIndex; i += 1) {
      age += ageConfig.stepPerStage[stageSequence[i]] || 0;
    }
    state.age = age;
  }

  function targetCountForStage(stageId) {
    const stageConfig = template.stages?.[stageId];
    const countConfig = counts[stageId] || {};
    const max = countConfig.max ?? stageConfig?.maxEvents ?? 4;
    const min = countConfig.min ?? stageConfig?.minEvents ?? Math.min(max, 3);
    const pool = poolByStage.get(stageId) || [];
    return Math.min(max, Math.max(min, pool.length));
  }

  function drawEvent() {
    const stageId = currentStage();
    if (!stageId) return null;

    const guaranteed = (engine.guaranteedEvents || {})[stageId] || [];
    const guaranteedEvent = guaranteed
      .map((id) => pack.events.find((event) => event.id === id))
      .find((event) => event && !usedEventIds.has(event.id) && matchesCondition(event.conditions, state, flags));
    if (guaranteedEvent) {
      usedEventIds.add(guaranteedEvent.id);
      eventIndexInStage += 1;
      currentEvent = guaranteedEvent;
      return guaranteedEvent;
    }

    let pool = (poolByStage.get(stageId) || []).filter((event) =>
      matchesCondition(event.conditions, state, flags)
    );
    if (engine.noRepeatWithinRun !== false) {
      pool = pool.filter((event) => !usedEventIds.has(event.id));
    }
    if (!pool.length) {
      pool = (poolByStage.get(stageId) || []).filter(
        (event) => !usedEventIds.has(event.id) && matchesCondition(event.conditions, state, flags)
      );
    }
    if (!pool.length) return null;
    const picked =
      engine.weightedDraw === false
        ? shuffle(pool, random)[0]
        : weightedPick(pool, "weight", random);
    usedEventIds.add(picked.id);
    eventIndexInStage += 1;
    currentEvent = picked;
    return picked;
  }

  function snapshot() {
    const stageId = currentStage();
    return {
      templateId: template.id,
      stageId,
      stageIndex,
      currentEventId: currentEvent?.id || null,
      stageLabel: stageId ? template.stages?.[stageId]?.label || stageId : null,
      stageProgress: stageId
        ? `${Math.min(eventIndexInStage, targetCountForStage(stageId))}/${targetCountForStage(stageId)}`
        : "0/0",
      totalEvents: history.length + (currentEvent ? 1 : 0),
      maxEvents: engine.maxEvents,
      attributes: { ...state },
      flags: [...flags],
      history: history.slice(),
      usedEventIds: [...usedEventIds],
      state: { ...state }
    };
  }

  function chooseOption(optionIndex, roll) {
    if (!currentEvent) return { error: "no_active_event" };
    const option = currentEvent.options[optionIndex];
    if (!option) return { error: "invalid_option" };

    const previousStage = currentStage();
    const chosenRoll = roll == null ? random() : roll;
    const result = resolveOptionResult(option, chosenRoll);
    const { applied, warnings } = applyEffects(state, attributeConfig, result.effects, "option");

    if (result.success && option.unlockFlag) {
      flags.add(option.unlockFlag);
    }
    if (option.nextEvent) {
      usedEventIds.delete(option.nextEvent);
    }

    const record = {
      eventId: currentEvent.id,
      eventTitle: currentEvent.title,
      optionIndex,
      optionLabel: option.label,
      success: result.success,
      successRate: option.successRate == null ? 1 : option.successRate,
      effects: applied,
      resultText: result.text,
      riskTag: result.riskTag,
      stageId: previousStage
    };
    history.push(record);

    const done = eventIndexInStage >= targetCountForStage(previousStage);
    const next = option.nextEvent || null;

    if (next) {
      usedEventIds.delete(next);
      currentEvent = pack.events.find((event) => event.id === next) || null;
      eventIndexInStage += 1;
      return {
        record,
        next,
        warnings,
        stageChanged: previousStage !== currentStage(),
        finished: false,
        snapshot: snapshot()
      };
    }

    if (done && stageIndex < stageSequence.length - 1) {
      stageIndex += 1;
      eventIndexInStage = 0;
      refreshAgeForStage();
      currentEvent = drawEvent();
    } else if (done || history.length >= engine.maxEvents) {
      currentEvent = null;
    } else {
      currentEvent = drawEvent();
    }
    const finished = !currentEvent;
    return {
      record,
      next: null,
      warnings,
      stageChanged: previousStage !== currentStage(),
      finished,
      snapshot: snapshot()
    };
  }

  function start() {
    stageIndex = 0;
    eventIndexInStage = 0;
    refreshAgeForStage();
    currentEvent = drawEvent();
    return snapshot();
  }

  return {
    start,
    chooseOption,
    snapshot,
    getCurrentEvent: () => currentEvent,
    getState: () => state,
    getFlags: () => flags
  };
}

export { createSession, weightedPick, matchesCondition };
