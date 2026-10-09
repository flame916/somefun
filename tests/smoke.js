import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createSession, REALMS, deathWindowState } from "../engine/event-engine.js";
import { judgeEnding } from "../engine/ending-engine.js";
import { createRandom } from "../engine/random.js";
import { createStorage, migrateSave } from "../engine/save-system.js";
import {
  SCORE_MAX,
  FOUR_DIMENSIONS,
  pointsFor,
  computeScore,
  formatSectionBars,
  costForLevel,
  totalAllocationCost,
  validateFourDimAllocation,
  birthTier
} from "../engine/score-engine.js";
import { createGameController } from "../app/game-controller.js";
import { createAdService } from "../app/ad-service.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
const assetRoot = fs.existsSync(path.resolve(root, "../ui/assets"))
  ? path.resolve(root, "../ui/assets")
  : path.resolve(root, "ui/assets");
const template = readJson("config/life-simulator.template.json");
const content = readJson("content/life-simulator.placeholder.json");
const adConfig = readJson("config/ad-placements.json");
const manifestPath = path.join(assetRoot, "asset-manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const R3_EVENT_IDS = Object.freeze([
  "act1_awaken_night",
  "act1_system_escape",
  "act2_herb_shelter",
  "act2_first_blood",
  "act3_old_identity",
  "act3_trial_tower",
  "act4_bandit_founded",
  "act4_fame_siege",
  "act5_abyss_expedition",
  "act5_north_tide",
  "act6_return_earth",
  "act6_celestial_descent",
  "act7_gate_selection",
  "act7_magic_core_duel",
  "act8_rescue_rou",
  "act8_push_sky_gate"
]);
const R3_EVENT_MONTHS = Object.freeze({
  act1_awaken_night: 0,
  act1_system_escape: 3,
  act2_herb_shelter: 12,
  act2_first_blood: 6,
  act3_old_identity: 18,
  act3_trial_tower: 36,
  act4_bandit_founded: 12,
  act4_fame_siege: 18,
  act5_abyss_expedition: 48,
  act5_north_tide: 0,
  act6_return_earth: 12,
  act6_celestial_descent: 3,
  act7_gate_selection: 0,
  act7_magic_core_duel: 24,
  act8_rescue_rou: 1,
  act8_push_sky_gate: 1
});

function assertClose(actual, expected, message, epsilon = 1e-9) {
  assert.ok(Math.abs(Number(actual) - Number(expected)) <= epsilon, `${message}: ${actual} !== ${expected}`);
}

function compactTemplate(overrides = {}) {
  return {
    id: "smoke-template",
    engine: {
      mode: "event-choice",
      stageSequence: ["act1"],
      eventsPerStage: { act1: { min: 1, max: 5 } },
      maxEvents: 5,
      weightedDraw: false,
      noRepeatWithinRun: true,
      age: { enabled: true, start: 16 }
    },
    attributes: {
      power: { label: "修为", init: 0, min: 0, max: 100, group: "growth", displayOrder: 1 },
      health: { label: "健康", init: 100, min: 0, max: 100, group: "state", displayOrder: 2 },
      sanity: { label: "理智", init: 100, min: 0, max: 100, group: "state", displayOrder: 3 },
      fame: { label: "声望", init: 0, min: 0, max: 100, group: "growth", displayOrder: 4 },
      bond: { label: "羁绊", init: 0, min: 0, max: 100, group: "growth", displayOrder: 5 }
    },
    stages: { act1: { label: "第一幕", description: "测试", minEvents: 1, maxEvents: 5 } },
    endings: { fallback: { label: "兜底", description: "测试结束", conditions: { mode: "fallback" } } },
    save: { enabled: false, maxHistory: 2 },
    ...overrides
  };
}

function compactContent(events) {
  return { version: "smoke", meta: { title: "smoke", source: "test", isPlaceholder: true }, events, endingCards: [] };
}

