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

  function buildRunPayload(ending) {
    const snapshot = activeSnapshot();
    const state = session.getState();
    return {
      templateId: template.id,
      startedAt: Date.now(),
      endingId: ending.id,
      endingTitle: ending.label,
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
      session = createSession(template, content);
      const snapshot = session.start();
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
