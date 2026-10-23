const KNOWLEDGE_LEVELS = Object.freeze({ heard: 1, witnessed: 2, evidence: 3, confirmed: 4 });
const R6_TICKS_PER_DAY = 96;
const R6_MAX_WORLD_TICK = 412316860415;
const SUPPORTED_EFFECTS = new Set(["set_fact", "add_resource", "add_item", "remove_item", "add_knowledge", "set_world", "set_person", "enqueue", "close_instance", "move_character", "record_cause", "add_crisis_allies", "noop"]);
const HIGH_REALM_SERVICE_TARGETS = Object.freeze({
  request_voluntary_witness: "r4_npc_market_vendor", request_archive_subject_consent: "r4_npc_han_archive",
  invite_care_request: "r4_npc_lin_xiaohe", request_roadwork_permit: "r4_npc_waykeeper",
  copy_public_map: "r4_npc_han_archive", request_facility_custody: "r4_npc_han_archive",
  invite_public_lesson: "r4_npc_public_teacher", request_waykeeper_nomination: "r4_npc_waykeeper",
  request_method_attribution: "r4_npc_public_teacher"
});

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function compactReceipt(value) {
  if (!value || typeof value !== "object") return value;
  const receipt = clone(value);
  delete receipt.snapshot;
  return receipt;
}
function recordKey(worldInstanceId, eventId, operationSequence) { return `${worldInstanceId}:${eventId}:${operationSequence}`; }
function collectRegisteredIds(value, found = new Set()) {
  if (typeof value === "string" && value.startsWith("r4_")) found.add(value);
  else if (Array.isArray(value)) value.forEach((item) => collectRegisteredIds(item, found));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectRegisteredIds(item, found));
  return found;
}
function eventByPackHas(pack, definitions, id) { return pack.registryIds.includes(id) && definitions.events.some((event) => event.id === id); }

export function worldDate(worldDay, calendar) {
  const day = Math.max(0, Math.floor(Number(worldDay) || 0));
  const perMonth = calendar.daysPerMonth;
  const perYear = perMonth * calendar.monthsPerYear;
  const year = calendar.epochYear + Math.floor(day / perYear);
  const dayOfYear = day % perYear;
  return { year, month: Math.floor(dayOfYear / perMonth) + 1, day: (dayOfYear % perMonth) + 1, worldDay: day };
}

export function r6RouteWeather(masterSeed32, routeId, worldDay) {
  const day = Math.floor(Number(worldDay)) >>> 0;
  const bytes = new TextEncoder().encode(`${routeId}|${Math.floor(Number(worldDay))}`);
  let salt = 0x811c9dc5;
  for (const byte of bytes) salt = Math.imul(salt ^ byte, 0x01000193) >>> 0;
  const key = ((Number(masterSeed32) >>> 0) ^ day ^ salt) >>> 0;
  let next = key;
  next ^= next << 13; next ^= next >>> 17; next ^= next << 5;
  next = (next >>> 0) || 1;
  return { routeId, worldDay: Math.floor(Number(worldDay)), masterSeed32: Number(masterSeed32) >>> 0, routeDaySalt32: salt >>> 0, key32: key, nextUint32: next, rainLevel: Math.floor((next / 0x100000000) * 4) };
}

export function createR4WorldEngine({ pack, definitions, seedConfig, saved = null, now = () => Date.now(), realmSourceAdapter = "r4", r6FreeSurvival = false, r6TimeContract = null }) {
  if (!pack || !definitions?.events || definitions.events.length !== pack.eventDefinitions.length) throw new Error("invalid_r4_world_package");
  if (!seedConfig || seedConfig.worldPackId !== pack.worldPackId || seedConfig.contentVersion !== pack.contentVersion) throw new Error("world_seed_package_mismatch");
  const registry = new Set(pack.registryIds || []);
  const referencedIds = collectRegisteredIds(seedConfig);
  for (const id of referencedIds) if (!registry.has(id)) throw new Error(`unregistered_seed_id:${id}`);
  for (const profile of seedConfig.originProfiles || []) {
    if (!registry.has(profile.originId) || !eventByPackHas(pack, definitions, profile.openingEventId)) throw new Error(`invalid_origin_seed:${profile.originId}`);
  }
  for (const event of definitions.events) {
    for (const option of event.options || []) {
      for (const effect of [...(option.success || []), ...(option.failure || [])]) {
        if (!SUPPORTED_EFFECTS.has(effect.op)) throw new Error(`unsupported_effect:${event.id}:${effect.op}`);
      }
    }
  }
  const eventById = new Map(definitions.events.map((event) => [event.id, event]));
  const initial = saved?.mode === "r4" ? clone(saved) : null;
  let state = initial || newState(pack, seedConfig, now());
  if (!Number.isSafeInteger(state.worldTick)) state.worldTick = Number(state.worldDay) * R6_TICKS_PER_DAY;
  if (!Number.isSafeInteger(state.worldTick) || state.worldTick < 0 || state.worldTick > R6_MAX_WORLD_TICK) throw new Error("invalid_world_tick");
  state.worldDay = Math.floor(state.worldTick / R6_TICKS_PER_DAY);
  state.world.worldDay = state.worldDay;
  if (r6FreeSurvival && realmSourceAdapter === "r5") {
    state.world.markets ||= {};
    state.character.r6StrandedReturnByLife ||= {};
    if (!state.world.r6FreeSurvivalMigrationReceipt) {
      const initialized = [];
      const tradable = pack.market.tradableUnitPrices || {};
      const salePrice = itemId => Math.floor(Number(tradable[itemId]) * Number(pack.caps.marketSellPercent || 50) / 100);
      for (const [marketId, marketConfig] of Object.entries(pack.market.locations || {})) {
        const initialStock = marketConfig.initialStock || {};
        const initialCredit = Object.entries(initialStock).reduce((sum, [itemId, quantity]) => Object.hasOwn(tradable, itemId)
          ? sum + Number(quantity) * salePrice(itemId) : sum, 0);
        const stock = state.world.marketStock?.[marketId];
        const stockVerified = stock && Object.entries(tradable).every(([itemId]) => Number.isSafeInteger(Number(stock[itemId])) && Number(stock[itemId]) >= 0);
        let credit = 0;
        let historyComplete = stockVerified && state.quotes && state.receipts && Array.isArray(state.world.marketTradeLedger);
        const quoteRows = Object.entries(state.quotes || {}).filter(([key, quote]) => key !== "active" && quote?.id === key && quote.marketId === marketId);
        const expectedStock = { ...initialStock };
        let netReceiptWealth = initialCredit;
        for (const [quoteId, quote] of quoteRows) {
          if (!quote.receipt) continue;
          const recorded = state.receipts?.[quoteId];
          if (!recorded || JSON.stringify(recorded) !== JSON.stringify(quote.receipt)) { historyComplete = false; break; }
          if (!Number.isSafeInteger(Number(quote.quantity)) || !Number.isSafeInteger(Number(quote.totalWealth)) || !["buy", "sell"].includes(quote.side)) { historyComplete = false; break; }
          expectedStock[quote.itemId] = Number(expectedStock[quote.itemId] || 0) + (quote.side === "buy" ? -Number(quote.quantity) : Number(quote.quantity));
          netReceiptWealth += quote.side === "buy" ? Number(quote.totalWealth) : -Number(quote.totalWealth);
        }
        if (historyComplete) {
          for (const [receiptId, receipt] of Object.entries(state.receipts)) {
            if (!state.quotes?.[receiptId] || JSON.stringify(state.quotes[receiptId].receipt) !== JSON.stringify(receipt)) { historyComplete = false; break; }
          }
        }
        if (historyComplete) {
          const marketSales = quoteRows.filter(([, quote]) => quote.side === "sell" && quote.receipt);
          for (const [, quote] of marketSales) {
            if (!state.world.marketTradeLedger.some(row => row.quoteId === quote.id && row.status === "committed")) { historyComplete = false; break; }
          }
        }
        if (historyComplete) {
          for (const itemId of Object.keys(tradable)) if (Number(expectedStock[itemId] || 0) !== Number(stock[itemId] || 0)) { historyComplete = false; break; }
        }
        if (historyComplete) credit = Math.max(0, netReceiptWealth);
        else if (stockVerified) credit = Math.min(initialCredit, Object.entries(tradable).reduce((sum, [itemId]) => sum + Number(stock[itemId]) * salePrice(itemId), 0));
        const existing = state.world.markets[marketId];
        state.world.markets[marketId] = existing?.ledgerVersion === "R6-MARKET-CREDIT-1" ? existing : {
          buyerCreditWealth: Math.max(0, Number.isSafeInteger(Number(existing?.buyerCreditWealth)) ? Number(existing.buyerCreditWealth) : credit),
          initialCreditWealth: initialCredit,
          buyerCreditReservations: existing?.buyerCreditReservations && typeof existing.buyerCreditReservations === "object" ? existing.buyerCreditReservations : {},
          ledgerVersion: "R6-MARKET-CREDIT-1",
          lastCommittedQuoteId: existing?.lastCommittedQuoteId || null
        };
        initialized.push(marketId);
      }
      state.world.r6FreeSurvivalMigrationReceipt = { migrationId: "R6-FREE-SURVIVAL-SAVE-1", status: "committed", marketsInitialized: initialized, day: Number(state.worldDay || 0) };
    }
    for (const market of Object.values(state.world.markets)) market.buyerCreditReservations ||= {};
  }
  state.world.realmServiceBoards ||= {};
  state.world.realmActionLedgers ||= { registrations: [], duties: [], housing: [], water: [], noteLoans: [] };
  state.world.realmEventSources ||= {};
  state.world.realmOperations ||= {};
  state.world.realmEventFollowups ||= {};
  for (const [id, person] of Object.entries({
    r4_npc_lin_xiaohe: { id: "r4_npc_lin_xiaohe", alive: true, locationId: "r4_loc_willow_market", onDuty: false, role: "waiting_student" },
    r4_npc_ash_neighbor: { id: "r4_npc_ash_neighbor", alive: true, locationId: "r4_loc_ashspring", onDuty: true, role: "neighbor" },
    r4_npc_room_owner: { id: "r4_npc_room_owner", alive: true, locationId: "r4_loc_ashspring", onDuty: true, role: "home_owner" },
    r4_npc_public_teacher: { id: "r4_npc_public_teacher", alive: true, locationId: "r4_loc_willow_market", onDuty: true, role: "public_teacher" },
    r4_npc_han_jian: { id: "r4_npc_han_jian", alive: true, locationId: "r4_loc_willow_market", onDuty: true, role: "archive_clerk" }
  })) state.world.npcRecords[id] ||= person;
  if (realmSourceAdapter === "r5") Object.assign(state.world.npcRecords.r4_npc_ash_neighbor, {
    nightCoverOfferPolicy: "renew_one_night_cover_for_current_worker",
    sharedWatchOfferPolicy: "offer_seven_day_shared_watch_with_player_acceptance"
  });
  if (realmSourceAdapter === "r5") {
    const people = state.world.npcRecords;
    Object.assign(people.r4_npc_market_vendor ||= { id: "r4_npc_market_vendor", alive: true, locationId: "r4_loc_willow_market", onDuty: true }, { realmWitnessPolicy: "offer_only_after_recorded_market_transaction" });
    Object.assign(people.r4_npc_han_archive ||= { id: "r4_npc_han_archive", alive: true, locationId: "r4_loc_willow_market", onDuty: true }, { archiveSubjectResponsePolicy: "grant_current_page_after_direct_request", custodyResponsePolicy: "entrust_public_register_and_tools_only_after_request" });
    Object.assign(people.r4_npc_lin_xiaohe ||= { id: "r4_npc_lin_xiaohe", alive: true, locationId: "r4_loc_willow_market", onDuty: true }, { careRequestPolicy: "may_ask_for_help_with_current_work_choice", lessonResponsePolicy: "accept_only_named_public_basics_session" });
    Object.assign(people.r4_npc_public_teacher, { openLessonPolicy: "accept_if_venue_and_learners_are_present", taughtSkillIds: ["r4_skill_dao01"] });
    Object.assign(people.r4_npc_waykeeper ||= { id: "r4_npc_waykeeper", alive: true, locationId: "r4_loc_willow_market", onDuty: true }, { roadPermitPolicy: "grant_one_segment_after_current_notice_request", appointmentPolicy: "invite_current_public_contributor_after_roster_review" });
    Object.assign(people.r4_npc_yan_teacher ||= { id: "r4_npc_yan_teacher", alive: true, locationId: "r4_loc_furnace_lane", onDuty: true }, { researchContributionPreference: "wants_contribution_trace" });
  }
  for (const [personId, person] of Object.entries(state.world.npcRecords)) {
    person.id ||= personId;
    if (person.locationId == null && person.location != null) person.locationId = person.location;
    person.onDuty ??= true;
  }
  const realmWorldId = state.world.id || state.worldId;
  const realmBoards = state.world.realmServiceBoards;
  realmBoards.practice ||= { status: "open", scheduleId: `public-practice:${realmWorldId}`, locationId: "r4_loc_willow_market" };
  realmBoards.course ||= { id: `${realmWorldId}:dao01-lesson`, status: "open", scheduleId: `dao01-lesson:${realmWorldId}`, teacherId: "r4_npc_public_teacher", locationId: "r4_loc_willow_market", openDay: state.worldDay, closeDay: state.worldDay + 1, capacity: 1 };
  realmBoards.nightDuty ||= { id: `${realmWorldId}:night-watch`, status: "open", locationId: "r4_loc_ashspring", coverOffer: { id: `${realmWorldId}:night-cover`, status: "offered", personId: "r4_npc_ash_neighbor", offeredBy: "r4_npc_ash_neighbor", scope: "one_night_cover", day: state.worldDay, expiresDay: state.worldDay + 7 } };
  const housingOwnerId = realmSourceAdapter === "r5" ? "r4_npc_ash_neighbor" : "r4_npc_room_owner";
  realmBoards.housing ||= { status: "open", locationId: "r4_loc_ashspring", homeId: `${realmWorldId}:shared-home`, ownerId: housingOwnerId, repairNotice: { status: "posted", causeId: `${realmWorldId}:roof-repair`, signedBy: housingOwnerId, homeId: `${realmWorldId}:shared-home` }, repairMaterials: { status: "available", stock: 1, sourceId: `${realmWorldId}:housing-maintenance-stock` }, vacantRoom: { id: `${realmWorldId}:vacant-room`, status: "verified_vacant", ownerId: housingOwnerId }, roommateOffer: { id: `${realmWorldId}:shared-watch-offer`, status: realmSourceAdapter === "r5" ? "not_offered" : "offered", personId: "r4_npc_ash_neighbor", offeredBy: realmSourceAdapter === "r5" ? null : "r4_npc_ash_neighbor", scope: "shared_night_watch", day: state.worldDay, expiresDay: realmSourceAdapter === "r5" ? state.worldDay : state.worldDay + 7 } };
  realmBoards.water ||= { status: "open", boardId: `${realmWorldId}:well-board`, locationId: "r4_loc_ashspring", repairCauseId: `${realmWorldId}:well-repair`, managerId: "r4_npc_ash_neighbor" };
  if (realmSourceAdapter === "r5") {
    state.world.realmActionLedgers.highRealmRequests ||= [];
    state.world.marketTradeLedger ||= []; state.world.quoteReceipts ||= {};
    state.world.rentalLedger ||= []; state.world.craftBatchLedger ||= []; state.world.researchReviews ||= []; state.world.researchRecords ||= [];
    state.world.equipment ||= {}; state.world.equipment["public-kiln"] ||= { status: "operable", locationId: "r4_loc_furnace_lane" };
    Object.assign(state.world.npcRecords.r4_npc_wen_repairer ||= { id: "r4_npc_wen_repairer", alive: true, locationId: "r4_loc_furnace_lane", onDuty: true, role: "repairer" }, { furnaceLeaseExtensionPolicy: "grant_one_7_day_extension_if_due_and_operable" });
    state.world.highRealmBoards ||= {
      archive: { id: `${realmWorldId}:public-archive`, status: "open", locationId: "r4_loc_willow_market", publicCatalogVersion: 1,
        publicPages: [{ id: `${realmWorldId}:public-index:v1`, status: "public", metadata: { volume: "local work ledger", revision: 1 } }],
        sealedPages: [{ id: `${realmWorldId}:sealed-page:han`, subjectId: "r4_npc_han_archive", status: "sealed", contentStored: false, authorization: { status: "none" } }], metadataIndex: [], reviewQueue: [], comparisons: [] },
      road: { id: `${realmWorldId}:public-road-board`, status: "open", locationId: "r4_loc_willow_market",
        segment: { id: `${realmWorldId}:north-footbridge`, ownerId: "public", status: "closed", causeId: `${realmWorldId}:inspection:${state.worldDay}`, postedDay: state.worldDay, expiresDay: null, reason: "inspection_in_progress", public: true, permits: [] },
        publishedMaps: [{ id: `${realmWorldId}:map:v1`, ownerId: "public", version: 1, publishedDay: Math.max(0, state.worldDay - 30), segments: [{ id: `${realmWorldId}:north-footbridge`, status: "open", verifiedDay: Math.max(0, state.worldDay - 30) }] }], mapRequests: [], repairLedger: [], repairStock: 1, repairStockSourceId: `${realmWorldId}:public-maintenance-kit`, publicShipment: { id: `${realmWorldId}:market-herb-delivery`, ownerId: "r4_npc_market_vendor", cargoId: `${realmWorldId}:market-herb-crate`, status: "verified_waiting", currentCarrierId: "r4_npc_market_vendor", origin: "r4_loc_willow_market", destination: "r4_loc_ashspring", proofId: `${realmWorldId}:market-shipment-manifest`, expiresDay: null }, detours: [] },
      facilityMove: { id: `${realmWorldId}:public-archive-move`, status: "scheduled", locationId: "r4_loc_willow_market", ownerId: "public", custodianId: "r4_npc_han_archive", departDay: state.worldDay + 1380, arrivalLocationId: "r4_loc_ashspring", cargo: [{ id: `${realmWorldId}:public-register`, item: "public_register", ownerId: "public", portable: true, status: "ready" }, { id: `${realmWorldId}:communal-tools`, item: "communal_tools", ownerId: "public", portable: true, status: "ready" }, { id: `${realmWorldId}:sealed-page:han`, item: "personal_sealed_page", ownerId: "r4_npc_han_archive", portable: true, status: "awaiting_owner_consent" }], custodyReceipts: [] },
      lesson: { id: `${realmWorldId}:public-hall`, status: "available", locationId: "r4_loc_willow_market", teacherId: "r4_npc_public_teacher", capacity: 3, roster: [], sessions: [] },
      organization: { id: "r4_faction_waykeepers", status: state.world.factions?.r4_faction_waykeepers?.guideService ? "active" : "inactive", vacancy: { id: `${realmWorldId}:seasonal-route-steward`, office: "seasonal_route_steward", status: "open", termDays: 30, scope: "one_public_segment" }, process: { id: `${realmWorldId}:waykeeper-appointment`, status: "open", steps: ["public_nomination", "credential_review", "dated_invitation", "acceptance"] }, nominationLedger: [], credentialReviews: [], candidateRoster: [], appointments: [], rotationProposals: [], invitations: [] },
      methods: { id: `${realmWorldId}:public-method-archive`, status: "open", entries: [] }
    };
    realmBoards.research ||= { status: "open", locationId: "r4_loc_furnace_lane", contributorId: "r4_npc_yan_teacher", records: [] };
    state.world.highRealmBoards.organization.nominationLedger ||= [];
    state.world.highRealmBoards.organization.credentialReviews ||= [];
    if (state.world.kilnQueueSourceVersion !== 1) {
      const startDay = Number(pack.runtimeSources.worldInitialization.worldDay);
      state.world.publicSchedules ||= {};
      const queue = state.world.publicSchedules.kilnQueue ||= {
        id: `kiln-queue:${realmWorldId}:initial`, status: "open", permitId: `kiln-visit:${realmWorldId}:${state.character.id}`,
        permitHolderId: state.character.id, permitStatus: "valid", reservationId: `reservation:${realmWorldId}:${state.character.id}:today`,
        reservationStatus: "booked", slotDay: startDay + 14,
        inspectionCauseId: `kiln-crack-inspection:${realmWorldId}:slot-${startDay + 14}`, inspectionStatus: "crack_reported",
        repairerId: "r4_npc_wen_repairer", repairerLocation: "r4_loc_furnace_lane", location: "r4_loc_furnace_lane", yieldedTo: null, resolution: null
      };
      state.character.permits ||= {};
      if (queue.permitId && !state.character.permits.kilnVisit) state.character.permits.kilnVisit = {
        id: queue.permitId, kind: "kiln_visit", location: queue.location, status: "valid", issuedDay: startDay, expiresDay: startDay + 30
      };
      const urgentId = "r4_npc_furnace_urgent";
      state.world.npcRecords[urgentId] ||= { id: urgentId, alive: true, locationId: "r4_loc_furnace_lane", role: "urgent_kiln_customer", urgentNeed: "time-sensitive repair firing" };
      queue.urgentRequest ||= { id: `urgent-kiln:${realmWorldId}:today`, requesterId: urgentId, credentialId: `repair-proof:${realmWorldId}:urgent-1`, status: "verified_waiting", createdDay: queue.slotDay, need: "time-sensitive repair firing" };
      state.world.kilnQueueSourceVersion = 1;
    }
  }
  realmBoards.library ||= { status: "open", locationId: "r4_loc_willow_market", clerkId: "r4_npc_han_jian", notes: [{ id: `${realmWorldId}:foundation-note:breath-first`, status: "available", authorId: "r4_npc_public_teacher", revision: 1 }, { id: `${realmWorldId}:foundation-note:body-first`, status: "available", authorId: "r4_npc_yan_teacher", revision: 1 }] };
  state.world.dailyServiceBoards.archive ||= { status: "open", sealStatus: "unsealed", locationId: "r4_loc_willow_market", volumeId: `${realmWorldId}:public-archive-catalog`, clerkId: "r4_npc_han_jian" };
  state.world.dailyServiceBoards.well ||= { status: "open", boardId: `${realmWorldId}:well-board`, locationId: "r4_loc_ashspring", rotation: [state.character.id], ropeStatus: "worn", repairCauseId: `${realmWorldId}:well-repair:${state.worldDay}`, swapConsents: {}, alternative: { status: "posted", noticeId: `${realmWorldId}:well-alternative:${state.worldDay}`, locationId: "r4_loc_ashspring" } };
  state.world.dailyServiceBoards.well.rotation ||= [state.character.id];
  state.world.dailyServiceBoards.well.swapConsents ||= {};
  state.suspendedTransactions ||= [];
  state.actionTransactionLedger ||= {};
  state.pendingResult ??= null;
  state.pendingResult = compactReceipt(state.pendingResult);
  state.lastResult = compactReceipt(state.lastResult);
  for (const entry of Object.values(state.actionTransactionLedger)) if (entry?.result) entry.result = compactReceipt(entry.result);
  const restoredAction = state.inFlightTransaction?.kind === "action" ? state.actionTransactionLedger[state.inFlightTransaction.transactionId] : null;
  if (restoredAction?.status === "completed" || restoredAction?.status === "aborted" || restoredAction?.status === "interrupted_by_death") {
    state.inFlightTransaction = null;
    if (restoredAction.result) state.pendingResult = clone(restoredAction.result);
  }
  if (state.quotes?.active?.id && state.quotes[state.quotes.active.id]) state.quotes.active = state.quotes[state.quotes.active.id];

  function activeCrisis() {
    if (state.activeCrisisInstanceId) return state.world.crisisInstances.find((item) => item.id === state.activeCrisisInstanceId && !item.closed);
    const event = eventById.get(state.activeEventId);
    const family = Object.entries(pack.crises).find(([, plan]) => plan.eventIds?.includes(event?.id))?.[0];
    return state.world.crisisInstances.find((item) => !item.closed && (!family || item.family === family));
  }

  function contextualCrisis() {
    if (state.activeCrisisInstanceId) return state.world.crisisInstances.find((item) => item.id === state.activeCrisisInstanceId) || activeCrisis();
    return activeCrisis();
  }

  function serviceAvailable(role) {
    const definition = pack.runtimeSources.worldInitialization.serviceRoles?.[role];
    if (!definition) return false;
    return Boolean(state.world.services?.[role]?.active && state.world.locations?.[definition.location]);
  }

  function promotionOpen() {
    const schedule = state.world.publicSchedules?.promotion;
    const instance = state.world.crisisInstances.find((item) => item.family === "resonance" && !item.closed);
    return Boolean(schedule && instance?.promotionActive && state.worldDay >= schedule.openDay && state.worldDay <= schedule.closeDay);
  }

  function scopeInstanceId(event) {
    const scope = event.instanceScope || "world";
    if (["r4_ev_daily_courier", "r4_ev_daily_roadmarker"].includes(event.id)) return state.queue.find((entry) => entry.eventId === event.id && entry.day <= state.worldDay)?.instanceId || state.world.dailyBusinessSources?.[event.id === "r4_ev_daily_courier" ? "courier" : "roadmarker"]?.id || state.worldId;
    if (scope === "world_crisis_instance") return activeCrisis()?.id || state.world.crisisInstances.find((item) => item.family === Object.entries(pack.crises).find(([, plan]) => plan.eventIds?.includes(event.id))?.[0] && !item.closed)?.id || state.worldId;
    if (scope === "character_opening") return state.world.openingInstance?.id || state.character.id;
    if (scope === "character_origin_record") return `${state.character.id}:${state.character.origin || "unborn"}`;
    if (scope === "character_breakthrough") return `${state.character.id}:${state.character.preparationWindowId || state.character.generation}`;
    if (scope.startsWith("character_")) return state.character.id;
    if (scope === "harvest_batch") return `${state.character.location}:${Math.floor(state.worldDay / Number(pack.caps.herbRestockDays || 30))}`;
    if (scope === "demand_instance") return state.world.demandInstance?.id || state.worldId;
    if (scope === "furnace_state") return state.world.furnace?.id || state.character.permits.furnace?.permitId || `${state.worldId}:furnace`;
    if (scope === "person_request") return state.world.requestingPerson || state.world.requestId || `${state.worldId}:request`;
    if (scope === "repair_task") return state.world.repairTask?.id || `${state.worldId}:repair`;
    if (scope === "borrowed_item") return Object.entries(state.character.inventoryLedger).flatMap(([itemId, entries]) => entries.map((entry) => ({ itemId, ...entry }))).find((entry) => entry.ownership === "borrowed")?.sourceId || `${state.character.id}:borrowed`;
    if (scope === "market_quote") return state.quotes.active?.id || `${state.worldId}:market`;
    if (scope === "conflict_instance") return state.world.conflict?.id || `${state.worldId}:conflict`;
    return state.worldId;
  }

  function repeatLimit(event) {
    const match = String(event.repeatPolicy || "").match(/^stock_capped_(\d+)_per_location_per_30_days$/);
    return match ? Number(match[1]) : 0;
  }

  function completedRepeatCount(instanceId, eventId) {
    const prefix = `${instanceId}:${eventId}:`;
    return Object.entries(state.eventClaimLedger).filter(([key, claim]) => key.startsWith(prefix) && key !== recordKey(instanceId, eventId, 0) && claim.state === "completed").length;
  }

  function evaluateWorldPlan() {
    const sources = pack.runtimeSources;
    const init = sources.worldInitialization;
    const availableInstances = seedConfig.worldSeed.crisisInstances || [];
    const factories = sources.instanceFactories || {};
    for (const [family, factory] of Object.entries(factories)) {
      if (state.world.worldPlan.created[family]) continue;
      let eligible = false;
      if (factory.trigger === "explicit_world_plan_node") {
        const faction = state.world.factions[factory.sourceFaction] || {};
        eligible = factory.requires.every((requirement) => {
          if (requirement === "projectMotivation") return faction.projectMotivation === true;
          if (requirement === "twoConstructionSites") return (faction.constructionSites || []).length >= 2;
          if (requirement === "arrayMaterialStock") return Number(faction.arrayMaterialStock) >= 2;
          if (requirement === "contractorAvailable") return faction.contractorAvailable === true;
          return false;
        });
      } else if (factory.trigger === "open_registered_promotion_schedule") {
        const schedule = init.publicSchedules.promotion;
        const teacher = serviceAvailable(factory.teacherServiceRole || "resonanceTeacher");
        eligible = Boolean(schedule && state.worldDay >= schedule.openDay && state.worldDay <= schedule.closeDay && teacher && schedule.capacity > 0);
      }
      if (!eligible) continue;
      const prior = state.world.crisisInstances.filter((item) => item.family === family).length;
      const identity = availableInstances.find((entry) => entry.family === family && registry.has(entry.instanceId)) || { instanceId: `${state.worldId}:${family}:${String(prior + 1).padStart(3, "0")}`, status: "active" };
      const instance = createCrisisInstance(family, identity, factory);
      state.world.worldPlan.created[family] = instance.id;
    }
  }

  function createCrisisInstance(family, identity, factory = {}) {
    const plan = pack.crises[family];
    if (!plan || (identity.instanceId.startsWith("r4_") && !registry.has(identity.instanceId))) throw new Error(`invalid_crisis_instance:${family}`);
    const instance = {
      id: identity.instanceId, family, createdDay: state.worldDay + Number(identity.createdDayOffset || 0), closed: false,
      ...crisisInitialState(family),
      status: factory.createdStatus || identity.status || "active", stage: factory.initialStage || "local_impact", countered: false, terminalDay: null, nodeClaims: {},
      ...(family === "lingxu" ? { springDecline: Boolean(factory.springDecline), irreversibleDay: state.worldDay + 360, closedDay: state.worldDay + 360, repairedDay: state.worldDay + 360, connectAttemptDay: state.worldDay + 270, secondSiteRecord: true, siteIds: clone(state.world.factions[factory.sourceFaction]?.constructionSites || []), supportChain: true, resources: true, independentLedgerCount: 2, witnessId: Object.keys(pack.runtimeSources.worldInitialization.people || {}).find((id) => id.endsWith("lu_gatherer")), witnessExists: true, merchantCommitmentIds: Array.from({ length: Number(factory.merchantCommitmentCount || 0) }, (_, index) => `merchant:${state.worldId}:${state.world.crisisInstances.filter((item) => item.family === family).length + 1}:${index + 1}`) } : {}),
      ...(family === "resonance" ? { promotionActive: Boolean(factory.promotionActive), relayCapacity: Boolean(factory.relayCapacity), networkThreshold: Boolean(factory.networkThreshold), irreversibleDay: state.worldDay + 240, closedDay: state.worldDay + 240, participantAccepted: false, promotionEvidence: false, promotionInstanceId: state.world.promotion.id, participantId: seedConfig.instanceRuntime?.[family]?.participantId, publicSignatoryIds: (factory.publicSignatoryFactions || []).map((factionId, index) => `appeal:${state.worldId}:${state.world.crisisInstances.filter((item) => item.family === family).length + 1}:${factionId}:${index + 1}`), independentRecords: 0 } : {})
    };
    state.world.crisisInstances.push(instance);
    if (family === "resonance") {
      state.world.participant = instance.participantId;
      state.world.witness = instance.participantId;
      state.world.npcRecords[instance.participantId] = { ...state.world.npcRecords[instance.participantId], symptomOpen: false, markDay: state.worldDay, symptomDeadline: state.worldDay + 180, contactDeadline: state.worldDay + 90, networkWitness: true, consent: true, contactable: true, trust: 1 };
      state.world.medicalCase = { exists: false, location: state.world.publicSchedules.promotion.location };
      state.world.publicAppeal = { open: true, location: state.world.publicSchedules.promotion.location };
      state.world.contest.open = true;
    }
    const firstEventId = plan.eventIds.map((eventId) => eventById.get(eventId)).find((event) => event && (event.type === "crisis" || event.type === "crisis_clue" || event.type === "local_story"))?.id;
    const firstEvent = eventById.get(firstEventId);
    if (firstEvent) {
      const previousEvent = state.activeEventId;
      const previousInstance = state.activeCrisisInstanceId;
      state.activeEventId = firstEvent.id;
      state.activeCrisisInstanceId = instance.id;
      const rawDue = firstEvent.window?.from == null ? instance.createdDay : resolvePath(firstEvent.window.from);
      state.activeEventId = previousEvent;
      state.activeCrisisInstanceId = previousInstance;
      const due = Number(rawDue);
      enqueue(firstEvent.id, Number.isFinite(due) ? due : instance.createdDay, instance.id);
    }
    appendCause("crisis_instance_created", instance.id, { family, trigger: factory.trigger });
    return instance;
  }

  function newState(worldPack, config, seed) {
    const inventory = {};
    const knowledge = {};
    const skills = {};
    const worldSeed = config.worldSeed;
    const runtime = worldPack.runtimeSources;
    const init = runtime?.worldInitialization;
    if (!runtime || runtime.schemaVersion !== 1 || !init || !config.worldSeed) throw new Error("missing_runtime_source_contract");
    const locations = Object.fromEntries((worldSeed.initialLocations || []).map((location) => [location.locationId, { ...location }]));
    const npcRecords = Object.fromEntries(Object.entries(init.people || {}).map(([id, person]) => [id, { ...clone(person), locationId: person.location }]));
    const marketStock = Object.fromEntries(Object.entries(worldPack.market.locations).map(([locationId, market]) => [locationId, clone(market.initialStock)]));
    const startDay = Number(init.worldDay);
    const roleFact = { arrayist: "projectMotivation", healer: "publicHealingService", resonanceTeacher: "promotionService", waykeeper: "guideService", resonanceInsider: "promotionService" };
    const services = Object.fromEntries(Object.entries(init.serviceRoles || {}).map(([role, spec]) => [role, { id: `service:${seed.toString(36)}:${role}`, active: Boolean(init.factions?.[spec.sourceFaction]?.[roleFact[role]]), sourceFaction: spec.sourceFaction, location: spec.location }]));
    const board = init.publicWorkBoard;
    const promotion = clone(init.publicSchedules?.promotion || {});
    Object.assign(promotion, { active: true, participants: [], acceptedCount: 0, id: `promotion:${seed.toString(36)}:initial` });
    if (!Number.isSafeInteger(startDay) || !Number.isInteger(Number(worldPack.calendar.epochYear))) throw new Error("invalid_calendar_seed");
    return {
      mode: "r4", namespace: worldPack.save.namespace, schemaVersion: worldPack.save.schemaVersion,
      contentVersion: worldPack.contentVersion, worldPackId: worldPack.worldPackId,
      worldId: `world-${seed.toString(36)}`, worldDay: startDay, worldTick: startDay * R6_TICKS_PER_DAY,
      rngState: (Number(seed) >>> 0) || 1, eventClaimLedger: {}, queue: [], inFlightTransaction: null, suspendedTransactions: [],
      operationSequence: 0, quotes: {}, receipts: {}, causeLog: [], instances: {}, generations: [], pendingResult: null, actionTransactionLedger: {},
      world: { locations, marketStock, crisisInstances: [], worldEventQueue: [], npcRecords: { ...npcRecords, r4_npc_tan_sail: { id: "r4_npc_tan_sail", alive: true, locationId: "r4_loc_willow_market", role: "ferry_operator", onDuty: true }, r4_npc_ferry_worker: { id: "r4_npc_ferry_worker", alive: true, locationId: "r4_loc_willow_market", role: "queued_traveler", commitment: "r4_loc_ashspring" }, r4_npc_market_clerk: { id: "r4_npc_market_clerk", alive: true, locationId: "r4_loc_willow_market", role: "market_registrar", onDuty: true }, r4_npc_han_jian: { id: "r4_npc_han_jian", alive: true, locationId: "r4_loc_willow_market", role: "archive_clerk", onDuty: true }, r4_npc_public_teacher: { id: "r4_npc_public_teacher", alive: true, locationId: "r4_loc_willow_market", role: "public_teacher", onDuty: true }, r4_npc_waykeeper: { id: "r4_npc_waykeeper", alive: true, locationId: "r4_loc_willow_market", role: "road_maintainer", onDuty: true } }, worldOutcomes: {}, factions: clone(init.factions || {}), region: clone(init.regionDefaults || {}), regions: clone(init.regionDefaults || {}), facts: {}, services, serviceRoles: clone(init.serviceRoles || {}), publicSchedules: clone(init.publicSchedules || {}), promotion, craftMeeting: clone(init.publicSchedules?.craftMeeting || {}), routes: clone(init.routes || []), knownLocations: clone(init.knownLocations || []), dailyServiceBoards: { ferry: { id: `ferry-board:${seed.toString(36)}:${startDay}`, status: "scheduled", locationId: "r4_loc_willow_market", routeFrom: "r4_loc_willow_market", routeTo: "r4_loc_ashspring", openDay: startDay, closeDay: startDay + 30, waterStatus: "safe", waterCauseId: `world-${seed.toString(36)}:water-level:${startDay}`, fare: 1, days: 7, workerCommitment: { status: "waiting", workerId: "r4_npc_ferry_worker", causeId: `world-${seed.toString(36)}:ferry-worker:${startDay}` } }, publicLesson: { status: "open", locationId: "r4_loc_willow_market", causeId: `world-${seed.toString(36)}:book-loan:${startDay}`, teacherId: "r4_npc_public_teacher", clerkId: "r4_npc_han_jian", bookId: `world-${seed.toString(36)}:public-book:${startDay}`, loanStatus: "available", loans: [], missingPage: { page: 17, lastBorrowerId: "r4_npc_stall_neighbor", status: "recorded_missing" }, revisionNotice: { status: "posted", edition: "revised", page: 17 } }, road: { status: "active", locationId: "r4_loc_willow_market", routeRecordId: `world-${seed.toString(36)}:route-record`, maintenanceCauseId: `world-${seed.toString(36)}:road-repair:${startDay}`, permitByCharacter: {}, verifiedRoute: { verified: true, direction: "r4_loc_ashspring", verifiedDay: startDay }, maintenanceNotice: { status: "active", causeId: `world-${seed.toString(36)}:road-repair:${startDay}` }, sign: { status: "damaged", causeId: `world-${seed.toString(36)}:road-weather:${startDay}` } } }, dailyBusinessSources: {}, dailyBusinessFollowups: {}, eraEventSources: {}, eraEventFollowups: {}, eraEventReceipts: {}, eraEventIssueLog: [], factionSettlements: [], factionSettlementAudits: [], destroyedOrganizations: [], organizationCauseIds: {}, organizationInventories: {}, organizationIndividualRights: [], worldNodeReceipts: {}, irrigationClaims: [], travelReceipts: [], worldPlan: { created: {} }, promotionParticipants: [], contest: { known: true, open: Number(init.publicSchedules?.craftMeeting?.openDay) <= startDay && Number(init.publicSchedules?.craftMeeting?.closeDay) >= startDay, id: `craft:${seed.toString(36)}:initial` }, workBoard: board ? Array.from({ length: board.tasksPerCharacter }, (_, index) => ({ id: `work:${seed.toString(36)}:character-${seed.toString(36)}:${index + 1}`, status: "open", realNeed: true, openDay: startDay + index * board.repeatCooldownDays, deadlineDay: startDay + (index + 1) * board.repeatCooldownDays, location: null, reward: board.reward, durationDays: board.durationDays, sourceFaction: board.sourceFaction })) : [], demandInstance: null, demandLocation: null, locationFacts: { r4_loc_ashspring: { harvestableStock: worldPack.caps.dailyHerbStockPerLocation, harvestRestockDay: startDay + worldPack.caps.herbRestockDays } }, worldPlan: { created: {} }, openingInstance: null, openingDanger: false, sourceContractVersion: runtime.schemaVersion },
      character: {
        id: `character-${seed.toString(36)}`, generation: 1, alive: true, birthDay: worldPack.calendar.epochDay,
        deathDay: null, origin: null, location: null,
        skills, learnedSkills: [], inventoryLedger: {}, inventory, permits: {}, relationships: {},
        knowledge, actionLog: [], ageDays: startDay - Number(worldPack.calendar.epochDay), leftScene: false,
        proficiency: {}, studyProgress: {},
        birthRecord: {}, leftOriginDay: null,
        causeLog: [], recordsVia: [], story: {}, aliveDays: 0
      },
      eventDefinitions: definitions.events.map((event) => event.id),
      activeEventId: null, lastResult: null, completedActionCount: 0
    };
  }

  const resolvePath = (path) => {
    if (path == null) return undefined;
    if (typeof path !== "string") return path;
    const special = {
      worldDay: () => state.worldDay,
      quotedItem: () => state.quotes.active?.itemId,
      quotedQuantity: () => state.quotes.active?.quantity,
      "quote.totalWealth": () => state.quotes.active?.totalWealth,
      "quote.side": () => state.quotes.active?.side,
      "quote.valid": () => !!state.quotes.active && state.quotes.active.expiryDay >= state.worldDay,
      "quote.marketId": () => state.quotes.active?.marketId
    };
    if (special[path]) return special[path]();
    if (path === "character.furnacePermit") return clone(state.character.permits?.furnace);
    if (path.startsWith("character.furnacePermit.")) return path.split(".").slice(2).reduce((value, key) => value?.[key], state.character.permits?.furnace);
    if (path === "worldDay") return state.worldDay;
    if (path === "quotedQuantity") return state.quotes.active?.quantity;
    if (path === "quotedItem") return state.quotes.active?.itemId;
    if (path.startsWith("character.knowledge.")) {
      const key = path.slice("character.knowledge.".length);
      const exact = state.character.knowledge[key]?.level;
      if (exact) return exact;
      const nested = Object.entries(state.character.knowledge).filter(([entry]) => entry.startsWith(`${key}.`)).map(([, entry]) => entry.level);
      return nested.sort((a, b) => (KNOWLEDGE_LEVELS[b] || 0) - (KNOWLEDGE_LEVELS[a] || 0))[0];
    }
    if (path === "character.inventory.quotedItem") return Number(state.character.inventory[state.quotes.active?.itemId] || 0);
    if (path === "market.stock.quotedItem") return Number(state.world.marketStock?.[state.quotes.active?.marketId]?.[state.quotes.active?.itemId] ?? pack.market.locations[state.quotes.active?.marketId]?.initialStock?.[state.quotes.active?.itemId] ?? 0);
    if (path === "character.manualReadable") return Object.entries(state.character.inventory).some(([id, count]) => id.endsWith("_manual") && Number(count) > 0);
    if (path === "character.furnacePermitValidHere") {
      const permit = state.character.permits.furnace;
      return !!permit && permit.location === state.character.location && state.worldDay <= Number(permit.issuedDay) + Number(permit.validDays);
    }
    if (path === "character.dao01SourceValid") {
      const schedule = state.world.publicSchedules?.dao01Lesson;
      const hasManual = Number(state.character.inventory.r4_item_manual || 0) > 0;
      const permit = state.character.permits.dao01;
      const permitValid = permit && Number(permit.validFrom || 0) <= state.worldDay && state.worldDay <= Number(permit.validUntil ?? -1);
      const publicLesson = schedule && state.worldDay >= schedule.openDay && state.worldDay <= schedule.closeDay && state.character.location === schedule.location && state.character.knowledge.lessonLocation && schedule.loanedManualAvailable;
      return hasManual || Boolean(permitValid) || Boolean(publicLesson);
    }
    if (path === "region.springDecline" || path === "springDecline") return Boolean(state.world.region?.springDecline ?? state.world.regions?.springDecline ?? pack.runtimeSources.derivedFields["region.springDecline"].default);
    if (path === "world.openingDanger") return Boolean(state.world.openingDanger);
    if (path === "world.nearestSafeLocation") return state.world.openingInstance?.exitLocation;
    if (path === "world.companionId") return state.world.openingInstance?.companionPersonId;
    if (path === "world.safeRegion") return state.world.openingInstance?.exitLocation;
    if (path === "contest.known") return Boolean(state.world.contest?.known);
    if (path === "contest.open") return Boolean(state.world.contest?.open);
    if (path === "invite.relationship") return Number(state.character.relationships?.r4_npc_qi_student?.value || 0) > 0;
    if (path === "world.publicLessonKnown") { const schedule = pack.runtimeSources.worldInitialization.publicSchedules.dao01Lesson; return state.worldDay >= schedule.openDay && state.worldDay <= schedule.closeDay; }
    if (path === "world.participant") return state.world.participant;
    if (path === "world.witness") return state.world.witness;
    if (path === "affectedBatch.weakQuality") return Boolean(state.character.knowledge["affectedBatch.weakQuality"] && (KNOWLEDGE_LEVELS[state.character.knowledge["affectedBatch.weakQuality"].level] || 0) >= KNOWLEDGE_LEVELS.evidence);
    if (path === "world.arrayistAvailable") return serviceAvailable("arrayist");
    if (path === "world.waykeeperAvailable") return serviceAvailable("waykeeper");
    if (path === "world.healerAvailable") return serviceAvailable("healer") && Boolean(state.character.facts?.medicalCase_known || state.character.knowledge.medicalCase);
    if (path === "world.insiderAvailable") return Boolean(state.character.contacts?.resonanceInsider) && serviceAvailable("resonanceInsider");
    if (path === "world.knownSafeRoute") return (KNOWLEDGE_LEVELS[state.character.knowledge.safeExit?.level] || 0) >= KNOWLEDGE_LEVELS.heard && state.world.routes.some((route) => route.from === state.character.location && state.character.knownLocations?.includes(route.to));
    if (path === "world.companionPresent") { const companion = state.world.openingInstance?.companionPersonId; const person = state.world.npcRecords?.[companion]; return Boolean(companion && person?.alive && person.location === state.world.openingInstance.location && !state.world.openingInstance.closed); }
    if (path === "world.organizationAccess") { const crisis = activeCrisis(); return Boolean(crisis && ["active", "incursion"].includes(crisis.status) && state.character.organizationAccess?.[crisis.id]); }
    if (path === "world.allianceAvailable") { const crisis = activeCrisis(); return Boolean(crisis && ["active", "incursion"].includes(crisis.status) && (state.character.crisisAllyCommitments?.[crisis.id] || []).length >= 2); }
    if (path === "crisis.allyCount") return (state.character.crisisAllyCommitments?.[activeCrisis()?.id] || []).length;
    if (path === "promotion.eventOpen") return promotionOpen();
    if (path === "promotion.teacherExists") return promotionOpen() && serviceAvailable("resonanceTeacher");
    if (path === "promotion.capacity") { const schedule = state.world.publicSchedules?.promotion; return promotionOpen() ? Math.max(0, Number(schedule.capacity || 0) - state.world.promotionParticipants.length) : 0; }
    const expression = path.match(/^(.+?)([+-])(\d+)$/);
    if (expression) return Number(resolvePath(expression[1])) + (expression[2] === "+" ? 1 : -1) * Number(expression[3]);
    const aliases = { "character.inventory": state.character.inventory, "character.learnedSkills": state.character.learnedSkills, "character.knowledge": state.character.knowledge, "character.skills": state.character.skills };
    if (path in aliases) return aliases[path];
    let parts = path.split(".");
    let root;
    if (parts[0] === "character") { root = state.character; parts.shift(); }
    else if (parts[0] === "world") { root = state.world; parts.shift(); }
    else if (parts[0] === "quote") { root = state.quotes.active || {}; parts.shift(); }
    else if (parts[0] === "crisis") {
      const activeEvent = eventById.get(state.activeEventId);
      const family = Object.entries(pack.crises).find(([, plan]) => plan.eventIds?.includes(activeEvent?.id))?.[0];
      root = state.world.crisisInstances.find((item) => item.id === state.activeCrisisInstanceId) || state.world.crisisInstances.find((item) => item.family === family && !item.closed) || {};
      parts.shift();
    }
    else if (parts[0] === "location") { root = state.world.locations?.[state.character.location] || {}; parts.shift(); }
    else if (parts[0] === "furnace") { root = state.world.furnace; parts.shift(); }
    else if (parts[0] === "region") { root = state.world.region || state.world.regions || {}; parts.shift(); }
    else if (parts[0] === "promotion") { root = state.world.promotion; parts.shift(); }
    else if (parts[0] === "participant") { root = state.world.npcRecords[state.world.participant] || {}; parts.shift(); }
    else if (parts[0] === "person") { root = state.world.npcRecords[state.world.requestingPerson] || {}; parts.shift(); }
    else if (parts[0] === "witness") { root = state.world.npcRecords[state.world.witness] || {}; parts.shift(); }
    else if (parts[0] === "medicalCase") { root = state.world.medicalCase || {}; parts.shift(); }
    else if (parts[0] === "repairTask") { root = state.world.repairTask || {}; parts.shift(); }
    else if (parts[0] === "demandInstance") { root = state.world.demandInstance || {}; parts.shift(); }
    else if (parts[0] === "conflict") { root = state.world.conflict || {}; parts.shift(); }
    else if (parts[0] === "contest") { root = state.world.contest || {}; parts.shift(); }
    else if (parts[0] === "borrowedItem") { root = state.world.borrowedItem || {}; parts.shift(); }
    else if (parts[0] === "affectedBatch") { root = activeCrisis()?.affectedBatch || {}; parts.shift(); }
    else if (parts[0] === "springDecline") return Boolean(state.world.region?.springDecline ?? pack.runtimeSources.derivedFields["region.springDecline"].default);
    else if (parts[0].startsWith("r4_fact_")) return resolveFact(parts[0], parts.slice(1));
    else if (parts[0].startsWith("r4_item_") || parts[0].startsWith("r6_item_")) return state.character.inventory[parts[0]] || 0;
    else if (parts[0].startsWith("r4_npc_")) { root = state.world.npcRecords[parts[0]] || {}; parts.shift(); }
    else if (parts[0] === "market") { root = state.world.market || {}; parts.shift(); }
    else if (parts[0] === "player") { root = state.character; parts.shift(); }
    else return undefined;
    for (const part of parts) {
      const index = part.match(/^(.+)\[(\d+)\]$/);
      if (index) root = root?.[index[1]]?.[Number(index[2])];
      else root = root?.[part];
    }
    return root;
  };

  function resolveFact(id, suffix = []) {
    const fact = state.character.facts?.[id] ?? state.world.facts?.[id];
    if (!suffix.length) return fact;
    let value = fact;
    for (const key of suffix) value = value?.[key];
    return value;
  }

  function testPredicate(predicate) {
    if (predicate === true) return true;
    if (predicate === false || predicate == null) return false;
    if (typeof predicate === "string") return false;
    if (predicate.all) return predicate.all.every(testPredicate);
    if (predicate.any) return predicate.any.some(testPredicate);
    if (predicate.not) return !testPredicate(predicate.not);
    const left = resolvePath(predicate.fact);
    const right = typeof predicate.value === "string" && (predicate.value.includes(".") || predicate.value === "worldDay" || predicate.value === "quotedQuantity" || predicate.value === "quotedItem" || /[+-]\d+$/.test(predicate.value)) ? resolvePath(predicate.value) ?? predicate.value : predicate.value;
    switch (predicate.op) {
      case "eq": return left === right;
      case "ne": return left !== right;
      case "gt": return Number(left) > Number(right);
      case "gte": return compare(left, right) >= 0;
      case "lt": return Number(left) < Number(right);
      case "lte": return Number(left) <= Number(right);
      case "in": return Array.isArray(right) && right.includes(left);
      case "contains": return Array.isArray(left) ? left.includes(right) : typeof left === "string" ? left.includes(String(right)) : Number(left?.[right] || 0) > 0;
      case "exists": return left !== undefined && left !== null && (predicate.value === false ? !left : true);
      default: throw new Error(`unsupported_predicate:${predicate.op}`);
    }
  }

  function compare(a, b) {
    if (typeof a === "string" && typeof b === "string" && a in KNOWLEDGE_LEVELS && b in KNOWLEDGE_LEVELS) return KNOWLEDGE_LEVELS[a] - KNOWLEDGE_LEVELS[b];
    return Number(a) - Number(b);
  }

  function setPath(path, value, delta = null) {
    if (path === "market.stock.quotedItem") {
      const quote = state.quotes.active;
      if (!quote) throw new Error("market_stock_effect_requires_quote");
      const stock = state.world.marketStock?.[quote.marketId];
      if (!stock) throw new Error("market_stock_missing");
      stock[quote.itemId] = delta != null ? Number(stock[quote.itemId] || 0) + Number(delta) : Number(resolveValue(value) || 0);
      return;
    }
    path = path.replaceAll("$activeInstanceId", contextualCrisis()?.id || "$activeInstanceId");
    if (path === "character.furnacePermit" || path.startsWith("character.furnacePermit.")) {
      const suffix = path.split(".").slice(2);
      let root = state.character.permits ||= {};
      root.furnace ||= {};
      if (!suffix.length) state.character.permits.furnace = clone(value);
      else {
        for (const key of suffix.slice(0, -1)) root.furnace[key] ||= {};
        const leaf = suffix.at(-1);
        if (delta != null) root.furnace[leaf] = Number(root.furnace[leaf] || 0) + Number(delta);
        else root.furnace[leaf] = clone(value);
      }
      return;
    }
    const parts = path.split(".");
    let root = state.world;
    const roots = { character: state.character, player: state.character, world: state.world, crisis: contextualCrisis() || {}, region: state.world.region, location: state.world.locationFacts?.[state.character.location] || state.world.locations?.[state.character.location] || {}, promotion: state.world.promotion || {}, promotionInstance: state.world.promotion || {}, contest: state.world.contest || {}, participant: state.world.npcRecords[state.world.participant] || {}, witness: state.world.npcRecords[state.world.witness] || {}, person: state.world.npcRecords[state.world.requestingPerson] || {}, medicalCase: state.world.medicalCase || {}, repairTask: state.world.repairTask || {}, demandInstance: state.world.demandInstance || {}, affectedBatch: activeCrisis()?.affectedBatch || {} };
    if (parts[0] in roots) root = roots[parts.shift()];
    if (!parts.length) return;
    const leaf = parts.pop();
    for (const key of parts) root = root[key] ||= {};
    if (delta != null) root[leaf] = Number(root[leaf] || 0) + Number(delta);
    else root[leaf] = clone(value);
    if (path === "crisis.status") {
      const crisis = contextualCrisis();
      if (crisis?.family) state.world.worldOutcomes[crisis.family] = resolveValue(value);
    }
  }

  function resolveValue(value) {
    if (value && typeof value === "object" && value.ref) return resolvePath(value.ref);
    if (value && typeof value === "object" && value.from) return resolvePath(value.from);
    if (Array.isArray(value)) return value.map(resolveValue);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, resolveValue(nested)]));
    return value;
  }

  function applyEffects(effects, eventId, optionId = null) {
    for (const effect of effects || []) {
      const amount = resolveValue(effect.amount);
      switch (effect.op) {
        case "set_fact": {
          const value = resolveValue(effect.value);
          if (effect.fact === "r4_fact_learned_skill") {
            const skill = value?.skill;
            if (skill && !state.character.learnedSkills.includes(skill)) state.character.learnedSkills.push(skill);
            if (skill) {
              state.character.skills[skill] = { stage: value.stage || 1, learnedDay: state.worldDay, sourceId: eventId };
              state.character.skillRecords ||= {};
              state.character.skillRecords[skill] = { skillId: skill, lifeIndex: Number(state.character.lifeIndex || 1), sourceId: eventId, sourceEventId: eventId, learnedDay: state.worldDay };
              if (skill === "r4_skill_dao02") state.character.proficiency[skill] = Math.max(Number(state.character.proficiency[skill] || 0), Number(pack.caps.dao02MinimumProficiency || 0));
            }
          } else if (effect.fact === "r4_fact_character_knowledge") {
            const key = value?.key || "unknown";
            state.character.knowledge[key] = { level: value?.level || "heard", sourceId: eventId, acquiredDay: state.worldDay, characterId: state.character.id };
          } else {
            state.character.facts ||= {};
            state.character.facts[effect.fact] = value;
          }
          break;
        }
        case "add_resource": {
          const key = effect.resource;
          const targetKey = key === "wealth" ? "cashWen" : key;
          // Only this verified legacy R4 wage is still stored as old abstract
          // wealth. Other numeric effects in current/future content are Wen;
          // quote refs are already Wen and must never be scaled again.
          const isLegacyWorkWage = key === "wealth"
            && eventId === "r4_daily_entrust"
            && optionId === "accept_and_fulfill";
          const delta = isLegacyWorkWage && typeof effect.amount === "number" && effect.amount === 2
            ? Number(amount || 0) * 100
            : Number(amount || 0);
          state.character[targetKey] = Math.max(0, Number(state.character[targetKey] || 0) + delta);
          break;
        }
        case "add_item": {
          const itemId = resolveValue(effect.item);
          const count = Number(resolveValue(effect.quantity) || 0);
          state.character.inventory[itemId] = Number(state.character.inventory[itemId] || 0) + count;
          state.character.inventoryLedger[itemId] = [...(state.character.inventoryLedger[itemId] || []), { quantity: count, acquiredDay: state.worldDay, ownership: effect.ownership || "owned", sourceId: eventId }];
          break;
        }
        case "remove_item": {
          if (effect.reservedAtStart === true) break;
          const itemId = resolveValue(effect.item);
          const count = Number(resolveValue(effect.quantity) || 0);
          if (Number(state.character.inventory[itemId] || 0) < count) throw new Error(`insufficient_inventory:${itemId}`);
          const lots = state.character.inventoryLedger[itemId] || [];
          const lotTotal = lots.reduce((sum, lot) => sum + Math.max(0, Number(lot.quantity || 0)), 0);
          if (lotTotal !== Number(state.character.inventory[itemId] || 0) || lotTotal < count) throw new Error(`inventory_lot_ledger_inconsistent:${itemId}`);
          let remaining = count;
          for (const lot of lots) {
            if (remaining <= 0) break;
            const removed = Math.min(Math.max(0, Number(lot.quantity || 0)), remaining);
            lot.quantity -= removed; remaining -= removed;
          }
          state.character.inventory[itemId] -= count;
          break;
        }
        case "add_knowledge": {
          const key = effect.key || effect.fact;
          const previous = state.character.knowledge[key];
          const level = previous && KNOWLEDGE_LEVELS[previous.level] > KNOWLEDGE_LEVELS[effect.level] ? previous.level : effect.level;
          state.character.knowledge[key] = { level, sourceId: eventId, acquiredDay: state.worldDay, characterId: state.character.id };
          break;
        }
        case "set_world": {
          const value = resolveValue(effect.value);
          setPath(effect.field, value, effect.delta != null ? resolveValue(effect.delta) : null);
          if (effect.field === "medicalCase.exists" && value === true) {
            state.character.knowledge.medicalCase = { level: "evidence", sourceId: eventId, acquiredDay: state.worldDay, characterId: state.character.id };
          }
          if (effect.field === "crisis.participantAccepted" && value === true) {
            const crisis = contextualCrisis();
            const participant = state.world.npcRecords[crisis?.participantId];
            if (crisis?.family === "resonance" && participant) {
              participant.markDay = state.worldDay;
              participant.symptomDeadline = state.worldDay + 180;
              participant.contactDeadline = state.worldDay + 90;
              participant.symptomOpen = false;
            }
          }
          break;
        }
        case "set_person": {
          const id = typeof effect.person === "string" ? effect.person : resolveValue(effect.person);
          state.world.npcRecords[id] ||= {};
          state.world.npcRecords[id][effect.field] = resolveValue(effect.value);
          break;
        }
        case "add_crisis_allies": {
          const crisis = activeCrisis();
          if (!crisis) throw new Error(`crisis_context_required:${eventId}`);
          const raw = resolveValue(effect.members);
          const members = Array.isArray(raw) ? raw : [raw];
          state.character.crisisAllyCommitments ||= {};
          const commitments = state.character.crisisAllyCommitments[crisis.id] ||= [];
          for (const member of members.filter(Boolean)) if (!commitments.includes(member)) commitments.push(member);
          break;
        }
        case "enqueue": enqueue(effect.eventId || effect.event || effect.id, effect.day ?? state.worldDay); break;
        case "close_instance": {
          const instance = state.world.crisisInstances.find((item) => !item.closed);
          if (instance) { instance.closed = true; instance.status = resolveValue(effect.status) || "closed"; instance.closedDay = state.worldDay; }
          break;
        }
        case "move_character": {
          const destination = resolveValue(effect.to);
          if (destination && state.character.location === state.character.originLocation && destination !== state.character.originLocation) {
            state.character.leftOriginDay ??= state.worldDay;
          }
          state.character.location = destination || state.character.location;
          break;
        }
        case "record_cause": appendCause(effect.cause || eventId, eventId); break;
        case "noop": break;
        default: throw new Error(`unsupported_effect:${effect.op}`);
      }
    }
  }

  function appendCause(cause, sourceId, change = {}) {
    state.causeLog.push({ id: `cause-${state.causeLog.length + 1}`, worldDay: state.worldDay, sourceId, cause, characterId: state.character.id, generation: state.character.generation, change: clone(change) });
  }

  function initializeR6CourierWorld() {
    if (realmSourceAdapter !== "r5" || state.world.r6CourierInitializationReceipt) return;
    state.world.r6CourierLedgers ||= {};
    state.world.r6CourierParcels ||= [];
    state.world.r6CourierContracts ||= [];
    state.world.r6CourierReceipts ||= {};
    state.world.r6CourierCycles ||= {};
    state.world.r6CourierDuty ||= { runnerId: "r6_npc_willow_courier_runner", status: "idle", cycleIndex: null, phase: "willow" };
    state.world.r6WeatherMasterSeed32 ??= (Number.parseInt(String(state.worldId || "").replace(/^world-/, ""), 36) >>> 0) || (Number(state.rngState) >>> 0) || 1;
    state.world.r6WeatherFacts ||= {};
    state.world.r6WeatherStreaks ||= {};
    state.world.r6FloodClosures ||= {};
    state.world.r6WeatherSeedMigrationReceipt ||= { id: "r6_receipt_weather_seed_migration", status: "persisted", seed32: state.world.r6WeatherMasterSeed32 };
    state.world.npcRecords.r6_npc_willow_apothecary ||= { id: "r6_npc_willow_apothecary", alive: true, locationId: "r4_loc_willow_market", onDuty: true, role: "apothecary" };
    state.world.npcRecords.r6_npc_willow_courier_runner ||= { id: "r6_npc_willow_courier_runner", alive: true, locationId: "r4_loc_willow_market", onDuty: false, role: "courier_runner" };
    state.world.npcRecords.r6_npc_mirror_recipient ||= { id: "r6_npc_mirror_recipient", alive: true, locationId: "r4_loc_mirror_stage", onDuty: true, role: "medicine_recipient" };
    const willowStock = state.world.marketStock?.r4_loc_willow_market;
    const initialStock = pack.market.locations?.r4_loc_willow_market?.initialStock;
    const untouchedMarket = willowStock && initialStock && Object.entries(initialStock).every(([id, count]) => Number(willowStock[id] || 0) === Number(count))
      && !(state.world.marketTradeLedger || []).length;
    if (untouchedMarket && Number(willowStock.r4_item_powder || 0) >= 2) {
      willowStock.r4_item_powder -= 2;
      state.world.r6CourierLedgers.issuerInventory = { id: "r6_ledger_willow_apothecary_powder_inventory", itemId: "r4_item_powder", quantity: 2 };
      state.world.r6CourierLedgers.workingCash = { id: "r6_ledger_willow_apothecary_working_cash", balanceWen: 400 };
      state.world.r6CourierLedgers.escrow = { id: "r6_ledger_willow_courier_reward_escrow", balanceWen: 0 };
      state.world.r6CourierInitializationReceipt = { id: "r6_receipt_willow_apothecary_seed_capital", status: "committed", day: state.worldDay, openingCashWen: 400, powderUnitsTransferred: 2, marketPowderBefore: Number(willowStock.r4_item_powder) + 2, marketPowderAfter: Number(willowStock.r4_item_powder), source: "registered_world_initialization_reallocation" };
    } else {
      state.world.r6CourierInitializationReceipt = { id: "r6_receipt_willow_apothecary_seed_capital", status: "withheld_unverified_opening_source", day: state.worldDay, reason: "market_stock_not_pristine_or_powder_unavailable", openingCashWen: 0, powderUnitsTransferred: 0 };
      state.world.r6CourierLedgers.issuerInventory ||= { id: "r6_ledger_willow_apothecary_powder_inventory", itemId: "r4_item_powder", quantity: 0 };
      state.world.r6CourierLedgers.workingCash ||= { id: "r6_ledger_willow_apothecary_working_cash", balanceWen: 0 };
      state.world.r6CourierLedgers.escrow ||= { id: "r6_ledger_willow_courier_reward_escrow", balanceWen: 0 };
    }
    processR6CourierDay(state.worldDay);
  }

  function processR6CourierDay(day) {
    if (realmSourceAdapter !== "r5" || !state.world.r6CourierLedgers?.workingCash) return;
    const cycleIndex = Math.floor(day / 75);
    const cycleStart = cycleIndex * 75;
    const previous = state.world.r6CourierCycles[String(cycleIndex - 1)];
    if (cycleIndex > 0 && previous && day >= previous.endWorldDayExclusive && !previous.returnReceipt) {
      const runner = state.world.npcRecords.r6_npc_willow_courier_runner;
      runner.locationId = "r4_loc_willow_market"; runner.routeStatus = "returned";
      const returned = [];
      for (const contractId of previous.contractIds) {
        const contract = state.world.r6CourierContracts.find((row) => row.contractId === contractId);
        if (!contract || ["accepted", "delivered", "expired", "returned"].includes(contract.status)) continue;
        const receiptId = `${previous.publishReceiptId}:runner-return:${contractId}`;
        if (!state.world.r6CourierReceipts[receiptId]) {
          state.world.r6CourierLedgers.escrow.balanceWen -= 200;
          state.world.r6CourierLedgers.workingCash.balanceWen += 200;
          state.world.r6CourierLedgers.issuerInventory.quantity += 1;
          const parcel = state.world.r6CourierParcels.find((row) => row.contractId === contractId);
          if (parcel) { parcel.status = "returned_to_issuer"; parcel.holderId = contract.issuerId; }
          contract.status = "returned"; contract.returnReceiptId = receiptId;
          state.world.r6CourierReceipts[receiptId] = { id: receiptId, status: "signed", contractId, day, cashReturnedWen: 200, powderReturned: 1, idempotencyKey: receiptId };
          returned.push(receiptId);
        }
      }
      previous.returnReceipt = { id: `${previous.publishReceiptId}:runner-return`, status: "signed", day, returnedContractReceipts: returned };
      previous.status = "returned";
      state.world.r6CourierDuty = { runnerId: runner.id, cycleIndex: cycleIndex - 1, status: "returned", phase: "willow", receiptId: previous.returnReceipt.id, day };
    }
    if (cycleIndex > 0 && previous && previous.returnReceipt?.status !== "signed") return;
    let cycle = state.world.r6CourierCycles[String(cycleIndex)];
    // A new world can begin mid-cycle (the configured scenario starts at day 5760).
    // Materialize that cycle on first observation so its runner can still return
    // on the registered absolute schedule instead of silently skipping a cycle.
    if (!cycle && day >= cycleStart) {
      cycle = { cycleIndex, openWorldDay: cycleStart, offerEndWorldDayExclusive: cycleStart + 30, endWorldDayExclusive: cycleStart + 75, status: "open", publishReceiptId: `r6_receipt_courier_publish:${cycleIndex}`, contractIds: [] };
      state.world.r6CourierCycles[String(cycleIndex)] = cycle;
      const cash = state.world.r6CourierLedgers.workingCash;
      const inventory = state.world.r6CourierLedgers.issuerInventory;
      for (let slot = 1; slot <= 2; slot += 1) {
        if (Number(cash.balanceWen) < 200 || Number(inventory.quantity) < 1) break;
        const contractId = `r6_courier_contract:${cycleIndex}:${String(slot).padStart(2, "0")}`;
        const parcelInstanceId = `r6_item_sealed_medicine_parcel:${contractId}`;
        cash.balanceWen -= 200;
        state.world.r6CourierLedgers.escrow.balanceWen += 200;
        inventory.quantity -= 1;
        const contract = { contractId, sourceId: "r6_source_courier_board", causeId: `r6_fact_delivery_contract:${contractId}`, cycleIndex, slot, issuerId: "r6_npc_willow_apothecary", runnerId: "r6_npc_willow_courier_runner", parcelInstanceId, namedRecipientId: "r6_npc_mirror_recipient", routeId: "r4_loc_willow_market>r4_loc_mirror_stage", openWorldDay: cycleStart, offerEndWorldDayExclusive: cycleStart + 30, status: "published", decision: "undecided", escrowWen: 200, idempotencyKey: `${state.worldId}:${contractId}` };
        state.world.r6CourierContracts.push(contract);
        state.world.r6CourierParcels.push({ parcelInstanceId, contractId, itemId: "r4_item_powder", ownerId: "r6_npc_willow_apothecary", holderId: "r6_npc_willow_courier_runner", status: "aboard_runner", nontradable: true, sourceReceiptId: state.world.r6CourierInitializationReceipt?.id });
        cycle.contractIds.push(contractId);
      }
      cycle.publishReceipt = { id: cycle.publishReceiptId, status: "published", day, contractIds: clone(cycle.contractIds), fundedSlots: cycle.contractIds.length };
      appendCause("r6_courier_cycle_published", "r6_source_courier_board", { receiptId: cycle.publishReceiptId, fundedSlots: cycle.contractIds.length });
    }
    if (!cycle) return;
    const elapsed = day - cycleStart;
    const runner = state.world.npcRecords.r6_npc_willow_courier_runner;
    if (elapsed < 15) { runner.locationId = "r4_loc_willow_market"; runner.routeStatus = "outbound"; cycle.runnerPhase = "outbound_to_waystop"; }
    else if (elapsed < 30) { runner.locationId = "r6_site_mirror_post"; runner.routeStatus = "waiting"; cycle.runnerPhase = "waiting_at_waystop"; }
    else if (elapsed < 45) { runner.locationId = "r4_loc_willow_market>r4_loc_mirror_stage"; runner.routeStatus = "outbound"; cycle.runnerPhase = "outbound_to_mirror"; }
    else if (elapsed < 75) { runner.locationId = "r4_loc_mirror_stage>r4_loc_willow_market"; runner.routeStatus = "returning"; cycle.runnerPhase = "returning_to_willow"; }
    else {
      runner.locationId = "r4_loc_willow_market"; runner.routeStatus = "returned"; cycle.runnerPhase = "returned";
      if (!cycle.returnReceipt) {
        const returned = [];
        for (const contractId of cycle.contractIds) {
          const contract = state.world.r6CourierContracts.find((row) => row.contractId === contractId);
          if (!contract || ["accepted", "delivered", "expired", "returned"].includes(contract.status)) continue;
          const receiptId = `${cycle.publishReceiptId}:runner-return:${contractId}`;
          if (state.world.r6CourierReceipts[receiptId]) continue;
          state.world.r6CourierLedgers.escrow.balanceWen -= 200;
          state.world.r6CourierLedgers.workingCash.balanceWen += 200;
          state.world.r6CourierLedgers.issuerInventory.quantity += 1;
          const parcel = state.world.r6CourierParcels.find((row) => row.contractId === contractId);
          if (parcel) { parcel.status = "returned_to_issuer"; parcel.holderId = contract.issuerId; }
          contract.status = "returned"; contract.returnReceiptId = receiptId;
          state.world.r6CourierReceipts[receiptId] = { id: receiptId, status: "signed", contractId, day, cashReturnedWen: 200, powderReturned: 1, idempotencyKey: receiptId };
          returned.push(receiptId);
        }
        cycle.returnReceipt = { id: `${cycle.publishReceiptId}:runner-return`, status: "signed", day, returnedContractReceipts: returned };
        cycle.status = "returned";
        state.world.r6CourierDuty = { runnerId: runner.id, cycleIndex, status: "returned", phase: "willow", receiptId: cycle.returnReceipt.id, day };
      }
    }
    for (const contract of state.world.r6CourierContracts) {
      if (contract.cycleIndex === cycleIndex && contract.status === "accepted" && day > contract.dueWorldDay) {
        const receiptId = `r6_receipt_courier_timeout:${contract.contractId}`;
        if (!state.world.r6CourierReceipts[receiptId]) {
          state.world.r6CourierLedgers.escrow.balanceWen -= 200;
          state.world.r6CourierLedgers.workingCash.balanceWen += 200;
          contract.status = "expired"; contract.timeoutReceiptId = receiptId;
          const parcel = state.world.r6CourierParcels.find((row) => row.contractId === contract.contractId);
          if (parcel) { parcel.status = "return_cargo_with_character"; parcel.holderId = state.character.id; }
          state.world.r6CourierReceipts[receiptId] = { id: receiptId, status: "committed", contractId: contract.contractId, day, cashReturnedWen: 200, parcelDisposition: "held_nontradable_pending_physical_return", idempotencyKey: receiptId };
        }
      }
    }
    state.world.r6CourierDuty ||= {};
    Object.assign(state.world.r6CourierDuty, { runnerId: runner.id, cycleIndex, phase: cycle.runnerPhase, status: cycle.status });
  }

  function processR6RouteWeatherDay(day) {
    if (realmSourceAdapter !== "r5") return null;
    const routeId = "r4_loc_willow_market>r4_loc_mirror_stage";
    const factKey = `${routeId}:${day}`;
    let fact = state.world.r6WeatherFacts[factKey];
    if (!fact) {
      fact = { id: `r6_fact_route_weather_day:${routeId}:${day}`, ...r6RouteWeather(state.world.r6WeatherMasterSeed32, routeId, day), source: "persisted_route_day_weather" };
      state.world.r6WeatherFacts[factKey] = fact;
    }
    let streak = state.world.r6WeatherStreaks[routeId] ||= { armed: true, lastHighWorldDay: null, rearmDryDay: null };
    const live = state.world.r6FloodClosures[routeId];
    if (live && day >= live.endWorldDayExclusive) { live.status = "expired"; live.expiredDay = day; }
    if (live?.status === "active") {
      if (fact.rainLevel <= 1) streak.rearmDryDay = day;
      const trip = state.inFlightTransaction?.r6TravelTransaction;
      if (state.inFlightTransaction?.actionId === "r4_action_travel" && trip?.routeId === "r6_route_willow_mirror") {
        state.world.dailyBusinessSources.roadmarker = { id: live.id, eventId: "r4_ev_daily_roadmarker", causeId: live.causeId, routeId, ownerCharacterId: state.character.id, createdDay: live.startWorldDay, expiresDay: live.endWorldDayExclusive - 1, status: "open", closureId: live.id, provenance: { producer: "r6_weather_generator", status: "verified" } };
        enqueue("r4_ev_daily_roadmarker", day, live.id);
      }
      return live;
    }
    if (!streak.armed && streak.rearmDryDay != null && day > Number(streak.rearmDryDay)) streak.armed = true;
    const consecutiveHigh = fact.rainLevel >= 2 && streak.lastHighWorldDay === day - 1;
    if (fact.rainLevel >= 2) streak.lastHighWorldDay = day; else { streak.lastHighWorldDay = null; streak.rearmDryDay = day; }
    if (streak.armed && consecutiveHigh) {
      const closure = { id: `r6_fact_route_flood_closure:${routeId}:${day}`, routeId, triggerWorldDay: day, startWorldDay: day, endWorldDayExclusive: day + 3, status: "active", causeId: `r6_fact_route_flood_closure:${routeId}:${day}`, eventId: "r4_ev_daily_roadmarker", receiptId: `r6_receipt_flood_closure:${routeId}:${day}`, provenance: "persisted_two_day_weather" };
      state.world.r6FloodClosures[routeId] = closure;
      streak.armed = false; streak.lastHighWorldDay = null;
      state.world.dailyBusinessSources.roadmarker = { id: closure.id, eventId: closure.eventId, causeId: closure.causeId, routeId, createdDay: day, expiresDay: day + 2, status: "open", closureId: closure.id, provenance: { producer: "r6_weather_generator", status: "verified" } };
      state.world.r6WeatherReceipts ||= {};
      state.world.r6WeatherReceipts[closure.receiptId] ||= { id: closure.receiptId, status: "committed", closureId: closure.id, causeId: closure.causeId, worldDay: day, idempotencyKey: closure.receiptId };
      appendCause("r6_route_flood_closure_created", closure.causeId, { routeId, startWorldDay: day, endWorldDayExclusive: day + 3, weatherFactIds: [`${routeId}:${day - 1}`, factKey] });
      const trip = state.inFlightTransaction?.r6TravelTransaction;
      if (state.inFlightTransaction?.actionId === "r4_action_travel" && trip?.routeId === "r6_route_willow_mirror") {
        state.world.dailyBusinessSources.roadmarker = { id: closure.id, eventId: "r4_ev_daily_roadmarker", causeId: closure.causeId, routeId, ownerCharacterId: state.character.id, createdDay: day, expiresDay: day + 2, status: "open", closureId: closure.id, provenance: { producer: "r6_weather_generator", status: "verified" } };
        enqueue("r4_ev_daily_roadmarker", day, closure.id);
      }
      return closure;
    }
    return null;
  }

  function openR6CourierEncounter(day) {
    const trip = state.inFlightTransaction?.r6TravelTransaction;
    if (!trip || trip.routeId !== "r6_route_willow_mirror") return null;
    const cycleIndex = Math.floor(day / 75);
    const cycle = state.world.r6CourierCycles[String(cycleIndex)];
    if (!cycle || day < cycle.openWorldDay + 15 || day >= cycle.offerEndWorldDayExclusive) return null;
    const runner = state.world.npcRecords.r6_npc_willow_courier_runner;
    const expectedMidpoint = Number(trip.startedDay ?? state.inFlightTransaction.startedDay) + Math.ceil(Number(trip.daysTotal) / 2);
    if (day !== expectedMidpoint || runner?.locationId !== "r6_site_mirror_post" || runner.routeStatus !== "waiting") return null;
    const contract = cycle.contractIds.map((id) => state.world.r6CourierContracts.find((row) => row.contractId === id)).find((row) => row?.status === "published" && day < row.offerEndWorldDayExclusive);
    if (!contract) return null;
    const source = { id: `${state.worldId}:r4_ev_daily_courier:${contract.contractId}:${day}`, eventId: "r4_ev_daily_courier", sourceId: "r6_source_courier_board", causeId: contract.causeId, contractId: contract.contractId, ownerCharacterId: state.character.id, routeId: contract.routeId, locationId: "r6_site_mirror_post", createdDay: day, expiresDay: contract.offerEndWorldDayExclusive - 1, status: "open", runnerId: runner.id, parcelInstanceId: contract.parcelInstanceId, provenance: { producer: "funded_registered_courier_board", status: "verified" } };
    state.world.dailyBusinessSources.courier = source;
    enqueue("r4_ev_daily_courier", day, contract.causeId);
    return source;
  }

  function isDailyCourierSourceLive() {
    const source = state.world.dailyBusinessSources?.courier;
    const contract = state.world.r6CourierContracts?.find((row) => row.contractId === source?.contractId);
    const runner = state.world.npcRecords?.[source?.runnerId];
    return Boolean(source?.status === "open" && source.eventId === "r4_ev_daily_courier" && source.ownerCharacterId === state.character.id
      && source.provenance?.status === "verified" && state.worldDay >= contract?.openWorldDay && state.worldDay < contract?.offerEndWorldDayExclusive
      && contract?.status === "published" && runner?.locationId === "r6_site_mirror_post" && runner.routeStatus === "waiting");
  }

  function deliverR6CourierContract(contractId) {
    const contract = state.world.r6CourierContracts?.find((row) => row.contractId === contractId);
    if (!contract) return { error: "courier_recipient_or_accepted_parcel_unavailable" };
    const receiptId = `r6_receipt_courier_reward:${contract.contractId}`;
    if (state.world.r6CourierReceipts[receiptId]) return { kind: "duplicate_suppressed", receipt: clone(state.world.r6CourierReceipts[receiptId]) };
    const parcel = state.world.r6CourierParcels?.find((row) => row.contractId === contractId);
    const recipient = state.world.npcRecords?.r6_npc_mirror_recipient;
    if (contract.status !== "accepted" || state.character.location !== "r4_loc_mirror_stage" || recipient?.alive !== true || recipient.locationId !== state.character.location) return { error: "courier_recipient_or_accepted_parcel_unavailable" };
    if (state.worldDay > contract.dueWorldDay || (Number.isSafeInteger(contract.dueAtTickExclusive) && state.worldTick >= contract.dueAtTickExclusive)) return { error: "courier_delivery_deadline_passed" };
    if (!parcel || parcel.status !== "bound_to_character" || parcel.holderId !== state.character.id) return { error: "courier_parcel_receipt_missing" };
    const escrow = state.world.r6CourierLedgers.escrow;
    if (Number(escrow.balanceWen) < 200) return { error: "courier_reward_escrow_insufficient" };
    escrow.balanceWen -= 200;
    state.character.cashWen = Number(state.character.cashWen || 0) + 200;
    parcel.status = "delivered_to_recipient"; parcel.holderId = recipient.id;
    contract.status = "delivered"; contract.settlementReceiptId = receiptId;
    const receipt = { id: receiptId, status: "signed", contractId, causeId: contract.causeId, payerLedgerId: "r6_ledger_willow_courier_reward_escrow", recipientId: state.character.id, amountWen: 200, rewardPoints: 0, day: state.worldDay, parcelInstanceId: parcel.parcelInstanceId, itemConsumed: true, idempotencyKey: receiptId };
    state.world.r6CourierReceipts[receiptId] = receipt;
    appendCause("r6_courier_delivery_settled", receiptId, { amountWen: 200, contractId, parcelInstanceId: parcel.parcelInstanceId });
    return { kind: "result", receipt: clone(receipt), snapshot: snapshot() };
  }

  function returnR6CourierPackage(contractId) {
    const contract = state.world.r6CourierContracts?.find((row) => row.contractId === contractId);
    const parcel = state.world.r6CourierParcels?.find((row) => row.contractId === contractId);
    if (!contract || contract.status !== "expired" || state.character.location !== "r4_loc_willow_market" || !parcel || parcel.status !== "return_cargo_with_character" || parcel.holderId !== state.character.id) return { error: "physical_courier_return_not_available" };
    const receiptId = `r6_receipt_courier_parcel_return:${contract.contractId}`;
    if (state.world.r6CourierReceipts[receiptId]) return { kind: "duplicate_suppressed", receipt: clone(state.world.r6CourierReceipts[receiptId]) };
    state.world.r6CourierLedgers.issuerInventory.quantity += 1;
    parcel.status = "returned_to_issuer"; parcel.holderId = contract.issuerId; parcel.returnedDay = state.worldDay;
    contract.parcelReturnReceiptId = receiptId;
    const receipt = { id: receiptId, status: "signed", contractId, parcelInstanceId: parcel.parcelInstanceId, itemId: "r4_item_powder", quantity: 1, day: state.worldDay, idempotencyKey: receiptId };
    state.world.r6CourierReceipts[receiptId] = receipt;
    appendCause("r6_courier_parcel_physically_returned", receiptId, { contractId, parcelInstanceId: parcel.parcelInstanceId });
    return { kind: "result", receipt: clone(receipt), snapshot: snapshot() };
  }

  function waitAtR6FloodClosure() {
    const tx = state.inFlightTransaction;
    if (tx?.actionId !== "r4_action_travel" || tx.pauseReason !== "r6_flood_wait") return { error: "flood_wait_not_active" };
    state.inFlightTransaction = null;
    const before = state.worldDay;
    advanceDays(1);
    state.inFlightTransaction = tx;
    if (state.worldDay === before) return { error: "flood_wait_day_not_advanced" };
    const closure = state.world.r6FloodClosures?.["r4_loc_willow_market>r4_loc_mirror_stage"];
    if (closure?.status !== "active") tx.pauseReason = "r6_flood_resume";
    return { kind: "progress", worldDay: state.worldDay, closure: clone(closure || null), transaction: clone(tx), snapshot: snapshot() };
  }

  function resumeR6FloodRoute() {
    const tx = state.inFlightTransaction;
    if (tx?.actionId !== "r4_action_travel" || tx.pauseReason !== "r6_flood_resume") return { error: "flood_route_not_ready" };
    tx.pauseReason = null; tx.pauseEventId = null;
    return { kind: "progress", transaction: clone(tx), snapshot: snapshot() };
  }

  function enqueue(eventId, day = state.worldDay, requestedInstanceId = null) {
    if (!eventById.has(eventId)) throw new Error(`unknown_event:${eventId}`);
    const event = eventById.get(eventId);
    const family = Object.entries(pack.crises).find(([, plan]) => plan.eventIds?.includes(eventId))?.[0];
    const instanceId = requestedInstanceId || scopeInstanceId(event);
    const key = recordKey(instanceId, eventId, 0);
    const claimState = state.eventClaimLedger[key]?.state;
    if (claimState === "completed" || claimState === "expired") return false;
    if (state.queue.some((entry) => entry.eventId === eventId && entry.instanceId === instanceId)) return true;
    state.queue.push({ eventId, instanceId, day: Math.max(state.worldDay, Math.floor(Number(day) || 0)), queuedDay: state.worldDay });
    state.world.worldEventQueue = clone(state.queue);
    return true;
  }

  function eventAvailable(event) {
    return withEventContext(event, () => eventAvailableInContext(event));
  }

  function currentRealmProgressionProof() {
    const lifeIndex = Number(state.character.lifeIndex || 1);
    if (realmSourceAdapter === "r5") {
      const current = state.facts?.r5_fact_progression_current || state.r5LifeLedger?.progression?.current;
      const attained = state.facts?.r5_fact_progression_attainment || state.r5LifeLedger?.progression?.attainment || [];
      if (!current || Number(current.lifeIndex) !== lifeIndex || current.source === "origin" || !current.sourceId) return null;
      return attained.find((row) => Number(row.lifeIndex) === lifeIndex && row.status === "success"
        && row.eventId === "r5_daily_breakthrough" && row.causeId === current.sourceId
        && row.sourceId === current.sourceId) || null;
    }
    const current = state.facts?.r4_fact_realm_current || {};
    if (Number(current.lifeIndex) !== lifeIndex || current.source !== "breakthrough" || !current.sourceId) return null;
    return (state.character.realmAttainment || []).find((row) => Number(row.lifeIndex) === lifeIndex
      && row.causeId === current.sourceId && row.eventId === "r4_daily_breakthrough"
      && String(row.outcomeId || "").endsWith("_success")) || null;
  }

  function nextR4Realm() {
    const realms = (pack.realmRegistry || []).map((row) => row.id);
    const current = state.facts?.r4_fact_realm_current?.realmId || "r4_realm_mortal";
    const index = realms.indexOf(current);
    return index >= 0 ? realms[index + 1] || null : null;
  }

  function validateR4BreakthroughAttempt() {
    const rules = pack.progressionRules || {};
    const target = nextR4Realm();
    if (!target) return "realm_at_registered_cap";
    if (!state.character.learnedSkills?.length) return "cultivation_skill_missing";
    if (Number(state.character.health || 0) < Number(rules.minimumBreakthroughHealth || 0)) return "body_health_below_threshold";
    if (Number(state.worldDay - Number(state.character.birthDay || 0)) < Number(rules.operableAgeDays || 0)) return "body_not_operable_age";
    if (Number(state.character.power || 0) < Number(rules.minimumBreakthroughPowerByTargetRealm?.[target] || Infinity)) return "breakthrough_power_below_threshold";
    return null;
  }

  function settleR4Breakthrough(outcome, option, tx) {
    if (tx.eventId !== "r4_daily_breakthrough" || tx.optionId !== "attempt_now") return;
    const rules = pack.progressionRules;
    const target = nextR4Realm();
    if (!target) throw new Error("breakthrough_target_realm_missing_at_commit");
    const lifeIndex = Number(state.character.lifeIndex || 1);
    const success = outcome === "success";
    const causeId = `breakthrough:${lifeIndex}:${target}:${tx.transactionId}`;
    const outcomeId = option.outcomeIds?.[success ? "success" : "failure"];
    if (success) {
      const attainment = { lifeIndex, realmId: target, eventId: tx.eventId, choiceId: tx.optionId, outcomeId, day: state.worldDay, causeId };
      state.character.realmAttainment ||= [];
      state.character.realmAttainment.push(clone(attainment));
      state.character.realmId = target;
      state.character.highestAttainedRealmId = target;
      state.facts ||= {};
      state.facts.r4_fact_realm_attainment ||= [];
      state.facts.r4_fact_realm_attainment.push(clone(attainment));
      state.facts.r4_fact_realm_current = { lifeIndex, realmId: target, source: "breakthrough", sourceId: causeId };
      const years = Number(rules.lifespanYearsByRealm?.[target]);
      const factor = Number(state.character.bodyLifeFactorBasisPoints || rules.bodyLifeFactorBasisPoints || 10000);
      const newDeathDay = Number(state.character.birthDay || 0) + Math.floor(years * Number(rules.daysPerYear || 360) * factor / Number(rules.bodyLifeFactorBasisPoints || 10000));
      if (Number.isFinite(newDeathDay) && (state.character.deathDay == null || newDeathDay > state.character.deathDay)) {
        state.character.deathDay = newDeathDay;
        state.facts.r4_fact_life_clock = { ...(state.facts.r4_fact_life_clock || {}), deathDay: newDeathDay, causeId };
      }
    } else {
      state.character.health = Math.max(0, Number(state.character.health || 0) - Number(rules.failureHealthLoss || 0));
    }
    (state.character.breakthroughReceipts ||= []).push({ lifeIndex, realmId: target, eventId: tx.eventId, choiceId: tx.optionId, outcomeId, outcome: success ? "success" : "failure", day: state.worldDay, causeId, transactionId: tx.transactionId });
  }

  function realmSourceFor(event) {
    const path = event?.runtimeBinding?.sourcePath;
    return path ? path.split(".").reduce((value, key) => value?.[key], state) : null;
  }

  function realmReservationMatches(event, source) {
    const pending = event?.runtimeBinding?.handler === "realm_core_craft" ? state.world.pendingRealmCraft : state.world.pendingRealmChoice;
    if (source?.status !== "open" || !pending || pending.eventId !== event?.id || pending.transactionId !== source?.reservedTransactionId
      || pending.sourceId !== source?.id || pending.actorId !== state.character.id || pending.lifeIndex !== Number(state.character.lifeIndex || 1)
      || !pending.actionTransactionId || pending.startedDay > Number(source?.expiresDay ?? pending.startedDay)) return false;
    const txId = pending.actionTransactionId;
    const targetActionId = event.runtimeBinding?.handler === "realm_core_craft" ? "r4_action_alchemy" : "r4_action_practice";
    const ledger = state.actionTransactionLedger?.[txId];
    const live = state.inFlightTransaction?.transactionId === txId && state.inFlightTransaction.kind === "action"
      && state.inFlightTransaction.actionId === targetActionId && ledger?.status === "running";
    const completed = ledger?.status === "completed" && state.character.alive
      && state.character.actionLog?.some((row) => row.transactionId === txId && row.actionId === targetActionId && (targetActionId !== "r4_action_practice" || row.outcome === "success"));
    return live || completed;
  }

  function validateRealmEventSource(event) {
    const binding = event.runtimeBinding || {};
    const source = realmSourceFor(event);
    const proof = currentRealmProgressionProof();
    const lifeIndex = Number(state.character.lifeIndex || 1);
    const day = Number(state.worldDay || 0);
    if (!proof) return { error: "current_life_successful_progression_required" };
    if (realmSourceAdapter !== "r5") {
      const order = Object.keys(pack.progressionRules?.lifespanYearsByRealm || {});
      const current = state.facts?.r4_fact_realm_current?.realmId || "r4_realm_mortal";
      if (!order.includes(current) || order.indexOf(current) < order.indexOf(binding.minimumRealmId)) return { error: "realm_requirement_not_met" };
    }
    const reserved = realmReservationMatches(event, source);
    if (!source || (source.status !== "open" && !reserved)) return { error: "realm_service_record_missing" };
    if (source.eventId !== event.id || source.lifeIndex !== lifeIndex || source.worldId !== (state.world.id || state.worldId)) return { error: "realm_source_event_life_or_world_mismatch" };
    const evidence = source.evidence || {};
    const evidenceProgressionCauseId = Array.isArray(evidence)
      ? (evidence.every((row) => row.progressionCauseId === proof.causeId) ? proof.causeId : null)
      : evidence.progressionCauseId;
    if (source.provenance?.producer !== "typed_realm_action" || source.provenance?.characterId !== state.character.id
      || source.provenance?.progressionCauseId !== proof.causeId || evidenceProgressionCauseId !== proof.causeId) return { error: "realm_source_wrong_actor_or_producer" };
    if (!source.causeId || source.causeId !== source.sourceId || source.createdDay > day || (source.expiresDay < day && !reserved)) return { error: "realm_source_cause_or_window_invalid" };
    if (state.character.location !== binding.locationId || source.locationId !== binding.locationId) return { error: "required_location_not_reached" };
    const ledgers = state.world.realmActionLedgers || {};
    if (binding.handler === "realm_qi_routine") {
      const row = (ledgers.registrations || []).find((item) => item.id === evidence.id && item.actorId === state.character.id
        && item.status === "accepted" && item.day <= day && item.skillId === evidence.skillId
        && state.character.learnedSkills?.includes(item.skillId)
        && state.character.skillRecords?.[item.skillId]?.lifeIndex === lifeIndex
        && state.character.skillRecords?.[item.skillId]?.sourceId === item.skillSourceId
        && item.scheduleId === state.world.realmServiceBoards?.practice?.scheduleId);
      if (!row) return { error: "practice_reservation_skill_provenance_mismatch" };
    } else if (binding.handler === "realm_qi_breathlesson") {
      const row = (ledgers.registrations || []).find((item) => item.id === evidence.id && item.registrationReceipt === source.registrationReceipt
        && item.studentId === state.character.id && item.status === "registered" && item.expiresDay >= day
        && state.world.npcRecords?.[item.teacherId]?.alive === true && state.world.npcRecords?.[item.teacherId]?.onDuty === true
        && state.world.npcRecords?.[item.teacherId]?.locationId === binding.locationId
        && state.world.npcRecords?.[item.waiterId]?.alive === true && state.world.npcRecords?.[item.waiterId]?.locationId === binding.locationId);
      if (!row) return { error: "typed_course_registration_invalid_or_expired" };
    } else if (binding.handler === "realm_qi_sleep") {
      const row = (ledgers.duties || []).find((item) => item.id === evidence.id && item.dutyReceipt === source.dutyReceipt
        && item.actorId === state.character.id && item.lifeIndex === lifeIndex && item.status === "accepted" && (item.dueDay >= day || reserved)
        && state.world.npcRecords?.[item.householdMemberId]?.alive === true && state.world.npcRecords?.[item.householdMemberId]?.locationId === binding.locationId);
      if (!row) return { error: "typed_duty_or_household_member_invalid" };
    } else if (binding.handler === "realm_foundation_shelter") {
      const row = (ledgers.housing || []).find((item) => item.id === evidence.id && item.housingRecord === source.housingRecord
        && item.managerId === state.character.id && item.lifeIndex === lifeIndex && item.status === "authorized"
        && item.expiresDay >= day && state.world.npcRecords?.[item.ownerId]?.alive === true
        && item.repairPermit?.status === "valid" && item.repairPermit?.expiresDay >= day
        && item.repairPermit?.issuedBy === item.ownerId && item.repairPermit?.id === state.world.realmServiceBoards?.housing?.repairNotice?.causeId);
      if (!row) return { error: "typed_housing_authority_invalid_or_revoked" };
    } else if (binding.handler === "realm_foundation_water") {
      const row = (ledgers.water || []).find((item) => item.id === evidence.id && item.waterTurn === source.waterTurn
        && item.holderId === state.character.id && item.lifeIndex === lifeIndex && item.status === "active" && item.expiresDay >= day);
      const consent = state.world.dailyServiceBoards?.well?.swapConsents?.[state.character.id];
      if (!row || !consent || consent.status !== "signed" || consent.id !== row.consentReceiptId || consent.signers?.join("|") !== row.signers?.join("|")) return { error: "typed_water_turn_invalid_or_expired" };
    } else if (binding.handler === "realm_foundation_debate") {
      const loans = source.loanReceipts || [];
      if (loans.length !== 2 || new Set(loans.map((item) => item.bookId)).size !== 2
        || loans.some((loan) => !ledgers.noteLoans?.some((row) => row.id === loan.id && row.borrowerId === state.character.id && row.status === "open" && row.dueDay >= day))
        || state.world.npcRecords?.r4_npc_han_jian?.alive !== true) return { error: "two_owned_current_note_loans_required" };
    } else if (binding.handler === "realm_core_craft") {
      const batch = source.batch || {}; const permit = source.permit || {}; const livePermit = state.character.permits?.furnace || {};
      const prepared = ledgers.craftBatches?.find((row) => row.id === source.sourceId && row.actorId === state.character.id && row.lifeIndex === lifeIndex && row.status === "authorized");
      const costs = pack.actions.r4_action_alchemy?.reservedCost || {};
      const actionTransactionId = source.evidence?.actionTransactionId;
      const completedCraftAction = reserved && actionTransactionId && state.actionTransactionLedger?.[actionTransactionId]?.status === "completed" && state.character.actionLog?.some((row) => row.transactionId === actionTransactionId && row.actionId === "r4_action_alchemy");
      if (!prepared || batch.status !== "ready" || batch.actorId !== state.character.id || batch.lifeIndex !== lifeIndex || !state.character.learnedSkills?.includes("r4_skill_dao02") || state.character.skillRecords?.r4_skill_dao02?.lifeIndex !== lifeIndex || permit.location !== state.character.location || permit.leaseId !== livePermit.leaseId || day > permit.issuedDay + permit.validDays || Number(state.character.inventory?.r4_item_powder_recipe || 0) < 1 || Number(state.character.proficiency?.r4_skill_dao02 || 0) < pack.caps.dao02MinimumProficiency || (!completedCraftAction && Number(state.character.inventory?.r4_item_stargrass || 0) < Number(costs.r4_item_stargrass || 1))) return { error: "current_dao02_batch_or_permit_invalid" };
    } else if (binding.handler === "realm_core_records") {
      const evidence = source.evidence || {}; const contributor = state.world.npcRecords?.[evidence.contributorId]; const consent = evidence.consent || {};
      const record = (state.world.researchRecords || []).find((row) => row.id === evidence.batchId);
      const contribution = ledgers.contributions?.find((row) => row.id === source.sourceId && row.status === "signed" && row.actorId === state.character.id && row.lifeIndex === lifeIndex && row.batchId === evidence.batchId);
      const batch = state.world.craftBatchLedger?.find((row) => row.id === evidence.batchId && row.actorId === state.character.id && row.lifeIndex === lifeIndex && ["completed", "failed"].includes(row.status));
      const review = state.world.researchReviews?.find((row) => row.id === evidence.review?.id && row.recordId === evidence.batchId && row.playerId === state.character.id && row.contributorId === evidence.contributorId && row.lifeIndex === lifeIndex && row.status === "completed" && row.day <= day && row.sourceBatchCauseId === batch?.causeId);
      const actualConsent = contributor?.contributionConsentRecords?.find((row) => row.id === consent.id && row.status === "signed" && row.signerId === evidence.contributorId && row.recordId === evidence.batchId && row.reviewId === review?.id && row.lifeIndex === lifeIndex && row.day <= day);
      if (!record || !batch || !contribution || evidence.status !== "signed" || evidence.actorId !== state.character.id || evidence.lifeIndex !== lifeIndex || !evidence.signedBy?.includes(state.character.id) || !evidence.signedBy?.includes(evidence.contributorId) || contributor?.alive !== true || consent.status !== "signed" || consent.signerId !== evidence.contributorId || consent.recordId !== evidence.batchId || consent.reviewId !== review?.id || !review || !actualConsent) return { error: "joint_contribution_signatures_invalid" };
    } else if (binding.handler === "realm_core_supply") {
      const batch = source.ownedBatch || {}; const lease = state.world.rentalLedger?.find((row) => row.leaseId === source.leaseNotice?.id && row.tenantId === state.character.id);
      const quote = state.quotes?.[source.validQuote?.id]; const lot = (state.character.inventoryLedger?.[batch.itemId] || []).find((row) => row.sourceId === batch.id && row.ownership === "owned" && row.quantity >= batch.quantity);
      const produced = (state.world.realmActionLedgers.vendorQuotes || []).find((row) => row.id === source.sourceId && row.status === "open" && row.ownedBatch?.id === batch.id && row.validQuote?.id === source.validQuote?.id);
      if (!produced || produced.ownedBatch?.ownerId !== batch.ownerId || produced.ownedBatch?.sourceRecord?.sourceId !== batch.id || produced.validQuote?.id !== source.validQuote?.id || batch.ownerId !== state.character.id || batch.itemId !== "r4_item_stargrass" || batch.quantity !== 1 || !lot || Number(state.character.inventory?.[batch.itemId] || 0) < batch.quantity || lease?.status !== "active" || lease.dueDay > day || lease.dueDay !== source.leaseNotice?.dueDay || lease.amount !== source.leaseNotice?.amount || lease.ownerId !== source.leaseNotice?.ownerId || lease.extensionOffer?.status !== source.leaseNotice?.extensionOffer?.status || !quote || quote.ownerId !== state.character.id || quote.itemId !== batch.itemId || quote.quantity !== batch.quantity || quote.totalWealth !== source.validQuote?.totalWealth || quote.marketId !== source.validQuote?.marketId || source.validQuote?.valid !== true || quote.receipt || quote.expiryDay < day || source.validQuote?.expiresDay < day) return { error: "owned_trade_batch_due_lease_or_live_quote_invalid" };
    } else if (/^(realm_soul_|realm_void_|realm_ascendant_)/.test(binding.handler)) {
      const evidence = source.evidence || {}; const person = state.world.npcRecords?.[evidence.personId];
      const actual = ledgers.highRealmRequests?.find((row) => row.id === source.sourceId && row.handler === binding.handler && row.actorId === state.character.id && row.lifeIndex === lifeIndex);
      if (!actual || !person || person.alive !== true || person.locationId !== state.character.location || !["open", "invited", "request", "requested", "authorized", "entrusted", "accepted", "owned_draft"].includes(source.status)) return { error: "authoritative_high_realm_source_actor_life_or_person_invalid" };
      const boards = state.world.highRealmBoards || {};
      if (binding.handler === "realm_soul_witness") {
        const invitation = actual.invitation || {}; const witness = state.world.npcRecords[invitation.invitedBy]; const receipt = state.world.quoteReceipts?.[invitation.evidenceRef];
        if (!evidence.evidenceRefs?.length || !witness?.witnessInvitations?.some((row) => row.id === invitation.id && row.status === "offered") || receipt?.status !== "committed" || invitation.expiresDay < day) return { error: "current_voluntary_witness_invitation_or_public_cause_missing" };
      } else if (binding.handler === "realm_soul_archive") {
        const page = boards.archive?.sealedPages?.find((row) => row.id === actual.pageId);
        const authorization = page?.authorization || {}; const consent = actual.authorization || {};
        if (!page || actual.personId !== page.subjectId || actual.evidence?.pageId && actual.evidence.pageId !== page.id || page.status !== "sealed" || page.contentStored !== false || authorization.status !== "valid" || authorization.id !== consent.id || authorization.pageId !== page.id || authorization.signerId !== page.subjectId || consent.status !== "signed" || consent.signerId !== page.subjectId || consent.pageId !== page.id || consent.scope !== "read_subject_page_once" || authorization.expiresDay < day || source.evidence?.authorization?.id !== authorization.id) return { error: "current_subject_authorized_sealed_page_missing" };
      } else if (binding.handler === "realm_soul_care") {
        const request = person.currentCareRequest; const pinned = actual.request || {};
        if (actual.personId !== evidence.personId || request?.status !== "open" || request.id !== pinned.id || request.requestorId !== person.id || request.decisionOwnerId !== person.id || !Array.isArray(request.alternatives) || !request.alternatives.length || request.kind !== pinned.kind || request.sourceId !== pinned.sourceId || request.day > day || request.expiresDay < day || pinned.expiresDay !== request.expiresDay) return { error: "personal_request_withdrawn_expired_or_authority_mismatch" };
      } else if (binding.handler === "realm_void_route") {
        const road = boards.road || {}; const segment = road.segment; const permit = actual.permit;
        const livePermit = segment?.permits?.find((row) => row.id === permit?.id);
        if (actual.actorId !== state.character.id || actual.personId !== "r4_npc_waykeeper" || actual.status !== "authorized" || !segment || segment.ownerId !== "public" || segment.status !== "closed" || segment.id !== actual.notice?.id || segment.causeId !== actual.notice?.causeId || segment.causeId !== permit?.causeId || (segment.expiresDay != null && segment.expiresDay < day) || !permit || permit.status !== "valid" || permit.holderId !== state.character.id || permit.issuedBy !== "r4_npc_waykeeper" || permit.segmentId !== segment.id || permit.scope !== "one_segment_public_repair" || permit.expiresDay < day || !livePermit || livePermit.status !== "valid" || livePermit.holderId !== state.character.id || livePermit.issuedBy !== permit.issuedBy || livePermit.causeId !== segment.causeId || source.evidence?.permit?.id !== permit.id) return { error: "current_public_road_closure_or_player_permit_missing" };
      } else if (binding.handler === "realm_void_map") {
        const road = boards.road || {}; const segment = road.segment; const map = road.publishedMaps?.find((row) => row.id === actual.map?.id && row.ownerId === "public" && row.version === actual.map?.version && row.publishedDay <= day);
        const observation = state.world.travelObservations?.find((row) => row.id === actual.observation?.id && row.actorId === state.character.id && row.lifeIndex === lifeIndex);
        const possessed = state.character.publicMaps?.[segment?.id]; const superseded = road.publishedMaps?.some((row) => row.ownerId === "public" && row.version > actual.map?.version && row.publishedDay <= day);
        if (actual.actorId !== state.character.id || actual.personId !== "r4_npc_han_archive" || actual.status !== "open" || segment?.ownerId !== "public" || !map || map.id !== source.evidence?.map?.id || map.version !== source.evidence?.map?.version || possessed?.id !== map.id || possessed.ownerId !== "public" || possessed.version !== map.version || superseded || !observation || observation.id !== source.evidence?.observation?.id || observation.segmentId !== segment.id || observation.status !== segment.status || observation.causeId !== segment.causeId || observation.source !== "observed_public_notice" || observation.locationId !== state.character.location) return { error: "lawful_public_map_or_current_route_observation_missing" };
      } else if (binding.handler === "realm_void_relocation") {
        const move = boards.facilityMove; const receipt = move?.custodyReceipt; const publicCargoIds = (move?.cargo || []).filter((item) => item.ownerId === "public" && item.portable && item.status === "ready").map((item) => item.id);
        const receiptCargoIds = receipt?.cargoIds || [];
        if (actual.actorId !== state.character.id || actual.personId !== "r4_npc_han_archive" || actual.status !== "entrusted" || move?.status !== "in_transit" || move.ownerId !== "public" || move.custodianId !== actual.personId || move.locationId !== actual.locationId || !receipt || receipt.status !== "entrusted" || receipt.custodianId !== state.character.id || receipt.acceptedBy !== actual.personId || receipt.ownerId !== "public" || receipt.expiresDay < day || receipt.id !== actual.id || actual.move?.id !== move.id || !receipt.privateCargoExcluded || JSON.stringify(receiptCargoIds) !== JSON.stringify(publicCargoIds) || move.cargo.some((item) => item.ownerId !== "public" && receiptCargoIds.includes(item.id)) || move.departDay <= day || !move.arrivalLocationId) return { error: "custody_or_current_move_revoked" };
      } else if (binding.handler === "realm_ascendant_openlesson") {
        const venue = boards.lesson; const lesson = actual.lesson || {}; const live = venue?.sessions?.find((row) => row.id === lesson.id);
        const teacher = state.world.npcRecords?.[lesson.teacherId]; const acceptedLearners = lesson.acceptedLearners || [];
        const seatsUsed = (venue?.sessions || []).filter((row) => row.status === "accepted" && row.expiresDay >= day).reduce((sum, row) => sum + (row.acceptedLearners || []).length, 0);
        const learnerConsents = acceptedLearners.every((id) => state.world.npcRecords?.[id]?.lessonResponsePolicy === "accept_only_named_public_basics_session" && state.world.npcRecords[id].alive === true && state.world.npcRecords[id].locationId === state.character.location);
        if (actual.actorId !== state.character.id || actual.personId !== "r4_npc_public_teacher" || actual.status !== "accepted" || venue?.status !== "available" || venue.locationId !== state.character.location || !live || live.status !== "accepted" || live.expiresDay < day || live.teacherId !== teacher?.id || live.acceptedByTeacher !== teacher?.id || teacher?.alive !== true || teacher.onDuty !== true || teacher.locationId !== state.character.location || teacher.openLessonPolicy !== "accept_if_venue_and_learners_are_present" || live.scope !== "public_basics_only" || live.venueId !== venue.id || !acceptedLearners.length || JSON.stringify(live.acceptedLearners) !== JSON.stringify(acceptedLearners) || !learnerConsents || acceptedLearners.some((id) => !venue.roster?.includes(id)) || new Set(venue.roster || []).size > venue.capacity || seatsUsed > venue.capacity || !live.consentReceipts?.includes(`teacher-consent:${live.causeId}`) || acceptedLearners.some((id) => !live.consentReceipts?.includes(`learner-consent:${live.causeId}`)) || source.evidence?.lesson?.id !== live.id || live.causeId !== actual.lesson?.causeId) return { error: "lesson_consent_venue_or_learners_missing" };
      } else if (binding.handler === "realm_ascendant_seat") {
        const org = boards.organization; const road = boards.road; const invitation = actual.invitation; const live = org?.invitations?.find((row) => row.id === invitation?.id);
        const application = org?.candidateRoster?.find((row) => row.id === invitation?.applicationId);
        const nomination = org?.nominationLedger?.find((row) => row.id === application?.nominationId);
        const review = org?.credentialReviews?.find((row) => row.id === application?.reviewId);
        const contribution = road?.repairLedger?.find((row) => row.id === application?.contributionId);
        const officer = state.world.npcRecords?.r4_npc_waykeeper;
        if (actual.actorId !== state.character.id || actual.personId !== "r4_npc_waykeeper" || actual.lifeIndex !== lifeIndex || actual.day > day || actual.locationId !== state.character.location || actual.status !== "invited"
          || !invitation || live?.id !== invitation.id || live.status !== "issued" || live.candidateId !== state.character.id || live.vacancyId !== org?.vacancy?.id
          || live.processId !== org?.process?.id || live.applicationId !== application?.id || live.issuedBy !== officer?.id || live.issuedDay !== actual.day || live.expiresDay < day || live.expiresDay < live.issuedDay
          || live.termDays !== org?.vacancy?.termDays || live.scope !== org?.vacancy?.scope || live.causeId !== invitation.causeId
          || source.evidence?.invitation?.id !== live.id
          || org?.status !== "active" || org.vacancy?.status !== "open" || org.process?.status !== "open" || org.process?.steps?.join(",") !== "public_nomination,credential_review,dated_invitation,acceptance"
          || application?.candidateId !== state.character.id || application.status !== "reviewed" || application.reviewedBy !== officer?.id || application.processId !== org.process.id
          || application.reviewedDay > day || application.nominationId !== nomination?.id || application.reviewId !== review?.id
          || nomination?.status !== "submitted" || nomination.public !== true || nomination.nominatedBy !== "public_contribution_registry" || nomination.candidateId !== state.character.id || nomination.contributionId !== contribution?.id || nomination.submittedDay !== application.submittedDay
          || review?.status !== "qualified" || review.candidateId !== state.character.id || review.reviewerId !== officer?.id || review.contributionId !== contribution?.id || review.reviewedDay !== application.reviewedDay || review.causeId !== invitation.causeId
          || !contribution || contribution.status !== "completed" || contribution.actorId !== state.character.id || contribution.public !== true
          || officer?.alive !== true || officer.onDuty !== true || officer.locationId !== state.character.location
          || org.appointments?.some((row) => row.status === "active" && row.expiresDay >= day) || (state.character.organizationAccess?.[org.id]?.status === "appointed" && state.character.organizationAccess[org.id].expiresDay >= day)) return { error: "formal_invitation_or_vacancy_missing" };
      } else if (binding.handler === "realm_ascendant_seedarchive") {
        const method = actual.method; const live = state.character.ownedPublicMethods?.find((row) => row.id === method?.id && row.ownerId === state.character.id && row.authorId === state.character.id && row.lifeIndex === lifeIndex && row.status === "draft");
        const practice = state.character.skillPracticeLedger?.find((row) => row.id === method?.sourcePracticeId && row.lifeIndex === lifeIndex && row.skillId === method?.sourceSkillId && state.character.learnedSkills?.includes(row.skillId));
        const authorship = state.world.methodAuthorshipLedger?.find((row) => row.id === method?.id && row.ownerId === state.character.id && row.sourcePracticeId === method?.sourcePracticeId);
        const methodArchive = boards.methods;
        const teacher = state.world.npcRecords?.[actual.personId]; const consent = actual.attributionConsent;
        const liveConsent = teacher?.methodAttributionConsents?.find((row) => row.id === consent?.id);
        if (actual.actorId !== state.character.id || actual.lifeIndex !== lifeIndex || actual.personId !== "r4_npc_public_teacher" || actual.status !== "owned_draft" || actual.locationId !== state.character.location || actual.day > day
          || !live || !practice || !authorship || methodArchive?.status !== "open" || live.privateContent !== false || live.sourceSkillId !== method.sourceSkillId || live.sourcePracticeId !== method.sourcePracticeId
          || live.authorId !== method.authorId || JSON.stringify(live.steps) !== JSON.stringify(method.steps) || JSON.stringify(source.evidence?.method?.steps) !== JSON.stringify(live.steps)
          || !Array.isArray(live.steps) || live.steps.length !== 2 || live.steps[0] !== "practice only the publicly documented basic sequence" || live.steps[1] !== "stop when the recorded safety limit is reached"
          || teacher?.alive !== true || teacher.onDuty !== true || teacher.locationId !== state.character.location || teacher.openLessonPolicy !== "accept_if_venue_and_learners_are_present"
          || consent?.status !== "signed" || consent.signerId !== teacher.id || consent.methodId !== live.id || consent.scope !== "named_contribution_only"
          || liveConsent?.status !== "signed" || liveConsent.signerId !== teacher.id || liveConsent.methodId !== live.id || liveConsent.scope !== consent.scope || liveConsent.expiresDay !== consent.expiresDay || liveConsent.causeId !== consent.causeId
          || !live.coauthors?.some((row) => row.personId === teacher.id && row.consentId === liveConsent.id)) return { error: "owned_current_public_method_draft_missing" };
      }
    }
    return null;
  }

  function validateRealmEventChoice(event, option) {
    const source = realmSourceFor(event);
    const evidence = source?.evidence || {};
    const day = state.worldDay;
    const action = option.runtimeAction;
    if (event.id === "r4_ev_realm_qi_sleep" && action === "realm_watch_share" && !evidence.consentReceiptId) return { error: "dated_substitute_acceptance_missing" };
    if (event.id === "r4_ev_realm_qi_sleep" && action === "realm_watch_practice") {
      const duty = (state.world.realmActionLedgers?.duties || []).find((row) => row.dutyReceipt === source?.dutyReceipt && row.actorId === state.character.id && row.lifeIndex === Number(state.character.lifeIndex || 1) && row.status === "accepted");
      const member = state.world.npcRecords?.[evidence.householdMemberId];
      const offer = state.world.realmServiceBoards?.nightDuty?.coverOffer || {};
      const consent = evidence.substituteConsentReceiptId;
      const consentReservedForLiveAction = realmReservationMatches(event, source);
      if (!duty || !consent || duty.substituteConsentReceiptId !== consent || duty.consentReceiptId !== consent
        || offer.status !== "accepted" || offer.consentReceiptId !== consent || offer.acceptedBy !== state.character.id
        || offer.offeredBy !== member?.id || !offer.signers?.includes(state.character.id) || !offer.signers?.includes(member?.id)
        || (offer.expiresDay < day && !consentReservedForLiveAction)
        || (realmSourceAdapter === "r5" && (!offer.sourceActionId || state.actionTransactionLedger?.[offer.sourceActionId]?.status !== "completed"))
        || member?.alive !== true || member.locationId !== state.character.location) return { error: "current_signed_substitute_consent_or_household_member_missing" };
    }
    if (event.id === "r4_ev_realm_foundation_shelter") {
      const board = state.world.realmServiceBoards.housing;
      if (action === "realm_room_repair" && (evidence.repairPermit?.status !== "valid" || evidence.repairPermit.expiresDay < day
        || evidence.repairPermit.issuedBy !== evidence.ownerId || evidence.repairMaterials?.status !== "available" || evidence.repairMaterials.stock < 1
        || board.repairNotice?.causeId !== evidence.repairPermit.id)) return { error: "owner_repair_permission_or_material_missing" };
      if (action === "realm_room_move" && (evidence.vacantRoom?.status !== "verified_vacant" || evidence.vacantRoom.ownerId !== evidence.ownerId
        || board.vacantRoom?.id !== evidence.vacantRoom.id || board.vacantRoom?.status !== "verified_vacant")) return { error: "owner_verified_current_vacancy_missing" };
      if (action === "realm_room_share_watch" && (evidence.roommateOffer?.status !== "accepted" || evidence.roommateOffer.acceptedBy !== state.character.id
        || evidence.roommateOffer.offeredBy !== evidence.roommateOffer.personId || !evidence.roommateOffer.consentReceiptId)) return { error: "dated_roommate_acceptance_missing" };
    }
    if (event.id === "r4_ev_realm_foundation_water" && action === "realm_water_alternative") {
      const permit = evidence.alternativePermit;
      if (permit?.status !== "valid" || permit.holderId !== state.character.id || permit.expiresDay < day
        || permit.boardId !== state.world.realmServiceBoards.water.boardId
        || permit.sourceNoticeId !== state.world.dailyServiceBoards.well.alternative?.noticeId) return { error: "authorized_alternative_water_permit_missing" };
    }
    if (event.id === "r4_ev_realm_foundation_water" && action === "realm_water_audit") {
      if (!evidence.managerId || !evidence.signers?.includes(evidence.managerId) || !evidence.signers?.includes(state.character.id)) return { error: "separate_manager_and_player_signatures_required" };
    }
    if (event.id === "r4_ev_realm_foundation_debate" && action === "realm_notes_ask_author") {
      const authorId = source.loanReceipts?.[0]?.authorId; const author = state.world.npcRecords[authorId];
      if (author?.alive !== true || author.locationId !== state.character.location) return { error: "note_author_unavailable" };
    }
    if (event.id === "r4_ev_realm_foundation_debate" && action === "realm_notes_return") {
      if (source.loanReceipts?.some((loan) => !state.world.realmActionLedgers.noteLoans.some((row) => row.id === loan.id && row.borrowerId === state.character.id && row.status === "open"))) return { error: "authoritative_open_note_loan_missing" };
    }
    if (event.id === "r4_ev_realm_void_route") {
      const road = state.world.highRealmBoards?.road || {}; const segment = road.segment; const producer = (state.world.realmActionLedgers.highRealmRequests || []).find((row) => row.id === source.sourceId && row.handler === "realm_void_route");
      const permit = segment?.permits?.find((row) => row.id === producer?.permit?.id);
      if (!producer || !permit || producer.actorId !== state.character.id || producer.lifeIndex !== Number(state.character.lifeIndex || 1) || producer.personId !== "r4_npc_waykeeper" || source.evidence?.permit?.id !== permit.id || permit.status !== "valid" || permit.holderId !== state.character.id || permit.issuedBy !== "r4_npc_waykeeper" || permit.expiresDay < day || segment?.status !== "closed" || segment.ownerId !== "public" || segment.id !== producer.notice?.id || segment.causeId !== producer.notice?.causeId || segment.causeId !== permit.causeId) return { error: "authoritative_route_segment_or_live_permit_required" };
      if (action === "realm_void_route_repair" && road.repairStock < 1) return { error: "public_repair_material_missing" };
      if (action === "realm_void_route_escort") {
        const shipment = road.publicShipment;
        if (shipment?.status !== "verified_waiting" || shipment.ownerId !== "r4_npc_market_vendor" || shipment.currentCarrierId !== shipment.ownerId || shipment.origin !== "r4_loc_willow_market" || shipment.destination !== "r4_loc_ashspring" || !shipment.proofId || (shipment.expiresDay != null && shipment.expiresDay < day)) return { error: "current_verified_public_shipment_required" };
      }
    }
    if (event.id === "r4_ev_realm_void_map" && action === "realm_void_map_permission") {
      const officer = state.world.npcRecords?.r4_npc_waykeeper;
      if (source.evidence?.map?.ownerId !== "public" || state.world.highRealmBoards?.road?.segment?.ownerId !== "public" || officer?.alive !== true || officer.onDuty !== true || officer.locationId !== state.character.location || state.world.factions?.r4_faction_waykeepers?.guideService !== true) return { error: "current_public_owner_officer_authority_required" };
    }
    if (event.id === "r4_ev_realm_void_relocation") {
      const move = state.world.highRealmBoards?.facilityMove; const producer = (state.world.realmActionLedgers.highRealmRequests || []).find((row) => row.id === source.sourceId && row.handler === "realm_void_relocation");
      const receipt = move?.custodyReceipt; const cargoId = action === "realm_void_move_register" ? "public_register" : action === "realm_void_move_tools" ? "communal_tools" : null;
      if (!producer || producer.actorId !== state.character.id || producer.lifeIndex !== Number(state.character.lifeIndex || 1) || producer.personId !== "r4_npc_han_archive" || move?.status !== "in_transit" || move.ownerId !== "public" || move.custodianId !== producer.personId || receipt?.status !== "entrusted" || receipt.custodianId !== state.character.id || receipt.ownerId !== "public" || receipt.expiresDay < day || !receipt.privateCargoExcluded || producer.move?.id !== move.id || receipt.id !== producer.id || move.departDay <= day) return { error: "current_public_custody_and_move_required" };
      if (cargoId && !move.cargo.some((item) => item.item === cargoId && item.ownerId === "public" && item.status === "ready" && item.portable && receipt.cargoIds.includes(item.id))) return { error: "selected_portable_public_cargo_missing" };
      if (receipt.cargoIds.some((id) => move.cargo.some((item) => item.id === id && item.ownerId !== "public"))) return { error: "private_cargo_excluded_from_public_custody" };
    }
    if (event.id === "r4_ev_realm_ascendant_openlesson") {
      const lesson = source.evidence?.lesson || {}; const teacher = state.world.npcRecords?.[lesson.teacherId];
      const skillId = state.character.learnedSkills?.find((id) => state.character.skillRecords?.[id]?.lifeIndex === Number(state.character.lifeIndex || 1) && teacher?.taughtSkillIds?.includes(id));
      if (action === "realm_asc_lesson_teach" && !skillId) return { error: "verified_current_life_teacher_skill_required" };
      if (action === "realm_asc_lesson_listen") {
        const course = state.world.realmServiceBoards?.course;
        if (!course?.id || course.teacherId !== teacher?.id || course.locationId !== state.character.location) return { error: "existing_public_course_or_material_required" };
      }
    }
    if (event.id === "r4_ev_realm_ascendant_seat" && action === "realm_asc_seat_rotation") {
      const org = state.world.highRealmBoards?.organization;
      const members = org?.members || ["r4_npc_waykeeper"];
      if (!members.some((id) => state.world.npcRecords?.[id]?.alive === true)) return { error: "living_member_for_rotation_consultation_missing" };
    }
    if (event.id === "r4_ev_realm_ascendant_seedarchive" && action === "realm_asc_archive_credit") {
      const method = source.evidence?.method || {};
      const producer = (state.world.realmActionLedgers.highRealmRequests || []).find((row) => row.id === source.sourceId && row.handler === "realm_ascendant_seedarchive");
      const liveMethod = state.character.ownedPublicMethods?.find((row) => row.id === method.id && row.ownerId === state.character.id && row.lifeIndex === Number(state.character.lifeIndex || 1) && row.status === "draft");
      const coauthors = liveMethod?.coauthors || [];
      const allConsented = coauthors.length > 0 && coauthors.every((author) => {
        const liveConsent = state.world.npcRecords?.[author.personId]?.methodAttributionConsents?.find((row) => row.id === author.consentId);
        return liveConsent?.status === "signed" && liveConsent.signerId === author.personId && liveConsent.methodId === liveMethod.id && liveConsent.scope === "named_contribution_only" && liveConsent.expiresDay >= day;
      });
      if (!producer || producer.method?.id !== method.id || method.status !== "draft" || !liveMethod || !allConsented
        || !coauthors.some((row) => row.personId === "r4_npc_public_teacher" && row.consentId === producer.attributionConsent?.id)) return { error: "dated_method_specific_coauthor_consent_missing" };
    }
    if (event.id === "r4_ev_realm_core_supply") {
      const notice = source.leaseNotice || {}; const actual = (state.world.rentalLedger || []).find((row) => row.leaseId === notice.id && row.tenantId === state.character.id);
      if (action === "realm_supply_sell" && (!actual || actual.status !== "active" || actual.dueDay > day || source.validQuote?.valid !== true || source.validQuote.ownerCharacterId !== state.character.id || source.validQuote.expiresDay < day || source.validQuote.totalWealth < notice.amount)) return { error: "valid_owned_quote_cannot_settle_due_rent" };
      if (action === "realm_supply_extend") {
        const approval = actual?.extensionOffer || {};
        if (!actual || actual.status !== "active" || actual.tenantId !== state.character.id || approval.status !== "preapproved" || approval.leaseId !== actual.leaseId || approval.tenantId !== state.character.id || approval.ownerId !== actual.ownerId || approval.signedBy !== actual.ownerId || !Number.isInteger(approval.termDays) || approval.termDays < 1 || approval.expiresDay < day) return { error: "lease_owner_signed_extension_not_proven" };
      }
      if (action === "realm_supply_decline" && (!actual || actual.status !== "active" || actual.dueDay > day)) return { error: "decline_requires_current_due_tenant_lease" };
    }
    return null;
  }

  function withEventContext(event, callback) {
    const previousEvent = state.activeEventId;
    const previousInstance = state.activeCrisisInstanceId;
    state.activeEventId = event.id;
    const family = Object.entries(pack.crises).find(([, plan]) => plan.eventIds?.includes(event.id))?.[0];
    const queuedInstance = state.queue.find((entry) => entry.eventId === event.id)?.instanceId;
    state.activeCrisisInstanceId = state.world.crisisInstances.find((item) => item.id === queuedInstance)?.id || state.world.crisisInstances.find((item) => item.family === family && !item.closed)?.id || previousInstance;
    try { return callback(); }
    finally { state.activeEventId = previousEvent; state.activeCrisisInstanceId = previousInstance; }
  }

  function eventAvailableInContext(event) {
    if (event.type === "action") return false;
    if (event.id === "r4_ev_daily_courier" && !isDailyCourierSourceLive()) return false;
    if (event.runtimeBinding?.kind === "realm_source" && validateRealmEventSource(event)) return false;
    if (event.id === "r4_ev_daily_ferry" && !isDailyFerrySourceLive()) return false;
    if (event.id === "r4_ev_daily_publiclesson" && !isDailyPublicLessonSourceLive()) return false;
    if (event.id === "r4_ev_daily_roadmarker" && !isDailyRoadSourceLive()) return false;
    if (event.id === "r4_ev_daily_well_queue" && !isDailyWellSourceLive()) return false;
    if (["r4_ev_era_lingxu_repair", "r4_ev_era_faction_successor"].includes(event.id) && !isEraEventSourceLive(event)) return false;
    if (typeof event.location === "string" && event.location.startsWith("r4_loc_") && state.character.location !== event.location) return false;
    if (!testPredicate(event.requiresFacts)) return false;
    if (event.forbidsFacts && testPredicate(event.forbidsFacts)) return false;
    if (event.requiresKnowledge && !testPredicate(event.requiresKnowledge)) return false;
    if (event.window) {
      const from = resolvePath(event.window.from);
      const until = event.window.until == null ? Infinity : resolvePath(event.window.until);
      if (Number.isFinite(Number(from)) && state.worldDay < Number(from)) return false;
      if (Number.isFinite(Number(until)) && state.worldDay > Number(until)) return false;
    }
    const queued = state.queue.some((entry) => entry.eventId === event.id && entry.day <= state.worldDay);
    if (event.instanceScope === "world_crisis_instance") return queued;
    const instanceId = scopeInstanceId(event);
    const limit = repeatLimit(event);
    if (limit) {
      if (state.eventClaimLedger[recordKey(instanceId, event.id, 0)]?.state === "in_flight") return false;
      return completedRepeatCount(instanceId, event.id) < limit;
    }
    return state.eventClaimLedger[recordKey(instanceId, event.id, 0)]?.state !== "completed";
  }

  function isDailyFerrySourceLive() {
    const source = state.world.dailyBusinessSources?.ferry;
    return Boolean(source && source.status === "open" && source.eventId === "r4_ev_daily_ferry"
      && source.ownerCharacterId === state.character.id && source.locationId === state.character.location
      && source.createdDay <= state.worldDay && source.expiresDay >= state.worldDay
      && source.provenance?.status === "verified");
  }

  function isDailyPublicLessonSourceLive() {
    const source = state.world.dailyBusinessSources?.publicLesson;
    return Boolean(source && source.status === "open" && source.eventId === "r4_ev_daily_publiclesson"
      && source.ownerCharacterId === state.character.id && source.locationId === state.character.location
      && source.createdDay === state.worldDay && source.expiresDay === state.worldDay
      && source.provenance?.status === "verified" && source.loan?.status === "open");
  }

  function isDailyRoadSourceLive() {
    const source = state.world.dailyBusinessSources?.roadmarker;
    if (source?.provenance?.producer === "r6_weather_generator") {
      const closure = state.world.r6FloodClosures?.[source.routeId];
      return Boolean(source.status === "open" && closure?.status === "active" && state.worldDay >= closure.startWorldDay && state.worldDay < closure.endWorldDayExclusive);
    }
    const permit = source?.maintenancePermit;
    return Boolean(source && source.status === "open" && source.eventId === "r4_ev_daily_roadmarker"
      && source.ownerCharacterId === state.character.id && source.locationId === state.character.location
      && source.createdDay === state.worldDay && source.expiresDay >= state.worldDay
      && source.provenance?.status === "verified" && source.route?.verified === true
      && permit?.characterId === state.character.id && permit.status === "valid" && permit.expiresDay >= state.worldDay);
  }

  function isDailyWellSourceLive() {
    const source = state.world.dailyBusinessSources?.wellQueue;
    const board = state.world.dailyServiceBoards?.well;
    return Boolean(source && source.status === "open" && source.eventId === "r4_ev_daily_well_queue"
      && source.ownerCharacterId === state.character.id && source.lifeIndex === Number(state.character.lifeIndex || 1)
      && source.locationId === state.character.location && source.createdDay === state.worldDay && source.expiresDay >= state.worldDay
      && board?.status === "open" && board.rotation?.includes(state.character.id)
      && source.provenance?.producer === "registered_daily_service_action" && source.provenance?.status === "verified");
  }

  function prepareRealmEventSource(eventId, actionId) {
    const event = eventById.get(eventId);
    const binding = event?.runtimeBinding;
    if (binding?.kind !== "realm_source") return { error: "unknown_realm_source" };
    const progressionProof = currentRealmProgressionProof();
    if (!progressionProof) return { error: "current_life_successful_progression_required" };
    if (state.character.location !== binding.locationId) return { error: "required_location_not_reached" };
    const day = state.worldDay;
    const cid = state.character.id;
    const lifeIndex = Number(state.character.lifeIndex || 1);
    const boards = state.world.realmServiceBoards;
    const ledgers = state.world.realmActionLedgers;
    let record;
    if (binding.handler === "realm_qi_routine" && actionId === "reserve_practice") {
      const skillId = (state.character.learnedSkills || []).find((id) => state.character.skillRecords?.[id]?.lifeIndex === lifeIndex);
      const practice = boards.practice;
      if (!skillId || practice.status !== "open" || practice.locationId !== state.character.location) return { error: "learned_skill_or_open_practice_point_missing" };
      record = { id: `practice-reservation:${cid}:${day}`, status: "accepted", actorId: cid, lifeIndex, skillId, skillSourceId: state.character.skillRecords[skillId].sourceId, scheduleId: practice.scheduleId, day, locationId: state.character.location };
      ledgers.registrations.push(record);
    } else if (binding.handler === "realm_qi_breathlesson" && actionId === "post_next_public_course_notice") {
      const course = boards.course;
      const teacher = state.world.npcRecords[course.teacherId];
      if (teacher?.alive !== true || teacher.onDuty !== true || teacher.locationId !== state.character.location || course.locationId !== state.character.location) return { error: "public_teacher_or_course_location_unavailable" };
      if (course.status === "open" && course.closeDay >= day) return { error: "current_public_course_notice_still_open" };
      const previousNoticeId = course.id;
      course.id = `${realmWorldId}:dao01-lesson:${day}`; course.status = "open"; course.openDay = day; course.closeDay = day + 1;
      course.previousNoticeId = previousNoticeId; course.postedBy = teacher.id; course.postedDay = day; course.capacity = 1;
      course.courseNoticeCauseId = `course-notice:${teacher.id}:${day}`;
      record = { id: course.id, status: "posted", teacherId: teacher.id, postedBy: teacher.id, postedDay: day, openDay: day, closeDay: day + 1, locationId: state.character.location, causeId: course.courseNoticeCauseId };
    } else if (binding.handler === "realm_qi_breathlesson" && actionId === "register_public_course") {
      const course = boards.course; const teacher = state.world.npcRecords[course.teacherId]; const waiter = state.world.npcRecords.r4_npc_lin_xiaohe;
      const hasCurrentSkill = (state.character.learnedSkills || []).some((id) => state.character.skillRecords?.[id]?.lifeIndex === lifeIndex);
      if (course.status !== "open" || day < course.openDay || day > course.closeDay || teacher?.alive !== true || teacher.onDuty !== true || teacher.locationId !== state.character.location || waiter?.alive !== true || waiter.locationId !== state.character.location || !hasCurrentSkill) return { error: "live_course_waiting_student_or_current_skill_missing" };
      record = { id: `course-registration:${course.id}:${cid}`, status: "registered", registrationReceipt: `${course.id}:registration:${cid}:${day}`, studentId: cid, lifeIndex, waiterId: waiter.id, teacherId: teacher.id, courseId: course.id, registeredDay: day, expiresDay: course.closeDay, locationId: state.character.location };
      ledgers.registrations.push(record);
    } else if (binding.handler === "realm_qi_sleep" && ["accept_night_watch", "accept_shared_watch_offer"].includes(actionId)) {
      const board = boards.nightDuty; const neighbor = state.world.npcRecords.r4_npc_ash_neighbor; const offer = board.coverOffer;
      if (board.status !== "open" || neighbor?.alive !== true || neighbor.locationId !== state.character.location) return { error: "current_watch_board_or_household_member_missing" };
      if (!state.character.lastWorkDay && !state.character.birthRecord?.householdId) return { error: "current_life_duty_or_household_source_missing" };
      if (actionId === "accept_shared_watch_offer") {
        if (offer.status !== "offered" || offer.offeredBy !== neighbor.id || offer.expiresDay < day) return { error: "current_neighbor_authored_cover_offer_missing" };
        if (realmSourceAdapter === "r5" && (!offer.sourceActionId || state.actionTransactionLedger?.[offer.sourceActionId]?.status !== "completed")) return { error: "formal_social_service_offer_receipt_required" };
        offer.status = "accepted"; offer.acceptedBy = cid; offer.consentReceiptId = `${offer.id}:accept:${cid}:${day}`; offer.signers = [neighbor.id, cid]; offer.acceptedDay = day;
      }
      record = { id: `night-duty:${board.id}:${cid}:${day}`, status: "accepted", dutyReceipt: `${board.id}:duty:${cid}:${day}`, actorId: cid, lifeIndex, householdMemberId: neighbor.id, consentReceiptId: offer.consentReceiptId || null, substituteConsentReceiptId: offer.consentReceiptId || null, sourceWorkDay: state.character.lastWorkDay ?? null, acceptedDay: day, dueDay: day + 1, locationId: state.character.location };
      ledgers.duties.push(record);
    } else if (binding.handler === "realm_qi_sleep" && actionId === "request_night_cover_offer") {
      if (realmSourceAdapter === "r5") return { error: "formal_social_service_action_required" };
      const neighbor = state.world.npcRecords.r4_npc_ash_neighbor;
      if (neighbor?.alive !== true || neighbor.locationId !== state.character.location || Number(state.character.relationships?.[neighbor.id]?.value || 0) < 1) return { error: "neighbor_relationship_or_presence_required" };
      const offer = { id: `${realmWorldId}:night-cover:${cid}:${day}`, status: "offered", personId: neighbor.id, offeredBy: neighbor.id, scope: "one_night_cover", day, expiresDay: day + 1 };
      boards.nightDuty.coverOffer = offer; record = clone(offer);
    } else if (binding.handler === "realm_foundation_shelter" && actionId === "request_housing_watch_offer") {
      if (realmSourceAdapter === "r5") return { error: "formal_social_service_action_required" };
      const neighbor = state.world.npcRecords.r4_npc_ash_neighbor;
      if (neighbor?.alive !== true || neighbor.locationId !== state.character.location || Number(state.character.relationships?.[neighbor.id]?.value || 0) < 1) return { error: "neighbor_relationship_or_presence_required" };
      const offer = { id: `${realmWorldId}:shared-watch-offer:${cid}:${day}`, status: "offered", personId: neighbor.id, offeredBy: neighbor.id, scope: "shared_night_watch", day, expiresDay: day + 1 };
      boards.housing.roommateOffer = offer; record = clone(offer);
    } else if (binding.handler === "realm_foundation_shelter" && actionId === "accept_housing_watch_offer") {
      const offer = boards.housing.roommateOffer; const neighbor = state.world.npcRecords[offer.personId];
      if (offer.status !== "offered" || offer.offeredBy !== offer.personId || offer.expiresDay < day || neighbor?.alive !== true || neighbor.locationId !== state.character.location) return { error: "current_neighbor_authored_housing_offer_missing" };
      if (realmSourceAdapter === "r5" && (!offer.sourceActionId || state.actionTransactionLedger?.[offer.sourceActionId]?.status !== "completed")) return { error: "formal_social_service_offer_receipt_required" };
      offer.status = "accepted"; offer.acceptedBy = cid; offer.consentReceiptId = `${offer.id}:accept:${cid}:${day}`; offer.signers = [offer.offeredBy, cid]; offer.acceptedDay = day;
      record = clone(offer);
    } else if (binding.handler === "realm_foundation_shelter" && actionId === "request_housing_authority") {
      const housing = boards.housing; const owner = state.world.npcRecords[housing.ownerId]; const notice = housing.repairNotice;
      if (owner?.alive !== true || owner.locationId !== state.character.location) return { error: "housing_owner_unavailable" };
      if (notice.status !== "posted" || notice.signedBy !== housing.ownerId || notice.homeId !== housing.homeId) return { error: "owner_signed_housing_notice_missing" };
      record = { id: `housing-authority:${housing.homeId}:${cid}:${day}`, status: "authorized", housingRecord: `${housing.homeId}:repair-permit:${cid}:${day}`, homeId: housing.homeId, ownerId: housing.ownerId, managerId: cid, lifeIndex, repairPermit: { id: notice.causeId, status: "valid", issuedBy: notice.signedBy, issuedDay: day, expiresDay: day + 7 }, repairMaterials: clone(housing.repairMaterials), vacantRoom: clone(housing.vacantRoom), roommateOffer: clone(housing.roommateOffer), issuedDay: day, expiresDay: day + 7, locationId: state.character.location };
      ledgers.housing.push(record);
    } else if (binding.handler === "realm_foundation_water" && actionId === "accept_water_turn") {
      const board = boards.water; const consent = state.world.dailyServiceBoards?.well?.swapConsents?.[cid]; const manager = state.world.npcRecords[board.managerId];
      if (board.status !== "open" || manager?.alive !== true || manager.locationId !== state.character.location || Number(state.character.relationships?.[board.managerId]?.value || 0) < 1) return { error: "water_manager_or_turn_unavailable" };
      if (!consent || consent.status !== "signed" || consent.boardId !== board.boardId) return { error: "signed_water_turn_required" };
      record = { id: `water-turn:${board.boardId}:${cid}`, status: "active", waterTurn: `${board.boardId}:turn:${cid}`, holderId: cid, lifeIndex, managerId: board.managerId, consentReceiptId: consent.id, signers: clone(consent.signers), boardId: board.boardId, repairCauseId: board.repairCauseId, issuedDay: day, expiresDay: day + 1, locationId: state.character.location };
      ledgers.water.push(record);
    } else if (binding.handler === "realm_foundation_water" && actionId === "issue_alternative_water_permit") {
      const board = boards.water; const well = state.world.dailyServiceBoards?.well || {}; const alternative = well.alternative || {}; const manager = state.world.npcRecords[board.managerId];
      const turn = [...ledgers.water].reverse().find((row) => row.holderId === cid && row.status === "active" && row.expiresDay >= day && row.boardId === board.boardId);
      if (!turn || alternative.status !== "posted" || !alternative.noticeId || manager?.alive !== true || manager.locationId !== state.character.location) return { error: "live_water_turn_posted_alternative_and_manager_required" };
      const permit = { id: `${alternative.noticeId}:permit:${cid}:${day}`, status: "valid", holderId: cid, issuedBy: board.managerId, sourceNoticeId: alternative.noticeId, sourceLocationId: alternative.locationId, issuedDay: day, expiresDay: day + 1, boardId: board.boardId, causeId: turn.id };
      turn.alternativePermit = permit; record = clone(permit);
    } else if (binding.handler === "realm_foundation_debate" && actionId === "borrow_two_public_notes") {
      const library = boards.library; const clerk = state.world.npcRecords[library.clerkId];
      if (library.status !== "open" || library.locationId !== state.character.location || clerk?.alive !== true || clerk.onDuty !== true || clerk.locationId !== state.character.location) return { error: "public_library_or_clerk_unavailable" };
      if (state.character.knowledge?.[state.world.dailyServiceBoards?.archive?.volumeId]?.level !== "public_catalog_read") return { error: "public_note_catalog_not_read" };
      const loans = library.notes.map((note) => ({ id: `note-loan:${note.id}:${cid}`, status: "open", sourceId: note.id, bookId: note.id, borrowerId: cid, lifeIndex, authorId: note.authorId, revision: note.revision, borrowedDay: day, dueDay: day + 7, clerkId: library.clerkId }));
      if (loans.length !== 2 || new Set(loans.map((row) => row.sourceId)).size !== 2 || loans.some((loan) => library.notes.find((note) => note.id === loan.sourceId)?.status !== "available")) return { error: "two_distinct_public_note_copies_required" };
      ledgers.noteLoans.push(...loans); record = loans;
    } else if (binding.handler === "realm_core_craft" && actionId === "reserve_authorized_alchemy_batch") {
      const skill = "r4_skill_dao02"; const permit = state.character.permits?.furnace || {};
      const costs = pack.actions.r4_action_alchemy?.reservedCost || {};
      const recipeReady = Number(state.character.inventory?.r4_item_powder_recipe || 0) > 0;
      if (!state.character.learnedSkills?.includes(skill) || state.character.skillRecords?.[skill]?.lifeIndex !== lifeIndex) return { error: "current_life_dao02_learning_required" };
      if (permit.location !== state.character.location || day > permit.issuedDay + permit.validDays || permit.status === "expired") return { error: "live_furnace_permit_required" };
      if (!recipeReady || Number(state.character.proficiency?.[skill] || 0) < pack.caps.dao02MinimumProficiency) return { error: "authorized_recipe_or_proficiency_missing" };
      if (Number(state.character.inventory?.r4_item_stargrass || 0) < Number(costs.r4_item_stargrass || 1) || Number(state.character.cashWen || 0) < Number(costs.wealth || 0)) return { error: "unstarted_batch_materials_missing" };
      const batch = { id: `prepared-batch:${cid}:${day}`, status: "ready", actorId: cid, lifeIndex, skillId: skill, inputItemId: "r4_item_stargrass", inputQuantity: Number(costs.r4_item_stargrass || 1), preparedDay: day };
      record = { id: batch.id, status: "authorized", actorId: cid, lifeIndex, batch, permit: clone(permit), locationId: state.character.location };
      ledgers.craftBatches ||= []; ledgers.craftBatches.push(record);
    } else if (binding.handler === "realm_core_records" && actionId === "request_contributor_signoff") {
      const board = boards.research; const partner = state.world.npcRecords[board?.contributorId];
      const batches = (state.world.craftBatchLedger || []).filter((row) => row.actorId === cid && row.lifeIndex === lifeIndex && ["completed", "failed"].includes(row.status));
      const batch = batches.at(-1);
      const review = [...(state.world.researchReviews || [])].reverse().find((row) => batch && row.recordId === batch.id && row.playerId === cid && row.contributorId === board.contributorId && row.lifeIndex === lifeIndex && row.status === "completed");
      const consent = (partner?.contributionConsentRecords || []).find((row) => review && row.status === "signed" && row.signerId === partner.id && row.recordId === batch.id && row.reviewId === review.id && row.lifeIndex === lifeIndex && row.day <= day);
      if (partner?.alive !== true || !batch || !review || !consent) return { error: "dated_same_batch_joint_review_and_explicit_contributor_consent_missing" };
      record = { id: `contribution:${batch.id}:${cid}:${partner.id}`, contributionRecord: `contribution:${batch.id}:${cid}:${partner.id}`, status: "signed", actorId: cid, contributorId: partner.id, lifeIndex, batchId: batch.id, signedBy: [cid, partner.id], day, review: clone(review), consent: clone(consent), consentSourceId: consent.id };
      ledgers.contributions ||= []; ledgers.contributions.push(record);
    } else if (binding.handler === "realm_core_supply" && actionId === "prepare_owned_batch_lease_quote") {
      const permit = state.character.permits?.furnace || {};
      const lease = (state.world.rentalLedger || []).find((row) => row.leaseId === permit.leaseId && row.tenantId === cid && row.status === "active" && row.dueDay <= day);
      const lot = (state.character.inventoryLedger?.r4_item_stargrass || []).find((row) => row.quantity > 0 && row.ownership === "owned");
      const vendor = state.world.npcRecords.r4_npc_market_vendor;
      if (!lease || !lot || Number(state.character.inventory?.r4_item_stargrass || 0) < 1 || vendor?.alive !== true || vendor.onDuty !== true || vendor.locationId !== state.character.location) return { error: "owned_herb_batch_due_lease_or_live_vendor_required" };
      const quoteResult = issueQuote({ marketId: state.character.location, itemId: "r4_item_stargrass", quantity: 1, side: "sell", sourceId: lot.sourceId });
      if (quoteResult?.kind !== "quote") return { error: quoteResult?.error || "valid_vendor_quote_required" };
      const quote = state.quotes[quoteResult.quote.id];
      const ownedBatch = { id: lot.sourceId, status: "owned", itemId: "r4_item_stargrass", ownerId: cid, quantity: 1, sourceDay: lot.acquiredDay, sourceRecord: clone(lot) };
      const leaseNotice = { id: lease.leaseId, status: "due", amount: lease.amount, dueDay: lease.dueDay, overdueDays: day - lease.dueDay, landlordApproval: lease.extensionOffer?.status === "preapproved" && lease.extensionOffer?.signedBy === lease.ownerId, ownerId: lease.ownerId, tenantId: cid, extensionOffer: clone(lease.extensionOffer || {}) };
      record = { id: quote.id, status: "open", ownedBatch, leaseNotice, validQuote: { id: quote.id, ownerId: cid, ownerCharacterId: cid, itemId: quote.itemId, quantity: quote.quantity, totalWealth: quote.totalWealth, valid: true, expiresDay: quote.expiryDay, expiryDay: quote.expiryDay, marketId: quote.marketId }, lease: clone(lease), createdDay: day, expiresDay: quote.expiryDay, locationId: state.character.location };
      ledgers.vendorQuotes ||= []; ledgers.vendorQuotes.push(record);
    } else if (binding.handler === "realm_ascendant_seedarchive" && actionId === "author_verified_method") {
      const practice = [...(state.character.skillPracticeLedger || [])].reverse().find((row) => row.lifeIndex === lifeIndex && state.character.learnedSkills?.includes(row.skillId));
      if (!practice) return { error: "current_life_real_skill_practice_required" };
      const method = { id: `method:${cid}:${lifeIndex}:${day}`, status: "draft", ownerId: cid, authorId: cid, lifeIndex, sourceSkillId: practice.skillId, sourcePracticeId: practice.id, sourceDay: practice.day, steps: ["practice only the publicly documented basic sequence", "stop when the recorded safety limit is reached"], privateContent: false, version: 1, coauthors: [] };
      (state.character.ownedPublicMethods ||= []).push(method); (state.world.methodAuthorshipLedger ||= []).push({ id: method.id, ownerId: cid, sourcePracticeId: practice.id, day, causeId: `author-method:${method.id}` });
      record = method;
    } else return { error: "unsupported_realm_preparation_action" };
    const records = Array.isArray(record) ? record : [record];
    for (const row of records) row.progressionCauseId = progressionProof.causeId;
    const ids = records.map((row) => row.id);
    state.causeLog.push({ day, operation: "realm_preparation_committed", eventId, actionId, sourceIds: ids, lifeIndex, progressionCauseId: progressionProof.causeId });
    return { status: "committed", record: clone(record), day };
  }

  function readPublicArchiveCatalog() {
    const board = state.world.dailyServiceBoards?.archive;
    const clerk = state.world.npcRecords?.r4_npc_han_jian;
    if (state.character.location !== "r4_loc_willow_market") return { error: "required_location_not_reached" };
    if (board?.status !== "open" || board.sealStatus !== "unsealed" || clerk?.alive !== true || clerk.onDuty !== true || clerk.locationId !== state.character.location) return { error: "archive_catalog_unavailable" };
    const volumeId = board.volumeId;
    if (!volumeId) return { error: "public_catalog_id_missing" };
    state.character.knowledge[volumeId] = { level: "public_catalog_read", sourceId: volumeId, acquiredDay: state.worldDay, characterId: state.character.id };
    state.facts.r4_fact_character_knowledge ||= {};
    state.facts.r4_fact_character_knowledge[volumeId] = { level: "public_catalog_read", sourceId: volumeId, day: state.worldDay, characterId: state.character.id };
    return { status: "committed", volumeId, clerkId: clerk.id, day: state.worldDay };
  }

  function applyRealmBusinessChoice(event, option, success, tx) {
    const binding = event.runtimeBinding || {};
    if (binding.kind !== "realm_source") return null;
    const source = realmSourceFor(event);
    const day = state.worldDay;
    const action = option.runtimeAction;
    const causeId = `${tx.transactionId}:${action}`;
    const row = { id: causeId, eventId: event.id, optionId: option.id, action, actorId: state.character.id, lifeIndex: Number(state.character.lifeIndex || 1), day, sourceId: source.sourceId, status: success ? "committed" : "committed_failure" };
    const operations = state.world.realmOperations[binding.handler] ||= [];
    if (!success) {
      source.status = "resolved"; source.resolvedDay = day;
      source.lastFailure = { optionId: option.id, day };
      source.resolution = clone(row); operations.push(clone(row));
      state.world.realmEventFollowups[binding.sourcePath.split(".").at(-1)] ||= [];
      state.world.realmEventFollowups[binding.sourcePath.split(".").at(-1)].push(clone(row));
      return row;
    }
    const evidence = source.evidence || {};
    if (action === "realm_qi_practice" || action === "realm_watch_practice") {
      const practiceTransactionId = evidence.practiceTransactionId;
      const practiceLedger = state.actionTransactionLedger?.[practiceTransactionId];
      const practiceRecord = state.character.actionLog?.find((entry) => entry.transactionId === practiceTransactionId && entry.actionId === "r4_action_practice" && entry.outcome === "success");
      if (!practiceTransactionId || practiceLedger?.status !== "completed" || !practiceRecord || practiceRecord.skillId !== (evidence.skillId || practiceRecord.skillId)) throw new Error("completed_current_life_practice_action_transaction_required");
      row.practiceTransactionId = practiceTransactionId; row.practiceDay = practiceRecord.worldDay; row.practiceDurationDays = practiceRecord.durationDays;
      if (action === "realm_watch_practice") {
        const duty = (state.world.realmActionLedgers.duties || []).find((item) => item.dutyReceipt === source.dutyReceipt && item.actorId === state.character.id && item.lifeIndex === Number(state.character.lifeIndex || 1));
        if (!duty || !evidence.consentReceiptId) throw new Error("current_consented_duty_required_for_substitute_practice");
        duty.status = "completed_with_substitute"; duty.substituteId = duty.householdMemberId; duty.completedDay = day;
        evidence.status = duty.status; evidence.substituteId = duty.substituteId;
        row.duty = clone(duty);
      }
      state.facts.r4_fact_realm_practice ||= [];
      state.facts.r4_fact_realm_practice.push({ id: causeId, actorId: state.character.id, skillId: practiceRecord.skillId, day: practiceRecord.worldDay, sourceId: source.sourceId, actionTransactionId: practiceTransactionId });
    } else if (action === "realm_qi_water_shift") {
      const receipt = { id: causeId, status: "fulfilled", workerId: state.character.id, taskId: `${source.sourceId}:water-shift`, day, locationId: state.character.location, causeId: source.sourceId };
      (state.world.workReceipts ||= []).push(receipt); state.character.lastWorkDay = day; row.workReceipt = receipt;
    } else if (action === "realm_qi_plan") {
      const teacher = state.world.npcRecords[evidence.teacherId];
      const plan = { id: causeId, ownerId: state.character.id, skillId: evidence.skillId, status: teacher?.alive === true && teacher.locationId === state.character.location ? "reviewed" : "draft", reviewerId: teacher?.alive === true && teacher.locationId === state.character.location ? teacher.id : null, day };
      (state.character.studyPlans ||= []).push(plan); row.plan = plan;
    } else if (["realm_lesson_confirm", "realm_lesson_yield", "realm_lesson_observe"].includes(action)) {
      const registration = state.world.realmActionLedgers.registrations.find((item) => item.registrationReceipt === evidence.registrationReceipt && item.studentId === state.character.id);
      if (!registration) throw new Error("current_owned_course_registration_required");
      registration.status = { realm_lesson_confirm: "seat_confirmed", realm_lesson_yield: "yielded_to_waiter", realm_lesson_observe: "observed_public_portion" }[action];
      registration.resolvedDay = day;
      if (action === "realm_lesson_yield") registration.seatAssignedTo = registration.waiterId;
      row.registration = clone(registration);
    } else if (["realm_watch_take", "realm_watch_share"].includes(action)) {
      const duty = state.world.realmActionLedgers.duties.find((item) => item.dutyReceipt === source.dutyReceipt && item.actorId === state.character.id);
      if (!duty) throw new Error("current_owned_duty_record_required");
      if (action === "realm_watch_take") { duty.status = "completed_by_actor"; duty.completedDay = day; state.character.lastDutyDay = day; }
      else {
        const schedule = { id: causeId, status: "shared", signers: [state.character.id, duty.householdMemberId], consentReceiptId: duty.consentReceiptId, day };
        (state.world.householdSchedules ||= []).push(schedule); duty.status = "shared_rotation"; duty.scheduleId = schedule.id;
      }
      row.duty = clone(duty);
    } else if (action === "realm_room_repair") {
      evidence.repairMaterials.stock -= 1;
      state.world.homes ||= {}; state.world.homes[evidence.homeId] ||= {}; state.world.homes[evidence.homeId].condition = "repaired";
      row.homeId = evidence.homeId; row.repairPermitId = evidence.repairPermit.id;
    } else if (action === "realm_room_move") {
      const occupancy = state.world.realmServiceBoards.housing.occupancy ||= {};
      Object.assign(occupancy, { tenantId: state.character.id, roomId: evidence.vacantRoom.id, status: "occupied", startDay: day });
      row.roomId = evidence.vacantRoom.id;
    } else if (action === "realm_room_share_watch") {
      const schedule = { id: causeId, status: "shared_watch", signers: clone(evidence.roommateOffer.signers), consentReceiptId: evidence.roommateOffer.consentReceiptId, day };
      (state.world.householdSchedules ||= []).push(schedule); row.schedule = schedule;
    } else if (["realm_water_test", "realm_water_alternative", "realm_water_audit"].includes(action)) {
      const well = state.world.dailyServiceBoards.well;
      if (action === "realm_water_test") {
        const inspection = { id: causeId, status: "inspected", repairCauseId: evidence.repairCauseId, inspectorId: state.character.id, day, finding: "sand_in_bucket" };
        (well.maintenanceRecords ||= []).push(inspection); well.ropeStatus = "damaged"; row.inspection = inspection;
      } else if (action === "realm_water_alternative") {
        const permit = evidence.alternativePermit;
        if (permit.status !== "valid" || permit.holderId !== state.character.id || permit.expiresDay < day) throw new Error("current_authorized_alternative_water_source_required");
        const receipt = { id: causeId, status: "fulfilled", holderId: state.character.id, sourceId: permit.sourceNoticeId, day };
        (state.world.waterReceipts ||= []).push(receipt); row.waterReceipt = receipt;
      } else {
        const audit = { id: causeId, status: "jointly_recorded", managerId: evidence.managerId, signers: clone(evidence.signers), repairCauseId: evidence.repairCauseId, day };
        (well.auditRecords ||= []).push(audit); row.audit = audit;
      }
    } else if (["realm_notes_compare", "realm_notes_ask_author", "realm_notes_return"].includes(action)) {
      if (action === "realm_notes_compare") {
        const comparison = { id: causeId, sourceIds: (source.loanReceipts || []).map((loan) => loan.sourceId), status: "provenance_compared", createsSkill: false, day };
        state.facts.r4_fact_note_comparisons ||= []; state.facts.r4_fact_note_comparisons.push(comparison); row.comparison = comparison;
      } else if (action === "realm_notes_ask_author") {
        const authorId = source.loanReceipts?.[0]?.authorId;
        const answer = { id: causeId, status: "answered", authorId, questionerId: state.character.id, sourceNoteIds: source.loanReceipts.map((loan) => loan.sourceId), day };
        state.facts.r4_fact_author_answers ||= []; state.facts.r4_fact_author_answers.push(answer); row.answer = answer;
      } else {
        const returned = [];
        for (const loan of source.loanReceipts || []) {
          const actual = state.world.realmActionLedgers.noteLoans.find((item) => item.id === loan.id && item.borrowerId === state.character.id && item.status === "open");
          if (!actual) throw new Error("current_authoritative_note_loan_required");
          actual.status = "returned"; actual.returnedDay = day; loan.status = "returned"; loan.returnedDay = day; returned.push(loan.id);
        }
        state.character.borrowerStanding = Number(state.character.borrowerStanding || 0) + 1; row.returnedLoanIds = returned;
      }
    } else if (["realm_craft_finish", "realm_craft_log", "realm_craft_yield"].includes(action)) {
      const prepared = (state.world.realmActionLedgers.craftBatches || []).find((item) => item.id === source.sourceId && item.actorId === state.character.id && item.lifeIndex === Number(state.character.lifeIndex || 1) && item.status === "authorized");
      const batch = prepared?.batch; const sourceBatch = source.batch;
      if (!prepared || batch?.status !== "ready" || batch.actorId !== state.character.id || batch.lifeIndex !== Number(state.character.lifeIndex || 1)) throw new Error("authorized_current_life_ready_batch_required");
      if (action === "realm_craft_finish") {
        const actionTransactionId = source.evidence?.actionTransactionId;
        const actionLedger = state.actionTransactionLedger?.[actionTransactionId];
        const actual = (state.world.craftBatchLedger || []).find((item) => item.actionTransactionId === actionTransactionId && item.actorId === state.character.id && item.lifeIndex === Number(state.character.lifeIndex || 1) && ["completed", "failed"].includes(item.status));
        const actionLog = (state.character.actionLog || []).find((item) => item.transactionId === actionTransactionId && item.actionId === "r4_action_alchemy");
        if (!actionTransactionId || actionLedger?.status !== "completed" || !actual || !actionLog || actual.outcome !== actionLog.outcome) throw new Error("completed_formal_alchemy_transaction_required");
        batch.status = actual.status; batch.completedDay = actual.day; batch.causeId = actual.causeId; batch.actualOutcome = actual.outcome; batch.actionTransactionId = actionTransactionId;
        Object.assign(sourceBatch, clone(batch));
        prepared.status = "resolved"; prepared.resolvedDay = day;
        row.batchId = batch.id; row.actionTransactionId = actionTransactionId; row.actualAlchemyOutcome = actual.outcome; row.productId = actual.outcome === "success" ? actual.itemId : null;
        row.productCreated = actual.outcome === "success";
      } else if (action === "realm_craft_log") {
        batch.status = "paused_for_observation"; batch.pausedDay = day; batch.pausedBy = state.character.id;
        Object.assign(sourceBatch, clone(batch));
        prepared.status = "paused_for_observation"; prepared.resolvedDay = day;
        row.batchId = batch.id; row.productCreated = false;
        (state.world.alchemyObservationLog ||= []).push({ id: causeId, batchId: batch.id, actorId: state.character.id, lifeIndex: batch.lifeIndex, day, status: "paused_for_observation" });
      } else {
        const queue = state.world.publicSchedules?.kilnQueue || {};
        if (!queue.reservationId || !["booked", "retained_with_risk"].includes(queue.reservationStatus)) throw new Error("active_kiln_reservation_required");
        queue.reservationStatus = "yielded_for_repair"; queue.yieldedBy = state.character.id; queue.yieldedDay = day;
        batch.status = "deferred_for_repair"; batch.deferredDay = day; prepared.status = "deferred_for_repair"; prepared.resolvedDay = day;
        Object.assign(sourceBatch, clone(batch));
        row.batchId = batch.id; row.reservationId = queue.reservationId; row.reservationStatus = queue.reservationStatus; row.productCreated = false;
      }
    } else if (["realm_supply_sell", "realm_supply_extend", "realm_supply_decline"].includes(action)) {
      const batch = source.ownedBatch; const notice = source.leaseNotice; const lease = (state.world.rentalLedger || []).find((item) => item.leaseId === notice.id && item.tenantId === state.character.id);
      const quote = state.quotes?.[source.validQuote?.id];
      if (!batch || !lease || lease.status !== "active" || lease.dueDay > day) throw new Error("current_due_owned_furnace_lease_required");
      if (action === "realm_supply_sell") {
        const lot = (state.character.inventoryLedger?.[batch.itemId] || []).find((item) => item.sourceId === batch.id && item.ownership === "owned" && item.quantity >= batch.quantity);
        if (!lot || batch.ownerId !== state.character.id || batch.itemId !== "r4_item_stargrass" || Number(state.character.inventory?.[batch.itemId] || 0) < batch.quantity || !quote || quote.receipt || quote.expiryDay < day || quote.ownerId !== state.character.id || quote.totalWealth < lease.amount || quote.itemId !== batch.itemId || quote.quantity !== batch.quantity || quote.inventoryLotSelections?.length !== 1 || quote.inventoryLotSelections[0]?.sourceId !== batch.id || quote.inventoryLotSelections[0]?.quantity !== batch.quantity) throw new Error("owned_dated_batch_and_live_quote_covering_rent_required");
        const sale = settleQuote(quote.id);
        if (sale.kind !== "receipt") throw new Error(sale.error || "owned_batch_sale_failed");
        lot.lastSoldDay = sale.receipt.day;
        state.character.cashWen -= lease.amount;
        const term = Math.max(1, lease.dueDay - lease.issuedDay);
        const oldDueDay = lease.dueDay;
        lease.lastPaidDay = day; lease.lastRentReceiptId = causeId; lease.dueDay = day + term;
        Object.assign(state.character.permits.furnace, { status: "valid", issuedDay: day, validDays: term, leaseId: lease.leaseId });
        Object.assign(notice, { status: "rent_settled", lastPaidDay: day, dueDay: lease.dueDay, rentReceiptId: causeId });
        source.lease = clone(lease);
        const businessRecord = (state.world.realmActionLedgers.vendorQuotes || []).find((item) => item.id === source.sourceId);
        if (businessRecord) businessRecord.status = "settled";
        row.itemId = batch.itemId; row.quantity = batch.quantity; row.proceeds = quote.totalWealth; row.rentPaid = lease.amount; row.saleReceiptId = sale.receipt.id; row.oldDueDay = oldDueDay; row.newDueDay = lease.dueDay;
      } else if (action === "realm_supply_extend") {
        const approval = lease.extensionOffer || {};
        if (approval.status !== "preapproved" || approval.leaseId !== lease.leaseId || approval.tenantId !== state.character.id || approval.ownerId !== lease.ownerId || approval.signedBy !== lease.ownerId || !Number.isInteger(approval.termDays) || approval.termDays < 1 || approval.expiresDay < day) throw new Error("current_lease_owner_signed_extension_required");
        lease.dueDay = Math.max(lease.dueDay, day) + approval.termDays;
        Object.assign(notice, { status: "extended", dueDay: lease.dueDay, extensionApproval: clone(approval) });
        Object.assign(state.character.permits.furnace, { status: "valid", leaseId: lease.leaseId, issuedDay: day, validDays: approval.termDays });
        lease.extensionOffer = { ...clone(approval), status: "consumed", consumedDay: day, consumedBy: state.character.id };
        notice.extensionApproval = clone(lease.extensionOffer); source.lease = clone(lease); row.lease = clone(notice);
        const businessRecord = (state.world.realmActionLedgers.vendorQuotes || []).find((item) => item.id === source.sourceId);
        if (businessRecord) businessRecord.status = "extended";
      } else {
        lease.status = "expired"; lease.closedDay = day; notice.status = "expired"; source.lease.status = "expired";
        if (state.character.permits.furnace?.leaseId === lease.leaseId) state.character.permits.furnace.status = "expired";
        batch.retainedAfterExit = batch.ownerId === state.character.id; row.batchRetained = batch.retainedAfterExit;
        const businessRecord = (state.world.realmActionLedgers.vendorQuotes || []).find((item) => item.id === source.sourceId);
        if (businessRecord) businessRecord.status = "closed_declined";
        if (quote && !quote.receipt) { quote.valid = false; quote.cancelledDay = day; }
      }
      row.leaseId = lease.leaseId; row.dueDay = lease.dueDay; row.wealthAfter = state.character.cashWen; row.batchOwnerId = batch.ownerId;
    } else if (["realm_record_append", "realm_record_anonymize", "realm_record_leave"].includes(action)) {
      const contribution = (state.world.realmActionLedgers.contributions || []).find((item) => item.id === source.sourceId && item.status === "signed" && item.actorId === state.character.id && item.lifeIndex === Number(state.character.lifeIndex || 1) && item.batchId === evidence.batchId);
      const record = (state.world.researchRecords || []).find((item) => item.id === evidence.batchId);
      const consent = evidence.consent || {};
      if (!contribution || !record || record.reviewId !== evidence.review?.id || consent.status !== "signed" || consent.recordId !== record.id || consent.signerId !== evidence.contributorId || consent.reviewId !== evidence.review?.id) throw new Error("current_joint_reviewed_contribution_record_required");
      if (action === "realm_record_append") {
        if (record.contributorNote) throw new Error("contributor_note_already_appended");
        record.contributorNote = { contributorId: evidence.contributorId, consentId: consent.id, reviewId: evidence.review.id, day };
        row.recordId = record.id; row.contributorNote = clone(record.contributorNote);
      } else if (action === "realm_record_anonymize") {
        if (record.methodPublic) throw new Error("method_already_published");
        record.methodPublic = true; record.privateNamesRedacted = [state.character.id, evidence.contributorId]; record.methodPublishedDay = day;
        row.recordId = record.id; row.publication = "method_only"; row.privateNamesRedacted = clone(record.privateNamesRedacted);
      } else {
        if (record.status === "unchanged_after_review") throw new Error("record_already_left_unchanged");
        record.status = "unchanged_after_review"; record.reviewedDay = day;
        row.recordId = record.id; row.reviewedStatus = record.status;
      }
    } else if (["realm_soul_witness_listen", "realm_soul_witness_compare", "realm_soul_witness_decline"].includes(action)) {
      const invitation = evidence.invitation || {};
      const producer = (state.world.realmActionLedgers.highRealmRequests || []).find((item) => item.id === source.sourceId && item.handler === "realm_soul_witness" && item.actorId === state.character.id && item.lifeIndex === Number(state.character.lifeIndex || 1));
      const witness = state.world.npcRecords?.[invitation.invitedBy];
      const liveInvitation = witness?.witnessInvitations?.find((item) => item.id === invitation.id && item.evidenceRef === invitation.evidenceRef);
      const receipt = state.world.quoteReceipts?.[invitation.evidenceRef];
      if (!producer || !liveInvitation || liveInvitation.status !== "offered" || liveInvitation.expiresDay < day || receipt?.status !== "committed" || !evidence.evidenceRefs?.includes(invitation.evidenceRef)) throw new Error("current_voluntary_witness_invitation_and_committed_public_transaction_required");
      if (action === "realm_soul_witness_listen") {
        liveInvitation.status = "accepted_for_hearing"; liveInvitation.acceptedBy = state.character.id; liveInvitation.acceptedDay = day;
        const statement = { id: causeId, speakerId: witness.id, listenerId: state.character.id, evidenceRef: liveInvitation.evidenceRef, scope: "firsthand_market_transaction", day, privacy: "private_account_not_public_fact" };
        (state.world.witnessStatements ||= []).push(statement);
        row.statementId = statement.id; row.evidenceRef = statement.evidenceRef; row.privacy = statement.privacy;
      } else if (action === "realm_soul_witness_compare") {
        const publicPages = state.world.highRealmBoards?.archive?.publicPages || [];
        const comparison = { id: causeId, evidenceRef: liveInvitation.evidenceRef, publicPageIds: publicPages.map((page) => page.id), result: "date_checked_against_public_index", day };
        (state.world.highRealmBoards.archive.comparisons ||= []).push(comparison);
        row.comparisonId = comparison.id; row.evidenceRef = comparison.evidenceRef; row.result = comparison.result;
      } else {
        liveInvitation.status = "declined"; liveInvitation.declinedBy = state.character.id; liveInvitation.declinedDay = day;
        row.result = "private_account_declined";
      }
    } else if (["realm_soul_archive_request", "realm_soul_archive_metadata", "realm_soul_archive_review"].includes(action)) {
      const archive = state.world.highRealmBoards?.archive;
      const producer = (state.world.realmActionLedgers.highRealmRequests || []).find((item) => item.id === source.sourceId && item.handler === "realm_soul_archive" && item.actorId === state.character.id && item.lifeIndex === Number(state.character.lifeIndex || 1));
      const page = archive?.sealedPages?.find((item) => item.id === producer?.pageId);
      const authorization = page?.authorization || {}; const consent = producer?.authorization || {};
      if (!producer || producer.personId !== page?.subjectId || source.evidence?.pageId !== page?.id || source.evidence?.authorization?.id !== authorization.id || page.status !== "sealed" || page.contentStored !== false || authorization.status !== "valid" || authorization.id !== consent.id || authorization.pageId !== page.id || authorization.signerId !== page.subjectId || consent.status !== "signed" || consent.signerId !== page.subjectId || consent.pageId !== page.id || consent.scope !== "read_subject_page_once" || authorization.expiresDay < day) throw new Error("current_subject_authorized_sealed_page_required");
      if (action === "realm_soul_archive_request") {
        const request = { id: causeId, pageId: page.id, requestorId: state.character.id, subjectId: page.subjectId, status: "pending", scope: "read_sealed_text", day };
        (archive.permissionRequests ||= []).push(request); row.requestId = request.id;
      } else if (action === "realm_soul_archive_metadata") {
        const item = { id: causeId, pageId: page.id, date: authorization.issuedDay, volume: "local archive", textCopied: false, public: true, day };
        (archive.metadataIndex ||= []).push(item); row.metadataId = item.id;
      } else {
        const review = { id: causeId, pageId: page.id, status: "sealed_pending_independent_review", submittedBy: state.character.id, day, textAccess: false };
        (archive.reviewQueue ||= []).push(review); row.reviewId = review.id;
      }
      row.textAccess = false; row.pageStatus = page.status; row.pageId = page.id;
    } else if (["realm_soul_care_ask", "realm_soul_care_explain", "realm_soul_care_stepback"].includes(action)) {
      const producer = (state.world.realmActionLedgers.highRealmRequests || []).find((item) => item.id === source.sourceId && item.handler === "realm_soul_care" && item.actorId === state.character.id && item.lifeIndex === Number(state.character.lifeIndex || 1));
      const person = state.world.npcRecords?.[producer?.personId]; const request = person?.currentCareRequest; const pinned = producer?.request || {};
      if (!producer || source.evidence?.personId !== producer.personId || request?.status !== "open" || request.id !== pinned.id || request.requestorId !== person.id || request.decisionOwnerId !== person.id || !Array.isArray(request.alternatives) || !request.alternatives.length || request.kind !== pinned.kind || request.sourceId !== pinned.sourceId || request.expiresDay !== pinned.expiresDay || request.expiresDay < day) throw new Error("current_requestor_owned_care_request_required");
      const care = { id: causeId, requestId: request.id, action, decisionMakerId: person.id, choiceMadeByPlayer: false, day, alternatives: clone(request.alternatives), status: action === "realm_soul_care_ask" ? "priority_requested" : action === "realm_soul_care_explain" ? "tradeoffs_explained" : "player_stepped_back" };
      if (action === "realm_soul_care_ask") care.priorityAnswer = null;
      if (action === "realm_soul_care_explain") care.explanationScope = "requestor_authored_alternatives_only";
      (state.world.careSupportLedger ||= []).push(care);
      (request.supportHistory ||= []).push(clone(care));
      row.careSupportId = care.id; row.requestId = request.id; row.requestStatus = request.status;
      row.decisionOwnerId = request.decisionOwnerId; row.choiceMadeByPlayer = false; row.alternatives = clone(request.alternatives);
    } else if (["realm_void_route_repair", "realm_void_route_escort", "realm_void_route_detour"].includes(action)) {
      const road = state.world.highRealmBoards?.road; const segment = road?.segment;
      const producer = (state.world.realmActionLedgers.highRealmRequests || []).find((item) => item.id === source.sourceId && item.handler === "realm_void_route" && item.actorId === state.character.id && item.lifeIndex === Number(state.character.lifeIndex || 1));
      const permit = segment?.permits?.find((item) => item.id === producer?.permit?.id);
      if (!producer || producer.personId !== "r4_npc_waykeeper" || !permit || permit.status !== "valid" || permit.holderId !== state.character.id || permit.issuedBy !== "r4_npc_waykeeper" || permit.expiresDay < day || segment?.ownerId !== "public" || segment.status !== "closed" || segment.id !== producer.notice?.id || segment.causeId !== producer.notice?.causeId || segment.causeId !== permit.causeId) throw new Error("current_public_segment_and_waykeeper_permit_required");
      if (action === "realm_void_route_repair") {
        if (road.repairStock < 1) throw new Error("public_repair_stock_required");
        road.repairStock -= 1; segment.status = "repaired_open"; segment.repairedDay = day; segment.repairReceiptId = causeId; permit.status = "consumed"; producer.permit.status = "consumed";
        const receipt = { id: causeId, actorId: state.character.id, segmentId: segment.id, status: "completed", day, materials: [road.repairStockSourceId], public: true };
        (road.repairLedger ||= []).push(receipt); row.repairReceiptId = receipt.id; row.materialSourceId = road.repairStockSourceId;
      } else if (action === "realm_void_route_escort") {
        const shipment = road.publicShipment;
        if (shipment?.status !== "verified_waiting" || shipment.ownerId !== "r4_npc_market_vendor" || shipment.currentCarrierId !== shipment.ownerId || !shipment.proofId || (shipment.expiresDay != null && shipment.expiresDay < day)) throw new Error("current_verified_public_shipment_required");
        shipment.status = "delivered"; shipment.escortedBy = state.character.id; shipment.deliveredDay = day; shipment.receiptId = causeId;
        const receipt = { id: causeId, shipmentId: shipment.id, proofId: shipment.proofId, actorId: state.character.id, ownerId: shipment.ownerId, origin: shipment.origin, destination: shipment.destination, status: "delivered", day };
        (road.shipmentReceipts ||= []).push(receipt); row.shipmentId = shipment.id; row.shipmentReceiptId = receipt.id; row.roadRemainsClosed = segment.status === "closed";
      } else {
        const detour = { id: causeId, segmentId: segment.id, verifiedFromCause: producer.notice.causeId, publishedBy: state.character.id, publishedDay: day, expiresDay: day + 7, status: "public", ownerId: "public" };
        (road.detours ||= []).push(detour); segment.publishedDetourId = detour.id; row.detourId = detour.id; row.detourExpiresDay = detour.expiresDay;
      }
      row.routeId = segment.id; row.roadOwnershipGranted = false;
      row.workStatus = action === "realm_void_route_repair" ? "repair_contributed" : action === "realm_void_route_escort" ? "shipment_escorted" : "verified_detour_published";
    } else if (["realm_void_map_correct", "realm_void_map_permission", "realm_void_map_private"].includes(action)) {
      const road = state.world.highRealmBoards?.road; const segment = road?.segment;
      const producer = (state.world.realmActionLedgers.highRealmRequests || []).find((item) => item.id === source.sourceId && item.handler === "realm_void_map" && item.actorId === state.character.id && item.lifeIndex === Number(state.character.lifeIndex || 1));
      const oldMap = producer?.map; const liveMap = road?.publishedMaps?.find((item) => item.id === oldMap?.id && item.ownerId === "public" && item.version === oldMap?.version);
      const observation = state.world.travelObservations?.find((item) => item.id === producer?.observation?.id && item.actorId === state.character.id && item.lifeIndex === Number(state.character.lifeIndex || 1));
      const newer = road?.publishedMaps?.some((item) => item.ownerId === "public" && item.version > oldMap?.version && item.publishedDay <= day);
      if (!producer || producer.personId !== "r4_npc_han_archive" || !liveMap || source.evidence?.map?.id !== liveMap.id || source.evidence?.map?.version !== liveMap.version || newer || state.character.publicMaps?.[segment?.id]?.id !== liveMap.id || state.character.publicMaps?.[segment?.id]?.ownerId !== "public" || !observation || observation.segmentId !== segment.id || observation.status !== segment.status || observation.causeId !== segment.causeId || observation.source !== "observed_public_notice" || segment.ownerId !== "public") throw new Error("current_public_map_copy_and_matching_route_observation_required");
      if (action === "realm_void_map_correct") {
        const corrected = { id: `${road.id}:map:v${liveMap.version + 1}`, ownerId: "public", version: liveMap.version + 1, publishedDay: day, segments: [{ id: segment.id, status: observation.status, verifiedDay: observation.day, causeId: observation.causeId, observationId: observation.id }], correctsMapId: liveMap.id };
        (road.publishedMaps ||= []).push(corrected); (state.character.publicMaps ||= {})[segment.id] = clone(corrected);
        row.mapVersion = corrected.version; row.publishedMapId = corrected.id;
      } else if (action === "realm_void_map_permission") {
        const officer = state.world.npcRecords?.r4_npc_waykeeper;
        if (officer?.alive !== true || officer.onDuty !== true || officer.locationId !== state.character.location || state.world.factions?.r4_faction_waykeepers?.guideService !== true) throw new Error("current_public_owner_officer_authority_required");
        const request = { id: causeId, mapId: liveMap.id, segmentId: segment.id, requestorId: state.character.id, ownerId: segment.ownerId, authorizedOfficerId: officer.id, observationId: observation.id, status: "pending", day, travelGranted: false };
        (road.mapRequests ||= []).push(request); row.permissionRequestId = request.id;
      } else {
        const note = { id: causeId, ownerId: state.character.id, mapId: liveMap.id, segmentId: segment.id, observationId: observation.id, observedStatus: observation.status, observedCauseId: observation.causeId, public: false, safeForNavigation: false, day };
        (state.character.privateRouteNotes ||= []).push(note); row.privateNoteId = note.id;
      }
      row.public = action === "realm_void_map_correct"; row.navigationAuthorized = false; row.observationId = observation.id; row.segmentId = segment.id;
    } else if (["realm_void_move_register", "realm_void_move_tools", "realm_void_move_pause"].includes(action)) {
      const move = state.world.highRealmBoards?.facilityMove;
      const producer = (state.world.realmActionLedgers.highRealmRequests || []).find((item) => item.id === source.sourceId && item.handler === "realm_void_relocation" && item.actorId === state.character.id && item.lifeIndex === Number(state.character.lifeIndex || 1));
      const receipt = move?.custodyReceipt;
      const itemName = action === "realm_void_move_register" ? "public_register" : action === "realm_void_move_tools" ? "communal_tools" : null;
      if (!producer || producer.personId !== "r4_npc_han_archive" || move?.status !== "in_transit" || move.ownerId !== "public" || move.custodianId !== producer.personId || receipt?.status !== "entrusted" || receipt.custodianId !== state.character.id || receipt.ownerId !== "public" || receipt.expiresDay < day || receipt.id !== producer.id || producer.move?.id !== move.id || !receipt.privateCargoExcluded || move.departDay <= day) throw new Error("current_public_custody_and_move_required");
      if (itemName) {
        const cargo = move.cargo.find((item) => item.item === itemName && item.ownerId === "public" && item.status === "ready" && item.portable && receipt.cargoIds.includes(item.id));
        if (!cargo) throw new Error("selected_portable_public_cargo_missing");
        const originalLocation = move.locationId;
        cargo.status = "moved"; cargo.currentLocation = move.arrivalLocationId; cargo.movedDay = day; cargo.receiptId = causeId;
        move.locationId = move.arrivalLocationId;
        const movement = { id: causeId, cargoId: cargo.id, item: cargo.item, ownerId: "public", status: "moved", from: originalLocation, to: move.arrivalLocationId, day, custodyReceiptId: receipt.id };
        (move.movementLedger ||= []).push(movement);
        row.cargoMoved = cargo.item; row.cargoId = cargo.id; row.movementReceiptId = movement.id;
      } else {
        move.status = "missed_truck_paused"; move.pausedBy = state.character.id; move.pausedDay = day; move.departureMissed = true;
        row.cargoMoved = null; row.pauseReason = "awaiting_personal_owner_confirmation";
      }
      row.moveId = move.id; row.privateItemsMoved = false; row.moveStatus = move.status;
    } else if (["realm_asc_lesson_teach", "realm_asc_lesson_listen", "realm_asc_lesson_decline"].includes(action)) {
      const venue = state.world.highRealmBoards?.lesson;
      const producer = (state.world.realmActionLedgers.highRealmRequests || []).find((item) => item.id === source.sourceId && item.handler === "realm_ascendant_openlesson" && item.actorId === state.character.id && item.lifeIndex === Number(state.character.lifeIndex || 1));
      const lesson = venue?.sessions?.find((item) => item.id === producer?.lesson?.id);
      const teacher = state.world.npcRecords?.[lesson?.teacherId]; const learnerIds = lesson?.acceptedLearners || [];
      const skillId = state.character.learnedSkills?.find((id) => state.character.skillRecords?.[id]?.lifeIndex === Number(state.character.lifeIndex || 1) && teacher?.taughtSkillIds?.includes(id));
      if (!producer || producer.personId !== "r4_npc_public_teacher" || venue?.status !== "available" || lesson?.status !== "accepted" || lesson.expiresDay < day || teacher?.alive !== true || teacher.onDuty !== true || teacher.locationId !== state.character.location || teacher.openLessonPolicy !== "accept_if_venue_and_learners_are_present" || !learnerIds.length || learnerIds.some((id) => state.world.npcRecords?.[id]?.alive !== true || state.world.npcRecords[id].locationId !== state.character.location || state.world.npcRecords[id].lessonResponsePolicy !== "accept_only_named_public_basics_session") || new Set(venue.roster || []).size > venue.capacity || !lesson.consentReceipts?.includes(`teacher-consent:${lesson.causeId}`) || learnerIds.some((id) => !lesson.consentReceipts?.includes(`learner-consent:${lesson.causeId}`))) throw new Error("current_consented_public_lesson_required");
      if (action === "realm_asc_lesson_teach") {
        if (!skillId) throw new Error("verified_current_life_teacher_skill_required");
        lesson.status = "taught"; lesson.taughtBy = state.character.id; lesson.skillId = skillId; lesson.scope = "verified_public_basics"; lesson.completedDay = day; lesson.attendance = clone(learnerIds);
        for (const learnerId of learnerIds) (state.world.npcRecords[learnerId].publicLearningRecords ||= []).push({ sourceId: lesson.id, skillId, scope: "public_basic_instruction", day });
        row.attendance = learnerIds.length; row.scope = "verified_public_basics"; row.skillId = skillId; row.skillGranted = false;
      } else if (action === "realm_asc_lesson_listen") {
        const course = state.world.realmServiceBoards?.course;
        if (!course?.id || course.teacherId !== teacher.id || course.locationId !== state.character.location) throw new Error("existing_public_course_or_material_required");
        lesson.status = "referred"; lesson.referralId = `${lesson.id}:referral`; lesson.targetCourseId = course.id; lesson.completedDay = day;
        row.attendance = 0; row.scope = "referral_only"; row.referralId = lesson.referralId; row.targetCourseId = course.id; row.skillGranted = false;
      } else {
        lesson.status = "declined"; lesson.declinedBy = state.character.id; lesson.completedDay = day;
        venue.roster = (venue.roster || []).filter((id) => !learnerIds.includes(id));
        (venue.waitlist ||= []).push({ venueId: venue.id, status: "available_to_next_applicant", fromSessionId: lesson.id, day });
        row.attendance = 0; row.scope = "declined"; row.skillGranted = false;
      }
      row.lessonId = lesson.id; row.venueId = venue.id;
    } else if (["realm_asc_seat_accept", "realm_asc_seat_rotation", "realm_asc_seat_decline"].includes(action)) {
      const org = state.world.highRealmBoards?.organization;
      const producer = (state.world.realmActionLedgers.highRealmRequests || []).find((item) => item.id === source.sourceId && item.handler === "realm_ascendant_seat" && item.actorId === state.character.id && item.lifeIndex === Number(state.character.lifeIndex || 1));
      const invitation = org?.invitations?.find((item) => item.id === producer?.invitation?.id);
      const application = org?.candidateRoster?.find((item) => item.id === invitation?.applicationId);
      if (!producer || !invitation || invitation.status !== "issued" || application?.status !== "reviewed" || invitation.candidateId !== state.character.id || org.vacancy?.status !== "open" || invitation.expiresDay < day) throw new Error("current_reviewed_waykeeper_invitation_required");
      if (action === "realm_asc_seat_accept") {
        const appointment = { id: causeId, personId: state.character.id, office: org.vacancy.office, scope: invitation.scope, termDays: invitation.termDays, issuedDay: day, expiresDay: day + invitation.termDays, sourceInvitationId: invitation.id, publicContributionId: application.contributionId, status: "active" };
        org.appointments.push(appointment); org.vacancy.status = "filled"; invitation.status = "accepted"; invitation.resolvedDay = day;
        state.character.organizationAccess ||= {};
        state.character.organizationAccess[org.id] = { status: "appointed", scope: appointment.scope, expiresDay: appointment.expiresDay, causeId };
        row.appointment = clone(appointment); row.privateAssetsGranted = false;
      } else if (action === "realm_asc_seat_rotation") {
        const memberIds = (org.members || ["r4_npc_waykeeper"]).filter((id) => state.world.npcRecords?.[id]?.alive === true);
        if (!memberIds.length) throw new Error("living_member_for_rotation_consultation_missing");
        const proposal = { id: causeId, vacancyId: invitation.vacancyId, proposedBy: state.character.id, termDays: 7, status: "pending_member_consent", memberIds, requiredConsentCount: 1, day, expiresDay: day + 7, sourceInvitationId: invitation.id, scope: invitation.scope };
        org.rotationProposals.push(proposal); invitation.status = "rotation_proposed"; invitation.resolvedDay = day;
        row.rotationProposal = clone(proposal); row.authorityGranted = false;
      } else {
        invitation.status = "declined"; invitation.resolvedDay = day; application.status = "declined";
        row.invitationId = invitation.id; row.invitationStatus = "declined"; row.vacancyRemainsOpen = org.vacancy.status === "open"; row.privateAssetsGranted = false;
      }
      row.applicationId = application.id; row.vacancyId = invitation.vacancyId; row.invitationStatus = invitation.status;
    } else if (["realm_asc_archive_steps", "realm_asc_archive_credit", "realm_asc_archive_private"].includes(action)) {
      const board = state.world.highRealmBoards?.methods;
      const producer = (state.world.realmActionLedgers.highRealmRequests || []).find((item) => item.id === source.sourceId && item.handler === "realm_ascendant_seedarchive" && item.actorId === state.character.id && item.lifeIndex === Number(state.character.lifeIndex || 1));
      const method = state.character.ownedPublicMethods?.find((item) => item.id === producer?.method?.id && item.ownerId === state.character.id && item.authorId === state.character.id && item.lifeIndex === Number(state.character.lifeIndex || 1) && item.status === "draft");
      if (!board || board.status !== "open" || !producer || !method || method.privateContent !== false) throw new Error("owned_current_public_method_draft_required");
      if (action === "realm_asc_archive_credit") {
        const teacher = state.world.npcRecords?.r4_npc_public_teacher;
        const consented = (method.coauthors || []).filter((author) => {
          const consent = state.world.npcRecords?.[author.personId]?.methodAttributionConsents?.find((item) => item.id === author.consentId);
          return consent?.status === "signed" && consent.methodId === method.id && consent.signerId === author.personId && consent.scope === "named_contribution_only" && consent.expiresDay >= day;
        });
        if (consented.length !== (method.coauthors || []).length || !consented.some((author) => author.personId === teacher?.id)) throw new Error("every_named_contributor_must_currently_consent");
      }
      const scope = action === "realm_asc_archive_steps" ? "public_basic_steps_only" : action === "realm_asc_archive_credit" ? "public_steps_with_consented_attribution" : "private_copy_only";
      let entry = null;
      if (action !== "realm_asc_archive_private") {
        entry = { id: causeId, methodId: method.id, authorId: method.authorId, ...(action === "realm_asc_archive_credit" ? { coauthors: (method.coauthors || []).map((row) => row.personId) } : {}), steps: clone(method.steps), sourceSkillId: method.sourceSkillId, scope, version: method.version, day, thirdPartyContent: false };
        board.entries.push(entry); method.status = action === "realm_asc_archive_credit" ? "published_attributed" : "published_steps";
      } else method.status = "private";
      row.methodId = method.id; row.publication = action === "realm_asc_archive_steps" ? "steps_only" : action === "realm_asc_archive_credit" ? "attributed" : "private";
      row.entryId = entry?.id || null; row.scope = scope; row.skillGranted = false; row.thirdPartyContentPublished = false;
    } else throw new Error(`unsupported_realm_choice_action:${action}`);
    operations.push(clone(row));
    source.status = "resolved"; source.resolvedDay = day;
    source.resolution = { status: "committed_success", optionId: option.id, action, day, causeId, operation: clone(row) };
    state.world.realmEventFollowups[binding.sourcePath.split(".").at(-1)] ||= [];
    state.world.realmEventFollowups[binding.sourcePath.split(".").at(-1)].push(clone(row));
    state.world.worldOutcomes[event.id] = { eventId: event.id, optionId: option.id, outcomeId: option.outcomeIds?.success || null, causeId: source.causeId, sourceId: source.id, lifeIndex: Number(state.character.lifeIndex || 1), day, operationId: row.id };
    return row;
  }

  function openRealmEventSource(eventId) {
    const event = eventById.get(eventId); const binding = event?.runtimeBinding;
    if (binding?.kind !== "realm_source") return { error: "unknown_realm_source" };
    if (!currentRealmProgressionProof()) return { error: "current_life_successful_progression_required" };
    if (state.character.location !== binding.locationId) return { error: "required_location_not_reached" };
    const ledgers = state.world.realmActionLedgers; const handler = binding.handler; const cid = state.character.id; const day = state.worldDay;
    const progressionProof = currentRealmProgressionProof();
    if (!progressionProof) return { error: "current_life_successful_progression_required" };
    let record;
    if (handler === "realm_qi_routine") record = [...ledgers.registrations].reverse().find((row) => row.actorId === cid && row.status === "accepted" && row.lifeIndex === Number(state.character.lifeIndex || 1) && row.progressionCauseId === progressionProof.causeId);
    else if (handler === "realm_qi_breathlesson") record = [...ledgers.registrations].reverse().find((row) => row.studentId === cid && row.status === "registered" && row.expiresDay >= day && row.progressionCauseId === progressionProof.causeId);
    else if (handler === "realm_qi_sleep") record = [...ledgers.duties].reverse().find((row) => row.actorId === cid && row.status === "accepted" && row.dueDay >= day && row.progressionCauseId === progressionProof.causeId);
    else if (handler === "realm_foundation_shelter") record = [...ledgers.housing].reverse().find((row) => row.managerId === cid && row.lifeIndex === Number(state.character.lifeIndex || 1) && row.status === "authorized" && row.expiresDay >= day && row.progressionCauseId === progressionProof.causeId);
    else if (handler === "realm_foundation_water") record = [...ledgers.water].reverse().find((row) => row.holderId === cid && row.lifeIndex === Number(state.character.lifeIndex || 1) && row.status === "active" && row.expiresDay >= day && row.progressionCauseId === progressionProof.causeId);
    else if (handler === "realm_foundation_debate") {
      const loans = ledgers.noteLoans.filter((row) => row.borrowerId === cid && row.lifeIndex === Number(state.character.lifeIndex || 1) && row.status === "open" && row.dueDay >= day && row.progressionCauseId === progressionProof.causeId);
      if (loans.length >= 2) record = loans.slice(-2);
    } else if (handler === "realm_core_craft") record = [...(ledgers.craftBatches || [])].reverse().find((row) => row.actorId === cid && row.lifeIndex === Number(state.character.lifeIndex || 1) && row.status === "authorized" && row.batch?.status === "ready" && row.progressionCauseId === progressionProof.causeId);
    else if (handler === "realm_core_records") record = [...(ledgers.contributions || [])].reverse().find((row) => row.actorId === cid && row.lifeIndex === Number(state.character.lifeIndex || 1) && row.status === "signed" && row.progressionCauseId === progressionProof.causeId);
    else if (handler === "realm_core_supply") record = [...(ledgers.vendorQuotes || [])].reverse().find((row) => row.ownedBatch?.ownerId === cid && row.locationId === state.character.location && row.status === "open" && row.progressionCauseId === progressionProof.causeId);
    else if (/^(realm_soul_|realm_void_|realm_ascendant_)/.test(handler)) record = [...(ledgers.highRealmRequests || [])].reverse().find((row) => row.handler === handler && row.actorId === cid && row.lifeIndex === Number(state.character.lifeIndex || 1) && row.locationId === state.character.location && row.progressionCauseId === progressionProof.causeId && ["invited", "request", "requested", "authorized", "open", "entrusted", "accepted", "owned_draft"].includes(row.status));
    if (!record) return { error: "typed_current_character_realm_record_missing" };
    const evidenceId = Array.isArray(record) ? record[0]?.id : record.id;
    const current = realmSourceFor(event);
    if (current?.status === "open") return { status: "already_open", source: clone(current) };
    const source = { id: `${state.world.id || state.worldId}:${eventId}:${cid}:${day}`, eventId, causeId: evidenceId, sourceId: evidenceId, status: "open", createdDay: day, expiresDay: day + 7, lifeIndex: Number(state.character.lifeIndex || 1), worldId: state.world.id || state.worldId, locationId: state.character.location, evidence: clone(record), provenance: { producer: "typed_realm_action", day, characterId: cid, progressionCauseId: progressionProof.causeId } };
    if (handler === "realm_qi_breathlesson") source.registrationReceipt = record.registrationReceipt;
    if (handler === "realm_qi_sleep") source.dutyReceipt = record.dutyReceipt;
    if (handler === "realm_foundation_shelter") source.housingRecord = record.housingRecord;
    if (handler === "realm_foundation_water") source.waterTurn = record.waterTurn;
    if (handler === "realm_foundation_debate") source.loanReceipts = clone(record);
    if (handler === "realm_core_craft") { source.batch = clone(record.batch); source.permit = clone(record.permit); }
    if (handler === "realm_core_records") source.contributionRecord = clone(record);
    if (handler === "realm_core_supply") Object.assign(source, { ownedBatch: clone(record.ownedBatch), leaseNotice: clone(record.leaseNotice), validQuote: clone(record.validQuote), lease: clone(record.lease) });
    const [root, ...path] = binding.sourcePath.split(".");
    let parent = state[root]; for (const key of path.slice(0, -1)) parent = parent[key] ||= {};
    parent[path.at(-1)] = source;
    return { status: "created", source: clone(source) };
  }

  function bindRealmPracticeTransaction(eventId, actionTransactionId) {
    const event = eventById.get(eventId); const binding = event?.runtimeBinding;
    if (binding?.kind !== "realm_source" || !["realm_qi_routine", "realm_qi_sleep"].includes(binding.handler)) return { error: "realm_practice_event_required" };
    const source = realmSourceFor(event); const ledger = state.actionTransactionLedger?.[actionTransactionId];
    const action = state.character.actionLog?.find((entry) => entry.transactionId === actionTransactionId);
    const pending = state.world.pendingRealmChoice;
    if (!realmReservationMatches(event, source) || pending?.actionTransactionId !== actionTransactionId
      || source?.reservedTransactionId !== pending?.transactionId) return { error: "live_matching_practice_reservation_required" };
    const sourceGuard = validateRealmEventSource(event);
    if (sourceGuard?.error) return sourceGuard;
    const option = event.options.find((row) => row.id === pending.choiceId);
    const choiceGuard = option && validateRealmEventChoice(event, option);
    if (!option || choiceGuard?.error) return choiceGuard || { error: "reserved_practice_choice_missing" };
    if (source?.status !== "open" || ledger?.status !== "completed" || action?.actionId !== "r4_action_practice" || action.outcome !== "success" || action.worldDay !== state.worldDay || !state.character.alive) return { error: "completed_current_life_practice_action_transaction_required" };
    const requiredSkill = source.evidence?.skillId;
    if (requiredSkill && action.skillId !== requiredSkill) return { error: "practice_skill_does_not_match_typed_source" };
    source.evidence.practiceTransactionId = actionTransactionId;
    source.evidence.practiceDay = action.worldDay;
    appendCause("realm_practice_action_linked", eventId, { sourceId: source.sourceId, progressionCauseId: source.provenance?.progressionCauseId, actionTransactionId, actionDay: action.worldDay, durationDays: action.durationDays, actorId: state.character.id, lifeIndex: Number(state.character.lifeIndex || 1) });
    return { status: "linked", actionTransactionId, day: action.worldDay, durationDays: action.durationDays, skillId: action.skillId };
  }

  function bindRealmCraftTransaction(eventId, actionTransactionId) {
    const event = eventById.get(eventId); const binding = event?.runtimeBinding;
    if (binding?.kind !== "realm_source" || binding.handler !== "realm_core_craft") return { error: "realm_craft_event_required" };
    const source = realmSourceFor(event); const ledger = state.actionTransactionLedger?.[actionTransactionId];
    const action = state.character.actionLog?.find((entry) => entry.transactionId === actionTransactionId);
    const batch = (state.world.craftBatchLedger || []).find((row) => row.actionTransactionId === actionTransactionId && row.actorId === state.character.id && row.lifeIndex === Number(state.character.lifeIndex || 1) && ["completed", "failed"].includes(row.status));
    if (source?.status !== "open" || ledger?.status !== "completed" || action?.actionId !== "r4_action_alchemy" || !batch || batch.outcome !== action.outcome || !state.character.alive) return { error: "completed_formal_alchemy_transaction_required" };
    source.evidence.actionTransactionId = actionTransactionId;
    appendCause("realm_craft_action_linked", eventId, { sourceId: source.sourceId, progressionCauseId: source.provenance?.progressionCauseId, actionTransactionId, actualOutcome: batch.outcome, actorId: state.character.id, lifeIndex: Number(state.character.lifeIndex || 1) });
    return { status: "linked", actionTransactionId, day: action.worldDay, outcome: action.outcome, batchId: batch.id };
  }

  function reserveRealmEventChoice(eventId, transactionId) {
    const event = eventById.get(eventId); const source = event && realmSourceFor(event);
    if (!event || event.runtimeBinding?.kind !== "realm_source" || !transactionId) return { error: "unknown_realm_source" };
    if (source?.reservedTransactionId && !realmReservationMatches(event, source)) {
      const staleTxId = source.reservedTransactionId;
      delete source.reservedTransactionId; delete source.reservedDay;
      for (const key of ["pendingRealmChoice", "pendingRealmCraft"]) {
        if (state.world[key]?.eventId === eventId && state.world[key]?.transactionId === staleTxId) state.world[key] = null;
      }
    }
    if (!eventAvailable(event)) return { error: "event_unavailable" };
    if (source.reservedTransactionId && source.reservedTransactionId !== transactionId) return { error: "realm_source_already_reserved" };
    source.reservedTransactionId = transactionId; source.reservedDay = state.worldDay;
    return { status: "reserved", eventId, transactionId, sourceId: source.id, day: state.worldDay };
  }

  function releaseRealmEventChoice(eventId, transactionId) {
    const event = eventById.get(eventId); const source = event && realmSourceFor(event);
    if (source?.reservedTransactionId !== transactionId) return { error: "realm_source_reservation_mismatch" };
    delete source.reservedTransactionId; delete source.reservedDay;
    return { status: "released", eventId, transactionId };
  }

  function acceptDailyBoardAuthority(eventId) {
    if (eventId === "r4_ev_daily_roadmarker") {
      const board = state.world.dailyServiceBoards?.road;
      const keeper = state.world.npcRecords?.r4_npc_waykeeper;
      if (state.character.location !== "r4_loc_willow_market") return { error: "required_location_not_reached" };
      if (board?.status !== "active" || board.maintenanceNotice?.status !== "active" || !board.verifiedRoute?.verified || board.sign?.status !== "damaged"
        || keeper?.alive !== true || keeper.locationId !== state.character.location || state.character.knownLocations?.includes("r4_loc_ashspring") !== true
        || state.world.services?.waykeeper?.active !== true) return { error: "route_or_waykeeper_unavailable" };
      const permit = { status: "valid", characterId: state.character.id, issuedBy: "r4_npc_waykeeper", routeRecordId: board.routeRecordId, issuedDay: state.worldDay, expiresDay: state.worldDay + 1, lifeIndex: Number(state.character.lifeIndex || 1) };
      board.permitByCharacter[state.character.id] = permit;
      appendCause("daily_board_authority_accepted", eventId, { permitId: `${board.routeRecordId}:permit:${state.character.id}:${state.worldDay}`, keeperId: keeper.id || "r4_npc_waykeeper" });
      return { kind: "authority", status: "accepted", permit: clone(permit), day: state.worldDay };
    }
    if (eventId === "r4_ev_daily_well_queue") {
      const board = state.world.dailyServiceBoards?.well;
      const neighbor = state.world.npcRecords?.r4_npc_ash_neighbor;
      if (state.character.location !== "r4_loc_ashspring") return { error: "required_location_not_reached" };
      if (board?.status !== "open" || !board.rotation?.includes(state.character.id) || neighbor?.alive !== true || neighbor.locationId !== state.character.location
        || Number(state.character.relationships?.r4_npc_ash_neighbor?.value || 0) < 1) return { error: "well_rotation_or_neighbor_consent_unavailable" };
      const consent = { id: `${board.boardId}:swap-consent:${state.character.id}:${state.worldDay}`, status: "signed", signers: [state.character.id, neighbor.id], neighborId: neighbor.id, day: state.worldDay, boardId: board.boardId };
      board.swapConsents[state.character.id] = consent;
      appendCause("daily_board_authority_accepted", eventId, { consentId: consent.id, neighborId: neighbor.id });
      return { kind: "authority", status: "accepted", consent: clone(consent), day: state.worldDay };
    }
    if (eventId !== "r4_ev_daily_publiclesson") return { error: "no_daily_authority_action" };
    const board = state.world.dailyServiceBoards?.publicLesson;
    if (state.world.dailyBusinessConsumedCauses?.[`${eventId}:${board?.causeId}`]) return { error: "daily_public_board_cause_already_resolved" };
    const clerk = state.world.npcRecords?.[board?.clerkId];
    if (state.character.location !== "r4_loc_willow_market") return { error: "required_location_not_reached" };
    if (!board || board.status !== "open" || board.loanStatus !== "available" || clerk?.alive !== true || clerk?.onDuty !== true || clerk.locationId !== state.character.location) return { error: "book_or_clerk_unavailable" };
    const loan = { id: `${board.bookId}:loan:${state.character.id}:${state.worldDay}`, bookId: board.bookId, borrowerId: state.character.id, status: "open", issuedBy: board.clerkId, issuedDay: state.worldDay, dueDay: state.worldDay + 7, missingPageReport: clone(board.missingPage) };
    board.loans.push(loan); board.loanStatus = "on_loan";
    appendCause("daily_board_authority_accepted", eventId, { loanId: loan.id, clerkId: board.clerkId });
    return { kind: "authority", status: "accepted", loan: clone(loan), clerkId: board.clerkId, day: state.worldDay };
  }

  function openDailyBusinessSource(eventId) {
    const event = eventById.get(eventId);
    const binding = event?.runtimeBinding;
    if (eventId === "r4_ev_daily_courier" && binding?.kind === "business_source" && binding?.handler === "daily_courier") {
      const source = state.world.dailyBusinessSources?.courier;
      return isDailyCourierSourceLive() ? { kind: "source", status: "already_open", source: clone(source) } : { error: "funded_physical_courier_source_unavailable" };
    }
    if (eventId === "r4_ev_daily_roadmarker" && state.world.dailyBusinessSources?.roadmarker?.provenance?.producer === "r6_weather_generator") {
      return isDailyRoadSourceLive() ? { kind: "source", status: "already_open", source: clone(state.world.dailyBusinessSources.roadmarker) } : { error: "persisted_flood_cause_unavailable" };
    }
    if (eventId === "r4_ev_daily_roadmarker" && binding?.kind === "business_source" && binding?.handler === "daily_roadmarker") {
      const board = state.world.dailyServiceBoards?.road;
      const permit = board?.permitByCharacter?.[state.character.id];
      if (state.character.location !== binding.locationId || state.character.location !== board?.locationId) return { error: "required_location_not_reached" };
      if (board?.status !== "active" || board.maintenanceNotice?.status !== "active") return { error: "road_maintenance_notice_closed" };
      if (!permit || permit.status !== "valid" || permit.expiresDay < state.worldDay || permit.lifeIndex !== Number(state.character.lifeIndex || 1)) return { error: "road_maintenance_permit_missing_or_expired" };
      const old = state.world.dailyBusinessSources.roadmarker;
      if (old?.status === "open" && old.createdDay === state.worldDay) return { kind: "source", status: "already_open", source: clone(old) };
      const source = { id: `${state.worldId}:${eventId}:${state.character.id}:${state.worldDay}`, eventId, causeId: board.maintenanceCauseId, ownerCharacterId: state.character.id, createdDay: state.worldDay, expiresDay: state.worldDay, locationId: board.locationId, status: "open", route: { id: board.routeRecordId, verified: board.verifiedRoute.verified, direction: board.verifiedRoute.direction }, maintenanceNotice: clone(board.maintenanceNotice), maintenancePermit: clone(permit), sign: clone(board.sign), evidence: { boardId: board.routeRecordId, causeId: board.maintenanceCauseId }, provenance: { producer: "registered_daily_service_action", characterId: state.character.id, locationId: state.character.location, day: state.worldDay, status: "verified" } };
      state.world.dailyBusinessSources.roadmarker = source;
      appendCause("daily_business_source_opened", eventId, { sourceId: source.id, causeId: source.causeId, boardId: board.routeRecordId, permitLifeIndex: permit.lifeIndex });
      return { kind: "source", status: "created", source: clone(source) };
    }
    if (eventId === "r4_ev_daily_publiclesson" && binding?.kind === "business_source" && binding?.handler === "daily_publiclesson") {
      const board = state.world.dailyServiceBoards?.publicLesson;
      const loan = board?.loans?.find((row) => row.borrowerId === state.character.id && row.bookId === board.bookId && row.status === "open");
      const clerk = state.world.npcRecords?.[board?.clerkId];
      if (state.character.location !== binding.locationId || state.character.location !== board?.locationId) return { error: "required_location_not_reached" };
      if (!board || board.status !== "open" || !loan || clerk?.alive !== true || clerk?.onDuty !== true) return { error: "public_book_loan_or_clerk_missing" };
      const old = state.world.dailyBusinessSources.publicLesson;
      if (old?.status === "open" && old.createdDay === state.worldDay) return { kind: "source", status: "already_open", source: clone(old) };
      const day = state.worldDay;
      const source = { id: `${state.worldId}:${eventId}:${state.character.id}:${day}`, eventId, causeId: board.causeId, ownerCharacterId: state.character.id, createdDay: day, expiresDay: day, locationId: board.locationId, status: "open", loan: clone(loan), clerkId: board.clerkId, bookId: board.bookId, missingPage: clone(board.missingPage), revisionNotice: clone(board.revisionNotice), evidence: { boardId: board.id || board.bookId, causeId: board.causeId }, provenance: { producer: "registered_daily_service_action", characterId: state.character.id, locationId: state.character.location, day, status: "verified" } };
      state.world.dailyBusinessSources.publicLesson = source;
      appendCause("daily_business_source_opened", eventId, { sourceId: source.id, causeId: source.causeId, boardId: source.evidence.boardId, loanId: loan.id });
      return { kind: "source", status: "created", source: clone(source) };
    }
    if (eventId === "r4_ev_daily_well_queue" && binding?.kind === "business_source" && binding?.handler === "daily_well_queue") {
      const board = state.world.dailyServiceBoards?.well;
      if (state.character.location !== binding.locationId || board?.locationId !== state.character.location) return { error: "required_location_not_reached" };
      if (board.status !== "open" || !board.rotation?.includes(state.character.id)) return { error: "well_closed_or_household_not_listed" };
      const old = state.world.dailyBusinessSources.wellQueue;
      if (old?.status === "open" && old.createdDay === state.worldDay) return { kind: "source", status: "already_open", source: clone(old) };
      const consent = board.swapConsents?.[state.character.id] || null;
      const day = state.worldDay;
      const source = { id: `${state.worldId}:${eventId}:${state.character.id}:${day}`, eventId, causeId: board.repairCauseId, ownerCharacterId: state.character.id, lifeIndex: Number(state.character.lifeIndex || 1), createdDay: day, expiresDay: day, locationId: board.locationId, status: "open", well: { id: board.boardId, status: board.status, ropeStatus: board.ropeStatus }, rotation: clone(board.rotation), repairCauseId: board.repairCauseId, swapConsent: clone(consent), alternative: clone(board.alternative), evidence: { boardId: board.boardId, causeId: board.repairCauseId }, provenance: { producer: "registered_daily_service_action", characterId: state.character.id, locationId: state.character.location, day, status: "verified" } };
      state.world.dailyBusinessSources.wellQueue = source;
      appendCause("daily_business_source_opened", eventId, { sourceId: source.id, causeId: source.causeId, boardId: board.boardId });
      return { kind: "source", status: "created", source: clone(source) };
    }
    if (eventId !== "r4_ev_daily_ferry" || binding?.kind !== "business_source" || binding?.handler !== "daily_ferry") return { error: "unknown_daily_source" };
    const board = state.world.dailyServiceBoards?.ferry;
    const day = state.worldDay;
    if (state.character.location !== binding.locationId || state.character.location !== board?.locationId) return { error: "required_location_not_reached" };
    if (!board || !["open", "active", "scheduled"].includes(board.status) || day < board.openDay || day > board.closeDay) return { error: "daily_public_board_unavailable" };
    const old = state.world.dailyBusinessSources?.ferry;
    if (old?.status === "open" && old.expiresDay >= day) return { kind: "source", status: "already_open", source: clone(old) };
    const route = state.world.routes.find((row) => row.from === board.routeFrom && row.to === board.routeTo);
    const target = state.world.workBoard.find((row) => row.status === "open" && row.realNeed === true && row.location === board.routeTo && row.openDay <= day && row.deadlineDay >= day);
    const operator = state.world.npcRecords.r4_npc_tan_sail;
    if (!route || board.waterStatus !== "safe" || !operator || operator.alive !== true || operator.onDuty !== true || operator.locationId !== board.locationId || operator.role !== "ferry_operator" || !target) return { error: "ferry_route_worker_water_or_target_missing" };
    const fare = Number(board.fare);
    const durationDays = Number(board.days || route.days);
    if (!Number.isFinite(fare) || fare < 0 || !Number.isSafeInteger(durationDays) || durationDays <= 0 || Number(state.character.cashWen) < fare) return { error: Number(state.character.cashWen) < fare ? "insufficient_resource" : "ferry_contract_invalid" };
    const causeId = `${state.worldId}:r4_ev_daily_ferry:${state.character.id}:${day}:cause`;
    const source = {
      id: `${state.worldId}:r4_ev_daily_ferry:${state.character.id}:${day}`, eventId: eventId, causeId,
      ownerCharacterId: state.character.id, createdDay: day, expiresDay: board.closeDay,
      locationId: board.locationId, status: "open", route: clone(route), fare, durationDays,
      waterNotice: { status: "safe", causeId: board.waterCauseId }, operatorId: operator.id,
      destinationReceipt: { status: "valid", location: route.to, receiptId: target.id },
      workerCommitment: clone(board.workerCommitment),
      evidence: { boardId: board.id, causeId: board.waterCauseId, targetWorkId: target.id },
      provenance: { producer: "registered_daily_service_action", characterId: state.character.id, locationId: state.character.location, day, status: "verified" }
    };
    state.world.dailyBusinessSources.ferry = source;
    appendCause("daily_business_source_opened", eventId, { sourceId: source.id, causeId, boardId: board.id, targetWorkId: target.id });
    return { kind: "source", status: "created", source: clone(source) };
  }

  function eraEvidence(eventId) {
    const world = state.world;
    if (eventId === "r4_ev_era_lingxu_repair") {
      const crisis = world.crisisInstances.find((row) => row.family === "lingxu" && row.resolution === "root_resolved" && row.status !== "active");
      const root = world.facts?.r4_fact_lingxu_root;
      if (!crisis || root?.status !== "root_resolved") return null;
      return { causeId: crisis.id, sourceRefs: [root.sourceRefs?.[0] || crisis.id], instanceId: crisis.id, scope: "post_resolution_repair", evidenceId: root.sourceRefs?.[0] || crisis.id };
    }
    if (eventId === "r4_ev_era_faction_successor") {
      const settlement = [...(world.factionSettlements || [])].reverse().find((row) => row.status === "open" && (world.destroyedOrganizations || []).includes(row.factionId) && row.publicAudit === true);
      if (!settlement) return null;
      const rights = (settlement.individualRights || []).filter((row) => row.claimantId === state.character.id && row.status === "registered").map((row) => row.id);
      const awards = (settlement.individualClaims || []).filter((row) => row.claimantId === state.character.id && row.status === "reserved").map((row) => row.awardId);
      return { causeId: settlement.causeId, sourceRefs: [settlement.id, settlement.causeId, ...rights, ...awards], settlementId: settlement.id, factionId: settlement.factionId, individualRightIds: rights, awardIds: awards, scope: "individual_public_claims_only" };
    }
    return null;
  }

  function refreshEraEventSources() {
    state.world.eraEventSources ||= {};
    state.world.eraEventReceipts ||= {};
    const currentLife = Number(state.character.lifeIndex || 1);
    for (const [eventId, key] of [["r4_ev_era_lingxu_repair", "lingxu_repair"], ["r4_ev_era_faction_successor", "faction_successor"]]) {
      const evidence = eraEvidence(eventId);
      const existing = state.world.eraEventSources[key];
      if (!evidence) {
        if (existing?.status === "open" && (!Number.isSafeInteger(existing.openedDay) || !Number.isSafeInteger(existing.expiresDay) || existing.expiresDay < state.worldDay)) existing.status = "expired";
        continue;
      }
      const receiptKey = `${currentLife}:${eventId}:${evidence.causeId}`;
      if (state.world.eraEventReceipts[receiptKey]) continue;
      if (existing?.causeId === evidence.causeId && existing.lifeIndex === currentLife && existing.worldId === state.worldId
        && existing.status === "open" && (!Number.isSafeInteger(existing.openedDay) || !Number.isSafeInteger(existing.expiresDay) || existing.expiresDay < state.worldDay)) {
        existing.status = "expired";
      }
      if (existing?.status === "open" && existing.causeId === evidence.causeId && existing.worldId === state.worldId && existing.lifeIndex === currentLife
        && Number.isSafeInteger(existing.openedDay) && Number.isSafeInteger(existing.expiresDay) && existing.openedDay <= state.worldDay && existing.expiresDay >= state.worldDay) continue;
      state.world.eraEventIssueLog ||= [];
      const priorIssue = state.world.eraEventIssueLog.find((row) => row.eventId === eventId && row.causeId === evidence.causeId && row.lifeIndex === currentLife && row.worldId === state.worldId);
      if (priorIssue) Object.assign(priorIssue, { previousOpenedDay: existing?.openedDay ?? priorIssue.previousOpenedDay, openedDay: state.worldDay, expiresDay: state.worldDay + 30, reissueCount: Number(priorIssue.reissueCount || 0) + 1, reason: "current_evidence_revalidated_after_expiry" });
      else state.world.eraEventIssueLog.push({ eventId, causeId: evidence.causeId, lifeIndex: currentLife, worldId: state.worldId, firstOpenedDay: state.worldDay, openedDay: state.worldDay, expiresDay: state.worldDay + 30, previousOpenedDay: null, reissueCount: 0, reason: "eligible_source_materialized" });
      state.world.eraEventSources[key] = {
        id: `era:${state.worldId}:${eventId}:${evidence.causeId}`, eventId, causeId: evidence.causeId,
        status: "open", worldId: state.worldId, lifeIndex: currentLife,
        openedDay: state.worldDay, expiresDay: state.worldDay + 30, evidence: clone(evidence)
      };
    }
  }

  function isEraEventSourceLive(event) {
    const key = event.id === "r4_ev_era_lingxu_repair" ? "lingxu_repair" : event.id === "r4_ev_era_faction_successor" ? "faction_successor" : null;
    if (!key) return true;
    const source = state.world.eraEventSources?.[key];
    const evidence = eraEvidence(event.id);
    return Boolean(source && source.status === "open" && source.eventId === event.id && source.worldId === state.worldId
      && source.lifeIndex === Number(state.character.lifeIndex || 1) && Number.isSafeInteger(source.openedDay) && Number.isSafeInteger(source.expiresDay)
      && source.openedDay <= state.worldDay && source.expiresDay >= state.worldDay
      && evidence && source.causeId === evidence.causeId && JSON.stringify(source.evidence) === JSON.stringify(evidence));
  }

  function settleDestroyedOrganizations() {
    const clerk = state.world.npcRecords.r4_npc_market_clerk;
    const clerkReady = clerk?.alive === true && clerk.role === "market_registrar" && clerk.onDuty === true
      && state.world.knownLocations.includes(clerk.locationId);
    if (!clerkReady) return;
    for (const factionId of state.world.destroyedOrganizations) {
      const causeId = state.world.organizationCauseIds[factionId];
      if (!causeId || state.world.factionSettlements.some((row) => row.factionId === factionId && row.causeId === causeId)) continue;
      const availableInventory = clone(state.world.organizationInventories[factionId] || {});
      const rights = (state.world.organizationIndividualRights || []).filter((row) => row.factionId === factionId && row.status === "registered").map(clone);
      const settlement = {
        id: `settlement:${factionId}:${causeId}`, factionId, status: "open", causeId,
        openedDay: state.worldDay, settlingOfficerId: clerk.id, settlingLocationId: clerk.locationId,
        settlingOfficerRole: clerk.role, publicAudit: true, individualClaims: [], publicTools: [],
        individualRights: rights, availableInventory, reservedInventory: {}, reviewLedger: []
      };
      for (const right of rights) {
        const stock = Number(settlement.availableInventory[right.itemId] || 0);
        if (right.claimantId && Number.isSafeInteger(right.quantity) && right.quantity > 0 && stock >= right.quantity) {
          const awardId = `award:${settlement.id}:${right.id}`;
          settlement.availableInventory[right.itemId] -= right.quantity;
          settlement.reservedInventory[right.itemId] = Number(settlement.reservedInventory[right.itemId] || 0) + right.quantity;
          settlement.individualClaims.push({ awardId, rightId: right.id, claimantId: right.claimantId, itemId: right.itemId, amount: right.quantity, status: "reserved", settlementId: settlement.id, causeId, reviewedBy: clerk.id, reviewedDay: state.worldDay, sourceReceiptId: right.sourceReceiptId });
          settlement.reviewLedger.push({ rightId: right.id, claimantId: right.claimantId, itemId: right.itemId, amount: right.quantity, sourceReceiptId: right.sourceReceiptId, settlementId: settlement.id, status: "verified_and_reserved", awardId, reviewedBy: clerk.id, day: state.worldDay, causeId });
        } else settlement.reviewLedger.push({ rightId: right.id, claimantId: right.claimantId, itemId: right.itemId, amount: right.quantity, sourceReceiptId: right.sourceReceiptId, settlementId: settlement.id, status: "not_funded_by_available_inventory", reviewedBy: clerk.id, day: state.worldDay, causeId });
      }
      state.world.factionSettlements.push(settlement);
      state.world.organizationInventories[factionId] = {};
    }
  }

  function applyEraBusinessChoice(event, option, transactionId) {
    if (!["r4_ev_era_lingxu_repair", "r4_ev_era_faction_successor"].includes(event.id)) return true;
    if (!isEraEventSourceLive(event)) return false;
    const key = event.id === "r4_ev_era_lingxu_repair" ? "lingxu_repair" : "faction_successor";
    const source = state.world.eraEventSources[key];
    const causeId = `era-choice:${state.character.lifeIndex || 1}:${transactionId}`;
    if (event.id === "r4_ev_era_lingxu_repair") {
      if (option.runtimeAction !== "era_lingxu_rotation") return false;
      const claim = { id: causeId, eventId: event.id, action: option.runtimeAction, status: "completed", actorId: state.character.id, lifeIndex: state.character.lifeIndex || 1, day: state.worldDay, sourceCauseId: source.causeId, instanceId: source.evidence.instanceId, rotation: "registered_public_rotation", privatelyAssignedPlotChanged: false };
      state.world.irrigationClaims.push(claim);
      state.world.eraEventFollowups.lingxu_repair ||= [];
      state.world.eraEventFollowups.lingxu_repair.push(clone(claim));
    } else {
      if (option.runtimeAction !== "era_faction_audit") return false;
      const settlement = state.world.factionSettlements.find((row) => row.id === source.evidence.settlementId && row.status === "open");
      const officer = state.world.npcRecords[settlement?.settlingOfficerId];
      if (!settlement || settlement.publicAudit !== true || !officer || officer.alive !== true || officer.onDuty !== true || officer.role !== "market_registrar" || officer.locationId !== settlement.settlingLocationId || !state.world.knownLocations.includes(officer.locationId)) return false;
      const audit = { id: causeId, settlementId: settlement.id, actorId: state.character.id, registrarId: officer.id, status: "public_individual_claims_and_tools_audited", claimCount: settlement.individualClaims.length, toolCount: settlement.publicTools.length, availableInventory: clone(settlement.availableInventory), reservedInventory: clone(settlement.reservedInventory), day: state.worldDay, causeId: source.causeId };
      state.world.factionSettlementAudits.push(audit);
      state.world.eraEventFollowups.faction_successor ||= [];
      state.world.eraEventFollowups.faction_successor.push({ id: causeId, eventId: event.id, action: option.runtimeAction, status: audit.status, actorId: state.character.id, day: state.worldDay, causeId: source.causeId, auditId: audit.id, settlementId: settlement.id });
    }
    source.status = "resolved";
    source.resolution = { status: "committed_success", action: option.runtimeAction, day: state.worldDay, causeId };
    state.world.eraEventReceipts[`${state.character.lifeIndex || 1}:${event.id}:${source.causeId}`] = { status: "resolved", day: state.worldDay, transactionId };
    return true;
  }

  function validateEraChoice(event, option) {
    if (!["r4_ev_era_lingxu_repair", "r4_ev_era_faction_successor"].includes(event.id)) return null;
    if (!isEraEventSourceLive(event)) return "era_source_missing_expired_or_causality_changed";
    if (event.id === "r4_ev_era_lingxu_repair") return option.runtimeAction === "era_lingxu_rotation" ? null : "registered_public_rotation_required";
    if (option.runtimeAction !== "era_faction_audit") return "public_audit_action_required";
    const source = state.world.eraEventSources.faction_successor;
    const settlement = state.world.factionSettlements.find((row) => row.id === source.evidence.settlementId && row.status === "open");
    const officer = state.world.npcRecords[settlement?.settlingOfficerId];
    return settlement?.publicAudit === true && officer?.alive === true && officer?.onDuty === true && officer?.role === "market_registrar" && officer.locationId === settlement.settlingLocationId && state.world.knownLocations.includes(officer.locationId)
      ? null : "current_public_registrar_and_open_settlement_required";
  }

  function availableEvents() {
    return definitions.events.filter(eventAvailable).map((event) => eventView(event));
  }

  function explainRequirement(predicate) {
    if (predicate?.fact) return `需要：${predicate.fact.replaceAll(".", " · ")}`;
    if (predicate?.all) return predicate.all.map(explainRequirement).join("；");
    if (predicate?.any) return `满足其一：${predicate.any.map(explainRequirement).join(" / ")}`;
    if (predicate?.not) return `当前条件已满足，不能重复：${explainRequirement(predicate.not)}`;
    return "当前条件不满足";
  }

  function start(origin) {
    const profile = seedConfig.originProfiles.find((item) => item.originId === origin);
    if (!profile) return { error: "invalid_origin" };
    if (state.character.origin) return { error: "generation_already_started" };
    const originKind = origin.replace(/^r4_origin_/, "");
    const originSource = pack.runtimeSources.originInitialization?.[originKind];
    if (!originSource) return { error: "missing_origin_runtime_source" };
    if (!profile.startingResources || !["health", "power", "wealth"].every((key) => Number.isFinite(Number(profile.startingResources[key])))) return { error: "origin_starting_resources_not_defined_by_b" };
    state.character.origin = originKind;
    state.character.facts = clone(profile.initialFacts || {});
    if (originKind === "system") state.character.facts.r4_fact_system_active ??= false;
    state.character.location = originSource.location;
    state.character.knownLocations = [...new Set([...(originSource.knownLocations || [originSource.location]), ...pack.runtimeSources.worldInitialization.routes.filter((route) => route.from === originSource.location && route.knownFromOrigin.includes(originKind)).map((route) => route.to)])];
    state.character.originLocation = originSource.location;
    state.character.birthDay = state.worldDay - Number(pack.crises.generation.operableAgeDays);
    state.character.ageDays = state.worldDay - state.character.birthDay;
    state.character.health = Number(profile.startingResources.health);
    state.character.power = Number(profile.startingResources.power);
    state.character.cashWen = Number(profile.startingResources.wealth);
    state.character.birthRecord = clone(originSource.birthRecord || profile.birthRecord || {});
    state.character.contacts = {};
    state.character.organizationAccess = {};
    state.character.crisisAllyCommitments = {};
    state.world.demandLocation = originSource.location;
    for (const task of state.world.workBoard) task.location = originSource.location;
    state.world.demandInstance = state.world.workBoard[0] || null;
    state.character.knowledge.demand = { level: "heard", sourceId: `public-work-board:${pack.runtimeSources.worldInitialization.publicWorkBoard.sourceFaction}`, acquiredDay: state.worldDay, characterId: state.character.id };
    for (const [key, level] of Object.entries(originSource.knowledge || {})) state.character.knowledge[key] = { level, sourceId: origin, acquiredDay: state.worldDay, characterId: state.character.id };
    if (originSource.basicHerbKnowledge) state.character.facts.r4_fact_basic_herb_knowledge = { value: true, sourceId: "world-init:herbal-childhood", day: 0 };
    if (originSource.openingScenario) {
      const exitLocation = pack.runtimeSources.worldInitialization.routes.find((route) => route.from === originSource.location && route.to.endsWith("willow_market"))?.to;
      const opening = { id: `${state.worldId}:opening:${state.character.id}`, family: "opening", status: "active", createdDay: state.worldDay, location: originSource.location, exitLocation, companionPersonId: originSource.companionPersonId || null, closed: false, danger: true };
      state.world.openingInstance = opening;
      state.world.crisisInstances.push(opening);
      state.world.openingDanger = true;
      state.world.nearestSafeLocation = exitLocation;
      state.world.originEncounterDay = state.worldDay;
      state.world.openingCloseDay = state.worldDay + 30;
      state.character.knowledge.safeExit = { level: "heard", sourceId: originSource.knownSafeRouteSource, acquiredDay: state.worldDay, characterId: state.character.id };
    }
    for (const entry of profile.initialKnowledge || []) state.character.knowledge[entry.key] = { level: entry.level, sourceId: entry.sourceId, acquiredDay: state.worldDay, characterId: state.character.id };
    const generation = { generation: 1, characterId: state.character.id, origin, birthDay: state.character.birthDay, status: "alive" };
    state.generations.push(generation);
    evaluateWorldPlan();
    enqueue(profile.openingEventId, state.worldDay);
    return { ok: true, snapshot: snapshot(), events: availableEvents() };
  }

  function beginEvent(eventId) {
    const event = eventById.get(eventId);
    if (!event) return { error: "unknown_event" };
    if (!eventAvailable(event)) return { error: "event_unavailable" };
    if (state.inFlightTransaction) {
      if (state.inFlightTransaction.pauseReason !== "world_node_due") return { error: "transaction_in_flight" };
      state.suspendedTransactions ||= [];
      const suspended = clone(state.inFlightTransaction);
      suspended.pauseReason = null;
      suspended.pauseEventId = null;
      state.suspendedTransactions.push(suspended);
      state.inFlightTransaction = null;
    }
    state.activeEventId = eventId;
    const family = Object.entries(pack.crises).find(([, plan]) => plan.eventIds?.includes(eventId))?.[0];
    state.activeCrisisInstanceId = state.queue.find((entry) => entry.eventId === eventId)?.instanceId || state.world.crisisInstances.find((item) => item.family === family && !item.closed)?.id || state.world.openingInstance?.id || null;
    return { ok: true, event: eventView(event), snapshot: snapshot() };
  }

  function eventView(event) {
    return withEventContext(event, () => {
      const source = state.world.dailyBusinessSources?.[event.id === "r4_ev_daily_courier" ? "courier" : "roadmarker"];
      const currentR6Courier = event.id === "r4_ev_daily_courier" && r6FreeSurvival && realmSourceAdapter === "r5";
      const courierChoices = currentR6Courier ? [
        { id: "r6_choice_accept_delivery", text: "接下送药委托", costs: {}, requires: true, outcomeIds: { success: "r6_outcome_v_daily_courier_accept_delivery_success" } },
        { id: "r6_choice_decline_delivery", text: "婉拒本次委托", costs: {}, requires: true, outcomeIds: { success: "r6_outcome_v_daily_courier_decline_delivery_success" } }
      ] : event.options;
      const options = courierChoices.map((option) => {
        const row = clone(option);
        let available = testPredicate(option.requires);
        if (event.id === "r4_ev_daily_courier") {
          const contract = state.world.r6CourierContracts?.find((item) => item.contractId === source?.contractId);
          const alreadyAccepted = state.world.r6CourierContracts?.some((item) => item.cycleIndex === contract?.cycleIndex && item.status === "accepted" && item.acceptedBy === state.character.id);
          available = isDailyCourierSourceLive() && (currentR6Courier
            ? !alreadyAccepted && ["r6_choice_accept_delivery", "r6_choice_decline_delivery"].includes(option.id)
            : ["verify_dispatch_copy", "return_to_sender"].includes(option.id));
          if (option.id === "verify_dispatch_copy") row.text = "核对送药委托 · 耗1刻";
          if (option.id === "return_to_sender") row.text = "原封退回药包 · 耗2刻";
          if (option.id === "contact_named_recipient") row.text = "抵达照影台后再签收";
        } else if (event.id === "r4_ev_daily_roadmarker" && source?.provenance?.producer === "r6_weather_generator") {
          available = isDailyRoadSourceLive() && option.id === "leave_and_report";
          if (option.id === "leave_and_report") row.text = "停步查看路标与水势 · 耗1日";
          if (option.id === "replace_with_verified_sign") row.text = "没有维护许可，不能更换公共路标";
          if (option.id === "post_temporary_warning") row.text = "等待路况复核后再走";
        }
        row.available = available;
        row.unavailableReason = available ? "" : (event.id === "r4_ev_daily_courier" ? "当前没有同日相遇的已托管药包委托。" : event.id === "r4_ev_daily_roadmarker" ? "当前没有有效的洪水封路因果。" : explainRequirement(option.requires));
        return row;
      });
      const title = event.id === "r4_ev_daily_courier" ? "柳汀药铺的托付"
        : event.id === "r4_ev_daily_roadmarker" && source?.provenance?.producer === "r6_weather_generator" ? "暴雨封路"
          : event.presentation?.title || event.id;
      return { ...clone(event), title, options };
    });
  }

  function choose(eventId, optionId, { abort = false, defer = false, afterRealmPractice = false, timeAlreadyCharged = false } = {}) {
    const event = eventById.get(eventId);
    const option = eventId === "r4_ev_daily_courier" ? { id: optionId, days: 1, costs: {}, requires: true, success: [{ op: "record_cause", cause: `r4_ev_daily_courier.${optionId}` }], failure: [] }
      : eventId === "r4_ev_daily_roadmarker" && state.world.dailyBusinessSources?.roadmarker?.provenance?.producer === "r6_weather_generator" ? { id: optionId, days: 1, costs: {}, requires: true, success: [{ op: "record_cause", cause: `r4_ev_daily_roadmarker.${optionId}` }], failure: [] }
        : event?.options.find((item) => item.id === optionId);
    if (!event || !option) return { error: "unknown_option" };
    const currentR6Courier = eventId === "r4_ev_daily_courier" && r6FreeSurvival && realmSourceAdapter === "r5";
    const validCourierChoices = currentR6Courier
      ? ["r6_choice_accept_delivery", "r6_choice_decline_delivery"]
      : ["verify_dispatch_copy", "return_to_sender"];
    if (eventId === "r4_ev_daily_courier" && (!isDailyCourierSourceLive() || !validCourierChoices.includes(optionId))) return { error: "funded_physical_courier_source_unavailable" };
    if (eventId === "r4_ev_daily_roadmarker" && state.world.dailyBusinessSources?.roadmarker?.provenance?.producer === "r6_weather_generator"
      && (!isDailyRoadSourceLive() || optionId !== "leave_and_report")) return { error: "persisted_flood_cause_unavailable" };
    if (event.type === "daily" && event.instanceScope === "market_quote") {
      const quote = state.quotes.active;
      if (!quote || quote.receipt || quote.expiryDay < state.worldDay) return { error: "market_quote_missing_or_expired" };
      if ((quote.side === "buy" && optionId !== "buy_listed_goods") || (quote.side === "sell" && optionId !== "sell_owned_goods")) return { error: "quote_side_mismatch" };
    }
    if (state.activeEventId !== eventId && !eventAvailable(event)) return { error: "event_unavailable" };
    if (!withEventContext(event, () => testPredicate(option.requires))) return { error: "requirements_not_met", reason: withEventContext(event, () => explainRequirement(option.requires)) };
    if (eventId === "r4_daily_breakthrough" && optionId === "attempt_now") {
      const breakthroughError = validateR4BreakthroughAttempt();
      if (breakthroughError) return { error: breakthroughError };
    }
    if (event.runtimeBinding?.kind === "realm_source") {
      const realmGuard = validateRealmEventSource(event);
      if (realmGuard) return realmGuard;
      const choiceGuard = validateRealmEventChoice(event, option);
      if (choiceGuard) return choiceGuard;
    }
    if (!afterRealmPractice && realmSourceAdapter !== "r5" && ["realm_qi_practice", "realm_watch_practice"].includes(option.runtimeAction)) {
      return beginR4RealmPracticeChoice(event, option);
    }
    const eraGuard = validateEraChoice(event, option);
    if (eraGuard) return { error: eraGuard };
    const lessonSource = eventId === "r4_ev_daily_publiclesson" ? state.world.dailyBusinessSources?.publicLesson : null;
    if (eventId === "r4_ev_daily_publiclesson" && (!lessonSource || !isDailyPublicLessonSourceLive())) return { error: "daily_business_source_missing_or_expired" };
    const roadSource = eventId === "r4_ev_daily_roadmarker" ? state.world.dailyBusinessSources?.roadmarker : null;
    if (eventId === "r4_ev_daily_roadmarker" && (!roadSource || !isDailyRoadSourceLive())) return { error: "daily_business_source_missing_or_expired" };
    if (eventId === "r4_ev_daily_well_queue" && !isDailyWellSourceLive()) return { error: "daily_business_source_missing_or_expired" };
    if (eventId === "r4_ev_daily_well_queue" && option.runtimeAction === "well_signed_swap") {
      const wellSource = state.world.dailyBusinessSources?.wellQueue;
      const consent = state.world.dailyServiceBoards?.well?.swapConsents?.[state.character.id];
      if (!consent || consent.status !== "signed" || consent.id !== wellSource?.swapConsent?.id
        || consent.boardId !== state.world.dailyServiceBoards.well.boardId || consent.signers?.[0] !== state.character.id) return { error: "signed_water_swap_consent_required" };
    }
    if (eventId === "r4_ev_daily_roadmarker" && option.runtimeAction === "road_replace_sign"
      && (!roadSource.route.verified || roadSource.maintenancePermit.status !== "valid" || roadSource.maintenancePermit.expiresDay < state.worldDay)) return { error: "daily_road_permit_or_route_invalid" };
    const instanceId = state.queue.find((entry) => entry.eventId === eventId)?.instanceId || scopeInstanceId(event);
    const key = recordKey(instanceId, eventId, ++state.operationSequence);
    if (state.eventClaimLedger[key]) return { error: "duplicate_suppressed" };
    const costs = normalizeCosts(option.costs || {});
    const ferrySource = eventId === "r4_ev_daily_ferry" && optionId === "pay_crossing" ? state.world.dailyBusinessSources?.ferry : null;
    if (eventId === "r4_ev_daily_ferry" && (!ferrySource || !isDailyFerrySourceLive())) return { error: "daily_business_source_missing_or_expired" };
    if (ferrySource && optionId === "pay_crossing") costs.wealth = Number(ferrySource.fare);
    if (!canAfford(costs)) return { error: "insufficient_resource" };
    consumeCosts(costs);
    const days = timeAlreadyCharged ? 0 : Math.max(0, Math.floor(ferrySource && optionId === "pay_crossing" ? ferrySource.durationDays : option.days || 0));
    const transaction = {
      kind: "event", transactionId: `${state.worldId}-tx-${state.operationSequence}`, worldId: state.worldId,
      eventId, optionId, instanceId, commitKey: [state.worldId, `${eventId}:${state.operationSequence}`],
      status: "running", startedDay: state.worldDay, targetDay: state.worldDay + days,
      durationDays: days, completedSegments: 0, totalSegments: Math.max(1, Math.ceil(days / 30)),
      reservedCost: costs, consumedAtStart: true, produced: false, claimKey: key,
      rngStateAtStart: state.rngState, lastResolvedDay: state.worldDay
    };
    state.inFlightTransaction = transaction;
    state.eventClaimLedger[key] = { state: "in_flight", transactionId: transaction.transactionId };
    state.eventClaimLedger[recordKey(instanceId, eventId, 0)] = { state: "in_flight", transactionId: transaction.transactionId };
    if (days === 0) return finishTransaction("success", option, event);
    if (defer) return { kind: "progress", transaction: clone(transaction), snapshot: snapshot() };
    const result = advanceDays(days);
    if (abort) return abortTransaction(option, event, result);
    return finishTransaction("success", option, event, result);
  }

  function beginR4RealmPracticeChoice(event, option) {
    if (state.world.pendingRealmChoice || state.world.pendingRealmCraft) return { error: "realm_choice_action_already_in_flight" };
    const eventId = event.id;
    const token = `${state.worldId}:realm-choice:${++state.operationSequence}`;
    const source = realmSourceFor(event);
    const pending = { eventId, choiceId: option.id, transactionId: token, sourceId: source?.id, actorId: state.character.id, lifeIndex: Number(state.character.lifeIndex || 1), startedDay: state.worldDay, actionTransactionId: null };
    state.world.pendingRealmChoice = pending;
    const skillId = source?.evidence?.skillId || (state.character.learnedSkills || []).find((id) => state.character.skillRecords?.[id]?.lifeIndex === Number(state.character.lifeIndex || 1));
    const actionResult = performAction("r4_action_practice", { skillId });
    if (actionResult?.error) { state.world.pendingRealmChoice = null; return actionResult; }
    pending.actionTransactionId = actionResult.transaction?.transactionId || state.inFlightTransaction?.transactionId;
    if (!pending.actionTransactionId) { state.world.pendingRealmChoice = null; return { error: "practice_transaction_not_started" }; }
    const reservation = reserveRealmEventChoice(eventId, token);
    if (reservation?.error) { state.world.pendingRealmChoice = null; abortInFlight(); return reservation; }
    return { ...actionResult, realmPracticeAction: true, eventId, choiceId: option.id, reservation, transaction: clone(state.inFlightTransaction) };
  }

  function settleR4RealmPracticeChoice(actionResult) {
    const pending = state.world.pendingRealmChoice;
    if (realmSourceAdapter === "r5" || !pending || pending.actionTransactionId !== actionResult?.actionId && pending.actionTransactionId !== actionResult?.transactionId) return actionResult;
    const unresolved = (result) => {
      releaseRealmEventChoice(pending.eventId, pending.transactionId);
      state.world.pendingRealmChoice = null;
      return { ...result, realmEventUnresolved: true, eventId: pending.eventId, choiceId: pending.choiceId };
    };
    if (actionResult.kind !== "result" || actionResult.outcome !== "success" || !state.character.alive || Number(state.character.lifeIndex || 1) !== pending.lifeIndex) return unresolved(actionResult);
    const linked = bindRealmPracticeTransaction(pending.eventId, pending.actionTransactionId);
    if (linked?.status !== "linked") return unresolved({ ...actionResult, error: linked?.error || "practice_transaction_link_failed" });
    state.pendingResult = null;
    const eventResult = choose(pending.eventId, pending.choiceId, { afterRealmPractice: true });
    releaseRealmEventChoice(pending.eventId, pending.transactionId);
    state.world.pendingRealmChoice = null;
    if (eventResult.error) return { ...eventResult, practiceReceipt: actionResult };
    eventResult.snapshot = snapshot();
    return { ...eventResult, practiceReceipt: actionResult, realmPracticeAction: true };
  }

  function normalizeCosts(costs) {
    const out = {};
    for (const [key, value] of Object.entries(costs)) {
      if (key === "items") continue;
      if (key.startsWith("r4_item_") || key.startsWith("r6_item_")) out[key] = Number(resolveValue(value) || 0);
      else if (key === "wealth" || key === "health" || key === "power") out[key] = Number(resolveValue(value) || 0);
    }
    for (const item of costs.items || []) out[resolveValue(item.item)] = (out[resolveValue(item.item)] || 0) + Number(resolveValue(item.quantity) || 0);
    return out;
  }
  function inventoryLotPlan(itemId, quantity, { sourceId = null } = {}) {
    const lots = state.character.inventoryLedger?.[itemId] || [];
    const aggregate = lots.reduce((sum, lot) => sum + Math.max(0, Number(lot.quantity || 0)), 0);
    if (aggregate > Number(state.character.inventory?.[itemId] || 0)) return null;
    let remaining = Number(quantity || 0); const plan = [];
    for (let lotIndex = 0; lotIndex < lots.length; lotIndex += 1) {
      if (remaining <= 0) break;
      const lot = lots[lotIndex];
      if (lot.ownership !== "owned" || (sourceId && lot.sourceId !== sourceId)) continue;
      const used = Math.min(Math.max(0, Number(lot.quantity || 0)), remaining);
      if (used) { plan.push({ lotIndex, sourceId: lot.sourceId, quantity: used }); remaining -= used; }
    }
    return remaining === 0 ? plan : null;
  }
  function canAfford(costs) { return Object.entries(costs).every(([key, amount]) => key.startsWith("r4_item_") || key.startsWith("r6_item_") ? inventoryLotPlan(key, amount) !== null : Number(state.character[key === "wealth" ? "cashWen" : key] || 0) >= amount); }
  function consumeInventoryLots(itemId, quantity, selections = null) {
    const plan = selections || inventoryLotPlan(itemId, quantity);
    if (!plan) return null;
    for (const selection of plan) {
      const lot = state.character.inventoryLedger?.[itemId]?.[selection.lotIndex];
      if (!lot || lot.sourceId !== selection.sourceId || lot.ownership !== "owned" || Number(lot.quantity || 0) < selection.quantity) return null;
    }
    for (const selection of plan) {
      const lot = state.character.inventoryLedger[itemId][selection.lotIndex];
      lot.quantity -= selection.quantity;
      if (lot.quantity === 0) lot.lastConsumedDay = state.worldDay;
    }
    return clone(plan);
  }
  function consumeCosts(costs) { for (const [key, amount] of Object.entries(costs)) { if (key.startsWith("r4_item_") || key.startsWith("r6_item_")) { if (!consumeInventoryLots(key, amount)) throw new Error(`owned_inventory_lots_insufficient:${key}`); state.character.inventory[key] -= amount; } else state.character[key === "wealth" ? "cashWen" : key] -= amount; } }

  function finishTransaction(outcome, option, event, advanceResult = null) {
    if (event.id === "r4_daily_breakthrough" && option.id === "attempt_now") {
      const rules = pack.progressionRules || {};
      const fortune = Number(state.character.dimensionMilliPoints?.fortune || 0);
      const chanceBasisPoints = Math.min(9500, Number(rules.successChancePercent || 0) * 100 + fortune);
      outcome = thisRandom() * 10000 < chanceBasisPoints ? "success" : "failure";
    }
    let effects = outcome === "success" ? option.success : option.failure;
    applyEffects(effects, event.id, option.id);
    const tx = state.inFlightTransaction;
    if (event.id === "r4_daily_entrust" && option.id === "accept_and_fulfill" && outcome === "success") {
      state.character.lastWorkDay = state.worldDay;
    }
    if (event.id === "r4_ev_daily_courier") {
      const source = state.world.dailyBusinessSources?.courier;
      const contract = state.world.r6CourierContracts?.find((row) => row.contractId === source?.contractId);
      const parcel = state.world.r6CourierParcels?.find((row) => row.contractId === contract?.contractId);
      const travel = state.suspendedTransactions?.at(-1);
      if (!contract || !parcel || !travel?.r6TravelTransaction) throw new Error("courier_source_or_paused_trip_lost_during_commit");
      const receiptId = `${source.causeId}:decision:${state.character.id}`;
      if (!state.world.r6CourierReceipts[receiptId]) {
        const acceptsDelivery = ["r6_choice_accept_delivery", "verify_dispatch_copy"].includes(option.id);
        const declinesDelivery = ["r6_choice_decline_delivery", "return_to_sender"].includes(option.id);
        const durationRow = r6TimeContract?.timeContract?.actionDurationTable?.find((row) => row.eventId === event.id && row.choiceId === option.id);
        const decisionTicks = Number(durationRow?.durationTicks) || Math.max(0, Number(tx.durationDays || 0) * R6_TICKS_PER_DAY);
        const decisionStartedAtTick = Math.max(0, state.worldTick - decisionTicks);
        const routeTargetAtTickBeforeDecision = Number(travel.targetAtTick ?? Number(travel.targetDay) * R6_TICKS_PER_DAY);
        const remainingRouteTicksAtAccept = Math.max(0, routeTargetAtTickBeforeDecision - decisionStartedAtTick);
        if (acceptsDelivery) {
          if (!isDailyCourierSourceLive() || state.world.r6CourierContracts.some((row) => row.cycleIndex === contract.cycleIndex && row.status === "accepted" && row.acceptedBy === state.character.id)) throw new Error("courier_acceptance_not_available_or_already_claimed");
          contract.decision = "accepted"; contract.acceptedBy = state.character.id; contract.acceptedWorldDay = state.worldDay; contract.acceptedAtTick = state.worldTick;
          contract.mode = travel.r6TravelTransaction.mode;
          contract.remainingRouteTicksAtAccept = remainingRouteTicksAtAccept;
          contract.remainingTravelDaysAtAccept = Math.ceil(remainingRouteTicksAtAccept / R6_TICKS_PER_DAY);
          contract.maxPracticeStopDays = 30; contract.maxAlchemyStopDays = 3; contract.floodDelayAllowanceDays = 4;
          contract.dueAtTickExclusive = state.worldTick + remainingRouteTicksAtAccept + (30 + 3 + 1 + 3 + 7) * R6_TICKS_PER_DAY;
          contract.dueWorldDay = Math.floor((contract.dueAtTickExclusive - 1) / R6_TICKS_PER_DAY);
          contract.status = "accepted"; contract.decisionReceiptId = receiptId;
          parcel.status = "bound_to_character"; parcel.holderId = state.character.id; parcel.boundDay = state.worldDay;
        } else if (declinesDelivery) {
          if (!isDailyCourierSourceLive()) throw new Error("courier_decline_not_available");
          contract.status = "declined"; contract.decision = "declined"; contract.declinedBy = state.character.id; contract.declinedWorldDay = state.worldDay; contract.declinedAtTick = state.worldTick; contract.decisionReceiptId = receiptId;
        } else throw new Error("courier_choice_not_registered");
        travel.targetAtTick = routeTargetAtTickBeforeDecision + decisionTicks;
        travel.targetDay = Math.floor(travel.targetAtTick / R6_TICKS_PER_DAY);
        travel.durationTicks = travel.targetAtTick - Number(travel.startedAtTick ?? Number(travel.startedDay) * R6_TICKS_PER_DAY);
        travel.durationDays = Math.ceil(travel.durationTicks / R6_TICKS_PER_DAY);
        travel.r6TravelTransaction.daysRemaining = Math.max(0, Math.ceil((travel.targetAtTick - state.worldTick) / R6_TICKS_PER_DAY));
        const routeLedger = state.actionTransactionLedger?.[travel.transactionId];
        if (routeLedger) { routeLedger.targetAtTick = travel.targetAtTick; routeLedger.durationTicks = travel.durationTicks; }
        state.world.r6CourierReceipts[receiptId] = { id: receiptId, status: "committed", contractId: contract.contractId, choice: option.id, actorId: state.character.id, day: state.worldDay, decisionAtTick: state.worldTick, durationTicks: decisionTicks, rewardWen: 0, rewardPoints: 0, idempotencyKey: receiptId };
      }
      source.status = "completed";
      if (["r6_choice_decline_delivery", "return_to_sender"].includes(option.id)) {
        const cycle = state.world.r6CourierCycles[String(contract.cycleIndex)];
        const next = cycle?.contractIds.map((id) => state.world.r6CourierContracts.find((row) => row.contractId === id)).find((row) => row?.status === "published");
        if (next && state.worldDay < next.offerEndWorldDayExclusive) {
          state.world.dailyBusinessSources.courier = { ...clone(source), id: `${state.worldId}:r4_ev_daily_courier:${next.contractId}:${state.worldDay}`, causeId: next.causeId, contractId: next.contractId, parcelInstanceId: next.parcelInstanceId, createdDay: state.worldDay, expiresDay: next.offerEndWorldDayExclusive - 1, status: "open" };
          enqueue("r4_ev_daily_courier", state.worldDay, next.causeId);
        }
      }
    }
    if (event.id === "r4_ev_daily_roadmarker" && state.world.dailyBusinessSources?.roadmarker?.provenance?.producer === "r6_weather_generator") {
      const source = state.world.dailyBusinessSources.roadmarker;
      source.status = "responded"; source.responseReceiptId = `${source.causeId}:response:${state.character.id}`;
      state.world.r6FloodClosures[source.routeId].responseReceiptId = source.responseReceiptId;
      state.world.r6WeatherReceipts[source.responseReceiptId] ||= { id: source.responseReceiptId, status: "committed", causeId: source.causeId, actorId: state.character.id, day: state.worldDay, responseDays: 1, idempotencyKey: source.responseReceiptId };
      const travel = state.suspendedTransactions?.at(-1);
      if (travel?.r6TravelTransaction) {
        travel.targetDay += 1; travel.durationDays += 1; travel.r6TravelTransaction.daysTotal += 1;
        travel.r6TravelTransaction.daysRemaining = Math.max(0, travel.targetDay - state.worldDay);
        travel.pauseReason = "r6_flood_wait"; travel.pauseEventId = null;
      }
    }
    if (event.runtimeBinding?.kind === "realm_source") {
      const realmOperation = applyRealmBusinessChoice(event, option, outcome === "success", tx);
      if (event.runtimeBinding.handler === "realm_core_craft" && option.runtimeAction === "realm_craft_finish" && realmOperation?.actualAlchemyOutcome) {
        outcome = realmOperation.actualAlchemyOutcome;
        effects = outcome === "success" ? option.success : option.failure;
        const source = realmSourceFor(event);
        if (source?.resolution) source.resolution.status = outcome === "success" ? "committed_success" : "committed_failure";
        const worldOutcome = state.world.worldOutcomes[event.id];
        if (worldOutcome) worldOutcome.outcomeId = option.outcomeIds?.[outcome] || worldOutcome.outcomeId;
      }
    }
    if (event.id === "r4_ev_daily_publiclesson" && outcome === "success") {
      const source = state.world.dailyBusinessSources?.publicLesson;
      const board = state.world.dailyServiceBoards?.publicLesson;
      const loan = board?.loans?.find((row) => row.id === source?.loan?.id && row.borrowerId === state.character.id && row.status === "open");
      if (!source || !loan) throw new Error("public_lesson_business_source_lost_during_commit");
      loan.status = option.id === "return_with_gap_report" ? "returned_with_gap_report" : "resolved";
      loan.returnedDay = state.worldDay;
      if (option.id === "return_with_gap_report") loan.gapReportedBy = state.character.id;
      board.loanStatus = "available";
      source.status = "completed";
      source.resolution = { status: "committed_success", optionId: option.id, outcomeId: option.outcomeIds?.success || null, loan: clone(loan), boardLoanStatus: board.loanStatus, committedDay: state.worldDay };
      state.world.dailyBusinessConsumedCauses ||= {};
      state.world.dailyBusinessConsumedCauses[`${event.id}:${source.causeId}`] = { eventId: event.id, causeId: source.causeId, sourceId: source.id, outcomeId: option.outcomeIds?.success || null, day: state.worldDay, status: "completed" };
      state.world.worldOutcomes[event.id] = { eventId: event.id, optionId: option.id, outcomeId: option.outcomeIds?.success || null, causeId: source.causeId, lifeIndex: state.character.lifeIndex || 1, day: state.worldDay, sourceId: source.id };
    }
    if (event.id === "r4_ev_daily_roadmarker" && outcome === "success" && option.runtimeAction === "road_replace_sign") {
      const source = state.world.dailyBusinessSources?.roadmarker;
      const board = state.world.dailyServiceBoards?.road;
      if (!source || source.status !== "open" || source.ownerCharacterId !== state.character.id || source.createdDay !== tx.startedDay
        || source.expiresDay < tx.startedDay || source.provenance?.status !== "verified" || !board) throw new Error("roadmarker_business_source_lost_during_commit");
      const receipt = { id: `${source.causeId}:sign-repair`, verifiedDirection: source.route.direction, verifiedBy: source.maintenancePermit.issuedBy, permitId: source.maintenancePermit.routeRecordId, validUntil: state.worldDay + 1, actorId: state.character.id, day: state.worldDay };
      board.sign = { status: "replaced_verified", receipt: clone(receipt) };
      board.maintenanceNotice.status = "closed"; board.status = "closed";
      state.world.roadSignRecords ||= []; state.world.roadSignRecords.push(clone(receipt));
      source.sign = clone(board.sign); source.resolution = { sign: clone(source.sign), noticeStatus: "closed" }; source.status = "completed";
      state.world.worldOutcomes[event.id] = { eventId: event.id, optionId: option.id, outcomeId: option.outcomeIds?.success || null, causeId: source.causeId, lifeIndex: state.character.lifeIndex || 1, day: state.worldDay, sourceId: source.id, roadSignReceipt: clone(receipt) };
    }
    if (event.id === "r4_ev_daily_well_queue") {
      const source = state.world.dailyBusinessSources?.wellQueue;
      const board = state.world.dailyServiceBoards?.well;
      if (!source || source.status !== "open" || source.ownerCharacterId !== state.character.id || source.lifeIndex !== Number(state.character.lifeIndex || 1)
        || source.createdDay !== tx.startedDay || source.expiresDay < tx.startedDay || source.provenance?.status !== "verified" || !board) throw new Error("well_queue_business_source_lost_during_commit");
      let receipt;
      if (outcome === "success" && option.runtimeAction === "well_signed_swap") {
        const consent = board.swapConsents?.[state.character.id];
        if (!consent || consent.status !== "signed" || consent.id !== source.swapConsent?.id || consent.boardId !== board.boardId
          || consent.signers?.[0] !== state.character.id || consent.signers?.[1] !== consent.neighborId) throw new Error("well_swap_consent_missing_or_changed");
        receipt = { id: `${source.causeId}:swap:${state.character.id}:${tx.transactionId}`, status: "signed", actorId: state.character.id, neighborId: consent.neighborId, signers: clone(consent.signers), boardId: board.boardId, day: state.worldDay, causeId: source.causeId };
        board.swapConsents[state.character.id] = { ...clone(consent), receiptId: receipt.id, resolved: true };
      } else if (outcome === "success" && option.runtimeAction === "well_report_damage") {
        const inspection = { id: `${source.causeId}:rope-inspection:${tx.transactionId}`, status: "inspected", repairCauseId: board.repairCauseId, inspectorId: state.character.id, day: state.worldDay, finding: "worn_rope" };
        board.ropeStatus = "damaged"; (board.maintenanceRecords ||= []).push(inspection); receipt = inspection;
      } else {
        receipt = { id: `${source.causeId}:posted-order:${tx.transactionId}`, status: "posted_order_kept", actorId: state.character.id, day: state.worldDay, causeId: source.causeId };
      }
      source.status = "completed"; source.resolution = { status: "committed_success", optionId: option.id, receipt: clone(receipt), committedDay: state.worldDay };
      state.world.dailyBusinessConsumedCauses ||= {};
      state.world.dailyBusinessConsumedCauses[`${event.id}:${source.causeId}`] = { eventId: event.id, sourceId: source.id, causeId: source.causeId, status: "completed", day: state.worldDay };
      state.world.worldOutcomes[event.id] = { eventId: event.id, optionId: option.id, outcomeId: option.outcomeIds?.success || null, causeId: source.causeId, sourceId: source.id, lifeIndex: state.character.lifeIndex || 1, day: state.worldDay, receipt: clone(receipt) };
    }
    if (outcome === "success" && event.id === "r4_l7_after_window_clue") {
      const crisis = state.world.crisisInstances.find((row) => row.id === tx.instanceId && row.family === "lingxu");
      if (crisis && ["world_damage", "plan_failed"].includes(crisis.status)) {
        crisis.rootPhase = "source_clue";
        crisis.source ||= { active: true, extractionRate: crisis.connected ? 1 : 0, links: crisis.connected ? ["r4_faction_hearthguild"] : [] };
        crisis.source.accessible = true;
        state.character.knowledge.lingxuRootSource = { level: "evidence", sourceId: crisis.id, acquiredDay: state.worldDay, characterId: state.character.id };
        state.world.facts.r4_fact_lingxu_root = { status: "source_accessible", sourceRefs: [crisis.id], affectedLinks: clone(crisis.source.links || []), clueDay: state.worldDay, cumulativeExtraction: Number(crisis.source.cumulativeExtraction || 0) };
      }
    }
    if (outcome === "success" && event.id === "r4_l8_root_remedy") {
      const crisis = state.world.crisisInstances.find((row) => row.id === tx.instanceId && row.family === "lingxu");
      if (crisis?.rootPhase === "source_clue" && crisis.source?.active && Number(crisis.source.extractionRate || 0) === 0 && !(crisis.source.links || []).length) {
        crisis.resolution = "root_resolved";
        crisis.rootPhase = "root_resolved";
        crisis.source.active = false;
        state.world.facts.r4_fact_lingxu_root = { status: "root_resolved", sourceRefs: [crisis.id], resolvedDay: state.worldDay, cumulativeExtraction: Number(crisis.source.cumulativeExtraction || 0) };
      }
    }
    if (outcome === "success" && ["r4_ev_era_lingxu_repair", "r4_ev_era_faction_successor"].includes(event.id)) {
      if (!applyEraBusinessChoice(event, option, tx.transactionId)) throw new Error(`era_business_handler_rejected_after_validation:${event.id}:${option.id}`);
    }
    if (event.instanceScope === "market_quote" && outcome === "success" && state.quotes.active) {
      const quote = state.quotes.active;
      quote.receipt = { id: `${quote.id}-receipt`, quoteId: quote.id, day: state.worldDay, side: quote.side, quantity: quote.quantity, totalWealth: quote.totalWealth };
      state.receipts[quote.id] = clone(quote.receipt);
    }
    if (event.id === "r4_ev_daily_ferry") {
      const source = state.world.dailyBusinessSources?.ferry;
      if (source && source.ownerCharacterId === state.character.id && source.status === "open") {
        const crossing = outcome === "success" && option.id === "pay_crossing" ? {
          status: "arrived", from: source.route.from, to: source.route.to, farePaid: source.fare,
          receiptId: `${source.causeId}:crossing`, day: state.worldDay,
          targetReceiptId: source.destinationReceipt.receiptId, routeId: source.route.id, operatorId: source.operatorId
        } : null;
        if (crossing) {
          state.character.location = crossing.to;
          state.world.travelReceipts.push(clone(crossing));
          source.crossing = crossing;
          source.resolution = { crossing: clone(crossing), wealthAfter: state.character.cashWen };
          source.status = "completed";
        } else if (option.id === "yield_to_worker") {
          source.status = "completed";
          source.crossing = { status: "yielded_to_waiting_worker", targetReceiptId: source.destinationReceipt.receiptId, targetRescheduleDay: state.worldDay + 1 };
        } else if (option.id === "check_public_route") {
          source.status = "completed";
          source.crossing = { status: "route_check_scheduled", scheduledDay: state.worldDay + 1, farePaid: 0 };
        }
      }
    }
    tx.status = "completed";
    tx.produced = true;
    tx.completedDay = state.worldDay;
    state.eventClaimLedger[tx.claimKey] = { state: "completed", transactionId: tx.transactionId, outcome };
    state.eventClaimLedger[recordKey(tx.instanceId, event.id, 0)] = { state: "completed", transactionId: tx.transactionId, outcome };
    state.inFlightTransaction = null;
    restoreSuspendedTransaction();
    state.activeEventId = null;
    const queueIndex = state.queue.findIndex((entry) => entry.eventId === event.id && entry.instanceId === tx.instanceId);
    if (queueIndex >= 0) state.queue.splice(queueIndex, 1);
    const instance = state.world.crisisInstances.find((item) => item.id === tx.instanceId);
    if (instance?.family === "opening") { instance.closed = true; instance.closedDay = state.worldDay; instance.status = resolveFact("r4_fact_opening_crisis") || "resolved"; state.world.openingDanger = false; }
    evaluateWorldPlan();
    appendCause(`${event.id}.${option.id}.${outcome}`, event.id, { costs: tx.reservedCost, durationDays: tx.durationDays });
    enqueueFollowups(event);
    settleR4Breakthrough(outcome, option, tx);
    const breakthroughWorldOutcome = state.world.worldOutcomes.r4_daily_breakthrough;
    if (event.id === "r4_daily_breakthrough" && breakthroughWorldOutcome) breakthroughWorldOutcome.outcomeId = option.outcomeIds?.[outcome] || breakthroughWorldOutcome.outcomeId;
    refreshEraEventSources();
    const result = { kind: "result", eventId: event.id, optionId: option.id, outcome, resultText: `${event.presentation?.title || event.id} · ${option.id}`, effects: clone(effects), time: { from: tx.startedDay, to: state.worldDay, durationDays: tx.durationDays }, causeLogEntry: clone(state.causeLog.at(-1)), stoppedAtWorldNode: advanceResult?.stoppedAtWorldNode || null };
    state.pendingResult = clone(result);
    state.lastResult = clone(result);
    result.snapshot = snapshot();
    return clone(result);
  }

  function abortTransaction(option, event, advanceResult = null) {
    const tx = state.inFlightTransaction;
    tx.status = "aborted";
    tx.abortedDay = state.worldDay;
    tx.completedSegments = Math.min(tx.totalSegments, Math.floor((state.worldDay - tx.startedDay) / 30));
    const failureEffects = tx.completedSegments > 0 ? option.failure : [];
    applyEffects(failureEffects, event.id, option.id);
    state.eventClaimLedger[tx.claimKey] = { state: "aborted", transactionId: tx.transactionId, completedSegments: tx.completedSegments };
    state.inFlightTransaction = null;
    restoreSuspendedTransaction();
    state.activeEventId = null;
    appendCause(`${event.id}.${option.id}.aborted`, event.id, { completedSegments: tx.completedSegments });
    const result = { kind: "result", eventId: event.id, optionId: option.id, outcome: "aborted", resultText: "行动已中断；只结算已经完成的整段", time: { from: tx.startedDay, to: state.worldDay, durationDays: state.worldDay - tx.startedDay }, stoppedAtWorldNode: advanceResult?.stoppedAtWorldNode || null };
    state.pendingResult = clone(result);
    state.lastResult = clone(result);
    result.snapshot = snapshot();
    return result;
  }

  function enqueueFollowups(event) {
    for (const rule of event.followupRules || []) {
      if (!testPredicate(rule.when)) continue;
      // Follow-up contracts may point at either an event or a registered player action.
      // Actions are offers, not queueable events: keep them visible and optional.
      if (pack.actions?.[rule.enqueue]) {
        state.world.actionOffers ||= [];
        const offerKey = `${event.id}:${rule.enqueue}:${state.character.id}:${state.worldDay}`;
        if (!state.world.actionOffers.some((offer) => offer.id === offerKey)) {
          state.world.actionOffers.push({ id: offerKey, actionId: rule.enqueue, sourceEventId: event.id, offeredDay: state.worldDay, characterId: state.character.id, status: "available" });
        }
        continue;
      }
      enqueue(rule.enqueue, state.worldDay);
    }
  }

  function availableActionOffers() {
    return clone((state.world.actionOffers || []).filter((offer) => offer.status === "available" && offer.characterId === state.character.id));
  }

  function lifeLimitWorldTick() {
    const character = state.character;
    if (!Number.isSafeInteger(character.lifeStartWorldTick) || !Number.isSafeInteger(character.birthDay) || !Number.isSafeInteger(character.deathDay)) return null;
    const lifespanDays = character.deathDay - character.birthDay;
    return Number.isSafeInteger(lifespanDays) && lifespanDays >= 0
      ? character.lifeStartWorldTick + lifespanDays * R6_TICKS_PER_DAY : null;
  }

  function markDeathAtTick(tick, source) {
    state.character.alive = false;
    state.character.deathDay = Math.floor(tick / R6_TICKS_PER_DAY);
    const generation = state.generations.find((item) => item.characterId === state.character.id);
    if (generation) { generation.status = "dead"; generation.deathDay = state.character.deathDay; }
    appendCause("character_death", source, { deathDay: state.character.deathDay, deathTick: tick });
  }

  function advanceWorldTicks(deltaTicks) {
    if (!Number.isSafeInteger(deltaTicks) || deltaTicks < 0 || state.worldTick + deltaTicks > R6_MAX_WORLD_TICK) return { error: "invalid_world_tick_delta" };
    if (state.inFlightTransaction?.r6TimeReconciliation?.status === "needs_reconciliation") return { error: "in_flight_time_reconciliation_required" };
    const targetTick = state.worldTick + deltaTicks;
    let stoppedAtWorldNode = null;
    let pauseEventId = null;
    while (state.worldTick < targetTick) {
      const nextDayBoundary = (Math.floor(state.worldTick / R6_TICKS_PER_DAY) + 1) * R6_TICKS_PER_DAY;
      const lifeLimit = state.character.alive ? lifeLimitWorldTick() : null;
      if (lifeLimit != null && state.worldTick >= lifeLimit) {
        markDeathAtTick(state.worldTick, "world_clock");
        stoppedAtWorldNode = "death";
        break;
      }
      const nextTick = Math.min(targetTick, nextDayBoundary, lifeLimit != null && lifeLimit > state.worldTick ? lifeLimit : targetTick);
      state.worldTick = nextTick;
      state.worldDay = Math.floor(nextTick / R6_TICKS_PER_DAY);
      state.world.worldDay = state.worldDay;
      if (lifeLimit != null && nextTick === lifeLimit) {
        markDeathAtTick(nextTick, "world_clock");
        stoppedAtWorldNode = "death";
        break;
      }
      if (nextTick !== nextDayBoundary) continue;
      const furnaceStore = state.world.r6PortableFurnaceStore;
      if (furnaceStore && Number.isSafeInteger(Number(furnaceStore.nextDeliveryDay))) {
        while (state.worldDay >= furnaceStore.nextDeliveryDay) {
          furnaceStore.ownedStock = Number(furnaceStore.ownedStock || 0) + 1;
          furnaceStore.leaseStock = Number(furnaceStore.leaseStock || 0) + 2;
          (state.world.r6PortableFurnaceDeliveryReceipts ||= []).push({ id: `${state.worldId}:r6-portable-furnace-delivery:${furnaceStore.nextDeliveryDay}`, sourceId: pack.r6PortableFurnace.saleSourceId, sellerId: pack.r6PortableFurnace.sellerId, day: furnaceStore.nextDeliveryDay, ownedUnits: 1, leaseUnits: 2, status: "delivered" });
          furnaceStore.nextDeliveryDay += Number(pack.r6PortableFurnace.restockIntervalDays);
        }
      }
      if (r6FreeSurvival && realmSourceAdapter === "r5") releaseExpiredMarketQuoteReservations();
      state.character.ageDays = Number.isSafeInteger(state.character.lifeStartWorldTick)
        ? Math.floor((state.worldTick - state.character.lifeStartWorldTick) / R6_TICKS_PER_DAY)
        : state.worldDay - state.character.birthDay;
      state.character.aliveDays += state.character.alive ? 1 : 0;
      updateWorldClock();
      if (state.character.health <= 0) {
        markDeathAtTick(nextTick, "world_calendar");
        stoppedAtWorldNode = "death";
        break;
      }
      processR6CourierDay(state.worldDay);
      const weatherClosure = processR6RouteWeatherDay(state.worldDay);
      const courierSource = openR6CourierEncounter(state.worldDay);
      const activeTrip = state.inFlightTransaction?.r6TravelTransaction;
      if (weatherClosure?.status === "active" && activeTrip?.routeId === "r6_route_willow_mirror") {
        state.inFlightTransaction.pauseReason = "world_node_due";
        state.inFlightTransaction.pauseEventId = "r4_ev_daily_roadmarker";
      }
      if (courierSource && weatherClosure?.status !== "active" && activeTrip?.routeId === "r6_route_willow_mirror") {
        state.inFlightTransaction.pauseReason = "world_node_due";
        state.inFlightTransaction.pauseEventId = "r4_ev_daily_courier";
        stoppedAtWorldNode = "r6_courier_meeting";
        break;
      }
      expireQueuedEvents();
      const hardDue = findHardDueEvent();
      if (hardDue) {
        stoppedAtWorldNode = "world_event_due";
        pauseEventId = hardDue.eventId;
        if (state.inFlightTransaction) {
          state.inFlightTransaction.pauseReason = "world_node_due";
          state.inFlightTransaction.pauseEventId = hardDue.eventId;
        }
        break;
      }
      const pendingFloodRoadmarker = state.inFlightTransaction?.actionId === "r4_action_travel"
        && state.inFlightTransaction.pauseReason === "world_node_due"
        && state.inFlightTransaction.pauseEventId === "r4_ev_daily_roadmarker"
        && state.world.r6FloodClosures?.["r4_loc_willow_market>r4_loc_mirror_stage"]?.status === "active";
      if (pendingFloodRoadmarker) {
        stoppedAtWorldNode = "world_event_due";
        break;
      }
      const trip = state.inFlightTransaction?.r6TravelTransaction;
      if (trip?.routeId === "r6_route_willow_mirror" && trip.waypointStatus !== "passed" && trip.waypointStatus !== "practice_complete"
        && state.world.r6Waystop?.safe === true && state.world.r6Waystop?.status === "open"
        && state.worldDay - Number(state.inFlightTransaction.startedDay) >= Math.ceil(Number(trip.daysTotal) / 2)) {
        trip.waypointStatus = "open";
        trip.waypointId = "r6_site_mirror_post";
        state.inFlightTransaction.pauseReason = "r6_waystop_decision";
        stoppedAtWorldNode = "r6_waystop";
        break;
      }
      if (state.inFlightTransaction) state.inFlightTransaction.completedSegments = Math.min(state.inFlightTransaction.totalSegments, Math.floor((state.worldDay - state.inFlightTransaction.startedDay) / 30));
    }
    state.worldDay = Math.floor(state.worldTick / R6_TICKS_PER_DAY);
    state.world.worldDay = state.worldDay;
    state.world.worldEventQueue = clone(state.queue.filter((item) => item.day > state.worldDay));
    return { stoppedAtWorldNode, pauseEventId, worldTick: state.worldTick, worldDay: state.worldDay };
  }

  function advanceDays(days) {
    if (!Number.isSafeInteger(days) || days < 0) return { error: "invalid_world_day_delta" };
    return advanceWorldTicks(days * R6_TICKS_PER_DAY);
  }

  function findHardDueEvent() {
    return state.queue.filter((entry) => {
      if (entry.day > state.worldDay) return false;
      if (entry.eventId === state.inFlightTransaction?.eventId) return false;
      const event = eventById.get(entry.eventId);
      return ["world_node", "crisis"].includes(event?.type) && eventAvailable(event) && eventView(event).options.some((option) => option.available);
    }).sort((a, b) => a.eventId.localeCompare(b.eventId) || a.instanceId.localeCompare(b.instanceId))[0] || null;
  }

  function expireQueuedEvents() {
    const expired = state.queue.filter((entry) => {
      const event = eventById.get(entry.eventId);
      if (!event?.window || event.window.until == null) return false;
      return withEventContext(event, () => {
        const until = resolvePath(event.window.until);
        return Number.isFinite(Number(until)) && state.worldDay > Number(until);
      });
    });
    for (const entry of expired) {
      const event = eventById.get(entry.eventId);
      withEventContext(event, () => applyEffects(event.expiryEffects || [], event.id));
      if (event.instanceScope === "character_opening" && event.type === "origin") {
        const instance = state.world.crisisInstances.find((item) => item.id === entry.instanceId);
        if (instance) instance.closed = true, instance.status = "expired", instance.closedDay = state.worldDay;
        if (state.world.openingInstance?.id === entry.instanceId) state.world.openingDanger = false;
      }
      const key = recordKey(entry.instanceId, entry.eventId, 0);
      state.eventClaimLedger[key] ||= { state: "expired", worldDay: state.worldDay };
      appendCause(`${event.id}.expired`, event.id, { instanceId: entry.instanceId });
      state.queue = state.queue.filter((queued) => queued !== entry);
    }
  }

  function mergeQueue(current, due) { const keys = new Set(current.map((item) => `${item.eventId}:${item.instanceId}`)); return [...current, ...due.filter((item) => !keys.has(`${item.eventId}:${item.instanceId}`))]; }

  function restoreSuspendedTransaction() {
    if (state.inFlightTransaction || !state.suspendedTransactions?.length || !state.character.alive) return;
    const resumed = state.suspendedTransactions.pop();
    if (resumed?.r6TravelTransaction?.waystopResumeDays != null) {
      const daysCompleted = Number(resumed.r6TravelTransaction.daysCompleted || 0);
      resumed.startedDay = state.worldDay - daysCompleted;
      resumed.targetDay = state.worldDay + Number(resumed.r6TravelTransaction.waystopResumeDays);
      resumed.targetAtTick = state.worldTick + Number(resumed.r6TravelTransaction.waystopResumeDays) * R6_TICKS_PER_DAY;
      resumed.durationTicks = resumed.targetAtTick - resumed.startedAtTick;
      resumed.durationDays = Math.ceil(resumed.durationTicks / R6_TICKS_PER_DAY);
      const ledger = state.actionTransactionLedger?.[resumed.transactionId];
      if (ledger) { ledger.targetAtTick = resumed.targetAtTick; ledger.durationTicks = resumed.durationTicks; }
      resumed.pauseReason = null;
      resumed.r6TravelTransaction.waypointStatus = "practice_complete";
      resumed.r6TravelTransaction.lastProcessedWorldDay = state.worldDay;
      delete resumed.r6TravelTransaction.waystopResumeDays;
    }
    state.inFlightTransaction = resumed;
  }

  function resumeTravelFromWaystop() {
    const tx = state.inFlightTransaction;
    if (tx?.actionId !== "r4_action_travel" || tx.pauseReason !== "r6_waystop_decision" || tx.r6TravelTransaction?.waypointId !== "r6_site_mirror_post") return { error: "registered_waystop_pause_required" };
    tx.pauseReason = null;
    tx.r6TravelTransaction.waypointStatus = "passed";
    return { kind: "progress", transaction: clone(tx), snapshot: snapshot() };
  }

  function beginTravelPractice(skillId) {
    const tx = state.inFlightTransaction;
    const trip = tx?.r6TravelTransaction;
    const site = state.world.r6Waystop;
    if (tx?.actionId !== "r4_action_travel" || tx.pauseReason !== "r6_waystop_decision" || trip?.waypointId !== "r6_site_mirror_post") return { error: "registered_waystop_pause_required" };
    if (!site || site.status !== "open" || site.safe !== true || site.portableAlchemyAllowed !== true) return { error: "registered_safe_waystop_unavailable" };
    if (!state.character.learnedSkills.includes(skillId) || state.character.skillRecords?.[skillId]?.lifeIndex !== Number(state.character.lifeIndex || 1)) return { error: "current_life_skill_not_learned" };
    if (Number(state.character.health || 0) <= 1) return { error: "practice_health_floor" };
    const remainingDays = Math.max(0, Number(tx.targetDay) - Number(state.worldDay));
    trip.waystopResumeDays = remainingDays;
    state.suspendedTransactions ||= [];
    state.suspendedTransactions.push(clone(tx));
    state.inFlightTransaction = null;
    const result = practiceSkill({ skillId });
    if (result?.error || result?.kind !== "progress") {
      state.inFlightTransaction = state.suspendedTransactions.pop() || tx;
      return result?.error ? result : { error: "waystop_practice_not_started" };
    }
    return result;
  }

  function updateWorldClock() {
    const day = state.worldDay;
    state.world.demandInstance = state.world.workBoard?.find((task) => task.status === "open" && task.openDay <= day && task.deadlineDay >= day) || null;
    for (const crisis of state.world.crisisInstances) {
      if (crisis.closed && !(crisis.family === "lingxu" && ["world_damage", "plan_failed"].includes(crisis.status) && crisis.resolution !== "root_resolved")) continue;
      const age = day - crisis.createdDay;
      const plan = pack.crises[crisis.family];
      if (!plan) continue;
      for (const eventId of plan?.eventIds || []) {
        const event = eventById.get(eventId);
        const from = event?.window?.from == null ? crisis.createdDay : withEventContext(event, () => resolvePath(event.window.from));
        if (event && Number.isFinite(Number(from)) && day >= Number(from)) enqueue(eventId, Number(from), crisis.id);
      }
      const nodes = plan?.nodes || [];
      if (crisis.family === "lingxu") {
        if (age >= (Number(nodes[0]?.day) || 90) && !crisis.affectedBatch) {
          const clueId = plan.eventIds.find((eventId) => eventById.get(eventId)?.type === "crisis_clue");
          const clue = eventById.get(clueId);
          crisis.affectedBatch = { id: `${crisis.id}:batch:001`, available: true, examined: false, location: seedConfig.instanceRuntime?.[crisis.family]?.affectedBatchLocationId || clue?.location, expiryDay: crisis.createdDay + 120, weakQuality: false };
          state.world.affectedBatch = crisis.affectedBatch;
        }
        if (crisis.affectedBatch?.available && day <= crisis.affectedBatch.expiryDay && state.character.alive && state.character.location === crisis.affectedBatch.location && (KNOWLEDGE_LEVELS[state.character.knowledge.affectedBatch?.level] || 0) < KNOWLEDGE_LEVELS.witnessed) {
          state.character.knowledge.affectedBatch = { level: "witnessed", sourceId: crisis.affectedBatch.id, acquiredDay: day, characterId: state.character.id };
        }
        if (age >= (Number(nodes[1]?.day) || 180)) { crisis.springDecline = true; state.world.region.springDecline = true; }
        if (!crisis.terminalOutcomeApplied && age >= (Number(nodes[2]?.day) || 270) && !crisis.countered) {
          const hasTwoSites = Array.isArray(crisis.siteIds) && new Set(crisis.siteIds).size >= 2;
          if (hasTwoSites && crisis.supportChain && crisis.resources) {
            crisis.connected = true;
            crisis.stage = "connected";
            crisis.status = "connected";
          }
        }
      }
      if (crisis.family === "resonance") {
        const participant = state.world.npcRecords[crisis.participantId];
        const participantAge = day - Number(participant?.markDay ?? crisis.createdDay);
        if (participantAge >= (Number(nodes[0]?.day) || 45) && crisis.participantAccepted) {
          participant.symptomOpen = true;
          if (state.character.alive && state.character.location === participant.location) {
            const knowledge = state.character.knowledge.participantSymptom;
            if ((KNOWLEDGE_LEVELS[knowledge?.level] || 0) < KNOWLEDGE_LEVELS.witnessed) {
              state.character.knowledge.participantSymptom = { level: "witnessed", sourceId: crisis.id, acquiredDay: day, characterId: state.character.id };
            }
          }
        }
        if (age >= (Number(nodes[1]?.day) || 120) && crisis.promotionActive && crisis.relayCapacity) {
          crisis.relayActive = true;
          const schedule = state.world.publicSchedules?.promotion || {};
          const accepted = Number(state.world.promotion?.acceptedCount || 0);
          crisis.networkThreshold = accepted >= 1 && Number(schedule.capacity || 0) > accepted;
        }
        if (age >= (Number(nodes[2]?.day) || 240) && !crisis.countered && crisis.status === "active") {
          if (crisis.relayActive && crisis.networkThreshold) {
            crisis.status = "incursion";
            crisis.stage = "incursion";
            state.world.worldOutcomes[crisis.family] = "incursion";
            appendCause("world_node", crisis.id, { family: crisis.family, status: "incursion" });
          } else if (!crisis.promotionActive) {
            crisis.status = "natural_failure";
            crisis.stage = "promotion_stopped";
            crisis.terminalDay = day;
            crisis.terminalOutcomeApplied = true;
            crisis.closed = true;
            state.world.worldOutcomes[crisis.family] = "natural_failure";
            appendCause("world_node", crisis.id, { family: crisis.family, status: "natural_failure" });
          }
        }
      }
      // Later informational/aftermath nodes must not delay the authored terminal outcome.
      // The current B pack separates the day-360 world_damage node from its day-361
      // after-window clue; using max(nodes) left the crisis connected for one extra day.
      const terminalDay = Number(nodes.find((node) => node.id === "world_damage")?.day) || Math.max(0, ...nodes.map((node) => Number(node.day) || 0));
      if (crisis.family === "lingxu" && age >= terminalDay && !crisis.countered && !crisis.terminalOutcomeApplied && ["active", "connected"].includes(crisis.status)) {
        crisis.terminalOutcomeApplied = true;
        crisis.status = crisis.connected ? "world_damage" : "plan_failed";
        crisis.terminalDay = day;
        crisis.closed = true;
        state.world.worldOutcomes[crisis.family] = crisis.status;
        appendCause("world_node", crisis.id, { family: crisis.family, status: crisis.status, connected: Boolean(crisis.connected) });
        const aftermath = plan.eventIds.find((eventId) => eventById.get(eventId)?.type === "aftermath");
        if (aftermath) enqueue(aftermath, day, crisis.id);
      }
      const late = pack.crises.lingxu?.latePhaseAssumptions || {};
      const afterWindowDay = Number(nodes.find((node) => node.id === "after_window_root_phase")?.day || 0);
      if (crisis.family === "lingxu" && age >= afterWindowDay && ["world_damage", "plan_failed"].includes(crisis.status) && crisis.resolution !== "root_resolved") {
        crisis.resolution ||= "unresolved";
        crisis.rootPhase ||= "after_window";
        crisis.source ||= { active: true, extractionRate: crisis.connected ? 1 : 0, links: crisis.connected ? ["r4_faction_hearthguild"] : [], cumulativeExtraction: 0 };
        const source = crisis.source;
        if (source.active) source.cumulativeExtraction = Number(source.cumulativeExtraction || 0) + Number(source.extractionRate || 0) * Number(late.unresolvedExtractionUnitsPerDay || 1);
        state.world.facts.r4_fact_lingxu_root = { status: source.active ? "source_accessible" : "root_resolved", sourceRefs: [crisis.id], affectedLinks: clone(source.links || []), cumulativeExtraction: Number(source.cumulativeExtraction || 0) };
        if (Number(source.cumulativeExtraction || 0) >= Number(late.linkedOrganizationCollapseUnits || Infinity)) {
          for (const factionId of source.links || []) {
            const faction = state.world.factions[factionId];
            const receiptId = `${crisis.id}:organization-collapse:${factionId}`;
            if (!faction || state.world.worldNodeReceipts[receiptId]) continue;
            faction.status = "dissolved";
            faction.dissolvedDay = day;
            faction.publicHealingService = false;
            faction.publicCourse = false;
            if (!state.world.destroyedOrganizations.includes(factionId)) state.world.destroyedOrganizations.push(factionId);
            state.world.organizationCauseIds[factionId] = receiptId;
            state.world.worldNodeReceipts[receiptId] = { day, sourceInstanceId: crisis.id, extractionUnits: source.cumulativeExtraction, cause: "linked_source_depletion" };
            appendCause("organization_dissolved", factionId, { causeId: receiptId, extractionUnits: source.cumulativeExtraction, sourceInstanceId: crisis.id });
          }
        }
      }
    }
    settleDestroyedOrganizations();
    refreshEraEventSources();
    if (state.worldDay % pack.caps.herbRestockDays === 0) for (const location of Object.values(state.world.locations || {})) {
      if (Object.hasOwn(location, "harvestableStock")) location.harvestableStock = pack.caps.dailyHerbStockPerLocation;
    }
  }

  function performAction(actionId, payload = {}) {
    if (r6FreeSurvival && realmSourceAdapter === "r5" && actionId === "r6_stranded_return") return startR6StrandedReturn();
    if (actionId === "r6_action_buy_travel_ration") return buyTravelRations(payload);
    const config = pack.actions[actionId];
    if (!config) return { error: "unknown_action" };
    switch (actionId) {
      case "r4_action_practice": return payload.mode === "study" ? studyManual(payload) : practiceSkill(payload);
      case "r4_action_alchemy": return startConfiguredAction(actionId, config, payload);
      case "r4_action_array": return payload.mode === "study" ? studyArray(payload) : startConfiguredAction(actionId, config, payload);
      case "r4_action_spell": return startConfiguredAction(actionId, config, payload);
      case "r4_action_travel": return travel(payload);
      case "r6_action_buy_travel_ration": return buyTravelRations(payload);
      case "r4_action_social": return social(payload);
      case "r4_action_contest": return contest(payload);
      case "r4_action_recover": return recover(payload);
      default: return { error: "unsupported_action" };
    }
  }

  function transaction(actionId, days, costs, completion) {
    if (state.inFlightTransaction) return { error: "transaction_in_flight" };
    if (state.pendingResult) return { error: "pending_result_must_be_acknowledged" };
    if (!Number.isSafeInteger(days) || days < 0 || !completion?.type) return { error: "invalid_transaction_contract" };
    if (!canAfford(costs)) return { error: "insufficient_resource" };
    const contractRows = r6TimeContract?.timeContract?.actionDurationTable || [];
    const socialService = completion?.type === "social_service" ? completion.service : null;
    const isHealerDose = socialService === "healer_dose_service" || socialService === "healer_dose";
    const isVisit = actionId === "r4_action_social" && days > 0 && !isHealerDose;
    const registeredActionTicks = actionId === "r4_action_practice" && completion?.type === "manual_study"
      ? contractRows.find((row) => row.actionId === "r6_action_practice_study")?.durationTicks
      : actionId === "r4_action_array" && completion?.type === "array_study"
        ? contractRows.find((row) => row.actionId === "r6_action_array_study")?.durationTicks
        : actionId === "r4_action_array" && completion?.type === "array_deploy"
          ? contractRows.find((row) => row.actionId === "r6_action_array_deploy")?.durationTicks
          : null;
    const specializedTicks = isHealerDose
      ? contractRows.find((row) => row.actionId === "r6_action_healer_dose")?.durationTicks
      : isVisit ? contractRows.find((row) => row.actionId === "r6_action_social_visit")?.durationTicks : null;
    if ((isVisit || isHealerDose) && r6TimeContract && !Number.isSafeInteger(specializedTicks)) return { error: "r6_time_contract_action_duration_missing" };
    const durationTicks = registeredActionTicks ?? (isHealerDose
      ? specializedTicks ?? days * R6_TICKS_PER_DAY
      : isVisit ? specializedTicks ?? days * R6_TICKS_PER_DAY
        : days * R6_TICKS_PER_DAY);
    if (!Number.isSafeInteger(durationTicks) || durationTicks < 0 || state.worldTick + durationTicks > R6_MAX_WORLD_TICK) return { error: "invalid_transaction_contract" };
    consumeCosts(costs);
    const targetAtTick = state.worldTick + durationTicks;
    const tx = { kind: "action", transactionId: `${state.worldId}-action-${++state.operationSequence}`, worldId: state.worldId, actionId, startedDay: state.worldDay, targetDay: Math.floor(targetAtTick / R6_TICKS_PER_DAY), startedAtTick: state.worldTick, targetAtTick, durationTicks, durationDays: days, reservedCost: clone(costs), completedSegments: 0, totalSegments: Math.max(1, Math.ceil(days / 30)), completion: clone(completion), status: "running", rngStateAtStart: state.rngState, pauseReason: null };
    if (actionId === "r4_action_travel") tx.r6TravelTransaction = {
      id: `R6-TRAVEL-TX-01:${tx.transactionId}`, characterId: state.character.id, routeId: completion.route.routeId,
      mode: completion.mode, daysTotal: days, daysCompleted: 0, daysRemaining: days,
      farePaidWen: completion.mode === "carriage" ? Number(completion.route.wealth || 0) : 0,
      rationsReserved: Number(completion.rationsReserved || 0), status: "in_flight", lastProcessedWorldDay: state.worldDay,
      pauseEventId: null, idempotencyKey: `${state.worldId}:${state.character.id}:${state.character.lifeIndex || 1}:${completion.route.routeId}:${state.worldDay}:${tx.transactionId}`
    };
    state.inFlightTransaction = tx;
    state.suspendedTransactions ||= [];
    state.actionTransactionLedger[tx.transactionId] = { status: "running", actionId, startedDay: tx.startedDay, startedAtTick: tx.startedAtTick, targetAtTick: tx.targetAtTick, durationTicks };
    if (Object.keys(costs).length) appendCause(`${actionId}.reserved`, actionId, { transactionId: tx.transactionId, reservedCost: clone(costs) });
    if (durationTicks === 0) return finishActionTransaction();
    return { kind: "progress", transaction: clone(tx), snapshot: snapshot() };
  }

  function finishActionTransaction() {
    const tx = state.inFlightTransaction;
    if (!tx || tx.kind !== "action") return { error: "action_transaction_missing" };
    if (!state.character.alive) return interruptActionByDeath();
    if (state.worldTick < tx.targetAtTick) return { kind: "progress", transaction: clone(tx), snapshot: snapshot() };
    const spec = tx.completion;
    let outcome = "success";
    let changes = {};
    let resultText = "行动完成，结果已记下。";
    switch (spec.type) {
      case "practice":
        state.character.power += spec.power;
        state.character.health = Math.max(0, state.character.health + spec.health);
        if (realmSourceAdapter !== "r5") {
          const failedAttempt = [...(state.character.breakthroughReceipts || [])].reverse().find((row) => row.lifeIndex === Number(state.character.lifeIndex || 1) && row.outcome === "failure" && !row.recoveryWindowId);
          if (failedAttempt) {
            state.character.preparationWindowId = Number(state.character.preparationWindowId || state.character.generation || 1) + 1;
            failedAttempt.recoveryWindowId = state.character.preparationWindowId;
            failedAttempt.recoveryStartedDay = state.worldDay;
          }
        }
        if (realmSourceAdapter === "r5") (state.character.skillPracticeLedger ||= []).push({ id: tx.transactionId, actionTransactionId: tx.transactionId, characterId: state.character.id, lifeIndex: Number(state.character.lifeIndex || 1), skillId: spec.skillId, day: state.worldDay, durationDays: tx.durationDays, status: "completed", outcome: "success" });
        changes = { power: spec.power, health: spec.health };
        resultText = "一轮吐纳告一段落，修为有所沉淀。";
        break;
      case "manual_study":
        state.character.studyProgress[spec.skillId] = Math.min(100, (state.character.studyProgress[spec.skillId] || 0) + spec.progress);
        if (state.character.studyProgress[spec.skillId] >= 100 && !state.character.learnedSkills.includes(spec.skillId)) {
          state.character.learnedSkills.push(spec.skillId);
          state.character.skills[spec.skillId] = { stage: 1, learnedDay: state.worldDay, sourceId: spec.sourceId };
        }
        changes = { studyProgress: state.character.studyProgress[spec.skillId] };
        resultText = `研读进度 ${state.character.studyProgress[spec.skillId]}%。`;
        break;
      case "array_study":
        state.character.studyProgress.r4_skill_array = Math.min(100, (state.character.studyProgress.r4_skill_array || 0) + spec.progress);
        if (state.character.studyProgress.r4_skill_array >= 100 && !state.character.learnedSkills.includes("r4_skill_array")) {
          state.character.learnedSkills.push("r4_skill_array");
          state.character.skills.r4_skill_array = { stage: 1, learnedDay: state.worldDay, sourceId: spec.sourceId };
        }
        changes = { studyProgress: state.character.studyProgress.r4_skill_array };
        resultText = `阵图研读进度 ${state.character.studyProgress.r4_skill_array}%。`;
        break;
      case "alchemy": {
        const success = thisRandom() < spec.successChance;
        outcome = success ? "success" : "failure";
        if (success) for (const [item, count] of Object.entries(spec.successItems)) {
          const amount = Number(count || 0);
          state.character.inventory[item] = Number(state.character.inventory[item] || 0) + amount;
          (state.character.inventoryLedger[item] ||= []).push({ quantity: amount, acquiredDay: state.worldDay, ownership: "owned", sourceId: tx.transactionId });
        }
        changes = { produced: success ? clone(spec.successItems) : {} };
        resultText = success ? "炼制完成，成品已入账。" : "炼制未成，投入材料已消耗。";
        break;
      }
      case "spell":
        state.character.proficiency[spec.skillId] = (state.character.proficiency[spec.skillId] || 0) + spec.proficiency;
        changes = { proficiency: state.character.proficiency[spec.skillId] };
        break;
      case "array_deploy":
        state.character.facts.r4_fact_location_guard = true;
        changes = { locationGuard: true };
        break;
      case "travel": {
        state.character.location = spec.destination;
        if (Number(spec.missingRations || 0) > 0) {
          const healthLoss = Number(spec.missingRations);
          state.character.health = Math.max(0, Number(state.character.health || 0) - healthLoss);
          changes.health = -healthLoss;
          changes.missingRations = healthLoss;
          resultText = `抵达已知地点；途中少了 ${healthLoss} 份口粮，身况下降 ${healthLoss}。`;
        }
        const newlyKnown = pack.runtimeSources.worldInitialization.routes
          .filter((route) => route.from === spec.destination && route.knownFromOrigin?.includes(state.character.origin))
          .map((route) => route.to);
        state.character.knownLocations = [...new Set([...(state.character.knownLocations || []), ...newlyKnown])];
        const source = pack.runtimeSources.worldInitialization.marketKnowledgeSource;
        if (source.locations.includes(spec.destination)) state.character.knowledge[source.knowledgeKey] = { level: source.level, sourceId: source.sourceAction, acquiredDay: state.worldDay, characterId: state.character.id };
        const promotion = state.world.publicSchedules?.promotion;
        if (promotion && spec.destination === promotion.location && state.worldDay >= Number(promotion.openDay) && state.worldDay <= Number(promotion.closeDay)) {
          state.character.knowledge.promotionEvent = { level: "heard", sourceId: `public-schedule:${promotion.eventId}`, acquiredDay: state.worldDay, characterId: state.character.id };
        }
        const batch = state.world.crisisInstances.find((item) => item.family === "lingxu" && !item.closed)?.affectedBatch;
        if (batch?.available && spec.destination === batch.location && state.worldDay <= Number(batch.expiryDay)) {
          const previous = state.character.knowledge.affectedBatch;
          if ((KNOWLEDGE_LEVELS[previous?.level] || 0) < KNOWLEDGE_LEVELS.witnessed) {
            state.character.knowledge.affectedBatch = { level: "witnessed", sourceId: batch.id, acquiredDay: state.worldDay, characterId: state.character.id };
          }
        }
        changes = { location: spec.destination };
        resultText = `抵达已知地点：${spec.destination}。`;
        break;
      }
      case "social": {
        const rel = state.character.relationships[spec.personId] ||= { lastGainDay: -Infinity, value: 0 };
        const month = Math.floor(state.worldDay / pack.calendar.daysPerMonth);
        if (Math.floor(rel.lastGainDay / pack.calendar.daysPerMonth) !== month) rel.value += 1, rel.lastGainDay = state.worldDay;
        changes = { relationship: rel.value };
        break;
      }
      case "social_service": {
        const neighbor = state.world.npcRecords[spec.personId];
        if (HIGH_REALM_SERVICE_TARGETS[spec.service]) {
          const committed = commitHighRealmProducer(spec.service, spec.personId, tx.transactionId);
          if (committed?.status !== "committed") {
            outcome = "failure"; changes = { socialService: spec.service, failure: committed?.error || "high_realm_service_rejected" };
            resultText = "当前公共服务条件已变化，未产生授权记录。"; break;
          }
          changes = { socialService: spec.service, receiptId: committed.record.id, handler: committed.record.handler };
          resultText = "正式服务已完成，来源回执已登记。";
          break;
        }
        if (spec.service === "review_alchemy_and_request_contribution_consent") {
          const batch = (state.world.craftBatchLedger || []).find((row) => row.id === spec.recordId && row.actorId === state.character.id && row.lifeIndex === Number(state.character.lifeIndex || 1) && ["completed", "failed"].includes(row.status));
          const contributor = state.world.npcRecords[spec.personId];
          if (!batch || !contributor || contributor.alive !== true || contributor.locationId !== state.character.location || contributor.researchContributionPreference !== "wants_contribution_trace") {
            outcome = "failure"; changes = { socialService: spec.service, failure: "contributor_or_batch_changed_during_review" }; resultText = "贡献者或本世炼制记录已变化，未生成签认。"; break;
          }
          const review = { id: `research-review:${batch.id}:${contributor.id}:${tx.transactionId}`, status: "completed", recordId: batch.id, playerId: state.character.id, contributorId: contributor.id, observedAlchemyOutcome: batch.outcome, day: state.worldDay, lifeIndex: Number(state.character.lifeIndex || 1), sourceBatchCauseId: batch.causeId };
          const consent = { id: `contributor-consent:${review.id}`, status: "signed", signerId: contributor.id, contributorId: contributor.id, recordId: batch.id, scope: "append_contribution_provenance_or_publish_anonymized_method", day: state.worldDay, lifeIndex: Number(state.character.lifeIndex || 1), reviewId: review.id, response: "consent_to_trace_contribution" };
          review.consentId = consent.id; (state.world.researchReviews ||= []).push(review); (contributor.contributionConsentRecords ||= []).push(consent);
          if (!(state.world.researchRecords || []).some((row) => row.id === batch.id)) state.world.researchRecords.push({ id: batch.id, status: "draft", ownerId: state.character.id, contributorId: contributor.id, sourceBatchCauseId: batch.causeId, observedAlchemyOutcome: batch.outcome, reviewId: review.id, createdDay: state.worldDay });
          changes = { socialService: spec.service, reviewId: review.id, consentId: consent.id, batchId: batch.id }; resultText = "本世炼制结果已核对，贡献者对该记录签署了来源说明许可。"; break;
        }
        if (spec.service === "request_furnace_rental") {
          const owner = state.world.npcRecords.r4_npc_wen_repairer; const skillId = spec.skillId; const skill = state.character.skillRecords?.[skillId] || {}; const day = state.worldDay;
          const active = state.world.rentalLedger.find((row) => row.tenantId === state.character.id && row.locationId === state.character.location && row.status === "active" && row.dueDay >= day);
          if (!owner || owner.alive !== true || owner.locationId !== state.character.location || owner.onDuty !== true || skill.lifeIndex !== Number(state.character.lifeIndex || 1) || !state.character.learnedSkills?.includes(skillId) || !["r4_skill_dao01", "r4_skill_dao02"].includes(skillId) || state.world.equipment?.["public-kiln"]?.status === "out_of_service" || active) {
            outcome = "failure"; changes = { socialService: spec.service, failure: "owner_furnace_or_current_learning_changed_before_rental" }; resultText = "炉主、当前所学或可用租期条件已变化，租赁未签发。"; break;
          }
          const leaseId = `furnace-lease:${state.character.id}:${day}:${tx.transactionId}`; const termDays = 7;
          const permit = { location: state.character.location, issuedDay: day, issuedAtTick: state.worldTick, validDays: termDays, expiresAtTickExclusive: (day + termDays + 1) * R6_TICKS_PER_DAY, status: "valid", ownerId: owner.id, leaseId, sourceActionId: tx.transactionId, authorizedSkillIds: [skillId] };
          const lease = { leaseId, status: "active", ownerId: owner.id, tenantId: state.character.id, locationId: state.character.location, amount: 100, currency: "cashWen", issuedDay: day, dueDay: day + termDays, termDays, permitId: tx.transactionId, extensionOffer: { status: "not_offered", signedBy: null, ownerId: owner.id }, sourceActionId: tx.transactionId };
          state.character.permits.furnace = permit; state.world.rentalLedger.push(lease); (state.world.furnaceRentalReceipts ||= []).push({ id: tx.transactionId, status: "issued", tenantId: state.character.id, ownerId: owner.id, leaseId, permitId: tx.transactionId, issuedDay: day, dueDay: day + termDays, amount: 100, currency: "cashWen" });
          (state.facts.r4_fact_furnace_permit ||= []).push({ leaseId, tenantId: state.character.id, ownerId: owner.id, issuedDay: day, dueDay: day + termDays, sourceActionId: tx.transactionId });
          changes = { leaseId, permit, wealth: -100 }; resultText = "七日炉位租约与许可已登记。"; break;
        }
        if (spec.service === "request_furnace_lease_extension") {
          const lease = state.world.rentalLedger.find((row) => row.leaseId === spec.leaseId && row.tenantId === state.character.id); const owner = state.world.npcRecords[spec.personId]; const day = state.worldDay;
          const remoteDelivery = Boolean(lease && state.character.location === "r4_loc_willow_market" && owner?.locationId === lease.locationId && state.character.knownLocations?.includes(owner.locationId) && state.world.services?.waykeeper?.active === true);
          const localResponse = owner?.locationId === state.character.location;
          if (!lease || lease.status !== "active" || lease.dueDay > day || lease.ownerId !== owner?.id || owner.alive !== true || !(localResponse || remoteDelivery) || owner.furnaceLeaseExtensionPolicy !== "grant_one_7_day_extension_if_due_and_operable" || state.world.equipment?.["public-kiln"]?.status === "out_of_service" || lease.extensionOffer?.status === "preapproved") {
            outcome = "failure"; changes = { socialService: spec.service, failure: "owner_or_due_lease_changed_before_extension_response" }; resultText = "租约或炉主条件已变化，未签发延期。"; break;
          }
          const approval = { id: `lease-extension:${lease.leaseId}:${tx.transactionId}`, status: "preapproved", leaseId: lease.leaseId, tenantId: state.character.id, ownerId: owner.id, signedBy: owner.id, termsId: `${lease.leaseId}:one-more-term`, termDays: 7, issuedDay: day, expiresDay: day, sourceActionId: tx.transactionId, delivery: { mode: localResponse ? "local" : "public_waykeeper_written_request", from: state.character.location, to: owner.locationId, day }, causeId: tx.transactionId };
          lease.extensionOffer = clone(approval); (state.world.furnaceLeaseExtensionOffers ||= []).push(clone(approval)); changes = { leaseId: lease.leaseId, approval }; resultText = "炉主已签署本租期的一次延期条件。"; break;
        }
        if (!neighbor || neighbor.alive !== true || neighbor.locationId !== state.character.location) {
          outcome = "failure"; changes = { socialService: spec.service, failure: "social_service_participant_changed" };
          resultText = "对方已不在场，服务未签发。"; break;
        }
        const service = spec.service;
        let offer;
        if (service === "request_night_cover_offer") {
          if (neighbor.nightCoverOfferPolicy !== "renew_one_night_cover_for_current_worker" || (!state.character.lastWorkDay && !state.character.birthRecord?.householdId)) {
            outcome = "failure"; changes = { socialService: service, failure: "current_worker_or_neighbor_offer_policy_missing" };
            resultText = "当前工作或家庭来源不符合邻里代值条件。"; break;
          }
          const board = state.world.realmServiceBoards.nightDuty;
          offer = { id: `${state.worldId}:night-cover:${state.character.id}:${state.worldDay}`, status: "offered", personId: neighbor.id, offeredBy: neighbor.id, scope: "one_night_cover", day: state.worldDay, expiresDay: state.worldDay + 1, causeId: tx.transactionId, sourceActionId: tx.transactionId };
          board.coverOffer = clone(offer); (board.coverOfferLedger ||= []).push(clone(offer));
        } else {
          if (service !== "request_roommate_offer" || neighbor.sharedWatchOfferPolicy !== "offer_seven_day_shared_watch_with_player_acceptance" || state.world.realmServiceBoards.housing.ownerId !== neighbor.id) {
            outcome = "failure"; changes = { socialService: service, failure: "current_neighbor_offer_policy_missing" };
            resultText = "当前邻居没有可签发的合住值夜服务。"; break;
          }
          const board = state.world.realmServiceBoards.housing;
          offer = { id: `${state.worldId}:shared-watch-offer:${state.character.id}:${state.worldDay}`, status: "offered", personId: neighbor.id, offeredBy: neighbor.id, scope: "shared_night_watch", day: state.worldDay, expiresDay: state.worldDay + 7, causeId: tx.transactionId, sourceActionId: tx.transactionId };
          board.roommateOffer = clone(offer); (board.roommateOfferLedger ||= []).push(clone(offer));
        }
        changes = { socialService: service, offerId: offer.id };
        resultText = "社交服务已完成，签发记录已写入公共服务板。";
        break;
      }
      case "recover": {
        const before = state.character.health;
        const gain = spec.medicated ? spec.medicatedHealthGain : spec.poorRecovery ? spec.poorHealthGain : state.character.health <= 25 ? spec.poorHealthGain : spec.healthGain;
        state.character.health = Math.min(100, before + gain);
        changes = { health: state.character.health - before };
        resultText = `休整完成，健康恢复 ${state.character.health - before}。`;
        break;
      }
      case "r6_stranded_return": {
        if (Number(state.character.lifeIndex || 1) !== Number(spec.lifeIndex)
          || state.character.location !== spec.fromLocationId || spec.toLocationId !== "r4_loc_ashspring") return { error: "stranded_return_transaction_invalidated" };
        const receipt = state.character.r6StrandedReturnByLife?.[String(spec.lifeIndex)];
        if (!receipt || receipt.transactionId !== tx.transactionId) return { error: "stranded_return_receipt_missing" };
        state.character.location = spec.toLocationId;
        receipt.status = "completed";
        receipt.completedDay = state.worldDay;
        changes = { locationId: state.character.location, fare: 0, wealthGranted: 0 };
        resultText = "你沿熟悉的路回到灰泉镇；此行用了七日，没有花费家资，也没有添得家资。";
        break;
      }
      default: return { error: `unknown_action_completion:${spec.type}` };
    }
    tx.status = "completed";
    tx.completedDay = state.worldDay;
    if (tx.r6TravelTransaction) {
      const trip = { ...clone(tx.r6TravelTransaction), daysCompleted: state.worldDay - tx.startedDay, daysRemaining: 0, status: "completed", lastProcessedWorldDay: state.worldDay };
      (state.world.travelReceipts ||= []).push(trip);
    }
    if (["r4_action_alchemy", pack.r6PortableFurnace?.portableAlchemyActionId].includes(tx.actionId) && realmSourceAdapter === "r5") {
      (state.world.craftBatchLedger ||= []).push({ id: tx.transactionId, actorId: state.character.id, lifeIndex: Number(state.character.lifeIndex || 1), status: outcome === "success" ? "completed" : "failed", outcome, itemId: Object.keys(tx.completion.successItems || {})[0] || null, day: state.worldDay, causeId: tx.transactionId, actionTransactionId: tx.transactionId, ...(tx.completion.furnaceSerialId ? { furnaceSerialId: tx.completion.furnaceSerialId } : {}), ...(tx.completion.leaseId ? { leaseId: tx.completion.leaseId } : {}) });
    }
    state.character.actionLog.push({ actionId: tx.actionId, transactionId: tx.transactionId, skillId: tx.completion.skillId || null, worldDay: state.worldDay, completedAtTick: state.worldTick, durationTicks: tx.durationTicks, durationDays: tx.durationDays, outcome });
    appendCause(`${tx.actionId}.${outcome}`, tx.actionId, { ...changes, skillId: tx.completion.skillId || null, transactionId: tx.transactionId });
    state.inFlightTransaction = null;
    restoreSuspendedTransaction();
    evaluateWorldPlan();
    const result = { kind: "result", actionId: tx.actionId, outcome, resultText, changes, time: { from: tx.startedDay, to: state.worldDay, durationDays: state.worldDay - tx.startedDay } };
    state.pendingResult = clone(result);
    state.actionTransactionLedger[tx.transactionId] = { status: "completed", actionId: tx.actionId, completedDay: state.worldDay, result: clone(result) };
    state.lastResult = clone(result);
    result.snapshot = snapshot();
    return result;
  }

  function interruptActionByDeath() {
    const tx = state.inFlightTransaction;
    if (!tx) return { error: "no_transaction" };
    tx.status = "interrupted_by_death";
    tx.interruptedDay = state.worldDay;
    state.inFlightTransaction = null;
    state.suspendedTransactions = [];
    appendCause("action_interrupted_by_death", tx.actionId, { transactionId: tx.transactionId, noReward: true });
    const result = { kind: "interrupted", outcome: "interrupted", actionId: tx.actionId, time: { from: tx.startedDay, to: state.worldDay, durationDays: state.worldDay - tx.startedDay } };
    state.pendingResult = clone(result);
    state.actionTransactionLedger[tx.transactionId] = { status: "interrupted_by_death", actionId: tx.actionId, completedDay: state.worldDay, result: clone(result) };
    state.lastResult = clone(result);
    result.snapshot = snapshot();
    return result;
  }

  function practiceSkill({ skillId } = {}) {
    if (!state.character.learnedSkills.includes(skillId)) return { error: "skill_not_learned" };
    const rule = pack.actions.r4_action_practice.practice;
    return transaction("r4_action_practice", rule.days, {}, { type: "practice", skillId, power: rule.power, health: rule.health });
  }

  function studyManual({ skillId = "r4_skill_dao01" } = {}) {
    const source = state.character.inventory.r4_item_manual || 0;
    if (!source) return { error: "readable_manual_required" };
    const rule = pack.actions.r4_action_practice.study;
    return transaction("r4_action_study", rule.days, {}, { type: "manual_study", skillId, progress: rule.studyProgress, sourceId: "r4_item_manual" });
  }

  function studyArray() {
    if (!(state.character.inventory.r4_item_array_diagram > 0)) return { error: "array_diagram_required" };
    const rule = pack.actions.r4_action_array.study;
    return transaction("r4_action_array_study", rule.days, {}, { type: "array_study", progress: rule.progress, sourceId: "r4_item_array_diagram" });
  }

  function startConfiguredAction(actionId, config, payload) {
    let days; let costs = {}; let success = {};
    if (actionId === "r4_action_alchemy") {
      if (!state.character.learnedSkills.includes("r4_skill_dao02")) return { error: "learned_powder_recipe_required" };
      const permit = state.character.permits.furnace;
      const permitExpiryTick = Number.isSafeInteger(permit?.expiresAtTickExclusive)
        ? permit.expiresAtTickExclusive : (Number(permit?.issuedDay) + Number(permit?.validDays) + 1) * R6_TICKS_PER_DAY;
      if (!permit || permit.location !== state.character.location || state.worldTick >= permitExpiryTick) return { error: "furnace_permit_invalid_here" };
      if ((state.character.skills.r4_skill_dao02?.stage || 0) < pack.caps.dao02MinimumStage || (state.character.proficiency.r4_skill_dao02 || 0) < pack.caps.dao02MinimumProficiency) return { error: "dao02_proficiency_insufficient" };
      days = config.days; costs = normalizeCosts(config.reservedCost); success = config.success;
      if (state.worldTick + days * R6_TICKS_PER_DAY > permitExpiryTick) return { error: "furnace_permit_expires_before_completion", requiredThroughTick: state.worldTick + days * R6_TICKS_PER_DAY, permitExpiresAtTickExclusive: permitExpiryTick };
    } else if (actionId === "r4_action_spell") {
      if (!state.character.learnedSkills.includes(payload.skillId)) return { error: "learned_ability_required" };
      days = config.days; costs.health = Math.max(0, -config.health); success.proficiency = config.proficiency;
    } else if (actionId === "r4_action_array") {
      days = config.deploy.days; costs = { [payload.materialId || "r4_item_array_material"]: config.deploy.cost.r4_item_array_material };
    } else return { error: "unsupported_action" };
    if (!canAfford(costs)) return { error: "insufficient_resource" };
    const completion = actionId === "r4_action_alchemy"
      ? { type: "alchemy", successChance: config.successChance, successItems: clone(success) }
      : actionId === "r4_action_spell"
        ? { type: "spell", skillId: payload.skillId, proficiency: config.proficiency }
        : { type: "array_deploy" };
    return transaction(actionId, days, costs, completion);
    /*
      const isSuccess = actionId !== "r4_action_alchemy" || thisRandom() < config.successChance;
      if (isSuccess) {
        for (const [item, count] of Object.entries(success)) state.character.inventory[item] = Number(state.character.inventory[item] || 0) + Number(count || 0);
        if (actionId === "r4_action_array") state.character.facts["r4_fact_location_guard"] = true;
        if (actionId === "r4_action_spell") state.character.proficiency[payload.skillId] = (state.character.proficiency[payload.skillId] || 0) + config.proficiency;
      }
      return { kind: "result", actionId, outcome: isSuccess ? "success" : "failure", resultText: isSuccess ? "行動完成，收益已入账。" : "本次未能成事，已消耗的材料不返还。", changes: { produced: isSuccess ? clone(success) : {} } };
  }

    */
  }

  function thisRandom() {
    let x = state.rngState >>> 0;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    state.rngState = x >>> 0 || 1;
    return state.rngState / 0x100000000;
  }

  function travel({ destination, mode = "carriage" } = {}) {
    if (!destination || !state.character.knownLocations?.includes(destination)) return { error: "known_destination_required" };
    const route = pack.runtimeSources.worldInitialization.routes.find((candidate) => candidate.from === state.character.location && candidate.to === destination);
    if (!route) return { error: "registered_route_unavailable" };
    if (!["carriage", "walking"].includes(mode)) return { error: "travel_mode_invalid" };
    if (mode === "carriage" && Number(state.character.cashWen || 0) < Number(route.wealth || 0)) return { error: "insufficient_resource" };
    const travelRoute = mode === "walking" ? { ...route, days: Math.ceil(Number(route.days) * 1.5), wealth: 0 } : route;
    const rationNeed = mode === "walking" ? Math.ceil(Number(travelRoute.days) / 7) : 0;
    const rationHeld = Math.max(0, Number(state.character.inventory?.r6_item_travel_ration || 0));
    const rationsReserved = Math.min(rationNeed, rationHeld);
    const missingRations = Math.max(0, rationNeed - rationsReserved);
    const costs = { ...(mode === "walking" ? {} : { wealth: route.wealth }), ...(rationsReserved ? { r6_item_travel_ration: rationsReserved } : {}) };
    return transaction("r4_action_travel", travelRoute.days, costs, { type: "travel", destination, route: travelRoute, mode, rationsReserved, missingRations });
  }

  function buyTravelRations({ quantity = 1, transactionId } = {}) {
    const receiptId = typeof transactionId === "string" && transactionId ? transactionId : `${state.worldId}:ration:${state.operationSequence + 1}`;
    state.world.r6ProvisionReceipts ||= {};
    if (state.world.r6ProvisionReceipts[receiptId]) return { kind: "duplicate_suppressed", receipt: clone(state.world.r6ProvisionReceipts[receiptId]) };
    const count = Math.floor(Number(quantity));
    const stores = state.world.r6ProvisionStores || {};
    const storeKey = state.character.location === "r4_loc_ashspring" ? "ashspring"
      : state.character.location === "r4_loc_willow_market" ? "willow" : null;
    const store = storeKey ? stores[storeKey] : null;
    if (!store || !Number.isSafeInteger(count) || count < 1 || count > Number(store.stock || 0)) return { error: "ration_supply_unavailable" };
    const totalPaidWen = count * 50;
    if (Number(state.character.cashWen || 0) < totalPaidWen) return { error: "insufficient_resource" };
    store.stock -= count;
    state.character.cashWen -= totalPaidWen;
    state.character.inventory.r6_item_travel_ration = Number(state.character.inventory.r6_item_travel_ration || 0) + count;
    state.character.inventoryLedger.r6_item_travel_ration ||= [];
    state.character.inventoryLedger.r6_item_travel_ration.push({ quantity: count, acquiredDay: state.worldDay, ownership: "owned", sourceId: receiptId });
    const receipt = { id: receiptId, sourceId: store.id, providerId: store.providerId, buyerId: state.character.id, quantity: count, unitPriceWen: 50, totalPaidWen, day: state.worldDay, status: "committed" };
    state.world.r6ProvisionReceipts[receiptId] = receipt;
    appendCause("r6_action_buy_travel_ration.committed", "r6_action_buy_travel_ration", { receiptId, costWen: totalPaidWen, quantity: count, sourceId: store.id });
    return { kind: "receipt", receipt: clone(receipt), snapshot: snapshot() };
  }

  function buyR6PortableFurnace({ kind = "owned", transactionId } = {}) {
    const config = pack.r6PortableFurnace;
    const store = state.world.r6PortableFurnaceStore;
    const receiptId = typeof transactionId === "string" && transactionId ? transactionId : `${state.worldId}:portable-furnace:${state.operationSequence + 1}`;
    state.world.r6PortableFurnaceReceipts ||= {};
    if (state.world.r6PortableFurnaceReceipts[receiptId]) return { kind: "duplicate_suppressed", receipt: clone(state.world.r6PortableFurnaceReceipts[receiptId]) };
    if (!config || !store || !["owned", "lease"].includes(kind)) return { error: "portable_furnace_source_unavailable" };
    if (state.inFlightTransaction || state.pendingResult) return { error: "current_action_must_finish_first" };
    const seller = state.world.npcRecords?.[config.sellerId];
    if (state.character.location !== config.locationId || seller?.alive !== true || seller.locationId !== config.locationId || seller.onDuty !== true) return { error: "portable_furnace_seller_unavailable" };
    const alreadyOwned = Number(state.character.inventory?.[config.ownedItemId] || 0) > 0;
    const activeLease = (state.character.portableFurnaceLeases || []).some((lease) => lease.status === "active" && lease.expiresDay >= state.worldDay);
    if (kind === "owned" && (alreadyOwned || Number(store.ownedStock || 0) < 1)) return { error: alreadyOwned ? "portable_furnace_already_owned" : "portable_furnace_out_of_stock" };
    if (kind === "lease" && (activeLease || Number(store.leaseStock || 0) < 1)) return { error: activeLease ? "portable_furnace_lease_already_active" : "portable_furnace_lease_out_of_stock" };
    const priceWen = kind === "owned" ? config.ownedPriceWen : config.leasePriceWen;
    if (Number(state.character.cashWen || 0) < priceWen) return { error: "insufficient_resource" };
    const receipt = { id: receiptId, sourceId: kind === "owned" ? config.saleSourceId : config.rentalSourceId, sellerId: config.sellerId, buyerId: state.character.id, kind, itemId: kind === "owned" ? config.ownedItemId : config.leaseItemId, priceWen, day: state.worldDay, status: "committed" };
    state.operationSequence += 1;
    state.character.cashWen -= priceWen;
    if (kind === "owned") {
      store.ownedStock -= 1;
      state.character.inventory[config.ownedItemId] = Number(state.character.inventory?.[config.ownedItemId] || 0) + 1;
      state.character.inventoryLedger[config.ownedItemId] ||= [];
      state.character.inventoryLedger[config.ownedItemId].push({ quantity: 1, acquiredDay: state.worldDay, ownership: "owned", sourceId: receiptId, serialId: `${receiptId}:serial` });
    } else {
      store.leaseStock -= 1;
      state.character.portableFurnaceLeases ||= [];
      state.character.portableFurnaceLeases.push({ leaseId: `${receiptId}:lease`, sourceId: receiptId, ownerId: config.sellerId, borrowerId: state.character.id, issuedDay: state.worldDay, issuedAtTick: state.worldTick, expiresDay: state.worldDay + Number(config.leaseDurationDays), expiresAtTickExclusive: state.worldTick + Number(config.leaseDurationDays) * R6_TICKS_PER_DAY, status: "active" });
    }
    state.world.r6PortableFurnaceReceipts[receiptId] = receipt;
    appendCause(`r6_action_${kind === "owned" ? "buy" : "rent"}_portable_furnace.committed`, receipt.sourceId, { receiptId, priceWen, itemId: receipt.itemId, kind });
    return { kind: "receipt", receipt: clone(receipt), snapshot: snapshot() };
  }

  function beginTravelPortableAlchemy() {
    const config = pack.r6PortableFurnace;
    const trip = state.inFlightTransaction?.r6TravelTransaction;
    const site = state.world.r6Waystop;
    if (state.inFlightTransaction?.actionId !== "r4_action_travel" || state.inFlightTransaction.pauseReason !== "r6_waystop_decision" || trip?.waypointId !== config?.waystopId) return { error: "registered_waystop_pause_required" };
    if (!site || site.status !== "open" || site.safe !== true || site.portableAlchemyAllowed !== true) return { error: "registered_safe_waystop_unavailable" };
    const skillId = "r4_skill_dao02";
    const currentLifeSkill = state.character.learnedSkills.includes(skillId) && state.character.skillRecords?.[skillId]?.lifeIndex === Number(state.character.lifeIndex || 1);
    if (!currentLifeSkill || Number(state.character.skills?.[skillId]?.stage || 0) < pack.caps.dao02MinimumStage || Number(state.character.proficiency?.[skillId] || state.character.skillRecords?.[skillId]?.proficiency || 0) < pack.caps.dao02MinimumProficiency) return { error: "portable_alchemy_current_skill_insufficient" };
    if (Number(state.character.inventory?.r4_item_powder_recipe || 0) < 1) return { error: "portable_alchemy_recipe_required" };
    const ownsFurnace = Number(state.character.inventory?.[config.ownedItemId] || 0) > 0 && (state.character.inventoryLedger?.[config.ownedItemId] || []).some((lot) => lot.ownership === "owned" && Number(lot.quantity || 0) > 0);
    const lease = [...(state.character.portableFurnaceLeases || [])].reverse().find((row) => row.status === "active" && row.ownerId === config.sellerId && row.borrowerId === state.character.id);
    const fullTerm = Number(config.portableAlchemyDays);
    if (!ownsFurnace && !lease) return { error: "portable_furnace_ownership_or_lease_required" };
    const leaseExpiryTick = Number.isSafeInteger(lease?.expiresAtTickExclusive)
      ? lease.expiresAtTickExclusive : Number.isSafeInteger(lease?.expiresDay)
        ? (lease.expiresDay + 1) * R6_TICKS_PER_DAY : Number(lease?.issuedDay) * R6_TICKS_PER_DAY + Number(config.leaseDurationDays) * R6_TICKS_PER_DAY;
    if (!ownsFurnace && (!Number.isSafeInteger(leaseExpiryTick) || state.worldTick + fullTerm * R6_TICKS_PER_DAY > leaseExpiryTick)) return { error: "portable_furnace_lease_expires_before_completion", requiredThroughTick: state.worldTick + fullTerm * R6_TICKS_PER_DAY, leaseExpiresAtTickExclusive: leaseExpiryTick };
    const batch = pack.actions.r4_action_alchemy;
    const costs = { r4_item_stargrass: Number(config.portableAlchemyStargrass), wealth: Number(config.portableAlchemyFeeWen) };
    if (Number(state.character.inventory?.r4_item_stargrass || 0) < costs.r4_item_stargrass || !canAfford(costs)) return { error: "portable_alchemy_material_or_cash_insufficient" };
    const travel = state.inFlightTransaction;
    const remainingDays = Math.max(0, Number(travel.targetDay) - Number(state.worldDay));
    travel.r6TravelTransaction.waystopResumeDays = remainingDays;
    state.suspendedTransactions ||= [];
    state.suspendedTransactions.push(clone(travel));
    state.inFlightTransaction = null;
    const result = transaction(config.portableAlchemyActionId, fullTerm, costs, { type: "alchemy", successChance: Number(config.portableAlchemySuccessChance ?? batch.successChance), successItems: { r4_item_powder: Number(config.portableAlchemyPowderYield) }, furnaceSerialId: ownsFurnace ? state.character.inventoryLedger[config.ownedItemId].find((lot) => lot.ownership === "owned" && Number(lot.quantity) > 0)?.serialId : null, leaseId: ownsFurnace ? null : lease.leaseId });
    if (result?.error) state.inFlightTransaction = state.suspendedTransactions.pop() || travel;
    return result;
  }

  function social({ personId, targetId, service, quoteRequest, recordId, skillId, leaseId } = {}) {
    if (quoteRequest) return issueQuote(quoteRequest);
    if (service) {
      if (HIGH_REALM_SERVICE_TARGETS[service]) {
        const rejected = validateHighRealmProducer(service, targetId);
        if (rejected) return { error: rejected };
        return transaction("r4_action_social", pack.actions.r4_action_social.visitDays, {}, { type: "social_service", personId: targetId, service });
      }
      if (realmSourceAdapter === "r5" && service === "review_alchemy_and_request_contribution_consent") {
        const board = state.world.realmServiceBoards.research; const batch = state.world.craftBatchLedger.find((row) => row.id === recordId && row.actorId === state.character.id && row.lifeIndex === Number(state.character.lifeIndex || 1) && ["completed", "failed"].includes(row.status));
        const contributor = state.world.npcRecords[board?.contributorId];
        if (targetId !== board?.contributorId || !batch) return { error: "current_life_public_alchemy_record_required" };
        if (contributor?.alive !== true || contributor.locationId !== state.character.location || contributor.researchContributionPreference !== "wants_contribution_trace") return { error: "contributor_unavailable_or_no_attribution_preference" };
        return transaction("r4_action_social", pack.actions.r4_action_social.visitDays, {}, { type: "social_service", personId: targetId, service, recordId: batch.id });
      }
      if (realmSourceAdapter === "r5" && service === "request_furnace_rental") {
        const ownerId = "r4_npc_wen_repairer"; const owner = state.world.npcRecords[ownerId]; const selectedSkillId = skillId || state.character.learnedSkills?.find((skill) => ["r4_skill_dao01", "r4_skill_dao02"].includes(skill) && state.character.skillRecords?.[skill]?.lifeIndex === Number(state.character.lifeIndex || 1));
        const skill = state.character.skillRecords?.[selectedSkillId] || {}; const active = state.world.rentalLedger.find((row) => row.tenantId === state.character.id && row.locationId === state.character.location && row.status === "active" && row.dueDay >= state.worldDay);
        if (targetId !== ownerId || state.character.location !== "r4_loc_furnace_lane" || owner?.alive !== true || owner.locationId !== state.character.location || owner.onDuty !== true || !selectedSkillId || skill.lifeIndex !== Number(state.character.lifeIndex || 1) || skill.skillId !== selectedSkillId || state.world.equipment?.["public-kiln"]?.status === "out_of_service") return { error: "current_life_furnace_compatible_skill_or_operable_owner_missing" };
        if (active) return { error: "active_furnace_lease_already_exists" };
        return transaction("r4_action_social", 0, { wealth: 100 }, { type: "social_service", personId: ownerId, service, skillId: selectedSkillId });
      }
      if (realmSourceAdapter === "r5" && service === "request_furnace_lease_extension") {
        const ownerId = "r4_npc_wen_repairer"; const owner = state.world.npcRecords[ownerId]; const lease = state.world.rentalLedger.find((row) => row.leaseId === leaseId && row.tenantId === state.character.id);
        if (!lease || lease.status !== "active" || lease.dueDay > state.worldDay || lease.ownerId !== ownerId) return { error: "current_due_furnace_lease_required" };
        const remoteDelivery = state.character.location === "r4_loc_willow_market" && owner?.locationId === lease.locationId && state.character.knownLocations?.includes(owner.locationId) && state.world.services?.waykeeper?.active === true;
        const localResponse = owner?.locationId === state.character.location;
        if (targetId !== ownerId || owner?.alive !== true || !(localResponse || remoteDelivery) || owner.furnaceLeaseExtensionPolicy !== "grant_one_7_day_extension_if_due_and_operable" || state.world.equipment?.["public-kiln"]?.status === "out_of_service") return { error: "lease_owner_or_operable_furnace_unavailable" };
        if (lease.extensionOffer?.status === "preapproved") return { error: "extension_already_signed" };
        return transaction("r4_action_social", 0, {}, { type: "social_service", personId: ownerId, service, leaseId: lease.leaseId });
      }
      const neighbor = state.world.npcRecords.r4_npc_ash_neighbor;
      if (targetId !== neighbor.id || !neighbor.alive || neighbor.locationId !== state.character.location || state.character.location !== "r4_loc_ashspring") return { error: "household_member_unavailable" };
      if (service === "request_night_cover_offer" && (neighbor.nightCoverOfferPolicy !== "renew_one_night_cover_for_current_worker" || (!state.character.lastWorkDay && !state.character.birthRecord?.householdId))) return { error: "current_worker_or_neighbor_offer_policy_missing" };
      if (service === "request_roommate_offer" && (neighbor.sharedWatchOfferPolicy !== "offer_seven_day_shared_watch_with_player_acceptance" || state.world.realmServiceBoards.housing.ownerId !== neighbor.id)) return { error: "current_neighbor_offer_policy_missing" };
      if (!["request_night_cover_offer", "request_roommate_offer"].includes(service)) return { error: "unknown_social_service" };
      return transaction("r4_action_social", pack.actions.r4_action_social.visitDays, {}, { type: "social_service", personId: neighbor.id, service });
    }
    if (!personId) return { error: "person_required" };
    return transaction("r4_action_social", pack.actions.r4_action_social.visitDays, {}, { type: "social", personId });
  }

  function issueQuote({ marketId, itemId, quantity, side, sourceId = null, counterPercent = null }) {
    const market = pack.market.locations[marketId];
    const count = Math.floor(Number(quantity));
    if (!market || !pack.market.tradableUnitPrices[itemId] || !["buy", "sell"].includes(side) || count < 1 || count > pack.market.maxQuantityPerQuote) return { error: "invalid_quote_request" };
    if (state.character.location !== marketId) return { error: "market_location_required" };
    if (r6FreeSurvival && realmSourceAdapter === "r5") {
      const knowledge = state.character.knowledge?.market;
      if ((typeof knowledge === "string" ? knowledge : knowledge?.level) !== "heard") return { error: "market_knowledge_required" };
    }
    const base = pack.market.tradableUnitPrices[itemId];
    let unit = side === "buy" ? Math.ceil(base * (100 + pack.caps.marketBuyMarkupPercent) / 100) : Math.floor(base * pack.caps.marketSellPercent / 100);
    let demandBand = null;
    if (counterPercent != null) {
      const finance = state.world.markets?.[marketId];
      const stock = state.world.marketStock?.[marketId] || market.initialStock;
      const current = Number(stock?.[itemId] ?? 0);
      const opening = Number(market.initialStock?.[itemId] ?? 0);
      demandBand = current === 0 ? "scarce" : current < opening ? "low" : "normal";
      const ceiling = demandBand === "scarce" ? 60 : demandBand === "low" ? 55 : 50;
      const percent = Number(counterPercent);
      const key = `${state.character.id}:${marketId}:${itemId}:${side}:${state.worldDay}`;
      state.world.marketCounterLedger ||= {};
      if (state.world.marketCounterLedger[key]) return { kind: "counter_rejected", reason: "daily_attempt_used", demandBand };
      state.world.marketCounterLedger[key] = { characterId: state.character.id, marketId, itemId, side, day: state.worldDay, percent, demandBand };
      if (side !== "sell" || !Number.isInteger(percent) || percent < pack.caps.marketSellPercent || percent > ceiling) return { kind: "counter_rejected", reason: "offer_outside_demand_band", demandBand, ceilingPercent: ceiling };
      unit = Math.floor(base * percent / 100);
    }
    const inventoryLotSelections = side === "sell" ? inventoryLotPlan(itemId, count, { sourceId }) : null;
    if (side === "sell" && !inventoryLotSelections) return { error: "owned_inventory_lots_insufficient_or_inconsistent", itemId, count, inventory: Number(state.character.inventory?.[itemId] || 0), lots: clone(state.character.inventoryLedger?.[itemId] || []) };
    const quoteId = `${state.worldId}-quote-${state.operationSequence + 1}`;
    const totalWealth = unit * count;
    const marketFinance = r6FreeSurvival && realmSourceAdapter === "r5" ? state.world.markets?.[marketId] : null;
    if (side === "sell" && marketFinance) {
      releaseExpiredMarketQuoteReservations();
      const held = Object.values(marketFinance.buyerCreditReservations || {}).filter(row => row.status === "held").reduce((sum, row) => sum + Number(row.amount || 0), 0);
      if (marketFinance.buyerCreditWealth - held < totalWealth) return { error: "market_buyer_credit_insufficient", available: Math.max(0, marketFinance.buyerCreditWealth - held), requested: totalWealth };
    }
    state.operationSequence += 1;
    const quote = { id: quoteId, worldId: state.worldId, ownerId: state.character.id, marketId, itemId, quantity: count, side, ...(counterPercent == null ? {} : { demandBand, counterPercent }), ...(side === "sell" ? { inventoryLotSelections } : {}), unitPrice: unit, totalWealth, createdDay: state.worldDay, expiryDay: state.worldDay + pack.market.quoteLifetimeDays, receipt: null };
    state.quotes[quote.id] = quote; state.quotes.active = quote;
    if (side === "sell" && marketFinance) marketFinance.buyerCreditReservations[`quote:${quote.id}`] = { amount: totalWealth, status: "held", transactionId: null };
    return { kind: "quote", quote: clone(quote), snapshot: snapshot() };
  }

  function releaseQuoteReservation(quote) {
    const reservation = state.world.markets?.[quote?.marketId]?.buyerCreditReservations?.[`quote:${quote.id}`];
    if (reservation?.status === "held") reservation.status = "released";
    return reservation || null;
  }

  function releaseExpiredMarketQuoteReservations() {
    if (!state.world.markets) return;
    for (const market of Object.values(state.world.markets)) for (const [key, reservation] of Object.entries(market.buyerCreditReservations || {})) {
      if (reservation.status !== "held") continue;
      const quote = state.quotes?.[key.slice("quote:".length)];
      if (!quote || Number(quote.expiryDay) < Number(state.worldDay)) reservation.status = "released";
    }
  }

  function marketFinance(marketId) {
    const finance = state.world.markets?.[marketId];
    if (!finance) return null;
    const held = Object.values(finance.buyerCreditReservations || {}).filter(row => row.status === "held").reduce((sum, row) => sum + Number(row.amount || 0), 0);
    return { marketId, buyerCreditWealth: finance.buyerCreditWealth, initialCreditWealth: finance.initialCreditWealth, reservedWealth: held, availableWealth: Math.max(0, finance.buyerCreditWealth - held), ledgerVersion: finance.ledgerVersion };
  }

  function cancelQuote(quoteId) {
    const quote = state.quotes?.[quoteId];
    if (!quote) return { error: "quote_missing" };
    if (quote.receipt) return { error: "quote_already_committed" };
    if (quote.ownerId !== state.character.id || quote.worldId !== state.worldId) return { error: "quote_owner_mismatch" };
    releaseQuoteReservation(quote);
    quote.cancelledDay = state.worldDay;
    return { kind: "canceled", quoteId, finance: marketFinance(quote.marketId), snapshot: snapshot() };
  }

  function settleQuote(quoteId) {
    const quote = state.quotes[quoteId];
    if (!quote) return { error: "quote_missing" };
    if (quote.receipt) return { error: "duplicate_suppressed", receipt: clone(quote.receipt) };
    const rejectQuote = reason => { releaseQuoteReservation(quote); return { error: reason }; };
    if (quote.ownerId !== state.character.id || quote.worldId !== state.worldId) return rejectQuote("quote_owner_mismatch");
    if (state.worldDay > quote.expiryDay) return rejectQuote("window_closed");
    if (r6FreeSurvival && realmSourceAdapter === "r5" && (state.character.location !== quote.marketId
      || (typeof state.character.knowledge?.market === "string" ? state.character.knowledge.market : state.character.knowledge?.market?.level) !== "heard")) return rejectQuote("market_qualification_changed");
    const marketConfig = pack.market.locations[quote.marketId];
    if (!marketConfig) return rejectQuote("quote_market_missing");
    const stock = state.world.marketStock?.[quote.marketId] || marketConfig.initialStock;
    let sellPlan = null;
    if (quote.side === "buy") {
      if (state.character.cashWen < quote.totalWealth || stock[quote.itemId] < quote.quantity) return rejectQuote("insufficient_resource");
    } else {
      sellPlan = inventoryLotPlan(quote.itemId, quote.quantity, quote.inventoryLotSelections?.length === 1 ? { sourceId: quote.inventoryLotSelections[0].sourceId } : {});
      if (!sellPlan || JSON.stringify(sellPlan) !== JSON.stringify(quote.inventoryLotSelections)) return rejectQuote("quoted_inventory_lots_unavailable_or_changed");
      if (r6FreeSurvival && realmSourceAdapter === "r5") {
        const finance = state.world.markets?.[quote.marketId];
        const reservation = finance?.buyerCreditReservations?.[`quote:${quote.id}`];
        if (!finance || reservation?.status !== "held" || reservation.amount !== quote.totalWealth || finance.buyerCreditWealth < quote.totalWealth) return rejectQuote("market_buyer_credit_changed");
      }
    }
    const markets = state.world.marketStock ||= {};
    markets[quote.marketId] ||= clone(marketConfig.initialStock);
    const currentStock = markets[quote.marketId];
    if (quote.side === "buy") {
      state.character.cashWen -= quote.totalWealth;
      state.character.inventory[quote.itemId] = (state.character.inventory[quote.itemId] || 0) + quote.quantity;
      (state.character.inventoryLedger[quote.itemId] ||= []).push({ quantity: quote.quantity, acquiredDay: state.worldDay, ownership: "owned", sourceId: quote.id });
      currentStock[quote.itemId] -= quote.quantity;
      if (r6FreeSurvival && realmSourceAdapter === "r5") state.world.markets[quote.marketId].buyerCreditWealth += quote.totalWealth;
    } else {
      const consumedLots = consumeInventoryLots(quote.itemId, quote.quantity, sellPlan);
      if (!consumedLots) throw new Error("validated_inventory_lot_plan_changed_during_settlement");
      state.character.inventory[quote.itemId] -= quote.quantity;
      state.character.cashWen += quote.totalWealth;
      currentStock[quote.itemId] += quote.quantity;
      if (r6FreeSurvival && realmSourceAdapter === "r5") {
        const finance = state.world.markets[quote.marketId];
        finance.buyerCreditWealth -= quote.totalWealth;
        finance.buyerCreditReservations[`quote:${quote.id}`].status = "committed";
        finance.buyerCreditReservations[`quote:${quote.id}`].transactionId = quote.id;
        finance.lastCommittedQuoteId = quote.id;
        if (finance.buyerCreditWealth < 0) throw new Error("market_buyer_credit_negative_invariant");
      }
    }
    quote.receipt = { id: `${quote.id}-receipt`, quoteId, day: state.worldDay, side: quote.side, quantity: quote.quantity, totalWealth: quote.totalWealth, ...(quote.side === "sell" ? { inventoryLotSelections: clone(quote.inventoryLotSelections) } : {}) };
    state.receipts[quote.id] = clone(quote.receipt);
    if (realmSourceAdapter === "r5" && (quote.side === "sell" || r6FreeSurvival)) {
      const marketReceipt = { ...clone(quote.receipt), status: "committed", ownerCharacterId: quote.ownerId, itemId: quote.itemId, marketId: quote.marketId, causeId: quote.id };
      state.world.quoteReceipts ||= {}; state.world.quoteReceipts[quote.id] = marketReceipt;
      (state.world.marketTradeLedger ||= []).push({ id: quote.id, actorId: quote.ownerId, ownerCharacterId: quote.ownerId, itemId: quote.itemId, marketId: quote.marketId, quantity: quote.quantity, side: quote.side, day: state.worldDay, quoteId: quote.id, receiptId: marketReceipt.id, status: "committed" });
    }
    appendCause("market_settlement", "r4_daily_market", quote.receipt);
    return { kind: "receipt", receipt: clone(quote.receipt), finance: marketFinance(quote.marketId), snapshot: snapshot() };
  }

  function contest() { return { error: "contest_requires_open_instance" }; }

  function recover({ medicated = false } = {}) {
    const config = pack.actions.r4_action_recover;
    const days = config.days + (medicated ? config.medicated.extraDays : 0);
    const poorRecovery = !medicated && Number(state.character.cashWen || 0) <= 0;
    const cost = poorRecovery ? {} : { wealth: config.wealth };
    if (medicated) cost.r4_item_powder = config.medicated.powder;
    return transaction("r4_action_recover", days, cost, { type: "recover", medicated: Boolean(medicated), poorRecovery, healthGain: config.healthGain, poorHealthGain: config.poorHealthGain, medicatedHealthGain: config.medicated.healthGain });
  }

  function startR6StrandedReturn() {
    const character = state.character;
    const lifeIndex = Number(character.lifeIndex || 1);
    const lifeKey = String(lifeIndex);
    const permit = character.permits?.furnace || character.furnacePermit;
    const permitExpired = Boolean(permit && permit.location === "r4_loc_furnace_lane"
      && (permit.status !== "valid" || Number(state.worldDay) > Number(permit.issuedDay) + Number(permit.validDays)));
    if (!character.alive) return { error: "life_not_active" };
    if (character.r6StrandedReturnByLife?.[lifeKey]) return { error: "stranded_return_already_used_this_life" };
    if (character.location !== "r4_loc_furnace_lane") return { error: "stranded_return_wrong_location" };
    if (Number(character.cashWen || 0) !== 0) return { error: "stranded_return_requires_zero_wealth" };
    if (!permitExpired) return { error: "stranded_return_requires_expired_permit" };
    if (!character.knownLocations?.includes("r4_loc_ashspring")) return { error: "stranded_return_destination_unknown" };
    if (state.inFlightTransaction) return { error: "transaction_in_flight" };
    if (state.pendingResult) return { error: "pending_result_must_be_acknowledged" };
    const result = transaction("r6_stranded_return", 7, {}, { type: "r6_stranded_return", lifeIndex, fromLocationId: "r4_loc_furnace_lane", toLocationId: "r4_loc_ashspring" });
    if (result?.kind === "progress") {
      (character.r6StrandedReturnByLife ||= {})[lifeKey] = {
        transactionId: result.transaction.transactionId, actionId: "r6_stranded_return", fromLocationId: "r4_loc_furnace_lane",
        toLocationId: "r4_loc_ashspring", startedDay: state.worldDay, completedDay: result.transaction.targetDay, status: "in_flight"
      };
    }
    return result;
  }

  function save() { return clone(state); }
  function snapshot({ includeHistory = true } = {}) {
    initializeR6CourierWorld();
    return {
      mode: "r4", namespace: state.namespace, contentVersion: state.contentVersion, worldId: state.worldId,
      worldDay: state.worldDay, date: worldDate(state.worldDay, pack.calendar), character: clone(state.character),
      world: clone(state.world), availableEvents: availableEvents(), queue: clone(state.queue),
      inFlightTransaction: clone(state.inFlightTransaction), suspendedTransactions: clone(state.suspendedTransactions || []), ...(includeHistory ? { causeLog: clone(state.causeLog), generations: clone(state.generations) } : {}),
      activeCrisisInstances: clone(state.world.crisisInstances.filter((item) => !item.closed)), lastResult: clone(state.lastResult), pendingResult: clone(state.pendingResult)
    };
  }

  function getPendingResult() { return clone(state.pendingResult); }
  function acknowledgeResult() { state.pendingResult = null; return snapshot(); }

  function abortInFlight() {
    const tx = state.inFlightTransaction;
    if (!tx) return { error: "no_transaction" };
    const event = eventById.get(tx.eventId);
    const option = event?.options.find((item) => item.id === tx.optionId);
    if (event && option) return abortTransaction(option, event);
    if (tx.actionId === "r6_stranded_return") {
      const receipt = state.character.r6StrandedReturnByLife?.[String(tx.completion?.lifeIndex)];
      if (receipt?.transactionId === tx.transactionId) { receipt.status = "terminated"; receipt.completedDay = state.worldDay; }
    }
    tx.status = "aborted";
    tx.abortedDay = state.worldDay;
    state.character.actionLog.push({ actionId: tx.actionId, transactionId: tx.transactionId, worldDay: state.worldDay, durationDays: state.worldDay - tx.startedDay, outcome: "aborted", completedSegments: tx.completedSegments });
    appendCause(`${tx.actionId}.aborted`, tx.actionId, { transactionId: tx.transactionId, completedSegments: tx.completedSegments, noReward: true });
    state.inFlightTransaction = null;
    restoreSuspendedTransaction();
    const result = { kind: "result", outcome: "aborted", actionId: tx.actionId, completedSegments: tx.completedSegments, resultText: "行动已中断，未领取完成奖励；已预扣的投入不返还。" };
    state.pendingResult = clone(result);
    state.actionTransactionLedger[tx.transactionId] = { status: "aborted", actionId: tx.actionId, completedDay: state.worldDay, result: clone(result) };
    state.lastResult = clone(result);
    result.snapshot = snapshot();
    return result;
  }

  function advanceTransaction(days = 1) {
    const tx = state.inFlightTransaction;
    if (!tx) return { error: "no_transaction" };
    const remainingTicks = Math.max(0, Number(tx.targetAtTick ?? (tx.targetDay * R6_TICKS_PER_DAY)) - state.worldTick);
    const requestedTicks = Math.max(1, Math.floor(days)) * R6_TICKS_PER_DAY;
    let result = advanceWorldTicks(Math.min(requestedTicks, remainingTicks));
    if (tx.r6TravelTransaction) {
      tx.r6TravelTransaction.daysCompleted = Math.max(0, state.worldDay - tx.startedDay);
      tx.r6TravelTransaction.daysRemaining = Math.max(0, tx.targetDay - state.worldDay);
      tx.r6TravelTransaction.lastProcessedWorldDay = state.worldDay;
      tx.r6TravelTransaction.pauseEventId = tx.pauseEventId || null;
    }
    tx.completedSegments = Math.min(tx.totalSegments, Math.floor((state.worldDay - tx.startedDay) / 30));
    if (!state.character.alive) {
      if (tx.kind === "action") {
        if (tx.r6TravelTransaction) { tx.r6TravelTransaction.status = "interrupted_by_death"; tx.r6TravelTransaction.daysCompleted = Math.max(0, state.worldDay - tx.startedDay); tx.r6TravelTransaction.daysRemaining = Math.max(0, tx.targetDay - state.worldDay); }
        if (tx.actionId === "r6_stranded_return") {
          const receipt = state.character.r6StrandedReturnByLife?.[String(tx.completion?.lifeIndex)];
          if (receipt?.transactionId === tx.transactionId) { receipt.status = "interrupted"; receipt.completedDay = state.worldDay; }
        }
        return settleR4RealmPracticeChoice({ ...interruptActionByDeath(), transactionId: tx.transactionId });
      }
      tx.status = "interrupted_by_death";
      state.eventClaimLedger[tx.claimKey] = { state: "interrupted_by_death", transactionId: tx.transactionId };
      state.inFlightTransaction = null;
      state.suspendedTransactions = [];
      const interrupted = { kind: "interrupted", outcome: "interrupted", eventId: tx.eventId, optionId: tx.optionId, ...result };
      state.pendingResult = clone(interrupted);
      state.lastResult = clone(interrupted);
      interrupted.snapshot = snapshot();
      return interrupted;
    }
    if (!result.stoppedAtWorldNode && state.worldTick >= Number(tx.targetAtTick ?? (tx.targetDay * R6_TICKS_PER_DAY))) {
      const hardDue = findHardDueEvent();
      if (hardDue) {
        tx.pauseReason = "world_node_due";
        tx.pauseEventId = hardDue.eventId;
        result = { ...result, stoppedAtWorldNode: "world_event_due" };
      }
    }
    if (tx.r6TravelTransaction) {
      tx.r6TravelTransaction.daysCompleted = Math.max(0, state.worldDay - tx.startedDay);
      tx.r6TravelTransaction.daysRemaining = Math.max(0, tx.targetDay - state.worldDay);
      tx.r6TravelTransaction.lastProcessedWorldDay = state.worldDay;
      tx.r6TravelTransaction.pauseEventId = tx.pauseEventId || null;
    }
    if (state.worldTick < Number(tx.targetAtTick ?? (tx.targetDay * R6_TICKS_PER_DAY)) || result.stoppedAtWorldNode) return { kind: "progress", transaction: clone(tx), snapshot: snapshot(), ...result };
    if (tx.kind === "action") return settleR4RealmPracticeChoice({ ...finishActionTransaction(), transactionId: tx.transactionId });
    const event = eventById.get(tx.eventId);
    const option = event?.options.find((item) => item.id === tx.optionId);
    if (event && option) return finishTransaction("success", option, event, result);
    return { kind: "progress", transaction: clone(tx), snapshot: snapshot() };
  }

  function resumeInFlight() {
    const tx = state.inFlightTransaction;
    if (!tx) return { error: "no_transaction" };
    return { kind: "progress", transaction: clone(tx), snapshot: snapshot() };
  }

  function newGeneration(originId) {
    if (state.character.alive) return { error: "character_still_alive" };
    const profile = seedConfig.originProfiles.find((item) => item.originId === originId);
    if (!profile) return { error: "invalid_origin" };
    const previous = state.character;
    const generation = previous.generation + 1;
    const record = { generation: previous.generation, characterId: previous.id, origin: previous.origin, birthDay: previous.birthDay, deathDay: previous.deathDay, status: "dead", worldDaysLived: previous.deathDay - previous.birthDay, worldOutcomeSummary: clone(state.world.worldOutcomes), recordsVia: clone(previous.recordsVia || []) };
    state.generations[state.generations.length - 1] = record;
    const oldWorld = state.world;
    const originKind = originId.replace(/^r4_origin_/, "");
    state.character = { id: `${state.worldId}-character-${generation}`, generation, alive: true, birthDay: state.worldDay, deathDay: null, origin: originKind, location: profile.locationId, health: Number(profile.startingResources.health), power: Number(profile.startingResources.power), cashWen: Number(profile.startingResources.wealth), skills: {}, learnedSkills: [], inventoryLedger: {}, inventory: {}, permits: {}, relationships: {}, knowledge: {}, facts: clone(profile.initialFacts || {}), actionLog: [], ageDays: 0, aliveDays: 0, proficiency: {}, studyProgress: {}, birthRecord: clone(profile.birthRecord || {}), recordsVia: [], sourceLedger: [] };
    state.world = oldWorld;
    state.worldId = state.worldId;
    state.queue = state.queue.filter((entry) => eventById.get(entry.eventId)?.instanceScope === "world_crisis_instance");
    state.operationSequence = 0;
    state.character.knownLocations = [...new Set([...(pack.runtimeSources.originInitialization?.[originKind]?.knownLocations || [profile.locationId]), ...pack.runtimeSources.worldInitialization.routes.filter((route) => route.from === profile.locationId && route.knownFromOrigin.includes(originKind)).map((route) => route.to)])];
    state.character.originLocation = profile.locationId;
    state.character.contacts = {};
    state.character.organizationAccess = {};
    state.character.crisisAllyCommitments = {};
    state.character.knowledge.originRecord = { level: "heard", sourceId: "family_record", acquiredDay: state.worldDay, characterId: state.character.id };
    for (const [key, level] of Object.entries(pack.runtimeSources.originInitialization?.[originKind]?.knowledge || {})) state.character.knowledge[key] = { level, sourceId: originId, acquiredDay: state.worldDay, characterId: state.character.id };
    if (pack.runtimeSources.originInitialization?.[originKind]?.basicHerbKnowledge) state.character.facts.r4_fact_basic_herb_knowledge = { value: true, sourceId: "world-init:herbal-childhood", day: 0 };
    const generationRecord = { generation, characterId: state.character.id, origin: originId, birthDay: state.worldDay, status: "alive" };
    state.generations.push(generationRecord);
    for (const entry of profile.initialKnowledge || []) state.character.knowledge[entry.key] = { level: entry.level, sourceId: entry.sourceId, acquiredDay: state.worldDay, characterId: state.character.id };
    const originSource = pack.runtimeSources.originInitialization?.[originKind];
    if (originSource?.openingScenario) {
      const exitLocation = pack.runtimeSources.worldInitialization.routes.find((route) => route.from === originSource.location && route.to.endsWith("willow_market"))?.to;
      const opening = { id: `${state.worldId}:opening:${state.character.id}`, family: "opening", status: "active", createdDay: state.worldDay, location: originSource.location, exitLocation, companionPersonId: originSource.companionPersonId || null, closed: false, danger: true };
      state.world.openingInstance = opening; state.world.crisisInstances.push(opening); state.world.openingDanger = true;
      state.world.originEncounterDay = state.worldDay; state.world.openingCloseDay = state.worldDay + 30; state.world.nearestSafeLocation = exitLocation;
      state.character.knowledge.safeExit = { level: "heard", sourceId: originSource.knownSafeRouteSource, acquiredDay: state.worldDay, characterId: state.character.id };
    }
    enqueue(profile.openingEventId, state.worldDay);
    appendCause("new_generation", "generation_record", { generation, originId });
    return { kind: "generation", snapshot: snapshot() };
  }

  function seedCrisis(family, seedEntry = null) {
    if (!Array.isArray(pack.crises[family]?.eventIds)) return { error: "unknown_crisis" };
    if (state.world.crisisInstances.filter((item) => !item.closed).length >= pack.caps.activeCrisisInstancesPerWorld) return { error: "crisis_cap_reached" };
    if (!seedEntry?.instanceId || !registry.has(seedEntry.instanceId)) return { error: "crisis_seed_instance_missing" };
    const id = seedEntry.instanceId;
    const instance = { id, family, createdDay: state.worldDay + Number(seedEntry.createdDayOffset || 0), status: seedEntry.status || "active", closed: false, countered: false, terminalDay: null, nodeClaims: {}, ...crisisInitialState(family) };
    state.world.crisisInstances.push(instance);
    const firstEvent = pack.crises[family].eventIds.map((eventId) => eventById.get(eventId)).find(Boolean);
    if (firstEvent) enqueue(firstEvent.id, instance.createdDay, id);
    appendCause("crisis_instance_created", id, { family });
    return { kind: "crisis", instance: clone(instance), snapshot: snapshot() };
  }

  function crisisInitialState(family) {
    const nodes = pack.crises[family]?.nodes || [];
    return { status: "active", stage: 0, countered: false, nodeClaims: {}, independentRecords: 1, createdDay: state.worldDay, deadlineDay: state.worldDay + Math.max(0, ...nodes.map((node) => Number(node.day) || 0)) };
  }

  function enterOffscreen(days) {
    if (state.character.alive) return { error: "character_must_be_absent" };
    const result = advanceDays(days);
    return { kind: "offscreen_advance", snapshot: snapshot(), ...result };
  }

  function materializeQueue() {
    const ready = state.queue.filter((entry) => entry.day <= state.worldDay).map((entry) => eventById.get(entry.eventId)).filter((event) => event && eventAvailable(event));
    ready.sort((a, b) => priority(a) - priority(b) || a.id.localeCompare(b.id));
    return ready.map((event) => eventView(event));
  }

  function validateHighRealmProducer(service, targetId) {
    if (realmSourceAdapter !== "r5" || HIGH_REALM_SERVICE_TARGETS[service] !== targetId) return "registered_high_realm_social_service_required";
    const person = state.world.npcRecords[targetId];
    if (person?.alive !== true || person.locationId !== state.character.location || state.character.location !== "r4_loc_willow_market") return "named_person_unavailable_or_wrong_location";
    const boards = state.world.highRealmBoards || {}; const day = state.worldDay; const cid = state.character.id;
    if (service === "request_voluntary_witness") {
      const sale = [...(state.world.marketTradeLedger || [])].reverse().find((row) => row.day <= day);
      const receipt = sale && state.world.quoteReceipts?.[sale.quoteId];
      if (person.realmWitnessPolicy !== "offer_only_after_recorded_market_transaction" || !receipt || receipt.status !== "committed") return "witnessed_public_transaction_missing";
    } else if (service === "request_archive_subject_consent") {
      if (person.archiveSubjectResponsePolicy !== "grant_current_page_after_direct_request" || !boards.archive?.sealedPages?.some((page) => page.subjectId === targetId && page.status === "sealed")) return "subject_page_or_current_response_missing";
    } else if (service === "invite_care_request") {
      if (person.careRequestPolicy !== "may_ask_for_help_with_current_work_choice" || person.currentCareRequest?.status === "open") return "person_has_no_new_current_request";
    } else if (service === "request_roadwork_permit") {
      const segment = boards.road?.segment;
      if (person.roadPermitPolicy !== "grant_one_segment_after_current_notice_request" || state.world.factions?.r4_faction_waykeepers?.guideService !== true || segment?.status !== "closed" || (segment.expiresDay != null && segment.expiresDay < day)) return "current_public_closure_or_waykeeper_authority_missing";
    } else if (service === "copy_public_map") {
      if (person.onDuty !== true || !boards.road?.publishedMaps?.some((map) => map.ownerId === "public" && map.version === 1)) return "public_old_map_or_archive_clerk_missing";
    } else if (service === "request_facility_custody") {
      const move = boards.facilityMove;
      if (person.custodyResponsePolicy !== "entrust_public_register_and_tools_only_after_request" || move?.status !== "scheduled" || move.custodianId !== targetId || move.departDay <= day) return "scheduled_public_move_or_custodian_authority_missing";
    } else if (service === "invite_public_lesson") {
      const venue = boards.lesson; const learner = state.world.npcRecords.r4_npc_lin_xiaohe;
      const usedSeats = (venue?.sessions || []).filter((row) => row.status === "accepted" && row.expiresDay >= state.worldDay).reduce((sum, row) => sum + (row.acceptedLearners || []).length, 0);
      if (person.openLessonPolicy !== "accept_if_venue_and_learners_are_present" || person.alive !== true || person.onDuty !== true || venue?.status !== "available" || venue.locationId !== state.character.location || usedSeats + 1 > Number(venue.capacity || 0) || venue.roster?.includes(learner?.id) || learner?.alive !== true || person.locationId !== state.character.location || learner.locationId !== state.character.location || learner.lessonResponsePolicy !== "accept_only_named_public_basics_session") return "public_teacher_learner_or_venue_not_available";
    } else if (service === "request_waykeeper_nomination") {
      const org = boards.organization; const contribution = [...(boards.road?.repairLedger || [])].reverse().find((row) => row.actorId === cid && row.status === "completed" && row.public === true);
      if (person.appointmentPolicy !== "invite_current_public_contributor_after_roster_review" || org?.status !== "active" || org.vacancy?.status !== "open" || org.process?.status !== "open" || !contribution) return "active_organization_lawful_vacancy_and_current_public_contribution_required";
    } else if (service === "request_method_attribution") {
      const method = [...(state.character.ownedPublicMethods || [])].reverse().find((row) => row.status === "draft" && row.ownerId === cid);
      if (!method || person.openLessonPolicy !== "accept_if_venue_and_learners_are_present" || !(person.taughtSkillIds || ["r4_skill_dao01"]).includes(method.sourceSkillId)) return "owned_method_and_relevant_living_coauthor_required";
    }
    return null;
  }

  function commitHighRealmProducer(service, targetId, transactionId) {
    const rejected = validateHighRealmProducer(service, targetId);
    if (rejected) return { error: rejected };
    const person = state.world.npcRecords[targetId]; const world = state.world; const day = state.worldDay; const cid = state.character.id;
    const boards = world.highRealmBoards; const id = `${transactionId}:high-realm-request`;
    let record;
    if (service === "request_voluntary_witness") {
      const sale = [...world.marketTradeLedger].reverse().find((row) => row.day <= day); const witness = { id: `${id}:witness-invitation`, status: "offered", invitedBy: targetId, actorId: cid, lifeIndex: Number(state.character.lifeIndex || 1), day, expiresDay: day + 7, scope: "firsthand_market_transaction", evidenceRef: sale.quoteId, causeId: transactionId };
      (person.witnessInvitations ||= []).push(clone(witness)); record = { id: witness.id, handler: "realm_soul_witness", status: "invited", actorId: cid, personId: targetId, lifeIndex: Number(state.character.lifeIndex || 1), day, locationId: state.character.location, evidenceRefs: [sale.quoteId], invitation: witness };
    } else if (service === "request_archive_subject_consent") {
      const page = boards.archive.sealedPages.find((row) => row.subjectId === targetId && row.status === "sealed");
      const consent = { id: `${page.id}:subject-consent:${transactionId}`, status: "signed", signerId: targetId, subjectId: targetId, pageId: page.id, scope: "read_subject_page_once", issuedDay: day, expiresDay: day, causeId: transactionId };
      page.authorization = { ...clone(consent), status: "valid" }; record = { id: consent.id, handler: "realm_soul_archive", status: "request", actorId: cid, personId: targetId, lifeIndex: Number(state.character.lifeIndex || 1), day, locationId: state.character.location, pageId: page.id, authorization: consent };
    } else if (service === "invite_care_request") {
      const request = { id: `care-request:${targetId}:${day}:${transactionId}`, status: "open", requestorId: targetId, day, expiresDay: day + 7, kind: "work_schedule_choice", alternatives: ["keep_current_shift", "exchange_for_family_errand", "decline_extra_work"], decisionOwnerId: targetId, sourceId: transactionId };
      person.currentCareRequest = clone(request); record = { id: request.id, handler: "realm_soul_care", status: "requested", actorId: cid, personId: targetId, lifeIndex: Number(state.character.lifeIndex || 1), day, locationId: state.character.location, request };
    } else if (service === "request_roadwork_permit") {
      const segment = boards.road.segment; const permit = { id: `roadwork-permit:${segment.id}:${cid}:${day}`, status: "valid", holderId: cid, issuedBy: targetId, segmentId: segment.id, issuedDay: day, expiresDay: day + 7, scope: "one_segment_public_repair", causeId: segment.causeId, responseId: transactionId };
      (segment.permits ||= []).push(clone(permit)); record = { id: permit.id, handler: "realm_void_route", status: "authorized", actorId: cid, personId: targetId, lifeIndex: Number(state.character.lifeIndex || 1), day, locationId: state.character.location, notice: clone(segment), permit };
    } else if (service === "copy_public_map") {
      const map = boards.road.publishedMaps.find((row) => row.ownerId === "public" && row.version === 1); const segment = boards.road.segment;
      state.character.publicMaps ||= {}; state.character.publicMaps[segment.id] = clone(map);
      const observation = { id: `route-observation:${cid}:${day}:${transactionId}`, actorId: cid, lifeIndex: Number(state.character.lifeIndex || 1), segmentId: segment.id, status: segment.status, causeId: segment.causeId, day, locationId: state.character.location, source: "observed_public_notice" };
      (world.travelObservations ||= []).push(observation); record = { id: `map-source:${map.id}:${transactionId}`, handler: "realm_void_map", status: "open", actorId: cid, personId: targetId, lifeIndex: Number(state.character.lifeIndex || 1), day, locationId: state.character.location, map: clone(map), observation };
    } else if (service === "request_facility_custody") {
      const move = boards.facilityMove; const receipt = { id: `${move.id}:custody:${cid}:${day}`, status: "entrusted", custodianId: cid, ownerId: "public", acceptedBy: targetId, issuedDay: day, expiresDay: move.departDay, cargoIds: move.cargo.filter((row) => row.ownerId === "public" && row.portable).map((row) => row.id), privateCargoExcluded: true, causeId: transactionId };
      move.status = "in_transit"; move.custodyReceipt = clone(receipt); move.entrustedDay = day; (move.custodyReceipts ||= []).push(clone(receipt)); record = { id: receipt.id, handler: "realm_void_relocation", status: "entrusted", actorId: cid, personId: targetId, lifeIndex: Number(state.character.lifeIndex || 1), day, locationId: state.character.location, move: clone(move) };
    } else if (service === "invite_public_lesson") {
      const venue = boards.lesson; const learner = state.world.npcRecords.r4_npc_lin_xiaohe; const lesson = { id: `${venue.id}:session:${day}:${transactionId}`, status: "accepted", teacherId: targetId, acceptedByTeacher: targetId, learners: [learner.id], acceptedLearners: [learner.id], venueId: venue.id, venueStatus: "available", postedDay: day, expiresDay: day + 7, consentReceipts: [`teacher-consent:${transactionId}`, `learner-consent:${transactionId}`], scope: "public_basics_only", causeId: transactionId };
      venue.roster.push(learner.id); venue.sessions.push(clone(lesson)); record = { id: lesson.id, handler: "realm_ascendant_openlesson", status: "accepted", actorId: cid, personId: targetId, lifeIndex: Number(state.character.lifeIndex || 1), day, locationId: state.character.location, lesson };
    } else if (service === "request_waykeeper_nomination") {
      const org = boards.organization; const contribution = [...boards.road.repairLedger].reverse().find((row) => row.actorId === cid && row.status === "completed" && row.public === true);
      const nomination = { id: `${org.id}:public-nomination:${cid}:${day}`, candidateId: cid, nominatedBy: "public_contribution_registry", contributionId: contribution.id, submittedDay: day, status: "submitted", public: true, causeId: transactionId };
      const review = { id: `${nomination.id}:credential-review`, candidateId: cid, reviewerId: targetId, contributionId: contribution.id, criteria: ["completed_public_contribution"], status: "qualified", reviewedDay: day, causeId: transactionId };
      const application = { id: `${org.id}:nomination:${cid}:${day}`, candidateId: cid, nominationId: nomination.id, reviewId: review.id, contributionId: contribution.id, submittedDay: day, reviewedDay: day, status: "reviewed", reviewedBy: targetId, processId: org.process.id };
      const invitation = { id: `${application.id}:invitation`, status: "issued", candidateId: cid, vacancyId: org.vacancy.id, processId: org.process.id, applicationId: application.id, nominationId: nomination.id, reviewId: review.id, issuedBy: targetId, issuedDay: day, expiresDay: day + 7, termDays: org.vacancy.termDays, scope: org.vacancy.scope, causeId: transactionId };
      org.nominationLedger.push(clone(nomination)); org.credentialReviews.push(clone(review));
      org.candidateRoster.push(application); org.invitations.push(clone(invitation)); record = { id: invitation.id, handler: "realm_ascendant_seat", status: "invited", actorId: cid, personId: targetId, lifeIndex: Number(state.character.lifeIndex || 1), day, locationId: state.character.location, application, invitation };
    } else {
      const method = [...(state.character.ownedPublicMethods || [])].reverse().find((row) => row.status === "draft" && row.ownerId === cid);
      const consent = { id: `${method.id}:attribution-consent:${transactionId}`, status: "signed", signerId: targetId, methodId: method.id, scope: "named_contribution_only", issuedDay: day, expiresDay: day + 30, causeId: transactionId };
      (person.methodAttributionConsents ||= []).push(clone(consent)); method.coauthors ||= []; method.coauthors.push({ personId: targetId, consentId: consent.id });
      record = { id: consent.id, handler: "realm_ascendant_seedarchive", status: "owned_draft", actorId: cid, personId: targetId, lifeIndex: Number(state.character.lifeIndex || 1), day, locationId: state.character.location, method: clone(method), attributionConsent: consent };
    }
    record.progressionCauseId = currentRealmProgressionProof()?.causeId;
    (world.realmActionLedgers.highRealmRequests ||= []).push(clone(record));
    appendCause("high_realm_npc_response", service, { targetId, receiptId: record.id, transactionId });
    return { status: "committed", record: clone(record) };
  }

  function priority(event) {
    const p = pack.transaction.sameDayPriority;
    const kind = event.type === "crisis" ? "hard_world_node" : event.type === "aftermath" ? "causal_followup" : event.type === "daily" ? "optional_event" : "causal_followup";
    return p.indexOf(kind) < 0 ? p.length : p.indexOf(kind);
  }

    return {
    pack, definitions, snapshot, save, getStateForAdapter: () => state, start, beginEvent, choose, availableEvents, availableActionOffers, materializeQueue,
    performAction, advanceDays, advanceWorldTicks, advanceTransaction, abortInFlight, resumeInFlight, resumeTravelFromWaystop, beginTravelPractice, buyR6PortableFurnace, beginTravelPortableAlchemy, deliverR6CourierContract, returnR6CourierPackage, waitAtR6FloodClosure, resumeR6FloodRoute, newGeneration, seedCrisis, enterOffscreen,
    bindRealmPracticeTransaction, bindRealmCraftTransaction,
    reserveRealmEventChoice, releaseRealmEventChoice,
    issueQuote, settleQuote, cancelQuote, marketFinance, openDailyBusinessSource, acceptDailyBoardAuthority, prepareRealmEventSource, openRealmEventSource, readPublicArchiveCatalog, getPendingResult, acknowledgeResult,
    debug: {
      testPredicate, resolvePath, eventAvailable, routeWeather: r6RouteWeather, eventView: (eventId) => eventView(eventById.get(eventId)),
      validateRealmChoice: (eventId, optionId) => {
        const event = eventById.get(eventId); const option = event?.options?.find((row) => row.id === optionId);
        if (!event || !option || event.runtimeBinding?.kind !== "realm_source") return { error: "unknown_realm_choice" };
        if (!eventAvailable(event)) return { error: "event_unavailable" };
        if (!withEventContext(event, () => testPredicate(option.requires))) return { error: "requirements_not_met" };
        const sourceError = validateRealmEventSource(event); if (sourceError) return { error: sourceError };
        return validateRealmEventChoice(event, option);
      }
    }
  };
}
