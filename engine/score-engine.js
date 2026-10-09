/**
 * R3 score and reincarnation engine.
 * Four sections are capped at 250 each, then routed through the R3
 * calibration table and reallocated so the total always equals the sections.
 * R1/R2 exports remain compatibility shims and are not consumed by new runs.
 */

const SCORE_SECTIONS = Object.freeze(["realm", "story", "living", "legacy"]);
const SCORE_SECTION_MAX = 250;
const SCORE_MAX = SCORE_SECTION_MAX * SCORE_SECTIONS.length;
const POINTS_TABLE = Object.freeze([
  { min: 0, max: 199, points: 0 },
  { min: 200, max: 329, points: 2 },
  { min: 330, max: 459, points: 5 },
  { min: 460, max: 589, points: 8 },
  { min: 590, max: 719, points: 12 },
  { min: 720, max: 849, points: 16 },
  { min: 850, max: 1000, points: 20 }
]);
const FOUR_DIMENSIONS = Object.freeze([
  "naturalTalent",
  "aptitude",
  "bloodline",
  "fortune"
]);
const FOUR_DIM_MAX = 10;
const FOUR_DIM_COST_TABLE = Object.freeze([0, 1, 3, 6, 10, 15, 21, 28, 36, 45, 55]);
const REALM_RANK = Object.freeze({ mortal: 0, qi: 1, foundation: 2, golden: 3, nascent: 4 });
const KEY_STORY_FLAGS = Object.freeze([
  "system_active", "saved_village", "identity_revealed", "gang_founded",
  "returned_earth", "exposed_conspiracy", "rescued_xiaorou", "opened_gate",
  "t1_attended", "t2_avoided"
]);

const DEFAULT_BANDS = Object.freeze({
  ending_g01_gate_opener: { min: 90, max: 100 },
  ending_g02_immortal_peak: { min: 82, max: 94 },
  ending_g03_jianghu_legend: { min: 72, max: 84 },
  ending_g04_dual_return: { min: 68, max: 80 },
  ending_g05_regret: { min: 44, max: 56 },
  ending_g06_fall: { min: 30, max: 42 },
  ending_g07_haunted: { min: 26, max: 38 },
  ending_g08_plain: { min: 18, max: 30 },
  fallback: { min: 18, max: 30 }
});
const DEFAULT_EVIDENCE = Object.freeze({
  riskySuccess: { points: 2, cap: 6 },
  unlockFlagSuccess: { points: 1, cap: 4 },
  dramaticFailure: { points: 1, cap: 2 },
  totalCap: 12
});
const SOUL_POINT_TABLE = Object.freeze([
  { max: 19, points: 0 },
  { max: 39, points: 1 },
  { max: 59, points: 2 },
  { max: 74, points: 3 },
  { max: 89, points: 4 },
  { max: 100, points: 5 }
]);
const ALLOC_TRACKS = Object.freeze(["wealth", "power", "fame", "bond"]);
const ALLOC_PER_TRACK_MAX = 3;
const ALLOC_PER_LIFE_MAX = 5;
const ALLOC_POINT_VALUE = 2;
const ROUTES = Object.freeze(["safe", "mixed", "high_risk"]);
const ROUTE_CAPS = Object.freeze({
  safe: Object.freeze({ realm: 180, story: 190, living: 250, legacy: 240 }),
  mixed: Object.freeze({ realm: 245, story: 250, living: 225, legacy: 245 }),
  high_risk: Object.freeze({ realm: 245, story: 250, living: 180, legacy: 250 })
});
const ROUTE_SHAPE = Object.freeze({
  safe: Object.freeze({ realm: 0.90, story: 0.95, living: 1.08, legacy: 1.15 }),
  mixed: Object.freeze({ realm: 1.00, story: 1.00, living: 1.00, legacy: 1.00 }),
  high_risk: Object.freeze({ realm: 1.15, story: 1.10, living: 0.82, legacy: 0.88 })
});
const SCORE_CALIBRATION = Object.freeze([
  Object.freeze([0, 0]),
  Object.freeze([450, 150]),
  Object.freeze([520, 220]),
  Object.freeze([600, 300]),
  Object.freeze([670, 410]),
  Object.freeze([720, 535]),
  Object.freeze([750, 700]),
  Object.freeze([775, 815]),
  Object.freeze([800, 900]),
  Object.freeze([830, 960]),
  Object.freeze([1000, 1000])
]);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function pointsFor(score) {
  if (score == null || !Number.isFinite(Number(score))) return null;
  const value = clamp(Math.round(Number(score)), 0, SCORE_MAX);
  for (const row of POINTS_TABLE) {
    if (value <= row.max) return row.points;
  }
  return 20;
}

