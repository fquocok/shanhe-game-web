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
    return W().findPath(data.map, save, here, id);
  }

  function edgeClass(edge, save) {
    if (edge.locked) return "is-locked";
    return W().edgeOpen(edge, save) ? "is-open" : "is-closed";
  }

  function renderQuest(save) {
    const host = $("world-quest-text");
    if (!host) return;
    const cur = W().currentQuest(save, data.quests);
    if (cur.quest && cur.step) {
      const qc = data.copy.quests[cur.quest.id] || { steps: {} };
      host.innerHTML = `<strong>${escapeHtml(qc.title)}</strong><span>${escapeHtml(qc.steps[cur.step.id] || "")}</span>`;
    } else if (cur.done) {
      host.innerHTML = `<span>${escapeHtml(ui("slice_done"))}</span>`;
    } else {
      host.innerHTML = "";
    }
    return cur;
  }

  function actionLabel(action) {
    if (action.type === "talk") return ui("talk");
    if (action.type === "inspect") return ui("inspect");
    if (action.type === "rest") return ui("rest");
    if (action.type === "stage") return ui("enter");
    return ui("walk");
  }

  function renderDrawer(save) {
    const id = selected || save.world.node;
    const node = W().nodeById(data.map, id);
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
    const cur = renderQuest(save);
    const target = cur && cur.step ? cur.step.target_node : null;
    const pos = Object.fromEntries(data.map.nodes.map((n) => [n.id, n]));
    const lines = data.map.edges.map((e) => {
      const a = pos[e.a];
      const b = pos[e.b];
      return `<line class="world-edge ${edgeClass(e, save)}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" vector-effect="non-scaling-stroke"/>`;
    }).join("");
    const river = `<path class="world-river" d="M -4 90 C 16 82, 30 96, 50 89 C 70 82, 82 94, 104 86" vector-effect="non-scaling-stroke"/>`;
    const svg = `<svg class="world-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${river}${lines}</svg>`;
    const here = save.world.node;
    const nodes = data.map.nodes.map((n) => {
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
    const herePos = pos[here] || pos[data.map.start_node];
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
    const save = S().load();
    if (id !== selected) {
      selected = id;
      render();
      const node = W().nodeById(data.map, id);
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
      const trig = W().arrivalFor(W().nodeById(data.map, nodeId), after);
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
        const trig = W().arrivalFor(W().nodeById(data.map, id), save);
        if (trig) runTrigger(trig);
      }
    }
  }

  function show() {
    active = true;
    hooks.showScreen("world");
    if (hooks.setHash) hooks.setHash("world");
    const save = withSave(() => null).save;
    if (!selected) selected = save.world.node;
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
    const errors = W().validateWorld({ ...data, validateScript: window.ShanheEvent && window.ShanheEvent.validateScript });
    if (errors.length) throw new Error("世界檔有誤：" + errors[0]);
  }

  window.ShanheWorldMap = { mount, show, render, back, isActive, deactivate, resetView, walkTo, onTap };
})();
