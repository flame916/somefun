"use strict";

/**
 * 结局判定：按模板结局配置顺序，多条件支持 any/all/threshold/flag/fallback。
 * 内容包只提供结局卡片文案，判定规则全部来自模板配置。
 */

function compareValue(actual, op, value) {
  switch (op) {
    case "gte": return actual >= value;
    case "gt": return actual > value;
    case "lte": return actual <= value;
    case "lt": return actual < value;
    case "eq": return actual === value;
    case "between": return actual >= (value ?? -Infinity) && actual <= value;
    default: return false;
  }
}

function evaluateConditions(conditions, state, flags) {
  const mode = conditions.mode || "all";
  if (mode === "fallback") return true;

  const thresholds = conditions.thresholds || [];
  if (mode === "threshold") {
    const passed = thresholds.filter((t) =>
      t.attribute in state && compareValue(state[t.attribute], t.op, t.value)
    );
    const needed = conditions.countOfThresholds || thresholds.length || 1;
    return passed.length >= needed;
  }
  if (mode === "flag") {
    return (conditions.requiredFlags || []).every((flag) => flags.has(flag));
  }
  if (mode === "any") {
    return thresholds.some((t) =>
      t.attribute in state && compareValue(state[t.attribute], t.op, t.value)
    ) || (conditions.requiredFlags || []).some((flag) => flags.has(flag));
  }
  return thresholds.every((t) =>
    t.attribute in state && compareValue(state[t.attribute], t.op, t.value)
  ) && (conditions.requiredFlags || []).every((flag) => flags.has(flag));
}

function judgeEnding(config, state, flags) {
  const endings = Object.entries(config.endings || {});
  for (const [endingId, ending] of endings) {
    if (ending.conditions && evaluateConditions(ending.conditions, state, flags)) {
      return {
        id: endingId,
        label: ending.label,
        description: ending.description,
        tone: ending.tone || "neutral"
      };
    }
  }
  return {
    id: "unknown",
    label: "未知",
    description: "没有匹配到结局条件。",
    tone: "neutral"
  };
}

module.exports = { judgeEnding, evaluateConditions };
