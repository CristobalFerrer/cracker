/**
 * Cross-tab viewer sync: stable channel name, tab id, IndexedDB snapshot store.
 * Loaded before app.js / viewer.js.
 */
(function (global) {
  const CHANNEL = "cracker-viewer-v1";
  const DB_NAME = "cracker-viewer-sync";
  const DB_VER = 1;
  const STORE = "snapshots";
  const KEY_LATEST = "latest";

  const tabId =
    global.crypto && typeof global.crypto.randomUUID === "function"
      ? global.crypto.randomUUID()
      : "t" + Math.random().toString(36).slice(2);

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onerror = () => reject(req.error);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
    });
  }

  /**
   * @param {Record<string, unknown>} record
   */
  async function saveSnapshot(record) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
      tx.objectStore(STORE).put(record, KEY_LATEST);
    });
  }

  async function loadSnapshot() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(KEY_LATEST);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  global.CrackerSync = {
    CHANNEL,
    tabId,
    saveSnapshot,
    loadSnapshot,
  };
})(typeof self !== "undefined" ? self : window);
