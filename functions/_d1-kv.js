// Sky31 D1-only KV-compatible store
// V294: D1 is mandatory. The app will NOT fall back to the old Cloudflare KV ORDERS binding.

let schemaPromise = null;

export function withD1Store(env) {
  if (!env || env.__SKY31_D1_WRAPPED) return env;

  const db = env.SKY31_DB || env.DB || env.ORDERS_DB;
  if (!db || typeof db.prepare !== "function") {
    return {
      ...env,
      __SKY31_D1_WRAPPED: true,
      ORDERS: createMissingD1Store()
    };
  }

  return {
    ...env,
    __SKY31_D1_WRAPPED: true,
    ORDERS: createD1KVStore(db)
  };
}

export function sky31D1Status(env) {
  const db = env && (env.SKY31_DB || env.DB || env.ORDERS_DB);
  return {
    enabled: !!(db && typeof db.prepare === "function"),
    binding: env && env.SKY31_DB ? "SKY31_DB" : (env && env.DB ? "DB" : (env && env.ORDERS_DB ? "ORDERS_DB" : "")),
    mode: "D1_ONLY_NO_KV_FALLBACK"
  };
}

function createMissingD1Store() {
  const error = () => new Error("Sky31 D1 binding not found. Please bind SKY31_DB. KV fallback is disabled in this version.");
  return {
    async get() { throw error(); },
    async put() { throw error(); },
    async delete() { throw error(); },
    async list() { throw error(); }
  };
}

function createD1KVStore(db) {
  return {
    async get(key) {
      key = normalizeKey(key);
      if (!key) return null;
      await ensureSchema(db);
      const now = unixNow();
      const row = await db.prepare(
        "SELECT value, expires_at FROM kv_store WHERE key = ?"
      ).bind(key).first();
      if (!row) return null;
      const expiresAt = row.expires_at == null ? null : Number(row.expires_at);
      if (expiresAt && expiresAt <= now) {
        try { await this.delete(key); } catch (_) {}
        return null;
      }
      return row.value == null ? null : String(row.value);
    },

    async put(key, value, options = {}) {
      key = normalizeKey(key);
      if (!key) return;
      await ensureSchema(db);
      const now = unixNow();
      const expiresAt = resolveExpiresAt(options, now);
      await db.prepare(
        "INSERT INTO kv_store (key, value, expires_at, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at, updated_at = excluded.updated_at"
      ).bind(key, String(value == null ? "" : value), expiresAt, now).run();
    },

    async delete(key) {
      key = normalizeKey(key);
      if (!key) return;
      await ensureSchema(db);
      await db.prepare("DELETE FROM kv_store WHERE key = ?").bind(key).run();
    },

    async list(options = {}) {
      await ensureSchema(db);
      const prefix = String(options.prefix || "");
      const limitRaw = Number(options.limit || 1000);
      const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) ? limitRaw : 1000, 1000));
      const offsetRaw = Number(options.cursor || 0);
      const offset = Math.max(0, Number.isFinite(offsetRaw) ? Math.floor(offsetRaw) : 0);
      const now = unixNow();
      const like = escapeLike(prefix) + "%";

      const result = await db.prepare(
        "SELECT key FROM kv_store " +
        "WHERE key LIKE ? ESCAPE '\\' AND (expires_at IS NULL OR expires_at > ?) " +
        "ORDER BY key ASC LIMIT ? OFFSET ?"
      ).bind(like, now, limit + 1, offset).all();

      const rows = Array.isArray(result && result.results) ? result.results : [];
      const visible = rows.slice(0, limit);
      const hasMore = rows.length > limit;

      return {
        keys: visible.map(row => ({ name: String(row.key || "") })).filter(k => k.name),
        list_complete: !hasMore,
        cursor: hasMore ? String(offset + limit) : undefined
      };
    }
  };
}

async function ensureSchema(db) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.prepare(
        "CREATE TABLE IF NOT EXISTS kv_store (" +
        "key TEXT PRIMARY KEY NOT NULL, " +
        "value TEXT, " +
        "expires_at INTEGER, " +
        "updated_at INTEGER NOT NULL" +
        ")"
      ).run();
      await db.prepare("CREATE INDEX IF NOT EXISTS idx_kv_store_expires ON kv_store(expires_at)").run();
      await db.prepare("CREATE INDEX IF NOT EXISTS idx_kv_store_updated ON kv_store(updated_at)").run();
    })().catch(err => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

function resolveExpiresAt(options, now) {
  if (!options || typeof options !== "object") return null;
  if (options.expiration != null) {
    const n = Number(options.expiration);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  }
  if (options.expirationTtl != null) {
    const ttl = Number(options.expirationTtl);
    return Number.isFinite(ttl) && ttl > 0 ? now + Math.floor(ttl) : null;
  }
  return null;
}

function normalizeKey(key) {
  return String(key == null ? "" : key).trim();
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

function escapeLike(value) {
  return String(value || "").replace(/[\\%_]/g, ch => "\\" + ch);
}