function calibrateScore(rawTotal) {
  const raw = clamp(Number(rawTotal) || 0, 0, SCORE_MAX);
  if (raw <= SCORE_CALIBRATION[0][0]) return SCORE_CALIBRATION[0][1];
  for (let index = 0; index < SCORE_CALIBRATION.length - 1; index += 1) {
    const [leftRaw, leftScore] = SCORE_CALIBRATION[index];
    const [rightRaw, rightScore] = SCORE_CALIBRATION[index + 1];
    if (raw <= rightRaw) {
      const progress = (raw - leftRaw) / (rightRaw - leftRaw);
      return Math.round(leftScore + (rightScore - leftScore) * progress);
    }
  }
  return SCORE_CALIBRATION[SCORE_CALIBRATION.length - 1][1];
}

function allocateScore(total, weights) {
  const source = weights && typeof weights === "object" ? weights : {};
  const target = clamp(Math.round(finiteNumber(total, 0)), 0, SCORE_MAX);
  const safeWeights = {};
  let totalWeight = 0;
  for (const key of SCORE_SECTIONS) {
    const weight = Math.max(0, finiteNumber(source[key], 0));
    safeWeights[key] = weight;
    totalWeight += weight;
  }
  if (totalWeight <= 0) {
    const even = Math.floor(target / SCORE_SECTIONS.length);
    const sections = {};
    for (const key of SCORE_SECTIONS) sections[key] = even;
    let remaining = target - even * SCORE_SECTIONS.length;
    for (const key of SCORE_SECTIONS) {
      if (remaining <= 0) break;
      sections[key] += 1;
      remaining -= 1;
    }
    return sections;
  }
  const exact = {};
  const sections = {};
  for (const key of SCORE_SECTIONS) {
    exact[key] = (target * safeWeights[key]) / totalWeight;
    sections[key] = Math.min(SCORE_SECTION_MAX, Math.floor(exact[key]));
  }
  let remaining = target - sumSections(sections);
  while (remaining > 0) {
    let pick = null;
    let pickScore = -1;
    for (const key of SCORE_SECTIONS) {
      if (sections[key] >= SCORE_SECTION_MAX) continue;
      const score = exact[key] - sections[key];
      if (score > pickScore || (score === pickScore && pick === null)) {
        pick = key;
        pickScore = score;
      }
    }
    if (!pick) break;
    sections[pick] += 1;
    remaining -= 1;
  }
  return sections;
}

function routeForChoice(safe, risky, sacrifice) {
  const safeCount = Math.max(0, Math.round(finiteNumber(safe, 0)));
  const riskyCount = Math.max(0, Math.round(finiteNumber(risky, 0)));
  const sacrificeCount = Math.max(0, Math.round(finiteNumber(sacrifice, 0)));
  if (sacrificeCount >= 3 || riskyCount + sacrificeCount >= 10) return "high_risk";
  if (safeCount >= 11) return "safe";
  return "mixed";
}

function strategyCoherence(choices) {
  const list = Array.isArray(choices) ? choices.filter(Boolean) : [];
  if (list.length < 2) return 1;
  let switches = 0;
  for (let index = 1; index < list.length; index += 1) {
    if (list[index] !== list[index - 1]) switches += 1;
  }
  const safeFraction = list.filter((choice) => choice === "safe").length / list.length;
  const focusedFraction = Math.max(safeFraction, 1 - safeFraction);
  return clamp(0.5 * (1 - switches / 12) + 0.5 * focusedFraction, 0, 1);
}

