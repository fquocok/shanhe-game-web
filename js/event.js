(() => {
  const BANNED = ["\u4e0a\u8f29\u5b50", "\u8d85\u5546", "\u6c89\u6c23", "\u6c89\u606f", "\u771f\u7d93", "\u6253\u9b3c", "\u7b2c241", "\u5927\u7db1"];

  function $(id) { return document.getElementById(id); }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function walkScenes(script) {
    const scenes = (script && script.scenes) || {};
    const start = script && script.start;
    if (!start || !scenes[start]) throw new Error("事件稿缺少起點");
    const seen = new Set();
    const queue = [start];
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      const scene = scenes[id];
      if (!scene) throw new Error("事件稿指向不存在的段落：" + id);
      if (scene.next) queue.push(scene.next);
      if (scene.success) queue.push(scene.success);
      if (scene.fail) queue.push(scene.fail);
      (scene.choices || []).forEach((choice) => {
        if (choice.next) queue.push(choice.next);
      });
    }
    return seen;
  }

  function collectText(script) {
    const chunks = [script.title, script.location, script.credits];
    Object.values(script.scenes || {}).forEach((scene) => {
      chunks.push(scene.prompt, scene.advance, scene.closing, scene.terminal_label, scene.result);
      (scene.lines || []).forEach((line) => chunks.push(line.speaker, line.text));
      (scene.choices || []).forEach((choice) => chunks.push(choice.label));
      (scene.cues || []).forEach((cue) => chunks.push(cue.text, cue.ok_label));
    });
    return chunks.filter(Boolean).join("\n");
  }

  function validateScript(script) {
    if (!script || script.schema !== "SHANHE_EVENT_SCRIPT_V0_1") {
      throw new Error("事件稿格式不對");
    }
    const scenes = script.scenes || {};
    const seen = walkScenes(script);
    Object.entries(scenes).forEach(([id, scene]) => {
      const type = scene.type;
      if (!["dialogue", "choice", "timed_choice", "standoff", "ending", "end"].includes(type)) {
        throw new Error("不支援的事件類型：" + type);
      }
      if (type === "ending") {
        if (!scene.result || !scene.terminal_label || !scene.closing) {
          throw new Error("收束段缺少完結欄：" + id);
        }
      }
    });
    const allowed = [
      "真經潮意不用，也不做加持。",
      "正文「上輩子」一句不用。",
    ];
    let blob = collectText(script);
    allowed.forEach((phrase) => { blob = blob.split(phrase).join(""); });
    BANNED.forEach((word) => {
      if (blob.includes(word)) throw new Error("事件稿含禁詞：" + word);
    });
    return { ok: true, reachable: Array.from(seen) };
  }

  function prefersReducedMotion() {
    return Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  let copy = null;
  let node = null;
  let sceneId = null;
  let finished = false;
  let busy = false;
  let cueTimer = null;
  let barTimer = null;
  let cueDeadline = null;
  let hold = null;
  let hooks = {};

  function clearBarTimer() {
    if (barTimer) {
      window.clearTimeout(barTimer);
      barTimer = null;
    }
  }

  function clearCueTimer() {
    if (cueTimer) {
      window.clearTimeout(cueTimer);
      cueTimer = null;
    }
    cueDeadline = null;
  }

  function clearTimers() {
    clearCueTimer();
    clearBarTimer();
  }

  function scene() {
    return copy && copy.scenes ? copy.scenes[sceneId] : null;
  }

  function setMeter(value, visible) {
    const wrap = $("event-meter");
    const bar = $("event-meter-bar");
    if (!wrap || !bar) return;
    if (!visible) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    const n = Math.max(0, Math.min(3, Number(value) || 0));
    wrap.dataset.level = String(n);
    bar.style.setProperty("--level", String(n));
    bar.setAttribute("aria-label", "對峙氣勢 " + n);
  }

  function setTimer(visible, ratio) {
    const wrap = $("event-timer");
    const bar = $("event-timer-bar");
    if (!wrap || !bar) return;
    wrap.hidden = !visible;
    if (visible) bar.style.transform = "scaleX(" + Math.max(0, Math.min(1, ratio)) + ")";
  }

  function setEnding(item) {
    const ending = $("event-end");
    if (!ending) return;
    if (item && item.closing) {
      ending.hidden = false;
      ending.textContent = item.closing;
      ending.className = "ending" + (item.result === "COMEDY_FAIL" ? " comedy" : "");
    } else {
      ending.hidden = true;
      ending.textContent = "";
    }
  }

  function scrollBeats() {
    const host = $("event-beats");
    if (!host) return;
    const go = () => { host.scrollTop = host.scrollHeight; };
    go();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(go);
  }

  function appendLines(lines, clear) {
    const host = $("event-beats");
    if (!host) return;
    if (clear) host.innerHTML = "";
    (lines || []).forEach((line) => {
      if (!line || !line.text) return;
      const p = document.createElement("p");
      p.className = "tutorial-line just-in";
      if (line.speaker) {
        p.innerHTML = `<span class="event-speaker">${escapeHtml(line.speaker)}</span>${escapeHtml(line.text)}`;
      } else {
        p.textContent = line.text;
      }
      host.appendChild(p);
    });
    scrollBeats();
  }

  function setPrompt(text, visible) {
    const el = $("event-prompt");
    if (!el) return;
    if (visible && text) {
      el.hidden = false;
      el.textContent = text;
    } else {
      el.hidden = true;
      el.textContent = "";
    }
  }

  function clearChoices() {
    const host = $("event-choices");
    if (host) host.innerHTML = "";
  }

  function renderChoices(choices) {
    const host = $("event-choices");
    if (!host) return;
    host.innerHTML = "";
    (choices || []).forEach((choice) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn seal event-choice";
      btn.textContent = choice.label;
      btn.dataset.id = choice.id;
      btn.disabled = busy;
      btn.onclick = () => choose(choice.id);
      host.appendChild(btn);
    });
  }

  function setAdvance(label, visible) {
    const action = $("event-action");
    if (!action) return;
    if (!visible) {
      action.hidden = true;
      return;
    }
    action.hidden = false;
    action.disabled = busy;
    action.textContent = label || "繼續";
  }

  function finish(item) {
    finished = true;
    busy = false;
    clearTimers();
    setTimer(false, 0);
    setAdvance("", false);
    clearChoices();
    setPrompt("", false);
    setEnding(item);
    if (typeof hooks.onFinished === "function") {
      hooks.onFinished({
        result: item.result || null,
        terminal_label: item.terminal_label || null,
        effects: item.effects || [],
        auto_return: Boolean(item.auto_return),
        scene_id: sceneId,
      });
    }
  }

  function goto(id) {
    clearTimers();
    hold = null;
    sceneId = id;
    const item = scene();
    if (!item) throw new Error("找不到段落：" + id);
    const type = item.type;
    if (type === "dialogue") {
      appendLines(item.lines, false);
      setPrompt("", false);
      setTimer(false, 0);
      setMeter(item.tension, item.tension > 0);
      clearChoices();
      setAdvance(item.advance || "繼續", true);
      scrollBeats();
      return;
    }
    if (type === "choice" || type === "standoff") {
      if (item.lines) appendLines(item.lines, false);
      setPrompt(item.prompt, Boolean(item.prompt));
      setTimer(false, 0);
      setMeter(item.tension, type === "standoff" || item.tension > 0);
      setAdvance("", false);
      renderChoices(item.choices);
      scrollBeats();
      return;
    }
    if (type === "timed_choice") {
      if (item.lines) appendLines(item.lines, false);
      setPrompt(item.prompt, Boolean(item.prompt));
      setMeter(false, false);
      clearChoices();
      setAdvance("", false);
      startHold(item);
      scrollBeats();
      return;
    }
    if (type === "ending" || type === "end") {
      // end：第 3 期世界層收束段，不寫關卡結果，只回傳 effects 給地圖。
      appendLines(item.lines, false);
      setPrompt("", false);
      setTimer(false, 0);
      finish(item);
    }
  }

  function startHold(item) {
    const reduced = prefersReducedMotion();
    const cues = item.cues || [];
    hold = {
      hits: 0,
      misses: 0,
      index: 0,
      cues,
      item,
      started: performance.now(),
    };
    setTimer(true, 1);
    if (reduced) {
      // 減少動效時不搶按，直接視為站穩。
      hold.hits = item.hits_needed || cues.length;
      barTimer = window.setTimeout(() => resolveHold(), 400);
      return;
    }
    scheduleNextCue();
    tickTimer();
  }

  function tickTimer() {
    if (!hold || finished) return;
    const item = hold.item;
    const elapsed = performance.now() - hold.started;
    const remain = 1 - elapsed / (item.duration_ms || 8000);
    setTimer(true, remain);
    if (elapsed >= (item.duration_ms || 8000) && hold.index >= hold.cues.length && !cueDeadline) {
      resolveHold();
      return;
    }
    barTimer = window.setTimeout(tickTimer, 80);
  }

  function scheduleNextCue() {
    if (!hold) return;
    const cue = hold.cues[hold.index];
    if (!cue) {
      const remain = (hold.item.duration_ms || 8000) - (performance.now() - hold.started);
      if (remain <= 0) resolveHold();
      return;
    }
    const wait = Math.max(0, cue.at_ms - (performance.now() - hold.started));
    cueTimer = window.setTimeout(showCue, wait);
  }

  function showCue() {
    if (!hold) return;
    const cue = hold.cues[hold.index];
    if (!cue) return;
    setPrompt(cue.text, true);
    setAdvance(cue.ok_label || "放下肩", true);
    cueDeadline = performance.now() + (cue.wait_ms || 1600);
    cueTimer = window.setTimeout(() => missCue(), cue.wait_ms || 1600);
  }

  function missCue() {
    if (!hold || !cueDeadline) return;
    hold.misses += 1;
    cueDeadline = null;
    setAdvance("", false);
    hold.index += 1;
    if (hold.misses > (hold.item.misses_allowed || 0)) {
      resolveHold();
      return;
    }
    scheduleNextCue();
  }

  function hitCue() {
    if (!hold || !cueDeadline) return;
    if (performance.now() > cueDeadline) {
      missCue();
      return;
    }
    hold.hits += 1;
    cueDeadline = null;
    clearCueTimer();
    setAdvance("", false);
    hold.index += 1;
    scheduleNextCue();
  }

  function resolveHold() {
    if (!hold) return;
    const item = hold.item;
    const ok = hold.hits >= (item.hits_needed || 1) && hold.misses <= (item.misses_allowed || 0);
    const hits = hold.hits;
    const misses = hold.misses;
    clearTimers();
    hold = null;
    cueDeadline = null;
    setTimer(false, 0);
    setAdvance("", false);
    if (ok) goto(item.success);
    else goto(item.fail);
    return { ok, hits, misses };
  }

  function advance() {
    if (finished || busy) return;
    if (hold && cueDeadline) {
      hitCue();
      return;
    }
    const item = scene();
    if (!item || !item.next) return;
    goto(item.next);
  }

  function resolveEscalate(choice) {
    const esc = choice && choice.escalate;
    if (!esc) return choice.next;
    const hasBattle = Boolean(node && node.encounter_id);
    if (esc.mode === "optional_battle" && hasBattle && typeof hooks.onBattle === "function") {
      hooks.onBattle(node);
      return null;
    }
    return choice.next;
  }

  function choose(choiceId) {
    if (finished || busy) return;
    const item = scene();
    if (!item || !item.choices) return;
    const choice = item.choices.find((c) => c.id === choiceId);
    if (!choice) return;
    const next = resolveEscalate(choice);
    if (next) goto(next);
  }

  function start(options) {
    hooks = options || {};
    node = hooks.node;
    finished = false;
    busy = false;
    clearTimers();
    hold = null;
    const src = (node && node.copy_src) ? ("assets/" + node.copy_src) : hooks.copyUrl;
    let loading;
    if (hooks.script) {
      // 第 3 期：地圖直接交一份事件稿物件（NPC 對話、看一眼、路上小事）。
      loading = Promise.resolve(hooks.script);
    } else {
      if (!src) return Promise.reject(new Error("此關沒有文案"));
      loading = fetch(src).then((res) => {
        if (!res.ok) throw new Error("事件文案載入失敗");
        return res.json();
      });
    }
    return loading.then((data) => {
      validateScript(data);
      copy = data;
      const title = $("event-title");
      const meta = $("event-meta");
      const credits = $("event-credits");
      if (title) title.textContent = hooks.title != null ? hooks.title : (copy.title || (node && node.title) || "");
      if (meta) meta.textContent = hooks.meta != null ? hooks.meta : (copy.location || "");
      if (credits) credits.textContent = copy.credits || "";
      const host = $("event-beats");
      if (host) host.innerHTML = "";
      setEnding(null);
      setPrompt("", false);
      setTimer(false, 0);
      setMeter(0, false);
      clearChoices();
      goto(copy.start);
    });
  }

  const api = {
    start,
    advance,
    choose,
    validateScript,
    collectText,
    walkScenes,
    BANNED,
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.ShanheEvent = api;
})();
