import { createGameController } from "./game-controller.js";

const template = await fetch("./config/life-simulator.template.json").then((res) => res.json());
const content = await fetch("./content/life-simulator.placeholder.json").then((res) => res.json());
const adConfig = await fetch("./config/ad-placements.json").then((res) => res.json());

const game = createGameController({ template, content, adConfig });
const view = document.getElementById("view");
const toast = document.getElementById("toast");
let toastTimer = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function showToast(text) {
  toast.textContent = text;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
}

function attributeList(attributes) {
  const list = document.createElement("div");
  list.className = "stat-grid";
  for (const [id, config] of Object.entries(template.attributes).sort(
    (a, b) => (a[1].displayOrder ?? 99) - (b[1].displayOrder ?? 99)
  )) {
    const value = attributes[id] ?? config.init;
    const item = el("div", "stat");
    const head = el("div", "stat-head");
    head.append(el("span", "stat-label", config.label), el("span", "stat-value", String(value)));
    const track = el("div", "stat-track");
    const fill = el("div", "stat-fill");
    fill.style.width = `${Math.max(0, Math.min(100, (value / config.max) * 100))}%`;
    fill.style.backgroundColor = config.color;
    track.append(fill);
    item.append(head, track);
    list.append(item);
  }
  return list;
}

function dangerTags(option) {
  const tags = [];
  if (option.successRate != null && option.successRate < 1) {
    tags.push(`成功率 ${Math.round(option.successRate * 100)}%`);
  }
  if (option.riskTag === "risky") tags.push("高风险");
  if (option.riskTag === "sacrifice") tags.push("取舍");
  return tags;
}

function renderHome() {
  view.innerHTML = "";
  const home = el("section", "home");
  const title = el("h1", "home-title", "人生模拟器");
  const subtitle = el("p", "home-subtitle", "三幕人生 · 十四次选择 · 八种结局");
  const route = el("p", "home-route", "当前为占位内容包，未使用小说原文");
  const start = el("button", "primary-btn", template.ui.startButton || "开始一段人生");
  start.addEventListener("click", () => {
    const snapshot = game.start();
    renderEvent(snapshot);
  });
  home.append(title, subtitle, route, start);

  const history = game.history();
  if (history.length) {
    const historyBox = el("div", "history-box");
    historyBox.append(el("h2", "section-title", "最近人生"));
    for (const run of history) {
      const row = el("div", "history-row");
      const time = new Date(run.startedAt || Date.now()).toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      });
      row.append(
        el("span", "history-ending", run.endingTitle || "未知结局"),
        el("span", "history-time", time)
      );
      historyBox.append(row);
    }
    home.append(historyBox);
  }
  view.append(home);
}