function consumeTransition(session, transition, state = {}) {
  let current = transition;
  let guard = 0;
  while (guard < 80) {
    guard += 1;
    if (!current || current.error) throw new Error(current?.error || "missing transition");
    if (current.kind === "event") {
      const result = session.chooseOption(0, state.roll);
      assert.ok(!result.error, result.error);
      return { kind: "choice", result };
    }
    if (current.kind === "interlude") {
      current = session.advance();
      continue;
    }
    if (current.kind === "fate_window") {
      const result = session.resolveWindow(state.windowChoice || "attend", state.windowRoll ?? 20);
      return { kind: "window_result", result, window: current.window };
    }
    if (current.kind === "karma_knock") {
      const result = session.resolveKarma(state.karmaChoice || "break", state.karmaRoll ?? 20);
      return { kind: "karma_result", result, karma: current.karma };
    }
    if (current.kind === "cliff") {
      const result = session.resolveCliff("stop");
      return { kind: "cliff_result", result };
    }
    if (current.kind === "finished") return { kind: "finished", result: current };
    throw new Error(`unknown transition ${current.kind}`);
  }
  throw new Error("transition guard exceeded");
}

function testScoreBoundaries() {
  const table = [[0, 0], [199, 0], [200, 2], [329, 2], [330, 5], [459, 5], [460, 8], [589, 8], [590, 12], [719, 12], [720, 16], [849, 16], [850, 20], [1000, 20]];
  for (const [score, points] of table) assert.equal(pointsFor(score), points, `pointsFor(${score})`);
  const sectionSets = [[0, 0, 0, 0], [250, 0, 0, 0], [250, 250, 0, 0], [250, 250, 250, 0], [250, 250, 250, 250]];
  sectionSets.forEach((values, index) => {
    const result = computeScore([], { id: "test", tone: "neutral" }, { scoreSections: { realm: values[0], story: values[1], living: values[2], legacy: values[3] } });
    assert.deepEqual(result.sections, { realm: values[0], story: values[1], living: values[2], legacy: values[3] });
    assert.equal(result.score, [0, 250, 500, 750, 1000][index]);
    assert.equal(Object.values(result.sections).reduce((sum, value) => sum + value, 0), result.score);
    assert.ok(result.score >= 0 && result.score <= SCORE_MAX);
    assert.equal(formatSectionBars(result.sections).length, 4);
  });
  const derived = computeScore([{ success: true, unlockFlag: "system_active" }], { id: "ending_g04_dual_return", tone: "warm" }, { state: { power: 60, health: 80, sanity: 70, bond: 60 }, flags: ["system_active", "saved_village"], realm: "qi", age: 30, realmLifespan: 150, remainingYears: 120, learningRecords: [] });
  assert.equal(derived.score, Object.values(derived.sections).reduce((sum, value) => sum + value, 0));
  assert.ok(Object.values(derived.sections).every((value) => value >= 0 && value <= 250));
  assert.deepEqual(Object.keys(derived.reasons), ["realm", "story", "living", "legacy"]);
}

function testFourDimensions() {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(costForLevel), [0, 1, 3, 6, 10, 15, 21, 28, 36, 45, 55]);
  const budget = validateFourDimAllocation({ naturalTalent: 5, aptitude: 2, bloodline: 1, fortune: 1 }, 20);
  assert.equal(budget.ok, true);
  assert.equal(budget.totalCost, 20);
  assert.equal(totalAllocationCost({ naturalTalent: 5 }), 15);
  assert.equal(validateFourDimAllocation({ naturalTalent: 6 }, 20).ok, false);
  assert.equal(validateFourDimAllocation({ naturalTalent: 10 }, 20).ok, false);
  assert.equal(validateFourDimAllocation({ health: 2 }, 20).ok, false);
  assert.deepEqual(FOUR_DIMENSIONS, ["naturalTalent", "aptitude", "bloodline", "fortune"]);
  assert.equal(birthTier(2), "低");
  assert.equal(birthTier(3), "中");
  assert.equal(birthTier(6), "中");
  assert.equal(birthTier(7), "高");
}

function testLifespanAndD20() {
  assert.deepEqual(REALMS.map((realm) => realm.lifespan), [100, 150, 220, 400, 700]);
  assert.deepEqual(REALMS.slice(1).map((realm) => realm.breakthroughTarget), [10, 13, 16, 19]);
  assert.equal(deathWindowState(21), "ok");
  assert.equal(deathWindowState(20), "warning");
  assert.equal(deathWindowState(5), "critical");
  assert.equal(deathWindowState(0), "exhausted");

  const events = [1, 2, 3].map((index) => ({
    id: `break_${index}`,
    title: `破境 ${index}`,
    text: "测试",
    stage: "act1",
    weight: 1,
    sceneDuration: "片刻",
    lifeAdvance: { months: 0, source: "event", reason: "破境当场完成", basis: "测试事件不推进账本" },
    resultText: "成",
    failureText: "败",
    options: [{ label: "破境", effects: { power: 5 }, d20: { id: "break_gate", target: 10, kind: "breakthrough" } }]
  }));
  const session = createSession(compactTemplate(), compactContent(events), null, null, createRandom(1));
  let transition = session.advance();
  const targets = [];
  for (let index = 0; index < 3; index += 1) {
    assert.equal(transition.kind, "event");
    const result = session.chooseOption(0, 1);
    assert.equal(result.phase, "outcome");
    assert.equal(result.record.timeAdvance, null);
    targets.push(result.record.d20.target);
    const continued = session.continueOutcome();
    assert.ok(!continued.error, continued.error);
    assert.equal(continued.record.timeAdvance.months, 0);
    transition = session.advance();
  }
  assert.deepEqual(targets, [10, 11, 12]);
  assert.equal(session.getState().checkPenalty.break_gate, 2);
  assert.equal(session.getState().realm, "mortal");
}

