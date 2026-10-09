import { createGameController } from "./game-controller.js?v=20261009-active-practice";
import { assetUrlFromManifest, loadAssetManifest } from "./asset-paths.js";
import {
  FOUR_DIMENSIONS,
  FOUR_DIM_COST_TABLE,
  costForLevel,
  totalAllocationCost,
  birthTier
} from "../engine/score-engine.js";

const [template, content, adConfig, assetBundle] = await Promise.all([
  fetch("./config/life-simulator.template.json").then((response) => response.json()),
  fetch("./content/life-simulator.placeholder.json?v=20261009-active-practice").then((response) => response.json()),
  fetch("./config/ad-placements.json").then((response) => response.json()),
  loadAssetManifest(fetch, window.location.href)
]);

const { manifest, manifestUrl } = assetBundle;
const assetMap = new Map(manifest.assets.map((asset) => [asset.asset_id, asset]));
const assetUrl = (id) => {
  const asset = assetMap.get(id);
  return asset ? assetUrlFromManifest(manifestUrl, asset.file) : "";
};
for (const asset of manifest.assets) {
  const image = new Image();
  image.src = assetUrl(asset.asset_id);
}

const game = createGameController({ template, content, adConfig });
const view = document.getElementById("view");
const toast = document.getElementById("toast");
let toastTimer = null;
let currentEventSnapshot = null;
let currentStudyMode = import.meta.url.includes("smoke") ? "smoke" : "play";
let pendingBirthProfile = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function image(id, className, alt = "") {
  const node = document.createElement("img");
  node.className = className;
  node.src = assetUrl(id);
  node.alt = alt;
  return node;
}

function showToast(text) {
  toast.textContent = text;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
}

function screen(name, backgroundId, extraClass = "") {
  const node = el("section", `screen ${name} ${extraClass}`.trim());
  node.style.setProperty("--page-bg", `url("${assetUrl(backgroundId)}")`);
  return node;
}

function panel(className, frameId) {
  const node = el("div", `panel ${className || ""}`.trim());
  if (frameId && assetMap.has(frameId)) node.style.setProperty("--frame-bg", `url("${assetUrl(frameId)}")`);
  return node;
}

function button(label, id = "btn_seal_primary_640x144", className = "primary-btn") {
  const node = el("button", `asset-button ${className}`.trim());
  const background = image(id, "button-skin");
  background.alt = "";
  const text = el("span", "button-label", label);
  node.append(background, text);
  return node;
}

function iconButton(id, label, className = "icon-button") {
  const node = el("button", className);
  node.append(image(id, "button-icon", ""));
  if (label) node.setAttribute("aria-label", label);
  return node;
}

function symbolButton(symbol, label, className = "icon-button") {
  const node = el("button", `${className} symbol-button`.trim());
  node.dataset.symbol = symbol;
  const glyph = el("span", "symbol-glyph", symbol);
  glyph.setAttribute("aria-hidden", "true");
  node.append(glyph);
  if (label) node.setAttribute("aria-label", label);
  return node;
}

function linkButton(label, handler, className = "ghost-btn") {
  const node = button(label, className === "primary-btn" ? "btn_seal_primary_640x144" : "btn_seal_ghost_640x144", className);
  node.addEventListener("click", handler);
  return node;
}

function orderedAttributes() {
  return Object.entries(template.attributes || {}).sort((a, b) => (a[1].displayOrder ?? 99) - (b[1].displayOrder ?? 99));
}

function attrIcon(key) {
  const map = { wealth: "icon_attr_wealth_96x96", power: "icon_attr_power_96x96", fame: "icon_attr_fame_96x96", bond: "icon_attr_bond_96x96", sanity: "icon_attr_sanity_96x96", health: "icon_attr_health_96x96" };
  return map[key] || "icon_logo_128x128";
}

function dimIcon(key) {
  const map = { naturalTalent: "icon_dim_natural_talent_96x96", aptitude: "icon_dim_aptitude_96x96", bloodline: "icon_dim_bloodline_96x96", fortune: "icon_dim_fortune_96x96" };
  return map[key];
}

function dimLabel(key) {
  return { naturalTalent: "资质", aptitude: "悟性", bloodline: "血脉", fortune: "气运" }[key] || key;
}

function formatDelta(value) {
  return value > 0 ? `+${value}` : String(value);
}

function effectText(effects) {
  return Object.entries(effects || {})
    .filter(([key, value]) => template.attributes[key] && value !== 0)
    .sort(([a], [b]) => (template.attributes[a]?.displayOrder ?? 99) - (template.attributes[b]?.displayOrder ?? 99))
    .map(([key, value]) => `${template.attributes[key].label} ${formatDelta(value)}`)
    .join(" · ");
}

function attributePanel(attributes) {
  const wrap = panel("attr-panel", "frame_card_700x260");
  const title = el("h2", "panel-title", "六属性");
  const grid = el("div", "attr-grid");
  for (const [key, config] of orderedAttributes()) {
    const item = el("div", "attr-item");
    item.append(image(attrIcon(key), "attr-icon", config.label));
    const copy = el("div", "attr-copy");
    copy.append(el("span", "attr-name", config.label), el("strong", "attr-value", String(attributes?.[key] ?? config.init)));
    const track = el("div", "attr-track");
    const fill = el("div", "attr-fill");
    fill.style.width = `${Math.max(0, Math.min(100, ((attributes?.[key] ?? config.init) / config.max) * 100))}%`;
    fill.style.backgroundColor = config.color;
    track.append(fill);
    copy.append(track);
    item.append(copy);
    grid.append(item);
  }
  wrap.append(title, grid);
  return wrap;
}

function ledgerPanel(ledger) {
  const wrap = panel("ledger-panel", "frame_card_700x260");
  const head = el("div", "ledger-head");
  head.append(image("icon_realm_96x96", "ledger-icon", "境界"), el("span", "ledger-realm", ledger?.realmLabel || "凡人"));
  const stateClass = ledger?.deathWindowState || "ok";
  head.append(el("span", `ledger-state ${stateClass}`, ledger?.warningText || "寿元安稳"));
  const grid = el("div", "ledger-grid");
  for (const [label, value] of [["年龄", ledger?.age], ["境界寿元", ledger?.realmLifespan], ["剩余寿元", ledger?.remainingYears]]) {
    const cell = el("div", "ledger-cell");
    cell.append(el("span", "ledger-label", label), el("strong", "ledger-value", String(value ?? "--")));
    grid.append(cell);
  }
  wrap.append(head, grid);
  return wrap;
}

function adSlot(placementId, context = {}) {
  const wrap = panel("ad-slot", "frame_ad_placeholder_700x220");
  const result = game.adService.show(placementId, context);
  wrap.append(image("icon_system_lantern_256x320", "ad-lantern", ""), el("span", "ad-label", result.shown ? "广告" : "广告位预留"));
  return wrap;
}

function showConfirm(message, onConfirm) {
  const overlay = el("div", "modal-overlay");
  const modal = panel("modal-card", "frame_modal_700x520");
  modal.append(el("h2", "modal-title", "此路需作取舍"), el("p", "modal-text", message));
  const actions = el("div", "modal-actions");
  const cancel = button("取消", "btn_seal_ghost_640x144", "ghost-btn");
  const confirm = button("确认献祭", "btn_seal_primary_640x144", "primary-btn");
  cancel.addEventListener("click", () => overlay.remove());
  confirm.addEventListener("click", () => { overlay.remove(); onConfirm(); });
  actions.append(cancel, confirm);
  modal.append(actions);
  overlay.append(modal);
  document.body.append(overlay);
}

