import { createR5Runtime } from "../engine/r5-runtime.js?v=r6-world-life-candidate-34";
import { R5LocalSaveStore } from "./r5-storage.js";
import { resolveCandidateQaSlot } from "./qa-slot.js?v=r6-world-life-candidate-18";
import { knownAdjacentTravelRoutes } from "./r6-travel-routes.js?v=r6-world-life-candidate-37";
import { actionCompletionLabelDate } from "../engine/r6-time-labels.js?v=r6-world-life-candidate-37";
import { migrateR6MoneyDto } from "./r6-money-migration.js?v=r6-world-life-candidate-2";
import { assetUrlFromManifest } from "./asset-paths.js?v=r6-world-life-candidate-2";
import { presentationMatchesRuntimeResult, reconcileRuntimeResult, runtimeResultReceiptKey } from "./r6-result-receipts.js?v=r6-world-life-candidate-25";
import { commitRuntimeResultAcknowledgement } from "./r6-result-ack-transaction.js?v=r6-world-life-candidate-25";
import { findActionDuration, formatWorldTime, migrateR6WorldTimeDto } from "../engine/r6-world-time.js?v=r6-world-life-candidate-30";

const app = document.querySelector("#r6-app");
const storageScope = resolveCandidateQaSlot({ hostname: location.hostname, search: location.search, saveNamespace: "r6-world-life-candidate-v5" });
const storage = new R5LocalSaveStore({ databaseName: storageScope.databaseName });
const SAVE_SCHEMA = "R6-WORLD-LIFE-CANDIDATE-2";
const VERSION = "今世";
const SCENE_ART_VERSION = "r6-world-life-candidate-2";
const DIMENSION_LABELS = Object.freeze([
  ["naturalTalent", "资质"],
  ["aptitude", "悟性"],
  ["bloodline", "血脉"],
  ["fortune", "气运"]
]);
const SKILL_LABELS = Object.freeze({
  r4_skill_breath: "养息篇",
  r4_skill_dao01: "五行镇岳诀",
  r4_skill_dao02: "星芒九转丹术",
  r4_skill_array: "护炉阵解",
  r4_skill_seal: "镇岳印",
  r4_skill_stealth: "敛息术"
});
const SKILL_DISCIPLINE_LABELS = Object.freeze({ cultivation: "修行法门", craft: "修习技艺", martial: "武艺" });
const scriptUrl = new URL(import.meta.url);
const isPublishedMirror = /\/r6-demo(?:-candidate-3[67])?\/app\/r6-main\.js$/.test(scriptUrl.pathname);
const publishedRoot = new URL("../", scriptUrl);
const sourceProjectRoot = new URL("../../", scriptUrl);
const [pack, definitions, seedConfig, contract, timeContract] = await Promise.all([
  readJson("content/r5-world-pack-v1.json"),
  readJson("content/r5-event-definitions-v1.json"),
  readJson("content/r5-start-scenario-v1.json"),
  readJson("design/r6-mobile-interaction-contract-v1.json"),
  readJson("design/r6-world-life-contract-v1.json")
]);
const assetManifestUrl = isPublishedMirror
  ? new URL("ui/assets/asset-manifest.json", publishedRoot)
  : new URL("../../ui/assets/asset-manifest.json", scriptUrl);
const loadedAssets = await fetch(assetManifestUrl).then(async (response) => response.ok
  ? { manifest: await response.json(), manifestUrl: response.url || assetManifestUrl.href }
  : null).catch(() => null);
const herbAsset = loadedAssets?.manifest?.assets?.find((asset) => asset.asset_id === "icon_herb_bundle_512x512");
const herbImageUrl = herbAsset?.file ? assetUrlFromManifest(loadedAssets.manifestUrl, herbAsset.file) : null;
const slotId = storageScope.slotId;
const legacySlotId = storageScope.legacySlotId;
const aliases = Object.fromEntries(contract.locationDisplayAliases.map((row) => [row.locationId, row.productionDisplayAlias]));
const eventDefinitions = new Map(definitions.events.map((event) => [event.id, event]));
let engine = null;
let envelope = null;
let savedAt = null;
let busy = false;
let errorText = "";
let errorAction = null;
let qaLastActionError = null;
let qaLastResumeSync = null;
const qaActionDiagnostics = new URLSearchParams(location.search).get("qaDiag") === "1"
  && ["localhost", "127.0.0.1"].includes(location.hostname);
let shell = null;
let sceneImageAttempt = 0;
let buttonIdCounts = new Map();

function displayCalendarDate(worldDay) {
  const day = Math.max(0, Math.floor(Number(worldDay) || 0));
  const daysPerMonth = Number(pack.calendar.daysPerMonth);
  const monthsPerYear = Number(pack.calendar.monthsPerYear);
  const daysPerYear = daysPerMonth * monthsPerYear;
  const absoluteDay = Number(pack.calendar.epochYear) * daysPerYear + day - Number(pack.calendar.epochDay || 0);
  const year = Math.floor(absoluteDay / daysPerYear);
  const month = Math.floor((absoluteDay % daysPerYear) / daysPerMonth) + 1;
  const date = absoluteDay % daysPerMonth + 1;
  return `第${year}年${month}月${date}日`;
}

function completionDate(worldTick, durationTicks) {
  return actionCompletionLabelDate(pack.calendar, Number(worldTick), durationTicks);
}
function displayWorldTime(worldTick) { return formatWorldTime(worldTick, pack.calendar); }

function formatWenFromLegacy(wenAmount) {
  const wen = Math.max(0, Math.round(Number(wenAmount)));
  const liang = Math.floor(wen / 1000);
  const qian = Math.floor((wen % 1000) / 100);
  const remainder = wen % 100;
  return [liang ? `${liang}两` : "", qian ? `${qian}钱` : "", remainder || (!liang && !qian) ? `${remainder}文` : ""].filter(Boolean).join("");
}

