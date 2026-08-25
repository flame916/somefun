# IAA 广告接入预留说明

## 状态

首版不接入真实广告。代码中只预留了广告位配置、频控和失败兜底结构，打开页面不会请求任何广告 SDK。

## 预留位置

1. `config/ad-placements.json`：广告位清单，当前全部 `enabled: false`。
2. `app/ad-service.js`：统一的广告服务入口，内置 `wx` 适配器空实现，包含 `canShow` 频控与 `show` 失败兜底。
3. `app/game-controller.js`：控制器持有 `adService`，后续在阶段切换、结算、重开时调用。
4. `app/main.js`：结算页已显示“广告位预留”提示文案，说明触发点存在但未展示广告。

## 频控与兜底

- 每个广告位可配置 `minIntervalMs`（最小间隔）与 `dailyCap`（每日上限），全局配置兜底。
- `fallback: none/direct/hide` 定义广告不可用时的行为；首版统一表现为“不展示、不打断流程”。
- 广告服务所有路径都返回结构化的 `{ shown, reason, fallback }`，核心玩法不依赖广告返回值。

## 接入真实广告时

1. 把 `config/ad-placements.json` 中对应广告位的 `enabled` 改为 `true`，填入微信广告位 `adUnitId`。
2. 在 `app/ad-service.js` 的 `ADAPTERS.wx` 中实现 `createInterstitialAd`、`createRewardedVideoAd`、`createBannerAd`。
3. 在 `game-controller.js` 的对应时机调用 `adService.show(...)`。
4. 不需要修改事件引擎、数值系统或页面主逻辑。