function riskLevel(option) {
  const semantic = option?.semantic || option?.riskTag;
  if (semantic === "sacrifice") return "sacrifice";
  if (semantic === "risky") return "high";
  if (semantic === "safe") return "low";
  return "mid";
}

function riskAsset(option) {
  const level = riskLevel(option);
  if (level === "sacrifice") return "icon_risk_sacrifice_96x96";
  if (level === "high") return "icon_risk_high_96x96";
  if (level === "low") return "icon_risk_low_96x96";
  return "icon_risk_mid_96x96";
}

function riskLabel(option) {
  const level = riskLevel(option);
  if (level === "sacrifice") return "献祭";
  if (level === "high") return "高风险";
  if (level === "low") return "低风险";
  return "中风险";
}

function durationLabel(years) {
  const amount = Math.max(0, Number(years) || 0);
  if (amount <= 0) return "立即结算";
  if (amount <= 1) return "耗时：微量";
  if (amount <= 5) return "耗时：明显";
  return "耗时：重大";
}

function renderHome() {
  pendingBirthProfile = null;
  const screenNode = screen("home", "bg_home_750x1624");
  const wrap = panel("home-panel", "frame_system_guide_700x320");
  wrap.append(image("icon_logo_128x128", "home-logo", ""), el("h1", "home-title", template.ui?.title || "八幕仙途"), el("p", "home-subtitle", template.ui?.subtitle || "十世轮回"));
  const last = game.history()[0];
  if (last) {
    const note = panel("last-run-card", "frame_card_700x260");
    note.append(el("span", "last-ending", `${last.endingTitle || "未知结局"} · ${last.livesInCycle || 1} 世`), el("strong", "last-score", `${last.score || 0}/1000`), el("span", "last-points", `轮回点数 ${last.pointsEarned ?? 0}`));
    wrap.append(note);
  }
  const actions = el("div", "home-actions");
  actions.append(linkButton(last ? "再入一世" : "魂性问心", () => startPrimaryFlow(last), "primary-btn"));
  actions.append(linkButton("直接落笔入世", () => { const snap = game.start(); routeSnapshot(snap); }));
  if (last) actions.append(linkButton("十世回望", renderCycleRecap));
  const nav = el("div", "home-nav");
  nav.append(linkButton("人物志", renderBioList), linkButton("历史", renderHistory));
  wrap.append(actions, nav, adSlot("banner_result", { screen: "home" }));
  screenNode.append(wrap);
  view.replaceChildren(screenNode);
  window.scrollTo({ top: 0 });
}

function startPrimaryFlow(lastRun) {
  if (game.saveSystem.loadActive()) {
    routeTransition(game.resume());
    return;
  }
  if (lastRun && game.pendingFourDimAllocation()) {
    renderBirthPick(lastRun);
    return;
  }
  if (lastRun) {
    renderRebirth(lastRun);
    return;
  }
  renderSoulTest(0);
}

function renderSoulTest(questionIndex = 0) {
  const test = content.soulTest;
  if (!test?.questions?.length) {
    renderRolePick();
    return;
  }
  const index = Number.isInteger(questionIndex) ? Math.max(0, Math.min(test.questions.length - 1, questionIndex)) : 0;
  const question = test.questions[index];
  const screenNode = screen("soul_test", "bg_soul_750x1624");
  const wrap = panel("soul-panel", "frame_tome_700x520");
  wrap.append(image("icon_soul_mark_96x96", "section-icon", ""), el("p", "eyebrow", `${index + 1}/${test.questions.length}`), el("h1", "screen-title", test.title), el("p", "screen-copy", question.text));
  const choices = el("div", "choice-list");
  for (const option of question.options) {
    const node = button(option.label, "btn_choice_620x120", "choice-row");
    node.addEventListener("click", () => {
      if (index + 1 < test.questions.length) renderSoulTest(index + 1);
      else renderRolePick();
    });
    choices.append(node);
  }
  wrap.append(choices);
  screenNode.append(wrap);
  view.replaceChildren(screenNode);
}

function renderRolePick() {
  const screenNode = screen("role_pick", "bg_role_pick_750x1624");
  const wrap = el("div", "content-column");
  wrap.append(el("p", "eyebrow", "魂性回响"), el("h1", "screen-title", "选择第一世身份"), el("p", "screen-copy", "推荐只决定初始道路，后续仍由每次抉择改写。"));
  const list = el("div", "role-list");
  content.soulTest.recommendations.forEach((role, index) => {
    const card = panel("role-card", "frame_role_card_700x340");
    card.append(image(`icon_role_0${index + 1}_160x160`, "role-icon", role.name), el("span", "source-tag", role.source), el("h2", "panel-title", role.name), el("p", "screen-copy", role.summary));
    const choose = button("以此身入世", "btn_seal_primary_640x144", "primary-btn");
    choose.addEventListener("click", () => { pendingBirthProfile = { ...role, tiers: { naturalTalent: "中", aptitude: "中", bloodline: "中", fortune: "中" } }; game.saveBirthProfile(pendingBirthProfile); routeSnapshot(game.start()); });
    card.append(choose);
    list.append(card);
  });
  wrap.append(list);
  screenNode.append(wrap);
  view.replaceChildren(screenNode);
}

function optionActionLine(option, event) {
  const years = option.timeAdvanceYears ?? event?.timeAdvanceYears ?? template.engine?.defaultTimeAdvanceYears ?? 0;
  return durationLabel(years);
}

const GROWTH_DAO_LABELS = Object.freeze({ DAO01: "五行镇岳诀", DAO02: "星芒九转丹术" });
const GROWTH_DAO_PURPOSES = Object.freeze({ DAO01: "镇压 / 护体", DAO02: "炼药 / 救治" });

function growthHealthLabel(health) {
  if (Number(health) >= 60) return "状态稳定";
  if (Number(health) >= 30) return "已有伤势";
  return "近乎强弩之末";
}

function growthHeader(snapshot) {
  const growth = snapshot?.growthState || {};
  const card = panel("growth-header", "frame_card_700x260");
  card.append(el("p", "eyebrow", "当前目标"), el("h2", "panel-title", "补足修为、伤势或药材，再面对村口危机"));
  card.append(el("p", "screen-copy", `修为 ${snapshot?.attributes?.power ?? 0} · 健康 ${snapshot?.attributes?.health ?? 0} · 药材 ${growth.medicine ?? 0}`));
  card.append(el("span", `ledger-state ${growth.windowPressure === "late_window" ? "warning" : "ok"}`, `${growthHealthLabel(snapshot?.attributes?.health)} · ${growth.windowPressure === "late_window" ? "准备过久，机会已变冷" : "准备窗口进行中"}`));
  return card;
}

