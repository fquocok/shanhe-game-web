(() => {
  const worker = new Worker("js/worker.js");
  const $ = (id) => document.getElementById(id);
  const boot = $("boot");
  const app = $("app");
  const fatal = $("fatal");
  const logEl = $("log");
  const ending = $("ending");
  const skillFlash = $("skill-flash");

  const TURN_NUM = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  const CHAPTER_NUM = { 15: "十五" };
  const BODY_PARTS = ["肋下", "肩頭", "腕側", "前胸", "脅下"];
  const ICON_BY_MOVE = {
    "一腳": "assets/icons/kick.png",
    "一撥": "assets/icons/parry.png",
    "一甩": "assets/icons/sweep.png",
  };
  const PORTRAIT_BY_ROLE = {
    escort: "assets/portraits/escort-battle.webp",
    "thief-0": "assets/portraits/thief-a-battle.webp",
    "thief-1": "assets/portraits/thief-b-battle.webp",
  };
  let artFiles = new Set();

  let state = null;
  let selectedTarget = null;
  let selectedAction = null;
  let autoTimer = null;
  let pending = Promise.resolve();
  let battleBegun = false;
  let endedLogged = false;
  const seenEventKeys = new Set();
  const revealTimers = new Set();
  const metrics = { loadMs: null, zipBytes: null };

  function later(fn, ms) {
    const id = window.setTimeout(() => { revealTimers.delete(id); fn(); }, ms);
    revealTimers.add(id);
  }
  function cancelReveals() {
    for (const id of revealTimers) window.clearTimeout(id);
    revealTimers.clear();
  }

  function showFatal(message) {
    boot.hidden = true;
    app.hidden = true;
    fatal.hidden = false;
    fatal.textContent = "載入失敗：" + message;
  }

  function send(message) {
    pending = pending.then(() => new Promise((resolve, reject) => {
      const onMessage = (event) => {
        const data = event.data || {};
        if (data.type === "progress") {
          $("boot-status").textContent = data.message;
          return;
        }
        worker.removeEventListener("message", onMessage);
        if (data.type === "error") {
          reject(new Error(data.message));
          return;
        }
        resolve(data);
      };
      worker.addEventListener("message", onMessage);
      worker.postMessage(message);
    }));
    return pending;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function hasArt(path) {
    const rel = String(path || "").replace(/^assets\//, "");
    return artFiles.has(rel) || artFiles.has("assets/" + rel);
  }

  function bindArt(img, onReady) {
    if (!img) return;
    const src = img.getAttribute("data-src") || img.getAttribute("src") || "";
    if (!src || !hasArt(src)) {
      img.removeAttribute("src");
      img.hidden = true;
      return;
    }
    img.src = src;
    const show = () => { img.hidden = false; onReady && onReady(); };
    const hide = () => { img.hidden = true; };
    img.addEventListener("load", show);
    img.addEventListener("error", hide);
    if (img.complete) {
      if (img.naturalWidth > 0) show();
      else hide();
    }
  }

  function shortName(name) {
    return String(name || "").replace(/^未具名/, "");
  }

  function nameOf(id) {
    if (!state || !id) return "";
    const all = [state.player, ...(state.allies || []), ...(state.enemies || [])];
    const found = all.find((unit) => unit.id === id);
    return found ? shortName(found.name) : "";
  }

  function unitEl(id) {
    if (!state) return null;
    if (state.player && state.player.id === id) return $("player-card");
    const enemies = state.enemies || [];
    if (enemies[0] && enemies[0].id === id) return $("enemy-a");
    if (enemies[1] && enemies[1].id === id) return $("enemy-b");
    return null;
  }

  function moveFromEvent(event) {
    const id = (event.details && event.details.attack_instance_id) || "";
    if (id.includes(".active")) return "一腳";
    if (id.includes(".pursuit")) return "一甩";
    if (id.includes(".retaliation")) return "一撥";
    if (id.includes("fist") || id.includes("action1")) return "撲上";
    const family = event.details?.action_presentation_metadata?.weapon_visual_family;
    if (family === "槍法" || family === "杆法") return "一腳";
    if (family === "拳法") return "撲上";
    if (state && event.actor_id === state.player?.id && selectedAction) {
      if (selectedAction.endsWith(".active")) return "一腳";
      if (selectedAction.endsWith(".pursuit")) return "一甩";
      if (selectedAction.endsWith(".retaliation")) return "一撥";
    }
    return "";
  }

  function actionLine(actor, move, target) {
    if (move === "一腳") return `${actor}一腳，踢向${target}。`;
    if (move === "一撥") return `${actor}一撥，把${target}放出船舷。`;
    if (move === "一甩") return `${actor}一甩，掃向${target}。`;
    if (move === "撲上") return `${actor}撲上前來，打向${target}。`;
    return `${actor}出手，攻向${target}。`;
  }

  function resultLine(move, target, { dodged, parried, defeated, part }) {
    if (dodged) {
      const label = move ? `這一${move.replace("撲上", "下")}` : "這一招";
      return `${label}落空，只帶起一團江霧。`;
    }
    if (parried) return `${target}偏身格開。`;
    if (defeated) return `${target}氣血耗盡，翻落江中。`;
    const blow = move ? `這一${move.replace("撲上", "下")}` : "這一招";
    return `${blow}結實，${target}${part}受創。`;
  }

  function eventKey(event) {
    const details = event.details || {};
    return [
      event.kind, event.actor_id,
      (event.target_ids || []).join(","),
      details.attack_instance_id || "",
      details.hp_damage, details.remaining_hp, details.outcome,
      details.terminal_state || "",
    ].join("|");
  }

  function kindOf(event) {
    let kind = String(event.kind || "");
    if (kind.includes(".")) kind = kind.split(".").pop();
    return kind;
  }

  function appendLog(text, className) {
    if (!text) return;
    const item = document.createElement("li");
    if (className) item.className = className;
    item.textContent = text;
    logEl.appendChild(item);
    item.scrollIntoView({ block: "end" });
  }

  function flashSkill(name) {
    if (!name || name === "撲上") {
      // 夜盜無正式招名：場上寫「撲上」仍可一閃
    }
    if (!name) return;
    skillFlash.hidden = false;
    skillFlash.textContent = name;
    skillFlash.style.animation = "none";
    void skillFlash.offsetWidth;
    skillFlash.style.animation = "";
    window.setTimeout(() => { skillFlash.hidden = true; }, 460);
  }

  function bumpUnit(id) {
    const node = unitEl(id);
    if (!node) return;
    node.classList.remove("shake", "hit-flash");
    void node.offsetWidth;
    node.classList.add("shake", "hit-flash");
    window.setTimeout(() => node.classList.remove("shake", "hit-flash"), 280);
  }

  function spawnFloater(targetId, text, className) {
    const node = unitEl(targetId);
    if (!node) return;
    const el = document.createElement("span");
    el.className = className;
    el.textContent = text;
    node.appendChild(el);
    window.setTimeout(() => el.remove(), 750);
  }

  function showDamage(event) {
    const details = event.details || {};
    const targetId = (event.target_ids || [])[0];
    if (!targetId) return;
    if (details.dodged) {
      spawnFloater(targetId, "空", "seal-mark");
      return;
    }
    if (details.parried) {
      spawnFloater(targetId, "格", "seal-mark");
      return;
    }
    const amount = Number(details.hp_damage || 0);
    if (!amount) return;
    const heavy = amount >= 60 || details.defeated;
    spawnFloater(targetId, String(amount), "floater" + (heavy ? " heavy" : ""));
  }

  const SKIP_KINDS = new Set([
    "ACTION_SELECTED", "ATTACK_RESOLVED", "ENEMY_INTENT",
    "CONTROL_READY", "FORMAL_TURN_STARTED", "FORMAL_TURN_COMPLETED",
    "ENCOUNTER_TERMINATED", "TARGET_SELECTED",
    "EFFECTIVE_ATTACK_DAMAGE_CONFIRMED", "ACTION_COMPLETED",
  ]);

  function consumeEvents(events, alreadyEnded) {
    if (!events || !events.length) return;
    const unique = [];
    for (const event of events) {
      const key = eventKey(event);
      if (seenEventKeys.has(key)) continue;
      seenEventKeys.add(key);
      unique.push(event);
    }

    let encounterOver = alreadyEnded || endedLogged;
    const pendingStarts = [];
    const pendingDownLog = new Set();
    if (window.ShanheMotion) window.ShanheMotion.beginStep();

    const flushStart = (event, fallbackMove) => {
      const actor = nameOf(event.actor_id);
      const targetId = (event.target_ids || [])[0];
      const target = nameOf(targetId);
      const move = fallbackMove || moveFromEvent(event) || "";
      if (!actor || !target) return 0;
      flashSkill(move);
      appendLog(actionLine(actor, move, target));
      battleBegun = true;
      const family = event.details?.action_presentation_metadata?.weapon_visual_family;
      if (!window.ShanheMotion) return 0;
      return window.ShanheMotion.playAttack(event.actor_id, targetId, move, family) || 0;
    };

    for (const event of unique) {
      const kind = kindOf(event);
      if (kind === "ENCOUNTER_TERMINATED") {
        encounterOver = true;
        endedLogged = true;
        continue;
      }
      if (encounterOver && (kind === "ACTION_START" || kind === "ACTION_STARTED" || kind === "ACTION_SELECTED")) {
        continue;
      }
      if (kind === "ACTION_START" && !(event.target_ids || []).length) {
        // 下一拍預告，不寫進戰報
        continue;
      }
      if (SKIP_KINDS.has(kind)) continue;

      if (kind === "ACTION_STARTED" || kind === "ACTION_START") {
        pendingStarts.push(event);
        continue;
      }

      if (kind === "DAMAGE_APPLIED" || kind === "HIT_CONFIRMED" || kind === "DODGE_CONFIRMED" || kind === "PARRY_CONFIRMED") {
        const details = event.details || {};
        const move = moveFromEvent(event);
        const start = pendingStarts.find((item) => item.actor_id === event.actor_id) || pendingStarts.shift();
        let contact = 0;
        if (start) {
          pendingStarts.splice(pendingStarts.indexOf(start), 1);
          contact = flushStart(start, move) || 0;
        } else if (move) {
          flashSkill(move);
        }
        const targetId = (event.target_ids || [])[0];
        const target = nameOf(targetId) || "對方";
        const part = BODY_PARTS[(Number(details.hp_damage) || 0) % BODY_PARTS.length];
        const dodged = Boolean(details.dodged) || kind === "DODGE_CONFIRMED";
        const parried = Boolean(details.parried) || kind === "PARRY_CONFIRMED";
        if (window.ShanheMotion) {
          const reactId = dodged ? "dodge" : parried ? "block" : "hit";
          const reactMove = window.ShanheRig?.getMove?.(reactId);
          window.ShanheMotion.note(contact + (reactMove?.duration_ms || 360));
        }
        if (details.defeated) pendingDownLog.add(target);
        const reveal = () => {
          showDamage(event);
          if (window.ShanheMotion) {
            window.ShanheMotion.playReact(targetId, kind, event.actor_id, details);
          }
          if (details.defeated) {
            const node = unitEl(targetId);
            if (node) {
              node.classList.add("down");
              const hp = node.querySelector(".hp-label");
              if (hp) hp.textContent = "已落水";
              const bar = node.querySelector(".bar > span");
              if (bar) bar.style.width = "0%";
            }
            if (window.ShanheMotion) window.ShanheMotion.playDown(targetId);
            appendLog(resultLine(move, target, { dodged, parried, defeated: true, part }), "down");
          } else {
            const node = unitEl(targetId);
            const unit = [...(state?.enemies || []), state?.player].find((item) => item && item.id === targetId);
            if (node && unit) {
              const hp = node.querySelector(".hp-label");
              if (hp) hp.textContent = unit.alive ? `${unit.hp}／${unit.max_hp}` : "已落水";
              const bar = node.querySelector(".bar > span");
              if (bar && unit.max_hp) bar.style.width = `${Math.max(0, Math.min(100, (unit.hp / unit.max_hp) * 100))}%`;
            }
            appendLog(resultLine(move, target, { dodged, parried, defeated: false, part }), dodged || parried ? "" : "hit");
          }
        };
        if (contact > 0) later(reveal, contact);
        else reveal();
        continue;
      }

      if (kind === "DEFEATED" || kind === "COMBATANT_DEFEATED") {
        const target = (event.target_ids || []).map(nameOf).filter(Boolean)[0];
        if (!target) continue;
        // 落水句已在延後的受創揭示裡寫過，或即將寫，這裡不再重複
        if (pendingDownLog.has(target)) continue;
        const already = Array.from(logEl.querySelectorAll("li")).some((li) => li.textContent.includes(`${target}氣血耗盡`));
        if (!already) appendLog(`${target}氣血耗盡，翻落江中。`, "down");
        continue;
      }
    }

    // 尚未配上傷害的出手（例如被中斷）仍寫動作句
    for (const start of pendingStarts) {
      flushStart(start, moveFromEvent(start));
    }

    $("flavor").classList.toggle("compact", battleBegun);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function chapterLine() {
    const chapter = state.chapter || 15;
    const turn = state.formal_turn || 1;
    const ch = CHAPTER_NUM[chapter] || String(chapter);
    const t = turn >= 1 && turn <= 10 ? TURN_NUM[turn] : String(turn);
    return `第${ch}章・其${t}`;
  }

  function roleOf(id) {
    if (!state || !id) return "";
    if (state.player && state.player.id === id) return "escort";
    const enemies = state.enemies || [];
    if (enemies[0] && enemies[0].id === id) return "thief-0";
    if (enemies[1] && enemies[1].id === id) return "thief-1";
    return "";
  }

  function unitHtml(unit, role, deferVitals) {
    const showHp = !deferVitals;
    const ratio = showHp && unit.max_hp ? Math.max(0, Math.min(100, (unit.hp / unit.max_hp) * 100)) : 100;
    const src = PORTRAIT_BY_ROLE[role] || "";
    const ink = role === "escort"
      ? '<span class="placeholder placeholder-escort" aria-hidden="true"><i class="pole"></i></span>'
      : '<span class="placeholder placeholder-thief" aria-hidden="true"></span>';
    const hpText = !showHp ? "" : (unit.alive ? `${unit.hp}／${unit.max_hp}` : "已落水");
    return `<div class="mover">
        <div class="portrait">
          <img class="art" data-src="${src}" alt="" hidden>
          ${ink}
          <div class="rig-mount" aria-hidden="true"></div>
        </div>
      </div>
      <div class="unit-meta">
        <h2>${escapeHtml(unit.name)}</h2>
        <p class="hp-label">${hpText}</p>
        <div class="bar"><span style="width:${ratio}%"></span></div>
      </div>
      <span class="tap-hint" hidden>再點一次出手</span>`;
  }

  const wasAlive = new Map();

  function setUnitChrome(node, base) {
    const keep = [...node.classList].filter((name) => name.startsWith("mot-"));
    node.className = base;
    keep.forEach((name) => node.classList.add(name));
  }

  function bindUnitTap(node, unit) {
    node.onclick = () => {
      if (!state || unit.id === state.player?.id) return;
      if (!unit.alive || state.terminal_result || autoTimer) return;
      if (selectedTarget === unit.id && selectedAction) {
        send({ type: "submit" }).then(applyState).catch(showFatal);
        return;
      }
      selectedTarget = unit.id;
      send({ type: "select_target", targetId: unit.id }).then(applyState).catch(showFatal);
    };
  }

  function syncUnit(node, unit, role) {
    const justFell = Boolean(wasAlive.get(unit.id) && !unit.alive);
    const built = node.dataset.builtId === unit.id && node.querySelector(".mover");
    if (!built) {
      node.dataset.builtId = unit.id;
      node.innerHTML = unitHtml(unit, role, justFell);
      hookPortrait(node);
      if (window.ShanheMotion) window.ShanheMotion.mountUnit(node, role);
    } else if (!justFell) {
      const name = node.querySelector("h2");
      if (name) name.textContent = unit.name;
      const hp = node.querySelector(".hp-label");
      if (hp) hp.textContent = unit.alive ? `${unit.hp}／${unit.max_hp}` : "已落水";
      const bar = node.querySelector(".bar > span");
      if (bar) {
        const ratio = unit.max_hp ? Math.max(0, Math.min(100, (unit.hp / unit.max_hp) * 100)) : 0;
        bar.style.width = unit.alive ? `${ratio}%` : "0%";
      }
    }
    bindUnitTap(node, unit);
    if (!justFell) node.classList.toggle("down", !unit.alive);
    node.classList.toggle("selected", selectedTarget === unit.id);
    const hint = node.querySelector(".tap-hint");
    if (hint) {
      const ready = selectedTarget === unit.id && selectedAction && unit.alive && !state.terminal_result && !autoTimer;
      hint.hidden = !ready;
    }
    if (!unit.alive && !justFell && window.ShanheMotion) window.ShanheMotion.playDown(unit.id);
    wasAlive.set(unit.id, unit.alive);
  }

  function hookPortrait(node) {
    const img = node.querySelector("img.art");
    const ph = node.querySelector(".placeholder");
    bindArt(img, () => { if (ph) ph.hidden = true; });
  }

  function hookSceneArt() {
    document.querySelectorAll(".scene-art").forEach((img) => bindArt(img));
    const aheImg = document.querySelector("#ahe-watch img.art");
    bindArt(aheImg);
  }

  function render() {
    if (!state) return;
    $("title").textContent = state.title || "青禾渡・鏢船夜盜";
    $("meta").textContent = chapterLine();
    $("flavor").textContent = state.flavor || "";
    $("credits").textContent = state.credits || "";

    setUnitChrome($("player-card"), "unit unit-escort");
    syncUnit($("player-card"), state.player, "escort");

    const enemies = state.enemies || [];
    ["enemy-a", "enemy-b"].forEach((id, index) => {
      const node = $(id);
      const unit = enemies[index];
      if (!unit) {
        node.hidden = true;
        return;
      }
      node.hidden = false;
      const variant = index === 0 ? " unit-thief-a" : " unit-thief-b";
      setUnitChrome(node, "unit unit-thief" + variant);
      syncUnit(node, unit, "thief-" + index);
    });

    const actions = $("actions");
    actions.innerHTML = "";
    (state.actions || []).forEach((action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chip" + (selectedAction === action.action_id ? " active" : "");
      const move = action.display_name;
      const icon = ICON_BY_MOVE[move];
      button.innerHTML = (icon ? `<img class="chip-icon" data-src="${icon}" alt="" hidden>` : "") + escapeHtml(move);
      if (icon) bindArt(button.querySelector(".chip-icon"));
      button.disabled = !action.enabled || Boolean(state.terminal_result) || Boolean(autoTimer);
      button.title = action.set_name || action.engine_name || "";
      button.onclick = () => {
        selectedAction = action.action_id;
        send({ type: "select_action", actionId: action.action_id }).then(applyState).catch(showFatal);
      };
      actions.appendChild(button);
    });

    const ended = Boolean(state.terminal_result);
    $("btn-submit").disabled = ended || Boolean(autoTimer) || !selectedAction || !selectedTarget;
    $("btn-auto").disabled = ended;
    $("btn-auto").classList.toggle("running", Boolean(autoTimer));
    $("btn-auto").textContent = autoTimer ? "停住" : "自動演示";

    if (ended) {
      skillFlash.hidden = true;
      ending.hidden = false;
      ending.className = "ending" + (state.terminal_result === "DEFEAT" ? " loss" : "");
      ending.textContent = state.terminal_label || (state.terminal_result === "VICTORY" ? "鏢船守住了" : "鏢船失守");
    } else {
      ending.hidden = true;
    }
  }

  function applyState(payload) {
    if (payload.type === "ready") {
      metrics.loadMs = payload.loadMs;
      metrics.zipBytes = payload.zipBytes;
      window.__SHANHE_METRICS__ = metrics;
      return payload;
    }
    if (payload.state) {
      const wasEnded = Boolean(state && state.terminal_result);
      state = payload.state;
      if (payload.action === "start" || payload.action === "reset") {
        logEl.innerHTML = "";
        selectedAction = null;
        selectedTarget = null;
        battleBegun = false;
        endedLogged = false;
        seenEventKeys.clear();
        wasAlive.clear();
        cancelReveals();
        if (window.ShanheMotion) window.ShanheMotion.reset();
        ["player-card", "enemy-a", "enemy-b"].forEach((id) => {
          const node = $(id);
          if (!node) return;
          delete node.dataset.builtId;
          node.classList.remove("mot-idle", "mot-attack", "mot-hit", "mot-dodge", "mot-block", "selected", "down");
        });
        $("flavor").classList.remove("compact");
        stopAuto();
      }
      render();
      consumeEvents(state.events || [], wasEnded);
    }
    return payload;
  }

  function stopAuto() {
    if (autoTimer) {
      clearTimeout(autoTimer);
      autoTimer = null;
    }
  }

  function stepAutoLoop() {
    if (!autoTimer) return;
    send({ type: "step_auto" }).then((payload) => {
      applyState(payload);
      if (payload.state && payload.state.terminal_result) {
        stopAuto();
        render();
        return;
      }
      const wait = Math.max(760, (window.ShanheMotion?.lastDuration() || 0) + 140);
      autoTimer = setTimeout(stepAutoLoop, wait);
    }).catch((error) => {
      stopAuto();
      showFatal(error.message);
    });
  }

  $("btn-submit").onclick = () => {
    send({ type: "submit" }).then(applyState).catch(showFatal);
  };
  $("btn-auto").onclick = () => {
    if (autoTimer) {
      stopAuto();
      render();
      return;
    }
    autoTimer = setTimeout(() => {}, 0);
    send({ type: "request_auto", enabled: true }).then((payload) => {
      applyState(payload);
      autoTimer = setTimeout(stepAutoLoop, 200);
    }).catch(showFatal);
  };
  $("btn-reset").onclick = () => {
    stopAuto();
    send({ type: "reset" }).then(applyState).catch(showFatal);
  };

  if (window.ShanheRig && window.matchMedia) {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const applyReduced = () => window.ShanheRig.setReduced(media.matches);
    applyReduced();
    if (media.addEventListener) media.addEventListener("change", applyReduced);
  }
  if (window.ShanheMotion) window.ShanheMotion.configure({ unitEl, roleOf });

  const rigBtn = $("btn-rig");
  if (rigBtn) {
    rigBtn.onclick = () => {
      const on = app.classList.toggle("show-rig");
      rigBtn.classList.toggle("active", on);
      rigBtn.setAttribute("aria-pressed", on ? "true" : "false");
    };
  }

  boot.hidden = false;
  const bootStarted = performance.now();
  const artReady = fetch("assets/manifest.json")
    .then((res) => res.ok ? res.json() : { files: [] })
    .then((data) => { artFiles = new Set(data.files || []); })
    .catch(() => { artFiles = new Set(); });
  const movesReady = window.ShanheRig
    ? window.ShanheRig.loadCatalog("assets/moves/catalog.json").catch(() => null)
    : Promise.resolve(null);
  Promise.all([artReady, movesReady]).then(() => { hookSceneArt(); return send({ type: "init" }); })
    .then((ready) => {
      applyState(ready);
      return send({ type: "start" });
    })
    .then((payload) => {
      metrics.readyToStartMs = Math.round(performance.now() - bootStarted);
      window.__SHANHE_METRICS__ = metrics;
      boot.hidden = true;
      app.hidden = false;
      applyState(payload);
    })
    .catch((error) => showFatal(error.message));
})();
