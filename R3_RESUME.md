# C R3 实现交接

Status: 已完成，等待董秘复核本次验收修改并安排 D。

## 实现范围

- `config/life-simulator.template.json`、`config/content-schema.json` 与 `content/life-simulator.placeholder.json` 已切到 R3：16 个规范事件 ID、事件级六字段、`sceneDuration`、`lifeAdvance`、T1/T2 `eventWindow` 均生效；选项级时间与结果字段已移除。
- `engine/event-engine.js` 已实现选后暂存、继续确认、唯一人生账本、T1/T2 单次结算、气运补骰与每世重置。
- `app/game-controller.js` 已接入 R3 v3 存档迁移、新世清零、无自动继承、轮回点数保留与四维分配。
- `app/main.js` 已实现 L0/L1/L2 选前信息、固定结果顺序、结果后 `[继续]` 承接、时间账本与事件间承接。
- `tests/smoke.js` 已覆盖 16 事件闭环、唯一账本、T1/T2、气运补骰、四段评分与点数、四维分配、旧存档迁移、107 项素材和广告占位。
- `tests/mobile-layout.mjs` 已按 R3 契约校准测试边界：标准满局必须覆盖 `soul_test`、事件选项、`study_dao` 与时间说明；`fate_window`、`karma_knock` 是条件路径，出现时继续执行选前不泄露与交互检查，但不再要求每局必然出现。
- 四维轮回点数 `+/-` 操作已改为保留当前滚动位置；控件使用 HTML/CSS 符号渲染，启用/禁用态均达到高对比度，不依赖原加减 PNG，且未修改 `asset-manifest.json`。

## 验证结果

- `node --check`：`app/game-controller.js`、`app/main.js`、`engine/event-engine.js`、`tests/mobile-layout.mjs` 全部通过。
- `node game-project/code/tests/smoke.js`：通过，输出包含 R3 event fields/IDs、single ledger time、T1/T2 windows、fortune rerolls、four-section score/points、four dimensions、lifespan/realm、d20、sacrifice、dao study、save migration、full loop、107 assets、ad placeholder。
- `node game-project/code/tests/mobile-layout.mjs`：`1440x900`、`375x667`、`390x844` 三档全部通过；每档 67 步，验证结果页顺序、时间说明、第一世轮回边界、再入一世与历史记录。四维控件补充截图像素对比度 `>= 4.5:1` 与点击后滚动位置偏差 `<= 2px` 断言。
- 本轮文件范围 `git diff --check` 通过；全仓检查仅剩既有无关的 `game-project/qa/07-rollback-plan.md:62` EOF 空行问题，本任务未触碰该文件。

## 本地 Demo

`http://127.0.0.1:8000/game-project/code/?v=20260916-r3-allocation-symbols`

## 下一步

董秘复核本次验收修改后复跑并按需抽查，通过则复用现有 D 会话进入回归测试与 GitHub Pages 正式发布。D 未启动，E 未启动。
