import { createR5Runtime } from "../engine/r5-runtime.js";
import { R5LocalSaveStore } from "./r5-storage.js";
import { assetUrlFromManifest } from "./asset-paths.js";

const app = document.querySelector("#r6-app");
const storage = new R5LocalSaveStore();
const SAVE_SCHEMA = "R6-MOBILE-SAVE-1";
const VERSION = "今世";
const SCENE_ART_VERSION = "r6-slice-5";
const scriptUrl = new URL(import.meta.url);
const isPublishedMirror = /\/r6-demo\/app\/r6-main\.js$/.test(scriptUrl.pathname);
const publishedRoot = new URL("../", scriptUrl);
const sourceProjectRoot = new URL("../../", scriptUrl);
const [pack, definitions, seedConfig, contract] = await Promise.all([
  readJson("content/r5-world-pack-v1.json"),
  readJson("content/r5-event-definitions-v1.json"),
  readJson("content/r5-start-scenario-v1.json"),
  readJson("design/r6-mobile-interaction-contract-v1.json")
]);
const assetManifestUrl = isPublishedMirror
  ? new URL("ui/assets/asset-manifest.json", publishedRoot)
  : new URL("../../ui/assets/asset-manifest.json", scriptUrl);
const loadedAssets = await fetch(assetManifestUrl).then(async (response) => response.ok
  ? { manifest: await response.json(), manifestUrl: response.url || assetManifestUrl.href }
  : null).catch(() => null);
