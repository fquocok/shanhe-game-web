(() => {
  /**
   * 第 3 期青禾渡區域圖（畫面與流程）。邏輯在 world.js；對話用 event.js；戰鬥與教學沿用 app.js 既有入口。
   * 點一下選中，再點一下（或按「走過去」）才走。可點範圍至少 44×44。減少動態時不播走路動畫。
   */
  const $ = (id) => document.getElementById(id);
  const W = () => window.ShanheWorld;
  const S = () => window.ShanheSave;

  let data = null; // { map, copy, quests, encounters, manifest }
  let hooks = {};
  let selected = null;
  let walking = false;
  let pendingArrival = null;
  let active = false;
  let mode = "area"; // area：區域圖；region：大地圖（第 3 步，只在私人頻道開）

  function big() { return data && data.bigmap ? data.bigmap : null; }

  /** 目前的區域圖：有臘月補丁就依存檔併進去。 */
  function M(save) {
    const b = big();
    return b && b.patch ? W().applyAreaPatch(data.map, b.patch, save || S().load()) : data.map;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function reducedMotion() {
    return Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function ui(key) { return (data && data.copy.ui[key]) || ""; }

  function withSave(fn) {
    let out;
    const next = S().update((save) => {
      out = fn(save);
      W().progressQuests(save, data.quests);
      return save;
    });
    return { save: next, out };
  }

  function toast(message) {
    const el = $("world-toast");
    if (!el) return;
    el.textContent = message || "";
    el.hidden = !message;
    window.clearTimeout(toast._t);
    if (message) toast._t = window.setTimeout(() => { el.hidden = true; }, 2600);
  }

  function nodeCopy(id) { return data.copy.nodes[id] || {}; }

  function reachInfo(save, id) {
    const here = save.world.node;
    if (id === here) return { ok: false, reason: "same" };
    return W().findPath(M(save), save, here, id);
  }

  function edgeClass(edge, save) {
    if (edge.locked) return "is-locked";
    return W().edgeOpen(edge, save) ? "is-open" : "is-closed";
  }

  function renderQuest(save) {
    const cur = renderQuestText(save);
    const host = $("world-quest-text");
    const bar = $("world-quest");
    if (bar && host) bar.hidden = host.textContent.trim() === "";
    return cur;
  }

  function renderQuestText(save) {
    const host = $("world-quest-text");
    if (!host) return null;
    const cur = W().currentQuest(save, data.quests);
    if (cur.quest && cur.step) {
      const qc = data.copy.quests[cur.quest.id] || { steps: {} };
      host.innerHTML = `<strong>${escapeHtml(qc.title)}</strong><span>${escapeHtml(qc.steps[cur.step.id] || "")}</span>`;
      return cur;
    }
    // 補丁提示（例如臘月還沒去渡口看一眼）：只有一句，不加粗標題。
    const hintKey = big() ? W().pickQuestHint(big().patch, save) : null;
    if (hintKey && ui(hintKey)) {
      host.innerHTML = `<span>${escapeHtml(ui(hintKey))}</span>`;
      return cur;
    }
    // 沒有進行中的任務：最後做完的任務若有收尾句就顯示；第 3 期做完則顯示切片收尾。
    const list = (data.quests && data.quests.quests) || [];
    const lastDone = list.slice().reverse().find((q) => save.quests[q.id] && save.quests[q.id].status === "done");
    const doneLine = lastDone && data.copy.quests[lastDone.id] && data.copy.quests[lastDone.id].done_line;
    if (doneLine) host.innerHTML = `<span>${escapeHtml(doneLine)}</span>`;
    else if (lastDone && save.world.season !== "layue") host.innerHTML = `<span>${escapeHtml(ui("slice_done"))}</span>`;
    else host.innerHTML = "";
    return cur;
  }

  function renderDay(save) {
    const el = $("world-day");
    if (!el) return;
    let text = "";
    if (save.world.season) {
      const day = Number(save.world.day || 1);
      const s = save.world.season;
      text = day >= 21 && ui("day." + s + ".21") ? ui("day." + s + ".21")
        : day >= 10 && ui("day." + s + ".10") ? ui("day." + s + ".10")
          : ui("season." + s);
    }
    el.textContent = text;
    el.hidden = !text;
  }

  function renderFoot() {
    const btn = $("btn-world-bigmap");
    const b = big();
    if (!btn) return;
    btn.hidden = !b;
    if (b) btn.textContent = mode === "region" ? b.copy.ui.back_area : b.copy.ui.bigmap;
  }

  function actionLabel(action) {
    if (action.label && ui(action.label)) return ui(action.label);
    if (action.type === "talk") return ui("talk");
    if (action.type === "inspect") return ui("inspect");
    if (action.type === "rest") return ui("rest");
    if (action.type === "stage") return ui("enter");
    return ui("walk");
  }

  function renderDrawer(save) {
    const id = selected || save.world.node;
    const node = W().nodeById(M(save), id);
    const nc = nodeCopy(id);
    const name = $("world-node-name");
    const blurb = $("world-node-blurb");
    const actions = $("world-actions");
    if (name) name.textContent = nc.label || "";
    if (blurb) blurb.textContent = node && node.locked ? (nc.locked_text || "") : W().pickBlurb(nc, save);
    if (!actions) return;
    actions.innerHTML = "";
    if (!node) return;
    if (id !== save.world.node) {
      if (node.locked) {
        const tag = document.createElement("span");
        tag.className = "world-locked-tag";
        tag.textContent = ui("locked");
        actions.appendChild(tag);
        return;
      }
      const reach = reachInfo(save, id);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn seal world-act";
      btn.textContent = ui("walk");
      btn.disabled = !reach.ok || walking;
      btn.onclick = () => walkTo(id);
      actions.appendChild(btn);
      return;
    }
    W().actionsFor(node, save).forEach((action) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn seal world-act";
      btn.textContent = actionLabel(action);
      btn.disabled = walking;
      btn.onclick = () => runAction(action);
      actions.appendChild(btn);
    });
  }

  function render() {
    if (!data) return;
    const save = S().load();
    const sheet = $("world-sheet");
    if (!sheet) return;
    renderDay(save);
    renderFoot();
    if (mode === "region") {
      renderRegion(save, sheet);
      return;
    }
    const title = $("world-title");
    if (title) title.textContent = data.copy.area_name || "";
    sheet.classList.remove("is-region");
    const map = M(save);
    const cur = renderQuest(save);
    const target = (cur && cur.step && cur.step.target_node) || (big() ? W().pickTarget(big().patch, save) : null);
    const pos = Object.fromEntries(map.nodes.map((n) => [n.id, n]));
    const lines = map.edges.map((e) => {
      const a = pos[e.a];
      const b = pos[e.b];
      return `<line class="world-edge ${edgeClass(e, save)}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" vector-effect="non-scaling-stroke"/>`;
    }).join("");
    const river = `<path class="world-river" d="M -4 90 C 16 82, 30 96, 50 89 C 70 82, 82 94, 104 86" vector-effect="non-scaling-stroke"/>`;
    const svg = `<svg class="world-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${river}${lines}</svg>`;
    const here = save.world.node;
    const nodes = map.nodes.map((n) => {
      const nc = nodeCopy(n.id);
      const cls = ["world-node"];
      if (n.id === here) cls.push("is-here");
      if (n.id === selected) cls.push("is-selected");
      if (n.id === target) cls.push("is-target");
      if (n.locked) cls.push("is-locked");
      else if (n.id !== here && !reachInfo(save, n.id).ok) cls.push("is-closed");
      return `<button type="button" class="${cls.join(" ")}" data-id="${escapeHtml(n.id)}" style="left:${n.x}%;top:${n.y}%;"
        aria-pressed="${n.id === selected ? "true" : "false"}" aria-label="${escapeHtml(nc.label || n.id)}">
        <span class="world-dot" aria-hidden="true"></span>
        <span class="world-node-label">${escapeHtml(nc.label || "")}</span>
      </button>`;
    }).join("");
    const herePos = pos[here] || pos[map.start_node];
    let token = sheet.querySelector(".world-token");
    const tokenLeft = herePos.x + "%";
    const tokenTop = herePos.y + "%";
    sheet.innerHTML = svg + nodes;
    token = token || document.createElement("span");
    token.className = "world-token" + (reducedMotion() ? " no-motion" : "");
    token.setAttribute("aria-hidden", "true");
    token.textContent = "禾";
    sheet.appendChild(token);
    // 先在舊位置掛上，下一幀再移，CSS transition 才會走。
    if (typeof requestAnimationFrame === "function" && !reducedMotion()) {
      requestAnimationFrame(() => { token.style.left = tokenLeft; token.style.top = tokenTop; });
    } else {
      token.style.left = tokenLeft;
      token.style.top = tokenTop;
    }
    sheet.querySelectorAll(".world-node").forEach((btn) => {
      btn.addEventListener("click", () => onTap(btn.getAttribute("data-id")));
    });
    sheet.classList.toggle("is-night", save.world.time === "night");
    const seed = $("world-seed");
    if (seed) seed.textContent = ui("seed").replace("{seed}", String(save.world.explore_seed));
    renderDrawer(save);
  }

  function onTap(id) {
    if (walking) return;
    if (mode === "region") {
      onRegionTap(id);
      return;
    }
    const save = S().load();
    if (id !== selected) {
      selected = id;
      render();
      const node = W().nodeById(M(save), id);
      if (node && node.locked) toast(nodeCopy(id).locked_text || ui("locked"));
      else if (id !== save.world.node && !reachInfo(save, id).ok && save.world.time === "night") toast(ui("night_blocked"));
      else toast("");
      return;
    }
    if (id === save.world.node) return;
    walkTo(id);
  }

  async function walkTo(id) {
    if (walking) return;
    const save0 = S().load();
    const res = reachInfo(save0, id);
    if (!res.ok) {
      if (res.reason === "locked") toast(nodeCopy(id).locked_text || ui("locked"));
      else if (save0.world.time === "night") toast(ui("night_blocked"));
      return;
    }
    walking = true;
    toast("");
    const stepMs = reducedMotion() ? 0 : 260;
    for (let i = 0; i < res.path.length; i += 1) {
      const nodeId = res.path[i];
      const edge = res.edges[i];
      const { out: enc } = withSave((save) => {
        const hit = W().rollEncounter(save, edge, data.encounters);
        save.world.step_count += 1;
        save.world.node = nodeId;
        return hit;
      });
      selected = nodeId;
      render();
      if (stepMs) await sleep(stepMs * (edge.steps || 1));
      const after = S().load();
      const trig = W().arrivalFor(W().nodeById(M(after), nodeId), after);
      if (enc) {
        walking = false;
        pendingArrival = trig ? nodeId : null;
        playEncounter(enc);
        return;
      }
      if (trig) {
        walking = false;
        runTrigger(trig);
        return;
      }
    }
    walking = false;
    selected = S().load().world.node;
    render();
  }

  function runTrigger(trig) {
    if (trig.effects && trig.effects.length) {
      withSave((save) => { W().applyEffects(save, trig.effects, data.quests); });
    }
    if (trig.script) {
      playScript(data.copy.scripts[trig.script], { title: data.copy.scripts[trig.script].title });
      return;
    }
    if (trig.stage_id) {
      launchStage(trig.stage_id);
      return;
    }
    render();
  }

  function playEncounter(entry) {
    if (entry.type === "event") {
      const script = data.copy.events[entry.event];
      playScript(script, { title: script.title, meta: ui("encounter") });
      return;
    }
    if (entry.type === "battle" && entry.stage_id) launchStage(entry.stage_id);
  }

  function runAction(action) {
    const save = S().load();
    if (action.type === "talk") {
      const npc = data.copy.npcs[action.npc];
      const talk = W().pickTalk(npc, save);
      if (!talk) return;
      playScript(talk.script, { title: npc.name, talkId: talk.id });
      return;
    }
    if (action.type === "inspect") {
      const script = data.copy.inspects[action.inspect];
      playScript(script, { title: script.title });
      return;
    }
    if (action.type === "rest") {
      const script = data.copy.scripts[action.script];
      playScript(script, { title: script.title });
      return;
    }
    if (action.type === "stage") launchStage(action.stage_id);
  }

  function playScript(script, opts) {
    const o = opts || {};
    if (!script) return;
    active = true;
    hooks.showScreen("event");
    window.ShanheEvent.start({
      script,
      title: o.title || "",
      meta: o.meta || "",
      onFinished: (payload) => {
        const { out: battle } = withSave((save) => {
          if (o.talkId) save.flags["talked." + o.talkId] = true;
          return W().applyEffects(save, payload.effects, data.quests).battle;
        });
        if (battle) {
          launchStage(battle);
          return;
        }
        if (payload.auto_return) back();
      },
    }).catch((err) => hooks.showFatal && hooks.showFatal(err.message));
  }

  function launchStage(stageId) {
    const node = ((data.manifest && data.manifest.nodes) || []).find((n) => n.id === stageId);
    if (!node) return;
    active = true;
    hooks.enterStage(node, { onReturn: (result) => stageReturned(stageId, result) });
  }

  function stageReturned(stageId, result) {
    const save = S().load();
    const scripted = ((data.encounters && data.encounters.scripted) || []).find((s) => s.stage_id === stageId
      && s.node === save.world.node && (!s.quest_step || W().evalCond({ quest_step: s.quest_step }, save)));
    if (scripted && result) {
      const fx = (scripted.after_effects || {})[result] || (scripted.after_effects || {})["*"];
      if (fx) withSave((s) => { W().applyEffects(s, fx, data.quests); });
      const key = (scripted.after || {})[result];
      if (key && data.copy.scripts[key]) {
        playScript(data.copy.scripts[key], { title: data.copy.scripts[key].title });
        return;
      }
    }
    show();
  }

  function back() {
    show();
    if (pendingArrival) {
      const id = pendingArrival;
      pendingArrival = null;
      const save = S().load();
      if (save.world.node === id) {
        const trig = W().arrivalFor(W().nodeById(M(save), id), save);
        if (trig) {
          runTrigger(trig);
          return;
        }
      }
    }
    runAuto();
  }

  /** 補丁的自動段（例如合買帖「收齊」）：條件成立就播一次。 */
  function runAuto() {
    const b = big();
    if (!b || !b.patch) return false;
    const save = S().load();
    const auto = W().pickAuto(b.patch, save);
    if (!auto) return false;
    withSave((s) => { s.flags["auto." + auto.id] = true; });
    const script = data.copy.scripts[auto.script];
    if (!script) return false;
    playScript(script, { title: script.title });
    return true;
  }

  // ---- 大地圖 ----

  function regionCopy(id) { return (big().copy.regions || {})[id] || {}; }

  function currentRegion(save) {
    const g = big().graph;
    const r = (g.regions || []).find((x) => (x.area || x.id) === save.world.region);
    return r ? r.id : g.start_region;
  }

  function regionVisited(save, id) {
    return id === currentRegion(save) || Boolean(save.flags["visited." + id]);
  }

  function renderRegion(save, sheet) {
    const b = big();
    const g = b.graph;
    const title = $("world-title");
    if (title) title.textContent = b.copy.ui.bigmap;
    renderQuest(save);
    sheet.classList.add("is-region");
    sheet.classList.remove("is-night");
    const here = currentRegion(save);
    const pos = Object.fromEntries(g.regions.map((r) => [r.id, r]));
    const lines = g.routes.map((e) => {
      const a = pos[e.a];
      const c = pos[e.b];
      const cls = (pos[e.a].locked || pos[e.b].locked || e.locked) ? "is-closed" : (W().edgeOpen(e, save) ? "is-open" : "is-closed");
      return `<line class="world-edge ${cls}" x1="${a.x}" y1="${a.y}" x2="${c.x}" y2="${c.y}" vector-effect="non-scaling-stroke"/>`;
    }).join("");
    const svg = `<svg class="world-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${lines}</svg>`;
    if (!selected || !pos[selected]) selected = here;
    const nodes = g.regions.map((r) => {
      const rc = regionCopy(r.id);
      const cls = ["world-node"];
      if (r.id === here) cls.push("is-here");
      if (r.id === selected) cls.push("is-selected");
      if (r.locked) cls.push("is-locked");
      return `<button type="button" class="${cls.join(" ")}" data-id="${escapeHtml(r.id)}" style="left:${r.x}%;top:${r.y}%;"
        aria-pressed="${r.id === selected ? "true" : "false"}" aria-label="${escapeHtml(rc.label || r.id)}">
        <span class="world-dot" aria-hidden="true"></span>
        <span class="world-node-label">${escapeHtml(rc.label || "")}</span>
      </button>`;
    }).join("");
    sheet.innerHTML = svg + nodes;
    const token = document.createElement("span");
    token.className = "world-token no-motion";
    token.setAttribute("aria-hidden", "true");
    token.textContent = "禾";
    token.style.left = pos[here].x + "%";
    token.style.top = pos[here].y + "%";
    sheet.appendChild(token);
    sheet.querySelectorAll(".world-node").forEach((btn) => {
      btn.addEventListener("click", () => onTap(btn.getAttribute("data-id")));
    });
    renderRegionDrawer(save);
  }

  function renderRegionDrawer(save) {
    const b = big();
    const id = selected;
    const r = W().nodeById({ nodes: b.graph.regions }, id);
    const rc = regionCopy(id);
    const name = $("world-node-name");
    const blurb = $("world-node-blurb");
    const actions = $("world-actions");
    if (name) name.textContent = rc.label || "";
    let text = "";
    if (r && r.locked) text = b.copy.ui.locked_text;
    else if (regionVisited(save, id)) text = rc.note || "";
    else {
      const res = W().regionPath(b.graph, save, currentRegion(save), id);
      if (res.ok) text = res.half_days >= 2 ? b.copy.ui.one_day : b.copy.ui.half_day;
    }
    if (blurb) blurb.textContent = text;
    if (!actions) return;
    actions.innerHTML = "";
    if (!r) return;
    if (r.locked) {
      const tag = document.createElement("span");
      tag.className = "world-locked-tag";
      tag.textContent = b.copy.ui.locked;
      actions.appendChild(tag);
      return;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn seal world-act";
    if (id === currentRegion(save)) {
      btn.textContent = b.copy.ui.back_area;
      btn.onclick = () => leaveRegion();
    } else {
      btn.textContent = b.copy.ui.walk;
      btn.disabled = !W().regionPath(b.graph, save, currentRegion(save), id).ok;
    }
    actions.appendChild(btn);
  }

  function onRegionTap(id) {
    const save = S().load();
    const r = W().nodeById({ nodes: big().graph.regions }, id);
    if (id !== selected) {
      selected = id;
      render();
      toast(r && r.locked ? big().copy.ui.locked_text : "");
      return;
    }
    if (id === currentRegion(save)) leaveRegion();
  }

  function enterRegion() {
    if (!big()) return;
    mode = "region";
    selected = null;
    toast("");
    render();
  }

  function leaveRegion() {
    mode = "area";
    withSave((s) => { s.flags["bigmap.back"] = true; });
    selected = S().load().world.node;
    toast("");
    render();
  }

  function toggleRegion() {
    if (mode === "region") leaveRegion();
    else enterRegion();
  }

  function show() {
    active = true;
    hooks.showScreen("world");
    if (hooks.setHash) hooks.setHash("world");
    const save = withSave(() => null).save;
    if (!selected) selected = save.world.node;
    mode = mode === "region" && big() ? "region" : "area";
    render();
    if (!save.flags["seen.opening"] && W().evalCond({ quest_step: ["q-qh-night", "go_shed"] }, save)) {
      playScript(data.copy.scripts.opening, { title: data.copy.scripts.opening.title });
    }
  }

  function isActive() { return active; }
  function deactivate() { active = false; }

  function resetView() {
    selected = null;
    pendingArrival = null;
    walking = false;
  }

  function mount(options) {
    hooks = options.hooks || {};
    data = options.data;
    const title = $("world-title");
    if (title) title.textContent = data.copy.area_name || "";
    const qk = $("world-quest-k");
    if (qk) qk.textContent = ui("quest_bar");
    const validateScript = window.ShanheEvent && window.ShanheEvent.validateScript;
    let checkMap = data.map;
    const b = big();
    if (b) {
      const errs = W().validateRegionGraph(b.graph).concat(b.patch ? W().validateAreaPatch(data.map, b.patch) : []);
      if (errs.length) throw new Error("大地圖檔有誤：" + errs[0]);
      // 臘月補丁併入後一起檢查（用一份假存檔讓時節條件成立）。
      if (b.patch) checkMap = W().applyAreaPatch(data.map, b.patch, { world: { season: b.patch.season }, flags: {}, quests: {}, stages: {} });
      (b.patch && b.patch.autos || []).forEach((a) => {
        if (!data.copy.scripts[a.script]) throw new Error("大地圖檔有誤：找不到事件稿 " + a.script);
      });
      (b.patch && b.patch.quest_hints || []).forEach((h) => {
        if (!data.copy.ui[h.ui]) throw new Error("大地圖檔有誤：找不到提示字 " + h.ui);
      });
    }
    const errors = W().validateWorld({ ...data, map: checkMap, validateScript });
    if (errors.length) throw new Error("世界檔有誤：" + errors[0]);
  }

  function resetMode() { mode = "area"; }

  window.ShanheWorldMap = { mount, show, render, back, isActive, deactivate, resetView, walkTo, onTap,
    toggleRegion, enterRegion, leaveRegion, resetMode, mode: () => mode };
})();