function testSacrificeSemantics() {
  const event = {
    id: "sacrifice",
    title: "献祭",
    text: "测试",
    stage: "act1",
    weight: 1,
    sceneDuration: "一瞬",
    lifeAdvance: { months: 0, source: "event", reason: "献祭当场结算", basis: "测试事件不推进账本" },
    resultText: "成",
    failureText: "败",
    options: [{ label: "散尽修为", semantic: "sacrifice", effects: { power: 50, health: 10 }, d20: { id: "sac", target: 19, kind: "sacrifice" } }]
  };
  const successSession = createSession(compactTemplate(), compactContent([event]), { power: 80, health: 100, sanity: 100 }, null, createRandom(1));
  successSession.advance();
  const success = successSession.chooseOption(0, 20);
  assert.equal(success.record.success, true);
  assert.equal(successSession.getState().power, 16);
  assert.ok(success.record.effects.power <= 0, "sacrifice success must not grant positive power");
  assert.equal(successSession.continueOutcome().record.resultText, "成");

  const failureSession = createSession(compactTemplate(), compactContent([event]), { power: 80, health: 100, sanity: 100 }, null, createRandom(1));
  failureSession.advance();
  const failure = failureSession.chooseOption(0, 1);
  assert.equal(failure.record.success, false);
  assert.equal(failureSession.getState().power, 24);
  assert.equal(failureSession.getState().health, 88);
  assert.ok(failure.record.effects.power < 0, "sacrifice failure must remove power");
  assert.equal(failureSession.continueOutcome().record.resultText, "败");
}

function testR3ContentContract() {
  assert.equal("defaultTimeAdvanceYears" in template.engine, false, "R3 must not retain a default time advance");
  assert.equal(content.version, "1.0.0-r3");
  assert.equal(content.events.length, R3_EVENT_IDS.length);
  assert.equal(new Set(content.events.map((event) => event.id)).size, R3_EVENT_IDS.length);
  assert.deepEqual(content.events.map((event) => event.id).sort(), [...R3_EVENT_IDS].sort());
  for (const event of content.events) {
    for (const field of ["resultText", "failureText", "bridgeText", "nextEventTrigger", "sceneDuration"]) {
      assert.equal(typeof event[field], "string", `${event.id}.${field} must be event-level text`);
      assert.ok(event[field].trim(), `${event.id}.${field} must not be blank`);
    }
    assert.ok(Array.isArray(event.timeBeats) && event.timeBeats.length > 0, `${event.id}.timeBeats`);
    for (const [index, beat] of event.timeBeats.entries()) {
      assert.ok(beat && typeof beat === "object" && !Array.isArray(beat), `${event.id}.timeBeats[${index}] must be an object`);
      assert.equal(typeof beat.at, "string", `${event.id}.timeBeats[${index}].at`);
      assert.ok(beat.at.trim(), `${event.id}.timeBeats[${index}].at must not be blank`);
      assert.equal(typeof beat.text, "string", `${event.id}.timeBeats[${index}].text`);
      assert.ok(beat.text.trim(), `${event.id}.timeBeats[${index}].text must not be blank`);
    }
    assert.ok(event.personLedgerEntry && typeof event.personLedgerEntry === "object", `${event.id}.personLedgerEntry`);
    assert.equal(event.lifeAdvance.months, R3_EVENT_MONTHS[event.id], `${event.id}.lifeAdvance.months`);
    assert.ok(event.lifeAdvance.source && event.lifeAdvance.reason && event.lifeAdvance.basis, `${event.id}.lifeAdvance metadata`);
  }
  const t1 = content.events.find((event) => event.id === "act5_north_tide").eventWindow;
  assert.deepEqual(t1, {
    id: "t1_beihai_tide",
    name: "北海妖潮",
    monthsFromNow: 108,
    announceAfterEvent: "act4_fame_siege",
    resolveAtEvent: "act5_north_tide",
    karmaOnAvoid: false
  });
  const t2 = content.events.find((event) => event.id === "act7_gate_selection").eventWindow;
  assert.deepEqual(t2, {
    id: "t2_shenyuan_rite",
    name: "沉渊古祭",
    monthsFromNow: 60,
    announceAfterEvent: "act6_celestial_descent",
    resolveAtEvent: "act7_gate_selection",
    karmaOnAvoid: true
  });
}