function renderEvent(snapshot) {
  const current = game.current();
  const event = current.event;
  const screen = el("section", "event-screen");

  const header = el("header", "game-header");
  const stage = el("div", "stage-line");
  stage.append(
    el("span", "stage-chip", snapshot.stageLabel || ""),
    el("span", "stage-progress", `${snapshot.totalEvents}/${snapshot.maxEvents}`)
  );
  const ageLine = el("div", "age-line");
  ageLine.append(el("span", "age-value", `年龄 ${snapshot.attributes.age ?? "-"}`));
  header.append(stage, ageLine);
  screen.append(header);

  const card = el("article", "event-card");
  card.append(
    el("h2", "event-title", event.title),
    el("p", "event-text", event.text)
  );
  screen.append(card);

  const options = el("div", "options");
  event.options.forEach((option, index) => {
    const btn = el("button", "option-btn", option.label);
    const tags = dangerTags(option);
    if (tags.length) {
      const tagBox = el("span", "option-tags", ` · ${tags.join(" · ")}`);
      btn.append(tagBox);
    }
    btn.addEventListener("click", () => {
      const result = game.choose(index);
      if (result.error) {
        showToast("操作失败，请重试");
        return;
      }
      if (result.finished) {
        renderEnding(result.ending, result.snapshot, result.runResult);
      } else if (result.stageChanged) {
        renderStageInterlude(result.snapshot);
      } else {
        renderEvent(result.snapshot);
      }
    });
    options.append(btn);
  });
  screen.append(options);

  const stats = el("div", "panel");
  stats.append(el("h2", "section-title", "当前状态"));
  stats.append(attributeList(snapshot.attributes));
  screen.append(stats);

  const history = el("details", "history-details");
  const summary = el("summary", "history-summary", "最近选择");
  const list = el("ol", "history-list");
  for (const record of snapshot.history.slice(-5).reverse()) {
    const item = el("li", "history-item");
    const head = el("div", "history-item-head");
    head.append(
      el("span", "history-event-title", record.eventTitle),
      el("span", "history-option", record.optionLabel)
    );
    const resultText = el("p", "history-result", record.resultText || "");
    item.append(head, resultText);
    list.append(item);
  }
  history.append(summary, list);
  screen.append(history);
  view.replaceChildren(screen);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderStageInterlude(snapshot) {
  const stage = template.stages[snapshot.stageId];
  const screen = el("section", "interlude");
  const badge = el("div", "interlude-badge", "幕间");
  const title = el("h2", "interlude-title", stage?.interlude || snapshot.stageLabel || "");
  const note = el("p", "interlude-note", stage?.description || "");
  const button = el("button", "primary-btn", "继续");
  button.addEventListener("click", () => renderEvent(snapshot));
  screen.append(badge, title, note, button);
  view.replaceChildren(screen);
  window.scrollTo({ top: 0 });
}

function renderEnding(ending, snapshot, runResult) {
  const card = (content.endingCards || []).find((c) => c.id === ending.id);
  const screen = el("section", "ending-screen");
  const badge = el("div", "ending-badge", "命运结算");
  const title = el("h1", "ending-title", ending.label);
  const text = el("p", "ending-text", card?.text || ending.description);
  screen.append(badge, title, text);

  const stats = el("div", "panel");
  stats.append(el("h2", "section-title", "一生属性"));
  stats.append(attributeList(snapshot.attributes));
  screen.append(stats);

  const review = el("div", "panel");
  review.append(el("h2", "section-title", "关键选择"));
  const list = el("ol", "ending-review");
  for (const record of snapshot.history.slice(-4).reverse()) {
    const item = el("li", "review-item");
    const head = el("div", "review-head");
    head.append(
      el("span", "review-event", record.eventTitle),
      el("span", "review-choice", `${record.optionLabel}${record.success ? "" : "（失败）"}`)
    );
    item.append(head);
    list.append(item);
  }
  review.append(list);
  screen.append(review);

  const actions = el("div", "ending-actions");
  const again = el("button", "primary-btn", template.ui.restartButton || "再来一局");
  again.addEventListener("click", () => {
    const next = game.start();
    renderEvent(next);
  });
  const home = el("button", "ghost-btn", "返回首页");
  home.addEventListener("click", renderHome);
  actions.append(again, home);

  const adNote = el("p", "ad-note", "广告位预留：本局已按配置记录广告触发点，当前未展示广告。");
  screen.append(actions, adNote);

  if (runResult && runResult.endingId) {
    const deltas = {};
    for (const record of runResult.history || []) {
      for (const [key, delta] of Object.entries(record.effects || {})) {
        deltas[key] = (deltas[key] || 0) + delta;
      }
    }
    if (Object.keys(deltas).length) {
      const deltaPanel = el("div", "panel");
      deltaPanel.append(el("h2", "section-title", "成长摘要"));
      const deltaGrid = el("div", "delta-grid");
      for (const [key, delta] of Object.entries(deltas)) {
        if (key === "age") continue;
        const config = template.attributes[key];
        if (!config) continue;
        const sign = delta > 0 ? "+" : "";
        const row = el("div", "delta-row");
        row.append(
          el("span", "delta-label", config.label),
          el("span", delta >= 0 ? "delta-pos" : "delta-neg", `${sign}${delta}`)
        );
        deltaGrid.append(row);
      }
      deltaPanel.append(deltaGrid);
      screen.insertBefore(deltaPanel, actions);
    }
  }
  view.replaceChildren(screen);
  window.scrollTo({ top: 0 });
}

window.addEventListener("beforeunload", () => {
  const current = game.current();
  if (current?.snapshot) game.saveSystem.saveActive(current.snapshot);
});

renderHome();