function readJson(path) {
  const root = !isPublishedMirror && path.startsWith("design/") ? sourceProjectRoot : publishedRoot;
  return fetch(new URL(path, root)).then((response) => {
    if (!response.ok) throw new Error(`规则资源读取失败：${path} (${response.status})`);
    return response.json();
  });
}
function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== "") node.textContent = String(text);
  return node;
}
function makeButton(label, action, className = "r6-button") {
  const node = element("button", className, label);
  node.type = "button";
  const key = String(label).normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "action";
  const count = (buttonIdCounts.get(key) || 0) + 1;
  buttonIdCounts.set(key, count);
  node.id = `r6-action-${key}-${count}`;
  node.addEventListener("click", action);
  return node;
}
function captureViewContext(event) {
  const presentation = currentPresentation();
  if (!presentation) return;
  const target = event.target instanceof Element ? event.target.closest("button,summary,[tabindex],input,select,textarea") : null;
  const anchor = target?.closest("[data-node]") || shell?.activity;
  if (!anchor) return;
  if (!anchor.id) anchor.id = anchor.dataset.node || "r6-scene-hotspot";
  if (target && !target.id) target.id = `r6-focus-${target.textContent.trim().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "control"}`;
  const rect = anchor.getBoundingClientRect();
  presentation.viewportAnchorId = anchor.id;
  presentation.viewportOffsetTop = rect.top;
  presentation.focusId = target?.id || null;
  presentation.scrollAnchor = anchor.id;
  syncReturnTarget();
}
function restoreViewContext() {
  const presentation = currentPresentation();
  if (!presentation) return;
  requestAnimationFrame(() => {
    const anchor = document.getElementById(presentation.viewportAnchorId || presentation.scrollAnchor);
    const restoreAnchor = () => {
      if (!anchor || presentation.viewportOffsetTop == null || !Number.isFinite(Number(presentation.viewportOffsetTop))) return;
      const delta = anchor.getBoundingClientRect().top - Number(presentation.viewportOffsetTop);
      if (delta > 0) {
        const maxScrollTop = document.documentElement.scrollHeight - window.innerHeight;
        const missingScrollRange = window.scrollY + delta - maxScrollTop;
        if (missingScrollRange > 0) {
          const currentSpacer = Number.parseFloat(shell.page.style.getPropertyValue("--r6-scroll-spacer")) || 0;
          shell.page.style.setProperty("--r6-scroll-spacer", `${currentSpacer + missingScrollRange}px`);
        }
      }
      if (Math.abs(delta) > 0.5) window.scrollBy(0, delta);
    };
    if (anchor && presentation.viewportOffsetTop != null && Number.isFinite(Number(presentation.viewportOffsetTop))) {
      restoreAnchor();
    } else if (anchor) anchor.scrollIntoView({ block: "nearest" });
    const focus = presentation.focusId && document.getElementById(presentation.focusId);
    if (focus && !focus.disabled && !focus.closest("[hidden]")) focus.focus({ preventScroll: true });
    restoreAnchor();
  });
}
function renderError() {
  shell.error.replaceChildren();
  if (errorText) shell.error.append(element("span", "", errorText));
  if (errorAction) shell.error.append(makeButton(errorAction.label, errorAction.run, "r6-button"));
  shell.error.hidden = !errorText && !errorAction;
}
function safeError(error, fallback = "这一步暂未办妥，原有记录仍在。请查看眼下可作的选择。") {
  const code = typeof error === "string" ? error : error?.message;
  if (code === "r6_save_conflict") return "另一处页面已保存新进展；本页没有覆盖，请刷新后继续。";
  if (code === "insufficient_resource") return "手头物资不够，这次没有办成；光阴与物资没有变化。";
  if (code === "event_unavailable" || code === "requirements_not_met") return "眼下情形有变，这次没有办成；请重新看看可作的选择。";
  if (code === "learned_powder_recipe_required") return "尚未取得本世丹术与星芒止血散方，暂不能开炉。";
  if (code === "dao02_proficiency_insufficient") return "丹术阶位或熟练还未达到此炉方要求。";
  if (code === "furnace_permit_invalid_here") return "药炉使用许可已过期或不适用于此处，暂不能开炉。";
  if (code === "result_receipt_mismatch") return "这段经历与待确认回执不一致，没有替你确认；请刷新后恢复正确记录。";
  if (code === "current_furnace_lease_or_permission_required") return "眼下没有有效的药炉使用许可；可查看炉巷的借炉与租炉安排。";
  if (code === "market_buyer_credit_insufficient" || code === "market_buyer_credit_changed") return "摊主这笔货款周转不开；物品与钱袋没有变化。";
  if (code === "market_knowledge_required" || code === "market_qualification_changed") return "还未在此处听闻市况，或眼下的交易条件已变化。";
  if (code === "portable_furnace_source_unavailable") return "行炉商铺暂不可用；钱袋与库存没有变化。";
  if (code === "portable_furnace_seller_unavailable") return "炉主此刻不在柜前；钱袋与库存没有变化。";
  if (code === "portable_furnace_already_owned") return "你已自置行炉；钱袋与库存没有变化。";
  if (code === "portable_furnace_out_of_stock" || code === "portable_furnace_lease_out_of_stock") return "这类行炉暂时售罄；钱袋与库存没有变化。";
  if (code === "portable_furnace_lease_already_active") return "你已有未到期的行炉租约；钱袋与库存没有变化。";
  if (code === "current_action_must_finish_first") return "先完成当前正在进行的事情，再办理行炉交易。";
  if (code === "indexeddb_unavailable" || code === "indexeddb_transaction_aborted" || code === "indexeddb_request_failed") return "存档暂时没有写好；这局仍留在本页，请稍后重试保存。";
  return fallback;
}
function renderRecoverableError(message, label, run) {
  errorText = message;
  errorAction = label && run ? { label, run } : null;
  render();
}
function setSceneImageState(state, message) {
  if (!shell) return;
  shell.scene.dataset.imageState = state;
  shell.sceneImage.dataset.state = state;
  shell.sceneImageStatus.hidden = state === "loaded";
  shell.sceneImageStatus.setAttribute("role", state === "failed" ? "alert" : "status");
  shell.sceneImageStatus.replaceChildren(element("span", "", message));
  if (state === "failed") {
    shell.sceneImageStatus.append(makeButton("重试载入院落画面", loadSceneImage, "r6-button primary"));
  }
}
function loadSceneImage() {
  if (!shell) return;
  const attempt = ++sceneImageAttempt;
  setSceneImageState("loading", "院落画面载入中…");
  const root = isPublishedMirror ? publishedRoot : sourceProjectRoot;
  const imageUrl = new URL("ui/assets/bg_ashspring_herb_yard_1200x900.png", root);
  imageUrl.searchParams.set("v", SCENE_ART_VERSION);
  if (attempt > 1) imageUrl.searchParams.set("retry", String(attempt - 1));
  const image = shell.sceneImage;
  image.onload = () => {
    if (attempt !== sceneImageAttempt) return;
    if (image.naturalWidth > 0 && image.naturalHeight > 0) setSceneImageState("loaded", "院落画面已载入");
    else setSceneImageState("failed", "画面暂未显出，可再试一次。 ");
  };
  image.onerror = () => {
    if (attempt === sceneImageAttempt) setSceneImageState("failed", "画面暂未显出，可再试一次。");
  };
  image.src = imageUrl.href;
}
function runtimeState() { return engine?.save() || null; }
function snapshot() { return engine?.snapshot() || null; }
function currentPresentation() { return envelope?.presentation || null; }
function reconcilePendingRuntimeResult() {
  const state = runtimeState();
  const presentation = currentPresentation();
  if (!state?.pendingResult || !presentation) return false;
  const reconciliation = reconcileRuntimeResult(presentation.pendingResult, state);
  if (reconciliation.action === "clear_acknowledged") {
    engine.acknowledgeResult();
    syncReturnTarget();
    return true;
  }
  if (reconciliation.action === "recover_unread") {
    presentation.pendingResult = reconciliation.presentation;
    presentation.selectedChoiceId = state.pendingResult.optionId || null;
    presentation.dialogueRef = { eventId: reconciliation.presentation.eventId, instanceId: reconciliation.presentation.instanceId, lineId: "runtime-result", speakerId: null, sourceRefs: [] };
    syncReturnTarget();
    return true;
  }
  if (reconciliation.action === "conflict") errorText = "存档里有两段不同的待确认经历；没有替你确认任何一段，请刷新后恢复记录。";
  return false;
}
function eventInstanceId(eventId) {
  const state = runtimeState();
  return `${state.worldId}:${state.character.lifeIndex}:${eventId}`;
}
function referenceFor(eventId, lineId) {
  const event = engine.eventView(eventId);
  return {
    eventId,
    instanceId: eventInstanceId(eventId),
    lineId,
    speakerId: null,
    sourceRefs: [...(event?.sourceRefs || [])]
  };
}
function clone(value) { return value == null ? value : structuredClone(value); }
function attributeValue(value) {
  if (value === null || value === undefined || value === "") return "尚无记录";
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : "尚无记录";
}
function skillName(row) {
  return SKILL_LABELS[row.skillId] || SKILL_DISCIPLINE_LABELS[row.discipline] || "已习得道业";
}
function milliValue(value) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return "尚无记录";
  return (Number(value) / 1000).toFixed(1);
}
function knownLifespan(state) {
  const rows = state.facts?.r5_fact_fate_gate;
  const gate = Array.isArray(rows) ? [...rows].reverse().find((row) => row.lifeIndex === state.character.lifeIndex
    && row.gateId === "accept_fate_limit" && row.status === "verified" && row.choiceId === "finite_lifespan") : null;
  const fact = gate?.evidence?.currentFact;
  const sourceId = typeof fact?.sourceId === "string" ? fact.sourceId : "";
  const deathDay = Number(fact?.deathDay);
  const currentDeathDay = Number(state.character.deathDay);
  const day = Number(state.worldDay);
  const daysPerYear = Number(pack.r5ProgressionRules?.daysPerYear);
  if (!gate || !sourceId || !Number.isSafeInteger(deathDay) || !Number.isSafeInteger(day)
    || !Number.isFinite(daysPerYear) || daysPerYear <= 0) {
    return { text: "尚不知此身寿数。", sourceId: "", reliability: "unavailable" };
  }
  if (!Number.isSafeInteger(currentDeathDay) || deathDay !== currentDeathDay) {
    return { text: "曾有寿限线索，但如今境界有变，尚未重新确认。", sourceId, reliability: "stale" };
  }
  const remainingYears = Math.floor(Math.max(0, deathDay - day) / daysPerYear);
  return { text: remainingYears > 0 ? `已核实寿限余量：至少 ${remainingYears} 年。` : "已核实寿限余量：不足一年。", sourceId, reliability: "verified" };
}
function makeReturnTarget(presentation) {
  return {
    sceneLocationId: presentation.sceneLocationId,
    sceneInstanceId: presentation.sceneInstanceId,
    dialogueRef: clone(presentation.dialogueRef),
    dialogueCursor: presentation.dialogueCursor,
    selectedChoiceId: presentation.selectedChoiceId,
    scrollAnchor: presentation.scrollAnchor,
    viewportAnchorId: presentation.viewportAnchorId || null,
    viewportOffsetTop: presentation.viewportOffsetTop != null && Number.isFinite(Number(presentation.viewportOffsetTop)) ? Number(presentation.viewportOffsetTop) : null,
    focusId: presentation.focusId || null,
    pendingResult: clone(presentation.pendingResult)
  };
}
function syncReturnTarget() {
  const presentation = currentPresentation();
  if (presentation) presentation.returnTarget = makeReturnTarget(presentation);
}
async function persistEnvelope() {
  if (!engine || !envelope) return;
  const presentation = currentPresentation();
  const action = presentation?.pendingAction;
  const flight = runtimeState()?.inFlightTransaction;
  if (["r4_action_recover", "r6_stranded_return"].includes(action?.actionId) && flight?.actionId === action.actionId
    && (!action.transactionId || action.transactionId === flight.transactionId)) {
    action.transactionId = flight.transactionId;
    action.optionId = action.actionId === "r6_stranded_return" ? "R6-STRANDED-RETURN-ONCE"
      : flight.completion?.medicated ? "R6-REST-10D-MEDICATED" : "R6-REST-7D-PLAIN";
    action.durationDays = flight.durationDays;
    action.daysDone = Math.max(0, Number(runtimeState().worldDay) - Number(flight.startedDay));
    action.interruptionRef = flight.pauseEventId || action.interruptionRef || null;
  }
  envelope.r5Save = engine.toSaveDto();
  syncReturnTarget();
  const saved = await storage.saveEnvelope(slotId, envelope, { expectedSavedAt: savedAt });
  savedAt = saved.savedAt;
  shell.status.textContent = "存档：已保存";
}
function createRuntime() {
  const now = storageScope.qaSeed == null ? undefined : () => storageScope.qaSeed;
  return createR5Runtime({ pack, definitions, seedConfig, now, r6FreeSurvival: true, r6TimeContract: timeContract });
}
function buildFreshEnvelope() {
  const state = runtimeState();
  const presentation = {
    sceneLocationId: state.character.location,
    sceneInstanceId: `${state.worldId}:${state.character.lifeIndex}:${state.character.location}`,
    dialogueRef: referenceFor("r4_birth_story", "choices"),
    eventInstanceRef: null,
    dialogueCursor: 0,
    selectedChoiceId: null,
    scrollAnchor: "r6-scene-event",
    returnTarget: null,
    overlayStack: [],
    pendingAction: null,
    pendingResult: null,
    introRead: false,
    viewportAnchorId: "r6-scene-event",
    viewportOffsetTop: null,
    focusId: null
  };
  const result = {
    schemaVersion: SAVE_SCHEMA,
    r5Save: engine.toSaveDto(),
    presentation
  };
  presentation.returnTarget = makeReturnTarget(presentation);
  return result;
}
function ensureShell() {
  if (shell) return;
  const page = element("div", "r6-page");
  const brand = element("header", "r6-brand");
  brand.append(element("strong", "", "青墟界 · 人生因果"), element("span", "r6-version", VERSION));
  const status = element("div", "r6-status");
  status.dataset.node = "r6_status_summary";
  const statusAge = element("span");
  statusAge.dataset.node = "r6_status_age";
  const statusStage = element("span");
  statusStage.dataset.node = "r6_status_realm";
  const statusHealth = element("span");
  statusHealth.dataset.node = "r6_status_health";
  const statusPower = element("span");
  statusPower.dataset.node = "r6_status_power";
  const statusWealth = element("span");
  statusWealth.dataset.node = "r6_status_wealth";
  const saveStatus = element("span", "r6-save-status", "存档：尚未保存");
  status.append(statusAge, statusStage, statusHealth, statusPower, statusWealth, saveStatus);
  const location = element("h1", "r6-location");
  location.id = "r6-location-label";
  const scene = element("section", "r6-scene-frame");
  scene.dataset.node = "r6_living_scene";
  scene.dataset.location = "r4_loc_ashspring";
  const sceneImage = element("img", "r6-scene-image");
  sceneImage.dataset.node = "r6_scene_image";
  sceneImage.alt = "灰泉镇药户院落与药棚";
  sceneImage.decoding = "async";
  sceneImage.loading = "eager";
  const sceneImageStatus = element("div", "r6-scene-image-status", "院落画面载入中…");
  sceneImageStatus.dataset.node = "r6_scene_image_status";
  sceneImageStatus.setAttribute("role", "status");
  sceneImageStatus.setAttribute("aria-live", "polite");
  scene.append(sceneImage, sceneImageStatus);
  scene.setAttribute("aria-label", "灰泉镇药户院落场景");
  const event = element("section", "r6-section");
  event.id = "r6-scene-event";
  event.dataset.node = "r6_scene_event";
  const result = element("section", "r6-section");
  result.id = "r6-scene-result";
  result.dataset.node = "r6_scene_result";
  const activity = element("section", "r6-section");
  activity.id = "r6-scene-hotspot";
  activity.dataset.node = "r6_scene_hotspot";
  const tools = element("nav", "r6-tools");
  tools.setAttribute("aria-label", "只读查看");
  const overlays = element("div");
  overlays.id = "r6-overlays";
  const error = element("div", "r6-error");
  error.setAttribute("role", "alert");
  const inventory = element("section", "r6-section r6-inventory");
  inventory.dataset.node = "r6_inventory";
  tools.id = "r6_character_tools";
  tools.dataset.node = "r6_character_tools";
  page.append(brand, status, tools, location, scene, event, result, activity, inventory, error, overlays);
  app.replaceChildren(page);
  document.addEventListener("click", captureViewContext, true);
  shell = { page, status: saveStatus, statusAge, statusStage, statusHealth, statusPower, statusWealth, location, scene, sceneImage, sceneImageStatus, event, result, activity, inventory, tools, overlays, error };
  loadSceneImage();
}
function locationName(locationId) {
  const localNames = { r4_loc_furnace_lane: "炉巷", r4_loc_mirror_stage: "照影台", r4_loc_echo_pass: "回声关" };
  return aliases[locationId] || localNames[locationId] || "路上";
}
function travelDestinationNote(destinationId, state) {
  if (destinationId === "r4_loc_willow_market") {
    const marketKnowledge = state.character.knowledge?.market;
    const heardMarket = (typeof marketKnowledge === "string" ? marketKnowledge : marketKnowledge?.level) === "heard";
    return heardMarket
      ? "柳溪集可查看当日行情；买卖仍看手边货物、钱袋与摊上条件。"
      : "柳溪集可查看当日行情；未听闻市况前，暂不能报价买卖。";
  }
  if (destinationId === "r4_loc_furnace_lane") return "炉巷有公用药炉；申请七日使用时段，须本世习得丹术或炼器、炉主当值、炉具可用，并备 1钱。";
  if (destinationId === "r4_loc_ashspring") return "回灰泉镇，可再看帮工、采药与休整是否有可行之处。";
  if (destinationId === "r4_loc_mirror_stage") return "照影台可查看当地市集与修习线索；能否行事仍看手中线索和眼前条件。";
  if (destinationId === "r4_loc_echo_pass") return "回声关可留意相关来事；是否出现，仍看时日与眼前条件。";
  return `行至${locationName(destinationId)}，再看眼下是否有可办之事。`;
}
function showLanding(saved = null, legacy = null) {
  ensureShell();
  shell.location.textContent = "一处药户院落";
  shell.event.replaceChildren(element("h2", "", "一段新人生"));
  shell.event.append(element("p", "r6-copy", "从灰泉镇的药户人家开始，往后的日子会随着你的选择慢慢展开。"));
  shell.result.replaceChildren();
  shell.activity.replaceChildren(element("div", "r6-empty", "这一局的经历会留在此处，不会改动其他人生的记录。"));
  shell.tools.replaceChildren();
  if (legacy) {
    shell.event.append(makeButton("复制存档到本候选版（原档保留）", () => migrateLegacySave(legacy), "r6-button primary"));
    shell.event.append(element("p", "r6-copy", "旧版存档会换算钱袋与账目；同版候选存档按原账复制。原记录不会被覆盖或删除。"));
  } else if (saved) {
    shell.event.append(makeButton("继续这段人生", () => resumeSaved(), "r6-button primary"));
    shell.event.append(makeButton("另开一段新人生", () => startNewGame(true), "r6-button"));
  } else shell.event.append(makeButton("开始药户新局", () => startNewGame(false), "r6-button primary"));
  const importLabel = element("label", "r6-button", "从存档文件导入副本");
  const importInput = element("input");
  importInput.type = "file";
  importInput.className = "r6-file-input";
  importInput.accept = "application/json,.json";
  importInput.setAttribute("aria-label", "选择存档 JSON 文件");
  importInput.addEventListener("change", async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      const oldEnvelope = imported.schemaVersion === "R6-MOBILE-SAVE-1" ? imported : imported.envelope;
      const dto = oldEnvelope?.r5Save;
      const currentCandidateSave = dto?.namespace === "r6-world-life-candidate-v2"
        && Number.isSafeInteger(dto.runtimeState?.character?.cashWen) && dto.runtimeState.character.wealth == null;
      const supportedSource = dto?.namespace === "r5-qingxu-v1" || currentCandidateSave;
      if (oldEnvelope?.schemaVersion !== "R6-MOBILE-SAVE-1" || !supportedSource) throw new Error("存档文件格式或版本不匹配");
      showLanding(null, { envelope: oldEnvelope, savedAt: null });
    } catch (error) {
      errorText = safeError(error, "没有读入旧档文件；原存档和候选存档都未改动。");
      render();
    }
  });
  importLabel.append(importInput);
  shell.event.append(importLabel);
  renderError();
}
async function migrateLegacySave(legacy) {
  if (busy || !legacy?.envelope?.r5Save) return;
  busy = true;
  try {
    const sourceDto = legacy.envelope.r5Save;
    const candidateDtoIsCurrent = sourceDto.namespace === "r6-world-life-candidate-v2"
      && Number.isSafeInteger(sourceDto.runtimeState?.character?.cashWen) && sourceDto.runtimeState.character.wealth == null;
    const { dto } = candidateDtoIsCurrent ? { dto: clone(sourceDto) } : migrateR6MoneyDto(sourceDto);
    const state = dto.runtimeState;
    const adjacent = pack.runtimeSources.worldInitialization.routes.filter((route) => route.from === state.character.location);
    state.character.knownLocations = [...new Set([...(state.character.knownLocations || []), ...adjacent.map((route) => route.to)])];
    envelope = { schemaVersion: SAVE_SCHEMA, r5Save: dto, presentation: clone(legacy.envelope.presentation) };
    engine = createRuntime();
    engine.restoreDto(dto);
    savedAt = null;
    errorText = candidateDtoIsCurrent ? "同版存档已复制到候选版；原记录保留未改。" : "旧档已复制到候选版；原记录保留未改。";
    errorAction = null;
    await persistEnvelope();
    render();
    if (currentPresentation().pendingAction) await resumePendingAction();
  } catch (error) {
    errorText = safeError(error, "旧档暂未迁移；原记录保持不变。请先保留此页面，不要另开新局。");
    errorAction = null;
    showLanding(null, legacy);
  } finally { busy = false; }
}
async function startNewGame(confirmOverwrite) {
  if (busy) return;
  const existing = await storage.loadEnvelope(slotId);
  const expected = existing?.savedAt ?? null;
  if (existing && !confirmOverwrite) return showLanding(existing);
  if (existing && !window.confirm("只会替换这段试玩记录，其他人生存档不会改变。要继续吗？")) return;
  busy = true;
  try {
    engine = createRuntime();
    engine.initialize("herbal", `r6-player-${crypto.randomUUID()}`, storageScope.worldId || `r6-world-${crypto.randomUUID()}`);
    envelope = buildFreshEnvelope();
    savedAt = expected;
    errorText = "";
    errorAction = null;
    render();
    await persistEnvelope();
    render();
  } catch (error) { errorText = safeError(error, "新局暂未保存；原有记录没有删除，请重试。 "); errorAction = { label: "重试开始", run: () => startNewGame(false) }; showLanding(); }
  finally { busy = false; }
}
async function resumeSaved() {
  if (busy) return;
  busy = true;
  try {
    const stored = await storage.loadEnvelope(slotId);
    if (!stored) throw new Error("R6 样稿存档不存在");
    envelope = stored.envelope;
    savedAt = stored.savedAt;
    engine = createRuntime();
    engine.restoreDto(envelope.r5Save);
    qaLastResumeSync = reconcilePendingRuntimeResult() ? { result: "reconciled" } : null;
    if (qaLastResumeSync) await persistEnvelope();
    errorText = "";
    errorAction = null;
    render();
    if (currentPresentation().pendingAction) await resumePendingAction();
  } catch (error) { errorText = safeError(error, "这段人生暂未接上；原存档仍保留，请重新读取。 "); errorAction = { label: "重新读取", run: () => resumeSaved() }; showLanding(); }
  finally { busy = false; }
}
function availableOptions(eventId) {
  if (!engine?.isEventAvailable(eventId)) return [];
  return (engine.eventView(eventId)?.options || []).filter((option) => option.available).map((option) => {
    const missing = [];
    for (const [resource, amount] of Object.entries(option.costs || {})) {
      const state = runtimeState();
      const current = resource === "wealth" ? Number(state.character.cashWen || 0)
        : resource === "demandInstance.materials" ? Number(state.world.demandInstance?.materials ?? state.demandInstance?.materials ?? 0)
          : resource.startsWith("r4_item_") ? Number(state.character.inventory?.[resource] || 0) : 0;
      if (current < Number(amount)) {
        const name = resource === "r4_item_powder" ? "星芒止血散" : resource === "r4_item_stargrass" ? "星芒草" : resource === "wealth" ? "钱" : resource === "demandInstance.materials" ? "可交付物料" : "所需物资";
        missing.push(resource === "wealth" ? `还差 ${formatWenFromLegacy(Number(amount) - current)}` : `还缺 ${Number(amount) - current} 份${name}`);
      }
    }
    if (eventId === "r4_ev_realm_core_craft" && option.id === "finish_authorized_batch") {
      const state = runtimeState();
      const { permit, valid } = currentFurnacePermit(state);
      const dao02 = state.character.learnedSkills?.includes("r4_skill_dao02") === true
        && state.character.skillRecords?.r4_skill_dao02?.lifeIndex === state.character.lifeIndex;
      const stage = Number(state.character.skills?.r4_skill_dao02?.stage || 0);
      const proficiency = Number(state.character.proficiency?.r4_skill_dao02 || state.character.skillRecords?.r4_skill_dao02?.proficiency || 0);
      if (!dao02 || itemCount(state, "r4_item_powder_recipe") < 1) missing.push("尚未取得本世丹术或星芒止血散方");
      if (stage < Number(pack.caps.dao02MinimumStage || 1) || proficiency < Number(pack.caps.dao02MinimumProficiency || 20)) missing.push("丹术阶位或熟练尚未达到炉方要求");
      if (!permit) missing.push("尚未取得药炉使用许可");
      else if (!valid) missing.push("药炉使用许可已过期或不属于此处");
      if (state.character.location !== "r4_loc_furnace_lane") missing.push("须在炉巷持有效药炉使用许可");
      if (itemCount(state, "r4_item_stargrass") < 2) missing.push(`还缺 ${2 - itemCount(state, "r4_item_stargrass")} 份星芒草`);
      const fee = Number(pack.actions.r4_action_alchemy.reservedCost?.wealth || 0);
      if (Number(state.character.cashWen || 0) < fee) missing.push(`还差 ${formatWenFromLegacy(fee - Number(state.character.cashWen || 0))}`);
    }
    return { ...option, canAfford: missing.length === 0, affordabilityMessage: missing.join("；") };
  });
}
function setEventReference(eventId) {
  const presentation = currentPresentation();
  presentation.dialogueRef = referenceFor(eventId, "choices");
  presentation.eventInstanceRef = null;
  presentation.dialogueCursor = 0;
  presentation.selectedChoiceId = null;
  presentation.scrollAnchor = "r6-scene-event";
  syncReturnTarget();
}
function itemCount(state, itemId) { return Math.max(0, Number(state.character.inventory?.[itemId] || 0)); }
function currentFurnacePermit(state = runtimeState()) {
  const permit = state.character.permits?.furnace || state.character.furnacePermit || null;
  if (!permit) return { permit: null, valid: false, remaining: 0 };
  const expiryTick = Number.isSafeInteger(permit.expiresAtTickExclusive)
    ? permit.expiresAtTickExclusive : (Number(permit.issuedDay) + Number(permit.validDays) + 1) * 96;
  const remainingTicks = Math.max(0, expiryTick - Number(state.worldTick));
  const dayValid = permit.status === "valid" && Number.isSafeInteger(expiryTick) && Number(state.worldTick) < expiryTick;
  const valid = dayValid && permit.location === state.character.location;
  return { permit, valid, dayValid, remaining: Math.ceil(remainingTicks / 96), remainingTicks, expiryTick };
}
function alchemyReadiness(state = runtimeState()) {
  const { permit, valid, dayValid, remaining, remainingTicks } = currentFurnacePermit(state);
  const skillId = "r4_skill_dao02";
  const learned = state.character.learnedSkills?.includes(skillId) === true
    && state.character.skillRecords?.[skillId]?.lifeIndex === state.character.lifeIndex;
  const stage = Number(state.character.skills?.[skillId]?.stage || 0);
  const proficiency = Number(state.character.proficiency?.[skillId] || state.character.skillRecords?.[skillId]?.proficiency || 0);
  const costs = pack.actions.r4_action_alchemy.reservedCost || {};
  const brewTicks = Number(pack.actions.r4_action_alchemy.days || 0) * 96;
  const missing = [];
  if (!learned || itemCount(state, "r4_item_powder_recipe") < 1) missing.push("先在炉巷取得本世丹术与星芒止血散方");
  if (stage < Number(pack.caps.dao02MinimumStage) || proficiency < Number(pack.caps.dao02MinimumProficiency)) missing.push("丹术阶位或熟练尚未达标");
  if (!permit) missing.push("尚未取得药炉使用许可");
  else if (!dayValid) missing.push("药炉使用许可已过期");
  else if (remainingTicks < brewTicks) missing.push(`许可还剩 ${Math.floor(remainingTicks / 96)}日${remainingTicks % 96}刻，需覆盖完整 ${brewTicks / 96}日炼制；期限不足时不会开炉或扣费`);
  else if (!valid) missing.push("须在炉巷持有效药炉使用许可");
  if (state.character.location !== "r4_loc_furnace_lane") missing.push("须在炉巷开炉");
  for (const [itemId, amount] of Object.entries(costs)) {
    const current = itemId === "wealth" ? Number(state.character.cashWen || 0) : itemCount(state, itemId);
    if (current < Number(amount)) missing.push(itemId === "wealth" ? `还差 ${formatWenFromLegacy(Number(amount) - current)}` : `还缺 ${Number(amount) - current} 份${itemId === "r4_item_stargrass" ? "星芒草" : "所需物资"}`);
  }
  return { ready: missing.length === 0, missing, permit, permitValid: valid && remainingTicks >= brewTicks, learned, stage, proficiency, costs };
}
function renderInventoryCard() {
  const state = runtimeState();
  const known = state.character.learnedSkills?.includes("r4_skill_dao02") === true
    && state.character.skillRecords?.r4_skill_dao02?.lifeIndex === state.character.lifeIndex;
  const skill = state.character.skills?.r4_skill_dao02 || {};
  const proficiency = Number(state.character.proficiency?.r4_skill_dao02 || state.character.skillRecords?.r4_skill_dao02?.proficiency || 0);
  const { permit, valid, dayValid, remaining } = currentFurnacePermit(state);
  shell.inventory.replaceChildren(element("h2", "", "手边物件与制药进度"));
  const rows = [
    `星芒草：${itemCount(state, "r4_item_stargrass")} 份`,
    `星芒止血散：${itemCount(state, "r4_item_powder")} 份`,
    `星芒止血散方：${itemCount(state, "r4_item_powder_recipe")} 份`,
    `行路口粮：${itemCount(state, "r6_item_travel_ration")} 份`
  ];
  shell.inventory.append(element("p", "r6-copy", rows.join("\n")));
  shell.inventory.append(element("p", "r6-copy", `丹术：${known ? `已学 · ${skill.stage || 0} 阶 · 熟练 ${proficiency}` : "尚未习得"}`));
  const courseKnowledge = state.character.knowledge?.course?.level || state.character.knowledge?.course;
  const trust = state.facts?.r4_fact_local_trust === "trusted" || state.character.localTrust === "trusted";
  shell.inventory.append(element("p", "r6-copy", `课程线索：${courseKnowledge === "heard" ? "已听闻" : courseKnowledge || "尚未听闻"} · 本地信任：${trust ? "已建立" : "尚未建立"}`));
  if (permit) shell.inventory.append(element("p", "r6-copy", !dayValid
    ? `药炉使用许可：已过期（原许可至${displayCalendarDate(Number(permit.issuedDay) + Number(permit.validDays))}）`
    : valid
      ? `药炉使用许可：此处有效 · 还余 ${remaining} 日（至${displayCalendarDate(Number(permit.issuedDay) + Number(permit.validDays))}）`
      : `药炉使用许可：仅限炉巷使用 · 还余 ${remaining} 日（至${displayCalendarDate(Number(permit.issuedDay) + Number(permit.validDays))}）`));
  else shell.inventory.append(element("p", "r6-copy", "药炉使用许可：尚未取得；可查看眼下开放的课程或炉巷服务。"));
  const alchemy = alchemyReadiness(state);
  if (alchemy.ready) shell.inventory.append(element("p", "r6-next", "下一步：可在炉巷按正式药方开炉；成败由运行时的原有概率决定。"));
  else if (known && itemCount(state, "r4_item_powder") > 0 && state.character.location === "r4_loc_ashspring") shell.inventory.append(element("p", "r6-next", "下一步：可选送一份星芒止血散，帮采药人一把；这不是主线必做。"));
  else if (known && permit && dayValid && !valid) shell.inventory.append(element("p", "r6-next", "下一步：循已知道路回到炉巷，在许可期限内开炉。"));
  else if (known && !dayValid) shell.inventory.append(element("p", "r6-next", state.character.location === "r4_loc_furnace_lane"
    ? "下一步：许可已到期，可向炉主申请七日炉位；费用按正式条件核验。"
    : "下一步：循已知道路前往炉巷，问炉主申请七日炉位。"));
  else if (known && alchemy.missing.some((item) => item.includes("星芒草") || item.includes("钱"))) shell.inventory.append(element("p", "r6-next", `下一步：补齐${alchemy.missing.filter((item) => item.includes("星芒草") || item.includes("钱")).join("、")}后再开炉。`));
  else if (!known) shell.inventory.append(element("p", "r6-next", "下一步：留意可见的丹术课程来源；本地拜师还需满足运行时给出的信任条件。"));
}
function renderFurnaceAccessActions() {
  const state = runtimeState();
  const furnaceConfig = pack.r6PortableFurnace;
  const store = state.world.r6PortableFurnaceStore;
  if (furnaceConfig && store && state.character.location === furnaceConfig.locationId) {
    shell.activity.append(element("h3", "", "行炉器具"));
    shell.activity.append(element("p", "r6-copy", "自置一具行炉，或租用三十日；库存有限，费用从钱袋实扣。"));
    for (const [kind, stock, priceWen] of [["owned", store.ownedStock, furnaceConfig.ownedPriceWen], ["lease", store.leaseStock, furnaceConfig.leasePriceWen]]) {
      const label = kind === "owned" ? "买下行炉 · 5两" : "租用行炉三十日 · 1两";
      const button = makeButton(label, () => buyPortableFurnace(kind), "r6-button");
      button.disabled = Number(stock || 0) < 1 || Number(state.character.cashWen || 0) < Number(priceWen || 0);
      shell.activity.append(button);
    }
  }
  const skillId = ["r4_skill_dao02", "r4_skill_dao01"].find((id) => state.character.learnedSkills?.includes(id)
    && state.character.skillRecords?.[id]?.lifeIndex === state.character.lifeIndex);
  const owner = state.world.npcRecords?.r4_npc_wen_repairer;
  const usableKiln = state.world.equipment?.["public-kiln"]?.status !== "out_of_service";
  const activeLease = (state.world.rentalLedger || []).find((row) => row.tenantId === state.character.id && row.locationId === state.character.location && row.status === "active");
  const { valid: permitValid } = currentFurnacePermit(state);
  if (!skillId || !owner?.alive || owner.locationId !== state.character.location || owner.onDuty !== true || !usableKiln) return;
  if (!activeLease && !permitValid) {
    shell.activity.append(element("p", "r6-copy", "炉巷炉主在场，且你已有本世丹术/炼器功法；可按正式条件申请七日炉位，费用由运行时核验。"));
    const button = makeButton("向炉主申请七日炉位 · 1钱", () => beginTimedAction("r4_action_social", {
      personId: owner.id, targetId: owner.id, service: "request_furnace_rental", skillId
    }));
    button.disabled = Number(state.character.cashWen || 0) < 100;
    shell.activity.append(button);
  } else {
    if (!activeLease) return;
    shell.activity.append(element("p", "r6-copy", `炉位租约：${activeLease.status} · 到期${displayCalendarDate(activeLease.dueDay)}${activeLease.extensionOffer?.status === "preapproved" ? " · 炉主已签一次延期条件" : ""}`));
    if (activeLease.status === "active" && Number(activeLease.dueDay) <= Number(state.worldDay) && activeLease.extensionOffer?.status !== "preapproved") {
      shell.activity.append(makeButton("请炉主签署一次七日延期", () => beginTimedAction("r4_action_social", {
        personId: owner.id, targetId: owner.id, service: "request_furnace_lease_extension", leaseId: activeLease.leaseId
      })));
    }
  }
}
async function buyPortableFurnace(kind) {
  if (busy) return;
  busy = true;
  try {
    const result = engine.buyR6PortableFurnace(kind, crypto.randomUUID());
    if (result?.error) throw new Error(result.error);
    await persistEnvelope();
    render();
  } catch (error) { errorText = safeError(error, "行炉交易未完成，钱与库存没有变化。"); render(); }
  finally { busy = false; }
}
function pendingActionTitle(actionId, fallback) {
  const titles = { r4_action_travel: "行路途中", r4_action_recover: "休整恢复中", r4_action_alchemy: "炼制星芒止血散", r6_action_alchemy_portable: "途中以行炉炼药", r4_action_practice: "驿亭打坐修行中", r4_action_social: "炉巷服务办理中", r6_stranded_return: "返程途中" };
  return titles[actionId] || eventTitle(actionId, fallback || "眼前的事");
}
function renderMarketTrade(marketId, state) {
  const marketName = locationName(marketId);
  const finance = engine.getMarketFinance(marketId);
  if (!finance) return;
  const marketKnowledge = state.character.knowledge?.market;
  const heardMarket = (typeof marketKnowledge === "string" ? marketKnowledge : marketKnowledge?.level) === "heard";
  shell.activity.append(element("h3", "", "市集交易"));
  shell.activity.append(element("p", "r6-copy", `你手头有 ${formatWenFromLegacy(state.character.cashWen)}；摊位按货量给价，买家账目不向你公开。钱法：1两=10钱=1000文，报价与成交以文记账。`));
  if (!heardMarket) {
    shell.activity.append(element("p", "r6-option-note", "还未在此处听闻市况，暂不能开售或采购。"));
    return;
  }
  const presentation = currentPresentation();
  const quote = presentation.marketQuoteId ? state.quotes?.[presentation.marketQuoteId] : null;
  if (quote) {
    shell.activity.append(element("p", "r6-copy", `${quote.side === "sell" ? "出售" : "购入"}${quote.quantity} 份${quote.itemId === "r4_item_powder" ? "星芒止血散" : quote.itemId === "r4_item_stargrass" ? "星芒草" : quote.itemId === "r4_item_manual" ? "手册" : "阵材"}；${formatWenFromLegacy(quote.unitPrice)}/份，共 ${formatWenFromLegacy(quote.totalWealth)}。报价来自${marketName}，当日有效。`));
    if (!quote.receipt && Number(state.worldDay) > Number(quote.expiryDay)) {
      shell.activity.append(element("p", "r6-option-note", "这笔报价已过期，摊主预留的货款已释放；物品与钱袋都没有变化。"));
      const dismiss = makeButton("收起过期报价", async () => {
        presentation.marketQuoteId = null;
        await persistEnvelope();
        render();
      }, "r6-button primary");
      dismiss.id = "r6-market-expired-dismiss";
      shell.activity.append(dismiss);
    } else if (quote.receipt) {
      shell.activity.append(element("p", "r6-next", `已成交：实际${quote.side === "sell" ? "收入" : "支出"} ${formatWenFromLegacy(quote.receipt.totalWealth)}。`));
      const acknowledge = makeButton("知道了", async () => {
        presentation.marketQuoteId = null;
        presentation.marketTradeReceipt = null;
        await persistEnvelope();
        render();
      }, "r6-button primary");
      acknowledge.id = "r6-market-receipt-ack";
      shell.activity.append(acknowledge);
    } else {
      const confirm = makeButton("确认成交", () => settleMarketTrade(quote.id), "r6-button primary");
      confirm.id = "r6-market-confirm";
      const cancel = makeButton("取消这笔报价", () => cancelMarketTrade(quote.id), "r6-button");
      cancel.id = "r6-market-cancel";
      shell.activity.append(confirm, cancel);
    }
    return;
  }
  const tradableNames = { r4_item_powder: "星芒止血散", r4_item_stargrass: "星芒草", r4_item_manual: "手册", r4_item_array_material: "阵材" };
  const tradables = Object.keys(pack.market.tradableUnitPrices).filter(itemId => itemCount(state, itemId) > 0);
  if (!tradables.length) {
    shell.activity.append(element("p", "r6-copy", "眼下没有可出售的自有货物。"));
    return;
  }
  for (const itemId of tradables) {
    const row = element("div", "r6-market-row");
    const name = tradableNames[itemId] || "货物";
    row.append(element("p", "r6-copy", `${name}：持有 ${itemCount(state, itemId)} 份`));
    const quantity = element("select", "r6-market-quantity");
    quantity.id = `r6-market-quantity-${itemId}`;
    quantity.setAttribute("aria-label", `${name}出售数量`);
    const maximum = Math.min(itemCount(state, itemId), Number(pack.market.maxQuantityPerQuote));
    for (let count = 1; count <= maximum; count += 1) {
      const option = element("option", "", String(count));
      option.value = String(count);
      quantity.append(option);
    }
    const request = makeButton(`询${name}价`, () => requestMarketQuote(marketId, itemId, Number(quantity.value)), "r6-button");
    request.id = `r6-market-quote-${itemId}`;
    const counter = element("input", "r6-market-quantity");
    counter.type = "number";
    counter.min = String(pack.caps.marketSellPercent);
    counter.max = "60";
    counter.step = "1";
    counter.value = String(pack.caps.marketSellPercent);
    counter.id = `r6-market-counter-${itemId}`;
    counter.setAttribute("aria-label", `${name}议价百分比`);
    const negotiate = makeButton("试着议价", () => requestMarketQuote(marketId, itemId, Number(quantity.value), Number(counter.value)), "r6-button");
    negotiate.id = `r6-market-negotiate-${itemId}`;
    row.append(quantity, request, counter, negotiate);
    shell.activity.append(row);
  }
}
async function requestMarketQuote(marketId, itemId, quantity, counterPercent = null) {
  if (busy) return;
  busy = true;
  try {
    const result = engine.issueMarketQuote(marketId, itemId, quantity, "sell", counterPercent);
    if (result?.kind === "counter_rejected") {
      errorText = result.reason === "daily_attempt_used" ? "今日对此摊位这类货物已议过一次；明日可再试。" : `这次议价未获接受（${result.demandBand === "scarce" ? "紧俏" : result.demandBand === "low" ? "偏少" : "常见"}货况下最高 ${result.ceilingPercent}%）。未耗钱、未耗时，也未交出物品。`;
      render();
      return;
    }
    if (result?.error) throw new Error(result.error);
    currentPresentation().marketQuoteId = result.quote.id;
    currentPresentation().viewportAnchorId = "r6-scene-hotspot";
    currentPresentation().viewportOffsetTop = shell.activity.getBoundingClientRect().top;
    currentPresentation().focusId = "r6-market-confirm";
    errorText = "";
    await persistEnvelope();
    render();
  } catch (error) {
    errorText = safeError(error, "市集暂未给出这笔报价；货物与钱袋没有变化。");
    render();
  } finally { busy = false; }
}
async function settleMarketTrade(quoteId) {
  if (busy) return;
  busy = true;
  try {
    const result = engine.settleMarketQuote(quoteId);
    if (result?.error) throw new Error(result.error);
    currentPresentation().marketTradeReceipt = { quoteId, receipt: clone(result.receipt) };
    currentPresentation().viewportAnchorId = "r6-scene-hotspot";
    currentPresentation().viewportOffsetTop = shell.activity.getBoundingClientRect().top;
    currentPresentation().focusId = "r6-market-receipt-ack";
    errorText = "";
    await persistEnvelope();
    render();
  } catch (error) {
    errorText = safeError(error, "这笔交易没有成交；物品与钱袋没有变化。");
    await persistEnvelope();
    render();
  } finally { busy = false; }
}
async function cancelMarketTrade(quoteId) {
  if (busy) return;
  busy = true;
  try {
    const result = engine.cancelMarketQuote(quoteId);
    if (result?.error) throw new Error(result.error);
    currentPresentation().marketQuoteId = null;
    currentPresentation().viewportAnchorId = "r6-scene-hotspot";
    currentPresentation().viewportOffsetTop = shell.activity.getBoundingClientRect().top;
    currentPresentation().focusId = `r6-market-quote-${runtimeState().quotes?.[quoteId]?.itemId || "r4_item_powder"}`;
    await persistEnvelope();
    render();
  } catch (error) {
    errorText = safeError(error, "报价暂未取消；可以重新查看这笔交易。");
    render();
  } finally { busy = false; }
}
function renderTravelSupplies(state) {
  const key = state.character.location === "r4_loc_ashspring" ? "ashspring"
    : state.character.location === "r4_loc_willow_market" ? "willow" : null;
  const store = key ? state.world.r6ProvisionStores?.[key] : null;
  if (!store) return;
  shell.activity.append(element("h3", "", "路上口粮"));
  shell.activity.append(element("p", "r6-copy", `店家余粮 ${Number(store.stock || 0)} 份 · 50文/份。徒步每七日需一份；乘车含途中饭食。`));
  if (Number(store.stock || 0) < 1) {
    shell.activity.append(element("p", "r6-option-note", "本地口粮已售罄；没有供货凭据前不会自动补货。"));
    return;
  }
  const select = element("select", "r6-market-quantity");
  select.id = "r6-ration-quantity";
  select.setAttribute("aria-label", "购买口粮数量");
  for (let quantity = 1; quantity <= Math.min(20, Number(store.stock)); quantity += 1) {
    const option = element("option", "", String(quantity));
    option.value = String(quantity);
    select.append(option);
  }
  const row = element("div", "r6-market-row");
  row.append(element("p", "r6-copy", `当前携带 ${itemCount(state, "r6_item_travel_ration")} 份口粮`), select);
  const buy = makeButton("买1份口粮 · 50文", () => buyTravelRations(Number(select.value)), "r6-button");
  buy.id = "r6-buy-travel-ration";
  row.append(buy);
  select.addEventListener("change", () => {
    const count = Number(select.value);
    buy.textContent = `买${count}份口粮 · ${formatWenFromLegacy(count * 50)}`;
    buy.disabled = Number(state.character.cashWen || 0) < count * 50;
  });
  buy.disabled = Number(state.character.cashWen || 0) < 50;
  shell.activity.append(row);
}
async function buyTravelRations(quantity) {
  if (busy) return;
  busy = true;
  try {
    const result = engine.performWorldAction("r6_action_buy_travel_ration", { quantity, transactionId: `${slotId}:ration:${crypto.randomUUID()}` });
    if (result?.error) throw new Error(result.error);
    await persistEnvelope();
    render();
  } catch (error) {
    errorText = error?.message === "ration_supply_unavailable" ? "这里没有可售的口粮；物资与钱袋没有变化。"
      : error?.message === "insufficient_resource" ? "钱袋不足；这笔口粮没有买成。"
        : safeError(error, "口粮交易未完成；物资与钱袋没有变化。");
    render();
  } finally { busy = false; }
}
function renderSceneContent() {
  const s = snapshot();
  const state = runtimeState();
  const presentation = currentPresentation();
  const ageDays = state.character.ageDays;
  const ageLabel = Number.isSafeInteger(ageDays) && ageDays >= 0 ? `今世 ${Math.floor(ageDays / 360)} 岁` : "今世年龄待核";
  shell.statusAge.textContent = `${displayWorldTime(state.worldTick)} · ${ageLabel}`;
  shell.statusStage.textContent = s.r5.currentStage?.name || "未修凡俗";
  shell.statusHealth.textContent = `身况 ${s.character.health}`;
  shell.statusPower.textContent = `修为 ${s.character.power}`;
  shell.statusWealth.textContent = `钱袋 ${formatWenFromLegacy(s.character.cashWen)}`;
  shell.location.textContent = locationName(state.character.location);
  shell.scene.dataset.location = state.character.location;
  shell.scene.hidden = state.character.location !== "r4_loc_ashspring";
  shell.sceneImage.hidden = state.character.location !== "r4_loc_ashspring";
  shell.scene.setAttribute("aria-label", `${locationName(state.character.location)}场景`);
  shell.status.textContent = "存档：已保存";
  renderError();
  shell.result.replaceChildren();
  shell.event.replaceChildren();
  shell.activity.replaceChildren();
  shell.scene.querySelector(".hotspot")?.remove();
  const thisLifeButton = makeButton("人物·属性", () => openOverlay("this_life"));
  thisLifeButton.id = "r6-tool-this-life";
  const recordButton = makeButton("行录", () => openOverlay("life_record"));
  recordButton.id = "r6-tool-life-record";
  shell.tools.replaceChildren(thisLifeButton, recordButton);
  renderInventoryCard();
  if (qaActionDiagnostics && engine) {
    const state = runtimeState();
    const readiness = alchemyReadiness(state);
    shell.activity.append(element("pre", "r6-option-note", JSON.stringify({
      qaActionDiagnostics: true,
      busy,
      pendingAction: currentPresentation()?.pendingAction || null,
      pendingResult: currentPresentation()?.pendingResult || null,
      runtimePendingResult: state.pendingResult || null,
      lastActionError: qaLastActionError,
      lastResumeSync: qaLastResumeSync,
      alchemyReady: readiness.ready,
      alchemyMissing: readiness.missing,
      furnacePermitValidHere: readiness.permitValid,
      worldDay: state.worldDay,
      location: state.character.location,
      cashWen: state.character.cashWen,
      stargrass: itemCount(state, "r4_item_stargrass")
    }, null, 2)));
  }

  if (presentation.pendingAction) {
    const event = eventDefinitions.get(presentation.pendingAction.actionId);
    const action = presentation.pendingAction;
    shell.event.append(element("h2", "", pendingActionTitle(action.actionId, event?.presentation?.title)));
    if (action.actionId === "r6_timed_choice") {
      const timed = state.world.r6PendingTimedChoices?.find((row) => row.transactionId === action.transactionId);
      if (!timed || timed.status === "needs_reconciliation") {
        shell.event.append(element("p", "r6-copy", "这段旧事务的时辰记录需要核对；不会自动推进或重复结算。"));
        return;
      }
      if (timed.pauseEventId) {
        shell.event.append(element("p", "r6-copy", `事情进行到一半，在${displayWorldTime(state.worldTick)}遇到途中来事。先处理眼前事件，原选择会从此处接续。`));
        renderChoiceCard(timed.pauseEventId, eventDefinitions.get(timed.pauseEventId)?.presentation?.title || "途中来事", "处理完后再续原来的事情。", shell.event);
        return;
      }
      shell.event.append(element("p", "r6-copy", `所选事情预计于${displayWorldTime(timed.targetAtTick)}办妥；现在是${displayWorldTime(state.worldTick)}。途中遇事会在安全节点停下。`));
      shell.event.append(makeButton(`继续至${displayWorldTime(timed.targetAtTick)}`, () => continueTimedAction(), "r6-button primary"));
      return;
    } else if (action.actionId === "r4_action_travel") {
      const inFlight = state.inFlightTransaction;
      if (inFlight?.transactionId === action.transactionId && inFlight.pauseReason === "r6_waystop_decision") {
        const skillId = (state.character.learnedSkills || []).find((id) => state.character.skillRecords?.[id]?.lifeIndex === state.character.lifeIndex);
        shell.event.append(element("p", "r6-copy", "行至照影驿亭中点。这里是登记在册的安全歇脚处，可以停下修行，也可以不作停留继续赶路；打坐的日子会另行计算。"));
        if (skillId && Number(state.character.health || 0) > 1) shell.event.append(makeButton(`在驿亭打坐修行 · 至${completionDate(state.worldTick, findActionDuration(timeContract, { actionId: "r4_action_practice", context: { mode: "practice" } }))}`, () => beginMidtripPractice(skillId), "r6-button"));
        else shell.event.append(element("p", "r6-option-note", "需已习得一门功法且身况高于1，才能在此打坐。"));
        const furnace = state.world.r6PortableFurnaceStore;
        const furnaceConfig = pack.r6PortableFurnace;
        const owns = Number(state.character.inventory?.[furnaceConfig.ownedItemId] || 0) > 0;
        const leased = (state.character.portableFurnaceLeases || []).some((lease) => lease.borrowerId === state.character.id && lease.status === "active" && lease.expiresDay >= Number(state.worldDay) + 3);
        if (skillId && (owns || leased) && itemCount(state, "r4_item_stargrass") >= 2 && Number(state.character.cashWen) >= 100)
          shell.event.append(makeButton(`用行炉炼药 · 至${completionDate(state.worldTick, findActionDuration(timeContract, { actionId: "r6_action_alchemy_portable" }))}`, () => beginMidtripPortableAlchemy(), "r6-button"));
        else shell.event.append(element("p", "r6-option-note", "行炉炼药需本世丹术、有效行炉、两份星芒草及1钱；租期须覆盖三日炼制。"));
        shell.event.append(makeButton("不作停留，继续赶路", () => continueTravel(), "r6-button"));
        return;
      }
      if (inFlight?.transactionId === action.transactionId && ["r6_flood_wait", "r6_flood_resume"].includes(inFlight.pauseReason)) {
        const closure = state.world.r6FloodClosures?.["r4_loc_willow_market>r4_loc_mirror_stage"];
        const resumeDay = Number(closure?.endWorldDayExclusive);
        shell.event.append(element("p", "r6-copy", closure?.status === "active"
          ? `洪水封住了前路，封闭至 ${displayCalendarDate(resumeDay - 1)}；${displayCalendarDate(resumeDay)} 恢复通行。行程与已付车资/预留口粮都保留在原事务中。`
          : "路况复核已开放道路；可从暂停处零日接回原行程。"));
        if (closure?.status === "active") shell.event.append(makeButton("等候一日并复核路况", () => waitAtFloodClosure(), "r6-button"));
        else shell.event.append(makeButton("道路开放，继续原行程", () => continueTravel(), "r6-button"));
        return;
      }
      if (inFlight?.transactionId === action.transactionId && inFlight.pauseReason === "world_node_due" && inFlight.pauseEventId) {
        const pausedEventId = inFlight.pauseEventId;
        const copy = pausedEventId === "r4_ev_daily_courier"
          ? "行至照影驿亭，恰与柳汀药铺的登记车夫同日相遇。药包和200文已由药铺托管；接单或婉拒各耗四刻，遇见时不发报酬。"
          : pausedEventId === "r4_ev_daily_roadmarker"
            ? `连续强降雨已使这段道路封闭。停步查看后于${completionDate(state.worldTick, 96)}复核；洪水因果到期后可恢复原行程，不会重扣车资或口粮。`
            : "途中遇到一桩急事，先作眼前选择；原行程会从暂停处接续。";
        shell.event.append(element("p", "r6-copy", copy));
        renderChoiceCard(pausedEventId, engine.eventView(pausedEventId)?.title || "途中来事", "处理完眼前这桩，再继续原来的路。", shell.event);
        return;
      }
      const remaining = Math.max(0, Number(inFlight?.targetDay || 0) - Number(state.worldDay || 0));
      shell.event.append(element("p", "r6-copy", remaining ? `预计于${displayCalendarDate(inFlight.targetDay)}抵达。遇到符合条件的路上事件时，会在安全节点停下；你仍在${locationName(presentation.sceneLocationId)}。` : "路途已尽，正准备落脚。"));
      shell.event.append(makeButton(remaining ? `继续整段行程 · 预计${displayCalendarDate(inFlight.targetDay)}抵达` : "确认抵达", () => continueTravel(), "r6-button primary"));
    } else if (["r4_action_recover", "r4_action_alchemy", "r6_action_alchemy_portable", "r4_action_practice", "r6_stranded_return"].includes(action.actionId)) {
      const flight = state.inFlightTransaction;
      if (!flight) {
        const checkingAlchemy = action.actionId === "r4_action_alchemy" || action.actionId === "r6_action_alchemy_portable";
        shell.event.append(element("p", "r6-copy", checkingAlchemy
          ? "正在核对丹方、药炉许可与材料；核验完成前不会扣除钱物或光阴。"
          : "正在核对这项行动；核验完成前不会扣除钱物或光阴。"));
        const pending = makeButton(checkingAlchemy ? "正在核对炼药条件…" : "正在启动行动…", () => {}, "r6-button primary");
        pending.disabled = true;
        shell.event.append(pending);
        return;
      }
      if (flight?.pauseReason === "world_node_due" && flight.pauseEventId) {
        shell.event.append(element("p", "r6-copy", "做事途中遇到一桩急事；先处理眼前来事，原来的事情会从这里接着做。"));
        renderChoiceCard(flight.pauseEventId, eventDefinitions.get(flight.pauseEventId)?.presentation?.title || "途中来事", "先作眼前选择，之后再接续原来的事。", shell.event);
        return;
      }
      const remaining = Math.max(0, Number(flight?.targetDay || 0) - Number(state.worldDay || 0));
      const isRecovery = action.actionId === "r4_action_recover";
      const isPractice = action.actionId === "r4_action_practice";
      const isStrandedReturn = action.actionId === "r6_stranded_return";
      shell.event.append(element("p", "r6-copy", action.awaitingInterruptionDecision
        ? `眼前的事已处理；${isRecovery ? "休整" : isStrandedReturn ? "返程" : "炼药"}预计于${displayCalendarDate(flight.targetDay)}结束。你可以接着做，也可以到此为止。`
        : isRecovery ? `休整已开始，预计于${displayCalendarDate(flight.targetDay)}结束。刷新页面后仍可接着做。`
          : isPractice ? `打坐修行已开始，预计于${displayCalendarDate(flight.targetDay)}结束；行程日期已冻结，修行结束后再接着走。`
          : isStrandedReturn ? `返程已开始；预计于${displayCalendarDate(flight.targetDay)}抵达灰泉镇。`
            : `炼药已按正式药方开始，材料已预扣，预计于${displayCalendarDate(flight.targetDay)}结炉。刷新页面后仍可接着做。`));
      const continueLabel = action.awaitingInterruptionDecision
        ? `继续${isRecovery ? "休整" : isStrandedReturn ? "返程" : "炼药"} · 至${displayCalendarDate(flight.targetDay)}`
        : remaining ? (isRecovery ? `继续完成休整 · 至${displayCalendarDate(flight.targetDay)}` : isPractice ? `继续完成打坐 · 至${displayCalendarDate(flight.targetDay)}` : isStrandedReturn ? `继续返程 · 至${displayCalendarDate(flight.targetDay)}` : `继续完成炼药 · 至${displayCalendarDate(flight.targetDay)}`) : "查看结果";
      shell.event.append(makeButton(continueLabel, () => continueTimedAction(), "r6-button primary"));
      if (action.awaitingInterruptionDecision && ["r4_action_recover", "r6_stranded_return"].includes(action.actionId)) {
        shell.event.append(makeButton(isRecovery ? "结束休整" : "停止返程", () => terminateTimedAction(), "r6-button"));
      }
    } else {
      shell.event.append(element("p", "r6-copy", "眼前这件事还没有落定。"));
      const pending = makeButton("正在处理…", () => {}, "r6-button primary");
      pending.disabled = true;
      shell.event.append(pending);
    }
    return;
  }
  if (presentation.introRead === false) {
    shell.event.append(element("h2", "", "这里是青墟界"));
    shell.event.append(element("p", "r6-copy", "草木随时令生长，炉火有炉火的规矩，走一段远路也要花去时日。你来到这一世，眼前没有替你写好的唯一去处。"));
    shell.event.append(element("p", "r6-copy", "手边有营生，便从眼下做得成的事开始；身上有药草，可以打听它的用处和去处；想学丹术或修行，就循着师承、材料与眼前的条件慢慢来。钱袋见底时，先看看附近有没有可做的活计；身子乏了，也可以挑一段时日歇息整顿。"));
    shell.event.append(element("p", "r6-copy", "采药、炼药都只是路之一。你可以谋生、求学、修行、行路，也可以换个打算。先选一件此刻走得通的事，把日子过下去；往后如何，由你自己决定。"));
    shell.event.append(makeButton("记下了", async () => {
      currentPresentation().introRead = true;
      await persistEnvelope();
      render();
    }, "r6-button primary"));
    return;
  }
  if (presentation.pendingResult?.readState === "unread") {
    renderPendingResult(presentation.pendingResult);
    return;
  }
  if (engine.isEventAvailable("r4_birth_story")) {
    renderChoiceCard("r4_birth_story", "院中旧事", "一段早年经历，留待你亲自作答。", shell.event);
    return;
  }
  if (engine.isEventAvailable("r4_ev_birth_herbal_roof")) {
    if (presentation.dialogueRef?.eventId === "r4_ev_birth_herbal_roof" && presentation.dialogueRef?.lineId === "choices") {
      renderChoiceCard("r4_ev_birth_herbal_roof", "檐下药草", "雨意渐近，檐下这一批药草该如何处置？", shell.event);
      return;
    }
    const hotspot = makeButton("查看药架", () => openRoofEvent(), "r6-button hotspot");
    hotspot.setAttribute("aria-label", "查看药架上的药草与当前来事");
    shell.scene.append(hotspot);
    shell.activity.append(element("h2", "", "院落里的事"));
    shell.activity.append(element("p", "r6-copy", "雨意渐近，檐下的药草该收拾了。你走近药架，看看眼下该如何处置。"));
    return;
  }
  const here = locationName(state.character.location);
  shell.activity.append(element("h2", "", state.character.location === "r4_loc_ashspring" ? "院中还可做的事" : `${here}还可做的事`));
  if (presentation.dialogueRef?.lineId === "arrival") shell.activity.append(element("p", "r6-copy", `路途已尽，你抵达了${locationName(state.character.location)}。`));
  else shell.activity.append(element("p", "r6-copy", `${here}暂时安静下来。可理药、接活，也可循已知道路出镇。`));
  const hint = element("details", "r6-hint");
  hint.append(element("summary", "", "看看眼下能做什么"), element("p", "r6-source", "只是眼前几条路，不必照着做。"));
  const currentWork = availableOptions("r4_daily_entrust").filter((option) => option.canAfford);
  const currentHerbs = availableOptions("r4_daily_herb").filter((option) => option.canAfford);
  if (currentWork.length) hint.append(element("p", "r6-copy", "眼下有一份可接的帮工。"));
  if (currentHerbs.length) hint.append(element("p", "r6-copy", "这里有可做的采药之事。"));
  const knownRoutes = pack.runtimeSources.worldInitialization.routes.filter((route) => route.from === state.character.location && state.character.knownLocations?.includes(route.to));
  if (knownRoutes.length) hint.append(element("p", "r6-copy", `已知道路：${knownRoutes.map((route) => `${locationName(route.to)}（乘车预计${completionDate(state.worldTick, findActionDuration(timeContract, { actionId: "r4_action_travel", context: { days: Number(route.days) } }))}抵达，车资 ${formatWenFromLegacy(route.wealth)}；也可徒步）`).join("；")}。`));
  if (!currentWork.length && !currentHerbs.length && !knownRoutes.length) hint.append(element("p", "r6-copy", "眼下没有可接的活计、可采的药草或已知道路。"));
  shell.activity.append(hint);
  for (const eventId of ["r4_daily_entrust", "r4_daily_herb", "r4_acq_dao02"]) {
    const options = availableOptions(eventId);
    if (!options.length) continue;
    const definition = eventDefinitions.get(eventId);
    shell.activity.append(element("h3", "", eventTitle(eventId, definition?.presentation?.title)));
    if (eventId === "r4_daily_herb" && herbImageUrl) {
      const visual = element("div", "r6-herb-visual");
      const image = element("img", "r6-herb-image");
      const versionedHerbUrl = new URL(herbImageUrl);
      versionedHerbUrl.searchParams.set("v", SCENE_ART_VERSION);
      image.src = versionedHerbUrl.href;
      image.alt = "通用草药采集情境图，不代表具体草药物种";
      image.loading = "lazy";
      image.decoding = "async";
      visual.append(image, element("span", "r6-source", "采集情境图 · 当前登记草药：星芒草"));
      shell.activity.append(visual);
    }
    const list = element("div", "r6-option-list");
    for (const option of options) {
      const choice = makeChoiceButton(eventId, option);
      choice.dataset.choiceId = option.id;
      choice.dataset.eventId = eventId;
      list.append(choice);
      const notice = optionNotice(eventId, option);
      if (notice) list.append(element("p", "r6-option-note", notice));
    }
    shell.activity.append(list);
    if (eventId === "r4_daily_herb" && options.some((option) => option.id === "help_other_gatherer")) {
      shell.activity.append(element("p", "r6-option-note", "这是一项可选的帮忙，不是主线必做；需已有星芒止血散。"));
    }
  }
  if (state.character.location === "r4_loc_furnace_lane") {
    const readiness = alchemyReadiness(state);
    const costs = Object.entries(readiness.costs).map(([itemId, amount]) => itemId === "wealth" ? formatWenFromLegacy(amount) : `${amount}${itemId === "r4_item_stargrass" ? "份星芒草" : "份物资"}`).join(" + ");
    const success = Math.round(Number(pack.actions.r4_action_alchemy.successChance) * 100);
    shell.activity.append(element("h3", "", "炼制星芒止血散"));
    const craftTicks = findActionDuration(timeContract, { actionId: "r4_action_alchemy", operation: "days" });
    const craft = makeButton(`开始炼药 · 预计${completionDate(state.worldTick, craftTicks)}结炉 · 消耗 ${costs} · 成功率 ${success}%`, () => beginTimedAction("r4_action_alchemy"));
    craft.disabled = !readiness.ready;
    shell.activity.append(craft);
    if (!readiness.ready) shell.activity.append(element("p", "r6-option-note", readiness.missing.join("；")));
  }
  const recovery = Number(state.character.health || 0) < Number(state.character.maxHealth || 100);
  if (recovery) {
    shell.activity.append(element("h3", "", "休整恢复"));
    const plainCost = Number(state.character.cashWen || 0) > 0 ? formatWenFromLegacy(pack.actions.r4_action_recover.wealth) : "不花钱";
    const plainRecoveryTicks = Number(pack.actions.r4_action_recover.days) * 96;
    shell.activity.append(makeButton(`休整至${completionDate(state.worldTick, plainRecoveryTicks)} · ${plainCost}`, () => beginRecovery(false), "r6-button"));
    const powder = itemCount(state, "r4_item_powder");
    const medicatedRecoveryCostWen = Number(pack.actions.r4_action_recover.wealth || 0);
    if (Number(state.character.cashWen || 0) >= medicatedRecoveryCostWen && powder >= Number(pack.actions.r4_action_recover.medicated.powder)) {
      const medicatedRecoveryTicks = (Number(pack.actions.r4_action_recover.days) + Number(pack.actions.r4_action_recover.medicated.extraDays)) * 96;
      shell.activity.append(makeButton(`用药休整至${completionDate(state.worldTick, medicatedRecoveryTicks)} · ${formatWenFromLegacy(medicatedRecoveryCostWen)} · 星芒止血散 1 份`, () => beginRecovery(true), "r6-button"));
    }
  }
  if (state.character.location === "r4_loc_furnace_lane") renderFurnaceAccessActions();
  if (["r4_loc_willow_market", "r4_loc_mirror_stage"].includes(state.character.location)) renderMarketTrade(state.character.location, state);
  renderCourierActions(state);
  renderTravelSupplies(state);
  const routes = knownAdjacentTravelRoutes(pack.runtimeSources.worldInitialization.routes, state.character);
  for (const route of routes) {
    const carriageTicks = findActionDuration(timeContract, { actionId: "r4_action_travel", context: { days: Number(route.days) } });
    const button = makeButton(`乘车前往${locationName(route.to)} · 预计${completionDate(state.worldTick, carriageTicks)}抵达 · ${formatWenFromLegacy(route.wealth)}`, () => beginTravel(route.to, "carriage"), "r6-button travel");
    button.dataset.node = "r6_travel_option";
    button.dataset.destinationId = route.to;
    button.disabled = Number(state.character.cashWen) < Number(route.wealth);
    const note = element("p", "r6-travel-note", travelDestinationNote(route.to, state));
    note.dataset.node = `r6_travel_note_${route.to}`;
    const walkingDays = Math.ceil(Number(route.days) * 1.5);
    const walk = makeButton(`徒步前往${locationName(route.to)} · 预计${completionDate(state.worldTick, walkingDays * 96)}抵达 · 不收路费`, () => beginTravel(route.to, "walking"), "r6-button travel");
    walk.dataset.node = "r6_travel_option";
    walk.dataset.destinationId = route.to;
    const rationNeed = Math.ceil(walkingDays / 7);
    const rationMissing = Math.max(0, rationNeed - itemCount(state, "r6_item_travel_ration"));
    const walkingNote = element("p", "r6-travel-note", rationMissing
      ? `徒步需 ${rationNeed} 份口粮；你缺 ${rationMissing} 份，抵达时身况将损失 ${rationMissing}。` 
      : `徒步需 ${rationNeed} 份口粮；你携带 ${itemCount(state, "r6_item_travel_ration")} 份，途中供食充足。`);
    walkingNote.dataset.node = `r6_walk_note_${route.to}`;
    shell.activity.append(button, walk, note, walkingNote);
  }
}
function renderChoiceCard(eventId, title, copy, parent) {
  const options = availableOptions(eventId);
  const heading = element("h2", "", title);
  parent.append(heading, element("p", "r6-copy", copy));
  if (!options.length) {
    parent.append(element("p", "r6-alert", "眼下没有可作的选择。"));
    return;
  }
  const list = element("div", "r6-option-list");
  for (const option of options) {
      const choice = makeChoiceButton(eventId, option);
    choice.dataset.choiceId = option.id;
      choice.dataset.eventId = eventId;
    list.append(choice);
      const notice = optionNotice(eventId, option);
      if (notice) list.append(element("p", "r6-option-note", notice));
  }
  parent.append(list);
}
function renderCourierActions(state) {
  const contracts = state.world.r6CourierContracts || [];
  const activeDelivery = contracts.find((row) => row.status === "accepted" && row.acceptedBy === state.character.id);
  if (activeDelivery && state.character.location === "r4_loc_mirror_stage") {
    shell.activity.append(element("h3", "", "柳汀药铺托付"));
    shell.activity.append(element("p", "r6-copy", `药包已送到收件人处；约定期限为 ${displayCalendarDate(activeDelivery.dueWorldDay)}，按签收回执结算。`));
    const sign = makeButton("交付药包并请收件人签收", () => deliverCourierContract(activeDelivery.contractId), "r6-button");
    sign.id = "r6-courier-deliver";
    sign.disabled = Number(state.worldDay) > Number(activeDelivery.dueWorldDay);
    shell.activity.append(sign);
  }
  const returnCargo = contracts.find((row) => row.status === "expired" && state.world.r6CourierParcels?.some((parcel) => parcel.contractId === row.contractId && parcel.status === "return_cargo_with_character" && parcel.holderId === state.character.id));
  if (returnCargo && state.character.location === "r4_loc_willow_market") {
    shell.activity.append(element("h3", "", "逾期药包待归还"));
    shell.activity.append(element("p", "r6-copy", "托管款已按逾期回执退回药铺；药包仍由你带回，须在此地实际交还后才重新入账。"));
    const returnButton = makeButton("将逾期药包交还柳汀药铺", () => returnCourierPackage(returnCargo.contractId), "r6-button");
    returnButton.id = "r6-courier-return-parcel";
    shell.activity.append(returnButton);
  }
}
async function deliverCourierContract(contractId) {
  if (busy) return;
  busy = true;
  try {
    const result = engine.deliverCourierContract(contractId);
    if (result?.error) throw new Error(result.error);
    errorText = `收件回执已签：药铺托管账向钱袋转入 ${formatWenFromLegacy(result.receipt.amountWen)}；没有额外点数。`;
    await persistEnvelope(); render();
  } catch (error) { errorText = safeError(error, "收件回执未签，钱袋与药包状态不变。"); render(); }
  finally { busy = false; }
}
async function returnCourierPackage(contractId) {
  if (busy) return;
  busy = true;
  try {
    const result = engine.returnCourierPackage(contractId);
    if (result?.error) throw new Error(result.error);
    errorText = "药包已由药铺收回；药材只按这张实物归还回执重新入账。";
    await persistEnvelope(); render();
  } catch (error) { errorText = safeError(error, "药包未交还，物品账未改变。"); render(); }
  finally { busy = false; }
}
async function waitAtFloodClosure() {
  if (busy) return;
  busy = true;
  try {
    const result = engine.waitAtFloodClosure();
    if (result?.error) throw new Error(result.error);
    errorText = result.closure?.status === "active" ? `道路仍封闭；将在 ${displayCalendarDate(result.closure.endWorldDayExclusive)} 恢复通行。原行程未推进。` : "复核期限已到，道路现已开放；原行程等待你继续。";
    await persistEnvelope(); render();
  } catch (error) { errorText = safeError(error, "路况复核未完成；原行程保留在暂停处。"); render(); }
  finally { busy = false; }
}
function choiceLabel(eventId, option, worldTick = runtimeState().worldTick) {
  const dateLabel = (durationTicks) => Number.isSafeInteger(worldTick) && Number.isSafeInteger(durationTicks) ? ` · 至${completionDate(worldTick, durationTicks)}` : "";
  const natural = {
    "r4_ev_daily_courier:r6_choice_accept_delivery": "接下送药委托",
    "r4_ev_daily_courier:r6_choice_decline_delivery": "婉拒本次委托",
    "r4_ev_daily_courier:verify_dispatch_copy": "核对送药委托",
    "r4_ev_daily_courier:return_to_sender": "原封退回药包",
    "r4_ev_daily_roadmarker:leave_and_report": `停步查看路标与水势${dateLabel(findActionDuration(timeContract, { eventId, choiceId: option.id }))}`,
    "r4_birth_story:respond_to_neighbor": "应下邻里托付",
    "r4_birth_story:help_household": "帮家里料理一件日常事",
    "r4_birth_story:fulfill_early_duty": "把先前答应的事做完",
    "r4_ev_birth_herbal_roof:save_neighbor_batch": "先护住托管的药草",
    "r4_ev_birth_herbal_roof:save_household_batch": "先收好自家的药草",
    "r4_ev_birth_herbal_roof:repair_and_call_help": "先补好棚角，再请人搭把手",
    "r4_daily_entrust:accept_and_fulfill": "接下帮工，把这份活计做好",
    "r4_daily_entrust:accept_and_fail": "接下帮工，但这份活没能做完",
    "r4_daily_entrust:decline": "婉言谢绝",
    "r4_daily_herb:harvest_for_self": `采下一份星芒草${dateLabel(findActionDuration(timeContract, { eventId, choiceId: option.id }))}`,
    "r4_daily_herb:help_other_gatherer": "送一份星芒止血散，帮采药人一把 · 可选",
    "r4_daily_herb:leave_stock": "暂且留下药草",
    "r4_acq_dao02:accept_apprenticeship": `随炉主学丹术${dateLabel(findActionDuration(timeContract, { eventId, choiceId: option.id }))}取得药方与七日药炉使用许可`,
    "r4_acq_dao02:buy_public_course": `缴2钱修习公开课程${dateLabel(findActionDuration(timeContract, { eventId, choiceId: option.id }))}（另需药炉使用许可）`,
    "r4_acq_dao02:decline": "暂不拜师",
    "r4_ev_realm_core_craft:finish_authorized_batch": `按授权药方炼制星芒止血散${dateLabel(findActionDuration(timeContract, { eventId, choiceId: option.id })).replace("至", "预计")}结炉 · 80% 成功率`,
    "r4_ev_realm_core_craft:log_variation": "暂停本批次并记录观测",
    "r4_ev_realm_core_craft:yield_to_repair": "让出炉位，避免设备损坏"
  };
  const text = natural[`${eventId}:${option.id}`] || option.text;
  return typeof text === "string" && text.trim() ? text.trim() : "";
}
function makeChoiceButton(eventId, option) {
  const label = choiceLabel(eventId, option);
  const canSelect = Boolean(label) && option.canAfford !== false;
  const duration = findActionDuration(timeContract, { eventId, choiceId: option.id });
  const timeLabel = duration > 0 ? ` · ${duration < 96 ? `${duration}刻` : `${duration / 96}日`}` : "";
  const button = makeButton(`${label || "此项暂不可选"}${timeLabel}`, () => submitChoice(eventId, option.id), "r6-button");
  if (!canSelect) { button.disabled = true; button.setAttribute("aria-disabled", "true"); }
  return button;
}
function optionNotice(eventId, option) {
  if (!choiceLabel(eventId, option)) return "这项回应还没有写明白，暂时不能选择。";
  return option.canAfford === false ? option.affordabilityMessage || "所需物资尚不齐备。" : "";
}
function eventTitle(eventId, fallback = "眼前的事") {
  const titles = {
    r4_birth_story: "院中旧事",
    r4_ev_birth_herbal_roof: "雨前收药草",
    r4_daily_entrust: "一份帮工",
    r4_daily_herb: "采集星芒草",
    r4_acq_dao02: "丹术课程与拜师",
    r4_ev_realm_core_craft: "炼制星芒止血散",
    r4_ev_daily_courier: "柳汀药铺的托付",
    r4_action_recover: "休整恢复",
    r4_action_alchemy: "炼制星芒止血散",
    r6_action_alchemy_portable: "途中以行炉炼药",
    r6_stranded_return: "回灰泉镇"
  };
  return titles[eventId] || (typeof fallback === "string" && fallback.trim() ? fallback : "眼前的事");
}
function renderPendingResult(pending) {
  const state = runtimeState();
  const result = state.lastResult;
  const event = eventDefinitions.get(pending.eventId);
  const option = event?.options?.find((row) => row.id === result?.optionId);
  const title = eventTitle(pending.eventId, event?.presentation?.title);
  const durationTicks = Number(pending.durationTicks || 0);
  const labelStartTick = Number.isSafeInteger(pending.startedAtTick) ? pending.startedAtTick : Number(state.worldTick) - durationTicks;
  shell.result.dataset.resultId = pending.resultId;
  shell.result.append(element("h2", "", title));
  shell.result.append(element("p", "r6-copy", option ? choiceLabel(pending.eventId, option, labelStartTick) : choiceLabel(pending.eventId, { id: result?.optionId, text: "" }, labelStartTick) || "这段经历有了结果。"));
  const days = Number(result?.time?.durationDays || 0);
  const craftBatch = ["r4_action_alchemy", "r6_action_alchemy_portable", "r4_ev_realm_core_craft"].includes(pending.eventId)
    ? [...(state.world.craftBatchLedger || [])].reverse().find((row) => row.actorId === state.character.id && row.lifeIndex === state.character.lifeIndex && row.actionTransactionId === pending.transactionId && ["completed", "failed"].includes(row.status))
    : null;
  const succeeded = craftBatch ? craftBatch.status === "completed" : result?.outcome === "success";
  const place = locationName(state.character.location);
  const completion = days ? displayCalendarDate(state.worldDay) : null;
  const prose = succeeded
    ? (durationTicks ? `事情办妥了，耗时${durationTicks}刻；现为${displayWorldTime(state.worldTick)}。你现在在${place}。`
      : days ? `事情办妥了，光阴至${completion}。你现在在${place}。` : "这份心意留在今世，光阴未动。")
    : (durationTicks ? `事情没能如愿，耗时${durationTicks}刻；现为${displayWorldTime(state.worldTick)}。你现在在${place}。`
      : days ? `事情没能如愿，光阴至${completion}。你现在在${place}。` : "这件事没能如愿，眼下光阴未动。");
  shell.result.append(element("p", "r6-copy", prose));
  if (["r4_action_recover", "r6_stranded_return"].includes(pending.eventId) && typeof result?.resultText === "string") {
    shell.result.append(element("p", "r6-copy", result.resultText));
  }
  if (["r4_action_alchemy", "r6_action_alchemy_portable", "r4_ev_realm_core_craft"].includes(pending.eventId)) {
    if (craftBatch) shell.result.append(element("p", "r6-copy", craftBatch.status === "completed"
      ? `本批炼制成功，星芒止血散已入囊；当前持有 ${itemCount(state, "r4_item_powder")} 份。`
      : "本批炼制未成；已预扣的星芒草与现钱不返还，未获得成药。"));
  }
  shell.result.append(element("p", "r6-source", "这段经历已收进行录。"));
  const continueLabel = pending.eventId === "r4_ev_birth_herbal_roof" ? "收拾停当" : pending.eventId === "r4_daily_entrust" ? `回到${locationName(state.character.location)}` : "收下这段经历";
  shell.result.append(makeButton(continueLabel, () => acknowledgeResult(), "r6-button primary"));
}
async function openRoofEvent() {
  if (busy || !engine.isEventAvailable("r4_ev_birth_herbal_roof")) return;
  busy = true;
  try {
    setEventReference("r4_ev_birth_herbal_roof");
    await persistEnvelope();
    render();
  } catch (error) { errorText = safeError(error, "眼前的情形暂未记下；这局仍在，请稍后再试。"); render(); }
  finally { busy = false; }
}
function matchingCommittedChoice(eventId, choiceId, tx) {
  const state = runtimeState();
  const receipt = state.r5LifeLedger?.transactions?.[`content:${tx}`];
  const result = state.lastResult;
  if (receipt?.transactionId !== tx || receipt.eventId !== eventId || receipt.choiceId !== choiceId
    || !["success", "failure"].includes(receipt.outcome)
    || result?.kind !== "result" || result.eventId !== eventId || result.optionId !== choiceId || result.outcome !== receipt.outcome) return null;
  return result;
}
function restoreSavedRuntimeBeforeChoice() {
  engine = createRuntime();
  engine.restoreDto(envelope.r5Save);
  const presentation = currentPresentation();
  presentation.pendingAction = null;
  presentation.pendingResult = null;
  presentation.selectedChoiceId = null;
  presentation.dialogueCursor = 0;
  syncReturnTarget();
}
async function retryEnvelopeSave() {
  if (busy) return;
  busy = true;
  try {
    await persistEnvelope();
    errorAction = null;
    errorText = "记录已保存，可以继续眼下的事。";
    render();
  } catch (error) {
    const conflict = error?.message === "r6_save_conflict";
    renderRecoverableError(conflict ? safeError(error) : "存档仍未写好；原记录保留，请稍后再试。", conflict ? "刷新并读取最新记录" : "重试保存", conflict ? () => location.reload() : retryEnvelopeSave);
  } finally { busy = false; }
}
async function recoverPendingChoice(eventId, choiceId, tx, error) {
  const committed = matchingCommittedChoice(eventId, choiceId, tx);
  if (committed) {
    try {
      await commitChoiceResult(eventId, choiceId, tx, committed);
      errorText = "";
      errorAction = null;
      render();
    } catch (saveError) {
      const conflict = saveError?.message === "r6_save_conflict";
      renderRecoverableError(conflict ? safeError(saveError) : "事情已经办妥，但结果还没写进存档。请保存后再继续。", conflict ? "刷新并读取最新记录" : "重试保存结果", conflict ? () => location.reload() : retryEnvelopeSave);
    }
    return;
  }

  const rejectedOption = availableOptions(eventId).find((option) => option.id === choiceId);
  const shortage = (typeof error === "string" ? error : error?.message) === "insufficient_resource" ? rejectedOption?.affordabilityMessage : "";
  restoreSavedRuntimeBeforeChoice();
  errorText = shortage ? `${shortage}；这次没有办成，光阴与物资没有变化。` : safeError(error, "这次没有办成，光阴与物资没有变化。请重新看看可作的选择。");
  errorAction = null;
  try {
    await persistEnvelope();
    render();
  } catch (saveError) {
    const conflict = saveError?.message === "r6_save_conflict";
    renderRecoverableError(conflict ? safeError(saveError) : "这次没有结算，但存档状态暂未更新。原记录还在，请重试保存。", conflict ? "刷新并读取最新记录" : "重试保存", conflict ? () => location.reload() : retryEnvelopeSave);
  }
}
async function resolvePendingChoice(eventId, choiceId, tx) {
  try {
    const raw = engine.resolveWorldChoice(eventId, choiceId, tx);
    if (raw?.error) return recoverPendingChoice(eventId, choiceId, tx, raw.error);
    if (raw?.kind === "progress" && raw.realmCraftAction) {
      currentPresentation().pendingAction = { operationId: tx, actionId: "r4_action_alchemy", transactionId: tx, status: "in_flight" };
      currentPresentation().scrollAnchor = "r6-scene-event";
      await persistEnvelope();
      render();
      return;
    }
    if (raw?.kind === "progress" && raw.r6TimedChoice) {
      currentPresentation().pendingAction = { operationId: tx, actionId: "r6_timed_choice", transactionId: tx, eventId, choiceId, status: "in_flight", durationTicks: raw.timedChoice.durationTicks, startedAtTick: raw.timedChoice.startedAtTick, targetAtTick: raw.timedChoice.targetAtTick };
      currentPresentation().scrollAnchor = "r6-scene-event";
      await persistEnvelope();
      render();
      return;
    }
    const result = raw?.kind === "duplicate_suppressed" ? matchingCommittedChoice(eventId, choiceId, tx) : raw;
    if (!result) return recoverPendingChoice(eventId, choiceId, tx, "choice_receipt_unavailable");
    await commitChoiceResult(eventId, choiceId, tx, result);
  } catch (error) {
    await recoverPendingChoice(eventId, choiceId, tx, error);
  }
}
async function finishStandaloneAction(actionId, tx, result) {
  if (!(["result", "interrupted"].includes(result?.kind))) throw new Error(result?.error || result?.reason || result?.kind || "action_not_completed");
  const presentation = currentPresentation();
  if (actionId === "r6_stranded_return" && result.kind === "result" && runtimeState().character.location === "r4_loc_ashspring") {
    presentation.sceneLocationId = "r4_loc_ashspring";
    presentation.sceneInstanceId = `${runtimeState().worldId}:${runtimeState().character.lifeIndex}:r4_loc_ashspring`;
    presentation.dialogueRef = { eventId: actionId, instanceId: eventInstanceId(actionId), lineId: "arrival", speakerId: null, sourceRefs: [] };
  }
  const viewId = eventInstanceId(actionId);
  presentation.eventInstanceRef = {
    eventId: actionId, instanceId: viewId, causeId: result.transaction?.transactionId || tx,
    locationId: runtimeState().character.location, status: "committed", sourceRefs: []
  };
  presentation.dialogueRef = { eventId: actionId, instanceId: viewId, lineId: "runtime-result", speakerId: null, sourceRefs: [] };
  presentation.selectedChoiceId = null;
  presentation.pendingAction = null;
  presentation.pendingResult = {
    resultId: `${viewId}:${result.outcome || "completed"}:${tx}`,
    eventId: actionId, instanceId: viewId, outcomeId: `${actionId}.${result.outcome || "completed"}`,
    transactionId: tx, runtimeReceiptKey: runtimeResultReceiptKey(runtimeState()), readState: "unread"
  };
  presentation.scrollAnchor = "r6-scene-result";
  presentation.viewportAnchorId = "r6-scene-result";
  presentation.viewportOffsetTop = 0;
  presentation.focusId = null;
  syncReturnTarget();
  await persistEnvelope();
  render();
}
async function dispatchTimedAction(actionId, payload, operationId) {
  const result = engine.performWorldAction(actionId, payload);
  if (result?.error) throw new Error(result.error);
  const flight = runtimeState().inFlightTransaction;
  if (result?.kind === "progress") {
    if (flight?.actionId !== actionId) throw new Error("timed_action_transaction_missing");
    currentPresentation().pendingAction.transactionId = flight.transactionId;
    currentPresentation().pendingAction.status = "in_flight";
    await persistEnvelope();
    render();
    return;
  }
  if (result?.kind === "result") return finishStandaloneAction(actionId, flight?.transactionId || operationId, result);
  throw new Error(result?.reason || result?.kind || "timed_action_not_started");
}
async function beginTimedAction(actionId, payload = {}, meta = {}) {
  if (busy || currentPresentation()?.pendingAction || currentPresentation()?.pendingResult?.readState === "unread") {
    if (qaActionDiagnostics) {
      qaLastActionError = { blocked: true, busy, pendingAction: currentPresentation()?.pendingAction || null, pendingResult: currentPresentation()?.pendingResult || null };
      render();
    }
    return;
  }
  busy = true;
  const operationId = `${slotId}:${runtimeState().character.lifeIndex}:${crypto.randomUUID()}`;
  try {
    const presentation = currentPresentation();
    presentation.pendingAction = { operationId, actionId, transactionId: operationId, status: "submitting", ...meta };
    presentation.selectedChoiceId = null;
    presentation.dialogueRef = { eventId: actionId, instanceId: eventInstanceId(actionId), lineId: "action", speakerId: null, sourceRefs: [] };
    errorText = "";
    errorAction = null;
    await persistEnvelope();
    render();
    await dispatchTimedAction(actionId, payload, operationId);
  } catch (error) {
    qaLastActionError = qaActionDiagnostics ? String(error?.message || error) : null;
    restoreSavedRuntimeBeforeChoice();
    errorText = safeError(error, "这件事暂未开始；没有结算，请按眼下条件补齐后再试。 ");
    errorAction = null;
    try { await persistEnvelope(); render(); }
    catch (saveError) { renderRecoverableError(safeError(saveError, "状态没有保存好；原存档仍在。"), "重试保存", retryEnvelopeSave); }
  } finally { busy = false; }
}
function beginRecovery(medicated) {
  const state = runtimeState();
  if (Number(state.character.health || 0) >= Number(state.character.maxHealth || 100)) return;
  if (medicated && (Number(state.character.cashWen || 0) < Number(pack.actions.r4_action_recover.wealth || 0) || itemCount(state, "r4_item_powder") < Number(pack.actions.r4_action_recover.medicated.powder))) return;
  const optionId = medicated ? "R6-REST-10D-MEDICATED" : "R6-REST-7D-PLAIN";
  const durationDays = Number(pack.actions.r4_action_recover.days) + (medicated ? Number(pack.actions.r4_action_recover.medicated.extraDays) : 0);
  return beginTimedAction("r4_action_recover", { medicated }, { optionId, durationDays, daysDone: 0, interruptionRef: null });
}
async function continueTimedAction() {
  if (busy) return;
  const action = currentPresentation().pendingAction;
  if (action?.actionId === "r6_timed_choice") {
    busy = true;
    try {
      const raw = engine.continuePendingWorldChoice();
      if (raw?.error) throw new Error(raw.error);
      if (raw?.kind === "interrupted") {
        currentPresentation().pendingAction = null;
        currentPresentation().pendingResult = null;
        errorText = "寿限在这件事办成前已尽；选择未结算。";
        await persistEnvelope();
        render();
        return;
      }
      if (raw?.kind === "progress") {
        const timed = raw.timedChoice;
        action.status = timed?.status || "in_flight";
        action.pauseEventId = raw.pauseEventId || null;
        await persistEnvelope();
        render();
        return;
      }
      if (raw?.kind === "result") {
        await commitChoiceResult(action.eventId, action.choiceId, action.transactionId, raw);
        return;
      }
      throw new Error(raw?.reason || raw?.kind || "timed_choice_result_missing");
    } catch (error) {
      errorText = safeError(error, "这项事情暂未续上；原有时辰与存档仍在。请重新查看眼下状态。");
      try { await persistEnvelope(); render(); } catch (saveError) { renderRecoverableError(safeError(saveError), "重试保存", retryEnvelopeSave); }
    } finally { busy = false; }
    return;
  }
  if (!action || !["r4_action_recover", "r4_action_alchemy", "r6_action_alchemy_portable", "r4_action_practice", "r4_action_social", "r6_stranded_return"].includes(action.actionId)) return;
  busy = true;
  try {
    const state = runtimeState();
    const craft = state.world.pendingRealmCraft;
    const expectedId = action.actionId === "r4_action_alchemy" && craft ? craft.actionTransactionId : action.transactionId;
    if (!expectedId || state.inFlightTransaction?.transactionId !== expectedId || state.inFlightTransaction?.actionId !== action.actionId) throw new Error("active_action_transaction_mismatch");
    action.status = "in_flight";
    action.awaitingInterruptionDecision = false;
    action.interruptionRef = null;
    const remainingDays = Math.max(0, Number(state.inFlightTransaction.targetDay || state.worldDay) - Number(state.worldDay));
    // Advance ordinary calendar days in one player action. The engine still
    // processes each day and stops early at death or any real world node.
    const advanceDays = Math.max(1, remainingDays);
    const raw = engine.continueWorldAction(advanceDays);
    if (raw?.error) throw new Error(raw.error);
    if (raw?.kind === "progress") {
      await persistEnvelope();
      render();
      return;
    }
    if (["r4_action_alchemy", "r6_action_alchemy_portable"].includes(action.actionId)) {
      if (craft) {
        const eventId = craft.eventId || currentPresentation().dialogueRef?.eventId;
        const choiceId = craft.choiceId || currentPresentation().selectedChoiceId;
        if (raw?.kind !== "result" || !eventId || !choiceId) throw new Error(raw?.reason || raw?.kind || "alchemy_result_missing");
        await commitChoiceResult(eventId, choiceId, craft.transactionId, raw);
      } else if (raw?.kind === "result" || raw?.kind === "interrupted") {
        await finishStandaloneAction(action.actionId, action.transactionId, raw);
      } else throw new Error(raw?.reason || raw?.kind || "alchemy_result_missing");
      return;
    }
    if (raw?.kind === "result" || raw?.kind === "interrupted") {
      await finishStandaloneAction(action.actionId, action.transactionId, raw);
      return;
    }
    throw new Error(raw?.reason || raw?.kind || "action_result_missing");
  } catch (error) {
    errorText = safeError(error, "这件事暂未续上；已发生的时间与消耗仍以存档为准。请重新查看眼下状态。");
    errorAction = null;
    try { await persistEnvelope(); render(); }
    catch (saveError) { renderRecoverableError(safeError(saveError, "进度没有写入；原记录仍在。"), "重试保存", retryEnvelopeSave); }
  } finally { busy = false; }
}
async function terminateTimedAction() {
  if (busy) return;
  const action = currentPresentation().pendingAction;
  if (!action?.awaitingInterruptionDecision || !["r4_action_recover", "r6_stranded_return"].includes(action.actionId)) return;
  busy = true;
  try {
    const result = engine.abortWorldAction();
    if (result?.error || result?.kind !== "result") throw new Error(result?.error || result?.reason || "action_termination_failed");
    await finishStandaloneAction(action.actionId, action.transactionId, result);
  } catch (error) {
    errorText = safeError(error, "这件事暂未结束；原有进度仍在。请重新查看眼下状态。");
    await persistEnvelope();
    render();
  } finally { busy = false; }
}
async function submitChoice(eventId, choiceId) {
  if (busy) return;
  const option = availableOptions(eventId).find((row) => row.id === choiceId);
  if (!option) { errorText = "眼下情形有变，这次没有办成；请重新看看可作的选择。"; errorAction = null; render(); return; }
  if (!choiceLabel(eventId, option)) { errorText = "这项回应还没有写明白，暂时不能选择。"; errorAction = null; render(); return; }
  if (!option.canAfford) { errorText = option.affordabilityMessage || "所需物资尚不齐备，这次没有结算。"; errorAction = null; render(); return; }
  busy = true;
  const tx = `${slotId}:${runtimeState().character.lifeIndex}:${crypto.randomUUID()}`;
  try {
    setEventReference(eventId);
    const presentation = currentPresentation();
    presentation.selectedChoiceId = choiceId;
    presentation.pendingAction = { operationId: tx, actionId: eventId, transactionId: tx, status: "submitting" };
    errorText = "";
    errorAction = null;
    await persistEnvelope();
    render();
    await resolvePendingChoice(eventId, choiceId, tx);
  } catch (error) {
    await recoverPendingChoice(eventId, choiceId, tx, error);
  } finally { busy = false; }
}
async function resumePendingAction() {
  const action = currentPresentation().pendingAction;
  if (!action) return;
  if (action.actionId === "r6_timed_choice") {
    const pending = runtimeState().world.r6PendingTimedChoices?.find((row) => row.transactionId === action.transactionId);
    if (!pending || pending.status === "needs_reconciliation") throw new Error("saved_timed_choice_reconciliation_required");
    action.eventId ||= pending.eventId;
    action.choiceId ||= pending.choiceId;
    action.durationTicks = pending.durationTicks;
    action.startedAtTick = pending.startedAtTick;
    action.targetAtTick = pending.targetAtTick;
    action.status = "in_flight";
    return;
  }
  if (action.actionId === "r4_action_travel") {
    const flight = runtimeState().inFlightTransaction;
    if (flight?.transactionId === action.transactionId) {
      currentPresentation().pendingAction.status = "in_flight";
      await persistEnvelope();
      return;
    }
    const destinationId = currentPresentation().selectedChoiceId;
    if (action.status === "submitting" && destinationId) return dispatchTravel(destinationId, action.transactionId, action.mode || "carriage");
    throw new Error("saved_travel_transaction_missing");
  }
  if (action.actionId === "r4_action_recover" || action.actionId === "r4_action_social") {
    const flight = runtimeState().inFlightTransaction;
    if (flight?.actionId === action.actionId) {
      action.transactionId = flight.transactionId;
      if (action.status !== "awaiting_interruption_decision") action.status = "in_flight";
      await persistEnvelope();
      return;
    }
    if (action.status === "submitting") return dispatchTimedAction(action.actionId, {}, action.operationId);
    throw new Error("saved_action_transaction_missing");
  }
  if (action.actionId === "r6_stranded_return") {
    const flight = runtimeState().inFlightTransaction;
    if (flight?.actionId === action.actionId) {
      action.transactionId = flight.transactionId;
      if (action.status !== "awaiting_interruption_decision") action.status = "in_flight";
      await persistEnvelope();
      return;
    }
    if (action.status === "submitting") return dispatchTimedAction(action.actionId, {}, action.operationId);
    throw new Error("saved_stranded_return_transaction_missing");
  }
  if (action.actionId === "r4_action_alchemy") {
    const craft = runtimeState().world.pendingRealmCraft;
    const flight = runtimeState().inFlightTransaction;
    if (flight?.actionId === "r4_action_alchemy" && (!craft || flight.transactionId === craft.actionTransactionId)) {
      if (craft) {
        action.transactionId = craft.transactionId;
        currentPresentation().selectedChoiceId = craft.choiceId;
        currentPresentation().dialogueRef = referenceFor(craft.eventId, "choices");
      } else action.transactionId = flight.transactionId;
      action.status = "in_flight";
      await persistEnvelope();
      return;
    }
    if (action.status === "submitting" && !flight) return dispatchTimedAction("r4_action_alchemy", {}, action.operationId);
    throw new Error("saved_alchemy_transaction_missing");
  }
  if (action.actionId === "r6_action_alchemy_portable") {
    const flight = runtimeState().inFlightTransaction;
    if (flight?.actionId === action.actionId) {
      action.transactionId = flight.transactionId;
      action.status = "in_flight";
      await persistEnvelope();
      return;
    }
    if (action.status === "submitting" && runtimeState().suspendedTransactions?.some((tx) => tx.transactionId === action.operationId)) {
      action.status = "in_flight";
      await persistEnvelope();
      return;
    }
    throw new Error("saved_portable_alchemy_transaction_missing");
  }
  if (action.actionId === "r4_action_practice") {
    const flight = runtimeState().inFlightTransaction;
    if (flight?.actionId === action.actionId) {
      action.transactionId = flight.transactionId;
      action.status = "in_flight";
      await persistEnvelope();
      return;
    }
    throw new Error("saved_waystop_practice_missing");
  }
  return resolvePendingChoice(action.actionId, currentPresentation().selectedChoiceId, action.transactionId);
}
async function beginTravel(destinationId, mode = "carriage") {
  if (busy) return;
  const state = runtimeState();
  const route = pack.runtimeSources.worldInitialization.routes.find((row) => row.from === state.character.location && row.to === destinationId && state.character.knownLocations?.includes(destinationId));
  if (!route || (mode === "carriage" && Number(state.character.cashWen) < Number(route.wealth))) { errorText = "路线或路费条件已变化，未出发。"; render(); return; }
  busy = true;
  errorText = "";
  errorAction = null;
  const tx = `${state.worldId}-action-${Number(state.operationSequence || 0) + 1}`;
  try {
    const presentation = currentPresentation();
    presentation.pendingAction = { operationId: tx, actionId: "r4_action_travel", transactionId: tx, destinationId, mode, status: "submitting" };
    presentation.selectedChoiceId = destinationId;
    presentation.dialogueRef = { eventId: "r4_action_travel", instanceId: eventInstanceId("r4_action_travel"), lineId: "travel", speakerId: null, sourceRefs: [] };
    await persistEnvelope();
    render();
    await dispatchTravel(destinationId, tx, mode);
  } catch (error) { errorText = safeError(error, "这趟路暂未启程；原有行程记录仍在。请重新查看路线。"); errorAction = error?.message === "r6_save_conflict" ? { label: "刷新并读取最新记录", run: () => location.reload() } : null; render(); }
  finally { busy = false; }
}
async function dispatchTravel(destinationId, tx, mode = "carriage") {
  const result = engine.performWorldAction("r4_action_travel", { destination: destinationId, mode });
  const actual = runtimeState().inFlightTransaction;
  if (actual?.transactionId !== tx) throw new Error(`travel_transaction_identity_mismatch:${tx}:${actual?.transactionId || result?.transaction?.transactionId || result?.kind}`);
  if (result?.kind === "result" && runtimeState().character.location === destinationId) return finishTravel(destinationId);
  if (result?.kind !== "progress") throw new Error(`travel_not_started:${result?.error || result?.reason || result?.kind}`);
  const progress = engine.continueWorldAction(Math.max(1, Number(actual.targetDay) - Number(runtimeState().worldDay)));
  if (runtimeState().character.location === destinationId) return finishTravel(destinationId);
  currentPresentation().pendingAction.status = "in_flight";
  await persistEnvelope();
  render();
}
async function continueTravel() {
  if (busy) return;
  busy = true;
  errorText = "";
  errorAction = null;
  try {
    const action = currentPresentation().pendingAction;
    if (!action || action.actionId !== "r4_action_travel") return;
    const destinationId = action.destinationId || currentPresentation().selectedChoiceId;
    if (!destinationId) throw new Error("saved_travel_destination_missing");
    if (runtimeState().character.location === destinationId) return await finishTravel(destinationId);
    let flight = runtimeState().inFlightTransaction;
    if (flight?.transactionId !== action.transactionId) throw new Error("active_travel_transaction_mismatch");
    if (flight.pauseReason === "r6_waystop_decision") engine.resumeTravelFromWaystop();
    if (flight.pauseReason === "r6_flood_resume") { engine.resumeFloodRoute(); flight = runtimeState().inFlightTransaction; }
    const result = engine.continueWorldAction(Math.max(1, Number(flight.targetDay) - Number(runtimeState().worldDay)));
    const updated = runtimeState().inFlightTransaction;
    if (runtimeState().character.location === destinationId) return await finishTravel(destinationId);
    if (result?.kind === "progress" && updated?.transactionId === action.transactionId) {
      await persistEnvelope();
      render();
      return;
    }
    if (result?.kind !== "result" || runtimeState().character.location !== destinationId) throw new Error(result?.error || "travel_not_authoritatively_completed");
    await finishTravel(destinationId);
  } catch (error) {
    const destinationId = currentPresentation().selectedChoiceId;
    if (destinationId && runtimeState().character.location === destinationId) {
      errorText = "你已抵达；请确认落脚，行程与路费不会再次结算。";
      errorAction = { label: "确认抵达", run: () => finishTravel(destinationId).catch((saveError) => renderRecoverableError(safeError(saveError, "抵达已记下，画面暂未保存；可以重试。"), "重试保存", retryEnvelopeSave)) };
    } else {
      errorText = safeError(error, "这趟路暂未继续；行程记录仍在，可以再试一次。");
      errorAction = null;
    }
    render();
  }
  finally { busy = false; }
}
async function beginMidtripPractice(skillId) {
  if (busy) return;
  busy = true;
  try {
    const travel = runtimeState().inFlightTransaction;
    if (!travel || travel.pauseReason !== "r6_waystop_decision") throw new Error("registered_waystop_pause_required");
    currentPresentation().pendingAction = { operationId: travel.transactionId, actionId: "r4_action_practice", transactionId: travel.transactionId, status: "submitting", skillId, resumedTravelId: travel.transactionId };
    currentPresentation().dialogueRef = { eventId: "r4_action_practice", instanceId: eventInstanceId("r4_action_practice"), lineId: "action", speakerId: null, sourceRefs: ["r6_site_mirror_post"] };
    await persistEnvelope();
    const result = engine.beginTravelPractice(skillId);
    if (result?.kind !== "progress") throw new Error(result?.error || "waystop_practice_not_started");
    const practice = runtimeState().inFlightTransaction;
    currentPresentation().pendingAction.transactionId = practice.transactionId;
    currentPresentation().pendingAction.status = "in_flight";
    await persistEnvelope();
    render();
  } catch (error) {
    const activeTrip = runtimeState().inFlightTransaction;
    if (activeTrip?.actionId === "r4_action_travel") {
      currentPresentation().pendingAction = { operationId: activeTrip.transactionId, actionId: "r4_action_travel", transactionId: activeTrip.transactionId, destinationId: activeTrip.completion?.destination, mode: activeTrip.completion?.mode, status: "in_flight" };
    }
    errorText = safeError(error, "驿亭修行条件有变，未开始；原行程仍在。");
    await persistEnvelope();
    render();
  } finally { busy = false; }
}
async function beginMidtripPortableAlchemy() {
  if (busy) return;
  busy = true;
  try {
    const travel = runtimeState().inFlightTransaction;
    if (!travel || travel.pauseReason !== "r6_waystop_decision") throw new Error("registered_waystop_pause_required");
    currentPresentation().pendingAction = { operationId: travel.transactionId, actionId: "r6_action_alchemy_portable", transactionId: travel.transactionId, status: "submitting", resumedTravelId: travel.transactionId };
    currentPresentation().dialogueRef = { eventId: "r6_action_alchemy_portable", instanceId: eventInstanceId("r6_action_alchemy_portable"), lineId: "action", speakerId: null, sourceRefs: ["r6_site_mirror_post"] };
    await persistEnvelope();
    const result = engine.beginTravelPortableAlchemy();
    if (result?.kind !== "progress") throw new Error(result?.error || "portable_alchemy_not_started");
    const tx = runtimeState().inFlightTransaction;
    currentPresentation().pendingAction.transactionId = tx.transactionId;
    currentPresentation().pendingAction.status = "in_flight";
    await persistEnvelope();
    render();
  } catch (error) {
    const activeTrip = runtimeState().inFlightTransaction;
    if (activeTrip?.actionId === "r4_action_travel") currentPresentation().pendingAction = { operationId: activeTrip.transactionId, actionId: "r4_action_travel", transactionId: activeTrip.transactionId, destinationId: activeTrip.completion?.destination, mode: activeTrip.completion?.mode, status: "in_flight" };
    qaLastActionError = qaActionDiagnostics ? { actionId: "r6_action_alchemy_portable", error: String(error?.message || error) } : null;
    errorText = safeError(error, "行炉炼药条件不足，原行程仍会保留。");
    await persistEnvelope();
    render();
  } finally { busy = false; }
}
async function finishTravel(destinationId) {
  if (runtimeState().character.location !== destinationId) throw new Error("travel_destination_not_committed");
  const presentation = currentPresentation();
  presentation.sceneLocationId = destinationId;
  presentation.sceneInstanceId = `${runtimeState().worldId}:${runtimeState().character.lifeIndex}:${destinationId}`;
  presentation.pendingAction = null;
  presentation.pendingResult = null;
  presentation.selectedChoiceId = null;
  presentation.dialogueRef = { eventId: "r4_action_travel", instanceId: eventInstanceId("r4_action_travel"), lineId: "arrival", speakerId: null, sourceRefs: [] };
  presentation.scrollAnchor = "r6-scene-hotspot";
  errorText = "";
  errorAction = null;
  await persistEnvelope();
  render();
}
async function commitChoiceResult(eventId, choiceId, tx, rawResult) {
  const result = rawResult?.kind === "duplicate_suppressed" ? matchingCommittedChoice(eventId, choiceId, tx) : rawResult;
  if (result?.kind !== "result") throw new Error(result?.error || result?.reason || result?.kind || "runtime_choice_not_committed");
  const event = engine.eventView(eventId);
  const eventDefinition = eventDefinitions.get(eventId);
  const option = eventDefinition?.options?.find((row) => row.id === choiceId)
    || engine.eventView(eventId)?.options?.find((row) => row.id === choiceId);
  const outcomeId = option?.outcomeIds?.[result.outcome];
  if (!outcomeId) throw new Error("runtime_outcome_reference_missing");
  const presentation = currentPresentation();
  const viewId = eventInstanceId(eventId);
  const causeId = result.causeLogEntry?.cause || result.causeLogEntry?.id;
  presentation.eventInstanceRef = {
    eventId, instanceId: viewId, causeId,
    locationId: runtimeState().character.location,
    status: "committed", sourceRefs: [...(event?.sourceRefs || [])]
  };
  presentation.dialogueRef = { eventId, instanceId: viewId, lineId: "runtime-result", speakerId: null, sourceRefs: [...(event?.sourceRefs || [])] };
  presentation.selectedChoiceId = choiceId;
  presentation.dialogueCursor = 0;
  presentation.scrollAnchor = "r6-scene-result";
  presentation.viewportAnchorId = "r6-scene-result";
  presentation.viewportOffsetTop = 0;
  presentation.focusId = null;
  const timedAction = presentation.pendingAction?.actionId === "r6_timed_choice" && presentation.pendingAction.transactionId === tx
    ? presentation.pendingAction : null;
  presentation.pendingAction = null;
  presentation.pendingResult = {
    resultId: `${viewId}:${outcomeId}:${tx}`,
    eventId, instanceId: viewId, outcomeId, transactionId: tx,
    ...(timedAction ? { durationTicks: timedAction.durationTicks, startedAtTick: timedAction.startedAtTick, targetAtTick: timedAction.targetAtTick } : {}),
    runtimeReceiptKey: runtimeResultReceiptKey(runtimeState()), readState: "unread"
  };
  syncReturnTarget();
  await persistEnvelope();
  render();
}
async function acknowledgeResult() {
  if (busy || currentPresentation().pendingResult?.readState !== "unread") return;
  busy = true;
  try {
    await commitRuntimeResultAcknowledgement({
      engine,
      envelope,
      matchesRuntimeResult: presentationMatchesRuntimeResult,
      persist: persistEnvelope,
      mutatePresentation: () => {
    currentPresentation().selectedChoiceId = null;
    currentPresentation().dialogueCursor = 0;
    currentPresentation().scrollAnchor = "r6-scene-hotspot";
    currentPresentation().viewportAnchorId = "r6-location-label";
    currentPresentation().viewportOffsetTop = shell.location.getBoundingClientRect().top;
    currentPresentation().focusId = "r6-tool-life-record";
    const resumedTravel = runtimeState().inFlightTransaction;
    if (resumedTravel?.actionId === "r4_action_travel") {
      currentPresentation().pendingAction = { operationId: resumedTravel.transactionId, actionId: "r4_action_travel", transactionId: resumedTravel.transactionId, status: "in_flight" };
      currentPresentation().selectedChoiceId = resumedTravel.completion?.destination || null;
      currentPresentation().dialogueRef = { eventId: "r4_action_travel", instanceId: eventInstanceId("r4_action_travel"), lineId: "travel", speakerId: null, sourceRefs: [] };
    } else if (["r4_action_recover", "r4_action_social", "r6_stranded_return"].includes(resumedTravel?.actionId)) {
      const requiresDecision = ["r4_action_recover", "r6_stranded_return"].includes(resumedTravel.actionId);
      currentPresentation().pendingAction = {
        operationId: resumedTravel.transactionId, actionId: resumedTravel.actionId, transactionId: resumedTravel.transactionId,
        status: requiresDecision ? "awaiting_interruption_decision" : "in_flight",
        ...(requiresDecision ? {
          awaitingInterruptionDecision: true,
          interruptionRef: currentPresentation().pendingResult.eventId,
          optionId: resumedTravel.actionId === "r6_stranded_return" ? "R6-STRANDED-RETURN-ONCE" : resumedTravel.completion?.medicated ? "R6-REST-10D-MEDICATED" : "R6-REST-7D-PLAIN",
          durationDays: resumedTravel.durationDays,
          daysDone: Math.max(0, Number(runtimeState().worldDay) - Number(resumedTravel.startedDay))
        } : {})
      };
      currentPresentation().dialogueRef = { eventId: resumedTravel.actionId, instanceId: eventInstanceId(resumedTravel.actionId), lineId: "action", speakerId: null, sourceRefs: [] };
    } else if (resumedTravel?.actionId === "r4_action_alchemy" && runtimeState().world.pendingRealmCraft) {
      const craft = runtimeState().world.pendingRealmCraft;
      currentPresentation().pendingAction = { operationId: craft.transactionId, actionId: "r4_action_alchemy", transactionId: craft.transactionId, status: "in_flight" };
      currentPresentation().selectedChoiceId = craft.choiceId;
      currentPresentation().dialogueRef = referenceFor(craft.eventId, "choices");
    } else if (runtimeState().world.r6PendingTimedChoices?.length) {
      const timed = runtimeState().world.r6PendingTimedChoices.at(-1);
      currentPresentation().pendingAction = { operationId: timed.transactionId, actionId: "r6_timed_choice", transactionId: timed.transactionId, eventId: timed.eventId, choiceId: timed.choiceId, status: "in_flight", pauseEventId: timed.pauseEventId || null };
      currentPresentation().dialogueRef = referenceFor(timed.eventId, "choices");
    }
    syncReturnTarget();
      }
    });
    render();
  } catch (error) {
    syncReturnTarget();
    errorText = safeError(error, "这段经历还没记为已读；原记录仍在，请稍后重试。");
    errorAction = error?.message === "r6_save_conflict" ? { label: "刷新并读取最新记录", run: () => location.reload() } : null;
    render();
  }
  finally { busy = false; }
}
async function openOverlay(type) {
  if (busy) return;
  busy = true;
  const presentation = currentPresentation();
  if (!presentation.viewportAnchorId) presentation.scrollAnchor = presentation.pendingResult?.readState === "unread" ? "r6-scene-result" : "r6-scene-hotspot";
  const returnTarget = makeReturnTarget(presentation);
  presentation.returnTarget = clone(returnTarget);
  presentation.overlayStack.push({ type, returnTarget: clone(returnTarget) });
  try { await persistEnvelope(); render(); }
  catch (error) { presentation.overlayStack.pop(); errorText = safeError(error, "查看内容未能记下；原有记录仍在。"); errorAction = error?.message === "r6_save_conflict" ? { label: "刷新并读取最新记录", run: () => location.reload() } : null; render(); }
  finally { busy = false; }
}
async function closeOverlay() {
  if (busy) return;
  const presentation = currentPresentation();
  const frame = presentation.overlayStack.pop();
  if (frame?.returnTarget) {
    const target = frame.returnTarget;
    presentation.sceneLocationId = target.sceneLocationId;
    presentation.sceneInstanceId = target.sceneInstanceId;
    presentation.dialogueRef = clone(target.dialogueRef);
    presentation.dialogueCursor = target.dialogueCursor;
    presentation.selectedChoiceId = target.selectedChoiceId;
    presentation.scrollAnchor = target.scrollAnchor;
    presentation.viewportAnchorId = target.viewportAnchorId || target.scrollAnchor;
    presentation.viewportOffsetTop = target.viewportOffsetTop;
    presentation.focusId = target.focusId;
    presentation.pendingResult = clone(target.pendingResult);
  }
  syncReturnTarget();
  try { await persistEnvelope(); render(); }
  catch (error) { errorText = safeError(error, "返回状态暂未记下；原有记录仍在。"); errorAction = error?.message === "r6_save_conflict" ? { label: "刷新并读取最新记录", run: () => location.reload() } : null; render(); }
  restoreViewContext();
}
function renderOverlay() {
  shell.overlays.replaceChildren();
  const presentation = currentPresentation();
  const frame = presentation?.overlayStack?.at(-1);
  if (!frame) return;
  const backdrop = element("div", "r6-overlay-backdrop");
  backdrop.dataset.node = "r6_view_overlay";
  const panel = element("section", "r6-overlay");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  const state = runtimeState();
  if (frame.type === "this_life") {
    panel.dataset.node = "r6_character_attributes";
    const view = snapshot();
    const daysPerYear = Number(pack.r5ProgressionRules?.daysPerYear);
    const ageDays = Number(state.character.ageDays);
    const age = Number.isSafeInteger(ageDays) && Number.isFinite(daysPerYear) && daysPerYear > 0
      ? `${Math.floor(ageDays / daysPerYear)} 岁` : "尚无记录";
    panel.append(element("h2", "", "人物·属性"));
    panel.append(element("h3", "r6-attribute-heading", "今世状态"));
    panel.append(element("p", "r6-copy", `今世：第 ${attributeValue(state.character.lifeIndex)} 世 · 年龄：${age}`));
    panel.append(element("p", "r6-copy", `境界：${view.r5?.currentStage?.name || "尚无记录"} · 修为：${attributeValue(state.character.power)}`));
    panel.append(element("p", "r6-copy", `身况值：${attributeValue(state.character.health)} · 钱袋：${formatWenFromLegacy(state.character.cashWen)}`));
    panel.append(element("p", "r6-copy", `所在：${locationName(state.character.location)}`));
    panel.append(element("h3", "r6-attribute-heading", "资质（当前累计记录）"));
    for (const [key, label] of DIMENSION_LABELS) {
      panel.append(element("p", "r6-copy", `${label}：${attributeValue(state.character.r5DimensionLevels?.[key])}`));
    }
    panel.append(element("h3", "r6-attribute-heading", "本世道业"));
    const skills = Array.isArray(view.r5?.skills) ? view.r5.skills.filter((row) => row.lifeIndex === state.character.lifeIndex) : [];
    if (!skills.length) panel.append(element("p", "r6-copy", "尚无本世已记录的道业。"));
    for (const skill of skills) {
      const mastery = milliValue(skill.masteryMilli);
      const understanding = milliValue(skill.understandingMilli);
      const proficiency = skill.skillId === "r4_skill_dao02"
        ? state.character.proficiency?.[skill.skillId] ?? state.character.skillRecords?.[skill.skillId]?.proficiency
        : null;
      const progress = [`修习 ${mastery}`, `参悟 ${understanding}`];
      if (proficiency !== null && proficiency !== undefined && proficiency !== "") progress.push(`熟练 ${attributeValue(proficiency)}`);
      const row = element("p", "r6-copy r6-attribute-skill", `${skillName(skill)}：${progress.join(" · ")}`);
      row.dataset.skillId = skill.skillId;
      panel.append(row);
    }
    const lifespan = knownLifespan(state);
    const lifespanRow = element("p", "r6-copy", `寿限：${lifespan.text}`);
    lifespanRow.dataset.attribute = "lifespan";
    lifespanRow.dataset.reliability = lifespan.reliability;
    if (lifespan.sourceId) lifespanRow.dataset.sourceId = lifespan.sourceId;
    panel.append(element("h3", "r6-attribute-heading", "寿限线索"), lifespanRow);
    panel.append(element("p", "r6-copy", `星芒草 ${itemCount(state, "r4_item_stargrass")} · 星芒止血散 ${itemCount(state, "r4_item_powder")} · 星芒止血散方 ${itemCount(state, "r4_item_powder_recipe")}`));
    const { permit, valid, remaining } = currentFurnacePermit(state);
    panel.append(element("p", "r6-copy", `药炉使用许可：${permit ? (valid ? `此处有效，余 ${remaining} 日` : "过期或地点不符") : "未取得"}`));
  } else if (frame.type === "intro") {
    panel.append(element("h2", "", "青墟界"));
    panel.append(element("p", "r6-copy", "草木随时令生长，炉火有炉火的规矩，走一段远路也要花去时日。你来到这一世，眼前没有替你写好的唯一去处。"));
    panel.append(element("p", "r6-copy", "手边有营生，便从眼下做得成的事开始；身上有药草，可以打听它的用处和去处；想学丹术或修行，就循着师承、材料与眼前的条件慢慢来。钱袋见底时，先看看附近有没有可做的活计；身子乏了，也可以挑一段时日歇息整顿。"));
    panel.append(element("p", "r6-copy", "采药、炼药都只是路之一。你可以谋生、求学、修行、行路，也可以换个打算。先选一件此刻走得通的事，把日子过下去；往后如何，由你自己决定。"));
  } else {
    panel.append(element("h2", "", "行录"));
    panel.append(makeButton("重读此世开篇", () => openOverlay("intro"), "r6-button"));
    const result = state.lastResult;
    const event = result && eventDefinitions.get(result.eventId);
    const choice = event?.options?.find((row) => row.id === result.optionId);
    panel.append(element("p", "r6-copy", `这一生留下了 ${state.causeLog?.length || 0} 段因果。`));
    panel.append(element("p", "r6-copy", result ? `${eventTitle(result.eventId, event?.presentation?.title)}：${choice ? choiceLabel(result.eventId, choice, null) || "一次抉择" : "一次抉择"} · ${result.outcome === "success" ? "办妥了" : "未能办妥"}` : "尚未遇见值得记下的事。"));
  }
  panel.append(element("p", "r6-source", "翻看旧事，不会改变眼前境况。"));
  panel.append(makeButton("返回原处", closeOverlay, "r6-button primary"));
  backdrop.append(panel);
  shell.overlays.append(backdrop);
}
function render() {
  ensureShell();
  if (!engine || !envelope) return showLanding();
  buttonIdCounts = new Map();
  renderSceneContent();
  renderOverlay();
  restoreViewContext();
}
async function boot() {
  ensureShell();
  try {
    const stored = await storage.loadEnvelope(slotId);
    savedAt = stored?.savedAt ?? null;
    if (!stored) {
      const legacy = await storage.loadLegacyEnvelope(legacySlotId);
      return showLanding(null, legacy);
    }
    envelope = stored.envelope;
    engine = createRuntime();
    engine.restoreDto(envelope.r5Save);
    qaLastResumeSync = reconcilePendingRuntimeResult() ? { result: "reconciled" } : null;
    if (qaLastResumeSync) await persistEnvelope();
    render();
    requestAnimationFrame(() => {
      const anchor = currentPresentation().scrollAnchor && document.getElementById(currentPresentation().scrollAnchor);
      if (anchor) anchor.scrollIntoView({ block: "nearest" });
    });
    if (currentPresentation().pendingAction) await resumePendingAction();
  } catch (error) {
    errorText = "这段人生暂时没能接上，原存档仍保留。请重新读取，不要另开新局。";
    errorAction = { label: "重新读取这段人生", run: () => location.reload() };
    if (engine && envelope) render(); else showLanding();
  }
}

boot();
