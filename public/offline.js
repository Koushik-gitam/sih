// Offline layer.
//
// A weighbridge cannot be brought to the laboratory, so the application has to
// keep working with no connectivity: drafts are written to IndexedDB and failed
// API calls are queued for replay when the network returns.
//
// Exposed as window.Offline.

(function offlineModule(global) {
  'use strict';

  const DB_NAME = 'nawi-r76';
  const DB_VERSION = 1;
  const STORE_DRAFTS = 'drafts';
  const STORE_QUEUE = 'queue';
  const STORE_META = 'meta';

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!global.indexedDB) return reject(new Error('IndexedDB is not available in this browser'));
      const request = global.indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_DRAFTS)) db.createObjectStore(STORE_DRAFTS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORE_QUEUE)) db.createObjectStore(STORE_QUEUE, { keyPath: 'id', autoIncrement: true });
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'key' });
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function withStore(name, mode) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const transaction = db.transaction(name, mode);
          const store = transaction.objectStore(name);
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onerror = () => {
            db.close();
            reject(transaction.error);
          };
          resolve.store(store);
        }),
    );
  }

  function request(store, method, payload) {
    return new Promise((resolve, reject) => {
      const result = method(store, payload);
      if (!result) return resolve();
      result.onsuccess = () => resolve(result.result);
      result.onerror = () => reject(result.error);
    });
  }

  const Offline = {
    isSupported() {
      return Boolean(global.indexedDB);
    },

    async saveDraft(draft) {
      if (!this.isSupported()) return { ok: false, error: 'IndexedDB unavailable' };
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_DRAFTS, 'readwrite');
        transaction.objectStore(STORE_DRAFTS).put({ ...draft, savedAt: new Date().toISOString() });
        transaction.oncomplete = () => {
          db.close();
          resolve({ ok: true });
        };
        transaction.onerror = () => {
          db.close();
          reject(transaction.error);
        };
      });
    },

    async getDraft(id) {
      if (!this.isSupported()) return null;
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_DRAFTS, 'readonly');
        const result = transaction.objectStore(STORE_DRAFTS).get(id);
        result.onsuccess = () => {
          db.close();
          resolve(result.result || null);
        };
        result.onerror = () => {
          db.close();
          reject(result.error);
        };
      });
    },

    async listDrafts() {
      if (!this.isSupported()) return [];
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_DRAFTS, 'readonly');
        const result = transaction.objectStore(STORE_DRAFTS).getAll();
        result.onsuccess = () => {
          db.close();
          resolve(result.result || []);
        };
        result.onerror = () => {
          db.close();
          reject(result.error);
        };
      });
    },

    async deleteDraft(id) {
      if (!this.isSupported()) return { ok: false };
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_DRAFTS, 'readwrite');
        transaction.objectStore(STORE_DRAFTS).delete(id);
        transaction.oncomplete = () => {
          db.close();
          resolve({ ok: true });
        };
        transaction.onerror = () => {
          db.close();
          reject(transaction.error);
        };
      });
    },

    /** Queue a request that could not reach the server. */
    async enqueue(entry) {
      if (!this.isSupported()) return { ok: false, error: 'IndexedDB unavailable' };
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_QUEUE, 'readwrite');
        transaction.objectStore(STORE_QUEUE).add({ ...entry, queuedAt: new Date().toISOString() });
        transaction.oncomplete = () => {
          db.close();
          resolve({ ok: true });
        };
        transaction.onerror = () => {
          db.close();
          reject(transaction.error);
        };
      });
    },

    async listQueue() {
      if (!this.isSupported()) return [];
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_QUEUE, 'readonly');
        const result = transaction.objectStore(STORE_QUEUE).getAll();
        result.onsuccess = () => {
          db.close();
          resolve(result.result || []);
        };
        result.onerror = () => {
          db.close();
          reject(result.error);
        };
      });
    },

    async dequeue(id) {
      if (!this.isSupported()) return { ok: false };
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_QUEUE, 'readwrite');
        transaction.objectStore(STORE_QUEUE).delete(id);
        transaction.oncomplete = () => {
          db.close();
          resolve({ ok: true });
        };
        transaction.onerror = () => {
          db.close();
          reject(transaction.error);
        };
      });
    },

    /**
     * Replay every queued request through the supplied sender.
     * @param {(entry:{path:string,method:string,body:any}) => Promise<any>} sender
     */
    async flush(sender) {
      const queue = await this.listQueue();
      const results = [];

      for (const entry of queue) {
        try {
          const response = await sender(entry);
          await this.dequeue(entry.id);
          results.push({ id: entry.id, ok: true, response });
        } catch (error) {
          results.push({ id: entry.id, ok: false, error: error.message });
        }
      }

      return results;
    },

    async setMeta(key, value) {
      if (!this.isSupported()) return { ok: false };
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_META, 'readwrite');
        transaction.objectStore(STORE_META).put({ key, value });
        transaction.oncomplete = () => {
          db.close();
          resolve({ ok: true });
        };
        transaction.onerror = () => {
          db.close();
          reject(transaction.error);
        };
      });
    },
  };

  global.Offline = Offline;
})(window);