function growthDaoCard(snapshot) {
  const growth = snapshot?.growthState || {};
  const card = panel("growth-dao-card", "frame_dao_card_700x320");
  card.append(el("h2", "panel-title", `${GROWTH_DAO_LABELS[growth.daoId] || growth.daoId || "未选道业"} · 熟练度 ${growth.daoMastery ?? 0}`));
  card.append(el("p", "screen-copy", `用途：${GROWTH_DAO_PURPOSES[growth.daoId] || "当前窗口可用道业"}`));
  const choices = el("div", "growth-dao-choices");
  for (const daoId of ["DAO01", "DAO02"]) {
    const choose = button(`${daoId} · ${GROWTH_DAO_LABELS[daoId]}`, "btn_choice_620x120", `choice-row ${growth.daoId === daoId ? "active-growth-dao" : ""}`);
    choose.disabled = growth.usedActions?.length > 0;
    choose.addEventListener("click", () => {
      const result = game.selectGrowthDao(daoId);
      if (result.error) showToast("行动开始后不能更换道业");
      else renderPreparation(result.snapshot);
    });
    choices.append(choose);
  }
  card.append(choices);
  return card;
}

function renderPreparation(snapshot) {
  const growth = snapshot?.growthState || {};
  const screenNode = screen("event_later", "bg_event_later_750x1624");
  const wrap = el("div", "content-column");
  wrap.append(el("p", "eyebrow", "preparation_window_01"), el("h1", "screen-title", "有限准备窗口"), growthHeader(snapshot), growthDaoCard(snapshot));
  const windowCard = panel("preparation-window", "frame_card_700x260");
  windowCard.append(el("h2", "panel-title", `剩余行动 ${growth.actionSlotsRemaining ?? 0}/3`), el("p", "screen-copy", "每项行动本窗口只能做一次；点击行动后先看结果，再回到这里。"));
  const actions = el("div", "growth-actions");
  const specs = [
    ["action_practice_dao", "研修当前道业", "12 个月 · 熟练度 +1 · 修为方向 · 健康代价"],
    ["action_recover_injury", "处理伤势", `有药材 6 个月 / 无药材 12 个月 · 健康方向`],
    ["action_outing_find_medicine", "有目的外出寻药", "8 个月 · 最多获得 1 份药材 · 承担健康风险"]
  ];
  for (const [actionId, label, detail] of specs) {
    const action = button(label, "btn_choice_620x168", "choice-row growth-action");
    const used = growth.usedActions?.includes(actionId);
    action.disabled = used || growth.actionSlotsRemaining <= 0 || (actionId === "action_practice_dao" && Number(snapshot?.attributes?.health || 0) < 30);
    action.append(el("span", "action-line", used ? `${detail} · 已用` : detail));
    action.addEventListener("click", () => {
      const result = game.chooseGrowthAction(actionId);
      if (result.error) { showToast(result.error === "health_too_low_to_practice" ? "伤势过重，无法研修" : "这项行动现在不能执行"); return; }
      renderSettledResult(result, () => game.continueOutcome());
    });
    actions.append(action);
  }
  windowCard.append(actions);
  if (growth.usedActions?.length) windowCard.append(el("p", "used-actions", `已用行动：${growth.usedActions.join("、")}`));
  wrap.append(windowCard);
  const finish = linkButton(growth.actionSlotsRemaining > 0 ? "结束准备，进入突破时机" : "进入突破时机", () => routeTransition(game.continuePreparation()), "primary-btn");
  wrap.append(finish, el("p", "note-row", "突破不额外推进时间；超过 24 个月会留下 late_window 机会代价。"));
  screenNode.append(wrap);
  view.replaceChildren(screenNode);
  window.scrollTo({ top: 0 });
}

function renderBreakthrough(snapshot) {
  const growth = snapshot?.growthState || {};
  const power = Number(snapshot?.attributes?.power || 0);
  const health = Number(snapshot?.attributes?.health || 0);
  const eligible = power >= 28 && health >= 35;
  const screenNode = screen("d20_result", "bg_d20_750x1624");
  const wrap = el("div", "content-column");
  wrap.append(el("p", "eyebrow", "breakthrough_timing_01"), el("h1", "screen-title", "突破时机"));
  const card = panel("breakthrough-card", "frame_card_700x260");
  card.append(el("p", "screen-copy", `${GROWTH_DAO_LABELS[growth.daoId] || growth.daoId} · 修为 ${power} · 健康 ${health} · 药材 ${growth.medicine ?? 0}`));
  card.append(el("p", "screen-copy", eligible ? "修为与状态条件已满足，尝试会承担失败代价。" : "条件不足，只能暂不突破并保留当前状态。"));
  const actions = el("div", "growth-actions");
  const attempt = button("尝试突破", "btn_choice_620x168", "choice-row growth-action");
  attempt.disabled = !eligible;
  attempt.addEventListener("click", () => {
    const result = game.resolveBreakthrough("attempt");
    if (result.error) { showToast("当前条件不足，无法突破"); return; }
    renderSettledResult(result, () => routeTransition(game.advance()));
  });
  const skip = button("暂不突破，进入共用危机", "btn_seal_ghost_640x144", "ghost-btn");
  skip.addEventListener("click", () => {
    const result = game.resolveBreakthrough("skip");
    if (result.error) { showToast("突破时机已结算"); return; }
    renderSettledResult(result, () => routeTransition(game.advance()));
  });
  actions.append(attempt, skip);
  card.append(actions);
  wrap.append(card, el("p", "note-row", "突破成功、失败或跳过都只结算一次；下一站是 act2_first_blood。"));
  screenNode.append(wrap);
  view.replaceChildren(screenNode);
  window.scrollTo({ top: 0 });
}

