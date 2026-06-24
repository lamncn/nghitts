// Simple IndexedDB cache for model files
class ModelCache {
  constructor() {
    this.dbName = "piper-tts-cache";
    this.storeName = "models";
    this.version = 2; // Increment version to trigger upgrade
    this.db = null;
  }

  async init() {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, {
            keyPath: "url",
          });
          store.createIndex("timestamp", "timestamp", { unique: false });
        } else {
          // Upgrade existing store - add contentHash field if needed
          const store = event.target.transaction.objectStore(this.storeName);
          if (!store.indexNames.contains("contentHash")) {
            store.createIndex("contentHash", "contentHash", { unique: false });
          }
        }
      };
    });
  }

  /**
   * Calculate a simple hash of the file content for change detection
   * Uses first 1KB + last 1KB + total size as a fingerprint
   */
  async calculateContentHash(arrayBuffer) {
    try {
      // Use SubtleCrypto for SHA-256 hash (more reliable)
      const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch (error) {
      // Fallback: simple hash using size + first/last bytes
      const view = new Uint8Array(arrayBuffer);
      const size = view.length;
      const firstBytes = Array.from(view.slice(0, Math.min(100, size))).join(
        ",",
      );
      const lastBytes = Array.from(
        view.slice(Math.max(0, size - 100), size),
      ).join(",");
      return `${size}-${firstBytes}-${lastBytes}`;
    }
  }

  async get(url) {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], "readonly");
      const store = transaction.objectStore(this.storeName);
      const request = store.get(url);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const result = request.result;
        if (result) {
          // Check if cache is still valid (7 days)
          const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
          if (Date.now() - result.timestamp < maxAge) {
            // Return cached data with its hash for comparison
            resolve({
              data: result.data,
              contentHash: result.contentHash || null,
            });
            return;
          } else {
            // Cache expired, remove it
            this.delete(url);
          }
        }
        resolve(null);
      };
    });
  }

  async set(url, data, contentHash) {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], "readwrite");
      const store = transaction.objectStore(this.storeName);
      const request = store.put({
        url,
        data,
        contentHash: contentHash || null,
        timestamp: Date.now(),
      });

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async delete(url) {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], "readwrite");
      const store = transaction.objectStore(this.storeName);
      const request = store.delete(url);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async clear() {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], "readwrite");
      const store = transaction.objectStore(this.storeName);
      const request = store.clear();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }
}

// Cached fetch function for model files
export async function cachedFetch(url) {
  const cache = new ModelCache();

  // IndexedDB may be unavailable or out of quota in a mobile WebView. Cache
  // failures must never prevent inference when the network is still usable.
  let cached = null;
  try {
    cached = await cache.get(url);
  } catch (error) {
    console.warn("Model cache read failed; using network:", error);
  }

  // Model URLs are served with immutable cache headers. Returning a valid
  // IndexedDB entry here avoids downloading the full model on every WebView
  // launch. Entries expire after seven days in ModelCache.get().
  if (cached) {
    return new Response(cached.data, { status: 200 });
  }

  // Nothing cached (or the entry expired), so fetch and persist it.
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  // Get the new file data
  const data = await response.arrayBuffer();

  try {
    // URLs are versioned by model name and served as immutable. Hashing the
    // entire ONNX buffer here only adds CPU and peak memory on mobile.
    await cache.set(url, data, null);
  } catch (error) {
    console.warn("Model cache write failed; continuing without cache:", error);
  }

  // Return the new response with the data
  return new Response(data, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export default ModelCache;
