# 游戏化流水线 · C 阶段代码目录

本目录是「小说游戏化流水线」的阶段 C 产物：一套模板化的纯前端事件引擎，加一个人生模拟器 MVP。

## 结构

```text
code/
  config/
    template-schema.json            玩法模板配置 Schema
    content-schema.json             内容包（事件/结局卡）Schema
    life-simulator.template.json    人生模拟器模板配置
    ad-placements.json              IAA 广告位预留配置
  content/
    life-simulator.placeholder.json 占位内容包，全部标记 isPlaceholder
  engine/
    event-engine.js                 事件抽取、条件过滤、选项结算、阶段推进
    attributes.js                   属性初始化与增量钳制
    ending-engine.js                结局判定
    save-system.js                  localStorage / 内存存档
    template-loader.js              配置与内容包校验
    random.js                       可注入种子的随机源
  app/
    game-controller.js              控制器：串起引擎、存档、广告预留
    ad-service.js                   IAA 广告占位服务（不接真实广告）
    analytics.js                    本地打点预留
    main.js                         页面入口
    styles.css                      页面样式
  tests/
    smoke.js                        引擎冒烟测试
    mobile-layout.mjs               移动端布局自测（375/390 视口，需本机 Chrome）
  index.html                        静态页面入口（需本地静态服务器）
  AD_PLACEMENT.md                   广告接入预留说明
```

## 运行

纯前端，无构建依赖。页面用 `fetch` 加载配置，直接双击 `file://` 入口会被浏览器 CORS 拦截，请在项目根启动静态服务器后访问。

本地快速预览：

```bash
python -m http.server 8000
```

然后访问 `http://localhost:8000/game-project/code/`。

## 部署到 GitHub Pages

1. 把仓库推送到 GitHub，在仓库 Settings → Pages 中选择分支为发布源（可用 `main` 分支）。
2. 若整个仓库发布，入口为 `game-project/code/index.html`；若只发布该目录，入口即 `index.html`。
3. 页面内资源全部使用相对路径，任意子目录部署均可直接访问，无需构建步骤。
4. 部署后可打开 `https://<owner>.github.io/<repo>/game-project/code/` 试玩。

## 换内容包

1. 复制 `life-simulator.template.json` 不改引擎字段，替换 `attributes`、`stages`、`endings` 之外的内容时只需要新建 `content/*.json`。
2. 事件按 `content-schema.json` 编写，`isPlaceholder` 一律标 `false`。
3. 修改 `app/main.js` 顶部的 `content` 地址即可切换内容包。
4. 换玩法模板时新建模板配置 + 内容包，引擎与页面不用改（页面文案在模板 `ui` 中覆盖）。

## 自测

```bash
node game-project/code/tests/smoke.js
```

移动端布局自测（需要本机 Chrome/Edge；本地静态服务器最稳，线上站点也可指定 `CDP_URL`。Windows + Node 24 下 headless CDP 偶发崩溃，属测试工具问题，重试即可）：

```bash
python -m http.server 8000
$env:CDP_URL="http://127.0.0.1:8000/game-project/code/"
node game-project/code/tests/mobile-layout.mjs
```

脚本会在 1440×900、375×667 与 390×844 视口下完整跑通 首页 → 事件 → d20/结果节拍 → 时间窗 → 轮回页 → 出生选择 → 历史，并检查选项数量、首屏可见性、滚动可达性、44px 最小点击区、遮挡命中、时间推进说明、无横向溢出、图片加载与历史记录保存。
