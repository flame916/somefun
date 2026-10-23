import { createR4WorldEngine, worldDate } from "./r4-world-engine.js?v=r6-world-life-candidate-18";

const DIMENSIONS = Object.freeze(["naturalTalent", "aptitude", "bloodline", "fortune"]);
const INITIAL_STAGE = "r5_origin_untrained";
const PERSISTENT_WORLD_SCOPES = new Set(["world", "world_crisis_instance", "world_cause_instance", "cause_instance", "demand_instance", "harvest_batch", "conflict_instance", "repair_task", "person_request", "furnace_state"]);
const PERSONAL_OR_LIFE_SCOPES = new Set(["market_quote", "furnace_permit", "borrowed_item", "life_source_instance", "character_breakthrough"]);
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const id = (...parts) => parts.map((part) => String(part)).join(":");
function replaceIdentifiers(value, replacements) {
  if (typeof value === "string") {
    let result = value;
    for (const [from, to] of replacements) if (from && from !== to) result = result.split(from).join(to);
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => replaceIdentifiers(item, replacements));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [replaceIdentifiers(key, replacements), replaceIdentifiers(item, replacements)]));
  return value;
}

import { findActionDuration, migrateR6WorldTimeDto } from "./r6-world-time.js";

/** R5 rules layered into the same persisted world state as the verified R4 executor. */
export function createR5Runtime({ pack, definitions, seedConfig, saved = null, now, r6FreeSurvival = false, r6TimeContract = null }) {
  if (!pack?.r5ProgressionRules?.stages || pack.saveNamespace !== "r6-world-life-candidate-v2") throw new Error("invalid_r5_runtime_package");
  const rules = pack.r5ProgressionRules;
  const rebirthRules = pack.r5RebirthRules;
  const runtimeDefinitions = clone(definitions);
  for (const event of runtimeDefinitions.events) if (event.runtimeBinding?.kind === "realm_source") event.runtimeBinding.minimumRealmId = "r4_realm_mortal";
  const stages = rules.stages.filter((stage) => stage.availability === "playable").sort((a, b) => a.progressionRank - b.progressionRank);
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const rankById = new Map(stages.map((stage) => [stage.id, stage.progressionRank]));
  const skillDisciplines = rules.skillDisciplines;
  const reserved = new Set(rules.reservedStageIds);
  let world;
  let base;

  function blankLife(index = 1) {
    return {
      schemaVersion: "R5-LIFE-1", ruleVersion: rebirthRules.version,
      scoreEntries: [], causeBest: {}, settlement: null,
      factLog: [], transactions: {}, rebirth: {
        schemaVersion: "R5-REBIRTH-1", walletUnits: 0, draft: null, receipt: null,
        dimensionLevels: Object.fromEntries(DIMENSIONS.map((key) => [key, 0])),
        dimensionIncrements: Object.fromEntries(DIMENSIONS.map((key) => [key, 0]))
      }, progression: { current: { lifeIndex: index, stageId: INITIAL_STAGE, source: "origin" }, attainment: [] },
      skills: [], gates: [], capabilities: [], rebirthReceipts: {}, inheritedMemory: {}, worldHistory: []
    };
  }

  function r5State(state = base?.save()) {
    if (!state) throw new Error("r5_world_not_initialized");
    if (Number.isSafeInteger(state.worldTick)) state.worldDay = Math.floor(state.worldTick / 96);
    const baseFacts = state.character.facts || {};
    const overlayFacts = state.facts || {};
    const facts = { ...baseFacts };
    for (const [key, value] of Object.entries(overlayFacts)) if (key.startsWith("r5_") || ["r4_fact_life_clock", "r4_fact_realm_current", "r4_fact_skill_memory", "r4_fact_birth_story", "r4_fact_memory_awakened"].includes(key)) facts[key] = value;
    state.character.facts = facts;
    state.facts = facts;
    state.world.id ||= state.worldId;
    state.world.worldDay = state.worldDay;
    state.r5RuntimeVersion = "R5-RUNTIME-1";
    state.r5Namespace = pack.saveNamespace;
    state.r5LifeLedger ||= blankLife(Number(state.character?.lifeIndex || 1));
    state.r5LifeLedger.transactions ||= {};
    state.r5LifeLedger.factLog ||= [];
    state.r5LifeLedger.progression ||= { current: { lifeIndex: 1, stageId: INITIAL_STAGE, source: "origin" }, attainment: [] };
    state.r5LifeLedger.skills ||= [];
    state.r5Rebirth ||= state.r5LifeLedger.rebirth || blankLife().rebirth;
    state.r5RebirthReceipts ||= state.r5LifeLedger.rebirthReceipts || {};
    state.r5LifeLedger.rebirth = state.r5Rebirth;
    state.r5LifeLedger.causeBest ||= {};
    state.r5LifeLedger.scoreEntries ||= [];
    state.r5LifeLedger.progression.attainment ||= [];
    state.r5LifeLedger.worldHistory ||= [];
    state.r5LifeLedger.rebirthReceipts = state.r5RebirthReceipts;
    state.r5LifeLedger.inheritedMemory ||= {};
    return state;
  }

  function replaceState(state) {
    const current = r5State(state);
    base = createR4WorldEngine({ pack, definitions: runtimeDefinitions, seedConfig, saved: current, now, realmSourceAdapter: "r5", r6FreeSurvival, r6TimeContract });
    return current;
  }

  function activeStage(state) {
    const current = state.r5LifeLedger.progression.current;
    if (current.lifeIndex !== Number(state.character.lifeIndex || 1) || !rankById.has(current.stageId)) throw new Error("r5_current_stage_wrong_life");
    return current.stageId;
  }

  function lifespanDays(state, stageId = activeStage(state)) {
    const rank = rankById.get(stageId) ?? 0;
    const extension = stages.filter((stage) => stage.progressionRank > 0 && stage.progressionRank <= rank)
      .reduce((sum, stage) => sum + Number(stage.lifespanYearsAdded || 0), 0);
    return (rules.baseLifespanYears + extension) * rules.daysPerYear;
  }

  function recordScore(state, kind, eventId, resultId, causeId, points, transactionId) {
    const ledger = state.r5LifeLedger;
    const key = `${kind}:${causeId}`;
    const prior = Number(ledger.causeBest[key] || 0);
    const delta = Math.max(0, Number(points) - prior);
    if (delta) {
      ledger.causeBest[key] = prior + delta;
      ledger.scoreEntries.push({ kind, eventId, resultId, causeId, causalFamilyId: key, points: delta, transactionId, lifeIndex: state.character.lifeIndex });
      state.facts.r5_fact_life_score_cause ||= [];
      state.facts.r5_fact_life_score_cause.push(clone(ledger.scoreEntries.at(-1)));
    }
    return delta;
  }

  function currentSkills(state, discipline = null) {
    const learned = new Set(state.character.learnedSkills || []);
    return state.r5LifeLedger.skills.filter((row) => row.lifeIndex === state.character.lifeIndex && learned.has(row.skillId) && (!discipline || row.discipline === discipline));
  }

  function syncLearnedSkillSources(state) {
    const rows = state.r5LifeLedger.skills;
    const known = new Set(rows.map((row) => `${row.lifeIndex}:${row.skillId}:${row.sourceId}`));
    for (const skillId of state.character.learnedSkills || []) {
      const source = state.character.skillRecords?.[skillId] || {};
      const legacy = state.character.skills?.[skillId] || {};
      const sourceId = source.sourceId || legacy.sourceId;
      if (!sourceId || (source.lifeIndex != null && Number(source.lifeIndex) !== Number(state.character.lifeIndex))) continue;
      const key = `${state.character.lifeIndex}:${skillId}:${sourceId}`;
      if (known.has(key)) continue;
      const row = { lifeIndex: state.character.lifeIndex, skillId,
        discipline: skillDisciplines[skillId] || "general", sourceId,
        sourceEventId: source.sourceEventId || (runtimeDefinitions.events.some((event) => event.id === legacy.sourceId) ? legacy.sourceId : null), learnedDay: source.learnedDay ?? legacy.learnedDay ?? state.worldDay,
        masteryMilli: 0, understandingMilli: 0,
        retainedFromLife: source.retainedFromLife ?? null, causeId: sourceId };
      rows.push(row);
      state.facts.r5_fact_skill_mastery ||= [];
      state.facts.r5_fact_skill_mastery.push(clone(row));
      state.r5LifeLedger.factLog.push({ kind: "skill_source", ...clone(row) });
      known.add(key);
    }
  }

  function sourceRecordIndex(state) {
    const currentLife = Number(state.character.lifeIndex || 1);
    const index = new Map();
    for (const row of [...(state.causeLog || []), ...(state.r5LifeLedger.factLog || [])]) {
      if (row?.causeId && Number(row.lifeIndex || currentLife) === currentLife && Number(row.day ?? row.worldDay ?? 0) <= state.worldDay) index.set(row.causeId, row);
    }
    return index;
  }

  function pathValue(root, path) {
    return String(path || "").split(".").filter(Boolean).reduce((value, key) => value?.[key], root);
  }

  function recordFateGateEvidence(gateId, sourceCauseIds, transactionId, choiceId = null) {
    let state = r5State(base.save());
    const replay = txReplay(state, transactionId);
    if (replay) return replay;
    const expectedStage = { know_fate_records: "r5_stage_spirit_09_dharma_form", accept_fate_limit: "r5_stage_spirit_10_know_fate", change_fate_outcome: "r5_stage_spirit_10_accept_fate" }[gateId];
    if (!expectedStage || activeStage(state) !== expectedStage) return "fate_gate_out_of_order";
    const ids = [...new Set(sourceCauseIds || [])];
    const known = sourceRecordIndex(state);
    const gates = state.facts.r5_fact_fate_gate ||= [];
    if (gates.some((row) => row.lifeIndex === state.character.lifeIndex && row.gateId === gateId && ["verified", "prepared"].includes(row.status))) return "fate_gate_already_recorded";
    let evidence, effect, status = "verified";
    if (gateId === "know_fate_records") {
      if (ids.length < 2 || ids.some((sourceId) => !known.has(sourceId))) return "two_distinct_current_life_records_required";
      evidence = ids.map((sourceId) => ({ causeId: sourceId, eventId: known.get(sourceId).eventId || null, operation: known.get(sourceId).operation || null, day: known.get(sourceId).day ?? known.get(sourceId).worldDay ?? null }));
      effect = { recordsCompared: evidence.length, historicalWorldStateChanged: false, futureKnown: false };
    } else if (gateId === "accept_fate_limit") {
      const prior = gates.find((row) => row.lifeIndex === state.character.lifeIndex && row.gateId === "know_fate_records" && row.status === "verified");
      const clock = state.r5LifeLedger.lifeClock;
      const limits = {
        finite_lifespan: clock.deathDay > state.worldDay ? { deathDay: clock.deathDay, sourceId: clock.causeId } : null,
        practiced_method: state.r5LifeLedger.skills.length ? { skillIds: state.r5LifeLedger.skills.filter((row) => row.lifeIndex === state.character.lifeIndex).map((row) => row.skillId), maximumMasteryMilli: Math.max(0, ...state.r5LifeLedger.skills.filter((row) => row.lifeIndex === state.character.lifeIndex).map((row) => row.masteryMilli || 0)) } : null,
        current_resources: state.character.cashWen >= 0 ? { wealth: state.character.cashWen, inventory: clone(state.character.inventory || {}) } : null
      };
      if (!prior || !ids.length || ids.some((sourceId) => !known.has(sourceId)) || !limits[choiceId]) return "factual_limit_and_prior_know_gate_required";
      evidence = { priorGateCauseId: prior.causeId, acceptedLimit: choiceId, currentFact: limits[choiceId] };
      effect = { historicalWorldStateChanged: false, choiceId };
    } else {
      const prior = gates.find((row) => row.lifeIndex === state.character.lifeIndex && row.gateId === "accept_fate_limit" && row.status === "verified");
      const sourceId = ids[0];
      const sourceEvent = runtimeDefinitions.events.find((event) => event.runtimeBinding?.causePath && pathValue(state, event.runtimeBinding.causePath) === sourceId);
      const source = sourceEvent ? pathValue(state, sourceEvent.runtimeBinding.sourcePath) : null;
      if (!prior || ids.length !== 1 || !choiceId) return "live_unfinished_cause_and_accepted_limit_required";
      if (!sourceEvent) return "unfinished_cause_event_missing";
      if (sourceEvent.id !== "r4_ev_era_faction_successor") return `unfinished_cause_not_registered_world_consequence:${sourceEvent.id}`;
      if (!source || source.status !== "open" || source.lifeIndex !== state.character.lifeIndex || source.causeId !== sourceId || source.worldId !== state.world.id || !Number.isSafeInteger(source.expiresDay) || source.expiresDay < state.worldDay) return "unfinished_cause_source_not_live";
      status = "prepared";
      evidence = { acceptedLimitCauseId: prior.causeId, unfinishedCauseId: sourceId, eventId: sourceEvent.id, choiceId };
      effect = { consequencePrepared: true, historicalWorldStateChanged: false, currentWorldChanged: false };
    }
    const row = { gateId, status, lifeIndex: state.character.lifeIndex, day: state.worldDay, sourceCauseIds: ids, choiceId, evidence, effect, causeId: id("r5-fate-gate", state.character.lifeIndex, gateId, transactionId), transactionId };
    gates.push(clone(row));
    state.r5LifeLedger.factLog.push(clone(row));
    putTx(state, transactionId, row);
    replaceState(state);
    return clone(row);
  }

  function durationAction(state, days) {
    const before = state.world.worldDay;
    const result = base.advanceDays(days);
    const after = base.getStateForAdapter();
    const ended = !after.character.alive || after.worldDay - before < days || Boolean(result?.stoppedAtWorldNode);
    return { before, after, result, ended };
  }

  function publicLessonBoard(state) {
    const day = state.worldDay;
    const worldId = state.worldId;
    const board = state.world.dailyServiceBoards?.publicLesson;
    if (board) {
      state.people ||= {};
      state.people[board.teacherId] ||= { id: board.teacherId, alive: true, onDuty: true, location: board.locationId, role: "public_teacher", openLessonPolicy: "accept_if_venue_and_learners_are_present" };
      return board;
    }
    // This is the same dated public-service source initialized by the B reference world.
    const value = {
      status: "open", locationId: "r4_loc_willow_market", causeId: `${worldId}:book-loan:${day}`,
      clerkId: "r4_npc_han_jian", teacherId: "r4_npc_public_teacher",
      bookId: `${worldId}:public-book:${day}`, loanStatus: "available",
      missingPage: { page: 17, lastBorrowerId: "r4_npc_stall_neighbor", status: "recorded_missing" },
      revisionNotice: { status: "posted", edition: "revised", page: 17 }
    };
    state.world.dailyServiceBoards ||= {};
    state.world.dailyServiceBoards.publicLesson = value;
    state.people ||= {};
    state.people.r4_npc_public_teacher ||= { id: value.teacherId, alive: true, onDuty: true, location: value.locationId, role: "public_teacher", openLessonPolicy: "accept_if_venue_and_learners_are_present" };
    return value;
  }

  function worldOwnedEventInstance(event, instanceId, state) {
    const scope = event.instanceScope || "world";
    if (!PERSISTENT_WORLD_SCOPES.has(scope) || PERSONAL_OR_LIFE_SCOPES.has(scope) || scope.startsWith("character_")) return false;
    const worldId = state.worldId;
    if (scope === "world_crisis_instance") return (state.world.crisisInstances || []).some((instance) => instance.id === instanceId);
    if (scope === "demand_instance") return instanceId === worldId || (state.world.workBoard || []).some((task) => task.id === instanceId);
    if (scope === "conflict_instance") return instanceId === worldId || instanceId === state.world.conflict?.id;
    if (scope === "repair_task") return instanceId === worldId || instanceId === state.world.repairTask?.id;
    if (scope === "person_request") return instanceId === worldId || [state.world.requestId, state.world.requestingPerson, state.world.request?.id].includes(instanceId);
    if (scope === "furnace_state") return instanceId === worldId || instanceId === state.world.furnace?.id;
    if (scope === "harvest_batch") return Object.keys(state.world.locations || {}).some((locationId) => instanceId.startsWith(`${locationId}:`));
    if (scope === "cause_instance" || scope === "world_cause_instance") return instanceId === worldId || instanceId.startsWith(`${worldId}:`);
    return instanceId === worldId;
  }

  function carryWorldEventState(previous, successor) {
    const eventById = new Map(runtimeDefinitions.events.map((event) => [event.id, event]));
    const carriedClaims = {};
    for (const [key, claim] of Object.entries(previous.eventClaimLedger || {})) {
      if (claim?.state !== "completed" && claim?.state !== "expired") continue;
      for (const event of runtimeDefinitions.events) {
        const marker = `:${event.id}:`;
        const markerAt = key.lastIndexOf(marker);
        if (markerAt < 0 || !/^\d+$/.test(key.slice(markerAt + marker.length))) continue;
        const instanceId = key.slice(0, markerAt);
        if (worldOwnedEventInstance(event, instanceId, previous)) carriedClaims[key] = claim;
        break;
      }
    }
    const queued = [];
    const queueKeys = new Set();
    for (const entry of [...(previous.queue || []), ...(successor.queue || [])]) {
      const event = eventById.get(entry.eventId);
      if (!event || !worldOwnedEventInstance(event, entry.instanceId, previous)) {
        if ((successor.queue || []).includes(entry)) queued.push(entry);
        continue;
      }
      const claim = carriedClaims[`${entry.instanceId}:${entry.eventId}:0`];
      if (claim?.state === "completed" || claim?.state === "expired") continue;
      const key = `${entry.eventId}:${entry.instanceId}`;
      if (!queueKeys.has(key)) { queueKeys.add(key); queued.push(entry); }
    }
    return { claims: { ...(successor.eventClaimLedger || {}), ...carriedClaims }, queue: queued };
  }

  function txReplay(state, txid) { return clone(state.r5LifeLedger.transactions[txid] || null); }
  function putTx(state, txid, result) { state.r5LifeLedger.transactions[txid] = clone(result); }

  function initialize(origin = "system", characterId = "r5-player", worldId = "r5-world") {
    const originId = origin.startsWith("r4_origin_") ? origin : `r4_origin_${origin}`;
    base = createR4WorldEngine({ pack, definitions: runtimeDefinitions, seedConfig, now, realmSourceAdapter: "r5", r6FreeSurvival, r6TimeContract });
    const started = base.start(originId);
    if (!started?.ok) throw new Error(started?.error || "r5_origin_initialization_failed");
    world = r5State(base.save());
    const previousWorldId = world.worldId;
    const previousCharacterId = world.character.id;
    world = replaceIdentifiers(world, [[previousWorldId, worldId || previousWorldId], [previousCharacterId, characterId || previousCharacterId]]);
    world.worldId = worldId || previousWorldId;
    world.character.id = characterId || previousCharacterId;
    world.character.lifeIndex = 1;
    world.world.id = world.worldId;
    ensureR6ProvisionStores(world);
    Object.assign(world.character, {
      r5DimensionLevels: Object.fromEntries(DIMENSIONS.map((key) => [key, 0])),
      r5InheritedMastery: {}, r5UnpracticedMemory: {}, r5PersonalPracticeUnits: 0,
      r5PhysicalConditioningUnits: 0, r5UnspentWallet: 0, r5StageId: INITIAL_STAGE,
      deathDay: world.character.birthDay + lifespanDays(world), lifeStartWorldTick: world.character.birthDay * 96
    });
    world.r5LifeLedger = blankLife(1);
    world.r5LifeLedger.lifeClock = {
      lifeIndex: 1, birthDay: world.character.birthDay, deathDay: world.character.deathDay,
      source: "r5_lifespan_formula_v1", causeId: id("life", 1, "birth"), playableDay: world.worldDay
    };
    publicLessonBoard(world);
    world.facts.r5_fact_progression_current = { lifeIndex: 1, stageId: INITIAL_STAGE, source: "origin", sourceId: id("r5-origin", world.worldId, world.character.id), day: world.worldDay, causeId: id("life", 1, "birth") };
    world.facts.r5_fact_progression_attainment = [];
    world.facts.r5_fact_skill_mastery = [];
    world.facts.r5_fact_life_score_cause = [];
    world.facts.r5_fact_life_clock = clone(world.r5LifeLedger.lifeClock);
    world.facts.r4_fact_life_clock = { ...(world.facts.r4_fact_life_clock || {}), birthDay: world.character.birthDay, deathDay: world.character.deathDay };
    world.facts.r4_fact_realm_current = { lifeIndex: 1, realmId: "r4_realm_mortal", source: "r5_adapter_no_r4_realm_mapping", sourceId: id("r5-origin", world.worldId, world.character.id) };
    replaceState(world);
    return snapshot();
  }

  function restore(state) {
    if (state?.r5Namespace !== pack.saveNamespace || state?.r5RuntimeVersion !== "R5-RUNTIME-1") throw new Error("r5_save_namespace_or_version_mismatch");
    world = r5State(migrateR6WorldTimeDto({ runtimeState: clone(state) }).dto.runtimeState);
    ensureR6ProvisionStores(world);
    replaceState(world);
    return snapshot();
  }

  function ensureR6ProvisionStores(state) {
    state.world.r6ProvisionStores ||= {
      ashspring: { id: "r6_service_ashspring_provisions", locationId: "r4_loc_ashspring", itemId: "r6_item_travel_ration", providerId: "r6_npc_provisioner_ashspring", openingStock: 20, stock: 20, unitPriceWen: 50 },
      willow: { id: "r6_service_market_provisions", locationId: "r4_loc_willow_market", itemId: "r6_item_travel_ration", providerId: "r6_npc_provisioner_willow", openingStock: 50, stock: 50, unitPriceWen: 50 }
    };
    state.world.r6Waystop ||= {
      id: "r6_site_mirror_post", routeId: "r6_route_willow_mirror", locationId: "r4_loc_mirror_stage",
      maintainerId: "r6_npc_roadkeeper_mirror", status: "open", safe: true, portableAlchemyAllowed: true,
      routeDayOffset: { carriage: 15, walking: 23 }, creationSource: "candidate-r6-registered-waystop"
    };
    const furnaceConfig = pack.r6PortableFurnace;
    state.world.r6PortableFurnaceStore ||= {
      id: "r6_source_portable_furnace_sale", sellerId: furnaceConfig.sellerId,
      locationId: furnaceConfig.locationId, ownedStock: furnaceConfig.ownedOpeningStock,
      leaseStock: furnaceConfig.leaseOpeningStock, nextDeliveryDay: Number(state.worldDay) + furnaceConfig.restockIntervalDays
    };
    state.world.r6PortableFurnaceReceipts ||= {};
    state.world.npcRecords ||= {};
    state.world.npcRecords.r6_npc_provisioner_ashspring ||= { id: "r6_npc_provisioner_ashspring", alive: true, locationId: "r4_loc_ashspring", role: "provisioner", onDuty: true };
    state.world.npcRecords.r6_npc_provisioner_willow ||= { id: "r6_npc_provisioner_willow", alive: true, locationId: "r4_loc_willow_market", role: "provisioner", onDuty: true };
  }

  function snapshot() {
    const state = r5State(base?.getStateForAdapter());
    const snap = base.snapshot({ includeHistory: false });
    const current = activeStage(state);
    return {
      ...snap,
      mode: "r5", namespace: pack.saveNamespace, runtimeVersion: "R5-RUNTIME-1",
      character: { ...snap.character, lifeIndex: state.character.lifeIndex, r5StageId: current, r5DimensionLevels: clone(state.character.r5DimensionLevels), deathDay: state.character.deathDay },
      r5: { currentStageId: current, currentStage: stageById.get(current), attainment: clone(state.r5LifeLedger.progression.attainment), skills: currentSkills(state), lifeClock: clone(state.r5LifeLedger.lifeClock), scoreLedger: clone(state.r5LifeLedger), rebirth: clone(state.r5LifeLedger.rebirth), capabilities: unlockedCapabilities(state) }
    };
  }

  function eventView(eventId) {
    const event = base.debug.eventView(eventId);
    return event ? clone(event) : null;
  }
  function isEventAvailable(eventId) {
    const event = base.debug.eventView(eventId);
    return Boolean(event && base.debug.eventAvailable(event));
  }

  // Adapter-owned live view avoids cloning the full authoritative world for read-only projections.
  function save() { return clone(r5State(base.getStateForAdapter())); }

  function learnPublicMartialForm(transactionId) {
    let state = r5State(base.save());
    if (state.r5LifeLedger.transactions[transactionId]) return txReplay(state, transactionId);
    const char = state.character;
    const board = publicLessonBoard(state);
    const teacher = state.people?.[board.teacherId];
    const alreadyLearned = state.r5LifeLedger.skills.find((row) => row.lifeIndex === char.lifeIndex && row.skillId === "r5_skill_martial_form");
    if (alreadyLearned) return clone(alreadyLearned);
    if (!char.alive || char.location !== board.locationId || board.status !== "open" || !teacher?.alive || !teacher?.onDuty || teacher.location !== char.location) return { status: "rejected", reason: "public_teacher_or_venue_unavailable" };
    const started = state.world.worldDay;
    const advanced = durationAction(state, Number(rules.publicMartialCourseDays));
    state = r5State(advanced.after);
    if (advanced.ended || !state.character.alive) return { status: "rejected", reason: "life_ended_or_world_interrupted_during_course" };
    const liveBoard = state.world.dailyServiceBoards.publicLesson;
    const liveTeacher = state.people?.[liveBoard.teacherId];
    if (!liveTeacher?.alive || !liveTeacher?.onDuty || liveTeacher.location !== state.character.location) return { status: "rejected", reason: "public_teacher_unavailable_at_completion" };
    const skillId = "r5_skill_martial_form";
    const causeId = id("r5-public-course", state.world.id, char.lifeIndex, liveBoard.causeId, transactionId);
    const sourceId = id("r5-teacher-lesson", liveTeacher.id, liveBoard.causeId, char.lifeIndex);
    state.character.learnedSkills ||= [];
    state.character.learnedSkills.push(skillId);
    state.character.skillRecords ||= {};
    state.character.skillRecords[skillId] = { skillId, lifeIndex: char.lifeIndex, sourceId, sourceEventId: "r5_public_teacher_course", learnedDay: state.world.worldDay, proficiency: 0 };
    const skill = { lifeIndex: char.lifeIndex, skillId, discipline: "martial", sourceId, sourceEventId: "r5_public_teacher_course", learnedDay: state.world.worldDay, masteryMilli: 0, understandingMilli: 0, retainedFromLife: null, causeId, teacherId: liveTeacher.id, venueId: liveBoard.locationId, courseStartedDay: started, courseCompletedDay: state.world.worldDay, status: "completed" };
    state.r5LifeLedger.skills.push(skill);
    const receipt = { status: "completed", skillId, teacherId: liveTeacher.id, venueId: liveBoard.locationId, startedDay: started, completedDay: state.world.worldDay, lifeIndex: char.lifeIndex, causeId, transactionId };
    state.world.r5TrainingCourses ||= [];
    state.world.r5TrainingCourses.push(clone(receipt));
    state.r5LifeLedger.factLog.push(clone(receipt));
    putTx(state, transactionId, receipt);
    replaceState(state);
    return clone(receipt);
  }

  function trainBlock(skillId, transactionId) {
    let state = r5State(base.save());
    const replay = txReplay(state, transactionId);
    if (replay) return replay;
    const char = state.character;
    const skill = currentSkills(state).find((row) => row.skillId === skillId);
    if (!skill || !(char.learnedSkills || []).includes(skillId)) return { status: "rejected", reason: "skill_not_learned_in_current_life" };
    if (!char.alive) return { status: "rejected", reason: "life_not_active" };
    if (Number(char.health) <= rules.trainingHealthFloor) return { status: "rejected", reason: "health_below_training_floor" };
    if (skillId === "r5_skill_martial_form") {
      const board = publicLessonBoard(state);
      const teacher = state.people?.[board.teacherId];
      if (char.location !== board.locationId || board.status !== "open" || !teacher?.alive || !teacher?.onDuty || teacher.location !== char.location) return { status: "rejected", reason: "current_public_practice_authority_missing" };
    }
    const started = state.world.worldDay;
    let practiceActionTransactionId = null;
    if (skillId === "r5_skill_martial_form") {
      const advanced = durationAction(state, rules.practiceDaysPerBlock);
      state = r5State(advanced.after);
      if (advanced.ended || !state.character.alive) return { status: "rejected", reason: "life_ended_or_world_interrupted_during_practice" };
      state.character.health = Math.max(0, state.character.health - rules.practiceHealthCost);
    } else {
      let action = base.performAction("r4_action_practice", { mode: "practice", skillId });
      if (action?.error) return { status: "rejected", reason: action.error };
      while (action?.kind === "progress") {
        action = base.advanceTransaction(Math.max(1, action.transaction?.durationDays || rules.practiceDaysPerBlock));
        if (action?.stoppedAtWorldNode) return { status: "rejected", reason: "world_event_interrupted_during_practice", eventId: action.pauseEventId || null };
      }
      if (action?.kind !== "result" || action.outcome !== "success") {
        if (action?.kind === "result" || action?.kind === "interrupted") base.acknowledgeResult();
        return { status: "rejected", reason: action?.outcome === "interrupted" ? "life_ended_during_practice" : action?.error || "registered_practice_action_not_completed" };
      }
      base.acknowledgeResult();
      state = r5State(base.save());
      const actionReceipt = state.character.actionLog?.at(-1);
      if (actionReceipt?.actionId !== "r4_action_practice" || actionReceipt.skillId !== skillId || actionReceipt.outcome !== "success") return { status: "rejected", reason: "registered_practice_receipt_skill_mismatch" };
      practiceActionTransactionId = actionReceipt.transactionId;
    }
    const current = currentSkills(state).find((row) => row.skillId === skillId);
    const levels = state.character.r5DimensionLevels || {};
    const masteryDelta = rules.practiceUnitsPerBlock * (1 + Math.floor(Number(levels.naturalTalent || 0) / 5));
    const understandingDelta = rules.practiceUnitsPerBlock * (1 + Math.floor(Number(levels.aptitude || 0) / 5));
    current.masteryMilli = Math.min(rules.masteryCapMilli, current.masteryMilli + masteryDelta);
    current.understandingMilli = Math.min(rules.masteryCapMilli, current.understandingMilli + understandingDelta);
    state.character.r5PersonalPracticeUnits = Number(state.character.r5PersonalPracticeUnits || 0) + masteryDelta;
    const causeId = id("r5-practice", char.lifeIndex, transactionId);
    const row = { id: transactionId, lifeIndex: char.lifeIndex, skillId, discipline: current.discipline, skillSourceId: current.sourceId, startedDay: started, day: state.world.worldDay, units: masteryDelta, masteryMilli: current.masteryMilli, understandingDeltaMilli: understandingDelta, understandingMilli: current.understandingMilli, causeId, transactionId, status: "completed" };
    row.practiceActionTransactionId = practiceActionTransactionId;
    state.r5LifeLedger.factLog.push(row);
    putTx(state, transactionId, row);
    replaceState(state);
    return clone(row);
  }

  function conditioningBlock(transactionId) {
    let state = r5State(base.save());
    const replay = txReplay(state, transactionId);
    if (replay) return replay;
    if (!state.character.alive || state.character.health <= rules.trainingHealthFloor) return { status: "rejected", reason: "life_or_health_not_ready" };
    const started = state.world.worldDay;
    const advanced = durationAction(state, rules.trainingBlockDays);
    state = r5State(advanced.after);
    if (advanced.ended || !state.character.alive) return { status: "rejected", reason: "life_ended_or_world_interrupted_during_conditioning" };
    state.character.health = Math.max(0, state.character.health - rules.conditioningHealthCost);
    const units = rules.conditioningUnitsPerBlock;
    state.character.r5PhysicalConditioningUnits = Number(state.character.r5PhysicalConditioningUnits || 0) + units;
    const row = { status: "completed", lifeIndex: state.character.lifeIndex, startedDay: started, day: state.world.worldDay, units, totalUnits: state.character.r5PhysicalConditioningUnits, transactionId, causeId: id("r5-conditioning", state.character.lifeIndex, transactionId) };
    state.r5LifeLedger.factLog.push(row);
    putTx(state, transactionId, row);
    replaceState(state);
    return clone(row);
  }

  function recover(transactionId) {
    let state = r5State(base.save());
    const replay = txReplay(state, transactionId);
    if (replay) return replay;
    if (!state.character.alive) return { status: "rejected", reason: "life_not_active" };
    const before = state.character.health;
    let result = base.performAction("r4_action_recover", { transactionId });
    if (result?.error) return result;
    while (result?.kind === "progress") {
      result = base.advanceTransaction(Math.max(1, result.transaction?.durationDays || 1));
      if (result?.stoppedAtWorldNode) return { status: "pending_world_event", eventId: result.pauseEventId || null };
    }
    if (result?.kind !== "result") return { status: "rejected", reason: result?.outcome || result?.kind || "recovery_not_completed" };
    base.acknowledgeResult();
    state = r5State(base.save());
    const extra = Number(state.character.r5DimensionLevels?.bloodline || 0);
    state.character.health = Math.min(Number(state.character.maxHealth || 100), Number(state.character.health || 0) + extra);
    const row = { status: "completed", transactionId, lifeIndex: state.character.lifeIndex, day: state.world.worldDay, healthBefore: before, healthAfter: state.character.health, bloodlineBonus: extra, causeId: id("r5-recovery", state.character.lifeIndex, transactionId) };
    state.r5LifeLedger.factLog.push(row);
    putTx(state, transactionId, row);
    replaceState(state);
    return clone(row);
  }

  function breakthroughChance(state, stageId) {
    const stage = stageById.get(stageId);
    const currentId = activeStage(state);
    if (!stage || stage.progressionRank !== rankById.get(currentId) + 1) return 0;
    const eligible = currentSkills(state).filter((row) => !stage.requiredDisciplines?.length || stage.requiredDisciplines.includes(row.discipline));
    const mastery = Math.max(0, ...eligible.map((row) => Number(row.masteryMilli || 0)));
    const understanding = Math.max(0, ...eligible.map((row) => Number(row.understandingMilli || 0)));
    if (mastery < Number(stage.practiceUnitsRequired || 0) || understanding < Number(stage.understandingUnitsRequired || 0) || Number(state.character.r5PhysicalConditioningUnits || 0) < Number(stage.physicalConditioningUnitsRequired || 0)) return 0;
    return Math.min(rules.maximumBreakthroughChanceBasisPoints, rules.baseBreakthroughChanceBasisPoints + Math.floor(mastery / 100) + Number(state.character.r5DimensionLevels?.fortune || 0) * 100);
  }

  async function sha256(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function attemptBreakthrough(stageId, transactionId) {
    let state = r5State(base.save());
    const replay = txReplay(state, transactionId);
    if (replay) return replay;
    if (reserved.has(stageId)) return { status: "rejected", reason: "stage_reserved" };
    const stage = stageById.get(stageId);
    const currentId = activeStage(state);
    if (!stage || stage.progressionRank !== rankById.get(currentId) + 1) return { status: "rejected", reason: "not_next_playable_stage" };
    const requiredGate = stage.requiredGateEvidence;
    if (requiredGate) {
      const acceptable = requiredGate === "change_fate_outcome" ? new Set(["verified", "prepared"]) : new Set(["verified"]);
      if (!(state.facts.r5_fact_fate_gate || []).some((row) => row.lifeIndex === state.character.lifeIndex && row.gateId === requiredGate && acceptable.has(row.status))) return { status: "rejected", reason: `required_fate_gate_evidence_missing:${requiredGate}` };
    }
    const chance = breakthroughChance(state, stageId);
    if (!chance) return { status: "rejected", reason: "practice_or_skill_evidence_missing" };
    if (!state.character.alive || state.character.health <= 0) return { status: "rejected", reason: "life_not_active" };
    const digest = await sha256(`${state.world.id}:${state.character.id}:${state.character.lifeIndex}:${transactionId}`);
    const roll = Number.parseInt(digest.slice(0, 8), 16) % 10000;
    const beforeDay = state.world.worldDay;
    const advanced = durationAction(state, rules.breakthroughAttemptDays);
    state = r5State(advanced.after);
    if (advanced.ended || !state.character.alive) return { status: "rejected", reason: "life_ended_or_world_interrupted_during_breakthrough" };
    state.character.health = Math.max(0, state.character.health - rules.breakthroughHealthCost);
    const causeId = id("r5-attainment", state.character.lifeIndex, stageId, transactionId);
    const success = roll < chance;
    const practicedSkill = currentSkills(state).filter((row) => !stage.requiredDisciplines?.length || stage.requiredDisciplines.includes(row.discipline)).sort((a, b) => Number(b.masteryMilli || 0) - Number(a.masteryMilli || 0))[0];
    const outcome = { status: success ? "success" : "failure", outcomeId: success ? "success" : "failure", eventId: "r5_daily_breakthrough", sourceId: causeId, fromStageId: currentId, stageId: success ? stageId : currentId, attemptedStageId: stageId, chanceBasisPoints: chance, rollBasisPoints: roll, day: state.world.worldDay, startedDay: beforeDay, causeId, transactionId, lifeIndex: state.character.lifeIndex };
    if (practicedSkill) outcome.skillId = practicedSkill.skillId;
    if (success) {
      state.r5LifeLedger.progression.current = { lifeIndex: state.character.lifeIndex, stageId, source: "successful_breakthrough", sourceId: causeId, day: state.world.worldDay, causeId };
      state.r5LifeLedger.progression.attainment.push(clone(outcome));
      state.character.r5StageId = stageId;
      state.character.deathDay = state.character.birthDay + lifespanDays(state, stageId);
      state.r5LifeLedger.lifeClock.deathDay = state.character.deathDay;
      state.r5LifeLedger.lifeClock.lastExtendedBy = causeId;
      state.facts.r5_fact_progression_current = clone(state.r5LifeLedger.progression.current);
      state.facts.r5_fact_progression_attainment = clone(state.r5LifeLedger.progression.attainment);
      state.facts.r5_fact_life_clock.deathDay = state.character.deathDay;
      state.facts.r4_fact_life_clock.deathDay = state.character.deathDay;
      recordScore(state, "stage_attainment", "r5_daily_breakthrough", stageId, causeId, stage.scorePoints, transactionId);
    }
    state.causeLog.push({ day: state.world.worldDay, operation: "r5_stage_attempt", eventId: "r5_daily_breakthrough", optionId: stageId, outcomeId: outcome.outcomeId, causeId, transactionId, lifeIndex: state.character.lifeIndex });
    state.r5LifeLedger.factLog.push(clone(outcome));
    state.facts.r5_fact_life_score_cause ||= [];
    state.facts.r5_fact_life_score_cause.push({ kind: "stage_attempt", ...clone(outcome) });
    putTx(state, transactionId, outcome);
    replaceState(state);
    return clone(outcome);
  }

  function unlockedCapabilities(state = r5State(base.getStateForAdapter())) {
    const owned = new Set();
    for (const stage of stages) if (stage.progressionRank <= rankById.get(activeStage(state))) for (const capability of stage.capabilities || []) owned.add(capability);
    return [...owned];
  }

  function capabilityView(capabilityId, targetId = null) {
    const state = r5State(base.save());
    const handler = rules.capabilityHandlers?.[capabilityId] || null;
    const contract = rules.capabilityContracts?.[capabilityId] || null;
    const isUnlocked = unlockedCapabilities(state).includes(capabilityId);
    const disciplineList = contract?.disciplines || [];
    const skillRows = currentSkills(state).filter((row) => disciplineList.length === 0 || disciplineList.includes(row.discipline));
    const learned = disciplineList.length ? skillRows.length > 0 : null;
    const mastered = disciplineList.length ? skillRows.some((row) => Number(row.masteryMilli || 0) >= rules.masteryCapMilli) : null;
    const targetKind = contract?.targetKinds?.[0] || null;
    let permission = targetId == null ? "not_checked" : false;
    if (targetId != null && isUnlocked && handler === "martial_contest") permission = skillRows.some((row) => row.skillId === targetId && state.character.location === publicLessonBoard(state).locationId);
    return { capabilityId, unlocked: isUnlocked, learned, mastered, permission, handler, disciplines: disciplineList, targetKind };
  }

  function useCapability(capabilityId, targetId, transactionId, choiceId = null) {
    const before = r5State(base.save());
    const replay = txReplay(before, transactionId);
    if (replay) return replay;
    const handler = rules.capabilityHandlers?.[capabilityId];
    const contract = rules.capabilityContracts?.[capabilityId];
    if (!handler || !contract) return { status: "rejected", reason: "capability_handler_unregistered" };
    if (!unlockedCapabilities(before).includes(capabilityId)) return { status: "rejected", reason: "capability_not_unlocked" };
    const singleUse = new Set(rules.capabilityUnlockPolicy?.singleUseCapabilities || []);
    if (singleUse.has(capabilityId) && before.r5LifeLedger.capabilities.some((row) => row.capabilityId === capabilityId && row.lifeIndex === before.character.lifeIndex)) return { status: "rejected", reason: "single_use_capability_already_resolved_this_life" };
    const required = new Set(contract.disciplines || []);
    const skillTargetHandlers = new Set(["martial_contest", "training_sequence", "spirit_entry_practice", "training_comparison", "spell_action", "inner_conflict_resolution"]);
    const disciplineSkill = currentSkills(before).find((row) => before.character.learnedSkills.includes(row.skillId) && (!required.size || required.has(row.discipline)));
    const skill = skillTargetHandlers.has(handler)
      ? currentSkills(before).find((row) => row.skillId === targetId && before.character.learnedSkills.includes(targetId) && (!required.size || required.has(row.discipline)))
      : disciplineSkill;
    const reject = (reason) => { replaceState(before); return { status: "rejected", reason }; };
    if (required.size && !skill) return reject("stage_discipline_source_missing");
    let effect;
    let cultivationAuthority = null;
    if (["martial_contest", "training_sequence", "spirit_entry_practice"].includes(handler)) {
      if (!skill || !before.character.alive) return reject("current_life_learned_skill_target_required");
      if (handler === "martial_contest") {
        if (skill.discipline !== "martial") return reject("learned_martial_skill_required");
        const minimum = Number(stageById.get(activeStage(before))?.practiceUnitsRequired || 0);
        if (Number(skill.masteryMilli || 0) < minimum) return reject("current_martial_mastery_too_low");
      }
      if (handler === "spirit_entry_practice") {
        const board = publicLessonBoard(before); const teacher = before.people?.[board.teacherId];
        if (skill.discipline !== "cultivation" || before.character.location !== board.locationId || !teacher?.alive || !teacher?.onDuty || teacher.location !== before.character.location) return reject("current_public_cultivation_source_missing");
        cultivationAuthority = { teacherId: teacher.id, sourceBoardCauseId: board.causeId };
      }
      const first = trainBlock(targetId, `${transactionId}:1`);
      if (first.status !== "completed") return reject(first.reason || "training_block_failed");
      if (handler === "training_sequence") {
        const second = trainBlock(targetId, `${transactionId}:2`);
        if (second.status !== "completed") return reject(second.reason || "training_sequence_block_failed");
        effect = { trainingReceipts: [first, second], status: "completed" };
      } else effect = handler === "spirit_entry_practice" ? { datedCultivationPractice: first, ...cultivationAuthority, currentSkillMasteryMilli: first.masteryMilli } : { datedTechniqueDrill: first, previousMasteryMilli: skill.masteryMilli, newMasteryMilli: first.masteryMilli, contestWindowClosed: true };
    } else if (handler === "self_state_record") {
      if (targetId !== before.character.id) return reject("self_state_target_mismatch");
      const observation = { kind: "bounded_self_state", lifeIndex: before.character.lifeIndex, day: before.worldDay, ageDays: before.character.ageDays, health: before.character.health, remainingLifeDays: Math.max(0, before.character.deathDay - before.worldDay), knownSkillIds: [...before.character.learnedSkills].sort(), causeId: id("r5-observation", transactionId) };
      before.facts.r5_fact_observation ||= []; before.facts.r5_fact_observation.push(observation); effect = { observation, hiddenWorldFactsRead: false };
    } else if (handler === "training_comparison") {
      if (!skill) return reject("current_life_learned_skill_target_required");
      const rows = before.r5LifeLedger.factLog.filter((row) => row.lifeIndex === before.character.lifeIndex && row.skillId === targetId && row.status === "completed" && row.transactionId);
      if (rows.length < 2) return reject("two_real_training_receipts_required");
      const [left, right] = rows.slice(-2); const comparison = { kind: "training_step_comparison", lifeIndex: before.character.lifeIndex, skillId: targetId, fromMasteryMilli: left.masteryMilli, toMasteryMilli: right.masteryMilli, delta: right.masteryMilli - left.masteryMilli, sourceCauseIds: [left.causeId, right.causeId], day: before.worldDay };
      before.facts.r5_fact_observation ||= []; before.facts.r5_fact_observation.push(comparison); effect = { comparison };
    } else if (handler === "visible_person_observation") {
      const person = before.people?.[targetId]; if (!person || person.alive !== true || person.location !== before.character.location) return reject("person_not_alive_and_visible_here");
      const observation = { kind: "visible_person_observation", lifeIndex: before.character.lifeIndex, personId: targetId, day: before.worldDay, visibleFields: Object.fromEntries(["alive", "location", "role"].filter((key) => key in person).map((key) => [key, person[key]])) };
      before.facts.r5_fact_observation ||= []; before.facts.r5_fact_observation.push(observation); effect = { observation, privateFieldsRead: false };
    } else if (handler === "recovery_action") {
      if (targetId !== before.character.id) return reject("recovery_target_must_be_self");
      const receipt = recover(`${transactionId}:recover`); if (receipt.status !== "completed") return reject(receipt.reason || "recovery_not_completed"); effect = { recoveryReceipt: receipt };
    } else if (handler === "spell_action") {
      if (!skill || !before.character.learnedSkills.includes(targetId) || skill.discipline !== "cultivation") return reject("actually_learned_art_required");
      const beforeAction = { health: before.character.health, spellProficiency: before.character.spellProficiency || 0 };
      let result = base.performAction("r4_action_spell", { skillId: targetId, ability: targetId, transactionId: `${transactionId}:spell` });
      if (result?.error) return reject(result.error);
      while (result?.kind === "progress") {
        result = base.advanceTransaction(Math.max(1, result.transaction?.durationDays || 1));
        if (result?.stoppedAtWorldNode) return reject("world_event_interrupted_spell_action");
      }
      if (result?.kind !== "result") return reject(result?.error || "spell_action_not_completed");
      base.acknowledgeResult(); const afterAction = r5State(base.save());
      effect = { before: beforeAction, after: { health: afterAction.character.health, spellProficiency: afterAction.character.spellProficiency || 0 }, day: afterAction.worldDay, outcome: result.outcome, actionReceipt: result };
    } else if (handler === "inner_conflict_resolution") {
      if (!skill || !before.character.learnedSkills.includes(targetId) || !["continue_practice", "conserve_body"].includes(choiceId)) return reject("current_skill_and_conflict_choice_required");
      const accepted = (before.facts.r5_fact_fate_gate || []).find((row) => row.lifeIndex === before.character.lifeIndex && row.gateId === "accept_fate_limit" && row.status === "verified" && row.choiceId === "finite_lifespan");
      if (!accepted) return reject("lived_limit_and_practiced_skill_evidence_required");
      const beforeState = { health: before.character.health, masteryMilli: skill.masteryMilli, day: before.worldDay };
      const action = choiceId === "continue_practice" ? trainBlock(targetId, `${transactionId}:inner-practice`) : recover(`${transactionId}:inner-recovery`);
      if (action?.status !== "completed") return reject(action?.reason || "inner_conflict_action_failed");
      const afterState = r5State(base.save()); const afterSkill = currentSkills(afterState).find((row) => row.skillId === targetId);
      const conflict = { kind: "current_life_inner_conflict", lifeIndex: afterState.character.lifeIndex, acceptedLimitCauseId: accepted.causeId, skillId: targetId, choiceId, actionReceipt: action, before: beforeState, after: { health: afterState.character.health, masteryMilli: afterSkill?.masteryMilli, day: afterState.worldDay }, causeId: id("r5-inner-conflict", transactionId) };
      afterState.facts.r5_fact_observation ||= []; afterState.facts.r5_fact_observation.push(conflict); replaceState(afterState); effect = { conflict };
    } else if (handler === "bounded_external_projection") {
      const cost = Number(rules.capabilityActionCosts?.boundedExternalActionHealth || 2);
      if (Number(before.character.health || 0) <= cost) return reject("insufficient_resource");
      const route = before.world.routes.find((row) => row.from === before.character.location && row.to === targetId);
      if (!route || !before.character.knownLocations.includes(targetId)) return reject("verified_adjacent_known_route_required");
      if (before.character.location !== "r4_loc_willow_market" || targetId !== "r4_loc_ashspring") return reject("permitted_adjacent_route_target_required");
      const board = before.world.dailyServiceBoards?.road;
      if (board?.verifiedRoute?.verified !== true || board.verifiedRoute.direction !== targetId || !["damaged", "missing", "unmarked"].includes(board.sign?.status)) return reject("current_verified_route_and_damaged_sign_required");
      const event = runtimeDefinitions.events.find((row) => row.id === "r4_ev_daily_roadmarker");
      if (!event) return reject("registered_route_notice_missing");
      const authority = base.acceptDailyBoardAuthority(event.id);
      if (authority?.kind !== "authority") return reject(authority?.error || "current_life_route_sign_permit_required");
      const source = base.openDailyBusinessSource(event.id);
      if (source?.kind !== "source") return reject(source?.error || "roadmarker_source_missing");
      const eligibility = base.debug.eventView(event.id);
      if (!eligibility?.options.some((row) => row.id === "replace_with_verified_sign" && row.available)) return reject("roadmarker_event_choice_ineligible");
      const authorizedState = r5State(base.save());
      const authorizedBoard = authorizedState.world.dailyServiceBoards.road;
      const permit = authorizedBoard.permitByCharacter?.[before.character.id];
      if (!permit || permit.lifeIndex !== before.character.lifeIndex || permit.status !== "valid" || permit.expiresDay < before.worldDay) return reject("current_life_route_sign_permit_required");
      const signBefore = clone(authorizedBoard.sign);
      const result = resolveWorldChoice(event.id, "replace_with_verified_sign", `${transactionId}:event`);
      if (result?.kind !== "result" || result.outcome !== "success") return reject("registered_route_sign_action_unavailable");
      const afterState = r5State(base.save()); const afterBoard = afterState.world.dailyServiceBoards?.road;
      if (!afterBoard || JSON.stringify(signBefore) === JSON.stringify(afterBoard.sign)) return reject("route_sign_state_unchanged");
      afterState.character.health -= cost; replaceState(afterState);
      effect = { eventId: event.id, route: clone(route), permit: clone(permit), signBefore, signAfter: clone(afterBoard.sign), locationId: afterState.character.location, healthAfter: afterState.character.health, worldDay: afterState.worldDay };
    } else if (handler === "bounded_environment_effect") {
      const cost = Number(rules.capabilityActionCosts?.boundedEnvironmentHealth || 2);
      if (targetId !== "r4_ev_era_lingxu_repair" || choiceId !== "follow_public_rotation") return reject("registered_bounded_water_rotation_required");
      if (Number(before.character.health || 0) <= cost) return reject("insufficient_resource");
      const event = runtimeDefinitions.events.find((row) => row.id === targetId);
      const source = pathValue(before, event?.runtimeBinding?.sourcePath);
      if (!source || source.status !== "open" || source.lifeIndex !== before.character.lifeIndex || source.worldId !== before.world.id) return reject("live_current_life_bounded_environment_source_required");
      const claimsBefore = clone(before.world.irrigationClaims || []);
      const result = resolveWorldChoice(targetId, choiceId, `${transactionId}:event`);
      if (result?.kind !== "result" || result.outcome !== "success") return reject("bounded_water_rotation_not_resolved");
      const afterState = r5State(base.save()); const claimsAfter = clone(afterState.world.irrigationClaims || []);
      if (JSON.stringify(claimsBefore) === JSON.stringify(claimsAfter)) return reject("environment_state_unchanged");
      afterState.character.health -= cost; replaceState(afterState);
      effect = { eventId: targetId, affectedRegion: "r4_loc_ashspring", costHealth: cost, irrigationClaimsBefore: claimsBefore, irrigationClaimsAfter: claimsAfter, worldDay: afterState.worldDay };
    } else if (handler === "unfinished_event_resolution") {
      const event = runtimeDefinitions.events.find((row) => row.id === targetId);
      const source = pathValue(before, event?.runtimeBinding?.sourcePath);
      if (!source || source.status !== "open" || source.lifeIndex !== before.character.lifeIndex || source.worldId !== before.world.id || !Number.isSafeInteger(source.expiresDay) || source.expiresDay < before.worldDay) return reject("live_current_life_event_source_required");
      if (activeStage(before) === "r5_stage_spirit_10_accept_fate") {
        const result = recordFateGateEvidence("change_fate_outcome", [source.causeId], `${transactionId}:gate`, choiceId);
        if (!result || typeof result !== "object") return reject(result || "live_unfinished_cause_and_accepted_limit_required");
        effect = { gateReceipt: result };
      } else if (activeStage(before) === "r5_stage_spirit_10_change_fate") {
        if (targetId !== "r4_ev_era_faction_successor") return reject("prepared_current_life_world_consequence_required");
        const prepared = (before.facts.r5_fact_fate_gate || []).find((row) => row.lifeIndex === before.character.lifeIndex && row.gateId === "change_fate_outcome" && row.status === "prepared" && row.sourceCauseIds.includes(source.causeId));
        if (!prepared) return reject("prepared_current_life_world_consequence_required");
        const result = resolveWorldChoice(targetId, choiceId, `${transactionId}:resolution`);
        if (result?.kind !== "result") return reject(result?.error || "faction_successor_resolution_failed");
        const afterState = r5State(base.save()); const gate = afterState.facts.r5_fact_fate_gate.find((row) => row.causeId === prepared.causeId);
        gate.status = "verified"; gate.resolutionCauseId = id("r5-consequence-resolution", transactionId); gate.resolvedDay = afterState.worldDay;
        replaceState(afterState); effect = { eventId: targetId, choiceId, preparedCauseId: prepared.causeId, resolutionCauseId: gate.resolutionCauseId, worldStatus: clone(pathValue(afterState, event.runtimeBinding?.followupPath)), worldDay: afterState.worldDay };
      } else return reject("fate_gate_out_of_order");
    } else if (handler === "accessible_record_compare") {
      const verified = (before.facts.r5_fact_fate_gate || []).some((row) => row.lifeIndex === before.character.lifeIndex && row.gateId === "know_fate_records" && row.status === "verified");
      if (!verified) {
        const result = recordFateGateEvidence("know_fate_records", [targetId, choiceId], `${transactionId}:gate`);
        if (!result || typeof result !== "object") return reject(result || "two_distinct_current_life_records_required"); effect = { gateReceipt: result };
      } else {
        const index = sourceRecordIndex(before); if (targetId === choiceId || !index.has(targetId) || !index.has(choiceId)) return reject("two_distinct_current_life_records_required");
        const comparison = { kind: "bounded_record_comparison", lifeIndex: before.character.lifeIndex, causeIds: [targetId, choiceId], eventIds: [index.get(targetId).eventId || null, index.get(choiceId).eventId || null], day: before.worldDay, futureKnown: false, causeId: id("r5-record-compare", transactionId) };
        before.facts.r5_fact_observation ||= []; before.facts.r5_fact_observation.push(comparison); effect = { comparison };
      }
    } else if (handler === "fate_acceptance") {
      const verified = (before.facts.r5_fact_fate_gate || []).some((row) => row.lifeIndex === before.character.lifeIndex && row.gateId === "accept_fate_limit" && row.status === "verified");
      if (!verified) { const result = recordFateGateEvidence("accept_fate_limit", [targetId], `${transactionId}:gate`, choiceId); if (!result || typeof result !== "object") return reject(result || "factual_limit_and_prior_know_gate_required"); effect = { gateReceipt: result }; }
      else { const record = sourceRecordIndex(before); if (choiceId !== "finite_lifespan" || before.character.deathDay <= before.worldDay || !record.has(targetId)) return reject("current_limit_and_source_evidence_required"); const acceptance = { kind: "bounded_fate_limit_acceptance", lifeIndex: before.character.lifeIndex, causeId: targetId, acceptedLimit: choiceId, day: before.worldDay, currentDeadline: before.character.deathDay, cause: id("r5-limit-acceptance", transactionId) }; before.facts.r5_fact_observation ||= []; before.facts.r5_fact_observation.push(acceptance); effect = { acceptance }; }
    } else if (handler === "body_capacity_upgrade") {
      if (targetId !== before.character.id || activeStage(before) !== "r5_milestone_molt_body") return reject("current_molt_body_and_self_required");
      if (before.facts.r5_fact_body_capacity) return reject("body_capacity_already_changed_this_life");
      const oldMax = Number(before.character.maxHealth || 100); before.character.maxHealth = oldMax + Number(rules.moltBodyCapacityHealth); before.character.health = Math.min(before.character.maxHealth, Number(before.character.health || 0) + Number(rules.moltBodyCapacityHealth));
      const receipt = { lifeIndex: before.character.lifeIndex, beforeMaxHealth: oldMax, afterMaxHealth: before.character.maxHealth, day: before.worldDay, sourceStageId: activeStage(before), causeId: id("r5-body-capacity", transactionId) }; before.facts.r5_fact_body_capacity = receipt; replaceState(before); effect = { receipt, healthAfter: before.character.health };
    } else if (["existing_eligible_event", "public_opportunity", "unfinished_event_resolution"].includes(handler)) {
      const event = runtimeDefinitions.events.find((row) => row.id === targetId); if (!event || !choiceId) return reject("registered_event_and_choice_required");
      const policy = rules.capabilityEventPolicy?.[capabilityId] || {}; if (handler !== "unfinished_event_resolution" && !(policy.eventIds || []).includes(targetId) && !(policy.prefixes || []).some((prefix) => targetId.startsWith(prefix))) return reject("event_not_semantically_allowed_for_capability");
      if (handler === "public_opportunity") {
        const authority = base.acceptDailyBoardAuthority(targetId); if (authority?.kind !== "authority") return reject(authority?.error || "daily_board_authority_rejected");
        const opened = base.openDailyBusinessSource(targetId); if (opened?.kind !== "source") return reject(opened?.error || "daily_business_source_rejected");
        const eligible = base.debug.eventView(targetId); if (!eligible || !eligible.options.some((row) => row.id === choiceId && row.available)) return reject("content_event_ineligible_after_source_issue");
        const result = resolveWorldChoice(targetId, choiceId, `${transactionId}:event`); if (result?.kind !== "result" || result.outcome !== "success") return reject(result?.error || "event_choice_not_committed");
        const committed = r5State(base.save()); const binding = event.runtimeBinding?.sourcePath?.split(".").reduce((value, key) => value?.[key], committed);
        const outcomeReceipt = committed.world.worldOutcomes?.[targetId];
        if (!binding || binding.status !== "completed" || !outcomeReceipt || outcomeReceipt.causeId !== binding.causeId) return reject("public_opportunity_outcome_receipt_missing");
        effect = { eventId: targetId, choiceId, authorityReceipt: clone(authority), sourceReceipt: clone(binding), outcomeReceipt: clone(outcomeReceipt), worldDay: committed.worldDay };
      } else {
        const result = resolveWorldChoice(targetId, choiceId, `${transactionId}:event`); if (result?.kind !== "result") return reject(result?.error || "event_choice_not_committed"); effect = { eventId: targetId, choiceId, outcomeId: result.outcome, outcomeReceipt: result, worldDay: r5State(base.save()).worldDay };
      }
    } else return reject("current_world_source_or_business_handler_not_yet_available");
    const after = r5State(base.save());
    const receipt = { status: "completed", capabilityId, handler, targetId, choiceId, lifeIndex: after.character.lifeIndex, day: after.worldDay, effect: clone(effect), causeId: id("r5-capability", after.character.lifeIndex, transactionId), transactionId };
    after.r5LifeLedger.capabilities.push(clone(receipt)); after.r5LifeLedger.factLog.push(clone(receipt)); putTx(after, transactionId, receipt); replaceState(after); return clone(receipt);
  }

  function resolveWorldChoice(eventId, choiceId, transactionId = null, afterRealmPractice = false, afterRealmCraft = false, afterTimedChoice = false) {
    pruneOrphanedRealmActionReservations();
    const before = r5State(base.save());
    transactionId ||= id("r5-content", before.worldId, before.character.lifeIndex, eventId, choiceId, before.worldDay);
    const transactionKey = `content:${transactionId}`;
    if (before.r5LifeLedger.transactions[transactionKey]) return { kind: "duplicate_suppressed", result: clone(before.r5LifeLedger.transactions[transactionKey]) };
    if (!afterTimedChoice && r6TimeContract) {
      const durationTicks = findActionDuration(r6TimeContract, { eventId, choiceId });
      if (durationTicks > 0) {
        const view = base.debug.eventView(eventId);
        if (!view?.options?.some((row) => row.id === choiceId && row.available)) return { error: "event_unavailable" };
        const timed = { eventId, choiceId, transactionId, startedAtTick: before.worldTick, targetAtTick: before.worldTick + durationTicks, durationTicks, status: "running", pauseEventId: null };
        if (!Number.isSafeInteger(timed.targetAtTick) || timed.targetAtTick > 412316860415) return { error: "invalid_world_tick_delta" };
        before.world.r6PendingTimedChoices ||= [];
        if (before.world.r6PendingTimedChoices.some((row) => row.transactionId === transactionId)) return { kind: "progress", r6TimedChoice: true, timedChoice: clone(before.world.r6PendingTimedChoices.at(-1)) };
        before.world.r6PendingTimedChoices.push(timed);
        replaceState(before);
        return { kind: "progress", r6TimedChoice: true, timedChoice: clone(timed), snapshot: snapshot() };
      }
    }
    if (before.world.pendingRealmChoice && !afterRealmPractice) return { error: "realm_choice_action_already_in_flight" };
    if (before.world.pendingRealmCraft && !afterRealmCraft) return { error: "realm_choice_action_already_in_flight" };
    const eventDefinition = runtimeDefinitions.events.find((row) => row.id === eventId);
    const optionDefinition = eventDefinition?.options.find((row) => row.id === choiceId);
    const realmPractice = ["realm_qi_practice", "realm_watch_practice"].includes(optionDefinition?.runtimeAction);
    const realmCraft = optionDefinition?.runtimeAction === "realm_craft_finish";
    if (optionDefinition?.runtimeAction === "realm_craft_yield") {
      const source = eventDefinition?.runtimeBinding?.sourcePath?.split(".").reduce((value, key) => value?.[key], before);
      const queue = before.world.publicSchedules?.kilnQueue || {};
      if (!source || source.status !== "open" || !["booked", "retained_with_risk"].includes(queue.reservationStatus)) return { error: "event_unavailable" };
    }
    if (realmCraft && !afterRealmCraft) {
      if (before.world.pendingRealmChoice || before.world.pendingRealmCraft) return { error: "realm_choice_action_already_in_flight" };
      const view = base.debug.eventView(eventId);
      if (!view?.options?.some((row) => row.id === choiceId && row.available)) return { error: "event_unavailable" };
      const reserved = base.reserveRealmEventChoice(eventId, transactionId);
      if (reserved?.status !== "reserved") return { error: reserved?.error || "realm_source_reservation_failed" };
      const started = base.performAction("r4_action_alchemy");
      if (started?.kind !== "progress") { base.releaseRealmEventChoice(eventId, transactionId); return started?.error ? started : { error: "authorized_alchemy_action_transaction_not_started", result: started }; }
      const next = r5State(base.save());
      next.world.pendingRealmCraft = { eventId, choiceId, transactionId, sourceId: reserved.sourceId, actorId: next.character.id, actionTransactionId: next.inFlightTransaction?.transactionId, startedDay: next.worldDay, lifeIndex: next.character.lifeIndex };
      replaceState(next);
      return { ...started, realmCraftAction: true, eventId, choiceId };
    }
    if (realmPractice && !afterRealmPractice) {
      if (before.world.pendingRealmChoice) return { error: "realm_choice_action_already_in_flight" };
      const view = base.debug.eventView(eventId);
      if (!view?.options?.some((row) => row.id === choiceId && row.available)) return { error: "event_unavailable" };
      const source = eventDefinition.runtimeBinding?.sourcePath?.split(".").reduce((value, key) => value?.[key], before);
      const skillId = source?.evidence?.skillId || before.character.learnedSkills?.find((id) => before.character.skillRecords?.[id]?.lifeIndex === before.character.lifeIndex);
      if (!skillId) return { error: "current_life_learned_skill_required" };
      const reserved = base.reserveRealmEventChoice(eventId, transactionId);
      if (reserved?.status !== "reserved") return { error: reserved?.error || "realm_source_reservation_failed" };
      const started = base.performAction("r4_action_practice", { mode: "practice", skillId });
      if (started?.kind !== "progress") { base.releaseRealmEventChoice(eventId, transactionId); return started?.error ? started : { error: "practice_action_transaction_not_started", result: started }; }
      const next = r5State(base.save());
      next.world.pendingRealmChoice = { eventId, choiceId, transactionId, sourceId: reserved.sourceId, actorId: next.character.id, actionTransactionId: next.inFlightTransaction?.transactionId, startedDay: next.worldDay, lifeIndex: next.character.lifeIndex };
      replaceState(next);
      return { ...started, realmPracticeAction: true, eventId, choiceId };
    }
    if (realmPractice && afterRealmPractice) {
      const pending = before.world.pendingRealmChoice;
      const source = eventDefinition?.runtimeBinding?.sourcePath?.split(".").reduce((value, key) => value?.[key], before);
      const action = pending?.actionTransactionId && before.character.actionLog?.find((row) => row.transactionId === pending.actionTransactionId);
      if (!pending || pending.eventId !== eventId || pending.choiceId !== choiceId || pending.transactionId !== transactionId
        || pending.actorId !== before.character.id || pending.lifeIndex !== before.character.lifeIndex
        || pending.sourceId !== source?.id || source?.reservedTransactionId !== transactionId
        || action?.actionId !== "r4_action_practice" || action.outcome !== "success") return { error: "matching_completed_practice_reservation_required" };
    }
    if (eventDefinition?.runtimeBinding?.kind === "realm_source" && ["realm_core_supply", "realm_void_route", "realm_void_map", "realm_void_relocation", "realm_ascendant_openlesson", "realm_ascendant_seat", "realm_ascendant_seedarchive"].includes(eventDefinition.runtimeBinding.handler)) {
      const guard = base.debug.validateRealmChoice(eventId, choiceId);
      if (guard?.error) return guard;
    }
    if (eventId === "r4_ev_era_memory_after_migration" && choiceId === "rebuild_from_memory") {
      const state = r5State(base.save());
      const skillId = state.playerInput?.skillId || Object.keys(state.character.r5UnpracticedMemory || {})[0];
      if (!skillId || !state.character.r5UnpracticedMemory?.[skillId] || state.facts?.r4_fact_memory_awakened?.lifeIndex !== state.character.lifeIndex) return { error: "awakened_skill_memory_missing" };
      state.playerInput = { ...(state.playerInput || {}), skillId };
      replaceState(state);
    }
    const opened = base.beginEvent(eventId);
    if (opened?.error) return opened;
    const result = base.choose(eventId, choiceId, { timeAlreadyCharged: afterTimedChoice });
    if (result?.kind === "result" || result?.kind === "interrupted") base.acknowledgeResult();
    const state = r5State(base.save());
    syncLearnedSkillSources(state);
    const event = runtimeDefinitions.events.find((item) => item.id === eventId);
    if (result?.outcome === "success" && eventId === "r4_acq_dao02" && choiceId === "accept_apprenticeship") {
      const permit = state.character.permits?.furnace;
      if (permit && Number.isSafeInteger(permit.issuedDay) && Number.isSafeInteger(permit.validDays) && permit.validDays >= 0) permit.status = "valid";
    }
    if (result?.outcome === "success" && eventId === "r4_memory_awakening" && choiceId === "recognize_memory") {
      state.facts.r4_fact_memory_awakened = { lifeIndex: state.character.lifeIndex, day: state.worldDay, eventId, choiceId, causeId: id("r5-memory-awakening", state.character.lifeIndex, transactionId), transactionId };
    }
    if (result?.outcome === "success" && eventId === "r4_ev_era_memory_after_migration" && choiceId === "rebuild_from_memory") {
      const skillId = state.playerInput?.skillId;
      const memory = state.character.r5UnpracticedMemory?.[skillId];
      if (memory && state.facts.r4_fact_memory_awakened?.lifeIndex === state.character.lifeIndex) {
        const trainingId = id("r5-awakened-course", state.character.lifeIndex, skillId, transactionId);
        const training = { id: trainingId, skillId, lifeIndex: state.character.lifeIndex, status: "active", source: "awakened_memory", startedDay: state.worldDay, sessionsCompleted: 0, causeId: id("r5-awakened-course-cause", transactionId), eventId, eventChoiceId: choiceId, authorizationTransactionId: transactionId, authorizedDay: state.worldDay };
        state.character.trainingInProgress ||= [];
        state.character.trainingInProgress.push(training);
        state.r5Retraining ||= {};
        state.r5Retraining[`${state.character.lifeIndex}:${skillId}`] = { status: "active", skillId, lifeIndex: state.character.lifeIndex, trainingId, requiredUnits: Math.max(300, Number(memory.minimumPracticeUnits || 300)), completedUnits: 0, completedSessions: 0, startedDay: state.worldDay, sourceMemoryLife: memory.sourceLife, causeId: training.causeId };
      }
    }
    if (result?.outcome === "success" && event && !["r4_ev_daily_courier", "r4_ev_daily_roadmarker"].includes(eventId)) {
      const activeId = before.world.openingInstance && !before.world.openingInstance.closed
        ? before.world.openingInstance.id
        : before.world.crisisInstances?.find((item) => item.family === "resonance" && !item.closed)?.id
          || before.world.crisisInstances?.find((item) => !item.closed)?.id;
      const bindingCause = event.runtimeBinding?.causePath?.split(".").reduce((value, key) => value?.[key], before);
      const causeId = activeId || bindingCause || `life:${before.character.lifeIndex}:${eventId}`;
      const delta = recordScore(state, "content_resolution", eventId, choiceId, causeId, 100, transactionId);
    }
    putTx(state, transactionKey, { eventId, choiceId, outcome: result?.outcome || result?.kind || "unknown", transactionId });
    replaceState(state);
    return result;
  }

  function continuePendingWorldChoice() {
    const before = r5State(base.save());
    const pending = before.world.r6PendingTimedChoices?.at(-1);
    if (!pending) return { error: "no_pending_timed_choice" };
    if (pending.status === "needs_reconciliation") return { error: "timed_choice_reconciliation_required" };
    const pauseEvent = pending.pauseEventId && runtimeDefinitions.events.find((row) => row.id === pending.pauseEventId);
    if (pauseEvent && base.debug.eventAvailable(pauseEvent)) return { kind: "progress", r6TimedChoice: true, timedChoice: clone(pending), pauseEventId: pending.pauseEventId };
    pending.pauseEventId = null;
    pending.status = "running";
    const result = base.advanceWorldTicks(Math.max(0, pending.targetAtTick - before.worldTick));
    if (result?.error) return result;
    let after = r5State(base.save());
    const current = after.world.r6PendingTimedChoices?.at(-1);
    if (!current || current.transactionId !== pending.transactionId) return { error: "timed_choice_identity_changed" };
    if (result.stoppedAtWorldNode === "death") {
      after.world.r6PendingTimedChoices.pop();
      current.status = "interrupted_by_death";
      (after.world.r6TimedChoiceHistory ||= []).push(current);
      replaceState(after);
      return { kind: "interrupted", outcome: "interrupted", eventId: pending.eventId, choiceId: pending.choiceId, transactionId: pending.transactionId, reason: "character_died_before_action_completion", snapshot: snapshot() };
    }
    if (result.stoppedAtWorldNode) {
      current.status = "paused";
      current.pauseEventId = result.pauseEventId || null;
      replaceState(after);
      return { kind: "progress", r6TimedChoice: true, timedChoice: clone(current), pauseEventId: current.pauseEventId, snapshot: snapshot() };
    }
    if (after.worldTick < current.targetAtTick) {
      replaceState(after);
      return { kind: "progress", r6TimedChoice: true, timedChoice: clone(current), snapshot: snapshot() };
    }
    after.world.r6PendingTimedChoices.pop();
    replaceState(after);
    const completed = resolveWorldChoice(pending.eventId, pending.choiceId, pending.transactionId, false, false, true);
    if (completed?.error) return completed;
    const latest = r5State(base.save());
    const parent = latest.world.r6PendingTimedChoices?.at(-1);
    if (parent && completed?.kind === "result") completed.r6ParentTimedChoice = clone(parent);
    return completed;
  }

  function performWorldAction(actionId, payload = {}) {
    const result = base.performAction(actionId, payload);
    const state = r5State(base.save());
    replaceState(state);
    return result;
  }

  function beginTravelPractice(skillId) {
    const result = base.beginTravelPractice(skillId);
    if (!result?.error) replaceState(r5State(base.save()));
    return result;
  }

  function resumeTravelFromWaystop() {
    const result = base.resumeTravelFromWaystop();
    if (!result?.error) replaceState(r5State(base.save()));
    return result;
  }

  function buyR6PortableFurnace(kind, transactionId) {
    const result = base.buyR6PortableFurnace({ kind, transactionId });
    if (!result?.error) replaceState(r5State(base.save()));
    return result;
  }

  function beginTravelPortableAlchemy() {
    const result = base.beginTravelPortableAlchemy();
    if (!result?.error) replaceState(r5State(base.save()));
    return result;
  }

  function beginMemoryRetraining(skillId, transactionId) {
    const state = r5State(base.save());
    const char = state.character;
    const memory = char.r5UnpracticedMemory?.[skillId];
    const awakened = state.facts?.r4_fact_memory_awakened;
    const training = char.trainingInProgress?.find((row) => row.skillId === skillId && row.lifeIndex === char.lifeIndex && row.status === "active" && row.source === "awakened_memory"
      && row.eventId === "r4_ev_era_memory_after_migration" && row.eventChoiceId === "rebuild_from_memory"
      && typeof row.authorizationTransactionId === "string" && row.authorizationTransactionId.length > 0
      && Number.isSafeInteger(row.authorizedDay) && Number.isSafeInteger(row.startedDay)
      && row.authorizedDay === row.startedDay && row.startedDay <= state.worldDay
      && (!Object.hasOwn(row, "expiresDay") || (Number.isSafeInteger(row.expiresDay) && state.worldDay <= row.expiresDay)));
    if (!memory || awakened?.lifeIndex !== char.lifeIndex) return { status: "rejected", reason: "awakened_skill_memory_missing" };
    if (!training) return { status: "rejected", reason: "dated_memory_retraining_event_missing" };
    const key = `${char.lifeIndex}:${skillId}`;
    const existing = state.r5Retraining?.[key];
    if (existing) return clone(existing);
    return { status: "rejected", reason: "dated_memory_retraining_course_missing" };
  }

  function retrainMemoryBlock(skillId, transactionId) {
    let state = r5State(base.save());
    const key = `${state.character.lifeIndex}:${skillId}`;
    let row = state.r5Retraining?.[key];
    const char = state.character;
    if (state.r5LifeLedger.transactions[transactionId]) return txReplay(state, transactionId);
    if (!row || row.status !== "active") return { status: "rejected", reason: "retraining_not_started" };
    const training = char.trainingInProgress?.find((item) => item.id === row.trainingId && item.lifeIndex === char.lifeIndex && item.status === "active" && item.source === "awakened_memory"
      && item.eventId === "r4_ev_era_memory_after_migration" && item.eventChoiceId === "rebuild_from_memory"
      && typeof item.authorizationTransactionId === "string" && item.authorizationTransactionId.length > 0
      && Number.isSafeInteger(item.authorizedDay) && Number.isSafeInteger(item.startedDay)
      && item.authorizedDay === item.startedDay && item.startedDay <= state.worldDay
      && (!Object.hasOwn(item, "expiresDay") || (Number.isSafeInteger(item.expiresDay) && state.worldDay <= item.expiresDay)));
    if (!training || !char.r5UnpracticedMemory?.[skillId] || state.facts?.r4_fact_memory_awakened?.lifeIndex !== char.lifeIndex) return { status: "rejected", reason: "active_awakened_training_or_memory_missing" };
    if (!char.alive || Number(char.health) <= rules.trainingHealthFloor) return { status: "rejected", reason: "life_or_health_not_ready" };
    const memory = char.r5UnpracticedMemory[skillId];
    const startedDay = state.worldDay;
    const wasLearned = (char.learnedSkills || []).includes(skillId);
    memory.minimumRealmId = "r4_realm_mortal";
    const legacyMemory = state.facts.r4_fact_skill_memory?.skills?.find((item) => item.skillId === skillId);
    if (legacyMemory) {
      legacyMemory.legacyMinimumRealmId ??= legacyMemory.minimumRealmId ?? null;
      legacyMemory.minimumRealmId = "r4_realm_mortal";
    }
    char.learnedSkills ||= [];
    if (!wasLearned) char.learnedSkills.push(skillId);
    char.skillRecords ||= {};
    char.skillRecords[skillId] ||= { skillId, lifeIndex: char.lifeIndex, sourceId: training.id, sourceEventId: "r5_temporary_authorized_memory_practice", proficiency: 0 };
    replaceState(state);
    let action = base.performAction("r4_action_practice", { mode: "practice", skillId });
    while (action?.kind === "progress") {
      action = base.advanceTransaction(Math.max(1, action.transaction?.durationDays || rules.practiceDaysPerBlock));
      if (action?.stoppedAtWorldNode) break;
    }
    const completed = action?.kind === "result" && action.outcome === "success";
    if (action?.kind === "result" || action?.kind === "interrupted") base.acknowledgeResult();
    if (!completed) {
      const rollback = r5State(base.save());
      if (!wasLearned) rollback.character.learnedSkills = (rollback.character.learnedSkills || []).filter((id) => id !== skillId);
      if (!wasLearned) delete rollback.character.skillRecords?.[skillId];
      replaceState(rollback);
      return { status: "rejected", reason: action?.outcome === "interrupted" ? "life_ended_during_practice" : action?.stoppedAtWorldNode ? "world_event_interrupted_during_practice" : action?.error || "registered_practice_action_not_completed" };
    }
    state = r5State(base.save());
    row = state.r5Retraining?.[key];
    const liveTraining = state.character.trainingInProgress?.find((item) => item.id === row?.trainingId && item.lifeIndex === state.character.lifeIndex && item.status === "active");
    const units = rules.practiceUnitsPerBlock * (1 + Math.floor(Number(state.character.r5DimensionLevels?.naturalTalent || 0) / 5));
    row.completedUnits = Number(row.completedUnits || 0) + units;
    row.completedSessions = Number(row.completedSessions || 0) + 1;
    row.lastDay = state.worldDay;
    const complete = row.completedUnits >= row.requiredUnits;
    if (complete) {
      row.status = "completed";
      liveTraining.status = "completed";
      const sourceId = id("r5-retrained-skill", skillId, state.character.lifeIndex, transactionId);
      state.character.skillRecords[skillId] = { skillId, lifeIndex: state.character.lifeIndex, sourceId, sourceEventId: "r5_memory_retraining", learnedDay: state.worldDay, proficiency: 0 };
      const mastery = { lifeIndex: state.character.lifeIndex, skillId, discipline: memory.discipline, sourceId, sourceEventId: "r5_memory_retraining", learnedDay: state.worldDay, masteryMilli: Math.min(rules.masteryCapMilli, row.completedUnits), understandingMilli: Math.min(rules.masteryCapMilli, row.completedUnits), retainedFromLife: null, causeId: row.causeId, retrainedAtDay: state.worldDay };
      state.r5LifeLedger.skills.push(mastery);
      state.facts.r5_fact_skill_mastery = clone(state.r5LifeLedger.skills);
      delete state.character.r5UnpracticedMemory[skillId];
    } else {
      if (!wasLearned) state.character.learnedSkills = state.character.learnedSkills.filter((id) => id !== skillId);
      if (!wasLearned) delete state.character.skillRecords[skillId];
    }
    const receipt = { status: complete ? "completed" : "in_progress", skillId, lifeIndex: state.character.lifeIndex, block: row.completedSessions, blocksRequired: Math.ceil(row.requiredUnits / rules.practiceUnitsPerBlock), completedUnits: row.completedUnits, requiredUnits: row.requiredUnits, startedDay, day: state.worldDay, causeId: id("r5-retraining-block", transactionId), transactionId, practiceActionTransactionId: state.character.actionLog?.at(-1)?.transactionId || null };
    state.r5LifeLedger.factLog.push(clone(receipt));
    putTx(state, transactionId, receipt);
    replaceState(state);
    return clone(receipt);
  }

  function acknowledgeResult() {
    base.acknowledgeResult();
    world = r5State(base.save());
    replaceState(world);
    return snapshot();
  }

  function issueMarketQuote(marketId, itemId, quantity, side, counterPercent = null) {
    const result = base.issueQuote({ marketId, itemId, quantity, side, ...(counterPercent == null ? {} : { counterPercent }) });
    if (!result?.error) replaceState(r5State(base.save()));
    return result;
  }

  function settleMarketQuote(quoteId) {
    const result = base.settleQuote(quoteId);
    if (!result?.error && result?.kind !== "duplicate_suppressed") replaceState(r5State(base.save()));
    return result;
  }

  function cancelMarketQuote(quoteId) {
    const result = base.cancelQuote(quoteId);
    if (!result?.error) replaceState(r5State(base.save()));
    return result;
  }

  function getMarketFinance(marketId) {
    return clone(base.marketFinance(marketId));
  }

  function openDailyBusinessSource(eventId) {
    const result = base.openDailyBusinessSource(eventId);
    if (result?.source) {
      const next = r5State(base.save());
      replaceState(next);
    }
    return result;
  }

  function acceptDailyBoardAuthority(eventId) {
    const result = base.acceptDailyBoardAuthority(eventId);
    if (result?.kind === "authority") replaceState(r5State(base.save()));
    return result;
  }

  function prepareRealmEventSource(eventId, actionId) {
    const result = base.prepareRealmEventSource(eventId, actionId);
    if (result?.status === "committed") replaceState(r5State(base.save()));
    return result;
  }

  function openRealmEventSource(eventId) {
    const result = base.openRealmEventSource(eventId);
    if (result?.source) replaceState(r5State(base.save()));
    return result;
  }

  function readPublicArchiveCatalog() {
    const result = base.readPublicArchiveCatalog();
    if (result?.status === "committed") replaceState(r5State(base.save()));
    return result;
  }

  function abortPendingRealmAction(pending, reason = null) {
    const result = base.abortInFlight();
    if (result?.kind !== "result") return result;
    base.acknowledgeResult();
    base.releaseRealmEventChoice(pending.eventId, pending.transactionId);
    const state = r5State(base.save());
    if (state.world.pendingRealmChoice?.transactionId === pending.transactionId) state.world.pendingRealmChoice = null;
    if (state.world.pendingRealmCraft?.transactionId === pending.transactionId) state.world.pendingRealmCraft = null;
    replaceState(state);
    return { ...result, realmEventUnresolved: true, eventId: pending.eventId, choiceId: pending.choiceId, ...(reason ? { invalidationReason: reason } : {}) };
  }

  function pruneOrphanedRealmActionReservations() {
    let state = r5State(base.save());
    for (const key of ["pendingRealmChoice", "pendingRealmCraft"]) {
      const pending = state.world[key];
      if (!pending) continue;
      const event = runtimeDefinitions.events.find((row) => row.id === pending.eventId);
      const source = event?.runtimeBinding?.sourcePath?.split(".").reduce((value, pathKey) => value?.[pathKey], state);
      const actionId = key === "pendingRealmCraft" ? "r4_action_alchemy" : "r4_action_practice";
      const active = source?.status === "open" && source?.reservedTransactionId === pending.transactionId
        && source?.id === pending.sourceId && pending.actorId === state.character.id
        && pending.lifeIndex === state.character.lifeIndex
        && ((state.inFlightTransaction?.transactionId === pending.actionTransactionId
          && state.inFlightTransaction?.actionId === actionId
          && state.actionTransactionLedger?.[pending.actionTransactionId]?.status === "running")
          || (state.actionTransactionLedger?.[pending.actionTransactionId]?.status === "completed"
            && state.character.actionLog?.some((row) => row.transactionId === pending.actionTransactionId && row.actionId === actionId
              && (actionId !== "r4_action_practice" || row.outcome === "success"))));
      if (active) continue;
      base.releaseRealmEventChoice(pending.eventId, source?.reservedTransactionId || pending.transactionId);
      state = r5State(base.save());
      if (state.world[key]?.transactionId === pending.transactionId) state.world[key] = null;
      replaceState(state);
      state = r5State(base.save());
    }
  }

  function validatePendingRealmCraft(pending, state) {
    const event = runtimeDefinitions.events.find((row) => row.id === pending?.eventId);
    const source = event?.runtimeBinding?.sourcePath?.split(".").reduce((value, key) => value?.[key], state);
    const actionId = pending?.actionTransactionId;
    const actionLedger = state.actionTransactionLedger?.[actionId];
    const prepared = state.world.realmActionLedgers?.craftBatches?.find((row) => row.id === source?.sourceId
      && row.actorId === state.character.id && row.lifeIndex === state.character.lifeIndex && row.status === "authorized");
    const livePermit = state.character.permits?.furnace;
    const sourcePermit = source?.permit;
    const integerWindow = (permit) => permit && Number.isSafeInteger(permit.issuedDay)
      && Number.isSafeInteger(permit.validDays) && permit.validDays >= 0
      && state.worldDay >= permit.issuedDay && state.worldDay <= permit.issuedDay + permit.validDays;
    let leaseValid = true;
    if (livePermit && Object.hasOwn(livePermit, "leaseId")) {
      const lease = typeof livePermit.leaseId === "string" && livePermit.leaseId.length
        ? state.world.rentalLedger?.find((row) => row.leaseId === livePermit.leaseId && row.tenantId === state.character.id)
        : null;
      leaseValid = !!lease && lease.status === "active" && Number.isSafeInteger(lease.dueDay)
        && state.worldDay <= lease.dueDay && lease.locationId === state.character.location
        && (lease.lifeIndex == null || lease.lifeIndex === state.character.lifeIndex);
    }
    if (!event || event.runtimeBinding?.handler !== "realm_core_craft" || !source
      || source.status !== "open" || source.reservedTransactionId !== pending.transactionId || source.id !== pending.sourceId
      || pending.actorId !== state.character.id || pending.lifeIndex !== state.character.lifeIndex
      || !Number.isSafeInteger(pending.startedDay) || !Number.isSafeInteger(source.expiresDay)
      || pending.startedDay > source.expiresDay || state.worldDay > source.expiresDay
      || !state.character.alive || state.character.location !== source.locationId
      || state.inFlightTransaction?.transactionId !== actionId || state.inFlightTransaction?.actionId !== "r4_action_alchemy"
      || actionLedger?.status !== "running" || actionLedger?.actionId !== "r4_action_alchemy"
      || !prepared || prepared.batch?.status !== "ready"
      || !livePermit || livePermit.status !== "valid" || !integerWindow(livePermit)
      || !sourcePermit || sourcePermit.status !== "valid" || !integerWindow(sourcePermit)
      || sourcePermit.location !== livePermit.location || sourcePermit.issuedDay !== livePermit.issuedDay
      || sourcePermit.validDays !== livePermit.validDays || sourcePermit.leaseId !== livePermit.leaseId
      || sourcePermit.location !== state.character.location || !leaseValid
      || !state.character.learnedSkills?.includes("r4_skill_dao02") || state.character.skillRecords?.r4_skill_dao02?.lifeIndex !== state.character.lifeIndex) {
      return { error: "pending_authorized_craft_invalidated" };
    }
    return null;
  }

  function continueWorldAction(days = 1) {
    const pendingState = r5State(base.save()).world;
    const pendingRealmChoice = pendingState.pendingRealmChoice;
    const pendingRealmCraft = pendingState.pendingRealmCraft;
    const pendingRealmAction = pendingRealmChoice || pendingRealmCraft;
    if (pendingRealmAction && base.getStateForAdapter().character.alive) {
      const guard = pendingRealmCraft
        ? validatePendingRealmCraft(pendingRealmCraft, r5State(base.save()))
        : base.debug.validateRealmChoice(pendingRealmAction.eventId, pendingRealmAction.choiceId);
      if (guard?.error) return abortPendingRealmAction(pendingRealmAction, guard.error);
    }
    const result = base.advanceTransaction(days);
    if (result?.kind === "result" || result?.kind === "interrupted") base.acknowledgeResult();
    const state = r5State(base.save());
    if (pendingRealmCraft && (result?.kind === "result" || result?.kind === "interrupted")) {
      if (result.kind === "interrupted" || !state.character.alive || state.character.lifeIndex !== pendingRealmCraft.lifeIndex) {
        base.releaseRealmEventChoice(pendingRealmCraft.eventId, pendingRealmCraft.transactionId);
        state.world.pendingRealmCraft = null; replaceState(r5State(base.save()));
        return { ...result, realmEventUnresolved: true, eventId: pendingRealmCraft.eventId, choiceId: pendingRealmCraft.choiceId };
      }
      const linked = base.bindRealmCraftTransaction(pendingRealmCraft.eventId, pendingRealmCraft.actionTransactionId);
      if (linked?.status !== "linked") { base.releaseRealmEventChoice(pendingRealmCraft.eventId, pendingRealmCraft.transactionId); state.world.pendingRealmCraft = null; replaceState(r5State(base.save())); return { error: linked?.error || "alchemy_transaction_link_failed", actionResult: result }; }
      const choiceResult = resolveWorldChoice(pendingRealmCraft.eventId, pendingRealmCraft.choiceId, pendingRealmCraft.transactionId, false, true);
      base.releaseRealmEventChoice(pendingRealmCraft.eventId, pendingRealmCraft.transactionId);
      const completed = r5State(base.save()); completed.world.pendingRealmCraft = null; replaceState(completed);
      return { ...choiceResult, actualAlchemyOutcome: linked.outcome, craftActionResult: result, craftReceipt: linked };
    }
    if (pendingRealmChoice && (result?.kind === "result" || result?.kind === "interrupted")) {
      if (result.kind === "interrupted" || result.outcome !== "success" || !state.character.alive || state.character.lifeIndex !== pendingRealmChoice.lifeIndex) {
        base.releaseRealmEventChoice(pendingRealmChoice.eventId, pendingRealmChoice.transactionId);
        state.world.pendingRealmChoice = null; replaceState(r5State(base.save()));
        return { ...result, realmEventUnresolved: true, eventId: pendingRealmChoice.eventId, choiceId: pendingRealmChoice.choiceId };
      }
      const linked = base.bindRealmPracticeTransaction(pendingRealmChoice.eventId, pendingRealmChoice.actionTransactionId);
      if (linked?.status !== "linked") { base.releaseRealmEventChoice(pendingRealmChoice.eventId, pendingRealmChoice.transactionId); state.world.pendingRealmChoice = null; replaceState(r5State(base.save())); return { error: linked?.error || "practice_transaction_link_failed", actionResult: result }; }
      const choiceResult = resolveWorldChoice(pendingRealmChoice.eventId, pendingRealmChoice.choiceId, pendingRealmChoice.transactionId, true);
      base.releaseRealmEventChoice(pendingRealmChoice.eventId, pendingRealmChoice.transactionId);
      const completed = r5State(base.save()); completed.world.pendingRealmChoice = null; replaceState(completed);
      return { ...choiceResult, practiceReceipt: linked, practiceActionResult: result };
    }
    replaceState(state);
    return result;
  }

  function abortWorldAction() {
    const pendingState = r5State(base.save()).world;
    const pendingRealmChoice = pendingState.pendingRealmChoice;
    const pendingRealmCraft = pendingState.pendingRealmCraft;
    const pending = pendingRealmChoice || pendingRealmCraft;
    if (pending) return abortPendingRealmAction(pending);
    const result = base.abortInFlight();
    if (result?.kind !== "result") return result;
    base.acknowledgeResult();
    replaceState(r5State(base.save()));
    return result;
  }

  function settleNaturalDeath() {
    const state = r5State(base.save());
    if (state.character.alive) return { status: "rejected", reason: "active_life_cannot_settle" };
    if (state.r5LifeLedger.settlement) return clone(state.r5LifeLedger.settlement);
    const clock = state.r5LifeLedger.lifeClock;
    const terminalDay = Math.min(state.world.worldDay, state.character.deathDay ?? state.world.worldDay);
    clock.terminalDay = terminalDay;
    const currentId = activeStage(state);
    const attained = state.r5LifeLedger.progression.attainment.filter((row) => row.lifeIndex === state.character.lifeIndex && row.status === "success" && state.causeLog.some((cause) => cause.causeId === row.causeId));
    const stageComponent = attained.reduce((sum, row) => sum + Number(stageById.get(row.stageId)?.scorePoints || 0), 0);
    const causeComponent = Math.min(rebirthRules.eventScoreCap, state.r5LifeLedger.scoreEntries.filter((row) => row.kind !== "stage_attainment" && row.lifeIndex === state.character.lifeIndex).reduce((sum, row) => sum + row.points, 0));
    const lived = Math.max(0, terminalDay - state.character.birthDay);
    const lifeSpan = Math.max(1, state.character.deathDay - state.character.birthDay);
    const survivalComponent = Math.floor(rebirthRules.survivalCap * lived * lived / (lifeSpan * lifeSpan));
    const total = Math.min(rebirthRules.scoreMaximum, stageComponent + causeComponent + survivalComponent);
    const numerator = BigInt(rebirthRules.walletMaximum) ** 2n * BigInt(total) / BigInt(rebirthRules.scoreToWallet.budgetSaturationScore);
    let root = 0n;
    for (let bit = 1n << 31n; bit; bit >>= 1n) if ((root | bit) * (root | bit) <= numerator) root |= bit;
    const budgetUnits = Math.min(rebirthRules.walletMaximum, Number(root));
    const settlement = { ruleVersion: rebirthRules.version, stageComponent, causeComponent, survivalComponent, total, budgetUnits, daysLived: lived, lifespanDays: lifeSpan, currentStageId: currentId, terminalDay, settlementId: id("r5-settlement", state.world.id, state.character.lifeIndex) };
    state.r5LifeLedger.settlement = settlement;
    state.r5LifeLedger.rebirth.walletUnits = budgetUnits;
    state.facts.r5_fact_life_clock.terminalDay = terminalDay;
    replaceState(state);
    return clone(settlement);
  }

  function dimensionCost(currentLevel, amount) {
    if (!Number.isInteger(amount) || amount < 0 || currentLevel < 0 || currentLevel + amount > rebirthRules.dimensionMaximumLevel) throw new Error("dimension_level_out_of_range");
    let cost = 0;
    for (let level = currentLevel; level < currentLevel + amount; level += 1) cost += rebirthRules.dimensionBaseCostUnits * (1 + Math.floor(level / rebirthRules.dimensionCostTierWidth));
    return cost;
  }

  function draftRebirth(retainedStageId, dimensions) {
    const state = r5State(base.save());
    if (state.character.alive) return "active_life_cannot_draft";
    if (!state.r5LifeLedger.settlement) return "life_settlement_missing";
    if (Object.keys(dimensions || {}).length !== DIMENSIONS.length || DIMENSIONS.some((key) => !Number.isInteger(dimensions[key]) || dimensions[key] < 0)) return "dimension_allocation_invalid";
    const current = activeStage(state);
    const retained = retainedStageId || null;
    if (retained && (!stageById.has(retained) || rankById.get(retained) > rankById.get(current))) return "retained_stage_exceeds_current_life_attainment";
    const skills = state.r5LifeLedger.skills.filter((row) => row.lifeIndex === state.character.lifeIndex);
    let stageCost = 0;
    if (retained) {
      const stage = stageById.get(retained);
      const mastery = skills.filter((row) => stage.retainedDisciplines?.includes(row.discipline)).reduce((sum, row) => sum + Math.min(rebirthRules.retainedSkillMasteryCapMilli, row.masteryMilli), 0);
      stageCost = stage.retentionCostUnits + Math.min(Math.floor(mastery / rebirthRules.retentionMasteryCostDivisor), rebirthRules.retentionMasteryCostCapUnits);
    }
    const levels = state.character.r5DimensionLevels || Object.fromEntries(DIMENSIONS.map((key) => [key, 0]));
    const dimCost = DIMENSIONS.reduce((sum, key) => sum + dimensionCost(Number(levels[key] || 0), dimensions[key]), 0);
    const budget = state.r5LifeLedger.rebirth.walletUnits;
    if (stageCost + dimCost > budget) return "insufficient_single_wallet";
    const draft = { retainedStageId: retained, retainedStageCostUnits: stageCost, dimensions: Object.fromEntries(DIMENSIONS.map((key) => [key, levels[key] + dimensions[key]])), dimensionIncrements: clone(dimensions), startingDimensionLevels: clone(levels), dimensionCostUnits: dimCost, budgetUnits: budget, remainingUnits: budget - stageCost - dimCost, masterySnapshot: clone(skills), draftId: id("r5-draft", state.character.lifeIndex, budget) };
    state.r5LifeLedger.rebirth.draft = draft;
    replaceState(state);
    return clone(draft);
  }

  function newLife(origin, transactionId) {
    let previous = r5State(base.save());
    const priorCommit = previous.r5LifeLedger.rebirth.receipt;
    if (priorCommit?.transactionId === transactionId && priorCommit.newLife === previous.character.lifeIndex) return clone(priorCommit);
    if (previous.character.alive && priorCommit?.newLife === previous.character.lifeIndex) return "rebirth_already_committed";
    if (previous.character.alive) return "active_life_cannot_rebirth";
    if (!previous.r5LifeLedger.settlement) return "life_settlement_missing";
    const key = id(previous.world.id, previous.character.lifeIndex, previous.r5LifeLedger.settlement.settlementId);
    if (previous.r5LifeLedger.rebirthReceipts[key]) return clone(previous.r5LifeLedger.rebirthReceipts[key]);
    const draft = previous.r5LifeLedger.rebirth.draft;
    if (!draft) return "rebirth_allocation_missing";
    const originId = origin.startsWith("r4_origin_") ? origin : `r4_origin_${origin}`;
    const successorNow = now ? () => Number(now()) + Number(previous.character.lifeIndex) : () => Date.now() + Number(previous.character.lifeIndex);
    const nextEngine = createR4WorldEngine({ pack, definitions: runtimeDefinitions, seedConfig, now: successorNow, realmSourceAdapter: "r5", r6FreeSurvival });
    const result = nextEngine.start(originId);
    if (!result?.ok) return result?.error || "invalid_origin";
    let next = r5State(nextEngine.save());
    const nextCharacterId = `${previous.character.id}:life:${previous.character.lifeIndex + 1}`;
    next = replaceIdentifiers(next, [[next.worldId, previous.worldId], [next.character.id, nextCharacterId]]);
    next.worldId = previous.worldId;
    next.world = clone(previous.world);
    next.people = clone(previous.people || {});
    next.causeLog = clone(previous.causeLog || []);
    next.world.lifeRecords ||= {};
    next.world.lifeRecords[String(previous.character.lifeIndex)] = { lifeIndex: previous.character.lifeIndex, characterId: previous.character.id, terminalDay: previous.r5LifeLedger.lifeClock.terminalDay, stageId: activeStage(previous), settlement: clone(previous.r5LifeLedger.settlement) };
    next.character.lifeIndex = previous.character.lifeIndex + 1;
    next.character.predecessorId = previous.character.id;
    if (r6FreeSurvival) next.character.r6StrandedReturnByLife = clone(previous.character.r6StrandedReturnByLife || {});
    next.character.birthDay = previous.world.worldDay;
    next.character.lifeStartWorldTick = previous.worldTick;
    next.character.deathDay = next.character.birthDay + lifespanDays(next, draft.retainedStageId || INITIAL_STAGE);
    next.character.r5DimensionLevels = clone(draft.dimensions);
    next.character.r5StageId = draft.retainedStageId || INITIAL_STAGE;
    next.character.r5InheritedMastery = {};
    next.character.r5UnpracticedMemory = {};
    next.character.r5PersonalPracticeUnits = 0;
    next.character.r5PhysicalConditioningUnits = 0;
    next.character.r5UnspentWallet = 0;
    next.character.learnedSkills = [];
    next.character.skillRecords = {};
    next.character.skills = {};
    next.character.maxHealth = Number(next.character.maxHealth || 100) + Number(draft.dimensions.bloodline || 0);
    next.character.health = Math.min(next.character.maxHealth, 60 + Number(draft.dimensions.bloodline || 0));
    next.worldTick = previous.worldTick;
    next.worldDay = Math.floor(next.worldTick / 96);
    next.world.worldDay = next.worldDay;
    const carriedWorldState = carryWorldEventState(previous, next);
    next.eventClaimLedger = carriedWorldState.claims;
    next.queue = carriedWorldState.queue;
    next.world.worldEventQueue = clone(next.queue);
    const life = blankLife(next.character.lifeIndex);
    life.rebirthReceipts = clone(previous.r5RebirthReceipts || previous.r5LifeLedger.rebirthReceipts || {});
    life.progression.current = { lifeIndex: next.character.lifeIndex, stageId: next.character.r5StageId, source: draft.retainedStageId ? "paid_retention" : "new_life_untrained", sourceId: draft.draftId, day: next.character.birthDay, causeId: id("r5-life", next.character.lifeIndex, "birth") };
    life.lifeClock = { lifeIndex: next.character.lifeIndex, birthDay: next.character.birthDay, deathDay: next.character.deathDay, source: "r5_lifespan_formula_v1", causeId: life.progression.current.causeId };
    for (const row of draft.masterySnapshot || []) {
      if (draft.retainedStageId && stageById.get(draft.retainedStageId).retainedDisciplines?.includes(row.discipline)) {
        const retainedRow = { ...clone(row), lifeIndex: next.character.lifeIndex, retainedFromLife: previous.character.lifeIndex, sourceId: id("r5-retained-skill", row.sourceId, next.character.lifeIndex), causeId: id("r5-retained-skill", row.causeId, next.character.lifeIndex), learnedDay: next.character.birthDay };
        life.skills.push(retainedRow);
        next.character.learnedSkills.push(row.skillId);
        next.character.skillRecords[row.skillId] = { skillId: row.skillId, lifeIndex: next.character.lifeIndex, sourceId: retainedRow.sourceId, sourceEventId: "r5_paid_retention", proficiency: Math.floor(row.masteryMilli / 100) };
        next.character.r5InheritedMastery[row.skillId] = row.masteryMilli;
      } else {
        next.character.r5UnpracticedMemory[row.skillId] = { discipline: row.discipline, rememberedMasteryMilli: row.masteryMilli, minimumPracticeUnits: Math.max(300, row.masteryMilli), status: "memory_unpracticed", sourceLife: previous.character.lifeIndex };
      }
    }
    const memoryRows = Object.entries(next.character.r5UnpracticedMemory).map(([skillId, memory]) => ({
      skillId, discipline: memory.discipline, masteryMilli: memory.rememberedMasteryMilli,
      minimumPracticeUnits: memory.minimumPracticeUnits, sourceLife: memory.sourceLife, status: "memory_unpracticed"
    }));
    if (memoryRows.length) {
      next.facts.r4_fact_skill_memory = { lifeIndex: next.character.lifeIndex, sourceLife: previous.character.lifeIndex, skills: memoryRows };
      next.facts.r4_fact_birth_story = { lifeIndex: next.character.lifeIndex, day: next.character.birthDay, predecessorId: previous.character.id, causeId: life.progression.current.causeId, originId };
    }
    next.r5LifeLedger = life;
    next.r5Rebirth = life.rebirth;
    next.r5RebirthReceipts = life.rebirthReceipts;
    next.r5LifeLedger.rebirth.dimensionLevels = clone(draft.dimensions);
    next.facts.r5_fact_progression_current = clone(life.progression.current);
    next.facts.r5_fact_progression_attainment = [];
    next.facts.r5_fact_skill_mastery = clone(life.skills);
    next.facts.r5_fact_life_score_cause = [];
    next.facts.r5_fact_life_clock = clone(life.lifeClock);
    next.facts.r4_fact_life_clock = { ...(next.facts.r4_fact_life_clock || {}), birthDay: next.character.birthDay, deathDay: next.character.deathDay };
    const receipt = { receiptId: key, priorLife: previous.character.lifeIndex, newLife: next.character.lifeIndex, retainedStageId: life.progression.current.stageId, stageCostUnits: draft.retainedStageCostUnits, dimensionCostUnits: draft.dimensionCostUnits, dimensionIncrements: clone(draft.dimensionIncrements), dimensionLevels: clone(draft.dimensions), spentUnits: draft.retainedStageCostUnits + draft.dimensionCostUnits, remainingUnits: draft.remainingUnits, retainedSkillIds: life.skills.map((row) => row.skillId), unpracticedMemorySkillIds: Object.keys(next.character.r5UnpracticedMemory), inventoryInherited: false, relationshipsInherited: false, permissionsInherited: false, oldAchievementsRescored: false, worldContinued: true, transactionId };
    life.rebirth.receipt = clone(receipt);
    life.rebirth.lastCommittedReceipt = clone(receipt);
    life.rebirthReceipts[key] = clone(receipt);
    previous.r5LifeLedger.rebirthReceipts[key] = clone(receipt);
    previous.r5LifeLedger.rebirth.receipt = clone(receipt);
    previous.r5LifeLedger.factLog.push({ kind: "rebirth_commit", ...receipt });
    next.facts.r5_fact_rebirth_allocation = clone(receipt);
    next.facts.r4_fact_realm_current = { lifeIndex: next.character.lifeIndex, realmId: "r4_realm_mortal", source: "r5_adapter_no_r4_realm_mapping", sourceId: key };
    next.world.dailyServiceBoards ||= {};
    next.world.dailyServiceBoards.publicLesson = clone(previous.world.dailyServiceBoards?.publicLesson || publicLessonBoard(next));
    world = next;
    replaceState(world);
    base.advanceDays(Number(pack.crises.generation.operableAgeDays));
    world = r5State(base.save());
    world.character.ageDays = world.worldDay - world.character.birthDay;
    world.r5LifeLedger.lifeClock.playableDay = world.worldDay;
    world.facts.r5_fact_life_clock.playableDay = world.worldDay;
    replaceState(world);
    return clone(receipt);
  }

  function advanceWorldDays(days) {
    if (!Number.isSafeInteger(days) || days < 0) return { error: "invalid_world_day_delta" };
    const result = base.advanceDays(days);
    world = r5State(base.getStateForAdapter());
    if (!world.character.alive && !world.r5LifeLedger.lifeClock.terminalDay) {
      world.r5LifeLedger.lifeClock.terminalDay = Math.min(world.worldDay, world.character.deathDay ?? world.worldDay);
      world.facts.r5_fact_life_clock.terminalDay = world.r5LifeLedger.lifeClock.terminalDay;
    }
    replaceState(world);
    return { ...result, snapshot: snapshot() };
  }

  function advanceWorldTicks(ticks) {
    if (!Number.isSafeInteger(ticks) || ticks < 0) return { error: "invalid_world_tick_delta" };
    const result = base.advanceWorldTicks(ticks);
    if (result?.error) return result;
    world = r5State(base.getStateForAdapter());
    if (!world.character.alive && !world.r5LifeLedger.lifeClock.terminalDay) {
      world.r5LifeLedger.lifeClock.terminalDay = Math.min(world.worldDay, world.character.deathDay ?? world.worldDay);
      world.facts.r5_fact_life_clock.terminalDay = world.r5LifeLedger.lifeClock.terminalDay;
    }
    replaceState(world);
    return { ...result, snapshot: snapshot() };
  }

  function toSaveDto() {
    const state = r5State(base.getStateForAdapter());
    const current = activeStage(state);
    return { runtimeVersion: "R5-RUNTIME-1", namespace: pack.saveNamespace, timeSchemaVersion: 3, saveId: `${state.world.id}:${state.character.id}:${state.character.lifeIndex}`, lifeIndex: state.character.lifeIndex, progression: { currentStageId: current, ownedStageId: current, attainment: clone(state.r5LifeLedger.progression.attainment), dimensionLevels: clone(state.character.r5DimensionLevels) }, skills: clone(state.r5LifeLedger.skills.filter((row) => row.lifeIndex === state.character.lifeIndex)), lifeClock: Object.fromEntries(["birthDay", "deathDay", "source", "playableDay"].filter((key) => state.r5LifeLedger.lifeClock[key] !== undefined).map((key) => [key, state.r5LifeLedger.lifeClock[key]])), scoreLedger: clone(state.r5LifeLedger), rebirthWallet: clone(state.r5LifeLedger.rebirth), world: { id: state.world.id, worldDay: state.world.worldDay }, runtimeState: clone(state) };
  }

  function restoreDto(dto) {
    if (!dto || dto.namespace !== pack.saveNamespace || dto.runtimeVersion !== "R5-RUNTIME-1" || !dto.runtimeState) throw new Error("r5_dto_header_invalid");
    dto = migrateR6WorldTimeDto(dto).dto;
    const savedBase = base;
    const projectedState = r5State(clone(dto.runtimeState));
    base = createR4WorldEngine({ pack, definitions: runtimeDefinitions, seedConfig, saved: projectedState, now, realmSourceAdapter: "r5", r6FreeSurvival, r6TimeContract });
    const expected = toSaveDto();
    base = savedBase;
    for (const key of ["namespace", "runtimeVersion", "lifeIndex", "progression", "skills", "lifeClock", "scoreLedger", "rebirthWallet", "world"]) {
      if (JSON.stringify(dto[key]) !== JSON.stringify(expected[key])) throw new Error(`r5_save_projection_mismatch:${key}`);
    }
    return restore(projectedState);
  }

  if (saved) restore(saved);
  return {
    initialize, restore, snapshot, save, toSaveDto, acknowledgeResult,
    learnPublicMartialForm, trainBlock, conditioningBlock, recover,
    deliverCourierContract: (...args) => { const result = base.deliverR6CourierContract(...args); return { ...result, snapshot: snapshot() }; },
    returnCourierPackage: (...args) => { const result = base.returnR6CourierPackage(...args); return { ...result, snapshot: snapshot() }; },
    waitAtFloodClosure: (...args) => { const result = base.waitAtR6FloodClosure(...args); return { ...result, snapshot: snapshot() }; },
    resumeFloodRoute: (...args) => { const result = base.resumeR6FloodRoute(...args); return { ...result, snapshot: snapshot() }; },
    routeWeather: (...args) => base.debug.routeWeather(...args),
    resolveWorldChoice, performWorldAction, continueWorldAction, continuePendingWorldChoice, abortWorldAction, beginTravelPractice, resumeTravelFromWaystop, buyR6PortableFurnace, beginTravelPortableAlchemy, beginMemoryRetraining, retrainMemoryBlock, issueMarketQuote, settleMarketQuote, cancelMarketQuote, getMarketFinance, openDailyBusinessSource, acceptDailyBoardAuthority,
    prepareRealmEventSource, openRealmEventSource, readPublicArchiveCatalog,
    attemptBreakthrough, advanceWorldDays, advanceWorldTicks, restoreDto, breakthroughChance: (stageId) => breakthroughChance(r5State(base.save()), stageId),
    settleNaturalDeath, draftRebirth, newLife, unlockedCapabilities: () => unlockedCapabilities(),
    capabilityView, useCapability, recordFateGateEvidence, eventView, isEventAvailable
  };
}