function testR31OptionFeedbackGraybox() {
  assert.equal(Object.keys(content.optionFeedback || {}).length, 16, "R3.1 must define feedback for all 16 events");
  for (const event of content.events) {
    const rows = content.optionFeedback[event.id];
    assert.ok(Array.isArray(rows) && rows.length === event.options.length, `${event.id} option feedback must cover every option`);
    for (const [index, row] of rows.entries()) {
      assert.ok(row.resultText && row.failureText && row.bridgeText, `${event.id} option ${index} needs success/failure/bridge text`);
      assert.ok(row.unlockFlag || row.failureUnlockFlag, `${event.id} option ${index} needs a stable state ID`);
    }
  }

  // Graybox: the first event proves the option -> response -> state loop.
  const first = createSession(compactTemplate(), compactContent([{
    id: "act1_awaken_night",
    title: "荒村第一夜",
    text: "测试",
    stage: "act1",
    resultText: "事件级成功缺省",
    failureText: "事件级失败缺省",
    bridgeText: "事件级承接缺省",
    options: [{ label: "稳妥", effects: { bond: 2 } }]
  }]), null, null, createRandom(1));
  // A real content session hydrates the R3.1 sidecar and must prefer it.
  const real = createSession(compactTemplate({ engine: { ...compactTemplate().engine, maxEvents: 1 } }), content, null, null, createRandom(1));
  real.start();
  const firstEvent = real.getCurrentEvent();
  assert.ok(firstEvent.options.every((option) => option.resultText && option.failureText && option.bridgeText));
  const choice = real.chooseOption(0, 1);
  assert.equal(choice.record.eventId, "act1_awaken_night");
  assert.equal(choice.record.resultSource, "option");
  assert.match(choice.record.resultText, /先把喘息的人/);
  const witnessFlag = ["act1", "saved", "witness"].join("_");
  assert.ok(choice.record.branchFlags.includes(witnessFlag));
  assert.ok(choice.snapshot.flags.includes(witnessFlag));
  const continued = real.continueOutcome();
  assert.equal(continued.record.bridgeText, "有人因你活下来，黎明时愿意替你指认安全的出村路。");
  assert.ok(continued.record.branchFlags.includes(witnessFlag));
  void first;
}