function routeCapsFor(route) {
  return { ...(ROUTE_CAPS[route] || ROUTE_CAPS.mixed) };
}

function routeShapeFor(route) {
  return { ...(ROUTE_SHAPE[route] || ROUTE_SHAPE.mixed) };
}

function applyRouteCaps(sections, route) {
  const raw = normalizeSections(sections);
  const caps = routeCapsFor(route);
  const capped = {};
  for (const key of SCORE_SECTIONS) capped[key] = Math.min(raw[key], caps[key]);
  return capped;
}

function applyRouteShape(sections, route) {
  const capped = normalizeSections(sections);
  const shape = routeShapeFor(route);
  const shaped = {};
  for (const key of SCORE_SECTIONS) shaped[key] = Math.round(capped[key] * shape[key]);
  return shaped;
}

function resolveRoutedScore(rawSections, route) {
  const actualRoute = ROUTES.includes(route) ? route : "mixed";
  const capped = applyRouteCaps(rawSections, actualRoute);
  const shaped = applyRouteShape(capped, actualRoute);
  const rawTotal = sumSections(shaped);
  const score = calibrateScore(rawTotal);
  const sections = allocateScore(score, shaped);
  return {
    route: actualRoute,
    caps: routeCapsFor(actualRoute),
    shape: routeShapeFor(actualRoute),
    cappedSections: capped,
    shapedSections: shaped,
    rawTotal,
    score,
    total: score,
    sections
  };
}

function normalizeSections(input) {
  const source = input && typeof input === "object" ? input : {};
  const sections = {};
  for (const key of SCORE_SECTIONS) {
    sections[key] = clamp(Math.round(finiteNumber(source[key], 0)), 0, SCORE_SECTION_MAX);
  }
  return sections;
}

function sumSections(sections) {
  return SCORE_SECTIONS.reduce((sum, key) => sum + finiteNumber(sections?.[key], 0), 0);
}

function asSet(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  if (value && typeof value === "object") return new Set(Object.keys(value));
  return new Set();
}

function endingTone(ending) {
  return ending?.tone || "neutral";
}

function endingBasePoints(ending) {
  if (endingTone(ending) === "bright") return 70;
  if (endingTone(ending) === "warm") return 58;
  if (endingTone(ending) === "dark") return 28;
  return 34;
}

function passageReward(context, key, fallback) {
  const marker = context?.timeWindows?.[key];
  const state = context?.timeWindowState?.[key] || context?.windowState?.[key];
  const status = typeof marker === "string" ? marker : marker?.status || state;
  if (["resolved", "attended", "success"].includes(status)) return fallback;
  if (["missed", "avoided", "failed"].includes(status)) return Math.round(fallback * 0.25);
  return Math.round(fallback * 0.55);
}

