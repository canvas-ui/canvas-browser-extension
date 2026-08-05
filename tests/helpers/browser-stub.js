// Minimal chrome.* stub so background modules can be imported and exercised in
// node. Only what the storage layer actually touches: storage.local (promise
// flavour, as MV3 and Firefox both provide) and the onChanged listener the
// BrowserStorage constructor registers.

const data = new Map();

export function installBrowserStub() {
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          const keys = Array.isArray(key) ? key : [key];
          const out = {};
          for (const k of keys) {
            if (data.has(k)) out[k] = structuredClone(data.get(k));
          }
          return out;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) data.set(k, structuredClone(v));
        },
        async remove(key) {
          for (const k of (Array.isArray(key) ? key : [key])) data.delete(k);
        },
        async clear() {
          data.clear();
        }
      },
      onChanged: { addListener() {} }
    }
  };

  // node exposes a read-only navigator; browser-storage only reads userAgent.
  if (!globalThis.navigator?.userAgent?.includes('Chrome')) {
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'node-test-chrome' },
      configurable: true
    });
  }
}

export function resetStorage() {
  data.clear();
}

export function rawStorage() {
  return data;
}