function testR3EpisodeAdvanceAndFortune() {
  const event = {
    id: "episode_time",
    title: "时间节拍",
    text: "测试",
    stage: "act1",
    weight: 1,
    sceneDuration: "一季",
    lifeAdvance: { months: 7, source: "event", reason: "善后耗时七个月", basis: "测试事件级账本" },
    resultText: "事件成功正文",
    failureText: "事件失败正文",
    bridgeText: "下一件事在门外等候。",
    timeBeats: [
      { at: "result", text: "选择" },
      { at: "ledger", text: "结果" },
      { at: "result", text: "承接" }
    ],
    nextEventTrigger: "测试下一事件",
    personLedgerEntry: { character: "测试人物", slice: "留下见证" },
    options: [{ label: "继续", d20: { id: "episode_check", target: 10 } }]
  };
  const session = createSession(compactTemplate(), compactContent([event]), null, null, createRandom(1));
  session.advance();
  const before = session.snapshot().ledger;
  const choice = session.chooseOption(0, 20);
  assert.ok(!choice.error, choice.error);
  assert.equal(choice.record.resultText, "事件成功正文");
  assert.equal(choice.record.timeAdvance, null);
  assert.equal(choice.snapshot.phase, "outcome");
  assert.deepEqual(choice.snapshot.ledger, before, "choosing must not commit time before continue");
  assert.equal(choice.snapshot.pendingOutcome.record.eventId, event.id);

  const continued = session.continueOutcome();
  assert.ok(!continued.error, continued.error);
  assert.equal(continued.record.bridgeText, event.bridgeText);
  assert.deepEqual(continued.record.timeBeats, event.timeBeats);
  assert.equal(continued.record.nextEventTrigger, event.nextEventTrigger);
  assert.equal(continued.record.timeAdvance.months, 7);
  assertClose(continued.record.timeAdvance.years, 7 / 12, "seven months must be recorded as a single advance");
  assertClose(session.getState().age, before.age + 7 / 12, "event lifeAdvance must commit exactly once");
  assertClose(session.snapshot().ledger.worldYear, before.worldYear + 7 / 12, "worldYear must use the same ledger");
  assert.equal(session.snapshot().timeline.length, 1);
  assert.equal(session.snapshot().timeline[0].eventId, event.id);
  assert.ok(session.snapshot().state.personLedger.some((entry) => entry.character === "测试人物"));

  const zeroEvent = {
    ...event,
    id: "episode_zero",
    sceneDuration: "一瞬到数月（只影响呈现）",
    lifeAdvance: { months: 0, source: "event", reason: "当场结算", basis: "测试零月推进" }
  };
  const zeroSession = createSession(compactTemplate(), compactContent([zeroEvent]), null, null, createRandom(1));
  zeroSession.advance();
  const zeroBefore = zeroSession.snapshot().ledger;
  zeroSession.chooseOption(0, 20);
  const zeroContinued = zeroSession.continueOutcome();
  assert.equal(zeroContinued.record.timeAdvance.months, 0);
  assert.equal(zeroSession.snapshot().timeline.length, 0, "sceneDuration must never create a ledger entry");
  assert.deepEqual(zeroSession.snapshot().ledger, zeroBefore);

  for (const [fortune, expectedRerolls] of [[0, 0], [2, 1], [5, 2], [10, 5]]) {
    const fortuneSession = createSession(compactTemplate(), compactContent([event]), { fourDims: { fortune } }, null, createRandom(1));
    assert.equal(fortuneSession.getFortuneRerolls(), expectedRerolls, `fortune ${fortune}`);
    if (expectedRerolls > 0) {
      fortuneSession.advance();
      const failed = fortuneSession.chooseOption(0, 1);
      assert.equal(failed.record.success, false);
      for (let index = 0; index < expectedRerolls; index += 1) {
        const rerolled = fortuneSession.useFortuneReroll(20);
        assert.ok(!rerolled.error, rerolled.error);
        assert.equal(rerolled.rerolled, true);
        assert.equal(rerolled.record.success, true);
        assert.equal(fortuneSession.getFortuneRerolls(), expectedRerolls - index - 1);
      }
      assert.equal(fortuneSession.useFortuneReroll(20).error, "no_fortune_rerolls");
    }
  }
  const nextLife = createSession(compactTemplate(), compactContent([event]), null, null, createRandom(1));
  assert.equal(nextLife.getFortuneRerolls(), 0, "a fresh life must derive fortune rerolls from that life only");
}

function testDaoStudy() {
  const session = createSession(template, content, null, null, createRandom(7));
  session.advance();
  const before = session.getLearningRecords().find((record) => record.id === "dao01");
  const success = session.practiceDao("dao01", "conservative", 20);
  assert.ok(!success.error);
  assert.equal(success.result.success, true);
  assert.equal(success.result.record.stageIndex, before.stageIndex + 1);
  assert.equal(success.result.timeAdvance.years, 1);
  assert.match(success.result.timeAdvance.reason, /五行镇岳诀/);
  assert.match(success.result.timeAdvance.basis, /道业依据/);
  const afterSuccess = session.getLearningRecords().find((record) => record.id === "dao01");
  const failure = session.practiceDao("dao01", "conservative", 1);
  assert.ok(!failure.error);
  assert.equal(failure.result.success, false);
  assert.equal(session.getLearningRecords().find((record) => record.id === "dao01").stageIndex, afterSuccess.stageIndex);
  assert.equal(session.practiceDao("unknown", "conservative", 20).error, "dao_not_available");
}

function testPowerSourceFiltering() {
  const events = [
    { id: "system_only", title: "系统遗迹", text: "测试", stage: "act1", weight: 1, requiresPowerSource: "system", resultText: "成", failureText: "败", options: [{ label: "查看", effects: {} }] },
    { id: "legacy_only", title: "传承遗迹", text: "测试", stage: "act1", weight: 1, requiresPowerSource: "传承", resultText: "成", failureText: "败", options: [{ label: "查看", effects: {} }] }
  ];
  const legacy = createSession(compactTemplate(), compactContent(events), { powerSource: "传承" }, null, createRandom(1));
  const first = legacy.advance();
  assert.equal(first.kind, "event");
  assert.equal(first.event.id, "legacy_only");
}