function scoreFromContext(choiceLog, ending, context) {
  const records = Array.isArray(choiceLog) ? choiceLog.filter(Boolean) : [];
  const state = context?.state || context?.attributes || {};
  const flags = asSet(context?.flags);
  const learningRecords = Array.isArray(context?.learningRecords)
    ? context.learningRecords
    : Array.isArray(context?.learning_records)
      ? context.learning_records
      : [];
  const successCount = records.filter((record) => record.success).length;
  const failureCount = records.length - successCount;
  const unlockCount = records.filter((record) => record.success && record.unlockFlag).length;
  const powerRatio = clamp(finiteNumber(state.power, 0) / 100, 0, 1);
  const healthRatio = clamp(finiteNumber(state.health, 100) / 100, 0, 1);
  const sanityRatio = clamp(finiteNumber(state.sanity, 100) / 100, 0, 1);
  const bondRatio = clamp(finiteNumber(state.bond, 0) / 100, 0, 1);
  const realmKey = context?.realm || state.realm || "mortal";
  const realmRank = REALM_RANK[realmKey] ?? 0;
  const breakthroughCount = Math.max(
    Number(context?.breakthroughs) || 0,
    [...flags].filter((flag) => flag.startsWith("realm_breakthrough")).length
  );
  const sacrificeSuccesses = records.filter((record) => record.success && record.semantic === "sacrifice").length;
  const keyFlags = [...flags].filter((flag) => KEY_STORY_FLAGS.includes(flag)).length;
  const windowReward = passageReward(context, "t1", 50) + passageReward(context, "t2", 50);
  const realmLifespan = Math.max(1, Number(context?.realmLifespan) || 100);
  const remainingYears = clamp(
    Number.isFinite(Number(context?.remainingYears))
      ? Number(context.remainingYears)
      : realmLifespan - finiteNumber(context?.age, 16),
    0,
    realmLifespan
  );
  const longevityRatio = clamp(remainingYears / realmLifespan, 0, 1);
  const learnedStages = learningRecords.reduce(
    (sum, record) => sum + Math.max(0, Number(record?.stageIndex ?? record?.stageValue ?? 0) || 0),
    0
  );
  const awakenedCount = learningRecords.filter((record) => record?.awakened).length;
  const memoryFragments = context?.memoryFragments || context?.memory_fragments || [];
  const unfinishedBusiness = context?.unfinishedBusiness || context?.unfinished_business || [];
  const deathWindowState = context?.deathWindowState || context?.death_window_state || "ok";
  const exhaustedPenalty = deathWindowState === "exhausted" ? 60 : 0;

  const realm = clamp(
    24 + realmRank * 38 + Math.round(powerRatio * 62) + Math.min(breakthroughCount, 2) * 25
      + Math.min(sacrificeSuccesses, 2) * 18
      + (flags.has("magicCoreSealed") ? 12 : 0)
      + (flags.has("skyGateOpened") ? 12 : 0),
    0,
    SCORE_SECTION_MAX
  );
  const story = clamp(
    endingBasePoints(ending)
      + Math.round((successCount / Math.max(1, records.length)) * 52)
      + Math.min(keyFlags, 8) * 11
      + Math.min(unlockCount, 8) * 4
      + windowReward
      - Math.min(failureCount, 8) * 3,
    0,
    SCORE_SECTION_MAX
  );
  const living = clamp(
    42 + Math.round(healthRatio * 62) + Math.round(sanityRatio * 54)
      + Math.round(longevityRatio * 72) - exhaustedPenalty,
    0,
    SCORE_SECTION_MAX
  );
  const legacy = clamp(
    24 + Math.min(learnedStages, 5) * 24 + Math.min(awakenedCount, 3) * 12
      + Math.min(memoryFragments.length, 4) * 10
      + Math.min(unfinishedBusiness.length, 5) * 5
      + Math.round(bondRatio * 42)
      + (endingTone(ending) === "bright" ? 15 : endingTone(ending) === "warm" ? 10 : 0),
    0,
    SCORE_SECTION_MAX
  );
  return { realm, story, living, legacy };
}

function buildReasons(sections, choiceLog, ending, context) {
  const records = Array.isArray(choiceLog) ? choiceLog.filter(Boolean) : [];
  const successCount = records.filter((record) => record.success).length;
  const failureCount = records.length - successCount;
  const state = context?.state || context?.attributes || {};
  const flags = asSet(context?.flags);
  const realmKey = context?.realm || state.realm || "mortal";
  const learningRecords = Array.isArray(context?.learningRecords)
    ? context.learningRecords
    : Array.isArray(context?.learning_records)
      ? context.learning_records
      : [];
  const deathWindowState = context?.deathWindowState || context?.death_window_state || "ok";
  return {
    realm: [
      `境界 ${realmKey} 与修为积累计入 ${sections.realm}/250`,
      (Number(context?.breakthroughs) || [...flags].some((flag) => flag.startsWith("realm_breakthrough")))
        ? "破境与关键修为止损留下加分"
        : "未完成破境，修为段缺少高价值里程碑"
    ],
    story: [
      `${successCount} 次成功抉择、${failureCount} 次失败形成故事轨迹`,
      [...flags].some((flag) => KEY_STORY_FLAGS.includes(flag))
        ? "关键剧情标记已承接"
        : "关键剧情标记不足，故事段被扣减",
      ending?.id ? `结局 ${ending.id} 的收束质量已计入` : "缺少有效结局，故事段取基础值"
    ],
    living: [
      `健康 ${finiteNumber(state.health, 100)}、理智 ${finiteNumber(state.sanity, 100)} 影响活况分`,
      deathWindowState === "exhausted"
        ? "寿元耗尽，活况段重扣 60 分"
        : `当前寿元状态为 ${deathWindowState}`
    ],
    legacy: [
      learningRecords.length
        ? `${learningRecords.length} 条道业记录计入传承`
        : "本世未沉淀道业，传承段仅保留基础分",
      flags.size ? `世界后果与人物痕迹 ${flags.size} 项` : "世界后果与人际痕迹不足"
    ]
  };
}

