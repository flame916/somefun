import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = JSON.parse(
  fs.readFileSync(path.join(root, "config/life-simulator.template.json"), "utf-8")
);
const content = JSON.parse(
  fs.readFileSync(path.join(root, "content/life-simulator.placeholder.json"), "utf-8")
);
const adConfig = JSON.parse(
  fs.readFileSync(path.join(root, "config/ad-placements.json"), "utf-8")
);

import { createSession } from "../engine/event-engine.js";
import { judgeEnding } from "../engine/ending-engine.js";
import { createRandom } from "../engine/random.js";
import { createGameController } from "../app/game-controller.js";
import { createAdService } from "../app/ad-service.js";

function bestOptionIndex(event, attribute) {
  let best = 0;
  let bestDelta = -Infinity;
  event.options.forEach((option, index) => {
    const delta = option.effects?.[attribute] ?? 0;
    if (delta > bestDelta) {
      bestDelta = delta;
      best = index;
    }
  });
  return best;
}

function simulateRun(seed, strategy) {
  const session = createSession(template, content, null, null, createRandom(seed));
  const snapshot = session.start();
  let safe = 0;
  while (session.getCurrentEvent()) {
    const event = session.getCurrentEvent();
    const index = strategy ? bestOptionIndex(event, strategy) : event.options.length - 1;
    const result = session.chooseOption(index, 0);
    safe += 1;
    assert.ok(!result.error, `run failed at event ${event.id}`);
    if (safe > 50) break;
  }
  const finalSnapshot = session.snapshot();
  const state = session.getState();
  const ending = judgeEnding(template, state, session.getFlags());
  return { snapshot: finalSnapshot, ending, state };
}

function testEngine() {
  const seen = new Set();
  let endings = new Set();
  const runs = [
    [1, "fame", "ending_fame"],
    [2, "bond", "ending_bond"]
  ];
  for (const [seed, strategy, expectedEnding] of runs) {
    const { snapshot, ending, state } = simulateRun(seed, strategy);
    assert.ok(snapshot.history.length >= 13, `too few events: ${snapshot.history.length}`);
    assert.ok(snapshot.history.length <= 16, `too many events: ${snapshot.history.length}`);
    assert.ok(ending.id, "ending id missing");
    assert.strictEqual(ending.id, expectedEnding, `strategy ${strategy} ended ${ending.id}`);
    endings.add(ending.id);
    for (const record of snapshot.history) {
      seen.add(record.eventId);
    }
    for (const [key, config] of Object.entries(template.attributes)) {
      assert.ok(state[key] >= config.min && state[key] <= config.max, `${key} out of range`);
    }
  }
  assert.ok(seen.size >= 14, `events covered too few: ${seen.size}`);
  assert.ok(endings.size >= 2, `expected multiple endings, got ${[...endings].join(",")}`);
}

function testController() {
  const game = createGameController({ template, content, adConfig });
  const started = game.start();
  assert.ok(started.currentEventId, "controller start failed");
  let result = game.choose(0);
  assert.ok(!result.error, "controller choose failed");
  assert.ok(game.history(), "history missing");
  const resumed = game.resume();
  assert.ok(resumed.currentEventId, "resume failed");
}

function testAdService() {
  const service = createAdService(adConfig);
  const init = service.init();
  assert.strictEqual(init.ready, false, "ad service should not be ready");
  const shown = service.show("interstitial_stage_switch", { stage: "prime" });
  assert.strictEqual(shown.shown, false, "ad must not show in placeholder build");
  assert.ok(shown.reason, "ad result missing reason");
}

testEngine();
testController();
testAdService();
console.log("smoke ok: engine, controller, ad placeholder");