function playSessionToEnd(session, onOutcome) {
  let transition = session.advance();
  let guard = 0;
  while (guard < 120) {
    guard += 1;
    if (transition.kind === "event") {
      const event = transition.event;
      const result = session.chooseOption(0, 0.5);
      assert.ok(!result.error, result.error);
      assert.equal(result.snapshot.phase, "outcome", `${event.id} must pause for result feedback`);
      assert.equal(result.record.timeAdvance, null, `${event.id} must not commit time before continue`);
      const continued = session.continueOutcome();
      assert.ok(!continued.error, continued.error);
      assert.equal(continued.record.eventId, event.id);
      if (onOutcome) onOutcome(continued, event);
      transition = session.advance();
      continue;
    }
    if (transition.kind === "interlude") {
      transition = session.advance();
      continue;
    }
    if (transition.kind === "fate_window") {
      const result = session.resolveWindow("attend", 20);
      assert.ok(!result.error, result.error);
      transition = session.advance();
      continue;
    }
    if (transition.kind === "karma_knock") {
      const result = session.resolveKarma("break", 20);
      assert.ok(!result.error, result.error);
      transition = session.advance();
      continue;
    }
    if (transition.kind === "cliff") {
      session.resolveCliff("stop");
      transition = { kind: "finished", snapshot: session.snapshot() };
      continue;
    }
    if (transition.kind === "finished") return session.snapshot();
    throw new Error(`unexpected transition ${transition.kind}`);
  }
  throw new Error("run did not finish");
}

