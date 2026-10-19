import { createR5Runtime } from "../engine/r5-runtime.js";
import { R5LocalSaveStore } from "./r5-storage.js";

const app = document.querySelector("#r6-app");
const storage = new R5LocalSaveStore();
const SAVE_SCHEMA = "R6-MOBILE-SAVE-1";
const VERSION = "R6 手机连续场景 · 测试版";
const SCENE_ART_VERSION = "r6-slice-3";
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
const slotId = `${pack.saveNamespace}:r6-mobile-active`;
const aliases = Object.fromEntries(contract.locationDisplayAliases.map((row) => [row.locationId, row.productionDisplayAlias]));
const eventDefinitions = new Map(definitions.events.map((event) => [event.id, event]));
let engine = null;
let envelope = null;
let savedAt = null;
let busy = false;
let errorText = "";
let shell = null;
let sceneImageAttempt = 0;

function setSceneImageState(state, message) {
  if (!shell) return;
  shell.scene.dataset.imageState = state;
  shell.sceneImage.dataset.state = state;
  shell.sceneImageStatus.hidden = state === "loaded";
  shell.sceneImageStatus.setAttribute("role", state === "failed" ? "alert" : "status");
  shell.sceneImageStatus.replaceChildren(element("span", "", message));
  if (state === "failed") shell.sceneImageStatus.append(makeButton("重试载入院落画面", loadSceneImage, "r6-button primary"));
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
    else setSceneImageState("failed", "画面暂未显出，可再试一次。");
  };
  image.onerror = () => { if (attempt === sceneImageAttempt) setSceneImageState("failed", "画面暂未显出，可再试一次。"); };
  image.src = imageUrl.href;
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
  node.addEventListener("click", action);
  return node;
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
  const error = element("p", "r6-error");
  error.setAttribute("role", "alert");
  page.append(brand, status, location, scene, event, result, activity, tools, error, overlays);
  app.replaceChildren(page);
  shell = { page, status: saveStatus, statusAge, statusStage, statusHealth, location, scene, sceneImage, sceneImageStatus, event, result, activity, tools, overlays, error };
  loadSceneImage();
}
function locationName(locationId) { return aliases[locationId] || locationId; }
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
  shell.error.textContent = errorText;
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
    render();
    await persistEnvelope();
    render();
  } catch (error) { errorText = `新局未保存：${error.message}`; showLanding(); }
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
    render();
    if (currentPresentation().pendingAction) await resumePendingAction();
  } catch (error) { errorText = `恢复未完成：${error.message}`; showLanding(); }
  finally { busy = false; }
}
function availableOptions(eventId) {
  if (!engine?.isEventAvailable(eventId)) return [];
  return (engine.eventView(eventId)?.options || []).filter((option) => option.available);
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
  shell.error.textContent = errorText;
  shell.result.replaceChildren();
  shell.event.replaceChildren();
  shell.activity.replaceChildren();
  shell.scene.querySelector(".hotspot")?.remove();
  const thisLifeButton = makeButton("此身", () => openOverlay("this_life"));
  thisLifeButton.id = "r6-tool-this-life";
  const recordButton = makeButton("行录", () => openOverlay("life_record"));
  recordButton.id = "r6-tool-life-record";
  shell.tools.replaceChildren(thisLifeButton, recordButton);

  if (presentation.pendingAction) {
    const event = eventDefinitions.get(presentation.pendingAction.actionId);
    const action = presentation.pendingAction;
    shell.event.append(element("h2", "", event?.presentation?.title || (action.actionId === "r4_action_travel" ? "正在途中" : "正在保存选择")));
    if (action.actionId === "r4_action_travel") {
      const inFlight = state.inFlightTransaction;
      if (inFlight?.transactionId === action.transactionId && inFlight.pauseReason === "world_node_due" && inFlight.pauseEventId) {
        const pausedEventId = inFlight.pauseEventId;
        shell.event.append(element("p", "r6-copy", "途中遇到一桩急事，先作眼前选择；原行程会从暂停处接续。"));
        renderChoiceCard(pausedEventId, eventDefinitions.get(pausedEventId)?.presentation?.title || "途中来事", "处理完眼前这桩，再继续原来的路。", shell.event);
        return;
      }
      const remaining = Math.max(0, Number(inFlight?.targetDay || 0) - Number(state.worldDay || 0));
      shell.event.append(element("p", "r6-copy", remaining ? `路上还需 ${remaining} 日。你仍在${locationName(presentation.sceneLocationId)}；途中状态已写入真实存档。` : "行程已由运行时结算，正在确认抵达。"));
      shell.event.append(makeButton(remaining ? "继续行程 1 日" : "确认抵达", () => continueTravel(), "r6-button primary"));
    } else {
      shell.event.append(element("p", "r6-copy", "选择正在由正式运行时处理；请勿重复提交。"));
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
  shell.activity.append(element("h2", "", "仍在院落"));
  if (presentation.dialogueRef?.lineId === "arrival") shell.activity.append(element("p", "r6-copy", `路途已尽，你抵达了${locationName(state.character.location)}。`));
  else shell.activity.append(element("p", "r6-copy", "院中一时安静下来。可理药、接活，也可循已知道路出镇。"));
  for (const eventId of ["r4_daily_entrust", "r4_daily_herb"]) {
    const options = availableOptions(eventId);
    if (!options.length) continue;
    const definition = eventDefinitions.get(eventId);
    shell.activity.append(element("h3", "", definition?.presentation?.title || "日常"));
    for (const option of options) {
      const choice = makeButton(option.text, () => submitChoice(eventId, option.id));
      choice.dataset.choiceId = option.id;
      choice.dataset.eventId = eventId;
      shell.activity.append(choice);
    }
  }
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
      const choice = makeButton(choiceLabel(eventId, option), () => submitChoice(eventId, option.id), "r6-button");
    choice.dataset.choiceId = option.id;
    list.append(choice);
  }
  parent.append(list);
}
function choiceLabel(eventId, option) {
  const natural = {
    "r4_birth_story:respond_to_neighbor": "应下邻里托付",
    "r4_ev_birth_herbal_roof:save_neighbor_batch": "先护住檐下药草"
  };
  return natural[`${eventId}:${option.id}`] || option.text;
}
function renderPendingResult(pending) {
  const state = runtimeState();
  const result = state.lastResult;
  const event = eventDefinitions.get(pending.eventId);
  const option = event?.options?.find((row) => row.id === result?.optionId);
  const title = event?.presentation?.title || "本次选择结果";
  shell.result.dataset.resultId = pending.resultId;
  shell.result.append(element("h2", "", title));
  shell.result.append(element("p", "r6-copy", option ? choiceLabel(pending.eventId, option) : "这段经历有了结果。"));
  const days = Number(result?.time?.durationDays || 0);
  const succeeded = result?.outcome === "success";
  const prose = succeeded
    ? (days ? `事情妥当了，日头也向前走了一日。你仍在${locationName(state.character.location)}。` : "这份心意落在了今世，光阴未动。")
    : (days ? `事情未尽如意，一日光阴已过；你仍在${locationName(state.character.location)}。` : "这件事暂未如愿，院中时光仍停在此刻。");
  shell.result.append(element("p", "r6-copy", prose));
  shell.result.append(element("p", "r6-source", "这段经历已收进行录。"));
  const continueLabel = pending.eventId === "r4_ev_birth_herbal_roof" ? "收拾停当" : pending.eventId === "r4_daily_entrust" ? "回到院中" : "收下这段经历";
  shell.result.append(makeButton(continueLabel, () => acknowledgeResult(), "r6-button primary"));
}
async function openRoofEvent() {
  if (busy || !engine.isEventAvailable("r4_ev_birth_herbal_roof")) return;
  busy = true;
  try {
    setEventReference("r4_ev_birth_herbal_roof");
    await persistEnvelope();
    render();
  } catch (error) { errorText = `场景状态未保存：${error.message}`; render(); }
  finally { busy = false; }
}
async function submitChoice(eventId, choiceId) {
  if (busy) return;
  const option = availableOptions(eventId).find((row) => row.id === choiceId);
  if (!option) { errorText = "当前来源或资格已变化，未提交选择。"; render(); return; }
  busy = true;
  const tx = `${slotId}:${runtimeState().character.lifeIndex}:${crypto.randomUUID()}`;
  try {
    setEventReference(eventId);
    const presentation = currentPresentation();
    presentation.selectedChoiceId = choiceId;
    presentation.pendingAction = { operationId: tx, actionId: eventId, transactionId: tx, status: "submitting" };
    errorText = "";
    await persistEnvelope();
    render();
    const result = engine.resolveWorldChoice(eventId, choiceId, tx);
    await commitChoiceResult(eventId, choiceId, tx, result);
  } catch (error) {
    errorText = error.message === "r6_save_conflict" ? "另一个标签页已更新此局；为避免重复结算，请刷新后继续。" : `本次选择未完成：${error.message}`;
    render();
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
  const result = engine.resolveWorldChoice(action.actionId, currentPresentation().selectedChoiceId, action.transactionId);
  await commitChoiceResult(action.actionId, currentPresentation().selectedChoiceId, action.transactionId, result);
}
async function beginTravel(destinationId) {
  if (busy) return;
  const state = runtimeState();
  const route = pack.runtimeSources.worldInitialization.routes.find((row) => row.from === state.character.location && row.to === destinationId && state.character.knownLocations?.includes(destinationId));
  if (!route || Number(state.character.wealth) < Number(route.wealth)) { errorText = "路线或路费条件已变化，未出发。"; render(); return; }
  busy = true;
  const tx = `${state.worldId}-action-${Number(state.operationSequence || 0) + 1}`;
  try {
    const presentation = currentPresentation();
    presentation.pendingAction = { operationId: tx, actionId: "r4_action_travel", transactionId: tx, status: "submitting" };
    presentation.selectedChoiceId = destinationId;
    presentation.dialogueRef = { eventId: "r4_action_travel", instanceId: eventInstanceId("r4_action_travel"), lineId: "travel", speakerId: null, sourceRefs: [] };
    await persistEnvelope();
    render();
    await dispatchTravel(destinationId, tx);
  } catch (error) { errorText = `出发未完成：${error.message}`; render(); }
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
  try {
    const action = currentPresentation().pendingAction;
    if (!action || action.actionId !== "r4_action_travel") return;
    if (runtimeState().character.location === currentPresentation().selectedChoiceId) return await finishTravel(currentPresentation().selectedChoiceId);
    const flight = runtimeState().inFlightTransaction;
    if (flight?.transactionId !== action.transactionId) throw new Error("active_travel_transaction_mismatch");
    const result = engine.continueWorldAction(1);
    const updated = runtimeState().inFlightTransaction;
    if (runtimeState().character.location === action.destinationId) return await finishTravel(action.destinationId);
    if (result?.kind === "progress" && updated?.transactionId === action.transactionId) {
      await persistEnvelope();
      render();
      return;
    }
    if (result?.kind !== "result" || runtimeState().character.location !== action.destinationId) throw new Error(result?.error || "travel_not_authoritatively_completed");
    await finishTravel(action.destinationId);
  } catch (error) { errorText = `行程未推进：${error.message}`; render(); }
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
  await persistEnvelope();
  render();
}
async function commitChoiceResult(eventId, choiceId, tx, rawResult) {
  const result = rawResult?.kind === "duplicate_suppressed" ? rawResult.result : rawResult;
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
    }
    syncReturnTarget();
    await persistEnvelope();
    render();
  } catch (error) { errorText = `已读状态未保存：${error.message}`; render(); }
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
  catch (error) { presentation.overlayStack.pop(); errorText = error.message === "r6_save_conflict" ? "另一处页面已保存新进展；本页未覆盖，请刷新后继续。" : `查看层状态未保存：${error.message}`; render(); }
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
  catch (error) { errorText = `查看层关闭状态未保存：${error.message}`; render(); }
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
  } else {
    panel.append(element("h2", "", "行录"));
    const result = state.lastResult;
    const event = result && eventDefinitions.get(result.eventId);
    const choice = event?.options?.find((row) => row.id === result.optionId);
    panel.append(element("p", "r6-copy", `这一生留下了 ${state.causeLog?.length || 0} 段因果。`));
    panel.append(element("p", "r6-copy", result ? `${event?.presentation?.title || "当时处境"}：${choice ? choiceLabel(result.eventId, choice) : "一次抉择"} · ${result.outcome === "success" ? "已然" : "未成"}` : "尚未遇见值得记下的事。"));
  }
  panel.append(element("p", "r6-source", "只读查看；开关不确认结果、不推进世界日。"));
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
    errorText = `存档读取失败：${error.message}`;
    showLanding();
  }
}

boot();
