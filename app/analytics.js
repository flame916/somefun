"use strict";

/**
 * 上报预留：首版只做本地打点，不接入任何远端统计服务。
 */

function createAnalytics(enabled) {
  const events = [];
  return {
    track(event) {
      if (enabled === false) return;
      events.push({
        ...event,
        ts: Date.now()
      });
    },
    drain() {
      return events.splice(0, events.length);
    }
  };
}

module.exports = { createAnalytics };