function testFullR3RunClosure() {
  const session = createSession(template, content, null, null, createRandom(20260913));
  const observed = {
    announced: new Map(),
    windowAdvances: new Map()
  };
  const snapshot = playSessionToEnd(session, (continued, event) => {
    for (const window of continued.snapshot.pendingWindows) {
      if (window.announced && !observed.announced.has(window.id)) observed.announced.set(window.id, event.id);
    }
    for (const advance of continued.windowTimeAdvances) {
      observed.windowAdvances.set(advance.windowId, (observed.windowAdvances.get(advance.windowId) || 0) + 1);
    }
  });
  assert.equal(snapshot.history.length, 16);
  assert.deepEqual(snapshot.history.map((record) => record.eventId).sort(), [...R3_EVENT_IDS].sort());
  assert.equal(new Set(snapshot.history.map((record) => record.eventId)).size, 16);
  assert.ok(snapshot.ledger.age >= 16);
  assert.ok(snapshot.ledger.remainingYears >= 0);
  assert.ok(snapshot.timeline.length > 0, "run must expose a time ledger");
  const expectedTimeline = snapshot.history.flatMap((record) => [record.timeAdvance, ...record.windowTimeAdvances]).filter((entry) => entry?.months > 0);
  assert.equal(snapshot.timeline.length, expectedTimeline.length, "timeline must be the unique projection of history time entries");
  for (let index = 0; index < snapshot.timeline.length; index += 1) {
    const entry = snapshot.timeline[index];
    assert.deepEqual(entry, expectedTimeline[index], `timeline/history mismatch at ${index}`);
    assert.ok(entry.months > 0, "timeline entries must only record actual advances");
    assert.ok(entry.years > 0, "timeline entries must only record actual advances");
    assertClose(entry.toAge, entry.fromAge + entry.years, "timeline age arithmetic must be explicit");
    assertClose(entry.toWorldYear, entry.fromWorldYear + entry.years, "timeline world-year arithmetic must be explicit");
    assert.ok(String(entry.reason || "").trim(), "every time advance must have a reason");
    assert.ok(String(entry.basis || "").trim(), "every time advance must cite its event/window basis");
    assert.ok(String(entry.source || "").trim(), "every time advance must identify its source");
  }
  const totalAdvancedYears = snapshot.timeline.reduce((sum, entry) => sum + entry.years, 0);
  assertClose(snapshot.ledger.age, 16 + totalAdvancedYears, "every age change must be accounted for in the timeline");
  assertClose(snapshot.ledger.worldYear, 1 + totalAdvancedYears, "worldYear must share the single ledger");
  assert.deepEqual(snapshot.ledger, snapshot.timeline[snapshot.timeline.length - 1].current);
  for (const record of snapshot.history) {
    assert.equal(record.timeAdvance.months, R3_EVENT_MONTHS[record.eventId], `${record.eventId} must advance exactly once`);
    assert.ok(record.resultText, `${record.eventId} must expose its result beat`);
    assert.ok(record.bridgeText, `${record.eventId} must expose its bridge/transition text`);
  }

  assert.equal(observed.announced.get("t1_beihai_tide"), "act4_fame_siege");
  assert.equal(observed.announced.get("t2_shenyuan_rite"), "act6_celestial_descent");
  assert.equal(observed.windowAdvances.get("t1_beihai_tide"), 1, "T1 must resolve exactly once");
  assert.equal(observed.windowAdvances.get("t2_shenyuan_rite"), 1, "T2 must resolve exactly once");
  const t1 = snapshot.pendingWindows.find((window) => window.id === "t1_beihai_tide");
  const t2 = snapshot.pendingWindows.find((window) => window.id === "t2_shenyuan_rite");
  assert.equal(t1.resolvedAtEvent, "act5_north_tide");
  assert.equal(t2.resolvedAtEvent, "act7_gate_selection");
  assert.equal(t1.resolved, true);
  assert.equal(t2.resolved, true);
  const t1Advance = snapshot.timeline.find((entry) => entry.windowId === "t1_beihai_tide");
  const t2Advance = snapshot.timeline.find((entry) => entry.windowId === "t2_shenyuan_rite");
  assert.ok(t1Advance && t2Advance, "T1/T2 window results must be recorded in the time ledger");
  assert.match(t1Advance.basis, /北海妖潮/);
  assert.match(t2Advance.basis, /沉渊古祭/);
  const personKeys = snapshot.state.personLedger.map((entry) => `${entry.character}:${entry.slice}`);
  assert.equal(new Set(personKeys).size, personKeys.length, "person ledger must deduplicate the same character/slice pair");
  const ending = judgeEnding(template, session.getState(), session.getFlags());
  const score = computeScore(snapshot.history, ending, { state: session.getState(), flags: session.getFlags(), learningRecords: session.getLearningRecords(), realm: session.getState().realm, realmLifespan: session.getState().realmLifespan, age: session.getState().age, remainingYears: session.getState().remainingYears, deathWindowState: session.getState().deathWindowState, memoryFragments: session.getState().memoryFragments, unfinishedBusiness: session.getState().unfinishedBusiness });
  assert.equal(score.score, Object.values(score.sections).reduce((sum, value) => sum + value, 0));
  assert.ok(score.score >= 0 && score.score <= 1000);
  assert.ok([0, 2, 5, 8, 12, 16, 20].includes(pointsFor(score.score)));
  assert.ok(score.reasons.realm.length >= 1 && score.reasons.story.length >= 1 && score.reasons.living.length >= 1 && score.reasons.legacy.length >= 1);
}

function testControllerAllocationAndMigration() {
  const storage = createStorage("smoke-r3-controller", {});
  const game = createGameController({ template, content, adConfig, storage });
  let transition = game.start() && { kind: "event", snapshot: game.current().snapshot };
  let runResult = null;
  let guard = 0;
  while (guard < 140) {
    guard += 1;
    if (transition.kind === "event") {
      const choice = game.choose(0, 0.5);
      assert.ok(!choice.error, choice.error);
      transition = game.advance();
      continue;
    }
    if (transition.kind === "interlude") { transition = game.advance(); continue; }
    if (transition.kind === "fate_window") { const result = game.resolveWindow("attend", 20); assert.ok(!result.error); transition = game.advance(); continue; }
    if (transition.kind === "karma_knock") { const result = game.resolveKarma("break", 20); assert.ok(!result.error); transition = game.advance(); continue; }
    if (transition.kind === "cliff") { const result = game.resolveCliff("stop"); if (result.runResult) runResult = result.runResult; transition = { kind: "finished", runResult }; continue; }
    if (transition.kind === "finished") { runResult = transition.runResult || runResult; break; }
    throw new Error(`controller unexpected ${transition.kind}`);
  }
  assert.ok(runResult, "controller run result missing");
  assert.equal(runResult.sections.realm + runResult.sections.story + runResult.sections.living + runResult.sections.legacy, runResult.score);
  assert.equal(runResult.pointsEarned, pointsFor(runResult.score));
  assert.ok(runResult.ledger?.worldYear >= 1, "controller result must expose the shared world-year ledger");
  assert.equal(runResult.timeline.length, runResult.history.flatMap((record) => [record.timeAdvance, ...(record.windowTimeAdvances || [])]).filter((entry) => entry?.months > 0).length);

  const allocation = game.saveFourDimAllocation({ naturalTalent: 5, aptitude: 2, bloodline: 1, fortune: 1 }, 20);
  assert.equal(allocation.ok, true);
  assert.deepEqual(game.pendingFourDimAllocation().levels, { naturalTalent: 5, aptitude: 2, bloodline: 1, fortune: 1 });
  const next = game.start();
  assert.deepEqual(next.fourDims, { naturalTalent: 5, aptitude: 2, bloodline: 1, fortune: 1 });
  assert.equal(game.pendingFourDimAllocation(), null);

  const migrated = migrateSave({ attributes: { power: 42, health: 70, sanity: 80 }, flags: ["old"], history: [{ eventId: "old" }], soul_points: 3, soul_bonuses: { power: 2 }, currentEventId: "old_event" });
  assert.equal(migrated.version, 2);
  assert.equal(migrated.state.power, 42);
  assert.deepEqual(migrated.fourDims, { naturalTalent: 0, aptitude: 0, bloodline: 0, fortune: 0 });
  assert.equal(migrated.legacySoulPoints, 3);
}