function computeScore(choiceLog, ending, context) {
  const safeContext = context && typeof context === "object" ? context : {};
  const explicit = safeContext.scoreSections || safeContext.resolvedSections;
  if (explicit) {
    const sections = normalizeSections(explicit);
    const score = sumSections(sections);
    return {
      score,
      total: score,
      sections: { ...sections },
      rawSections: { ...sections },
      shapedSections: { ...sections },
      rawTotal: score,
      route: safeContext.route || null,
      coherence: safeContext.coherence ?? null,
      reasons: buildReasons(sections, choiceLog, ending, safeContext),
      endingId: ending?.id || "fallback",
      maxScore: SCORE_MAX
    };
  }
  const rawSections = safeContext.rawSections || scoreFromContext(choiceLog, ending, safeContext);
  const route = safeContext.route || safeContext.actualRoute;
  const routed = route ? resolveRoutedScore(rawSections, route) : null;
  const sections = routed ? routed.sections : normalizeSections(rawSections);
  const score = sumSections(sections);
  return {
    score,
    total: score,
    sections: { ...sections },
    rawSections: routed ? routed.cappedSections : { ...sections },
    shapedSections: routed ? routed.shapedSections : { ...sections },
    rawTotal: routed ? routed.rawTotal : score,
    route: routed ? routed.route : route || null,
    caps: routed ? routed.caps : null,
    shape: routed ? routed.shape : null,
    coherence: safeContext.coherence ?? null,
    reasons: buildReasons(sections, choiceLog, ending, safeContext),
    endingId: ending?.id || "fallback",
    maxScore: SCORE_MAX
  };
}

function formatSectionBars(sections) {
  const safe = normalizeSections(sections);
  return SCORE_SECTIONS.map((key) => ({ key, value: safe[key], max: SCORE_SECTION_MAX }));
}

function costForLevel(level) {
  return FOUR_DIM_COST_TABLE[clamp(Math.round(finiteNumber(level, 0)), 0, FOUR_DIM_MAX)];
}

function normalizeFourDims(levels) {
  const result = {};
  for (const key of FOUR_DIMENSIONS) {
    result[key] = clamp(Math.round(finiteNumber(levels?.[key], 0)), 0, FOUR_DIM_MAX);
  }
  return result;
}

function totalAllocationCost(levels) {
  const normalized = normalizeFourDims(levels);
  return FOUR_DIMENSIONS.reduce((sum, key) => sum + costForLevel(normalized[key]), 0);
}

function validateFourDimAllocation(levels, availablePoints) {
  const normalized = normalizeFourDims(levels);
  const errors = [];
  const available = clamp(Math.round(finiteNumber(availablePoints, 0)), 0, 20);
  const totalCost = totalAllocationCost(normalized);
  for (const key of Object.keys(levels || {})) {
    if (!FOUR_DIMENSIONS.includes(key)) errors.push(`${key} 不可投入`);
  }
  if (totalCost > available) errors.push("单世四维分配超出可用轮回点数");
  return { ok: errors.length === 0, errors, levels: normalized, totalCost, remaining: Math.max(0, available - totalCost) };
}

