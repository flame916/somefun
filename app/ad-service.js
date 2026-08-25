/**
 * IAA 广告预留服务：只做配置解析、频控与失败兜底，不接入真实广告 SDK。
 * 后续接入微信广告时，只需在 ADAPTERS.wx 中补 createInterstitialAd 等实现。
 */

const ADAPTERS = {
  wx: {
    name: "wechat-miniprogram",
    ready: false,
    createInterstitialAd() {
      return null;
    },
    createRewardedVideoAd() {
      return null;
    },
    createBannerAd() {
      return null;
    }
  }
};

class AdService {
  constructor(config) {
    this.config = config || { enabled: false, global: {}, placements: [] };
    this.impressions = {};
    this.calls = {};
    this.provider = null;
  }

  init() {
    const providerName = this.config.defaultProvider || "wx";
    this.provider = ADAPTERS[providerName] || ADAPTERS.wx;
    return { ready: this.config.enabled === true && !!this.provider };
  }

  placementById(id) {
    return (this.config.placements || []).find((p) => p.id === id) || null;
  }

  canShow(placement, now) {
    if (!this.config.enabled || !placement || placement.enabled !== true) return false;
    const global = this.config.global || {};
    const key = placement.id;
    const last = this.impressions[key] || 0;
    const interval = placement.minIntervalMs || global.minIntervalMs || 0;
    const cap = placement.dailyCap ?? global.dailyCap ?? 0;
    const dayKey = new Date(now).toISOString().slice(0, 10);
    const dayCount = this.calls[key]?.date === dayKey ? this.calls[key].count : 0;
    return last + interval <= now && (cap <= 0 || dayCount < cap);
  }

  show(id, context) {
    const placement = this.placementById(id);
    if (!this.canShow(placement, Date.now())) {
      return { shown: false, reason: "throttled_or_disabled", fallback: placement?.fallback || "none" };
    }

    const record = {
      placementId: id,
      context: context || {},
      result: "not_implemented",
      fallback: placement?.fallback || "none",
      timestamp: Date.now()
    };
    this.impressions[id] = Date.now();
    const dayKey = new Date().toISOString().slice(0, 10);
    const day = this.calls[id] || { date: dayKey, count: 0 };
    day.count += 1;
    this.calls[id] = day;

    return {
      shown: false,
      reason: "adapter_not_ready",
      record,
      fallback: record.fallback
    };
  }
}

function createAdService(config) {
  return new AdService(config);
}

export { createAdService, AdService };
