(() => {
  const KEY = "shanhe.save.v1";
  const SCHEMA_VERSION = 1;
  const GAME_ID = "shanhe";

  // 未來版本把遷移函數依序掛在這裡，例如 2: (save) => { ...; save.schema_version = 2; return save; }
  const MIGRATIONS = {};

  function nowIso() {
    const d = new Date();
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
    const mm = String(Math.abs(off) % 60).padStart(2, "0");
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 19) + sign + hh + ":" + mm;
  }

  function emptySave() {
    return {
      schema_version: SCHEMA_VERSION,
      game_id: GAME_ID,
      updated_at: null,
      stages: {},
      settings: { seed_policy: "recommended" },
    };
  }

  function migrate(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptySave();
    let save = raw;
    let version = Number(save.schema_version);
    if (!Number.isFinite(version) || version < 1) {
      save = {
        ...emptySave(),
        stages: save.stages && typeof save.stages === "object" && !Array.isArray(save.stages) ? save.stages : {},
        settings: { ...emptySave().settings, ...(save.settings || {}) },
        updated_at: save.updated_at || null,
      };
      version = 1;
      save.schema_version = 1;
    }
    if (save.game_id && save.game_id !== GAME_ID) return emptySave();
    while (version < SCHEMA_VERSION) {
      const step = MIGRATIONS[version + 1];
      if (!step) break;
      save = step(save) || save;
      version = Number(save.schema_version) || version + 1;
    }
    if (!save.stages || typeof save.stages !== "object" || Array.isArray(save.stages)) save.stages = {};
    if (!save.settings || typeof save.settings !== "object") save.settings = { seed_policy: "recommended" };
    save.schema_version = Math.max(1, Number(save.schema_version) || 1);
    save.game_id = GAME_ID;
    return save;
  }

  function storage() {
    try {
      return window.localStorage;
    } catch (_) {
      return null;
    }
  }

  function load() {
    const store = storage();
    if (!store) return emptySave();
    try {
      const raw = store.getItem(KEY);
      if (!raw) return emptySave();
      return migrate(JSON.parse(raw));
    } catch (_) {
      return emptySave();
    }
  }

  function persist(save) {
    const next = { ...save, game_id: GAME_ID, updated_at: nowIso() };
    const store = storage();
    if (store) {
      try {
        store.setItem(KEY, JSON.stringify(next));
      } catch (_) {
        /* quota or private mode: keep going with in-memory state */
      }
    }
    return next;
  }

  function recordAttempt(stageId, extra) {
    const save = load();
    const prev = save.stages[stageId] || {};
    const attempts = Number(prev.attempts || 0) + 1;
    save.stages[stageId] = {
      ...prev,
      status: prev.status || "unlocked",
      attempts,
      updated_at: nowIso(),
      ...(extra || {}),
    };
    return persist(save);
  }

  function recordResult(stageId, payload) {
    const save = load();
    const prev = save.stages[stageId] || {};
    const attempts = Number(prev.attempts || 0) + (payload && payload.incrementAttempt === false ? 0 : 0);
    const result = payload && payload.result;
    const cleared = Boolean(result);
    const entry = {
      ...prev,
      status: cleared ? "cleared" : (prev.status || "unlocked"),
      result: result || prev.result || null,
      terminal_label: (payload && payload.terminal_label) || prev.terminal_label || null,
      attempts: Number(prev.attempts || 0) || attempts,
      last_seed: (payload && payload.seed != null) ? payload.seed : prev.last_seed,
      updated_at: nowIso(),
    };
    if (cleared && !prev.cleared_at) entry.cleared_at = nowIso();
    else if (prev.cleared_at) entry.cleared_at = prev.cleared_at;
    save.stages[stageId] = entry;
    return persist(save);
  }

  function stageEntry(stageId) {
    return load().stages[stageId] || null;
  }

  function reset() {
    const store = storage();
    if (store) {
      try { store.removeItem(KEY); } catch (_) { /* ignore */ }
    }
    return emptySave();
  }

  /**
   * 節點是否可進入。
   * public 頻道遇上 review_gate 時一律視為準備中。
   */
  function accessFor(node, save, channel) {
    const ch = channel || "private";
    if (!node) return { state: "locked", label: "未開放", enterable: false };
    if (ch === "public" && node.review_gate) {
      return { state: "preparing", label: "準備中", enterable: false };
    }
    if (node.unlock === "locked") {
      return { state: "locked", label: "未開放", enterable: false };
    }
    if (node.unlock && typeof node.unlock === "object" && Array.isArray(node.unlock.after)) {
      const needed = node.unlock.after;
      const ok = needed.every((id) => save && save.stages && save.stages[id] && save.stages[id].status === "cleared");
      if (!ok) return { state: "locked", label: "未開放", enterable: false };
    }
    const entry = save && save.stages ? save.stages[node.id] : null;
    if (entry && entry.status === "cleared") {
      return { state: "cleared", label: entry.terminal_label || "已過", enterable: true, entry };
    }
    return { state: "open", label: "可入", enterable: true, entry };
  }

  const api = {
    KEY,
    SCHEMA_VERSION,
    migrate,
    emptySave,
    load,
    persist,
    recordAttempt,
    recordResult,
    stageEntry,
    reset,
    accessFor,
    nowIso,
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.ShanheSave = api;
})();
