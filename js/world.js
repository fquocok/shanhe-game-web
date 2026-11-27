(() => {
  /**
   * 第 3 期世界層邏輯（純函式，不碰 DOM）：條件、效果、任務推進、路徑、遭遇擲骰、資料檢查。
   * 只動世界層存檔欄位（world / quests / flags / wallet），不改戰鬥語意。
   */

  function isObj(v) { return Boolean(v) && typeof v === "object" && !Array.isArray(v); }

  function questState(save, id) {
    return save && save.quests ? save.quests[id] : null;
  }

  function evalCond(cond, save) {
    if (!cond || !isObj(cond)) return true;
    const keys = Object.keys(cond);
    if (!keys.length) return true;
    return keys.every((key) => {
      const v = cond[key];
      switch (key) {
        case "all": return (v || []).every((c) => evalCond(c, save));
        case "any": return (v || []).some((c) => evalCond(c, save));
        case "not": return !evalCond(v, save);
        case "time": return Boolean(save.world) && save.world.time === v;
        case "flag": return Boolean(save.flags && save.flags[v]);
        case "at_node": return Boolean(save.world) && save.world.node === v;
        case "quest_step": {
          const q = questState(save, v[0]);
          return Boolean(q) && q.status === "active" && q.step === v[1];
        }
        case "quest_done": {
          const q = questState(save, v);
          return Boolean(q) && q.status === "done";
        }
        case "stage_cleared": {
          const id = typeof v === "string" ? v : v.id;
          const entry = save.stages ? save.stages[id] : null;
          if (!entry || entry.status !== "cleared") return false;
          return typeof v === "string" || !v.result || entry.result === v.result;
        }
        default:
          throw new Error("未知條件：" + key);
      }
    });
  }

  const EFFECT_KEYS = ["set_flag", "clear_flag", "set_time", "move_to", "wallet_add", "start_quest", "advance_quest", "battle"];

  /** 套用效果，回傳 { save, battle }。battle 是要進的戰鬥關 id（由呼叫端處理）。 */
  function applyEffects(save, effects, questDefs) {
    let battle = null;
    (effects || []).forEach((fx) => {
      if (!isObj(fx)) return;
      Object.keys(fx).forEach((key) => {
        const v = fx[key];
        if (key === "set_flag") save.flags[v] = true;
        else if (key === "clear_flag") delete save.flags[v];
        else if (key === "set_time") save.world.time = v;
        else if (key === "move_to") save.world.node = v;
        else if (key === "wallet_add") save.wallet.wen = Number(save.wallet.wen || 0) + Number(v || 0);
        else if (key === "start_quest") startQuest(save, findQuest(questDefs, v));
        else if (key === "advance_quest") advanceQuest(save, findQuest(questDefs, v), questDefs);
        else if (key === "battle") battle = v;
        else throw new Error("未知效果：" + key);
      });
    });
    return { save, battle };
  }

  function findQuest(questDefs, id) {
    const list = (questDefs && questDefs.quests) || [];
    return list.find((q) => q.id === id) || null;
  }

  function startQuest(save, def) {
    if (!def || save.quests[def.id]) return;
    save.quests[def.id] = {
      status: "active",
      step: def.steps[0] ? def.steps[0].id : null,
      started_at: nowIso(),
      done_at: null,
    };
  }

  function completeQuest(save, def, questDefs) {
    const q = save.quests[def.id];
    q.status = "done";
    q.step = null;
    q.done_at = nowIso();
    applyEffects(save, def.on_complete, questDefs);
  }

  function advanceQuest(save, def, questDefs) {
    if (!def) return;
    const q = save.quests[def.id];
    if (!q || q.status !== "active") return;
    const idx = def.steps.findIndex((s) => s.id === q.step);
    const next = def.steps[idx + 1];
    if (next) q.step = next.id;
    else completeQuest(save, def, questDefs);
  }

  function nowIso() {
    const save = typeof window !== "undefined" ? window.ShanheSave : null;
    if (save && save.nowIso) return save.nowIso();
    return new Date().toISOString();
  }

  /** 依條件自動接任務、推進步驟，直到穩定。回傳是否有變。 */
  function progressQuests(save, questDefs) {
    const list = (questDefs && questDefs.quests) || [];
    let changed = false;
    for (let guard = 0; guard < 64; guard += 1) {
      let moved = false;
      list.forEach((def) => {
        const q = save.quests[def.id];
        if (!q) {
          if (evalCond(def.starts_when, save)) {
            startQuest(save, def);
            moved = true;
          }
          return;
        }
        if (q.status !== "active") return;
        const step = def.steps.find((s) => s.id === q.step);
        if (!step) {
          completeQuest(save, def, questDefs);
          moved = true;
          return;
        }
        if (step.done_when && Object.keys(step.done_when).length && evalCond(step.done_when, save)) {
          advanceQuest(save, def, questDefs);
          moved = true;
        }
      });
      if (!moved) break;
      changed = true;
    }
    return changed;
  }

  /** 目前要顯示的任務：第一個進行中的任務與步驟。全部做完回傳 { done: true }。 */
  function currentQuest(save, questDefs) {
    const list = (questDefs && questDefs.quests) || [];
    for (const def of list) {
      const q = save.quests[def.id];
      if (q && q.status === "active") {
        const step = def.steps.find((s) => s.id === q.step) || null;
        return { quest: def, step, done: false };
      }
    }
    const all = list.length > 0 && list.every((def) => save.quests[def.id] && save.quests[def.id].status === "done");
    return { quest: null, step: null, done: all };
  }

  function edgeOpen(edge, save) {
    if (!edge || edge.locked) return false;
    return evalCond(edge.when, save);
  }

  function nodeById(map, id) {
    return ((map && map.nodes) || []).find((n) => n.id === id) || null;
  }

  function edgesOf(map, id) {
    return ((map && map.edges) || []).filter((e) => e.a === id || e.b === id);
  }

  function other(edge, id) { return edge.a === id ? edge.b : edge.a; }

  /**
   * 找路。回傳 { ok, path: [nodeId...], edges: [edge...], reason }。
   * reason：locked（點未開放）、closed（現在走不到，例如夜裡）、same（就在這裡）。
   */
  function findPath(map, save, from, to) {
    const target = nodeById(map, to);
    if (!target) return { ok: false, reason: "missing" };
    if (target.locked) return { ok: false, reason: "locked" };
    if (from === to) return { ok: false, reason: "same" };
    const prev = new Map([[from, null]]);
    const queue = [from];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === to) break;
      edgesOf(map, cur).forEach((edge) => {
        if (!edgeOpen(edge, save)) return;
        const nxt = other(edge, cur);
        const n = nodeById(map, nxt);
        if (!n || n.locked || prev.has(nxt)) return;
        prev.set(nxt, { from: cur, edge });
        queue.push(nxt);
      });
    }
    if (!prev.has(to)) return { ok: false, reason: "closed" };
    const path = [];
    const edges = [];
    let cur = to;
    while (cur !== from) {
      const p = prev.get(cur);
      path.unshift(cur);
      edges.unshift(p.edge);
      cur = p.from;
    }
    return { ok: true, path, edges };
  }

  /** 第一個條件成立的對話組。 */
  function pickTalk(npc, save) {
    const talks = (npc && npc.talks) || [];
    return talks.find((t) => evalCond(t.when, save)) || null;
  }

  function pickBlurb(copyNode, save) {
    const blurbs = (copyNode && copyNode.blurbs) || [];
    const hit = blurbs.find((b) => evalCond(b.when, save));
    return hit ? hit.text : "";
  }

  function actionsFor(node, save) {
    return ((node && node.actions) || []).filter((a) => evalCond(a.when, save));
  }

  function arrivalFor(node, save) {
    return ((node && node.on_arrive) || []).find((t) => evalCond(t.when, save)) || null;
  }

  // mulberry32：探索種子＋步數決定每一步的骰子，回報時可重現。
  function rand(seed, step) {
    let t = ((Number(seed) >>> 0) ^ Math.imul((Number(step) >>> 0) + 1, 0x9E3779B1)) >>> 0;
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  }

  function encounterFlag(tableId, save) {
    return "enc." + tableId + "." + ((save.world && save.world.time) || "any");
  }

  /** 走過一條路時擲遭遇。回傳 entry 或 null；有中就記旗標（同一時段最多 max_per_outing 回）。 */
  function rollEncounter(save, edge, encDefs) {
    if (!edge || !edge.encounters || !encDefs || !encDefs.tables) return null;
    const table = encDefs.tables[edge.encounters];
    if (!table || !evalCond(table.when, save)) return null;
    const flag = encounterFlag(edge.encounters, save);
    const seen = Number((save.flags && save.flags[flag]) || 0);
    if (seen >= (table.max_per_outing || 1)) return null;
    const roll = rand(save.world.explore_seed, save.world.step_count);
    if (roll >= Number(table.chance_per_step || 0)) return null;
    const entries = table.entries || [];
    const total = entries.reduce((sum, e) => sum + (Number(e.weight) || 1), 0);
    let pick = rand(save.world.explore_seed ^ 0x5bd1e995, save.world.step_count) * total;
    let chosen = entries[0] || null;
    for (const e of entries) {
      pick -= Number(e.weight) || 1;
      if (pick < 0) { chosen = e; break; }
    }
    if (chosen) save.flags[flag] = seen + 1;
    return chosen;
  }

  function scriptedFor(encDefs, nodeId, save) {
    return ((encDefs && encDefs.scripted) || []).find((s) => s.node === nodeId
      && (!s.quest_step || evalCond({ quest_step: s.quest_step }, save))) || null;
  }

  function collectCondKeys(cond, out) {
    if (!isObj(cond)) return out;
    Object.keys(cond).forEach((k) => {
      out.push(k);
      if (k === "all" || k === "any") (cond[k] || []).forEach((c) => collectCondKeys(c, out));
      if (k === "not") collectCondKeys(cond[k], out);
    });
    return out;
  }

  const COND_KEYS = ["all", "any", "not", "time", "flag", "at_node", "quest_step", "quest_done", "stage_cleared"];

  /** 一次檢查四份世界檔與關卡清單是否接得起來。回傳錯誤字串陣列。 */
  function validateWorld({ map, copy, quests, encounters, manifest, validateScript }) {
    const errors = [];
    const push = (msg) => errors.push(msg);
    if (!map || map.contract !== "SHANHE_AREA_MAP_V0_1") push("地圖合約不對");
    if (!copy || copy.schema !== "SHANHE_WORLD_COPY_V0_1") push("世界文案合約不對");
    if (!quests || quests.contract !== "SHANHE_QUEST_V0_1") push("任務合約不對");
    if (!encounters || encounters.contract !== "SHANHE_ENCOUNTER_TABLE_V0_1") push("遭遇表合約不對");
    if (errors.length) return errors;
    const ids = new Set();
    map.nodes.forEach((n) => {
      if (ids.has(n.id)) push("點 id 重複：" + n.id);
      ids.add(n.id);
      if (!copy.nodes[n.id]) push("點缺文案：" + n.id);
    });
    if (!ids.has(map.start_node)) push("起點不存在");
    const stageIds = new Set(((manifest && manifest.nodes) || []).map((n) => n.id));
    const conds = [];
    map.edges.forEach((e) => {
      if (!ids.has(e.a) || !ids.has(e.b)) push("路的端點不存在：" + e.id);
      if (e.encounters && !encounters.tables[e.encounters]) push("路指向不存在的遭遇表：" + e.id);
      conds.push(e.when);
    });
    map.nodes.forEach((n) => {
      (n.actions || []).forEach((a) => {
        conds.push(a.when);
        if (a.type === "talk" && !copy.npcs[a.npc]) push("找不到 NPC：" + a.npc);
        if (a.type === "inspect" && !copy.inspects[a.inspect]) push("找不到看一眼：" + a.inspect);
        if ((a.type === "rest") && !copy.scripts[a.script]) push("找不到事件稿：" + a.script);
        if (a.type === "stage" && !stageIds.has(a.stage_id)) push("關卡清單沒有：" + a.stage_id);
        if (!["talk", "inspect", "stage", "rest", "exit"].includes(a.type)) push("未知動作：" + a.type);
      });
      (n.on_arrive || []).forEach((t) => {
        conds.push(t.when);
        if (t.script && !copy.scripts[t.script]) push("找不到事件稿：" + t.script);
        if (t.stage_id && !stageIds.has(t.stage_id)) push("關卡清單沒有：" + t.stage_id);
      });
    });
    Object.entries(copy.npcs).forEach(([id, npc]) => {
      const talks = npc.talks || [];
      if (!talks.some((t) => !t.when || !Object.keys(t.when).length)) push("NPC 缺預設對話：" + id);
      talks.forEach((t) => conds.push(t.when));
    });
    Object.values(copy.nodes).forEach((n) => (n.blurbs || []).forEach((b) => conds.push(b.when)));
    quests.quests.forEach((q) => {
      conds.push(q.starts_when);
      if (!copy.quests[q.id]) push("任務缺文案：" + q.id);
      q.steps.forEach((s) => {
        conds.push(s.done_when);
        if (s.target_node && !ids.has(s.target_node)) push("任務目標點不存在：" + q.id + "/" + s.id);
        if (!copy.quests[q.id] || !copy.quests[q.id].steps[s.id]) push("任務步驟缺提示：" + q.id + "/" + s.id);
      });
    });
    (encounters.scripted || []).forEach((s) => {
      if (!ids.has(s.node)) push("劇情遭遇點不存在：" + s.id);
      if (s.stage_id && !stageIds.has(s.stage_id)) push("關卡清單沒有：" + s.stage_id);
      Object.values(s.after || {}).forEach((k) => { if (!copy.scripts[k]) push("找不到事件稿：" + k); });
    });
    Object.values(encounters.tables).forEach((t) => (t.entries || []).forEach((e) => {
      if (e.type === "event" && !copy.events[e.event]) push("找不到路上小事：" + e.event);
      if (e.type === "battle" && !stageIds.has(e.stage_id)) push("關卡清單沒有：" + e.stage_id);
    }));
    conds.forEach((c) => collectCondKeys(c, []).forEach((k) => {
      if (!COND_KEYS.includes(k)) push("未知條件：" + k);
    }));
    allScripts(copy).forEach(({ id, script }) => {
      walkEffects(script).forEach((fx) => Object.keys(fx).forEach((k) => {
        if (!EFFECT_KEYS.includes(k)) push("未知效果：" + k + "（" + id + "）");
      }));
      if (validateScript) {
        try { validateScript(script); } catch (err) { push(id + "：" + err.message); }
      }
    });
    return errors;
  }

  function walkEffects(script) {
    const out = [];
    Object.values((script && script.scenes) || {}).forEach((s) => (s.effects || []).forEach((fx) => out.push(fx)));
    return out;
  }

  function allScripts(copy) {
    const out = [];
    Object.entries(copy.scripts || {}).forEach(([id, script]) => out.push({ id: "scripts." + id, script }));
    Object.entries(copy.inspects || {}).forEach(([id, script]) => out.push({ id: "inspects." + id, script }));
    Object.entries(copy.events || {}).forEach(([id, script]) => out.push({ id: "events." + id, script }));
    Object.entries(copy.npcs || {}).forEach(([id, npc]) => (npc.talks || []).forEach((t) => out.push({ id: id + "/" + t.id, script: t.script })));
    return out;
  }

  const api = {
    evalCond,
    applyEffects,
    progressQuests,
    currentQuest,
    startQuest,
    advanceQuest,
    findQuest,
    edgeOpen,
    findPath,
    nodeById,
    edgesOf,
    pickTalk,
    pickBlurb,
    actionsFor,
    arrivalFor,
    rollEncounter,
    scriptedFor,
    rand,
    validateWorld,
    allScripts,
    EFFECT_KEYS,
    COND_KEYS,
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.ShanheWorld = api;
})();
