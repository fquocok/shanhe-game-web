(() => {
  const KEY = "shanhe.save.v1";
  const SCHEMA_VERSION = 2;
  const GAME_ID = "shanhe";

  // 第 3 期：青禾渡區域圖的預設位置與布袋起始文數（第 15 章結尾她布袋裡三十文，遊戲推估）。
  const WORLD_DEFAULTS = { area: "qinghedu", node: "qh-hut", time: "night" };
  const WALLET_START = 30;

  function newExploreSeed() {
    return 100000 + Math.floor(Math.random() * 900000);
  }

  function emptyWorld() {
    return { ...WORLD_DEFAULTS, explore_seed: newExploreSeed(), step_count: 0 };
  }

  function isObj(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  // 依序掛遷移函數：key 是目標版本。
  const MIGRATIONS = {
    2: (save) => {
      const next = { ...save };
      next.world = emptyWorld();
      next.quests = {};
      next.flags = {};
      next.wallet = { wen: WALLET_START };
      const stages = isObj(save.stages) ? save.stages : {};
      const escort = stages["st15-escort"];
      const mud = stages["st15-mud"];
      const held = escort && escort.status === "cleared" && escort.result === "VICTORY";
      const mudDone = mud && mud.status === "cleared";
      // 已打過的關不逼玩家重打（Yuki 定稿：兩關都過 → 任務一停在 go_ferry，早上，茅棚）。
      if (held && mudDone) {
        next.world.time = "morning";
        next.world.node = "qh-hut";
        next.quests["q-qh-night"] = { status: "active", step: "go_ferry", started_at: save.updated_at || null, done_at: null };
        next.flags = { "seen.opening": true, "barge.held": true, "mud.done": true, slept: true };
      } else if (held) {
        next.world.time = "night";
        next.world.node = "qh-shed";
        next.quests["q-qh-night"] = { status: "active", step: "go_home", started_at: save.updated_at || null, done_at: null };
        next.flags = { "seen.opening": true, "barge.held": true };
      }
      next.schema_version = 2;
      return next;
    },
  };

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
      settings: { seed_policy: "recommended", battle_control: "manual" },
      world: emptyWorld(),
      quests: {},
      flags: {},
      wallet: { wen: WALLET_START },
    };
  }

  function normalizeWorld(save) {
    const w = isObj(save.world) ? save.world : {};
    const seed = Number(w.explore_seed);
    save.world = {
      ...w,
      area: typeof w.area === "string" && w.area ? w.area : WORLD_DEFAULTS.area,
      node: typeof w.node === "string" && w.node ? w.node : WORLD_DEFAULTS.node,
      time: w.time === "morning" || w.time === "night" ? w.time : WORLD_DEFAULTS.time,
      explore_seed: Number.isFinite(seed) && seed > 0 ? Math.floor(seed) : newExploreSeed(),
      step_count: Math.max(0, Math.floor(Number(w.step_count) || 0)),
    };
    if (!isObj(save.quests)) save.quests = {};
    if (!isObj(save.flags)) save.flags = {};
    if (!isObj(save.wallet) || !Number.isFinite(Number(save.wallet.wen))) save.wallet = { wen: WALLET_START };
    else save.wallet = { ...save.wallet, wen: Number(save.wallet.wen) };
    return save;
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
    if (!save.settings || typeof save.settings !== "object") save.settings = { seed_policy: "recommended", battle_control: "manual" };
    if (!save.settings.seed_policy) save.settings.seed_policy = "recommended";
    if (save.settings.battle_control !== "auto") save.settings.battle_control = "manual";
    save.schema_version = Math.max(1, Number(save.schema_version) || 1);
    if (save.schema_version >= 2) normalizeWorld(save);
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


  function getSetting(key) {
    const save = load();
    return save.settings ? save.settings[key] : undefined;
  }

  function setSetting(key, value) {
    const save = load();
    if (!save.settings || typeof save.settings !== "object") {
      save.settings = { seed_policy: "recommended", battle_control: "manual" };
    }
    save.settings[key] = value;
    return persist(save);
  }

  /** 讀出、交給 fn 修改、再寫回。fn 回傳值若是物件就當成新的存檔。 */
  function update(fn) {
    const save = load();
    const next = fn(save) || save;
    return persist(next);
  }

  const api = {
    KEY,
    SCHEMA_VERSION,
    WORLD_DEFAULTS,
    WALLET_START,
    update,
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
    getSetting,
    setSetting,
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.ShanheSave = api;
})();
