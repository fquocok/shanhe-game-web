(() => {
  const worker = new Worker("js/worker.js");
  const $ = (id) => document.getElementById(id);
  const boot = $("boot");
  const app = $("app");
  const fatal = $("fatal");
  const logEl = $("log");
  const ending = $("ending");

  let state = null;
  let selectedTarget = null;
  let selectedAction = null;
  let autoTimer = null;
  let pending = Promise.resolve();
  const metrics = { loadMs: null, zipBytes: null };

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

  function unitHtml(unit, kind) {
    const ratio = unit.max_hp ? Math.max(0, Math.min(100, (unit.hp / unit.max_hp) * 100)) : 0;
    const down = unit.alive ? "" : " down";
    const selected = selectedTarget === unit.id ? " selected" : "";
    const pole = kind === "escort" ? '<i class="pole" aria-hidden="true"></i>' : "";
    return `<div class="silhouette" aria-hidden="true"></div>${pole}
      <h2>${escapeHtml(unit.name)}</h2>
      <p class="hp-label">${unit.alive ? `${unit.hp}／${unit.max_hp}` : "已落水"}</p>
      <div class="bar"><span style="width:${ratio}%"></span></div>`;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function appendEvents(events) {
    if (!events || !events.length) return;
    for (const event of events) {
      const item = document.createElement("li");
      const kind = event.kind || "";
      if (kind === "DAMAGE_APPLIED" || kind === "HIT_CONFIRMED") item.className = "hit";
      if (kind === "DEFEATED") item.className = "down";
      const who = nameOf(event.actor_id);
      const targets = (event.target_ids || []).map(nameOf).filter(Boolean).join("、");
      let text = event.label || kind;
      if (who && targets) text = `${who}　${text}　${targets}`;
      else if (who) text = `${who}　${text}`;
      item.textContent = text;
      logEl.appendChild(item);
    }
    logEl.scrollTop = logEl.scrollHeight;
  }

  function nameOf(id) {
    if (!state || !id) return "";
    const all = [state.player, ...(state.allies || []), ...(state.enemies || [])];
    const found = all.find((unit) => unit.id === id);
    return found ? found.name : "";
  }

  function render() {
    if (!state) return;
    $("title").textContent = state.title || "青禾渡・鏢船夜盜";
    $("meta").textContent = `第 ${state.chapter || 15} 章　${state.location || "青禾渡"}　第 ${state.formal_turn || 1} 個回合`;
    $("flavor").textContent = state.flavor || "";
    $("credits").textContent = state.credits || "";

    $("player-card").className = "unit unit-escort" + (state.player.alive ? "" : " down");
    $("player-card").innerHTML = unitHtml(state.player, "escort");

    const enemies = state.enemies || [];
    ["enemy-a", "enemy-b"].forEach((id, index) => {
      const node = $(id);
      const unit = enemies[index];
      if (!unit) {
        node.hidden = true;
        return;
      }
      node.hidden = false;
      node.className = "unit unit-thief" + (unit.alive ? "" : " down") + (selectedTarget === unit.id ? " selected" : "");
      node.innerHTML = unitHtml(unit, "thief");
      node.onclick = () => {
        if (!unit.alive || state.terminal_result || autoTimer) return;
        selectedTarget = unit.id;
        send({ type: "select_target", targetId: unit.id }).then(applyState).catch(showFatal);
      };
    });

    const actions = $("actions");
    actions.innerHTML = "";
    (state.actions || []).forEach((action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chip" + (selectedAction === action.action_id ? " active" : "");
      button.textContent = action.display_name;
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
    $("btn-auto").textContent = autoTimer ? "演示中…" : "自動演示";

    if (ended) {
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
      state = payload.state;
      if (payload.action === "start" || payload.action === "reset") {
        logEl.innerHTML = "";
        selectedAction = null;
        selectedTarget = null;
        stopAuto();
      }
      appendEvents(state.events || []);
      render();
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
      autoTimer = setTimeout(stepAutoLoop, 850);
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

  boot.hidden = false;
  const bootStarted = performance.now();
  send({ type: "init" })
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