function testAssetsAndAds() {
  assert.equal(manifest.assets.length, 107, "asset manifest must contain 107 entries");
  for (const asset of manifest.assets) {
    const absolute = path.join(assetRoot, asset.file);
    assert.ok(fs.existsSync(absolute), `missing asset ${asset.file}`);
    const data = fs.readFileSync(absolute);
    assert.ok(data.length > 0, `empty asset ${asset.file}`);
    assert.equal(data.toString("ascii", 1, 4), "PNG", `invalid PNG signature ${asset.file}`);
    assert.equal(data.toString("ascii", 12, 16), "IHDR", `missing PNG IHDR ${asset.file}`);
    const [expectedWidth, expectedHeight] = String(asset.actual_size).split("x").map(Number);
    assert.equal(data.readUInt32BE(16), expectedWidth, `width mismatch ${asset.file}`);
    assert.equal(data.readUInt32BE(20), expectedHeight, `height mismatch ${asset.file}`);
    assert.equal(data.length, asset.verification.bytes, `byte size mismatch ${asset.file}`);
    assert.equal(createHash("sha256").update(data).digest("hex"), asset.verification.sha256, `sha256 mismatch ${asset.file}`);
    assert.match(asset.file, /^[a-z0-9_]+\.png$/);
  }
  const source = fs.readFileSync(path.join(root, "app/main.js"), "utf8");
  const referenced = [...source.matchAll(/"(bg|btn|deco|frame|icon)_[a-z0-9_]+"/g)].map((match) => match[0].slice(1, -1));
  const ids = new Set(manifest.assets.map((asset) => asset.asset_id));
  assert.ok(referenced.length > 0);
  assert.ok(referenced.every((id) => ids.has(id)), "main.js references an asset missing from manifest");

  const service = createAdService(adConfig);
  assert.equal(service.init().ready, false);
  const disabled = service.show("interstitial_stage_switch", { stage: "act2" });
  assert.equal(disabled.shown, false);
  const enabledConfig = JSON.parse(JSON.stringify(adConfig));
  enabledConfig.enabled = true;
  enabledConfig.placements = enabledConfig.placements.map((placement) => ({ ...placement, enabled: true }));
  const enabled = createAdService(enabledConfig);
  assert.equal(enabled.show("rewarded_restart", {}).reason, "adapter_not_ready");
  assert.equal(enabled.show("rewarded_restart", {}).reason, "throttled_or_disabled");
}

testScoreBoundaries();
testFourDimensions();
testLifespanAndD20();
testSacrificeSemantics();
testR3ContentContract();
testR31OptionFeedbackGraybox();
testR3EpisodeAdvanceAndFortune();
testDaoStudy();
testPowerSourceFiltering();
testFullR3RunClosure();
testControllerAllocationAndMigration();
testAssetsAndAds();
console.log("smoke ok: R3 event fields/IDs, single ledger time, T1/T2 windows, fortune rerolls, four-section score/points, four dimensions, lifespan/realm, d20, sacrifice, dao study, save migration, full loop, 107 assets, ad placeholder");
