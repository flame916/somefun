const DATABASE_NAME = "qingxu-r5-local";
const DATABASE_VERSION = 1;
const STORE_NAME = "saveSlots";

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("indexeddb_request_failed"));
  });
}

function transactionResult(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("indexeddb_transaction_failed"));
    transaction.onabort = () => reject(transaction.error || new Error("indexeddb_transaction_aborted"));
  });
}

export class R5LocalSaveStore {
  constructor({ indexedDB = globalThis.indexedDB, databaseName = DATABASE_NAME } = {}) {
    if (!indexedDB) throw new Error("indexeddb_unavailable");
    this.indexedDB = indexedDB;
    this.databaseName = databaseName;
    this.databasePromise = null;
  }

  open() {
    if (!this.databasePromise) {
      const request = this.indexedDB.open(this.databaseName, DATABASE_VERSION);
      this.databasePromise = new Promise((resolve, reject) => {
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: "slotId" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("indexeddb_open_failed"));
      }).catch((error) => {
        this.databasePromise = null;
        throw error;
      });
    }
    return this.databasePromise;
  }

  async save(slotId, dto) {
    if (typeof slotId !== "string" || !slotId || dto?.namespace !== "r5-qingxu-v1" || dto?.runtimeVersion !== "R5-RUNTIME-1" || !dto?.runtimeState) {
      throw new Error("r5_storage_record_invalid");
    }
    const database = await this.open();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const done = transactionResult(transaction);
    try {
      transaction.objectStore(STORE_NAME).put({ slotId, dto, savedAt: Date.now() });
    } catch (error) {
      try { transaction.abort(); } catch {}
      await done.catch(() => {});
      throw error;
    }
    await done;
    return { slotId, saveId: dto.saveId, savedAt: Date.now() };
  }

  async load(slotId) {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const done = transactionResult(transaction);
    const request = transaction.objectStore(STORE_NAME).get(slotId);
    const [record] = await Promise.all([requestResult(request), done]);
    if (!record) return null;
    if (record.slotId !== slotId || record.dto?.namespace !== "r5-qingxu-v1" || record.dto?.runtimeVersion !== "R5-RUNTIME-1" || !record.dto?.runtimeState) {
      throw new Error("r5_storage_record_corrupt");
    }
    return record.dto;
  }

  async remove(slotId) {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const done = transactionResult(transaction);
    transaction.objectStore(STORE_NAME).delete(slotId);
    await done;
  }
}
