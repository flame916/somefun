/**
 * 数值系统：按模板配置初始化、应用增量、钳制上下限。
 * 引擎不感知具体属性名，属性全部来自模板配置。
 */

function createAttributes(attributeConfig) {
  const state = {};
  const meta = {};
  for (const [id, config] of Object.entries(attributeConfig || {})) {
    const min = config.min ?? 0;
    const max = config.max ?? 100;
    const init = clamp(config.init ?? 0, min, max);
    state[id] = init;
    meta[id] = {
      label: config.label || id,
      min,
      max,
      group: config.group || "growth",
      displayOrder: config.displayOrder ?? 99,
      color: config.color || "#64748b",
      decayOnZero: config.decayOnZero ?? false
    };
  }
  return { state, meta };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function applyEffects(state, attributeConfig, effects, source = "engine") {
  const applied = {};
  const warnings = [];
  for (const [key, delta] of Object.entries(effects || {})) {
    if (!(key in state)) {
      continue;
    }
    const config = attributeConfig[key] || {};
    const min = config.min ?? 0;
    const max = config.max ?? 100;
    const before = state[key];
    const after = clamp(before + delta, min, max);
    state[key] = after;
    applied[key] = after - before;
    if (config.group === "state" && after <= min && delta < 0) {
      warnings.push(`${config.label || key} 已降至最低`);
    }
  }
  return { applied, warnings };
}

export { createAttributes, applyEffects, clamp };