const herbAsset = loadedAssets?.manifest?.assets?.find((asset) => asset.asset_id === "icon_herb_bundle_512x512");
const herbImageUrl = herbAsset?.file ? assetUrlFromManifest(loadedAssets.manifestUrl, herbAsset.file) : null;
const slotId = `${pack.saveNamespace}:r6-mobile-active`;
const aliases = Object.fromEntries(contract.locationDisplayAliases.map((row) => [row.locationId, row.productionDisplayAlias]));
const eventDefinitions = new Map(definitions.events.map((event) => [event.id, event]));
let engine = null;
let envelope = null;
let savedAt = null;
let busy = false;
let errorText = "";
let errorAction = null;
let shell = null;
let sceneImageAttempt = 0;

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
  node.addEventListener("click", action);
  return node;
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
  if (code === "furnace_permit_invalid_here") return "炉权已过期或不属于此处，尚不能开炉。";
  if (code === "current_furnace_lease_or_permission_required") return "眼下没有有效炉权；请查看炉巷可用的正式许可来源。";
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
function makeReturnTarget(presentation) {
  return {
    sceneLocationId: presentation.sceneLocationId,
    sceneInstanceId: presentation.sceneInstanceId,
    dialogueRef: clone(presentation.dialogueRef),
    dialogueCursor: presentation.dialogueCursor,
    selectedChoiceId: presentation.selectedChoiceId,
    scrollAnchor: presentation.scrollAnchor,
    pendingResult: clone(presentation.pendingResult)
  };
}
function syncReturnTarget() {
  const presentation = currentPresentation();
  if (presentation) presentation.returnTarget = makeReturnTarget(presentation);
}
async function persistEnvelope() {
  if (!engine || !envelope) return;
  envelope.r5Save = engine.toSaveDto();
  syncReturnTarget();
  const saved = await storage.saveEnvelope(slotId, envelope, { expectedSavedAt: savedAt });
  savedAt = saved.savedAt;
  shell.status.textContent = "存档：已保存";
}
function createRuntime() {
  return createR5Runtime({ pack, definitions, seedConfig });
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
    pendingResult: null
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
  const statusAge = element("span");
  const statusStage = element("span");
  const statusHealth = element("span");
  const saveStatus = element("span", "r6-save-status", "存档：尚未保存");
  status.append(statusAge, statusStage, statusHealth, saveStatus);
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
  event.dataset.node = "r6_scene_event";
  const result = element("section", "r6-section");
  result.dataset.node = "r6_scene_result";
  const activity = element("section", "r6-section");
  activity.dataset.node = "r6_scene_hotspot";
  const tools = element("nav", "r6-tools");
  tools.setAttribute("aria-label", "只读查看");
  const overlays = element("div");
  overlays.id = "r6-overlays";
  const error = element("div", "r6-error");
  error.setAttribute("role", "alert");
  const inventory = element("section", "r6-section r6-inventory");
  inventory.dataset.node = "r6_inventory";
  page.append(brand, status, location, scene, event, result, activity, inventory, tools, error, overlays);
  app.replaceChildren(page);
  shell = { page, status: saveStatus, statusAge, statusStage, statusHealth, location, scene, sceneImage, sceneImageStatus, event, result, activity, inventory, tools, overlays, error };
  loadSceneImage();
}
function locationName(locationId) {
  const localNames = { r4_loc_furnace_lane: "炉巷", r4_loc_mirror_stage: "照影台", r4_loc_echo_pass: "回声关" };
  return aliases[locationId] || localNames[locationId] || "路上";
}
function showLanding(saved = null) {
  ensureShell();
  shell.location.textContent = "一处药户院落";
  shell.event.replaceChildren(element("h2", "", "一段新人生"));
  shell.event.append(element("p", "r6-copy", "从灰泉镇的药户人家开始，往后的日子会随着你的选择慢慢展开。"));
  shell.result.replaceChildren();
  shell.activity.replaceChildren(element("div", "r6-empty", "这一局的经历会留在此处，不会改动其他人生的记录。"));
  shell.tools.replaceChildren();
  if (saved) {
    shell.event.append(makeButton("继续这段人生", () => resumeSaved(), "r6-button primary"));
    shell.event.append(makeButton("另开一段新人生", () => startNewGame(true), "r6-button"));
  } else shell.event.append(makeButton("开始药户新局", () => startNewGame(false), "r6-button primary"));
  renderError();
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
    engine.initialize("herbal", `r6-player-${crypto.randomUUID()}`, `r6-world-${crypto.randomUUID()}`);
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
      const current = resource === "wealth" ? Number(state.character.wealth || 0)
        : resource === "demandInstance.materials" ? Number(state.world.demandInstance?.materials ?? state.demandInstance?.materials ?? 0)
          : resource.startsWith("r4_item_") ? Number(state.character.inventory?.[resource] || 0) : 0;
      if (current < Number(amount)) {
        const name = resource === "r4_item_powder" ? "星芒止血散" : resource === "r4_item_stargrass" ? "星芒草" : resource === "wealth" ? "家资" : resource === "demandInstance.materials" ? "可交付物料" : "所需物资";
        missing.push(`还缺 ${Number(amount) - current} 份${name}`);
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
      if (!permit) missing.push("尚未取得炉权");
      else if (!valid) missing.push("炉权已过期或不属于此处");
      if (state.character.location !== "r4_loc_furnace_lane") missing.push("须在炉巷持有效炉权");
      if (itemCount(state, "r4_item_stargrass") < 2) missing.push(`还缺 ${2 - itemCount(state, "r4_item_stargrass")} 份星芒草`);
      if (Number(state.character.wealth || 0) < 1) missing.push("还缺 1 份家资");
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
  const until = Number(permit.issuedDay) + Number(permit.validDays);
  const dayValid = permit.status === "valid" && Number.isSafeInteger(until) && Number(state.worldDay) <= until;
  const valid = dayValid && permit.location === state.character.location;
  return { permit, valid, dayValid, remaining: dayValid ? Math.max(0, until - Number(state.worldDay)) : 0 };
}
function alchemyReadiness(state = runtimeState()) {
  const { permit, valid, dayValid } = currentFurnacePermit(state);
  const skillId = "r4_skill_dao02";
  const learned = state.character.learnedSkills?.includes(skillId) === true
    && state.character.skillRecords?.[skillId]?.lifeIndex === state.character.lifeIndex;
  const stage = Number(state.character.skills?.[skillId]?.stage || 0);
  const proficiency = Number(state.character.proficiency?.[skillId] || state.character.skillRecords?.[skillId]?.proficiency || 0);
  const costs = pack.actions.r4_action_alchemy.reservedCost || {};
  const missing = [];
  if (!learned || itemCount(state, "r4_item_powder_recipe") < 1) missing.push("先在炉巷取得本世丹术与星芒止血散方");
  if (stage < Number(pack.caps.dao02MinimumStage) || proficiency < Number(pack.caps.dao02MinimumProficiency)) missing.push("丹术阶位或熟练尚未达标");
  if (!permit) missing.push("尚未取得炉权");
  else if (!dayValid) missing.push("炉权已过期");
  else if (!valid) missing.push("须在炉巷持有效炉权");
  if (state.character.location !== "r4_loc_furnace_lane") missing.push("须在炉巷开炉");
  for (const [itemId, amount] of Object.entries(costs)) {
    const current = itemId === "wealth" ? Number(state.character.wealth || 0) : itemCount(state, itemId);
    if (current < Number(amount)) missing.push(`还缺 ${Number(amount) - current} 份${itemId === "wealth" ? "家资" : itemId === "r4_item_stargrass" ? "星芒草" : "所需物资"}`);
  }
  return { ready: missing.length === 0, missing, permit, permitValid: valid, learned, stage, proficiency, costs };
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
    `星芒止血散方：${itemCount(state, "r4_item_powder_recipe")} 份`
  ];
  shell.inventory.append(element("p", "r6-copy", rows.join("\n")));
  shell.inventory.append(element("p", "r6-copy", `丹术：${known ? `已学 · ${skill.stage || 0} 阶 · 熟练 ${proficiency}` : "尚未习得"}`));
  const courseKnowledge = state.character.knowledge?.course?.level || state.character.knowledge?.course;
  const trust = state.facts?.r4_fact_local_trust === "trusted" || state.character.localTrust === "trusted";
  shell.inventory.append(element("p", "r6-copy", `课程线索：${courseKnowledge === "heard" ? "已听闻" : courseKnowledge || "尚未听闻"} · 本地信任：${trust ? "已建立" : "尚未建立"}`));
  if (permit) shell.inventory.append(element("p", "r6-copy", !dayValid
    ? `炉权：已过期（原许可至第 ${Number(permit.issuedDay) + Number(permit.validDays)} 日）`
    : valid
      ? `炉权：此处有效 · 还余 ${remaining} 日（至第 ${Number(permit.issuedDay) + Number(permit.validDays)} 日）`
      : `炉权：仅限炉巷使用 · 还余 ${remaining} 日（至第 ${Number(permit.issuedDay) + Number(permit.validDays)} 日）`));
  else shell.inventory.append(element("p", "r6-copy", "炉权：尚未取得；可查看眼下开放的课程或炉巷服务。"));
  const alchemy = alchemyReadiness(state);
  if (alchemy.ready) shell.inventory.append(element("p", "r6-next", "下一步：可在炉巷按正式药方开炉；成败由运行时的原有概率决定。"));
  else if (known && itemCount(state, "r4_item_powder") > 0 && state.character.location === "r4_loc_ashspring") shell.inventory.append(element("p", "r6-next", "下一步：可选送一份星芒止血散，帮采药人一把；这不是主线必做。"));
  else if (known && permit && dayValid && !valid) shell.inventory.append(element("p", "r6-next", "下一步：循已知道路回到炉巷，在许可期限内开炉。"));
  else if (known && !dayValid) shell.inventory.append(element("p", "r6-next", state.character.location === "r4_loc_furnace_lane"
    ? "下一步：炉权已到期，可向炉主申请七日炉位；费用按正式条件核验。"
    : "下一步：循已知道路前往炉巷，问炉主申请七日炉位。"));
  else if (known && alchemy.missing.some((item) => item.includes("星芒草") || item.includes("家资"))) shell.inventory.append(element("p", "r6-next", `下一步：补齐${alchemy.missing.filter((item) => item.includes("星芒草") || item.includes("家资")).join("、")}后再开炉。`));
  else if (!known) shell.inventory.append(element("p", "r6-next", "下一步：留意可见的丹术课程来源；本地拜师还需满足运行时给出的信任条件。"));
}
function renderFurnaceAccessActions() {
  const state = runtimeState();
  const skillId = ["r4_skill_dao02", "r4_skill_dao01"].find((id) => state.character.learnedSkills?.includes(id)
    && state.character.skillRecords?.[id]?.lifeIndex === state.character.lifeIndex);
  const owner = state.world.npcRecords?.r4_npc_wen_repairer;
  const usableKiln = state.world.equipment?.["public-kiln"]?.status !== "out_of_service";
  const activeLease = (state.world.rentalLedger || []).find((row) => row.tenantId === state.character.id && row.locationId === state.character.location && row.status === "active");
  const { valid: permitValid } = currentFurnacePermit(state);
  if (!skillId || !owner?.alive || owner.locationId !== state.character.location || owner.onDuty !== true || !usableKiln) return;
  if (!activeLease && !permitValid) {
    shell.activity.append(element("p", "r6-copy", "炉巷炉主在场，且你已有本世丹术/炼器功法；可按正式条件申请七日炉位，费用由运行时核验。"));
    const button = makeButton("向炉主申请七日炉位 · 家资 1", () => beginTimedAction("r4_action_social", {
      personId: owner.id, targetId: owner.id, service: "request_furnace_rental", skillId
    }));
    button.disabled = Number(state.character.wealth || 0) < 1;
    shell.activity.append(button);
  } else {
    if (!activeLease) return;
    shell.activity.append(element("p", "r6-copy", `炉位租约：${activeLease.status} · 到期第 ${activeLease.dueDay} 日${activeLease.extensionOffer?.status === "preapproved" ? " · 炉主已签一次延期條件" : ""}`));
    if (activeLease.status === "active" && Number(activeLease.dueDay) <= Number(state.worldDay) && activeLease.extensionOffer?.status !== "preapproved") {
      shell.activity.append(makeButton("请炉主签署一次七日延期", () => beginTimedAction("r4_action_social", {
        personId: owner.id, targetId: owner.id, service: "request_furnace_lease_extension", leaseId: activeLease.leaseId
      })));
    }
  }
}
function pendingActionTitle(actionId, fallback) {
  const titles = { r4_action_travel: "行路途中", r4_action_recover: "休整恢复中", r4_action_alchemy: "炼制星芒止血散", r4_action_social: "炉巷服务办理中" };
  return titles[actionId] || eventTitle(actionId, fallback || "眼前的事");
}
function renderSceneContent() {
  const s = snapshot();
  const state = runtimeState();
  const presentation = currentPresentation();
  const ageDays = Math.max(0, Number(state.character.ageDays || 0));
  shell.statusAge.textContent = `今世 ${Math.floor(ageDays / 360)} 岁`;
  shell.statusStage.textContent = s.r5.currentStage?.name || "未修凡俗";
  shell.statusHealth.textContent = `身况 ${s.character.health}`;
  shell.location.textContent = locationName(state.character.location);
  shell.scene.dataset.location = state.character.location;
  shell.sceneImage.hidden = state.character.location !== "r4_loc_ashspring";
  shell.scene.setAttribute("aria-label", `${locationName(state.character.location)}场景`);
  shell.status.textContent = "存档：已保存";
  renderError();
  shell.result.replaceChildren();
  shell.event.replaceChildren();
  shell.activity.replaceChildren();
  shell.scene.querySelector(".hotspot")?.remove();
  const thisLifeButton = makeButton("此身", () => openOverlay("this_life"));
  thisLifeButton.id = "r6-tool-this-life";
  const recordButton = makeButton("行录", () => openOverlay("life_record"));
  recordButton.id = "r6-tool-life-record";
  shell.tools.replaceChildren(thisLifeButton, recordButton);
  renderInventoryCard();

  if (presentation.pendingAction) {
    const event = eventDefinitions.get(presentation.pendingAction.actionId);
    const action = presentation.pendingAction;
    shell.event.append(element("h2", "", pendingActionTitle(action.actionId, event?.presentation?.title)));
    if (action.actionId === "r4_action_travel") {
      const inFlight = state.inFlightTransaction;
      if (inFlight?.transactionId === action.transactionId && inFlight.pauseReason === "world_node_due" && inFlight.pauseEventId) {
        const pausedEventId = inFlight.pauseEventId;
        shell.event.append(element("p", "r6-copy", "途中遇到一桩急事，先作眼前选择；原行程会从暂停处接续。"));
        renderChoiceCard(pausedEventId, eventDefinitions.get(pausedEventId)?.presentation?.title || "途中来事", "处理完眼前这桩，再继续原来的路。", shell.event);
        return;
      }
      const remaining = Math.max(0, Number(inFlight?.targetDay || 0) - Number(state.worldDay || 0));
      shell.event.append(element("p", "r6-copy", remaining ? `还要走 ${remaining} 日。你仍在${locationName(presentation.sceneLocationId)}。` : "路途已尽，正准备落脚。"));
      shell.event.append(makeButton(remaining ? "继续行程 1 日" : "确认抵达", () => continueTravel(), "r6-button primary"));
    } else if (["r4_action_recover", "r4_action_alchemy"].includes(action.actionId)) {
      const flight = state.inFlightTransaction;
      if (flight?.pauseReason === "world_node_due" && flight.pauseEventId) {
        shell.event.append(element("p", "r6-copy", "做事途中遇到一桩急事；先处理眼前来事，原来的事情会从这里接着做。"));
        renderChoiceCard(flight.pauseEventId, eventDefinitions.get(flight.pauseEventId)?.presentation?.title || "途中来事", "先作眼前选择，之后再接续原来的事。", shell.event);
        return;
      }
      const remaining = Math.max(0, Number(flight?.targetDay || 0) - Number(state.worldDay || 0));
      shell.event.append(element("p", "r6-copy", action.actionId === "r4_action_alchemy"
        ? `炼药已按正式药方开始，已预扣材料；还需 ${remaining} 日。刷新页面后仍可接着做。`
        : `休整已开始，还需 ${remaining} 日。刷新页面后仍可接着做。`));
      shell.event.append(makeButton(remaining ? `继续${action.actionId === "r4_action_alchemy" ? "炼药" : "休整"} 1 日` : "查看结果", () => continueTimedAction(), "r6-button primary"));
    } else {
      shell.event.append(element("p", "r6-copy", "眼前这件事还没有落定。"));
      const pending = makeButton("正在处理…", () => {}, "r6-button primary");
      pending.disabled = true;
      shell.event.append(pending);
    }
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
    const costs = Object.entries(readiness.costs).map(([itemId, amount]) => `${amount}${itemId === "wealth" ? "家资" : itemId === "r4_item_stargrass" ? "份星芒草" : "份物资"}`).join(" + ");
    const success = Math.round(Number(pack.actions.r4_action_alchemy.successChance) * 100);
    shell.activity.append(element("h3", "", "炼制星芒止血散"));
    const craft = makeButton(`开始炼药 · ${pack.actions.r4_action_alchemy.days} 日 · 消耗 ${costs} · 成功率 ${success}%`, () => beginTimedAction("r4_action_alchemy"));
    craft.disabled = !readiness.ready;
    shell.activity.append(craft);
    if (!readiness.ready) shell.activity.append(element("p", "r6-option-note", readiness.missing.join("；")));
  }
  const recovery = Number(state.character.health || 0) < Number(state.character.maxHealth || 100);
  if (recovery) {
    shell.activity.append(element("h3", "", "休整恢复"));
    shell.activity.append(makeButton("休整 7 日", () => beginTimedAction("r4_action_recover"), "r6-button"));
  }
  if (state.character.location === "r4_loc_furnace_lane") renderFurnaceAccessActions();
  const routes = pack.runtimeSources.worldInitialization.routes.filter((route) => route.from === state.character.location && state.character.knownLocations?.includes(route.to));
  for (const route of routes) {
    const button = makeButton(`前往${locationName(route.to)} · ${route.days} 日 · 家资 ${route.wealth}`, () => beginTravel(route.to), "r6-button primary");
    button.disabled = Number(state.character.wealth) < Number(route.wealth);
    shell.activity.append(button);
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
function choiceLabel(eventId, option) {
  const natural = {
    "r4_birth_story:respond_to_neighbor": "应下邻里托付",
    "r4_birth_story:help_household": "帮家里料理一件日常事",
    "r4_birth_story:fulfill_early_duty": "把先前答应的事做完",
    "r4_ev_birth_herbal_roof:save_neighbor_batch": "先护住托管的药草",
    "r4_ev_birth_herbal_roof:save_household_batch": "先收好自家的药草",
    "r4_ev_birth_herbal_roof:repair_and_call_help": "先补好棚角，再请人搭把手",
    "r4_daily_entrust:accept_and_fulfill": "接下帮工，把这份活计做好",
    "r4_daily_entrust:accept_and_fail": "接下帮工，但这份活没能做完",
    "r4_daily_entrust:decline": "婉言谢绝",
    "r4_daily_herb:harvest_for_self": "采下一份星芒草 · 1 日",
    "r4_daily_herb:help_other_gatherer": "送一份星芒止血散，帮采药人一把 · 可选",
    "r4_daily_herb:leave_stock": "暂且留下药草",
    "r4_acq_dao02:accept_apprenticeship": "随炉主学丹术 · 7 日 · 取得药方与七日炉权",
    "r4_acq_dao02:buy_public_course": "缴家资修习公开课程 · 2 家资 · 7 日（另需取得炉权）",
    "r4_acq_dao02:decline": "暂不拜师",
    "r4_ev_realm_core_craft:finish_authorized_batch": "按授权药方炼制星芒止血散 · 3 日 · 80% 成功率",
    "r4_ev_realm_core_craft:log_variation": "暂停本批次并记录观测",
    "r4_ev_realm_core_craft:yield_to_repair": "让出炉位，避免设备损坏"
  };
  const text = natural[`${eventId}:${option.id}`] || option.text;
  return typeof text === "string" && text.trim() ? text.trim() : "";
}
function makeChoiceButton(eventId, option) {
  const label = choiceLabel(eventId, option);
  const canSelect = Boolean(label) && option.canAfford !== false;
  const button = makeButton(label || "此项暂不可选", () => submitChoice(eventId, option.id), "r6-button");
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
    r4_action_recover: "休整恢复",
    r4_action_alchemy: "炼制星芒止血散"
  };
  return titles[eventId] || (typeof fallback === "string" && fallback.trim() ? fallback : "眼前的事");
}
function renderPendingResult(pending) {
  const state = runtimeState();
  const result = state.lastResult;
  const event = eventDefinitions.get(pending.eventId);
  const option = event?.options?.find((row) => row.id === result?.optionId);
  const title = eventTitle(pending.eventId, event?.presentation?.title);
  shell.result.dataset.resultId = pending.resultId;
  shell.result.append(element("h2", "", title));
  shell.result.append(element("p", "r6-copy", option ? choiceLabel(pending.eventId, option) : "这段经历有了结果。"));
  const days = Number(result?.time?.durationDays || 0);
  const craftBatch = ["r4_action_alchemy", "r4_ev_realm_core_craft"].includes(pending.eventId)
    ? [...(state.world.craftBatchLedger || [])].reverse().find((row) => row.actorId === state.character.id && row.lifeIndex === state.character.lifeIndex && ["completed", "failed"].includes(row.status))
    : null;
  const succeeded = craftBatch ? craftBatch.status === "completed" : result?.outcome === "success";
  const place = locationName(state.character.location);
  const elapsed = days === 1 ? "一日" : `${days}日`;
  const prose = succeeded
    ? (days ? `事情办妥了，过了${elapsed}。你现在在${place}。` : "这份心意留在今世，光阴未动。")
    : (days ? `事情没能如愿，过了${elapsed}。你现在在${place}。` : "这件事没能如愿，眼下光阴未动。");
  shell.result.append(element("p", "r6-copy", prose));
  if (pending.eventId === "r4_action_recover" && typeof result?.resultText === "string") {
    shell.result.append(element("p", "r6-copy", result.resultText));
  }
  if (["r4_action_alchemy", "r4_ev_realm_core_craft"].includes(pending.eventId)) {
    if (craftBatch) shell.result.append(element("p", "r6-copy", craftBatch.status === "completed"
      ? `本批炼制成功，星芒止血散已入囊；当前持有 ${itemCount(state, "r4_item_powder")} 份。`
      : "本批炼制未成；已预扣的星芒草与家资不返还，未获得成药。"));
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
    const result = raw?.kind === "duplicate_suppressed" ? matchingCommittedChoice(eventId, choiceId, tx) : raw;
    if (!result) return recoverPendingChoice(eventId, choiceId, tx, "choice_receipt_unavailable");
    await commitChoiceResult(eventId, choiceId, tx, result);
  } catch (error) {
    await recoverPendingChoice(eventId, choiceId, tx, error);
  }
}
async function finishStandaloneAction(actionId, tx, result) {
  if (result?.kind !== "result") throw new Error(result?.error || result?.reason || result?.kind || "action_not_completed");
  const presentation = currentPresentation();
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
    transactionId: tx, readState: "unread"
  };
  presentation.scrollAnchor = "r6-scene-result";
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
async function beginTimedAction(actionId, payload = {}) {
  if (busy || currentPresentation()?.pendingAction || currentPresentation()?.pendingResult?.readState === "unread") return;
  busy = true;
  const operationId = `${slotId}:${runtimeState().character.lifeIndex}:${crypto.randomUUID()}`;
  try {
    const presentation = currentPresentation();
    presentation.pendingAction = { operationId, actionId, transactionId: operationId, status: "submitting" };
    presentation.selectedChoiceId = null;
    presentation.dialogueRef = { eventId: actionId, instanceId: eventInstanceId(actionId), lineId: "action", speakerId: null, sourceRefs: [] };
    errorText = "";
    errorAction = null;
    await persistEnvelope();
    render();
    await dispatchTimedAction(actionId, payload, operationId);
  } catch (error) {
    restoreSavedRuntimeBeforeChoice();
    errorText = safeError(error, "这件事暂未开始；没有结算，请按眼下条件补齐后再试。 ");
    errorAction = null;
    try { await persistEnvelope(); render(); }
    catch (saveError) { renderRecoverableError(safeError(saveError, "状态没有保存好；原存档仍在。"), "重试保存", retryEnvelopeSave); }
  } finally { busy = false; }
}
async function continueTimedAction() {
  if (busy) return;
  const action = currentPresentation().pendingAction;
  if (!action || !["r4_action_recover", "r4_action_alchemy", "r4_action_social"].includes(action.actionId)) return;
  busy = true;
  try {
    const state = runtimeState();
    const craft = state.world.pendingRealmCraft;
    const expectedId = action.actionId === "r4_action_alchemy" && craft ? craft.actionTransactionId : action.transactionId;
    if (!expectedId || state.inFlightTransaction?.transactionId !== expectedId || state.inFlightTransaction?.actionId !== action.actionId) throw new Error("active_action_transaction_mismatch");
    const raw = engine.continueWorldAction(1);
    if (raw?.error) throw new Error(raw.error);
    if (raw?.kind === "progress") {
      await persistEnvelope();
      render();
      return;
    }
    if (action.actionId === "r4_action_alchemy") {
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
  if (action.actionId === "r4_action_travel") {
    const flight = runtimeState().inFlightTransaction;
    if (flight?.transactionId === action.transactionId) {
      currentPresentation().pendingAction.status = "in_flight";
      await persistEnvelope();
      return;
    }
    const destinationId = currentPresentation().selectedChoiceId;
    if (action.status === "submitting" && destinationId) return dispatchTravel(destinationId, action.transactionId);
    throw new Error("saved_travel_transaction_missing");
  }
  if (action.actionId === "r4_action_recover" || action.actionId === "r4_action_social") {
    const flight = runtimeState().inFlightTransaction;
    if (flight?.actionId === action.actionId) {
      action.transactionId = flight.transactionId;
      action.status = "in_flight";
      await persistEnvelope();
      return;
    }
    if (action.status === "submitting") return dispatchTimedAction(action.actionId, {}, action.operationId);
    throw new Error("saved_action_transaction_missing");
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
  return resolvePendingChoice(action.actionId, currentPresentation().selectedChoiceId, action.transactionId);
}
async function beginTravel(destinationId) {
  if (busy) return;
  const state = runtimeState();
  const route = pack.runtimeSources.worldInitialization.routes.find((row) => row.from === state.character.location && row.to === destinationId && state.character.knownLocations?.includes(destinationId));
  if (!route || Number(state.character.wealth) < Number(route.wealth)) { errorText = "路线或路费条件已变化，未出发。"; render(); return; }
  busy = true;
  errorText = "";
  errorAction = null;
  const tx = `${state.worldId}-action-${Number(state.operationSequence || 0) + 1}`;
  try {
    const presentation = currentPresentation();
    presentation.pendingAction = { operationId: tx, actionId: "r4_action_travel", transactionId: tx, status: "submitting" };
    presentation.selectedChoiceId = destinationId;
    presentation.dialogueRef = { eventId: "r4_action_travel", instanceId: eventInstanceId("r4_action_travel"), lineId: "travel", speakerId: null, sourceRefs: [] };
    await persistEnvelope();
    render();
    await dispatchTravel(destinationId, tx);
  } catch (error) { errorText = safeError(error, "这趟路暂未启程；原有行程记录仍在。请重新查看路线。"); errorAction = error?.message === "r6_save_conflict" ? { label: "刷新并读取最新记录", run: () => location.reload() } : null; render(); }
  finally { busy = false; }
}
async function dispatchTravel(destinationId, tx) {
  const result = engine.performWorldAction("r4_action_travel", { destination: destinationId });
  const actual = runtimeState().inFlightTransaction;
  if (actual?.transactionId !== tx) throw new Error(`travel_transaction_identity_mismatch:${tx}:${actual?.transactionId || result?.transaction?.transactionId || result?.kind}`);
  if (result?.kind === "result" && runtimeState().character.location === destinationId) return finishTravel(destinationId);
  if (result?.kind !== "progress") throw new Error(`travel_not_started:${result?.error || result?.reason || result?.kind}`);
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
    const flight = runtimeState().inFlightTransaction;
    if (flight?.transactionId !== action.transactionId) throw new Error("active_travel_transaction_mismatch");
    const result = engine.continueWorldAction(1);
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
  const option = eventDefinition?.options?.find((row) => row.id === choiceId);
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
  presentation.pendingAction = null;
  presentation.pendingResult = {
    resultId: `${viewId}:${outcomeId}:${tx}`,
    eventId, instanceId: viewId, outcomeId, transactionId: tx, readState: "unread"
  };
  syncReturnTarget();
  await persistEnvelope();
  render();
}
async function acknowledgeResult() {
  if (busy || currentPresentation().pendingResult?.readState !== "unread") return;
  busy = true;
  try {
    currentPresentation().pendingResult.readState = "read";
    currentPresentation().selectedChoiceId = null;
    currentPresentation().dialogueCursor = 0;
    currentPresentation().scrollAnchor = "r6-scene-hotspot";
    const resumedTravel = runtimeState().inFlightTransaction;
    if (resumedTravel?.actionId === "r4_action_travel") {
      currentPresentation().pendingAction = { operationId: resumedTravel.transactionId, actionId: "r4_action_travel", transactionId: resumedTravel.transactionId, status: "in_flight" };
      currentPresentation().selectedChoiceId = resumedTravel.completion?.destination || null;
      currentPresentation().dialogueRef = { eventId: "r4_action_travel", instanceId: eventInstanceId("r4_action_travel"), lineId: "travel", speakerId: null, sourceRefs: [] };
    } else if (["r4_action_recover", "r4_action_social"].includes(resumedTravel?.actionId)) {
      currentPresentation().pendingAction = { operationId: resumedTravel.transactionId, actionId: resumedTravel.actionId, transactionId: resumedTravel.transactionId, status: "in_flight" };
      currentPresentation().dialogueRef = { eventId: resumedTravel.actionId, instanceId: eventInstanceId(resumedTravel.actionId), lineId: "action", speakerId: null, sourceRefs: [] };
    } else if (resumedTravel?.actionId === "r4_action_alchemy" && runtimeState().world.pendingRealmCraft) {
      const craft = runtimeState().world.pendingRealmCraft;
      currentPresentation().pendingAction = { operationId: craft.transactionId, actionId: "r4_action_alchemy", transactionId: craft.transactionId, status: "in_flight" };
      currentPresentation().selectedChoiceId = craft.choiceId;
      currentPresentation().dialogueRef = referenceFor(craft.eventId, "choices");
    }
    syncReturnTarget();
    await persistEnvelope();
    render();
  } catch (error) { errorText = safeError(error, "这段经历还没记为已读；原记录仍在，请稍后重试。"); errorAction = error?.message === "r6_save_conflict" ? { label: "刷新并读取最新记录", run: () => location.reload() } : null; render(); }
  finally { busy = false; }
}
async function openOverlay(type) {
  if (busy) return;
  busy = true;
  const presentation = currentPresentation();
  presentation.scrollAnchor = document.activeElement?.id || (presentation.pendingResult?.readState === "unread" ? "r6-scene-result" : "r6-scene-hotspot");
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
    presentation.pendingResult = clone(target.pendingResult);
  }
  syncReturnTarget();
  try { await persistEnvelope(); render(); }
  catch (error) { errorText = safeError(error, "返回状态暂未记下；原有记录仍在。"); errorAction = error?.message === "r6_save_conflict" ? { label: "刷新并读取最新记录", run: () => location.reload() } : null; render(); }
  requestAnimationFrame(() => {
    if (presentation.scrollAnchor && document.getElementById(presentation.scrollAnchor)) {
      const anchor = document.getElementById(presentation.scrollAnchor);
      anchor.scrollIntoView({ block: "nearest" });
      if (anchor.matches("button")) anchor.focus({ preventScroll: true });
    }
  });
}
function renderOverlay() {
  shell.overlays.replaceChildren();
  const presentation = currentPresentation();
  const frame = presentation?.overlayStack?.at(-1);
  if (!frame) return;
  const backdrop = element("div", "r6-overlay-backdrop");
  backdrop.dataset.node = "r6_view_overlay";
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) closeOverlay(); });
  const panel = element("section", "r6-overlay");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  const state = runtimeState();
  if (frame.type === "this_life") {
    panel.append(element("h2", "", "此身"));
    panel.append(element("p", "r6-copy", `今世第 ${state.character.lifeIndex} 世 · ${Math.floor(Number(state.character.ageDays || 0) / 360)} 岁`));
    panel.append(element("p", "r6-copy", `当前境界：${snapshot().r5.currentStage?.name || "未修凡俗"} · 身况：${state.character.health}`));
    panel.append(element("p", "r6-copy", `所在：${locationName(state.character.location)}`));
    panel.append(element("p", "r6-copy", `星芒草 ${itemCount(state, "r4_item_stargrass")} · 星芒止血散 ${itemCount(state, "r4_item_powder")} · 星芒止血散方 ${itemCount(state, "r4_item_powder_recipe")}`));
    const { permit, valid, remaining } = currentFurnacePermit(state);
    panel.append(element("p", "r6-copy", `炉权：${permit ? (valid ? `此处有效，余 ${remaining} 日` : "过期或地点不符") : "未取得"}`));
  } else {
    panel.append(element("h2", "", "行录"));
    const result = state.lastResult;
    const event = result && eventDefinitions.get(result.eventId);
    const choice = event?.options?.find((row) => row.id === result.optionId);
    panel.append(element("p", "r6-copy", `这一生留下了 ${state.causeLog?.length || 0} 段因果。`));
    panel.append(element("p", "r6-copy", result ? `${eventTitle(result.eventId, event?.presentation?.title)}：${choice ? choiceLabel(result.eventId, choice) || "一次抉择" : "一次抉择"} · ${result.outcome === "success" ? "办妥了" : "未能办妥"}` : "尚未遇见值得记下的事。"));
  }
  panel.append(element("p", "r6-source", "翻看旧事，不会改变眼前境况。"));
  panel.append(makeButton("返回原处", closeOverlay, "r6-button primary"));
  backdrop.append(panel);
  shell.overlays.append(backdrop);
}
function render() {
  ensureShell();
  if (!engine || !envelope) return showLanding();
  renderSceneContent();
  renderOverlay();
}
async function boot() {
  ensureShell();
  try {
    const stored = await storage.loadEnvelope(slotId);
    savedAt = stored?.savedAt ?? null;
    if (!stored) return showLanding();
    envelope = stored.envelope;
    engine = createRuntime();
    engine.restoreDto(envelope.r5Save);
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
