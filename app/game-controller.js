import { createSession } from "../engine/event-engine.js";
import { judgeEnding } from "../engine/ending-engine.js";
import { createSaveSystem } from "../engine/save-system.js";
import { createAdService } from "./ad-service.js";

/**
 * 页面控制器：把模板、内容包、引擎、存档、广告预留串起来。
 * 界面层只调用这里暴露的方法，不直接操作引擎。
 */

function createGameController({ template, content, storage, adConfig, analytics }) {
  const saveSystem = createSaveSystem(template, storage);
  const adService = createAdService(adConfig);
  const tracker = analytics || { track() {} };
  let session = null;
  let lastResult = null;

  function activeSnapshot() {
    return session ? session.snapshot() : null;
  }

  function clampScore(value, scoreConfig) {
    const min = scoreConfig?.range?.min ?? 0;
    const max = scoreConfig?.range?.max ?? 100;
    return Math.max(min, Math.min(max, Math.round(value)));
  }

  function computeScore(history, ending) {
    const scoreConfig = template.score;
    if (!scoreConfig || scoreConfig.enabled === false) return null;
    const delta = scoreConfig.delta || {};
    let total = scoreConfig.base ?? 0;
    for (const record of history) {
      if (record.riskTag && delta[record.riskTag] != null) total += delta[record.riskTag];
      if (record.success && delta.success != null) total += delta.success;
    }
    const bonus = scoreConfig.endingBonus || {};
    if (ending && bonus[ending.tone] != null) total += bonus[ending.tone];
    return clampScore(total, scoreConfig);
  }

  function buildInheritance(state, ending) {
    const scoreConfig = template.score;
    const inherit = scoreConfig?.reincarnation;
    if (!scoreConfig || scoreConfig.enabled === false || !inherit || inherit.enabled === false) {
      return null;
    }
    const inherits = {};
    for (const key of inherit.inheritAttrs || []) {
      const config = template.attributes[key];
      if (!config) continue;
      const value = Math.floor((state[key] ?? 0) * (inherit.rate ?? 0));
      if (value > 0) inherits[key] = Math.min(value, inherit.cap ?? 12);
    }
    return {
      attrs: inherits,
      score: computeScore(session.snapshot().history, ending)
    };
  }

  function seedForRun() {
    const history = saveSystem.readHistory();
    const latest = history[0];
    if (latest?.inheritance?.attrs && Object.keys(latest.inheritance.attrs).length) {
      return latest.inheritance.attrs;
    }
    return null;
  }

  function buildRunPayload(ending) {
    const snapshot = activeSnapshot();
    const state = session.getState();
    const inheritance = buildInheritance(state, ending);
    return {
      templateId: template.id,
      startedAt: Date.now(),
      endingId: ending.id,
      endingTitle: ending.label,
      score: inheritance ? inheritance.score : null,
      inheritance: inheritance,
      attributes: { ...state },
      flags: session.getFlags() ? [...session.getFlags()] : [],
      history: snapshot ? snapshot.history : [],
      durationMs: 0
    };
  }

  return {
    template,
    content,
    saveSystem,
    adService,

    start() {
      const seed = seedForRun();
      const inheritMap = seed || null;
      if (inheritMap) {
        const baseState = {};
        for (const key of Object.keys(template.attributes || {})) {
          const config = template.attributes[key];
          if (!config) continue;
          const min = config.min ?? 0;
          const max = config.max ?? 100;
          baseState[key] = Math.max(min, Math.min(max, config.init ?? 0));
        }
        const seeded = { ...baseState };
        for (const [key, bonus] of Object.entries(inheritMap)) {
          const config = template.attributes[key];
          if (!config || !(key in seeded)) continue;
          const min = config.min ?? 0;
          const max = config.max ?? 100;
          seeded[key] = Math.max(min, Math.min(max, seeded[key] + bonus));
        }
        session = createSession(template, content, seeded);
      } else {
        session = createSession(template, content);
      }
      const snapshot = session.start();
      snapshot.inherited = inheritMap;
      saveSystem.saveActive(snapshot);
      tracker.track({ type: "run_start" });
      return snapshot;
    },

    resume() {
      const saved = saveSystem.loadActive();
      if (!saved) return this.start();
      session = createSession(template, content, null, saved);
      if (!session.getCurrentEvent()) {
        return this.start();
      }
      tracker.track({ type: "run_resume" });
      return session.snapshot();
    },

    choose(optionIndex) {
      if (!session) return { error: "no_session" };
      const result = session.chooseOption(optionIndex);
      if (result.error) return result;
      saveSystem.saveActive(result.snapshot);
      tracker.track({
        type: "choice",
        eventId: result.record.eventId,
        optionIndex,
        success: result.record.success,
        attributes: result.snapshot.attributes
      });

      if (result.finished) {
        const ending = judgeEnding(template, session.getState(), session.getFlags());
        lastResult = buildRunPayload(ending);
        lastResult.durationMs = Date.now() - lastResult.startedAt;
        saveSystem.saveResult(lastResult);
        saveSystem.clearActive();
        tracker.track({ type: "run_end", endingId: ending.id });
        return { ...result, ending, runResult: lastResult };
      }
      return result;
    },

    current() {
      return session ? { event: session.getCurrentEvent(), snapshot: activeSnapshot() } : null;
    },

    history() {
      return saveSystem.readHistory();
    }
  };
}

export { createGameController };