function birthTier(value) {
  const level = clamp(Math.round(finiteNumber(value, 0)), 0, FOUR_DIM_MAX);
  return level <= 2 ? "低" : level <= 6 ? "中" : "高";
}

function normalizeBands(configBands) {
  const bands = {};
  if (Array.isArray(configBands)) {
    for (const band of configBands) {
      if (band?.endingId) bands[band.endingId] = { label: band.label || null, min: band.min ?? 0, max: band.max ?? 100 };
    }
  } else if (configBands && typeof configBands === "object") {
    for (const [id, band] of Object.entries(configBands)) {
      bands[id] = { label: band.label || null, min: band.min ?? 0, max: band.max ?? 100 };
    }
  }
  return bands;
}

function evidenceFor(history, rules) {
  const rule = rules || {};
  const risky = rule.riskySuccess || {};
  const unlock = rule.unlockFlagSuccess || {};
  const failure = rule.dramaticFailure || {};
  let riskySuccess = 0;
  let unlockFlagSuccess = 0;
  let dramaticFailure = 0;
  for (const record of history || []) {
    if (!record) continue;
    if (record.success) {
      if (record.riskTag === "risky") riskySuccess += 1;
      if (record.unlockFlag) unlockFlagSuccess += 1;
    } else if (["risky", "sacrifice", "custom"].includes(record.riskTag)) dramaticFailure += 1;
  }
  const riskyPoints = Math.min(riskySuccess * (risky.points ?? 2), risky.cap ?? 6);
  const unlockPoints = Math.min(unlockFlagSuccess * (unlock.points ?? 1), unlock.cap ?? 4);
  const failurePoints = Math.min(dramaticFailure * (failure.points ?? 1), failure.cap ?? 2);
  return { riskySuccess: riskyPoints, unlockFlagSuccess: unlockPoints, dramaticFailure: failurePoints, total: Math.min(riskyPoints + unlockPoints + failurePoints, rule.totalCap ?? 12) };
}

function soulPointsFor(score) {
  if (score == null || Number.isNaN(Number(score))) return null;
  const value = clamp(Math.round(Number(score)), 0, 100);
  for (const row of SOUL_POINT_TABLE) if (value <= row.max) return row.points;
  return 0;
}

function validateSoulAllocation(bonuses, soulPoints) {
  const errors = [];
  const safeBonuses = {};
  let total = 0;
  for (const [track, points] of Object.entries(bonuses || {})) {
    const value = Math.max(0, Math.round(Number(points) || 0));
    if (!ALLOC_TRACKS.includes(track)) {
      errors.push(`${track} 不可投入`);
      continue;
    }
    if (value > ALLOC_PER_TRACK_MAX) {
      errors.push(`${track} 单轨最多 ${ALLOC_PER_TRACK_MAX} 点`);
      continue;
    }
    safeBonuses[track] = value;
    total += value;
  }
  if (total > Math.min(ALLOC_PER_LIFE_MAX, soulPoints ?? 0)) errors.push("单世分配点数超出可支配轮回点数");
  return { ok: errors.length === 0, errors, bonuses: safeBonuses, total };
}

export {
  SCORE_SECTIONS, SCORE_SECTION_MAX, SCORE_MAX, POINTS_TABLE,
  FOUR_DIMENSIONS, FOUR_DIM_MAX, FOUR_DIM_COST_TABLE, REALM_RANK,
  pointsFor, computeScore, normalizeSections, sumSections, formatSectionBars,
  costForLevel, totalAllocationCost, validateFourDimAllocation, birthTier,
  soulPointsFor, validateSoulAllocation, evidenceFor, DEFAULT_BANDS,
  ALLOC_TRACKS, ALLOC_PER_TRACK_MAX, ALLOC_PER_LIFE_MAX, ALLOC_POINT_VALUE,
  SCORE_CALIBRATION, ROUTES, ROUTE_CAPS, ROUTE_SHAPE,
  calibrateScore, allocateScore, routeForChoice, strategyCoherence,
  routeCapsFor, routeShapeFor, applyRouteCaps, applyRouteShape, resolveRoutedScore
};
