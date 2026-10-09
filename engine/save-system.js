/**
 * 存档系统：浏览器 localStorage 适配；无 storage 时退化为内存存档。
 */

function createStorage(prefix, fallbackStore) {
  let memory = fallbackStore || {};
  const keyFor = (key) => `${prefix}:${key}`;
  return {
    get(key) {
      try {
        if (typeof localStorage !== "undefined") {
          const raw = localStorage.getItem(keyFor(key));
          return raw == null ? null : JSON.parse(raw);
        }
      } catch (error) {
        // 隐私模式或存储被禁用时使用内存存档。
      }
      return memory[key] == null ? null : JSON.parse(JSON.stringify(memory[key]));
    },
    set(key, value) {
      try {
        if (typeof localStorage !== "undefined") {
          localStorage.setItem(keyFor(key), JSON.stringify(value));
          return;
        }
      } catch (error) {
        // 同上，继续写入内存。
      }
      memory[key] = JSON.parse(JSON.stringify(value));
    },
    remove(key) {
      try {
        if (typeof localStorage !== "undefined") {
          localStorage.removeItem(keyFor(key));
        }
      } catch (error) {
        // 忽略存储不可用。
      }
      delete memory[key];
    }
  };
}

function migrateSave(raw) {
  if (!raw || typeof raw !== "object") return null;
  const data = JSON.parse(JSON.stringify(raw));
  if (data.version === 2 && data.fourDims && data.phase) return data;
  const legacyState = { ...(data.attributes || {}), ...(data.state || {}) };
  const legacySoulPoints = Number(data.soul_points ?? data.soulPoints ?? 0) || 0;
  const fourDims = {
    naturalTalent: Number(data.four_dims?.naturalTalent ?? data.fourDims?.naturalTalent ?? 0) || 0,
    aptitude: Number(data.four_dims?.aptitude ?? data.fourDims?.aptitude ?? 0) || 0,
    bloodline: Number(data.four_dims?.bloodline ?? data.fourDims?.bloodline ?? 0) || 0,
    fortune: Number(data.four_dims?.fortune ?? data.fourDims?.fortune ?? 0) || 0
  };
  return {
    ...data,
    version: 2,
    phase: data.phase || (data.currentEventId ? "event" : "event"),
    stageIndex: Number(data.stageIndex) || 0,
    eventIndexInStage: Number(data.eventIndexInStage) || 0,
    currentEventId: data.currentEventId || null,
    flags: Array.isArray(data.flags) ? data.flags : [],
    history: Array.isArray(data.history) ? data.history : [],
    usedEventIds: Array.isArray(data.usedEventIds) ? data.usedEventIds : [],
    state: legacyState,
    attributes: legacyState,
    cycle: Number(data.cycle ?? data.lives_in_cycle ?? 1) || 1,
    livesInCycle: Number(data.livesInCycle ?? data.lives_in_cycle ?? 1) || 1,
    powerSource: data.power_source || data.powerSource || "system",
    systemGuidanceState: data.system_guidance_state || data.systemGuidanceState || "quiet",
    fourDims,
    learningRecords: Array.isArray(data.learning_records) ? data.learning_records : Array.isArray(data.learningRecords) ? data.learningRecords : [],
    memoryFragments: Array.isArray(data.memory_fragments) ? data.memory_fragments : Array.isArray(data.memoryFragments) ? data.memoryFragments : [],
    unfinishedBusiness: Array.isArray(data.unfinished_business) ? data.unfinished_business : Array.isArray(data.unfinishedBusiness) ? data.unfinishedBusiness : [],
    grudgeAnchors: Array.isArray(data.grudge_anchors) ? data.grudge_anchors : Array.isArray(data.grudgeAnchors) ? data.grudgeAnchors : [],
    personLedger: Array.isArray(data.person_ledger) ? data.person_ledger : Array.isArray(data.personLedger) ? data.personLedger : [],
    legacySoulPoints
  };
}

function createSaveSystem(config, storage) {
  const save = config.save || {};
  const store = storage || createStorage(save.storageKeyPrefix || "novel-game");
  const historyKey = "history";
  const activeKey = "active";

  function readHistory() {
    const data = store.get(historyKey);
    return Array.isArray(data) ? data : [];
  }

  function saveResult(result) {
    if (save.enabled === false) return null;
    const history = readHistory();
    history.unshift(result);
    const trimmed = history.slice(0, save.maxHistory || 5);
    store.set(historyKey, trimmed);
    return trimmed;
  }

  function saveActive(snapshot) {
    if (save.autoSave === false) return;
    store.set(activeKey, snapshot);
  }

  function loadActive() {
    return store.get(activeKey);
  }

  function clearActive() {
    store.remove(activeKey);
  }

  function clearAll() {
    store.remove(activeKey);
    store.remove(historyKey);
    store.remove("fourDimAllocation");
    store.remove("soulAllocation");
  }

  return {
    readHistory,
    saveResult,
    saveActive,
    loadActive,
    clearActive,
    migrateSave,
    clearAll,
    raw: () => store
  };
}

export { createSaveSystem, createStorage, migrateSave };
