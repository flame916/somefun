import { createSession } from "../engine/event-engine.js?v=20260930-r31-feedback2";
import { judgeEnding } from "../engine/ending-engine.js";
import { createSaveSystem, migrateSave } from "../engine/save-system.js";
import { createAdService } from "./ad-service.js";
import { computeScore, pointsFor, validateFourDimAllocation, FOUR_DIMENSIONS, birthTier } from "../engine/score-engine.js";

function createGameController({ template, content, storage, adConfig, analytics }) {
  const runtimeContent = {
    ...content,
    events: (content.events || []).map((event) => ({
      ...event,
      options: (event.options || []).map((option, index) => ({
        ...option,
        ...(content.optionFeedback?.[event.id]?.[index] || {})
      }))
    }))
  };
  const saveSystem = createSaveSystem(template, storage);
  const adService = createAdService(adConfig);
  const tracker = analytics || { track() {} };
  const allocationKey = "fourDimAllocation";
  const birthProfileKey = "birthProfile";
  let session = null;
  let lastResult = null;
  let runStartedAt = Date.now();

  function snapshot() { return session?.snapshot() || null; }
  function state() { return session?.getState() || {}; }
  function flags() { return session?.getFlags() || new Set(); }

  function readPendingFourDims() {
    const stored = saveSystem.raw().get(allocationKey);
    if (!stored || typeof stored !== "object") return null;
    const levels = stored.levels || stored.fourDims || stored;
    const normalized = {};
    for (const key of FOUR_DIMENSIONS) normalized[key] = Math.max(0, Math.min(10, Math.round(Number(levels?.[key]) || 0)));
    const check = validateFourDimAllocation(normalized, stored.points ?? 20);
    return check.ok ? { levels: normalized, points: stored.points ?? 20, cost: check.totalCost } : null;
  }

  function normalizeR3Save(saved) {
    if (!saved || typeof saved !== "object") return saved;
    const state = saved.state && typeof saved.state === "object" ? saved.state : {};
    const fourDims = {
      naturalTalent: 0,
      aptitude: 0,
      bloodline: 0,
      fortune: 0,
      ...(saved.fourDims || {})
    };
    const pendingOutcome = saved.pendingOutcome || null;
    const phase = saved.phase === "outcome" && !pendingOutcome ? "event" : saved.phase || "event";
    const normalized = {
      ...saved,
      version: 3,
      phase,
      pendingOutcome,
      timeline: Array.isArray(saved.timeline) ? saved.timeline : [],
      pendingWindows: Array.isArray(saved.pendingWindows) ? saved.pendingWindows : [],
      learningRecords: Array.isArray(saved.learningRecords) ? saved.learningRecords : [],
      memoryFragments: Array.isArray(saved.memoryFragments) ? saved.memoryFragments : [],
      unfinishedBusiness: Array.isArray(saved.unfinishedBusiness) ? saved.unfinishedBusiness : [],
      personLedger: Array.isArray(saved.personLedger) ? saved.personLedger : [],
      fourDims,
      checkPenalty: saved.checkPenalty || state.checkPenalty || {},
      karmaDeferred: saved.karmaDeferred || state.karmaDeferred || null,
      blackMark: saved.blackMark === true || state.blackMark === true,
      state: {
        ...state,
        worldYear: Number.isFinite(Number(state.worldYear)) ? Number(state.worldYear) : 1,
        checkPenalty: state.checkPenalty || saved.checkPenalty || {},
        karmaDeferred: state.karmaDeferred || saved.karmaDeferred || null,
        blackMark: state.blackMark === true || saved.blackMark === true
      }
    };
    if (normalized.fortuneUsesRemaining == null && state.fortuneUsesRemaining != null) {
      normalized.fortuneUsesRemaining = state.fortuneUsesRemaining;
    }
    if (normalized.fortuneUsesRemaining == null) {
      normalized.fortuneUsesRemaining = Math.min(5, Math.floor(Number(fourDims.fortune || 0) / 2));
    }
    return normalized;
  }

  function rememberActive(nextSnapshot) {
    if (nextSnapshot) saveSystem.saveActive({ ...nextSnapshot, version: 3 });
  }

  function buildRunPayload(ending) {
    const current = snapshot();
    const context = {
      state: state(),
      flags: flags(),
      learningRecords: session?.getLearningRecords() || [],
      realm: state().realm,
      realmLifespan: state().realmLifespan,
      age: state().age,
      remainingYears: state().remainingYears,
      deathWindowState: state().deathWindowState,
      breakthroughs: current?.history?.filter((item) => item.realmProgress?.changed).length || 0,
      pendingWindows: session?.getPendingWindows() || [],
      timeWindows: Object.fromEntries((session?.getPendingWindows() || []).map((window) => [window.id, window.resolved ? window.outcome : "open"])),
      memoryFragments: state().memoryFragments,
      unfinishedBusiness: state().unfinishedBusiness
    };
    const scoreDetail = computeScore(current?.history || [], ending, context);
    const pointsEarned = pointsFor(scoreDetail.score);
    const run = {
      version: 3,
      templateId: template.id,
      startedAt: runStartedAt,
      endedAt: Date.now(),
      durationMs: Date.now() - runStartedAt,
      endingId: ending.id,
      endingTitle: ending.label,
      endingTone: ending.tone || "neutral",
      score: scoreDetail.score,
      scoreDetail,
      pointsEarned,
      sections: scoreDetail.sections,
      reasons: scoreDetail.reasons,
      cycle: state().cycle || 1,
      livesInCycle: state().livesInCycle || 1,
      attributes: current?.attributes || {},
      ledger: current?.ledger || null,
      flags: current?.flags || [],
      history: current?.history || [],
      timeline: current?.timeline || [],
      learningRecords: session?.getLearningRecords() || [],
      fourDims: current?.fourDims || {},
      unfinishedBusiness: state().unfinishedBusiness || [],
      memoryFragments: state().memoryFragments || [],
      personLedger: state().personLedger || []
    };
    return run;
  }

  function finishRun() {
    if (lastResult) return lastResult;
    const ending = judgeEnding(template, state(), flags());
    lastResult = buildRunPayload(ending);
    saveSystem.saveResult(lastResult);
    saveSystem.clearActive();
    tracker.track({ type: "run_end", endingId: ending.id, score: lastResult.score, points: lastResult.pointsEarned });
    return lastResult;
  }

  function consume(result) {
    if (result?.snapshot) rememberActive(result.snapshot);
    if (result?.kind === "finished") {
      const runResult = finishRun();
      return { ...result, runResult, ending: { id: runResult.endingId, label: runResult.endingTitle, tone: runResult.endingTone } };
    }
    return result;
  }

  return {
    template,
    content,
    saveSystem,
    adService,

    start(options = {}) {
      const pending = readPendingFourDims();
      const pendingProfile = saveSystem.raw().get(birthProfileKey);
      const previous = saveSystem.readHistory()[0];
      const nextLife = Math.max(1, Number(previous?.livesInCycle || 0) + (previous ? 1 : 0));
      const previousRecords = Array.isArray(previous?.learningRecords)
        ? previous.learningRecords.map((record) => ({ ...record, current: false }))
        : [];
      const currentRecords = (template.learningSystem?.initialRecords || []).map((record) => ({
        ...record,
        lifeIndex: nextLife,
        current: true
      }));
      const worldYear = previous?.worldYear ?? previous?.ledger?.worldYear ?? previous?.state?.worldYear;
      const seed = {
        cycle: previous?.cycle || 1,
        livesInCycle: nextLife,
        fourDims: pending?.levels || { naturalTalent: 0, aptitude: 0, bloodline: 0, fortune: 0 },
        birthProfile: pendingProfile || null,
        powerSource: pendingProfile?.source || (nextLife === 1 ? "system" : "传承"),
        learningRecords: [...previousRecords, ...currentRecords],
        memoryFragments: previous?.memoryFragments || [],
        unfinishedBusiness: previous?.unfinishedBusiness || [],
        personLedger: previous?.personLedger || [],
        timeline: previous?.timeline || [],
        ...(worldYear == null ? {} : { worldYear })
      };
      session = createSession(template, runtimeContent, seed, null, options.random);
      lastResult = null;
      runStartedAt = Date.now();
      const started = session.start();
      if (pending) saveSystem.raw().remove(allocationKey);
      saveSystem.raw().remove(birthProfileKey);
      rememberActive(started);
      tracker.track({ type: "run_start", life: nextLife, fourDims: seed.fourDims });
      return started;
    },

    resume(options = {}) {
      const saved = normalizeR3Save(migrateSave(saveSystem.loadActive()));
      if (!saved) return this.start(options);
      session = createSession(template, runtimeContent, null, saved, options.random);
      lastResult = null;
      runStartedAt = Number(saved.startedAt) || Date.now();
      if (saved.phase === "finished") {
        const runResult = finishRun();
        return {
          kind: "finished",
          snapshot: session.snapshot(),
          runResult,
          ending: { id: runResult.endingId, label: runResult.endingTitle, tone: runResult.endingTone }
        };
      }
      if (saved.phase === "outcome" && saved.pendingOutcome?.record) {
        return {
          kind: "outcome",
          record: saved.pendingOutcome.record,
          snapshot: session.snapshot(),
          phase: "outcome",
          finished: false
        };
      }
      const current = session.advance();
      if (current.kind === "finished") return consume(current);
      rememberActive(current.snapshot);
      tracker.track({ type: "run_resume" });
      return current;
    },

    choose(optionIndex, roll) {
      if (!session) return { error: "no_session" };
      const result = session.chooseOption(optionIndex, roll);
      if (result.error) return result;
      rememberActive(result.snapshot);
      tracker.track({ type: "choice", eventId: result.record.eventId, optionIndex, success: result.record.success, semantic: result.record.semantic, d20: result.record.d20, attributes: result.snapshot.attributes });
      return result;
    },

    advance() {
      if (!session) return { error: "no_session" };
      return consume(session.advance());
    },

    continueOutcome() {
      if (!session) return { error: "no_session" };
      const result = session.continueOutcome();
      if (result.error) return result;
      rememberActive(result.snapshot);
      tracker.track({
        type: "outcome_continue",
        eventId: result.record?.eventId,
        timeAdvance: result.timeAdvance,
        windowTimeAdvances: result.windowTimeAdvances
      });
      if (result.finished) {
        const runResult = finishRun();
        return {
          ...result,
          kind: "finished",
          runResult,
          ending: { id: runResult.endingId, label: runResult.endingTitle, tone: runResult.endingTone }
        };
      }
      return result;
    },

    rerollLastOutcome(roll) {
      if (!session) return { error: "no_session" };
      const result = session.useFortuneReroll(roll);
      if (!result.error && result.snapshot) rememberActive(result.snapshot);
      return result;
    },

    resolveWindow(choice, roll) {
      if (!session) return { error: "no_session" };
      const result = session.resolveWindow(choice, roll);
      if (!result.error) rememberActive(result.snapshot);
      return result;
    },

    resolveKarma(choice, roll) {
      if (!session) return { error: "no_session" };
      const result = session.resolveKarma(choice, roll);
      if (!result.error) rememberActive(result.snapshot);
      return result;
    },

    resolveCliff(action, roll) {
      if (!session) return { error: "no_session" };
      const result = session.resolveCliff(action, roll);
      if (result.snapshot) rememberActive(result.snapshot);
      if (result.finished) {
        const runResult = finishRun();
        return { ...result, runResult, ending: { id: runResult.endingId, label: runResult.endingTitle, tone: runResult.endingTone } };
      }
      return result;
    },

    practiceDao(daoId, mode, roll) {
      if (!session) return { error: "no_session" };
      const result = session.practiceDao(daoId, mode, roll);
      if (result.snapshot) rememberActive(result.snapshot);
      return result;
    },

    current() { return session ? { event: session.getCurrentEvent(), snapshot: session.snapshot(), ledger: session.getLedger(), pendingWindows: session.getPendingWindows(), learningRecords: session.getLearningRecords() } : null; },
    history() { return saveSystem.readHistory(); },
    lastResult() { return lastResult; },
    saveCurrentSnapshot() {
      const current = snapshot();
      if (current) rememberActive(current);
      return current;
    },
    pendingFourDimAllocation() { return readPendingFourDims(); },

    saveFourDimAllocation(levels, points) {
      const check = validateFourDimAllocation(levels, points);
      if (!check.ok) return check;
      saveSystem.raw().set(allocationKey, { levels: check.levels, points, cost: check.totalCost, updatedAt: Date.now() });
      return check;
    },

    saveBirthProfile(profile) {
      saveSystem.raw().set(birthProfileKey, profile);
      return profile;
    },

    clearFourDimAllocation() { saveSystem.raw().remove(allocationKey); },
    birthTier,
    migrateSave
  };
}

export { createGameController };
