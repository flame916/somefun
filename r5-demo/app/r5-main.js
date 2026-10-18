import { createR5Runtime } from "../engine/r5-runtime.js";
import { R5LocalSaveStore } from "./r5-storage.js";

const view = document.querySelector("#view");
const toast = document.querySelector("#toast");
const [pack, definitions, seed, legacyReference] = await Promise.all([
  readJson("../content/r5-world-pack-v1.json"), readJson("../content/r5-event-definitions-v1.json"),
  readJson("../content/r5-start-scenario-v1.json"), readJson("../content/r4-legacy-storage-reference-v1.json")
]);
const namespace = pack.saveNamespace;
const slotId = `${namespace}:active`;
const storage = new R5LocalSaveStore();
const dimensions = pack.r5RebirthRules.dimensions;
const dimNames = { naturalTalent: "资质", aptitude: "悟性", bloodline: "血脉", fortune: "机缘" };
const dimIcons = { naturalTalent: "natural_talent", aptitude: "aptitude", bloodline: "bloodline", fortune: "fortune" };
const origins = [
  { id: "herbal", label: "药农人家", desc: "从草木与乡里生计起步。" },
  { id: "sect", label: "宗门旁支", desc: "身在修行门庭边缘，凭选择寻找机缘。" },
  { id: "system", label: "异世来客", desc: "从陌生与变故中开始，在青墟界立足。" }
];
let engine = null;
let toastTimer = null;
let busy = false;
let saveState = "尚未保存";
let lastReceipt = null;

