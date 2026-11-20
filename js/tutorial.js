(() => {
  function $(id) { return document.getElementById(id); }

  let copy = null;
  let node = null;
  let stepIndex = 0;
  let finished = false;
  let busy = false;
  let rigHost = null;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function beat(id) {
    return ((copy && copy.beats) || []).find((item) => item.id === id) || null;
  }

  function steps() {
    return (copy && copy.steps) || [];
  }

  function setEnding(visible) {
    const ending = $("tutorial-end");
    if (!ending) return;
    const endBeat = beat("end");
    if (visible && endBeat && endBeat.closing) {
      ending.hidden = false;
      ending.textContent = endBeat.closing;
      ending.className = "ending comedy";
    } else {
      ending.hidden = true;
      ending.textContent = "";
    }
  }

  function introBeats() {
    const ids = new Set(["open", "want", "prompt"]);
    return ((copy && copy.beats) || []).filter((item) => ids.has(item.id) && item.text);
  }

  function renderIntro() {
    const host = $("tutorial-beats");
    if (!host || !copy) return;
    host.innerHTML = introBeats().map((item) => (
      `<p class="tutorial-line" data-id="${escapeHtml(item.id)}">${escapeHtml(item.text)}</p>`
    )).join("");
    const credits = $("tutorial-credits");
    if (credits) credits.textContent = copy.credits || "";
    setEnding(false);
    updateAction();
  }

  function appendLine(item, extraClass) {
    const host = $("tutorial-beats");
    if (!host || !item || !item.text) return;
    const p = document.createElement("p");
    p.className = "tutorial-line" + (extraClass ? " " + extraClass : "");
    p.dataset.id = item.id || "";
    p.textContent = item.text;
    host.appendChild(p);
    p.scrollIntoView({ block: "nearest" });
  }

  function updateAction() {
    const action = $("tutorial-action");
    if (!action) return;
    const list = steps();
    if (finished || stepIndex >= list.length) {
      action.hidden = true;
      return;
    }
    const step = list[stepIndex];
    action.hidden = false;
    action.disabled = busy;
    action.textContent = step.label || "繼續";
  }

  function mountRig() {
    const mount = $("tutorial-rig");
    if (!mount || !window.ShanheRig) return;
    rigHost = mount;
    window.ShanheRig.mount(mount, { weapon: "pole" });
    window.ShanheRig.play(mount, "idle", { weapon: "pole" });
  }

  function playMove(moveId) {
    return new Promise((resolve) => {
      if (!window.ShanheRig || !rigHost || !moveId) {
        resolve();
        return;
      }
      const reduced = window.ShanheRig.isReduced && window.ShanheRig.isReduced();
      const duration = window.ShanheRig.play(rigHost, moveId, {
        weapon: "pole",
        onDone: () => resolve(),
      });
      if (reduced || !duration) {
        resolve();
        return;
      }
      window.setTimeout(resolve, duration + 80);
    });
  }

  function revealFail() {
    finished = true;
    const figure = $("tutorial-figure");
    if (figure) figure.classList.add("is-faceplant");
    appendLine(beat("fail"), "just-in");
    appendLine(beat("after"), "just-in");
    appendLine(beat("end"), "just-in");
    setEnding(true);
    updateAction();
    const endBeat = beat("end") || {};
    if (window.ShanheTutorial && window.ShanheTutorial.onFinished) {
      window.ShanheTutorial.onFinished({
        node,
        result: endBeat.result || "COMEDY_FAIL",
        terminal_label: endBeat.terminal_label || "摔進泥坑",
      });
    }
  }

  async function playStep() {
    if (finished || busy || !copy) return;
    const list = steps();
    const step = list[stepIndex];
    if (!step) return;
    busy = true;
    updateAction();
    const figure = $("tutorial-figure");
    if (figure) figure.classList.add("is-acting");
    await playMove(step.move);
    if (figure) figure.classList.remove("is-acting");
    if (step.outcome === "fail") {
      revealFail();
      busy = false;
      return;
    }
    stepIndex += 1;
    busy = false;
    updateAction();
  }

  async function start(options) {
    node = options && options.node;
    const src = (node && node.copy_src) || "stages/tutorial-kick.copy.json";
    const res = await fetch("assets/" + src.replace(/^assets\//, ""));
    if (!res.ok) throw new Error("教學文案載入失敗");
    copy = await res.json();
    finished = false;
    busy = false;
    stepIndex = 0;
    const title = $("tutorial-title");
    const meta = $("tutorial-meta");
    if (title) title.textContent = copy.title || (node && node.title) || "學那一腳";
    if (meta) meta.textContent = copy.location || "青禾渡・回家路上";
    const figure = $("tutorial-figure");
    if (figure) figure.classList.remove("is-faceplant", "is-acting");
    if (window.ShanheRig && !window.ShanheRig.getMove) {
      /* catalog already loaded at boot; mount anyway */
    }
    if (window.ShanheRig && !window.ShanheRig.getCatalog?.()?.meta) {
      await window.ShanheRig.loadCatalog("assets/moves/catalog.json").catch(() => null);
    }
    renderIntro();
    mountRig();
  }

  window.ShanheTutorial = { start, playStep, playChoice: playStep };
})();