function renderEvent(snapshot, phase = "event_guide") {
  currentEventSnapshot = snapshot;
  const current = game.current();
  if (!current?.event) { renderHome(); return; }
  const screenNode = screen(phase, phase === "event_guide" ? "bg_event_guide_750x1624" : "bg_event_later_750x1624");
  const wrap = el("div", "content-column");
  const header = el("header", "life-header");
  const life = el("div", "life-identity");
  life.append(image("icon_life_seal_96x96", "life-seal", ""), el("span", "life-name", `第 ${snapshot.livesInCycle} 世 · ${snapshot.birthProfile?.name || "未名者"}`));
  const stage = el("div", "stage-chip");
  stage.append(image("deco_seal_act_96x96", "stage-seal", ""), el("span", "", `${snapshot.stageLabel || ""} · ${snapshot.stageProgress}`));
  header.append(life, stage, image("icon_system_lantern_256x320", snapshot.livesInCycle === 1 ? "guide-lantern" : "quiet-lantern", ""));
  wrap.append(header);
  const eventCard = panel("event-card", "frame_card_700x260");
  eventCard.append(el("p", "eyebrow", `事件 ${snapshot.totalEvents}/${snapshot.maxEvents}`), el("h1", "event-title", current.event.title), el("p", "event-text", current.event.text));
  wrap.append(eventCard);
  if (current.event.id === "act2_first_blood" && snapshot.growthState) {
    const crisis = panel("crisis-state", "frame_card_700x260");
    crisis.append(el("h2", "panel-title", "共用危机状态"), el("p", "screen-copy", `${GROWTH_DAO_LABELS[snapshot.growthState.daoId] || snapshot.growthState.daoId} · 突破：${snapshot.growthState.breakthroughState} · 压力：${snapshot.growthState.windowPressure}`));
    wrap.append(crisis);
  }
  wrap.append(el("p", "choice-heading", "请选择"));
  const choices = el("div", "choice-list");
  choices.id = "event-choices";
  choices.setAttribute("aria-label", "可选抉择");
  current.event.options.forEach((option, index) => {
    const choice = button("", "btn_choice_620x168", "choice-row event-choice");
    const top = el("div", "choice-top");
    top.append(image(riskAsset(option), "risk-icon", riskLabel(option)), el("strong", "choice-label", option.label), el("span", "risk-label", riskLabel(option)));
    const effects = el("span", "effects-row", effectText(option.effects) || "无直接属性变化");
    choice.append(top, effects);
    if (option.failureEffects || option.d20) choice.append(el("span", "failure-row", `失败时：${effectText(option.failureEffects || option.effects) || "后果未明"}`));
    choice.append(el("span", "action-line", optionActionLine(option, current.event)));
    const act = () => {
      const result = game.choose(index);
      if (result.error) { showToast("操作失败，请重试"); return; }
      const showResult = () => renderOutcomeResult(result, () => game.continueOutcome());
      if (result.record.d20) renderD20Result(result, showResult);
      else showResult();
    };
    choice.addEventListener("click", () => option.semantic === "sacrifice" ? showConfirm("修为将散去大半，只保留道路资格与庇护。", act) : act());
    choices.append(choice);
  });
  wrap.append(choices);
  wrap.append(ledgerPanel(snapshot.ledger));
  wrap.append(attributePanel(snapshot.attributes));
  if (snapshot.livesInCycle === 1) {
    const guide = panel("system-guide", "frame_system_guide_700x320");
    guide.append(el("strong", "guide-title", "轮回灯已点亮"), el("p", "screen-copy", "先读选项的属性增减，再看下方寿元账本。每一次选择都会进入结果节拍。"));
    wrap.append(guide);
  }
  wrap.append(adSlot("interstitial_stage_switch", { stage: snapshot.stageId }));
  const menu = el("div", "event-menu");
  menu.append(linkButton("个人面板", () => renderProfile(snapshot)), linkButton("道业研修", () => renderStudyDao()));
  wrap.append(menu);
  screenNode.append(wrap);
  view.replaceChildren(screenNode);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function outcomeRecord(result) {
  if (result?.record) return result.record;
  if (result?.result) {
    return { eventId: "dao_practice", eventTitle: "道业研修", optionLabel: result.result.daoId, success: result.result.success, effects: result.result.effects, resultText: result.result.resultText, d20: result.result.d20, timeAdvance: result.result.timeAdvance, semantic: "study", riskTag: "development" };
  }
  return { success: false, effects: {}, resultText: "" };
}

function settledContinuation(result, next) {
  const record = outcomeRecord(result);
  return {
    ...result,
    kind: result?.finished || result?.runResult ? "finished" : "resolved",
    record,
    snapshot: result?.snapshot || currentEventSnapshot,
    timeAdvance: result?.timeAdvance || record.timeAdvance || result?.result?.timeAdvance || null,
    windowTimeAdvances: result?.windowTimeAdvances || record.windowTimeAdvances || [],
    bridgeText: result?.bridgeText || record.bridgeText || null,
    lifespanCost: Number(record.lifespanCost || result?.lifespanCost || 0),
    next
  };
}

function renderSettledResult(result, next) {
  const showResult = () => renderOutcomeResult(result, () => settledContinuation(result, next));
  if (outcomeRecord(result).d20) renderD20Result(result, showResult);
  else showResult();
}

function renderD20Result(result, next) {
  const record = outcomeRecord(result);
  const d20 = record.d20 || {};
  const screenNode = screen("d20_result", "bg_d20_750x1624");
  const wrap = el("div", "content-column");
  wrap.append(el("p", "eyebrow", "d20 检定"), el("h1", "screen-title", record.eventTitle || "关口"));
  const ring = panel("d20-ring", "deco_d20_ring_360x360");
  ring.append(el("strong", "d20-value", String(d20.roll ?? "--")));
  wrap.append(ring);
  if (d20.extreme) wrap.append(el("p", `extreme-tag ${d20.extreme}`, d20.extreme === "greatSuccess" ? "大成功" : "大凶"));
  const consequence = panel("result-card", "frame_card_700x260");
  consequence.append(el("span", `outcome-stamp ${record.success ? "success" : "failure"}`, record.success ? "检定成功" : "检定失败"), el("p", "result-text", record.resultText || ""));
  wrap.append(consequence);
  wrap.append(el("p", "d20-target-line", `目标 ≥ ${d20.target ?? "--"} · 骰面 ${d20.roll ?? "--"} + 加值 ${d20.modifier ?? 0} = ${d20.total ?? "--"}`));
  if (!record.success && d20.penalty < 2) wrap.append(el("p", "retry-note", "失败不可免费重试；再试需付疗伤、材料或心境代价，目标 +1，最多累计 +2。"));
  if (!record.success && Number(result?.snapshot?.state?.fortuneUsesRemaining || 0) > 0 && typeof game.rerollLastOutcome === "function") {
    const reroll = linkButton("借气运重掷", () => { const rerolled = game.rerollLastOutcome(); if (rerolled.error) showToast("气运已耗尽"); else renderD20Result(rerolled, next); });
    wrap.append(reroll);
  }
  const continueButton = button("继续", "btn_seal_primary_640x144", "primary-btn continue-btn");
  continueButton.addEventListener("click", () => next ? next() : renderOutcomeResult(result, () => game.continueOutcome()));
  wrap.append(continueButton);
  screenNode.append(wrap);
  view.replaceChildren(screenNode);
  window.scrollTo({ top: 0 });
}

function renderOutcomeResult(result, continuationFactory) {
  const record = outcomeRecord(result);
  const snapshot = result.snapshot || currentEventSnapshot;
  const screenNode = screen("result_beat", "bg_result_750x1624");
  const wrap = el("div", "content-column");
  wrap.append(el("p", "eyebrow", "结果节拍"));
  const resultCard = panel("result-card", "frame_card_700x260");
  resultCard.append(image(record.success ? "icon_outcome_success_96x96" : "icon_outcome_failure_96x96", "outcome-icon", ""), el("span", `outcome-stamp ${record.success ? "success" : "failure"}`, record.success ? "成" : "败"), el("p", "result-option", `你选择了「${record.optionLabel || record.eventTitle || "此事"}」`), el("p", "result-text", record.resultText || ""));
  wrap.append(resultCard);
  const deltaCard = panel("delta-card", "frame_card_700x260");
  deltaCard.append(el("h2", "panel-title", "本拍实际生效"));
  const deltas = Object.entries(record.effects || {}).filter(([key, value]) => template.attributes[key] && value !== 0);
  if (!deltas.length) deltaCard.append(el("p", "screen-copy", "属性没有产生可见变化。"));
  for (const [key, value] of deltas) {
    const row = el("div", "delta-row");
    row.append(image(attrIcon(key), "delta-icon", template.attributes[key].label), el("span", "delta-name", template.attributes[key].label), el("strong", value >= 0 ? "delta-pos" : "delta-neg", formatDelta(value)), el("span", "delta-current", String(snapshot?.attributes?.[key] ?? "")));
    deltaCard.append(row);
  }
  for (const [key, value] of Object.entries(record.growthChanges || {}).filter(([, value]) => value != null)) {
    deltaCard.append(el("p", "growth-change", `${key === "medicine" ? "药材" : key === "daoMastery" ? "道业熟练度" : key}：${value}`));
  }
  wrap.append(deltaCard);
  wrap.append(attributePanel(snapshot?.attributes));
  const next = button("继续", "btn_seal_primary_640x144", "primary-btn continue-btn result-continue");
  next.addEventListener("click", () => {
    const continuation = typeof continuationFactory === "function" ? continuationFactory() : game.continueOutcome();
    if (!continuation || continuation.error) {
      showToast("结果已失效，请重新开始本世");
      return;
    }
    renderContinuation(continuation);
  });
  wrap.append(next);
  screenNode.append(wrap);
  view.replaceChildren(screenNode);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function displayLedgerNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/\.?0+$/, "");
}

