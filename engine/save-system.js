"use strict";

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

  return { readHistory, saveResult, saveActive, loadActive, clearActive };
}

module.exports = { createSaveSystem, createStorage };
