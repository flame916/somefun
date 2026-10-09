import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const content = JSON.parse(fs.readFileSync(path.join(root, "content/life-simulator.placeholder.json"), "utf8"));
const template = JSON.parse(fs.readFileSync(path.join(root, "config/life-simulator.template.json"), "utf8"));

const summary = {
  contentMeta: content.meta,
  templateEngine: template.engine,
  eventCount: content.events.length,
  events: content.events.map((event) => ({
    id: event.id,
    title: event.title,
    stage: event.stage,
    keys: Object.keys(event),
    options: (event.options || []).map((option) => ({
      label: option.label,
      semantic: option.semantic,
      keys: Object.keys(option),
      effects: option.effects,
      failureEffects: option.failureEffects
    })),
    eventWindow: event.eventWindow || null,
    timeAdvanceYears: event.timeAdvanceYears,
    lifeAdvance: event.lifeAdvance
  })),
  endingCards: content.endingCards,
  soulTest: content.soulTest,
  characterBiographies: content.characterBiographies
};

console.log(JSON.stringify(summary, null, 2));
