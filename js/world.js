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
        case "has_item": {
          const [id, n] = Array.isArray(v) ? v : [v, 1];
          return Number((save.inventory && save.inventory[id]) || 0) >= Number(n || 1);
        }
        case "day_at_least": return Number((save.world && save.world.day) || 1) >= Number(v);
        case "season": return Boolean(save.world) && save.world.season === v;
        case "in_region": return Boolean(save.world) && save.world.region === v;
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

  const EFFECT_KEYS = ["set_flag", "clear_flag", "set_time", "move_to", "wallet_add", "start_quest", "advance_quest", "battle",
    "item_add", "item_remove", "set_day", "advance_day", "set_season", "travel_to"];

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
        else if (key === "item_add" || key === "item_remove") {
          // 大地圖第 3 步：隨身物（只是計數，不影響戰鬥）。
          const id = isObj(v) ? v.id : v;
          const n = Number((isObj(v) && v.n) || 1) * (key === "item_add" ? 1 : -1);
          if (!save.inventory) save.inventory = {};
          const next = Number(save.inventory[id] || 0) + n;
          if (next > 0) save.inventory[id] = next;
          else delete save.inventory[id];
        }
        else if (key === "set_day") save.world.day = Math.max(1, Number(v) || 1);
        else if (key === "advance_day") {
          save.world.day = Math.max(1, Number(save.world.day || 1) + Number(v || 1));
          save.world.time = "morning";
        }
        else if (key === "set_season") save.world.season = v;
        else if (key === "travel_to") {
          save.world.region = v.region;
          if (v.node) save.world.node = v.node;
        }
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
    const entries = (table.entries || []).filter(entryAllowed);
    if (!entries.length) return null;
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

  const COND_KEYS = ["all", "any", "not", "time", "flag", "at_node", "quest_step", "quest_done", "stage_cleared",
    "has_item", "day_at_least", "season", "in_region"];

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
        if (a.label && !(copy.ui && copy.ui[a.label])) push("動作缺按鈕字：" + a.id);
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
    validateEncounterOperators(encounters).forEach(push);
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


  // ---- 大地圖第 3–7 步：引擎骨架（不含玩家字；資料檔預設關閉） ----

  /** 遭遇條目能不能被擲到：battle 條目必須有操作方、不可是阿禾、且已核准。 */
  function entryAllowed(entry) {
    if (!entry || entry.type !== "battle") return true;
    return Boolean(entry.operator) && entry.operator !== "ahe" && entry.approved === true;
  }

  /** 檢查遭遇表裡會開打的條目。回傳錯誤字串陣列（未核准不算錯，只是擲不到）。 */
  function validateEncounterOperators(encDefs) {
    const errors = [];
    Object.entries((encDefs && encDefs.tables) || {}).forEach(([tid, t]) => (t.entries || []).forEach((e, i) => {
      if (e.type !== "battle") return;
      if (!e.operator) errors.push("會開打的遭遇缺操作方：" + tid + "#" + i);
      else if (e.operator === "ahe") errors.push("阿禾不上場打人：" + tid + "#" + i);
    }));
    return errors;
  }

  /** 功能開關：資料檔 enabled 為 true，且頻道列在 channels 裡（沒寫 channels 就只開私人頻道）。 */
  function featureEnabled(data, channel) {
    if (!data || data.enabled !== true || !channel) return false;
    const allowed = Array.isArray(data.channels) ? data.channels : ["private"];
    return allowed.includes(channel);
  }

  /** 把大地圖轉成 findPath 吃的 { nodes, edges } 形狀。 */
  function graphAsMap(graph) {
    return {
      nodes: (graph.regions || []).map((r) => ({ ...r })),
      edges: (graph.routes || []).map((r) => ({ ...r })),
    };
  }

  /** 大地圖找路：回傳 { ok, path, edges, half_days, reason }。 */
  function regionPath(graph, save, from, to) {
    const res = findPath(graphAsMap(graph), save, from, to);
    if (!res.ok) return res;
    return { ...res, half_days: travelCost(res.edges) };
  }

  function travelCost(edges) {
    return (edges || []).reduce((sum, e) => sum + Math.max(1, Number(e.half_days) || 1), 0);
  }

  /**
   * 走完一段大地圖路：推日子、換區域與落點。
   * 規則（遊戲推估）：每兩個半日算一天；早上出發走一個半日，到時是同一天傍晚（記成 night）。
   */
  function applyTravel(save, graph, res) {
    if (!res || !res.ok) return save;
    const halves = res.half_days;
    const startNight = save.world.time === "night" ? 1 : 0;
    const total = startNight + halves;
    save.world.day = Number(save.world.day || 1) + Math.floor(total / 2);
    save.world.time = total % 2 === 1 ? "night" : "morning";
    const dest = (graph.regions || []).find((r) => r.id === res.path[res.path.length - 1]);
    if (dest) {
      save.world.region = dest.area || dest.id;
      if (dest.entry_node) save.world.node = dest.entry_node;
    }
    save.world.step_count = Number(save.world.step_count || 0) + res.edges.length;
    return save;
  }

  function validateRegionGraph(graph) {
    const errors = [];
    if (!graph || graph.contract !== "SHANHE_REGION_GRAPH_V0_1") return ["大地圖合約不對"];
    const ids = new Set();
    (graph.regions || []).forEach((r) => {
      if (ids.has(r.id)) errors.push("大地圖點 id 重複：" + r.id);
      ids.add(r.id);
      if (typeof r.x !== "number" || typeof r.y !== "number") errors.push("大地圖點缺座標：" + r.id);
    });
    if (!ids.has(graph.start_region)) errors.push("大地圖起點不存在");
    (graph.routes || []).forEach((e) => {
      if (!ids.has(e.a) || !ids.has(e.b)) errors.push("大地圖路的端點不存在：" + e.id);
      if (!(Number(e.half_days) >= 1)) errors.push("大地圖路缺路程：" + e.id);
      collectCondKeys(e.when, []).forEach((k) => { if (!COND_KEYS.includes(k)) errors.push("未知條件：" + k); });
    });
    return errors;
  }

  /**
   * 把時節補丁併進區域圖（回傳新物件，不改原圖）。
   * always_node_actions 不看時節（例如進臘月的按鈕）；其餘只在 patch.when 成立時併入。
   */
  function applyAreaPatch(map, patch, save) {
    if (!patch) return map;
    const out = { ...map, nodes: map.nodes.map((n) => ({ ...n })), edges: map.edges.slice() };
    const addActions = (table) => Object.entries(table || {}).forEach(([id, actions]) => {
      const n = out.nodes.find((x) => x.id === id);
      if (n) n.actions = (n.actions || []).concat(actions);
    });
    addActions(patch.always_node_actions);
    if (patch.when && save && !evalCond(patch.when, save)) return out;
    (patch.add_nodes || []).forEach((n) => out.nodes.push({ ...n }));
    (patch.add_edges || []).forEach((e) => out.edges.push({ ...e }));
    const hide = new Set(patch.hide_actions || []);
    if (hide.size) out.nodes.forEach((n) => { if (n.actions) n.actions = n.actions.filter((a) => !hide.has(a.id)); });
    addActions(patch.node_actions);
    Object.entries(patch.node_on_arrive || {}).forEach(([id, trigs]) => {
      const n = out.nodes.find((x) => x.id === id);
      // 補丁的觸發排在原本的前面：臘月的事先發生。
      if (n) n.on_arrive = trigs.concat(n.on_arrive || []);
    });
    return out;
  }

  /** 補丁裡第一個條件成立的自動段（播過記 auto.<id>）。 */
  function pickAuto(patch, save) {
    return ((patch && patch.autos) || []).find((a) => !save.flags["auto." + a.id] && evalCond(a.when, save)) || null;
  }

  /** 補丁的「眼下的事」提示（沒有進行中任務時用）：回傳 ui 鍵。 */
  function pickQuestHint(patch, save) {
    if (patch && patch.when && !evalCond(patch.when, save)) return null;
    const hit = ((patch && patch.quest_hints) || []).find((t) => evalCond(t.when, save));
    return hit ? hit.ui : null;
  }

  /** 補丁指定的提示目標點（任務步驟沒有 target_node 時用）。 */
  function pickTarget(patch, save) {
    const hit = ((patch && patch.targets) || []).find((t) => evalCond(t.when, save));
    return hit ? hit.node : null;
  }

  /** 把補丁文案疊到區域文案上（回傳新物件）。npc_prepend 的對話排在既有 NPC 對話前面。 */
  function mergeCopy(base, overlay) {
    if (!overlay) return base;
    const out = JSON.parse(JSON.stringify(base));
    ["nodes", "inspects", "scripts", "events", "quests"].forEach((k) => { out[k] = { ...(out[k] || {}), ...(overlay[k] || {}) }; });
    out.ui = { ...(out.ui || {}), ...(overlay.ui || {}) };
    out.npcs = { ...(out.npcs || {}), ...(overlay.npcs || {}) };
    Object.entries(overlay.npc_prepend || {}).forEach(([id, talks]) => {
      if (out.npcs[id]) out.npcs[id] = { ...out.npcs[id], talks: talks.concat(out.npcs[id].talks || []) };
    });
    // blurb_prepend：時節短注排在原本短注前面（各自帶 when）。
    Object.entries(overlay.blurb_prepend || {}).forEach(([id, blurbs]) => {
      if (out.nodes[id]) out.nodes[id] = { ...out.nodes[id], blurbs: blurbs.concat(out.nodes[id].blurbs || []) };
    });
    return out;
  }

  function mergeQuests(base, extra) {
    if (!extra) return base;
    return { ...base, quests: (base.quests || []).concat(extra.quests || []) };
  }

  function validateAreaPatch(map, patch) {
    const errors = [];
    if (!patch || patch.contract !== "SHANHE_AREA_PATCH_V0_1") return ["區域補丁合約不對"];
    if (patch.area_id !== map.area_id) errors.push("補丁區域不對：" + patch.area_id);
    const ids = new Set(map.nodes.map((n) => n.id));
    (patch.add_nodes || []).forEach((n) => {
      if (ids.has(n.id)) errors.push("補丁點 id 重複：" + n.id);
      ids.add(n.id);
    });
    (patch.add_edges || []).forEach((e) => {
      if (!ids.has(e.a) || !ids.has(e.b)) errors.push("補丁路的端點不存在：" + e.id);
    });
    ["node_actions", "always_node_actions", "node_on_arrive"].forEach((k) => Object.keys(patch[k] || {}).forEach((id) => {
      if (!ids.has(id)) errors.push("補丁動作的點不存在：" + id);
    }));
    (patch.targets || []).forEach((t) => { if (!ids.has(t.node)) errors.push("補丁提示點不存在：" + t.node); });
    const conds = [patch.when];
    (patch.autos || []).forEach((a) => conds.push(a.when));
    (patch.targets || []).forEach((t) => conds.push(t.when));
    (patch.quest_hints || []).forEach((t) => { conds.push(t.when); if (!t.ui) errors.push("補丁提示缺 ui 鍵"); });
    conds.forEach((c) => collectCondKeys(c, []).forEach((k) => { if (!COND_KEYS.includes(k)) errors.push("未知條件：" + k); }));
    return errors;
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
    entryAllowed,
    validateEncounterOperators,
    featureEnabled,
    regionPath,
    travelCost,
    applyTravel,
    validateRegionGraph,
    applyAreaPatch,
    validateAreaPatch,
    pickAuto,
    pickTarget, pickQuestHint,
    mergeCopy,
    mergeQuests,
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.ShanheWorld = api;
})();