function appendTimeLedger(wrap, entry) {
  if (!entry || Number(entry.years || 0) <= 0) return;
  const card = panel("time-ledger", "frame_card_700x260");
  card.append(el("h2", "panel-title", `时间推进 · 经过 ${displayLedgerNumber(entry.years)} 年`));
  card.append(el("p", "time-reason", entry.reason || "事件明确记录的时间推进"));
  card.append(el("p", "screen-copy", `年龄 ${displayLedgerNumber(entry.previous?.age)} → ${displayLedgerNumber(entry.current?.age)} · 剩余寿元 ${displayLedgerNumber(entry.previous?.remainingYears)} → ${displayLedgerNumber(entry.current?.remainingYears)} · 世界年 ${displayLedgerNumber(entry.fromWorldYear)} → ${displayLedgerNumber(entry.toWorldYear)}`));
  card.append(el("p", "time-basis", entry.basis || "事件依据已记录"));
  card.append(el("span", `ledger-state ${entry.current?.deathWindowState || "ok"}`, entry.current?.warningText || "寿元安稳"));
  wrap.append(card);
}

const TIME_BEAT_LABELS = Object.freeze({
  result: "结果",
  ledger: "人生账本"
});

function formatTimeBeat(beat) {
  if (typeof beat === "string") return beat.trim();
  if (!beat || typeof beat !== "object") return "";
  const text = typeof beat.text === "string" ? beat.text.trim() : "";
  if (!text) return "";
  const at = typeof beat.at === "string" ? beat.at.trim() : "";
  const label = TIME_BEAT_LABELS[at] || at;
  return label ? `【${label}】${text}` : text;
}