async function readJson(path) {
  const response = await fetch(new URL(path, import.meta.url));
  if (!response.ok) throw new Error(`规则资源读取失败：${path} (${response.status})`);
  return response.json();
}
function el(tag, cls = "", text = "") {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== "") node.textContent = String(text);
  return node;
}
function img(name, alt, cls = "r5-icon") {
  const image = el("img", cls);
  image.src = new URL(`../ui/assets/${name}.png`, import.meta.url).href;
  image.alt = alt;
  image.width = 48;
  image.height = 48;
  return image;
}
function button(label, fn, cls = "button") {
  const node = el("button", cls, label);
  node.type = "button";
  node.addEventListener("click", fn);
  return node;
}
function panel(title, copy = "", frame = "frame_card_700x260") {
  const node = el("section", "paper-card r5-card");
  node.style.setProperty("--r5-frame", `url("${new URL(`../ui/assets/${frame}.png`, import.meta.url).href}")`);
  node.append(el("h2", "card-title", title));
  if (copy) node.append(el("p", "muted", copy));
  return node;
}
function notice(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3400);
}
function snap() { return engine?.snapshot() || null; }
function state() { return engine?.save() || null; }
function txId(kind) { return `${namespace}:${snap().character.lifeIndex}:${kind}:${crypto.randomUUID()}`; }
function mount(node, { preserveScroll = false } = {}) {
  const y = window.scrollY;
  view.replaceChildren(node);
  if (!preserveScroll) window.scrollTo({ top: 0, behavior: "instant" });
  else window.scrollTo({ top: y, behavior: "instant" });
}
function shell(nodeId, title, subtitle = "", background = "bg_home_750x1624") {
  const root = el("div", "screen r5-screen");
  root.dataset.node = nodeId;
  root.style.setProperty("--page-bg", `url("${new URL(`../ui/assets/${background}.png`, import.meta.url).href}")`);
  const header = el("header", "screen-header");
  header.append(el("span", "eyebrow", "青墟界 · 人生因果"), el("h1", "screen-title", title));
  if (subtitle) header.append(el("p", "screen-copy", subtitle));
  const status = el("p", "r5-save-status", `存档：${saveState}`);
  status.setAttribute("aria-live", "polite");
  header.append(status);
  root.append(header);
  return root;
}
async function persist() {
  if (!engine) return false;
  saveState = "保存中…";
  document.querySelector(".r5-save-status")?.replaceChildren(document.createTextNode(`存档：${saveState}`));
  try {
    await storage.save(slotId, engine.toSaveDto());
    saveState = "已保存";
    return true;
  } catch (error) {
    saveState = "保存失败";
    notice(`保存未完成；旧存档仍保留：${error.message}`);
    return false;
  }
}
async function restore() {
  const dto = await storage.load(slotId);
  if (!dto) return false;
  engine = createR5Runtime({ pack, definitions, seedConfig: seed });
  engine.restoreDto(dto);
  saveState = "已恢复";
  return true;
}
async function start(origin) {
  if (busy) return;
  busy = true;
  try {
    engine = createR5Runtime({ pack, definitions, seedConfig: seed });
    engine.initialize(origin, `qingxu-${crypto.randomUUID()}`, `world-${crypto.randomUUID()}`);
    if (await persist()) renderHome();
  } catch (error) { pageError(error); }
  finally { busy = false; }
}
function rootEntry(savedDto, oldSave) {
  const root = shell("r5_world_home", "青墟界", "在人间起步，修习、作出选择，见证同一片天地中的人生更迭。");
  const hero = panel("踏入此世", "新局默认使用 R5 四境与转世规则；存档与 R4 旧版彼此隔离。", "frame_role_card_700x340");
  hero.append(img("icon_logo_128x128", "青墟界印记", "r5-logo"));
  if (savedDto) hero.append(button("继续这一世", async () => {
    if (busy) return;
    busy = true;
    try { if (await restore()) renderHome(); }
    catch (error) { pageError(error); }
    finally { busy = false; }
  }, "button primary"));
  hero.append(el("h3", "card-title", "选择来处"));
  for (const origin of origins) {
    const row = el("div", "cause-row origin-card");
    row.append(el("strong", "origin-label", origin.label), el("p", "muted", origin.desc), button("以此身份开始", () => start(origin.id), "button secondary"));
    hero.append(row);
  }
  if (oldSave) {
    const old = panel("R4 旧档案", "旧档只读，R4 → R5 迁移在本版不可用。可导出原始备份，不会写入或改动旧档。", "frame_memory_700x180");
    old.append(button("导出 R4 备份", () => exportLegacy(oldSave), "button secondary"));
    hero.append(old);
  } else hero.append(el("p", "hint", "未发现 R4 旧版存档。"));
  root.append(hero);
  mount(root);
}
function exportLegacy(saved) {
  const blob = new Blob([JSON.stringify(saved, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "qingxu-r4-readonly-backup.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notice("R4 备份已导出；旧存档未作修改。");
}
function profile(s) {
  const character = s.character;
  const current = s.r5.currentStage;
  const clock = s.r5.lifeClock;
  const levels = character.r5DimensionLevels;
  const card = panel("今生角色", "查看此生境界、身体状况与寿命。", "frame_character_card_700x260");
  card.append(img("icon_realm_96x96", "当前境界"), el("h3", "r5-stage-name", `${current?.name || "未修凡俗"} · 第 ${current?.progressionRank || 0} 阶`));
  const date = r5Date(s.worldDay);
  card.append(el("p", "date-line", `第 ${character.lifeIndex} 世 · ${date.year} 年 ${date.month} 月 ${date.day} 日 · ${locationName(character.location)}`));
  card.append(el("p", "date-line", `年龄 ${Math.floor((s.worldDay - clock.birthDay) / 360)} 岁 · 预计寿尽：世界第 ${clock.deathDay} 日`));
  card.append(el("p", "date-line", `健康 ${character.health}${Number.isFinite(character.maxHealth) ? `/${character.maxHealth}` : ""} · 财富 ${character.wealth ?? 0} · 声望 ${character.fame ?? 0}`));
  const dimensionsCard = panel("永久累计维度", "这些等级会随转世继续累计，不等于当前境界或前世履历。", "frame_card_700x260");
  const grid = el("div", "stats-grid");
  for (const key of dimensions) {
    const chip = el("div", "stat-chip r5-dim-chip");
    chip.append(img(`icon_dim_${dimIcons[key]}_96x96`, dimNames[key]), el("span", "", `${dimNames[key]} ${levels[key] || 0}`));
    grid.append(chip);
  }
  dimensionsCard.append(grid);
  return [card, dimensionsCard];
}
function renderHome() {
  const s = snap();
  if (!s) return renderEntry();
  if (!s.character.alive) return renderSettlement();
  const root = shell("r5_world_home", "此生修行", `世界第 ${s.worldDay} 日 · 第 ${s.character.lifeIndex} 世`);
  const [identity, dimensionsCard] = profile(s);
  root.append(identity, dimensionsCard);
  if (s.r5.rebirth.receipt?.newLife === s.character.lifeIndex) root.append(successorCard(s));
  root.append(actionPanel(s));
  root.append(sourcePanel(s));
  root.append(worldPanel(s));
  const nav = el("nav", "bottom-nav");
  nav.setAttribute("aria-label", "人生档案");
  for (const [label, action] of [["境界", () => renderProgression(s)], ["功法", () => renderSkills(s)], ["能力", () => renderCapabilities(s)], ["世界/市集", () => renderWorld(s)], ["存档", async () => { if (await persist()) notice("此世已保存。"); }]]) nav.append(button(label, action, "nav-item"));
  root.append(nav);
  mount(root);
}
function actionPanel(s) {
  const card = panel("下一步行动", "行动会消耗对应时间；若途中遇到突发变故，未完成的部分不会算作修行成果。", "frame_dao_card_700x320");
  const learned = s.r5.skills;
  const publicBoard = s.world.dailyServiceBoards?.publicLesson;
  if (!learned.some((row) => row.skillId === "r5_skill_martial_form")) {
    const atTeacher = publicBoard?.locationId === s.character.location;
    const courseLabel = publicBoard?.status !== "open" ? "公开课程暂未开放" : atTeacher ? "参加公开武学课程" : `前往${locationName(publicBoard.locationId)}公开课程`;
    card.append(button(courseLabel, () => publicBoard?.status === "open" && !atTeacher
      ? act("前往公开课程", () => engine.performWorldAction("r4_action_travel", { destination: publicBoard.locationId }))
      : act("学习", () => engine.learnPublicMartialForm(txId("public-course"))), "button primary"));
  }
  const cultivationBoard = s.world.dailyServiceBoards?.publicLesson;
  const knowsCultivation = learned.some((row) => row.discipline === "cultivation");
  if (!knowsCultivation && cultivationBoard?.status === "open" && s.character.location === cultivationBoard.locationId && engine.isEventAvailable("r4_acq_dao01")) {
    card.append(button("向公开教师学习导引术", () => act("学习修行功法", () => engine.resolveWorldChoice("r4_acq_dao01", "study_dao01", txId("public-cultivation-course"))), "button primary"));
  }
  for (const skill of learned) {
    const name = skillName(skill.skillId);
    card.append(button(`修习「${name}」`, () => act("修习", () => engine.trainBlock(skill.skillId, txId(`practice-${skill.skillId}`))), "button secondary"));
  }
  card.append(button("锻炼体魄（正式周期）", () => act("锻体", () => engine.conditioningBlock(txId("conditioning"))), "button secondary"));
  card.append(button("休养恢复", () => act("休养", () => engine.recover(txId("recover"))), "button secondary"));
  const yearButton = button("安度一年（最多 360 日）", advanceYear, "button secondary");
  yearButton.title = "按世界日历逐日推进；突发事件或寿终会提前停下，不会跳过处理。";
  card.append(yearButton);
  const monthButton = button("安度一月（最多 30 日）", () => advanceCalendar(30, "一月"), "button secondary");
  monthButton.title = "按世界日历逐日推进；突发事件或寿终会提前停下，不会跳过处理。";
  card.append(monthButton);
  const weekButton = button("安度一周（最多 7 日）", () => advanceCalendar(7, "周"), "button secondary");
  weekButton.title = "按世界日历逐日推进；突发事件或寿终会提前停下，不会跳过处理。";
  card.append(weekButton);
  const dayButton = button("安度一日（最多 1 日）", () => advanceCalendar(1, "日"), "button secondary");
  dayButton.title = "按世界日历推进一天；突发事件或寿终会提前停下，不会跳过处理。";
  card.append(dayButton);
  const next = nextPlayableStage(s);
  if (next) {
    const chance = engine.breakthroughChance(next.id);
    card.append(button(`突破预览：${next.name}${chance ? ` · 当前成功率 ${(chance / 100).toFixed(1)}%` : " · 尚有条件未满足"}`, () => renderBreakthrough(s, next), "button secondary"));
  }
  const travel = document.createElement("select");
  travel.className = "button secondary r5-select";
  travel.setAttribute("aria-label", "选择旅行目的地");
  travel.append(new Option("按真实路费旅行…", ""));
  for (const id of s.character.knownLocations || []) if (id !== s.character.location) travel.append(new Option(locationName(id), id));
  travel.addEventListener("change", () => { if (travel.value) act("旅行", () => engine.performWorldAction("r4_action_travel", { destination: travel.value })); });
  card.append(travel);
  return card;
}
function sourcePanel(s) {
  const card = panel("身边的事", "处理已经发生的邀约、委托和日常机会。", "frame_card_700x260");
  const road = s.world.dailyServiceBoards?.road;
  const keeper = s.world.npcRecords?.r4_npc_waykeeper;
  if (s.character.location === "r4_loc_willow_market" && road?.status === "active" && road.maintenanceNotice?.status === "active"
    && road.verifiedRoute?.verified === true && road.sign?.status === "damaged" && keeper?.alive === true && keeper?.onDuty === true
    && keeper.locationId === s.character.location && s.character.knownLocations?.includes("r4_loc_ashspring") && s.world.services?.waykeeper?.active === true) {
    card.append(button("向路务员申请今日路标修缮许可", () => act("路标维护许可", () => {
      const eventId = "r4_ev_daily_roadmarker";
      const authority = engine.acceptDailyBoardAuthority(eventId);
      if (authority?.kind !== "authority") return { error: authority?.error || "许可未获批准" };
      const source = engine.openDailyBusinessSource(eventId);
      return source?.kind === "source" ? { status: "completed", source } : { error: source?.error || "今日路标来源未开放" };
    }), "button secondary"));
  }
  const demand = s.world.demandInstance;
  if (demand?.status === "open" || demand?.status === "available") {
    card.append(button("完成今日委托", () => act("委托", () => engine.resolveWorldChoice("r4_daily_entrust", "accept_and_fulfill", txId("daily-work"))), "button primary"));
  }
  const localStock = Number(s.world.locations?.[s.character.location]?.harvestableStock || 0);
  if (localStock > 0) card.append(button(`采集草药（余 ${localStock} 株）`, () => act("采药", () => engine.resolveWorldChoice("r4_daily_herb", "harvest_for_self", txId("daily-herb"))), "button secondary"));
  const availableById = new Map((s.availableEvents || []).map((event) => [event.id, event]));
  const showMemoryEvent = (eventId) => {
    const memories = Object.keys(s.character.r5UnpracticedMemory || {});
    if (!memories.length || Number(s.character.lifeIndex) <= 1) return false;
    const awake = state()?.facts?.r4_fact_memory_awakened?.lifeIndex === s.character.lifeIndex;
    if (eventId === "r4_ev_era_memory_after_migration") return awake;
    return eventId !== "r4_memory_awakening" || !awake;
  };
  const dueById = new Map((s.world.worldEventQueue || [])
    .filter((row) => row.day <= s.worldDay && availableById.has(row.eventId)
      && (!["r4_memory_awakening", "r4_ev_era_memory_after_migration"].includes(row.eventId) || showMemoryEvent(row.eventId)))
    .map((row) => [row.eventId, row]));
  // These two character-life memory events are available from current-life facts,
  // rather than a queued world notice; surface them only when R5 marks them available.
  for (const eventId of ["r4_memory_awakening", "r4_ev_era_memory_after_migration"]) {
    if (availableById.has(eventId) && showMemoryEvent(eventId) && !dueById.has(eventId)) dueById.set(eventId, { eventId, day: s.worldDay, instanceId: "current-life-memory" });
  }
  // Runtime-visible aftermath choices can be eligible from verified crisis facts
  // without their own dated queue row. Surface only choices the runtime marks available.
  for (const eventId of ["r4_l7_after_window_clue", "r4_l8_root_remedy"]) {
    if (availableById.has(eventId) && !dueById.has(eventId)) dueById.set(eventId, { eventId, day: s.worldDay, instanceId: "verified-crisis-aftermath" });
  }
  const due = [...dueById.values()];
  if (!due.length) card.append(el("p", "muted", "目前没有已到期的公开事件来源。可查看世界记录，或通过旅行与境界行动继续生活。"));
  for (const row of due.slice(0, 6)) {
    const event = availableById.get(row.eventId);
    const titleText = event.presentation?.title || "眼前的邀约";
    const detailText = event.presentation?.description || "有人带来一条消息。选择前先确认自己的处境。";
    const choices = panel(titleText, detailText);
    choices.dataset.eventId = event.id;
    const labeledOptions = (event.options || []).filter((option) => option.available).map((option) => ({ option, label: optionLabel(event.id, option) })).filter((row) => row.label);
    if (!labeledOptions.length) choices.append(el("p", "muted", "这条消息暂无可读的处理选项。"));
    for (const { option, label } of labeledOptions) {
      const choice = button(label, () => act(titleText, () => engine.resolveWorldChoice(event.id, option.id, txId(`event-${event.id}-${option.id}`))), "button secondary");
      choice.dataset.optionId = option.id;
      choices.append(choice);
    }
    card.append(choices);
  }
  return card;
}
function worldPanel(s) {
  const card = panel("世界与因果", "只显示角色亲历或听闻的内容；尚未证实的传闻仍是传闻。", "frame_memory_700x180");
  const rows = s.r5.scoreLedger.factLog || [];
  if (!rows.length) card.append(el("p", "muted", "尚无已记录的本世因果。"));
  for (const row of [...rows].slice(-5).reverse()) card.append(el("p", "cause-row", `${row.day ?? row.completedDay ?? s.worldDay} 日 · ${eventName(row.eventId) || skillName(row.skillId) || capabilityName(row.capabilityId) || row.kind || row.status || "人生记录"}`));
  return card;
}
function successorCard(s) {
  const receipt = s.r5.rebirth.receipt;
  const paidStage = Number(receipt.stageCostUnits || 0) > 0;
  const retainedStage = paidStage ? stageName(receipt.retainedStageId) : "未保留境界";
  const card = panel("本次转世回执", "只列本次实际带入的内容；未保留技能仅作为记忆线索。", "frame_birth_card_700x300");
  card.append(el("p", "date-line", paidStage ? `付费保留境界：${retainedStage} · ${receipt.stageCostUnits} 点` : retainedStage));
  card.append(el("p", "date-line", `保留技能：${receipt.retainedSkillIds.length ? receipt.retainedSkillIds.map(skillName).join("、") : "无"}`));
  card.append(el("p", "date-line", `记忆线索：${receipt.unpracticedMemorySkillIds.length ? receipt.unpracticedMemorySkillIds.map(skillName).join("、") : "无"}`));
  card.append(el("p", "muted", "前世物品、关系、许可与私人知识不会自动继承。"));
  return card;
}
function nextPlayableStage(s) {
  const rank = Number(s.r5.currentStage?.progressionRank || 0);
  return pack.r5ProgressionRules.stages.find((row) => row.availability === "playable" && row.progressionRank === rank + 1) || null;
}
function locationName(id) {
  const labels = { r4_loc_ashspring: "灰泉镇", r4_loc_willow_market: "柳溪集", r4_loc_furnace_lane: "炉巷", r4_loc_mirror_stage: "照影台", r4_loc_echo_pass: "回声关" };
  return id ? labels[id] || "未知地点" : "所在未明";
}
function stageName(id) { return pack.r5ProgressionRules.stages.find((row) => row.id === id)?.name || id; }
function optionLabel(eventId, option) {
  const optionId = option.id;
  const labels = {
    "r4_m1_invite:accept_mark": "接受共鸣印邀请", "r4_m1_invite:refuse_mark": "婉拒邀请", "r4_m1_invite:observe_demo": "先观察示范",
    "r4_acq_family:accept_record": "确认药户履历", "r4_acq_family:decline_family_trade": "婉拒这份安排",
    "r4_daily_entrust:accept_and_fulfill": "接受并完成委托", "r4_daily_entrust:accept_and_fail": "接下委托但不保证完成", "r4_daily_entrust:decline": "暂不接委托",
    "r4_daily_herb:harvest_for_self": "采集草药", "r4_daily_herb:help_other_gatherer": "帮忙采集", "r4_daily_herb:leave_stock": "留给后来的人",
    "r4_acq_dao01:study_dao01": "学习导引术", "r4_acq_dao01:learn_breath_first": "先学调息法", "r4_acq_dao01:refuse_study": "暂不学习",
    "r4_birth_story:help_household": "帮家里完成早年日常", "r4_birth_story:respond_to_neighbor": "回应邻里请求", "r4_birth_story:fulfill_early_duty": "履行已答应的责任",
    "r4_l7_after_window_clue:trace_surviving_source": "追查仍存的源头账链",
    "r4_l8_root_remedy:shut_source_and_links": "封闭采灵根源及关联",
    "r4_memory_awakening:recognize_memory": "接住这次觉醒",
    "r4_ev_era_memory_after_migration:rebuild_from_memory": "按当前身体重练记忆中的功法",
    "r4_ev_era_memory_after_migration:study_public_alternative": "改用新教材从基础学习",
    "r4_ev_era_memory_after_migration:keep_memory_unpracticed": "暂不训练，保留记忆线索"
  };
  const mapped = labels[`${eventId}:${optionId}`];
  if (mapped) return mapped;
  const text = option.text?.trim() || "";
  return /[\u3400-\u9fff]/.test(text) ? text : "";
}
function eventName(id) { return definitions.events.find((row) => row.id === id)?.presentation?.title || ""; }
function skillName(id) {
  const labels = { r5_skill_martial_form: "基础武学", r4_skill_dao01: "导引术", r4_skill_dao02: "丹术", r4_skill_array: "阵图术", r4_skill_stealth: "敛息术" };
  return labels[id] || "未命名功法";
}
function disciplineName(id) { return ({ martial: "武学", cultivation: "修行" })[id] || "其他"; }
function skillStatus(id) { return id === "completed" ? "已完成" : id === "in_progress" ? "进行中" : "当前记录"; }
function capabilityName(id) { return pack.r5ProgressionRules.capabilityContracts?.[id]?.playerName || ""; }
function r5Date(worldDay) {
  const calendar = pack.calendar;
  const absolute = Number(worldDay) - Number(calendar.epochDay || 0);
  const year = Number(calendar.epochYear) + Math.floor(absolute / (calendar.daysPerMonth * calendar.monthsPerYear));
  const withinYear = ((absolute % (calendar.daysPerMonth * calendar.monthsPerYear)) + calendar.daysPerMonth * calendar.monthsPerYear) % (calendar.daysPerMonth * calendar.monthsPerYear);
  return { year, month: Math.floor(withinYear / calendar.daysPerMonth) + 1, day: withinYear % calendar.daysPerMonth + 1 };
}
async function act(label, operation) {
  if (busy) return;
  busy = true;
  let rerender = false;
  try {
    let result = await operation();
    while (result?.kind === "progress") result = engine.continueWorldAction(Math.max(1, result.transaction?.durationDays || 1));
    if (result?.status === "rejected" || result?.error || result?.kind === "interrupted") {
      const reason = result.reason || result.error || result.eventId || result.kind;
      notice(`${label}未完成：${reason}`);
      if (!snap().character.alive) renderHome();
      return;
    }
    if (result?.kind === "result" || result?.kind === "interrupted") engine.acknowledgeResult();
    if (await persist()) {
      if (result?.status) notice(`${label}已按运行时结算。`);
      rerender = true;
    }
  } catch (error) { notice(`${label}未完成：${error.message}`); }
  finally {
    busy = false;
    if (rerender) renderHome();
  }
}
async function advanceYear() {
  return advanceCalendar(360, "一年");
}
async function advanceCalendar(days, label) {
  if (busy) return;
  const before = snap();
  let rerender = false;
  busy = true;
  try {
    const result = engine.advanceWorldDays(days);
    const after = snap();
    const elapsed = Math.max(0, after.worldDay - before.worldDay);
    if (!await persist()) return;
    rerender = true;
    if (!after.character.alive) {
      notice(`世界日历推进 ${elapsed} 日，此生寿终。`);
      return;
    }
    const stopCopy = result.stoppedAtWorldNode === "world_event_due"
      ? "途中有需要亲自处理的变故，已停在事发之日。"
      : result.stoppedAtWorldNode === "death" ? "此生已尽。" : `这一${label}已安然过去。`;
    notice(`日历前行 ${elapsed} 日。${stopCopy}`);
  } catch (error) {
    notice(`日历未能继续：${error.message}`);
  } finally {
    busy = false;
    if (rerender) renderHome();
  }
}
function renderProgression(s) {
  const root = shell("r5_progression_record", "境界履历", "历史达成只作履历；只有本世真实突破或本次付费保留会影响当前解锁。", "bg_study_750x1624");
  const current = s.r5.currentStage;
  const history = s.r5.attainment;
  const stages = pack.r5ProgressionRules.stages;
  const registered = stages.length;
  const playableCount = stages.filter((row) => row.availability === "playable").length;
  const groups = [
    { title: "起步", rows: stages.filter((row) => row.domain === "origin") },
    { title: "凡俗武者", rows: stages.filter((row) => row.domain === "warrior") },
    { title: "通灵境", rows: stages.filter((row) => row.domain === "spirit" || row.domain === "spirit_gate") },
    { title: "羽化里程碑", rows: stages.filter((row) => row.domain === "ascendant" || row.domain === "molt") },
    { title: "暂未开放", rows: stages.filter((row) => row.domain === "immortal") }
  ];
  for (const group of groups) {
    if (!group.rows.length) continue;
    const card = panel(group.title, "按注册顺序逐阶达成；缺少条件时会显示真实缺口。", "frame_tome_700x520");
    for (const stage of group.rows) {
      const attained = history.some((row) => row.lifeIndex === s.character.lifeIndex && row.stageId === stage.id && row.status === "success");
      const locked = stage.availability !== "playable";
      const row = el("div", `cause-row ${locked ? "r5-locked" : ""}`);
      row.append(img("frame_timeline_node_96x96", attained ? "已达成" : locked ? "未开放" : "可玩境界", "r5-timeline-icon"), el("strong", "", `${stage.name}${stage.id === current.id ? " · 当前" : ""}`));
      const gate = stage.requiredGateEvidence ? fateGateLabel(stage.requiredGateEvidence) : "";
      row.append(el("p", "date-line", locked ? "本版保留位，不可进入" : attained ? "本世已验证达成" : `${stage.requiredDisciplines?.length ? stage.requiredDisciplines.map(disciplineName).join("、") : "修习"} ${stage.practiceUnitsRequired ?? 0} · 悟性 ${stage.understandingUnitsRequired ?? 0} · 锻体 ${stage.physicalConditioningUnitsRequired ?? 0}${gate ? ` · 顺序关：${gate}` : ""}`));
      if (!locked && stage.id === current.id) row.append(el("p", "hint", "当前所在境界；只有下一阶可尝试突破。"));
      if (!locked && stage.id === nextPlayableStage(s)?.id) row.append(button("查看本阶条件", () => renderBreakthrough(s, stage), "button secondary"));
      card.append(row);
    }
    root.append(card);
  }
  root.append(el("p", "muted", `登记 ${registered} 阶：${playableCount} 阶可玩（含起点，最多晋升 ${playableCount - 1} 次），${registered - playableCount} 阶保留位。`));
  const hist = panel("历史达成", "旧世达成不自动解锁本世能力；仅用于回看。", "frame_memory_700x180");
  const all = s.r5.scoreLedger.progression.attainment || [];
  if (!all.length) hist.append(el("p", "muted", "尚无境界达成记录。"));
  for (const row of [...all].reverse().slice(0, 12)) hist.append(el("p", "cause-row", `第 ${row.lifeIndex} 世 · ${stageName(row.stageId)} · ${row.status}`));
  root.append(hist);
  const next = nextPlayableStage(s);
  if (next?.requiredGateEvidence) root.append(fateGatePanel(s, next));
  root.append(button("返回首页", renderHome, "button"));
  mount(root);
}
function fateGatePanel(s, nextStage) {
  const gateId = nextStage.requiredGateEvidence;
  const title = fateGateLabel(gateId);
  const card = panel(`晋阶前的命关：${title}`, "凭据只取自本世真实记录；提交后由运行时核验并留存。", "frame_fate_card_700x360");
  const saved = state() || {};
  const currentGates = (saved.facts?.r5_fact_fate_gate || []).filter((row) => row.lifeIndex === s.character.lifeIndex && row.gateId === gateId && (gateId === "change_fate_outcome" ? ["prepared", "verified"].includes(row.status) : row.status === "verified"));
  if (currentGates.length) {
    card.append(el("p", "hint", gateId === "change_fate_outcome" && currentGates[0].status === "prepared" ? "真实后果已登记为待处理；完成对应事件后会核验结果。" : "本世命关已有有效凭据。"));
    return card;
  }
  const recordMap = new Map();
  for (const row of [...(saved.causeLog || []), ...(saved.r5LifeLedger?.factLog || [])]) {
    if (row?.causeId && Number(row.lifeIndex || s.character.lifeIndex) === s.character.lifeIndex && Number(row.day ?? row.worldDay ?? 0) <= s.worldDay) recordMap.set(row.causeId, row);
  }
  const records = [...recordMap.values()];
  if (gateId === "know_fate_records") {
    const first = gateRecordSelect(records, "选择第一条本世经历记录");
    const second = gateRecordSelect(records, "选择另一条不同的经历记录");
    const status = el("p", "hint", records.length < 2 ? "目前还没有两条不同的本世记录可供对照。" : "选择两条不同的记录；历史世界不会因此改变，也不会预知未来。");
    const submit = button("对照两条记录", () => submitFateGate(gateId, [first.value, second.value], null), "button secondary");
    submit.disabled = records.length < 2;
    card.append(first, second, status, submit);
  } else if (gateId === "accept_fate_limit") {
    const source = gateRecordSelect(records, "选择一条能说明当世限制的记录");
    const choices = [];
    if (Number(saved.r5LifeLedger?.lifeClock?.deathDay || s.character.deathDay) > s.worldDay) choices.push(["finite_lifespan", "有限寿数"]);
    if ((saved.r5LifeLedger?.skills || []).some((row) => row.lifeIndex === s.character.lifeIndex)) choices.push(["practiced_method", "已学功法与当前修习程度"]);
    if (Number(s.character.wealth) >= 0) choices.push(["current_resources", "当前财物与持有物"]);
    const choice = document.createElement("select");
    choice.className = "button secondary r5-select";
    choice.setAttribute("aria-label", "选择要面对的当世限制");
    choice.append(new Option(choices.length ? "选择一项当世限制…" : "当前没有可确认的限制", ""));
    for (const [value, label] of choices) choice.append(new Option(label, value));
    const submit = button("确认这项限制", () => submitFateGate(gateId, [source.value], choice.value), "button secondary");
    submit.disabled = !choices.length;
    card.append(source, choice, el("p", "hint", "需先完成知命对照；这里确认的是可核验的当世事实，不是认定命运不可改变。"), submit);
  } else if (gateId === "change_fate_outcome") {
    const event = definitions.events.find((row) => row.id === "r4_ev_era_faction_successor");
    const source = event ? readPath(saved, event.runtimeBinding?.sourcePath) : null;
    const causeId = event ? readPath(saved, event.runtimeBinding?.causePath) : null;
    const availableEvent = event ? engine.eventView(event.id) : null;
    const live = Boolean(source?.status === "open" && source.lifeIndex === s.character.lifeIndex && source.worldId === saved.world?.id && Number.isSafeInteger(source.expiresDay) && source.expiresDay >= s.worldDay && causeId === source.causeId && engine.isEventAvailable(event.id) && (saved.facts?.r5_fact_fate_gate || []).some((row) => row.lifeIndex === s.character.lifeIndex && row.gateId === "accept_fate_limit" && row.status === "verified"));
    const action = availableEvent?.options?.filter((row) => row.available && row.id === "audit_public_tools").map((row) => ({ id: row.id, label: optionLabel(event.id, row) || row.text })).filter((row) => row.label) || [];
    if (live && action.length) {
      const choice = document.createElement("select");
      choice.className = "button secondary r5-select";
      choice.setAttribute("aria-label", "选择如何面对这项未完后果");
      choice.append(new Option("选择一种有凭据的处理方式…", ""));
      for (const row of action) choice.append(new Option(row.label, row.id));
      const submit = button("登记真实后果", () => submitFateGate(gateId, [causeId], choice.value), "button secondary");
      submit.disabled = !causeId;
      card.append(el("p", "date-line", "发现本世仍开放的宗门交接事项；登记后晋阶可尝试，事项仍须在后续按真实事件处理。"), choice, submit);
    } else card.append(el("p", "hint", "还没有符合条件的未完事项；需要先完成信命关，并在本世遇到仍开放的宗门交接事项。"));
  }
  return card;
}
function gateRecordSelect(records, placeholder) {
  const select = document.createElement("select");
  select.className = "button secondary r5-select";
  select.setAttribute("aria-label", placeholder);
  select.append(new Option(placeholder, ""));
  for (const row of records) select.append(new Option(`${row.day ?? row.worldDay ?? "当日"} 日 · ${eventName(row.eventId) || skillName(row.skillId) || "本世经历"}`, row.causeId));
  return select;
}
function readPath(root, path) { return String(path || "").split(".").filter(Boolean).reduce((value, key) => value?.[key], root); }
async function submitFateGate(gateId, sourceIds, choiceId) {
  if (busy || sourceIds.some((id) => !id) || (gateId === "know_fate_records" && new Set(sourceIds).size !== 2) || (gateId !== "know_fate_records" && !choiceId)) return;
  busy = true;
  try {
    const result = engine.recordFateGateEvidence(gateId, sourceIds, txId(`fate-gate-${gateId}`), choiceId);
    if (typeof result === "string" || result?.status === "rejected") {
      notice("命关未能记录：当前来源、顺序或事实条件不符合运行时核验。未推进境界。");
      return;
    }
    if (await persist()) {
      notice("本世命关凭据已由运行时核验并保存；晋阶仍需满足修习条件。" );
      renderProgression(snap());
    }
  } catch { notice("命关未能记录：运行时核验未通过，境界未推进。"); }
  finally { busy = false; }
}
function renderBreakthrough(s, stage) {
  const chance = engine.breakthroughChance(stage.id);
  const currentSkills = s.r5.skills;
  const skill = currentSkills.find((row) => !stage.requiredDisciplines?.length || stage.requiredDisciplines.includes(row.discipline));
  const gateRows = state()?.facts?.r5_fact_fate_gate || [];
  const gateAcceptable = stage.requiredGateEvidence === "change_fate_outcome" ? ["verified", "prepared"] : ["verified"];
  const gateReady = !stage.requiredGateEvidence || gateRows.some((row) => row.lifeIndex === s.character.lifeIndex && row.gateId === stage.requiredGateEvidence && gateAcceptable.includes(row.status));
  const healthCost = Number(pack.r5ProgressionRules.rules?.breakthroughHealthCost ?? 2);
  const attemptDays = Number(pack.r5ProgressionRules.rules?.breakthroughAttemptDays ?? 1);
  const canAttempt = chance > 0 && gateReady && s.character.alive && Number(s.character.health || 0) > 0;
  const root = shell("r5_breakthrough_preview", `突破预览 · ${stage.name}`, "尝试前核对本世功法、训练、理解与身体条件；失败不会授予境界。", "bg_fate_750x1624");
  const card = panel("真实门槛", "以下数值均读取境界规则和当前技能/身体状态。", "frame_card_700x260");
  const eligibleSkills = currentSkills.filter((row) => !stage.requiredDisciplines?.length || stage.requiredDisciplines.includes(row.discipline));
  const bestMastery = Math.max(0, ...eligibleSkills.map((row) => Number(row.masteryMilli || 0)));
  const bestUnderstanding = Math.max(0, ...eligibleSkills.map((row) => Number(row.understandingMilli || 0)));
  card.append(el("p", "date-line", `所需功法：${(stage.requiredDisciplines || []).map(disciplineName).join("、") || "无指定"} · ${skill ? `本世已有${disciplineName(skill.discipline)}功法` : "缺少合格功法"}`));
  card.append(el("p", "date-line", `本世最高修习 ${bestMastery}/${stage.practiceUnitsRequired ?? 0} · 最高理解 ${bestUnderstanding}/${stage.understandingUnitsRequired ?? 0}`));
  card.append(el("p", "date-line", `锻体 ${s.character.r5PhysicalConditioningUnits || 0}/${stage.physicalConditioningUnitsRequired ?? 0} · 健康 ${s.character.health}`));
  card.append(el("p", "date-line", `成功率 ${chance ? `${(chance / 100).toFixed(1)}%` : "尚未具备修习门槛"} · 尝试耗时 ${attemptDays} 日、消耗 ${healthCost} 点健康；失败不晋级。`));
  if (stage.requiredGateEvidence) card.append(el("p", gateReady ? "hint" : "warning", `顺序命运关：${fateGateLabel(stage.requiredGateEvidence)} · ${gateReady ? "已留有本世凭据" : "尚缺本世有效凭据，不能尝试"}`));
  const attempt = button(canAttempt ? "按正式规则尝试" : "条件未齐，暂不能尝试", () => attemptBreakthrough(stage), "button primary");
  attempt.disabled = !canAttempt;
  card.append(attempt);
  root.append(card, button("返回境界履历", () => renderProgression(s), "button secondary"));
  mount(root);
}
async function attemptBreakthrough(stage) {
  if (busy) return;
  busy = true;
  try {
    const before = snap();
    const result = await engine.attemptBreakthrough(stage.id, txId(`breakthrough-${stage.id}`));
    if (result?.status === "rejected" || result?.error) {
      notice("突破未能开始：运行时条件未满足，没有扣除本次突破代价。");
      return;
    }
    if (!await persist()) return;
    const after = snap();
    const elapsed = Math.max(0, Number(after.worldDay) - Number(before.worldDay));
    const healthLost = Math.max(0, Number(before.character.health) - Number(after.character.health));
    notice(result.status === "success"
      ? `突破成功，已达${stage.name}；耗时 ${elapsed} 日，健康变化 ${healthLost} 点。`
      : `突破未成，境界不变；耗时 ${elapsed} 日，健康变化 ${healthLost} 点。可恢复后再按规则尝试。`);
    renderProgression(after);
  } catch {
    notice("突破未完成：运行时没有返回可保存的结果，请核对本世存档后再继续。");
  } finally { busy = false; }
}
function fateGateLabel(id) {
  return ({ know_fate_records: "知命：对照两条本世真实记录", accept_fate_limit: "信命：确认一项已核验的当世限制", change_fate_outcome: "改命：面对一项未完结的真实后果" })[id] || "顺序命关";
}
function renderSkills(s) {
  const root = shell("r5_skill_record", "功法与记忆", "当前身体掌握、来源与前世记忆分开显示；记忆不是技能权限。", "bg_study_750x1624");
  const skills = s.r5.skills;
  const card = panel("当前身体已学", "只列当前生命中有来源的技能记录。", "frame_dao_card_700x320");
  if (!skills.length) card.append(el("p", "muted", "当前身体尚未学会功法。可前往公开课程地点，按实际教师与课程来源学习。"));
  for (const row of skills) {
    const item = panel(skillName(row.skillId), `方向：${disciplineName(row.discipline)} · ${eventName(row.sourceEventId) || "有学习来源记录"}`);
    item.append(el("p", "date-line", `修习 ${row.masteryMilli} · 理解 ${row.understandingMilli} · 学得日期 ${row.learnedDay ?? "未知"}`));
    item.append(el("p", "date-line", `第 ${row.lifeIndex} 世学得 · ${skillStatus(row.status)}`));
    card.append(item);
  }
  root.append(card);
  const memory = panel("未修习记忆", "觉醒只提供线索；获得课程并完成修习后，才能在今生掌握。", "frame_memory_700x180");
  const memories = Object.entries(s.character.r5UnpracticedMemory || {});
  const raw = state();
  const awakened = raw?.facts?.r4_fact_memory_awakened?.lifeIndex === s.character.lifeIndex;
  if (!memories.length) memory.append(el("p", "muted", "暂无未修习记忆。"));
  for (const [skillId, row] of memories) {
    const name = skillName(skillId);
    const active = (s.character.trainingInProgress || []).find((item) => item.skillId === skillId && item.lifeIndex === s.character.lifeIndex && item.status === "active" && item.source === "awakened_memory");
    const course = raw?.r5Retraining?.[`${s.character.lifeIndex}:${skillId}`];
    const card = panel(name, `记忆线索，当前身体尚未掌握 · 来自第 ${row.sourceLife} 世`);
    card.dataset.node = "r5_retraining_course";
    card.append(el("p", "date-line", `记忆熟练 ${row.rememberedMasteryMilli} · 当前掌握 ${s.character.skillRecords?.[skillId]?.lifeIndex === s.character.lifeIndex ? s.character.skillRecords[skillId].proficiency : 0}`));
    if (!awakened) {
      card.append(el("p", "hint", "先在首页回应与这段记忆有关的觉醒，再选择是否参加重练课程。"));
    } else if (!active || !course || course.status !== "active") {
      card.append(el("p", "hint", "当前尚无有效重练课程；请在首页处理相关课程邀约。"));
    } else {
      card.append(el("p", "hint", `课程进度 ${course.completedUnits}/${course.requiredUnits} · ${course.completedSessions} 次 · 每次修习耗时 30 日。`));
      card.append(button("完成一次课程修习（30 日）", () => retrainMemory(skillId), "button secondary"));
    }
    memory.append(card);
  }
  root.append(memory, button("返回首页", renderHome, "button"));
  mount(root);
}
async function retrainMemory(skillId) {
  if (busy) return;
  busy = true;
  let rerender = false;
  try {
    const result = engine.retrainMemoryBlock(skillId, txId(`memory-train-${skillId}`));
    if (result.status === "rejected") {
      notice(`暂未完成重练：${trainingReason(result.reason)}`);
      return;
    }
    if (await persist()) {
      notice(result.status === "completed" ? `${skillName(skillId)}已在本世重新掌握。` : `修习进度 ${result.completedUnits}/${result.requiredUnits}，还需继续完成课程。`);
      rerender = true;
    }
  } catch (error) { notice(`课程未能继续：${error.message}`); }
  finally {
    busy = false;
    if (rerender) renderSkills(snap());
  }
}
function trainingReason(reason) {
  const copy = {
    retraining_not_started: "课程尚未开始，请先回应重练邀约。",
    active_awakened_training_or_memory_missing: "记忆觉醒或课程资格已失效。",
    life_or_health_not_ready: "此世身体状况暂不适合继续修习。",
    world_event_interrupted_during_practice: "途中出现必须处理的变故，修习未记作完成。",
    life_ended_during_practice: "寿终中断了本次修习。"
  };
  return copy[reason] || "当前条件不满足，进度未记作完成。";
}
function renderCapabilities(s) {
  const root = shell("r5_capability_detail", "境界能力", "只显示本世已解锁能力；使用资格、来源、期限和实际效果由运行时核验。", "bg_study_750x1624");
  const ids = s.r5.capabilities;
  if (!ids.length) root.append(panel("尚未解锁能力", "按可玩境界路径完成真实突破后，本世能力会逐阶开放。"));
  for (const id of ids) {
    const contract = pack.r5ProgressionRules.capabilityContracts[id] || {};
    const viewState = engine.capabilityView(id);
    const card = panel(capabilityLabel(id), capabilityEffect(id));
    card.dataset.capability = id;
    card.append(el("p", "date-line", `当前境界：${s.r5.currentStage?.name || "未明"} · 取得途径：${handlerName(viewState.handler)} · 学科：${(viewState.disciplines || []).map(disciplineName).join("、") || "无指定"}`));
    card.append(el("p", "hint", viewState.unlocked ? "本世已解锁；本次行动仍须满足来源、地点、对象与期限条件。" : "尚未解锁。"));
    const candidates = capabilityCandidates(id, viewState.handler, contract, s);
    const target = document.createElement("select");
    target.className = "button secondary r5-select";
    target.setAttribute("aria-label", `${capabilityLabel(id)}的可用对象`);
    target.append(new Option(candidates.length ? "选择当前有效对象…" : "当前没有符合条件的对象", ""));
    for (const candidate of candidates) target.append(new Option(candidate.label, candidate.id));
    card.append(target);
    const choice = document.createElement("select");
    choice.className = "button secondary r5-select";
    choice.setAttribute("aria-label", `${capabilityLabel(id)}的处理方式`);
    choice.append(new Option("选择处理方式…", ""));
    choice.hidden = !candidates.some((candidate) => candidate.choices?.length);
    function updateChoices() {
      const selected = candidates.find((candidate) => candidate.id === target.value);
      const priorChoice = choice.value;
      choice.replaceChildren(new Option(selected?.choices?.length ? "选择处理方式…" : "此能力无需另选处理方式", ""));
      for (const option of selected?.choices || []) choice.append(new Option(option.label, option.id));
      if (selected?.choices?.some((option) => option.id === priorChoice)) choice.value = priorChoice;
      choice.hidden = !selected?.choices?.length;
      const current = selected ? engine.capabilityView(id, selected.id) : null;
      status.textContent = !selected
        ? capabilityPrerequisite(id, contract, candidates)
        : current?.permission === true ? "所选对象符合当前能力的基础核验；执行时仍由完整运行时复核。"
          : typeof current?.permission === "string" && current.permission !== "not_checked" ? capabilityReason(current.permission)
            : selected.reason || "对象来自本世当前记录；正式行动仍由运行时核验。";
      run.disabled = !selected || Boolean(selected.choices?.length && !choice.value);
    }
    target.addEventListener("change", updateChoices);
    choice.addEventListener("change", updateChoices);
    const status = el("p", "hint", capabilityPrerequisite(id, contract, candidates));
    const run = button("按真实规则执行", () => executeCapability(id, target.value, choice.value || null), "button secondary");
    run.disabled = true;
    card.append(choice, status, run);
    root.append(card);
  }
  root.append(button("返回首页", renderHome, "button"));
  mount(root);
}
const capabilityLabels = {
  work: "按约受雇", study: "求学与研读", relationship: "建立关系", public_opportunity: "参与公开机缘",
  basic_form: "基础招式演练", pressure_form: "压力下守势", linked_form: "连贯招式", sustained_effort: "持续修习",
  breath_control: "调息控制", controlled_force: "收放力道", seek_spirit_entry: "求教入门", sense_self_state: "体察自身",
  compare_observed_steps: "对照修习进度", focused_observation: "观察眼前人物", bounded_sense: "有限感知",
  invoke_learned_art: "施展已学术法", sequence_learned_steps: "连续修习", stabilize_learned_art: "稳固已学术法",
  resist_bounded_body_pressure: "调养身体", bounded_external_action: "影响相邻路标", compare_accessible_records: "对照可查记录",
  choose_evidence_bounded_responsibility: "面对已知限制", change_unfinished_consequence: "处理未尽后果",
  alter_body_capacity: "锻成蜕变之躯", affect_bounded_environment: "参与水渠轮灌", resolve_inner_conflict: "回应内心冲突"
};
function capabilityLabel(id) { return capabilityLabels[id] || "境界能力"; }
function capabilityEffect(id) {
  const copy = {
    work: "只处理本世当前有效的工作邀约；报酬与结果按真实事件结算。",
    study: "仅处理当前确有来源的求学机会；学习结果写入本世记录。",
    relationship: "处理眼前真实关系邀约；尊重当事人的边界与同意。",
    public_opportunity: "仅使用本世有效的公开服务或课程公告。",
    basic_form: "需要本世已学武学，并满足当前地点与修习条件。"
  };
  return copy[id] || "按本世境界、已学功法、实际地点与运行时登记来源核验；未达条件不会产生效果。";
}
function handlerName(handler) {
  return ({ existing_eligible_event: "眼前有效事件", public_opportunity: "公开服务公告", martial_contest: "武学演练", training_sequence: "功法修习", spirit_entry_practice: "教师指导", self_state_record: "自身状态记录", training_comparison: "真实修习记录", visible_person_observation: "在场人物观察", spell_action: "已学术法行动", recovery_action: "调养行动", bounded_external_projection: "相邻地点行动", accessible_record_compare: "公开记录对照", fate_acceptance: "已知限制选择", unfinished_event_resolution: "未尽事件处理", body_capacity_upgrade: "蜕变境界行动", bounded_environment_effect: "公开环境行动", inner_conflict_resolution: "当世选择" })[handler] || "本世登记来源";
}
function capabilityCandidates(id, handler, contract, s) {
  const saved = state() || {};
  const targetKind = contract.targetKinds?.[0];
  if (handler === "bounded_external_projection") {
    const board = saved.world?.dailyServiceBoards?.road;
    const permit = board?.permitByCharacter?.[s.character.id];
    const source = saved.world?.dailyBusinessSources?.roadmarker;
    const healthCost = Number(pack.r5ProgressionRules.capabilityActionCosts?.boundedExternalActionHealth || 2);
    const live = s.character.location === "r4_loc_willow_market" && s.character.knownLocations?.includes("r4_loc_ashspring")
      && board?.verifiedRoute?.verified === true && board.verifiedRoute.direction === "r4_loc_ashspring"
      && board.sign?.status === "damaged" && permit?.status === "valid" && permit.lifeIndex === s.character.lifeIndex
      && permit.characterId === s.character.id && source?.ownerCharacterId === s.character.id
      && permit.expiresDay >= s.worldDay && source?.status === "open" && source.createdDay === s.worldDay
      && source.expiresDay >= s.worldDay && source.provenance?.status === "verified"
      && Number(s.character.health || 0) > healthCost && engine.isEventAvailable("r4_ev_daily_roadmarker");
    return live ? [{ id: "r4_loc_ashspring", label: "灰泉镇的破损路标" }] : [];
  }
  if (handler === "bounded_environment_effect") {
    const eventId = "r4_ev_era_lingxu_repair";
    const source = saved.world?.eraEventSources?.lingxu_repair;
    const live = source?.status === "open" && source.lifeIndex === s.character.lifeIndex && source.worldId === saved.world?.id
      && Number.isSafeInteger(source.expiresDay) && source.expiresDay >= s.worldDay && engine.isEventAvailable(eventId);
    const event = live ? engine.eventView(eventId) : null;
    const choices = (event?.options || []).filter((option) => option.available && option.id === "follow_public_rotation")
      .map((option) => ({ id: option.id, label: optionLabel(eventId, option) || "遵循公开轮灌" }));
    return choices.length ? [{ id: eventId, label: event.title || "灵墟水渠公开轮灌", choices }] : [];
  }
  if (handler === "inner_conflict_resolution") {
    const acceptedLimit = (saved.facts?.r5_fact_fate_gate || []).some((row) => row.lifeIndex === s.character.lifeIndex && row.gateId === "accept_fate_limit" && row.status === "verified" && row.choiceId === "finite_lifespan");
    if (!acceptedLimit) return [];
    const choices = [
      { id: "continue_practice", label: "继续修习，承担身体消耗" },
      { id: "conserve_body", label: "调养身体，暂缓精进" }
    ];
    return (s.r5.skills || []).filter((row) => row.discipline === "cultivation" && saved.character?.learnedSkills?.includes(row.skillId))
      .map((row) => ({ id: row.skillId, label: skillName(row.skillId), choices }));
  }
  if (handler === "unfinished_event_resolution") {
    const eventId = "r4_ev_era_faction_successor";
    const source = saved.world?.eraEventSources?.faction_successor;
    const preparedGate = (saved.facts?.r5_fact_fate_gate || []).some((row) => row.lifeIndex === s.character.lifeIndex && row.gateId === "change_fate_outcome" && row.status === "prepared" && row.sourceCauseIds?.includes(source?.causeId));
    const acceptedLimit = (saved.facts?.r5_fact_fate_gate || []).some((row) => row.lifeIndex === s.character.lifeIndex && row.gateId === "accept_fate_limit" && row.status === "verified");
    const live = source?.status === "open" && source.lifeIndex === s.character.lifeIndex && source.worldId === saved.world?.id && Number.isSafeInteger(source.expiresDay) && source.expiresDay >= s.worldDay && acceptedLimit && preparedGate && engine.isEventAvailable(eventId);
    const event = live ? engine.eventView(eventId) : null;
    if (!event) return [];
    return [{ id: eventId, label: event.title || "宗门后续事项", choices: (event.options || []).filter((option) => option.available && option.id === "audit_public_tools").map((option) => ({ id: option.id, label: optionLabel(eventId, option) || option.text })).filter((option) => option.label) }].filter((row) => row.choices.length);
  }
  const eventPolicy = pack.r5ProgressionRules.capabilityEventPolicy?.[id];
  const candidateEvents = (s.availableEvents || []).filter((event) => {
    return (eventPolicy?.eventIds || []).includes(event.id) || (eventPolicy?.prefixes || []).some((prefix) => event.id.startsWith(prefix));
  });
  const eventCandidates = candidateEvents.map((event) => ({
    id: event.id,
    label: event.presentation?.title || "当前有效邀约",
    choices: (event.options || []).filter((option) => option.available).map((option) => ({ id: option.id, label: optionLabel(event.id, option) || "处理此项" }))
  })).filter((event) => event.choices.length);
  if (handler === "public_opportunity") {
    const board = saved.world?.dailyServiceBoards?.publicLesson;
    const clerk = saved.world?.npcRecords?.[board?.clerkId];
    const canOpenCurrentLoan = board?.status === "open" && board.loanStatus === "available"
      && s.character.location === board.locationId && clerk?.alive === true && clerk?.onDuty === true && clerk.locationId === s.character.location;
    if (!canOpenCurrentLoan || saved.world?.dailyBusinessConsumedCauses?.[`r4_ev_daily_publiclesson:${board.causeId}`]) return [];
    const event = definitions.events.find((row) => row.id === "r4_ev_daily_publiclesson");
    return event ? [{
      id: event.id,
      label: event.presentation?.title || "公开课本借阅",
      choices: (event.options || []).map((option) => ({ id: option.id, label: optionLabel(event.id, option) || "处理此项" }))
    }] : [];
  }
  if (["existing_eligible_event", "unfinished_event_resolution"].includes(handler)) return eventCandidates;
  if (["current_life_learned_skill", "learned_martial_skill_or_live_contest", "learned_cultivation_skill_and_present_teacher", "current_life_learned_art", "two_current_life_training_receipts"].includes(targetKind)) {
    const required = new Set(contract.disciplines || []);
    const completedRows = saved.r5LifeLedger?.factLog || [];
    return (s.r5.skills || []).filter((row) => !required.size || required.has(row.discipline))
      .filter((row) => targetKind !== "two_current_life_training_receipts" || completedRows.filter((fact) => fact.skillId === row.skillId && fact.lifeIndex === s.character.lifeIndex && fact.status === "completed" && fact.transactionId).length >= 2)
      .filter((row) => handler !== "martial_contest" || (row.discipline === "martial" && Number(row.masteryMilli || 0) >= Number(s.r5.currentStage?.practiceUnitsRequired || 0) && s.character.location === saved.world?.dailyServiceBoards?.publicLesson?.locationId))
      .map((row) => ({ id: row.skillId, label: skillName(row.skillId) }));
  }
  if (["self", "self_with_recoverable_pressure", "self_at_molt_body"].includes(targetKind)) {
    const stageNeeded = targetKind === "self_at_molt_body" ? s.r5.currentStageId === "r5_milestone_molt_body" && !saved.facts?.r5_fact_body_capacity : true;
    const recoveryReady = targetKind !== "self_with_recoverable_pressure" || s.character.health < Number(s.character.maxHealth || 100);
    return stageNeeded && recoveryReady ? [{ id: s.character.id, label: "自己" }] : [];
  }
  if (targetKind === "present_visible_person") return Object.entries(saved.people || {})
    .filter(([, person]) => person.alive === true && person.location === s.character.location)
    .map(([personId, person]) => ({ id: personId, label: ({ r4_npc_public_teacher: "公开课程教师", r4_npc_lu_gatherer: "陆姓采药人", r4_npc_qi_student: "齐姓学徒", r4_npc_wen_repairer: "温姓修理匠" })[personId] || (person.role === "ferry_operator" ? "渡口行者" : "在场人物") }));
  if (["two_current_life_accessible_records", "current_factual_limit_and_source"].includes(targetKind)) {
    const records = [...(saved.causeLog || []), ...(saved.r5LifeLedger?.factLog || [])]
      .filter((row) => row?.causeId && Number(row.lifeIndex || s.character.lifeIndex) === s.character.lifeIndex && Number(row.day ?? row.worldDay ?? 0) <= s.worldDay);
    const unique = [...new Map(records.map((row) => [row.causeId, row])).values()];
    const recordLabel = (row) => `${row.day ?? row.worldDay ?? s.worldDay} 日 · ${eventName(row.eventId) || skillName(row.skillId) || "本世经历记录"}`;
    if (handler === "accessible_record_compare") {
      return unique.map((row) => ({
        id: row.causeId,
        label: recordLabel(row),
        choices: unique.filter((other) => other.causeId !== row.causeId)
          .map((other) => ({ id: other.causeId, label: recordLabel(other) }))
      }));
    }
    if (handler === "fate_acceptance") {
      const choices = [
        { id: "finite_lifespan", label: "有限寿数" },
        { id: "practiced_method", label: "已学功法与当前修习程度" },
        { id: "current_resources", label: "当前资源" }
      ];
      return unique.map((row) => ({ id: row.causeId, label: recordLabel(row), choices }));
    }
    return unique.map((row) => ({ id: row.causeId, label: recordLabel(row) }));
  }
  return [];
}
function capabilityPrerequisite(id, contract, candidates) {
  if (candidates.length) return "已按本世有效来源列出可选对象；选项文字隐藏内部编号。";
  const targetKind = contract.targetKinds?.[0];
  const copy = {
    authorized_work_event: "需先出现本世仍可处理的工作委托；完成后再从此处选择。",
    available_study_event: "需先遇到符合当前境界的求学/研读来源，并确保邀约仍有效。",
    named_relationship_event: "需先出现当前仍有效的关系邀约；未获同意的关系不会列为选项。",
    live_public_service_board: "需在开放期间遇到真实公开服务公告；无公告时不能执行。",
    learned_martial_skill_or_live_contest: "需本世已学武学、满足当前修习门槛，并身处公开演练地点。",
    current_life_learned_skill: "需本世实际学会合同要求学科的功法。",
    learned_cultivation_skill_and_present_teacher: "需本世实际学会修行功法，并与在岗教师同处课程地点。",
    self: "目标固定为自己；该能力还须满足本世境界与来源条件。",
    present_visible_person: "需有存活人物当前与你同处一地；只会列出当下可见对象。",
    two_current_life_training_receipts: "需本世同一功法留下至少两次真实完成的修习记录。",
    two_current_life_accessible_records: "需本世至少有两条可查且不同的真实经历记录。",
    current_factual_limit_and_source: "需先形成可核验的当世限制事实与来源记录。",
    permitted_adjacent_route_sign: "需持本世有效的当日路务许可、仍在期限内的维修来源，且健康高于行动成本。",
    self_with_recoverable_pressure: "需自身出现可通过真实调养缓解的身体压力。",
    self_at_molt_body: "需先真实达到蜕变之躯境界；不以历史履历代替当世境界。",
    live_current_life_lingxu_water_rotation: "需有本世、当前世界且未过期的灵墟公开轮灌来源；来源失效时不会列为可选。",
    cause_backed_current_life_value_conflict: "需本世确认有限寿数，并以已学修行功法选择承担修习或调养。"
  };
  return copy[targetKind] || "当前没有符合运行时前置条件的对象；请先完成对应境界、来源、地点或当世记录。";
}
function capabilityReason(reason) {
  return ({ not_checked: "请选择一个当前有效对象。", current_life_learned_skill_target_required: "需选择本世已学功法。", current_martial_mastery_too_low: "本世武学修习尚未达到要求。", person_not_alive_and_visible_here: "该人物目前不在场或已无法互动。", stage_discipline_source_missing: "本世尚无符合学科要求的功法来源。" })[reason] || "当前运行时条件未满足；未产生行动或奖励。";
}
async function executeCapability(capabilityId, targetId, choiceId) {
  if (busy || !targetId) return;
  busy = true;
  let rerender = false;
  try {
    const result = engine.useCapability(capabilityId, targetId, txId(`capability-${capabilityId}`), choiceId);
    if (result?.status === "rejected" || result?.error) { notice(`尚未执行：${capabilityReason(result.reason || result.error)}`); return; }
    if (await persist()) { notice(`${capabilityLabel(capabilityId)}已按本世真实来源处理并保存回执。`); rerender = true; }
  } catch (error) { notice(`行动未完成：${capabilityReason(error.message)}`); }
  finally { busy = false; if (rerender) renderCapabilities(snap()); }
}
function renderWorld(s) {
  const root = shell("r5_world_legacy", "世界与市集", `世界第 ${s.worldDay} 日 · 角色只知道其亲历或获知的部分。`, "bg_history_750x1624");
  const card = panel("本世可验证沿革", "世界存在不等于角色知情；未经角色获知的事实不写入其知识。", "frame_memory_700x180");
  const known = s.character.knowledge || {};
  const entries = Object.entries(known);
  if (!entries.length) card.append(el("p", "muted", "尚无可验证的公开沿革线索。"));
  for (const [key, row] of entries) card.append(el("p", "cause-row", `${knowledgeName(key)} · ${knowledgeLevel(row.level)} · 第 ${row.acquiredDay ?? "未知"} 日 · ${knowledgeSource(row.sourceId)}`));
  const events = (s.world.worldEventQueue || []).filter((row) => row.day <= s.worldDay);
  card.append(el("h3", "card-title", "已到期世界事件"));
  for (const row of events.slice(0, 12)) card.append(el("p", "date-line", `${row.day} 日 · ${eventName(row.eventId) || "一段待确认的往事"}`));
  root.append(card, marketPanel(s), button("返回首页", renderHome, "button"));
  mount(root);
}
const marketGoods = [
  { id: "r4_item_manual", name: "基础修习手册", unit: 10 },
  { id: "r4_item_stargrass", name: "星草", unit: 4 },
  { id: "r4_item_powder", name: "回气散", unit: 15 },
  { id: "r4_item_array_material", name: "阵材", unit: 8 }
];
function marketPanel(s) {
  const saved = state() || {};
  const marketId = "r4_loc_willow_market";
  const market = panel("柳溪集交易", "货物、报价、路费与库存均由本世运行时核验；报价当日有效。", "frame_memory_700x180");
  market.dataset.market = "r4_loc_willow_market";
  if (s.character.location !== marketId) {
    market.append(el("p", "hint", `你现在在${locationName(s.character.location)}。需先按真实路费前往柳溪集，抵达后才能询价。`));
    const route = button("按实际路费前往柳溪集", () => act("旅行", () => engine.performWorldAction("r4_action_travel", { destination: marketId })), "button secondary");
    route.dataset.action = "market-travel";
    market.append(route);
    return market;
  }
  market.append(el("p", "date-line", `当前位置：${locationName(s.character.location)} · 财富：${s.character.wealth || 0} · 世界第 ${s.worldDay} 日`));
  const stock = s.world.marketStock?.[marketId] || pack.market.locations[marketId].initialStock;
  for (const good of marketGoods) {
    const quantityOwned = Number(s.character.inventory?.[good.id] || 0);
    const row = el("div", "cause-row");
    row.dataset.good = good.id;
    row.append(el("strong", "", good.name), el("p", "muted", `市有 ${Number(stock[good.id] || 0)} · 你有 ${quantityOwned} · 买入约 ${good.unit} 文/件`));
    const qty = document.createElement("select");
    qty.className = "button secondary r5-select";
    qty.setAttribute("aria-label", `${good.name}交易数量`);
    for (let n = 1; n <= 20; n++) qty.append(new Option(`${n} 件`, String(n)));
    row.append(qty,
      button("询买价", () => issueMarketQuote(marketId, good, Number(qty.value), "buy"), "button secondary"),
      button("询卖价", () => issueMarketQuote(marketId, good, Number(qty.value), "sell"), "button secondary"));
    market.append(row);
  }
  const outstanding = Object.entries(saved.quotes || {}).filter(([key, quote]) => key !== "active" && quote && !quote.receipt && quote.marketId === marketId && quote.ownerId === s.character.id && quote.worldId === s.worldId);
  if (outstanding.length) market.append(el("h3", "card-title", "待确认报价"));
  for (const [quoteId, quote] of outstanding) {
    const good = marketGoods.find((item) => item.id === quote.itemId);
    if (!good) continue;
    const quoteCard = panel(`${quote.side === "buy" ? "买入" : "卖出"}${good.name}`, `${quote.quantity} 件 · 每件 ${quote.unitPrice} 文 · 合计 ${quote.totalWealth} 文 · 当日有效`, "frame_card_700x260");
    quoteCard.dataset.quote = quoteId;
    quoteCard.dataset.side = quote.side;
    quoteCard.dataset.good = quote.itemId;
    let reason = "";
    if (s.worldDay > quote.expiryDay) reason = "报价已过期，请重新询价。";
    else if (s.character.location !== quote.marketId) reason = "你已离开报价地点。";
    else if (quote.side === "buy" && Number(s.character.wealth || 0) < quote.totalWealth) reason = "现有财富不足，未发生扣款。";
    else if (quote.side === "buy" && Number(stock[quote.itemId] || 0) < quote.quantity) reason = "市面库存已变化，请重新询价。";
    else if (quote.side === "sell" && !quoteLotsStillOwned(saved, quote)) reason = "锁定的自有物品已售出或发生变化，请重新询价。";
    if (reason) quoteCard.append(el("p", "hint", reason));
    else quoteCard.append(button("确认成交", () => settleMarketQuote(quoteId), "button primary"));
    market.append(quoteCard);
  }
  const recent = Object.entries(saved.quotes || {}).filter(([key, quote]) => key !== "active" && quote?.receipt && quote.marketId === marketId && quote.ownerId === s.character.id).slice(-4).reverse();
  if (recent.length) {
    market.append(el("h3", "card-title", "本世成交记录"));
    for (const [, quote] of recent) {
      const good = marketGoods.find((item) => item.id === quote.itemId);
      market.append(el("p", "date-line", `第 ${quote.receipt.day} 日 · ${quote.side === "buy" ? "买入" : "卖出"}${good?.name || "物品"} ${quote.receipt.quantity} 件 · ${quote.side === "buy" ? "支出" : "收入"} ${quote.receipt.totalWealth} 文`));
    }
  }
  return market;
}
async function issueMarketQuote(marketId, good, quantity, side) {
  if (busy) return;
  busy = true;
  let rerender = false;
  try {
    const result = engine.issueMarketQuote(marketId, good.id, quantity, side);
    if (result?.error) { notice(`未能报价：${marketReason(result.error)}`); return; }
    if (await persist()) { notice("已取得当日有效报价；成交前仍会重新核验库存与余额。"); rerender = true; }
  } catch (error) { notice(`报价未完成：${error.message}`); }
  finally { busy = false; if (rerender) renderWorld(snap()); }
}
async function settleMarketQuote(quoteId) {
  if (busy) return;
  busy = true;
  let rerender = false;
  try {
    const result = engine.settleMarketQuote(quoteId);
    if (result?.error && result.error !== "duplicate_suppressed") { notice(`未能成交：${marketReason(result.error)}`); return; }
    if (await persist()) { notice("成交已记入本世回执，现金与库存同步更新。"); rerender = true; }
  } catch (error) { notice(`成交未完成：${error.message}`); }
  finally { busy = false; if (rerender) renderWorld(snap()); }
}
function marketReason(reason) {
  return ({ market_location_required: "需在柳溪集现场报价。", invalid_quote_request: "数量或货品不符合交易规则。", window_closed: "报价已过期。", insufficient_resource: "余额或市场库存不足。", quoted_inventory_lots_unavailable_or_changed: "自有库存已变化，请重新询价。", quote_owner_mismatch: "此报价不属于当前角色。", quote_missing: "报价不存在，请重新询价。" })[reason] || "运行时未批准本次交易。";
}
function quoteLotsStillOwned(saved, quote) {
  const current = saved.character?.inventoryLedger?.[quote.itemId] || [];
  return Number(saved.character?.inventory?.[quote.itemId] || 0) >= Number(quote.quantity || 0)
    && (quote.inventoryLotSelections || []).every((locked) => {
      const lot = current.find((row) => row.sourceId === locked.sourceId && row.ownership === "owned");
      return Number(lot?.quantity || 0) >= Number(locked.quantity || 0);
    });
}
function knowledgeName(key) { return ({ market: "柳溪集消息", safeExit: "安全路线消息", waterRotation: "水渠轮灌消息" })[key] || "已获知的公开线索"; }
function knowledgeLevel(level) { return ({ rumor: "传闻", heard: "听闻", observed: "见过", witnessed: "亲历", verified: "已核实" })[level] || "记录在案"; }
function knowledgeSource(id) {
  const event = definitions.events.find((row) => row.id === id);
  if (event) return `来自「${event.presentation?.title || "公开事件"}」`;
  if (typeof id === "string" && id.startsWith("public-schedule:")) return "来自公开时令安排";
  return "来源已记录";
}
function renderSettlement() {
  const s = snap();
  const settlement = s.r5.scoreLedger.settlement;
  const root = shell("r5_life_settlement", "此生已尽", `第 ${s.character.lifeIndex} 世 · 世界第 ${s.worldDay} 日`, "bg_result_750x1624");
  const card = panel("本世因果结算", "预算来自本世有效境界达成、事件因果与寿命；重复结算返回同一权威结果。", "frame_ending_banner_700x240");
  const facts = s.r5.scoreLedger.factLog || [];
  for (const row of facts.slice(-6).reverse()) card.append(el("p", "cause-row", `${row.day ?? row.completedDay ?? s.worldDay} 日 · ${row.eventId || row.skillId || row.kind || row.status || "经历"}`));
  if (!settlement) card.append(button("结算此世", async () => {
    if (busy) return;
    busy = true;
    let rerender = false;
    try {
      const result = engine.settleNaturalDeath();
      if (result.status === "rejected") return notice(`暂不能结算：${result.reason}`);
      rerender = await persist();
    } catch (error) { notice(`结算未完成：${error.message}`); }
    finally {
      busy = false;
      if (rerender) renderSettlement();
    }
  }, "button primary"));
  else {
    card.append(img("icon_life_seal_96x96", "本世结算印记"));
    card.append(el("p", "date-line", `境界 ${settlement.stageComponent} · 因果 ${settlement.causeComponent} · 寿命 ${settlement.survivalComponent}`));
    card.append(el("p", "date-line", `总分 ${settlement.total} · 转生余额 ${s.r5.rebirth.walletUnits} 点`));
    card.append(button("进入预算分配", renderRebirth, "button primary"));
  }
  root.append(card, button("保存并返回入口", async () => { if (await persist()) renderEntry(); }, "button secondary"));
  mount(root);
}
function renderRebirth() {
  const s = snap();
  const current = s.r5.currentStage;
  const rank = Number(current?.progressionRank || 0);
  const eligible = pack.r5ProgressionRules.stages.filter((row) => row.availability === "playable" && row.progressionRank <= rank);
  const savedDraft = s.r5.rebirth.draft;
  let plan = {
    retainedStageId: savedDraft?.retainedStageId || null,
    increments: { ...Object.fromEntries(dimensions.map((key) => [key, 0])), ...(savedDraft?.dimensionIncrements || {}) }
  };
  let currentQuote = null;
  const root = shell("r5_rebirth_draft", "安排下一世", `同一转生余额：${s.r5.rebirth.walletUnits} 点 · 未使用余额不继承`, "bg_rebirth_750x1624");
  const card = panel("保留真实达成境界", "仅能购买本世已达成阶段；本次会带入的境界与技能学科以权威回执为准。", "frame_card_700x260");
  const select = document.createElement("select");
  select.className = "button secondary r5-select";
  select.setAttribute("aria-label", "选择付费保留境界");
  select.append(new Option("不保留境界", ""));
  for (const stage of eligible) select.append(new Option(stage.name, stage.id));
  select.value = plan.retainedStageId || "";
  const quoteLine = el("p", "date-line", "请先生成权威报价。");
  const dimensionRows = new Map();
  const summary = panel("永久四维", "每一等级跨世累计；价格由 R5 运行时按当前等级计算。", "frame_card_700x260");
  for (const key of dimensions) {
    const row = el("div", "r5-dimension-row");
    row.append(img(`icon_dim_${dimIcons[key]}_96x96`, dimNames[key], "r5-dimension-icon"), el("span", "", `${dimNames[key]} · 当前 ${s.character.r5DimensionLevels[key] || 0}`));
    const value = el("strong", "", String(plan.increments[key]));
    row.append(button("−", () => adjust(key, -1), "button secondary r5-step"), value, button("＋", () => adjust(key, 1), "button secondary r5-step"));
    dimensionRows.set(key, value);
    summary.append(row);
  }
  select.addEventListener("change", () => { plan.retainedStageId = select.value || null; quote(); });
  function allocation() { return { ...plan.increments }; }
  async function quote() {
    if (busy) return;
    const result = engine.draftRebirth(plan.retainedStageId, allocation());
    if (typeof result === "string") {
      currentQuote = null;
      quoteLine.textContent = `此方案不可用：${result}。可撤销增量或重置方案。`;
      notice(`未锁定新草案：${result}`);
    } else {
      currentQuote = result;
      quoteLine.textContent = `境界 ${result.retainedStageCostUnits} · 四维 ${result.dimensionCostUnits} · 合计 ${result.retainedStageCostUnits + result.dimensionCostUnits} · 余 ${result.remainingUnits}`;
      saveState = await persist() ? "已保存草案" : "保存失败";
    }
    quoteLine.dataset.quote = currentQuote ? "valid" : "invalid";
  }
  function adjust(key, delta) {
    const maximum = pack.r5RebirthRules.dimensionMaximumLevel - Number(s.character.r5DimensionLevels[key] || 0);
    plan.increments[key] = Math.max(0, Math.min(maximum, plan.increments[key] + delta));
    dimensionRows.get(key).textContent = String(plan.increments[key]);
    quote();
  }
  card.append(select, quoteLine);
  summary.append(el("p", "hint", "资质影响修习收益；悟性影响理解；血脉影响身体恢复；机缘只影响种子化机会，不保证成功。"));
  root.append(card, summary);
  root.append(button("撤销所有未提交分配", async () => {
    plan = { retainedStageId: null, increments: Object.fromEntries(dimensions.map((key) => [key, 0])) };
    select.value = "";
    for (const key of dimensions) dimensionRows.get(key).textContent = "0";
    await quote();
  }, "button secondary"));
  root.append(button("确认预算并继续", () => {
    if (!currentQuote || currentQuote.retainedStageId !== plan.retainedStageId || JSON.stringify(currentQuote.dimensionIncrements) !== JSON.stringify(allocation())) return notice("当前选择尚无有效权威报价，请先调整或撤销后重试。");
    renderCommit(s, currentQuote);
  }, "button primary"), button("返回结算", renderSettlement, "button secondary"));
  mount(root);
  quote();
}
function renderCommit(previous, quote) {
  const root = shell("r5_rebirth_commit", "确认转世", "提交后本世预算永久锁定；前世相同结算不能再次扣点或生成第二后继。", "bg_rebirth_750x1624");
  const card = panel("最终核对", "返回修改只影响未提交草案。", "frame_modal_700x520");
  card.append(el("p", "date-line", `${quote.retainedStageId ? `付费保留境界：${stageName(quote.retainedStageId)}` : "不保留境界"} · ${quote.retainedStageCostUnits} 点`));
  for (const key of dimensions) card.append(el("p", "date-line", `${dimNames[key]}：${previous.character.r5DimensionLevels[key] || 0} + ${quote.dimensionIncrements[key]} → ${quote.dimensions[key]} 级`));
  card.append(el("p", "date-line", `四维 ${quote.dimensionCostUnits} · 总花费 ${quote.retainedStageCostUnits + quote.dimensionCostUnits} · 剩余 ${quote.remainingUnits}`));
  card.append(el("p", "hint", "下一世将重新开始年龄、寿命与身体；未保留技能只可能作为记忆线索，物品、关系和许可不继承。"));
  root.append(card);
  for (const origin of origins) root.append(button(`以${origin.label}来世`, () => commit(origin.id), "button secondary"));
  root.append(button("返回修改草案", renderRebirth, "button"));
  mount(root);
  async function commit(origin) {
    if (busy) return;
    busy = true;
    let saved = false;
    try {
      const settlement = snap().r5.scoreLedger.settlement;
      const stableKey = `${snap().world.id}:${snap().character.lifeIndex}:${settlement.settlementId}`;
      const receipt = engine.newLife(origin, stableKey);
      if (typeof receipt === "string") return notice(`转世未提交：${receipt}`);
      lastReceipt = receipt;
      saved = await persist();
      if (saved) {
        saveState = "转世回执已保存";
      }
    } catch (error) { notice(`转世未提交：${error.message}`); }
    finally {
      busy = false;
      if (saved) renderSuccessor(lastReceipt);
    }
  }
}
function renderSuccessor(receipt = lastReceipt || snap().r5.rebirth.receipt) {
  const s = snap();
  const root = shell("r5_successor_entry", "新的一世", `第 ${s.character.lifeIndex} 世 · 世界已行至第 ${s.worldDay} 日`, "bg_cycle_750x1624");
  root.append(successorCard(s), button("进入新一世", renderHome, "button primary"));
  mount(root);
}
function renderEntry() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(`${legacyReference.namespace}:active`) || "null"); }
  catch { saved = null; }
  storage.load(slotId).then((dto) => rootEntry(dto, saved)).catch((error) => pageError(error));
}
function pageError(error) {
  const root = shell("r5_world_home", "暂时无法进入青墟界", error?.message || "规则或存档读取失败。");
  root.append(button("重试", () => location.reload(), "button primary"));
  mount(root);
}

renderEntry();