function renderContinuation(transition) {
  if (!transition || transition.error) { renderHome(); return; }
  const record = transition.record || outcomeRecord(transition);
  const snapshot = transition.snapshot || currentEventSnapshot;
  const timeEntries = [transition.timeAdvance, transition.record?.timeAdvance, ...(transition.windowTimeAdvances || []), ...(record.windowTimeAdvances || [])]
    .filter(Boolean)
    .filter((entry, index, list) => list.indexOf(entry) === index && Number(entry.years || 0) > 0);
  const lifespanCost = Number(transition.lifespanCost || record.lifespanCost || 0);
  const bridgeText = transition.bridgeText || record.bridgeText || "";
  const timeBeats = transition.timeBeats || record.timeBeats || [];
  const next = typeof transition.next === "function"
    ? transition.next
    : transition.kind === "finished"
      ? () => routeTransition(transition)
      : () => routeTransition(game.advance());

  if (!timeEntries.length && lifespanCost <= 0 && !bridgeText && !timeBeats.length) {
    next();
    return;
  }

  const screenNode = screen("continuation", "bg_result_750x1624");
  const wrap = el("div", "content-column");
  wrap.append(el("p", "eyebrow", transition.stageChanged ? "交接节拍" : "因果续页"), el("h1", "screen-title", transition.stageChanged ? "幕间将至" : "此拍之后"));
  for (const entry of timeEntries) appendTimeLedger(wrap, entry);
  if (lifespanCost > 0) {
    const remaining = snapshot?.state?.remainingYears ?? snapshot?.ledger?.remainingYears ?? 0;
    const lifespanCard = panel("time-ledger lifespan-cost", "frame_card_700x260");
    lifespanCard.append(el("h2", "panel-title", `寿元消耗 · ${displayLedgerNumber(lifespanCost)} 年`));
    lifespanCard.append(el("p", "time-reason", record.resultText || "以命避劫消耗寿元"));
    lifespanCard.append(el("p", "screen-copy", `剩余寿元 ${displayLedgerNumber(Number(remaining) + lifespanCost)} → ${displayLedgerNumber(remaining)}`));
    lifespanCard.append(el("p", "time-basis", `因果依据：${record.eventTitle || "劫敲门"} · 以命避劫`));
    wrap.append(lifespanCard);
  }
  if (timeBeats.length) {
    const beats = panel("time-beats-card", "frame_card_700x260");
    beats.append(el("h2", "panel-title", "时间节拍"));
    for (const beat of timeBeats) {
      const text = formatTimeBeat(beat);
      if (text) beats.append(el("p", "screen-copy time-beat", text));
    }
    wrap.append(beats);
  }
  if (bridgeText) {
    const bridge = panel("bridge-card", "frame_card_700x260");
    bridge.append(el("h2", "panel-title", "承接"), el("p", "screen-copy", bridgeText));
    wrap.append(bridge);
  }
  const nextButton = button("继续", "btn_seal_primary_640x144", "primary-btn continuation-next");
  nextButton.addEventListener("click", next);
  wrap.append(nextButton);
  screenNode.append(wrap);
  view.replaceChildren(screenNode);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderInterlude(snapshot, next) {
  const stage = template.stages?.[snapshot?.stageId];
  const screenNode = screen("interlude", "bg_interlude_750x1624");
  const wrap = panel("interlude-card", "frame_tome_700x520");
  wrap.append(image("deco_seal_act_96x96", "act-seal", ""), el("p", "eyebrow", "幕间"), el("h1", "screen-title", stage?.label || snapshot?.stageLabel || "幕后"), el("p", "screen-copy", stage?.interlude || stage?.description || "上一段因果已经落定。"));
  const continueButton = button("继续", "btn_seal_primary_640x144", "primary-btn");
  continueButton.addEventListener("click", next);
  wrap.append(continueButton, adSlot("interstitial_stage_switch", { stage: snapshot?.stageId }));
  screenNode.append(wrap);
  view.replaceChildren(screenNode);
  window.scrollTo({ top: 0 });
}

function renderFateWindow(windowData, snapshot) {
  const screenNode = screen("fate_window", "bg_fate_750x1624");
  const wrap = el("div", "content-column");
  wrap.append(el("p", "eyebrow", "天机簿"), el("h1", "screen-title", windowData?.name || "未名约期"));
  const tome = panel("tome-card", "frame_tome_700x520");
  tome.append(image("icon_window_mark_96x96", "section-icon", ""), el("p", "screen-copy", windowData?.hint || "墨痕只说：到时自见。"), el("p", "ledger-row", "应期已记入天机簿"));
  if (windowData?.unfinishedBusiness?.length) tome.append(el("p", "consequence-preview", `若失约：${windowData.unfinishedBusiness.join("、")}`));
  wrap.append(tome);
  const choices = el("div", "choice-list");
  const paths = [["attend", windowData?.attendPath, "应约赴会"], ["miss", windowData?.missPath, "闭关错过"], ["avoid", windowData?.avoidPath, "主动避开"]];
  for (const [choice, path, fallback] of paths) {
    if (!path && choice !== "attend") continue;
    if (!path && choice === "attend") continue;
    const row = button(path.label || fallback, "btn_choice_620x168", "choice-row");
    row.append(el("span", "action-line", `${riskLabel(path)} · ${durationLabel(path.timeAdvanceYears)}`));
    row.addEventListener("click", () => {
      const result = game.resolveWindow(choice, path.d20 ? undefined : 1);
      if (result.error) { showToast("时间窗已关闭"); return; }
      renderSettledResult(result, () => routeTransition(game.advance()));
    });
    choices.append(row);
  }
  wrap.append(choices, el("p", "note-row", "错过或避开会写入未竟之事，世界照常演化。"));
  screenNode.append(wrap);
  view.replaceChildren(screenNode);
  window.scrollTo({ top: 0 });
}

function renderKarma(snapshot) {
  const screenNode = screen("karma_knock", "bg_karma_750x1624");
  const wrap = el("div", "content-column");
  wrap.append(el("p", "eyebrow", `第 ${snapshot?.livesInCycle || 1} 世 · 劫敲门`), el("h1", "screen-title", "劫气已至"));
  const banner = panel("gate-banner", "frame_doom_gate_700x360");
  banner.append(image("icon_karma_mark_96x96", "section-icon", ""), el("p", "screen-copy", "避劫只把因果推迟，不会让它消失。"));
  wrap.append(banner);
  const choices = el("div", "choice-list");
  for (const [value, label, detail] of [["break", "破关迎劫", "高风险 · 失败后果极重"], ["suppress", "强行压劫", "中风险 · 成功后留黑纹"], ["avoid", "以命避劫", "献祭 · 消耗大量寿元"]]) {
    const row = button(label, "btn_choice_620x168", "choice-row");
    row.append(image(value === "avoid" ? "icon_risk_sacrifice_96x96" : value === "break" ? "icon_risk_high_96x96" : "icon_risk_mid_96x96", "risk-icon", ""), el("span", "action-line", detail));
    row.addEventListener("click", () => {
      const run = () => {
        const result = game.resolveKarma(value, value === "avoid" ? 1 : undefined);
        if (result.error) { showToast("劫门状态无效"); return; }
        renderSettledResult(result, () => routeTransition(game.advance()));
      };
      if (value === "avoid") showConfirm("以寿元换过此劫，因果仍会进入下一世。", run);
      else run();
    });
    choices.append(row);
  }
  wrap.append(choices, el("p", "persistent-warning", "此劫不可永久避开。"));
  screenNode.append(wrap);
  view.replaceChildren(screenNode);
}

function renderStudyDao(tab = "current") {
  const current = game.current();
  const snapshot = current?.snapshot || currentEventSnapshot;
  const records = current?.learningRecords || [];
  const screenNode = screen("study_dao", "bg_study_750x1624");
  const wrap = el("div", "content-column");
  wrap.append(el("p", "eyebrow", `第 ${snapshot?.livesInCycle || 1} 世 · 道业录`), el("h1", "screen-title", "道业研修"));
  const tabs = el("div", "segmented");
  for (const [value, label] of [["current", "本世可用"], ["past", "历世回望"]]) {
    const node = el("button", `segment ${tab === value ? "active" : ""}`, label);
    node.addEventListener("click", () => renderStudyDao(value));
    tabs.append(node);
  }
  wrap.append(tabs);
  const list = el("div", "dao-list");
  const visible = tab === "current" ? records.filter((record) => record.current !== false && record.awakened) : records.filter((record) => record.awakened !== true || record.lifeIndex < (snapshot?.livesInCycle || 1));
  if (!visible.length) list.append(el("p", "screen-copy", tab === "current" ? "本世暂无可研修道业。" : "历世尚未留下可回望的觉醒记录。"));
  for (const record of visible) {
    const card = panel("dao-card", "frame_dao_card_700x320");
    const head = el("div", "dao-head");
    head.append(image(record.category === "elixir" ? "icon_dao_elixir_96x96" : "icon_dao_cultivation_96x96", "dao-icon", record.name), el("div", "dao-copy"));
    head.lastChild.append(el("strong", "panel-title", record.name), el("span", "source-tag", `第 ${record.lifeIndex} 世 · ${record.rank} · ${record.stages?.[record.stageIndex] || ""}`));
    card.append(head, el("p", "screen-copy", record.effect));
    if (tab === "current" && record.stageIndex < 3) {
      const ops = el("div", "dao-ops");
      const conservative = button("保守练习 · 低风险", "btn_choice_620x120", "choice-row");
      conservative.addEventListener("click", () => {
        const result = game.practiceDao(record.id, "conservative");
        if (result.error) { showToast(result.error); return; }
        renderSettledResult(result, () => renderStudyDao("current"));
      });
      ops.append(conservative);
      if (record.stageIndex >= 2) {
        const risky = button("冒险研修 · 高风险", "btn_choice_620x120", "choice-row");
        risky.addEventListener("click", () => {
          const result = game.practiceDao(record.id, "risky");
          if (result.error) { showToast(result.error); return; }
          renderSettledResult(result, () => renderStudyDao("current"));
        });
        ops.append(risky);
      }
      card.append(ops);
    }
    list.append(card);
  }
  wrap.append(list);
  const back = button("返回当前事件", "btn_seal_secondary_640x144", "ghost-btn");
  back.addEventListener("click", () => routeSnapshot(snapshot));
  wrap.append(back);
  screenNode.append(wrap);
  view.replaceChildren(screenNode);
  window.scrollTo({ top: 0 });
}

function renderProfile(snapshot = currentEventSnapshot) {
  const screenNode = screen("profile", "bg_profile_750x1624");
  const wrap = el("div", "content-column");
  wrap.append(el("p", "eyebrow", "个人面板"), el("h1", "screen-title", `第 ${snapshot?.livesInCycle || 1} 世 · 言缺线`));
  wrap.append(ledgerPanel(snapshot?.ledger), attributePanel(snapshot?.attributes));
  const dao = panel("dao-summary", "frame_dao_card_700x320");
  dao.append(el("h2", "panel-title", "道业"));
  const records = game.current()?.learningRecords || [];
  for (const record of records.slice(0, 4)) dao.append(el("p", "ledger-row", `${record.name} · ${record.rank} · ${record.awakened ? "已觉醒" : "未觉醒"}`));
  wrap.append(dao);
  const memory = panel("memory-zone", "frame_memory_700x180");
  memory.append(el("h2", "panel-title", "记忆与未竟之事"));
  const memoryItems = [...(snapshot?.memoryFragments || []), ...(snapshot?.unfinishedBusiness || [])];
  if (!memoryItems.length) memory.append(el("p", "screen-copy", "记忆仍沉在雾里。"));
  for (const item of memoryItems.slice(-4)) memory.append(el("p", "screen-copy", String(item)));
  wrap.append(memory);
  const actions = el("div", "profile-actions");
  actions.append(linkButton("道业研修", () => renderStudyDao()), linkButton("人物志", renderBioList), linkButton("返回", () => routeSnapshot(snapshot), "primary-btn"));
  wrap.append(actions);
  screenNode.append(wrap);
  view.replaceChildren(screenNode);
  window.scrollTo({ top: 0 });
}

function renderCliff(reason = "mid_life_stop", runResult = null) {
  const snapshot = game.current()?.snapshot || currentEventSnapshot;
  const screenNode = screen("cliff", "bg_cliff_750x1624");
  const wrap = el("div", "content-column");
  const names = { health_zero: "重创收束", sanity_zero: "心魔收束", lifespan_exhausted: "寿尽收束", mid_life_stop: "中途收束" };
  const banner = panel("cliff-banner", "frame_ending_banner_700x240");
  banner.append(image("icon_cliff_96x96", "section-icon", ""), el("h1", "screen-title", names[reason] || "此世收束"), el("p", "screen-copy", reason === "lifespan_exhausted" ? "寿元已到尽头，关口却仍在前面。" : "这一世在此停下，四段评分仍会留下。"));
  wrap.append(banner);
  const stateCard = panel("state-card", "frame_card_700x260");
  stateCard.append(el("p", "ledger-row", `健康 ${snapshot?.attributes?.health ?? 0} · 理智 ${snapshot?.attributes?.sanity ?? 0}`), el("p", "ledger-row", `境界 ${snapshot?.ledger?.realmLabel || "凡人"} · 剩余寿元 ${snapshot?.ledger?.remainingYears ?? 0}`));
  wrap.append(stateCard);
  if (!runResult && reason === "lifespan_exhausted" && snapshot?.state?.lifespanRescueUsed !== true) {
    const rescue = panel("rescue-row", "frame_card_700x260");
    rescue.append(el("p", "screen-copy", "一生一次 · 以命冲关失败即寿尽收束"));
    const rescueButton = button("以命冲关", "btn_seal_primary_640x144", "primary-btn");
    rescueButton.addEventListener("click", () => {
      const result = game.resolveCliff("rescue");
      if (result.runResult) { renderSettledResult(result, () => renderRebirth(result)); return; }
      renderSettledResult(result, () => routeTransition(game.advance()));
    });
    rescue.append(rescueButton);
    wrap.append(rescue);
  }
  const enter = button("进入轮回边界", "btn_seal_secondary_640x144", "ghost-btn");
  enter.addEventListener("click", () => {
    if (runResult) renderRebirth({ runResult, ending: { id: runResult.endingId, label: runResult.endingTitle, tone: runResult.endingTone } });
    else {
      const result = game.resolveCliff("stop");
      renderRebirth(result);
    }
  });
  wrap.append(enter, el("p", "note-row", "非寿尽收束也按 R2 四段结算。"));
  screenNode.append(wrap);
  view.replaceChildren(screenNode);
}

function emptyAllocation() {
  return Object.fromEntries(FOUR_DIMENSIONS.map((key) => [key, 0]));
}

function renderRebirth(result, allocation, options = {}) {
  const preserveScroll = options.preserveScroll === true;
  const savedScrollY = preserveScroll ? window.scrollY : 0;
  const run = result?.runResult || result;
  const ending = result?.ending || { id: run?.endingId, label: run?.endingTitle, tone: run?.endingTone };
  const score = run?.score || 0;
  const points = run?.pointsEarned || 0;
  const sections = run?.sections || run?.scoreDetail?.sections || {};
  const reasons = run?.reasons || run?.scoreDetail?.reasons || {};
  const alloc = allocation || emptyAllocation();
  const cost = totalAllocationCost(alloc);
  const remaining = Math.max(0, points - cost);
  const screenNode = screen("rebirth", "bg_rebirth_750x1624");
  const wrap = el("div", "content-column");
  const banner = panel("ending-banner", "frame_ending_banner_700x240");
  banner.append(image("icon_ending_mark_96x96", "ending-icon", ""), el("p", "eyebrow", "轮回边界 · 此世落幕"), el("h1", "ending-title", ending?.label || run?.endingTitle || "此世落幕"));
  wrap.append(banner);
  const scoreZone = panel("score-zone", "frame_card_700x260");
  const ring = el("div", "score-ring");
  ring.style.setProperty("--score-progress", `${Math.max(0, Math.min(100, (score / 1000) * 100))}%`);
  ring.append(el("strong", "score-value", String(score)), el("span", "score-total", "/1000"));
  scoreZone.append(ring);
  const titles = { realm: "修为/境界", story: "故事/因果", living: "活况", legacy: "传承" };
  for (const key of FOUR_DIMENSIONS.length === 4 ? ["realm", "story", "living", "legacy"] : []) {
    const row = el("div", "section-score");
    const bar = el("div", "section-track");
    const fill = el("div", "section-fill");
    fill.style.width = `${Math.max(0, Math.min(100, ((sections[key] || 0) / 250) * 100))}%`;
    bar.append(fill);
    row.append(el("strong", "section-name", `${titles[key]} ${sections[key] || 0}/250`), bar);
    for (const reason of (reasons[key] || []).slice(0, 2)) row.append(el("span", "section-reason", reason));
    scoreZone.append(row);
  }
  wrap.append(scoreZone);
  const pointZone = panel("point-zone", "frame_seal_round_160x160");
  pointZone.append(image("deco_cycle_ring_240x240", "point-icon", ""), el("span", "point-label", `轮回点数 +${points}`), el("span", "point-note", "固定查表：0-199/200-329/330-459/460-589/590-719/720-849/850-1000"));
  wrap.append(pointZone);
  const allocZone = panel("alloc-zone", "frame_card_700x260");
  allocZone.append(el("h2", "panel-title", "分配四维"), el("p", "alloc-meta", `剩余 ${remaining}/${points} 点 · 单维最高 5 级`));
  for (const key of FOUR_DIMENSIONS) {
    const level = alloc[key] || 0;
    const row = el("div", "alloc-row");
    row.append(image(dimIcon(key), "dim-icon", dimLabel(key)), el("span", "alloc-name", dimLabel(key)));
    const minus = symbolButton("-", `减少${dimLabel(key)}`);
    minus.disabled = level <= 0;
    minus.addEventListener("click", () => renderRebirth(result, { ...alloc, [key]: level - 1 }, { preserveScroll: true }));
    const plus = symbolButton("+", `增加${dimLabel(key)}`);
    plus.disabled = level >= 5 || costForLevel(level + 1) - costForLevel(level) > remaining;
    plus.addEventListener("click", () => renderRebirth(result, { ...alloc, [key]: level + 1 }, { preserveScroll: true }));
    row.append(minus, el("strong", "alloc-level", String(level)), plus, el("span", "alloc-cost", `累计 ${costForLevel(level)}`));
    allocZone.append(row);
  }
  const budget = el("p", "budget-row", `剩余 ${remaining}/${points} 点 · 已用 ${cost}`);
  allocZone.append(budget);
  const preview = el("p", "birth-preview", FOUR_DIMENSIONS.map((key) => `${dimLabel(key)} ${birthTier(alloc[key] || 0)}`).join(" · "));
  allocZone.append(preview);
  wrap.append(allocZone);
  const actionGroup = el("div", "rebirth-actions");
  const confirm = button(points > 0 ? "确定并再入轮回" : "再入轮回", "btn_seal_primary_640x144", "primary-btn");
  confirm.addEventListener("click", () => {
    if (cost > points) { showToast("四维分配超出预算"); return; }
    const saved = game.saveFourDimAllocation(alloc, points);
    if (!saved.ok) { showToast(saved.errors[0] || "分配无效"); return; }
    if ((run?.livesInCycle || 1) >= (template.cycle?.recapAtLife || 10)) renderCycleRecap();
    else renderBirthPick(run);
  });
  const skip = button("跳过分配，直接轮回", "btn_seal_ghost_640x144", "ghost-btn");
  skip.addEventListener("click", () => { game.saveFourDimAllocation(emptyAllocation(), points); renderBirthPick(run); });
  actionGroup.append(confirm, skip);
  wrap.append(actionGroup, adSlot("rewarded_restart", { screen: "rebirth" }));
  screenNode.append(wrap);
  view.replaceChildren(screenNode);
  const maxScrollTop = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  window.scrollTo({ top: preserveScroll ? Math.min(savedScrollY, maxScrollTop) : 0 });
}

function renderBirthPick(run) {
  const pending = game.pendingFourDimAllocation();
  const levels = pending?.levels || emptyAllocation();
  const tiers = Object.fromEntries(FOUR_DIMENSIONS.map((key) => [key, birthTier(levels[key] || 0)]));
  const screenNode = screen("birth_pick", "bg_birth_750x1624");
  const wrap = el("div", "content-column");
  wrap.append(el("p", "eyebrow", `第 ${(run?.livesInCycle || 0) + 1} 世 · 出身`), el("h1", "screen-title", "选择出身模板"));
  const disc = panel("fate-disc", "deco_birth_ring_240x240");
  disc.append(el("p", "dim-summary", FOUR_DIMENSIONS.map((key) => `${dimLabel(key)} ${tiers[key]}`).join(" · ")), image("icon_echo_96x96", "echo-icon", ""), el("p", "screen-copy", "一段记不起名字的回声，正在为你指路。"));
  wrap.append(disc);
  const candidates = [
    { id: "role_01", name: "旧约行者", source: "传承", text: "故人缘分更深，先听见旧事的回声。", strengths: `资质 ${tiers.naturalTalent} · 羁绊线更早浮现` },
    { id: "role_02", name: "逆命客", source: "天命", text: "关口更险，却更容易撞开高难路线。", strengths: `悟性 ${tiers.aptitude} · 破境路线更清晰` },
    { id: "role_03", name: "守卷人", source: "师承", text: "道业研修与传承沉淀更稳。", strengths: `血脉 ${tiers.bloodline} · 气运 ${tiers.fortune}` }
  ];
  const list = el("div", "birth-list");
  for (const [index, candidate] of candidates.entries()) {
    const card = panel("birth-card", "frame_birth_card_700x300");
    card.append(image(`icon_role_0${index + 1}_160x160`, "birth-icon", candidate.name), el("span", "source-tag", candidate.source), el("h2", "panel-title", candidate.name), el("p", "screen-copy", candidate.text), el("span", "strength-row", candidate.strengths));
    const choose = button("以此身入世", "btn_seal_primary_640x144", "primary-btn");
    choose.addEventListener("click", () => { game.saveBirthProfile({ ...candidate, tiers }); routeSnapshot(game.start()); });
    card.append(choose);
    list.append(card);
  }
  wrap.append(list, el("p", "note-row", "同段身份 2-3 选 1，只显示身份来源与低/中/高。"));
  screenNode.append(wrap);
  view.replaceChildren(screenNode);
}

function renderCycleRecap() {
  const history = game.history().slice(0, template.cycle?.livesPerCycle || 10);
  const screenNode = screen("cycle_recap", "bg_cycle_750x1624");
  const wrap = el("div", "content-column");
  wrap.append(el("p", "eyebrow", "十世回望"), el("h1", "screen-title", "轮回卷"));
  const list = el("div", "cycle-list");
  if (!history.length) list.append(el("p", "screen-copy", "尚无完整一世。"));
  history.forEach((run, index) => {
    const row = panel("life-row", "frame_timeline_node_96x96");
    row.append(image("icon_life_seal_96x96", "life-seal", ""), el("span", "life-name", `第 ${run.livesInCycle || index + 1} 世`), el("strong", "life-score", `${run.score || 0}/1000`), el("span", "life-points", `${run.pointsEarned || 0} 点`));
    list.append(row);
  });
  wrap.append(list);
  const home = button("回到轮回入口", "btn_seal_primary_640x144", "primary-btn");
  home.addEventListener("click", renderHome);
  wrap.append(home);
  screenNode.append(wrap);
  view.replaceChildren(screenNode);
}

function renderBioList() {
  const screenNode = screen("bio_list", "bg_bio_list_750x1624");
  const wrap = el("div", "content-column");
  wrap.append(el("p", "eyebrow", "人物志"), el("h1", "screen-title", "在因果里留下名字的人"));
  const list = el("div", "bio-list");
  Object.entries(content.characterBiographies || {}).forEach(([id, person], index) => {
    const card = panel("bio-card", "frame_character_card_700x260");
    card.append(image(`icon_character_0${index + 1}_160x160`, "bio-icon", person.name), el("div", "bio-copy"));
    card.lastChild.append(el("h2", "panel-title", person.name), el("p", "screen-copy", person.title));
    const open = linkButton("查看切片", () => renderBioDetail(id));
    card.append(open);
    list.append(card);
  });
  const back = linkButton("返回", renderHome);
  wrap.append(list, back);
  screenNode.append(wrap);
  view.replaceChildren(screenNode);
}

function renderBioDetail(id) {
  const person = content.characterBiographies?.[id];
  const screenNode = screen("bio_detail", "bg_bio_detail_750x1624");
  const wrap = el("div", "content-column");
  wrap.append(el("p", "eyebrow", person?.title || "人物切片"), el("h1", "screen-title", person?.name || "未名者"));
  const list = el("ol", "slice-list");
  for (const slice of person?.slices || []) list.append(el("li", "slice-row", slice));
  wrap.append(list, linkButton("返回人物志", renderBioList));
  screenNode.append(wrap);
  view.replaceChildren(screenNode);
}

function renderHistory() {
  const history = game.history();
  const screenNode = screen("history", "bg_history_750x1624");
  const wrap = el("div", "content-column");
  wrap.append(el("p", "eyebrow", "历史"), el("h1", "screen-title", "旧世记录"));
  const list = el("div", "history-list");
  if (!history.length) list.append(el("p", "screen-copy", "还没有走完一世。"));
  for (const run of history) {
    const row = panel("history-row-card", "frame_memory_700x180");
    row.append(el("strong", "history-ending", `${run.endingTitle || "未知结局"} · 第 ${run.livesInCycle || 1} 世`), el("span", "history-score", `${run.score || 0}/1000 · ${run.pointsEarned || 0} 点`));
    list.append(row);
  }
  wrap.append(list, linkButton("返回", renderHome));
  screenNode.append(wrap);
  view.replaceChildren(screenNode);
}

function routeSnapshot(snapshot) {
  if (!snapshot) { renderHome(); return; }
  if (snapshot.ledger?.deathWindowState === "exhausted") { renderCliff("lifespan_exhausted"); return; }
  renderEvent(snapshot, snapshot.livesInCycle === 1 ? "event_guide" : "event_later");
}

function routeTransition(transition) {
  if (!transition || transition.error) { renderHome(); return; }
  if (transition.kind === "preparation") { renderPreparation(transition.snapshot); return; }
  if (transition.kind === "breakthrough") { renderBreakthrough(transition.snapshot); return; }
  if (transition.kind === "outcome" || transition.kind === "resolved") { renderContinuation(transition); return; }
  if (transition.kind === "event") { routeSnapshot(transition.snapshot); return; }
  if (transition.kind === "interlude") { renderInterlude(transition.snapshot, () => routeTransition(game.advance())); return; }
  if (transition.kind === "fate_window") { renderFateWindow(transition.window, transition.snapshot); return; }
  if (transition.kind === "karma_knock") { renderKarma(transition.snapshot); return; }
  if (transition.kind === "cliff") { renderCliff(transition.reason, null); return; }
  if (transition.kind === "finished") {
    if (transition.runResult) renderCliff("mid_life_stop", transition.runResult);
    else renderCliff("mid_life_stop");
    return;
  }
  renderHome();
}

window.addEventListener("beforeunload", () => {
  game.saveCurrentSnapshot();
});

renderHome();
