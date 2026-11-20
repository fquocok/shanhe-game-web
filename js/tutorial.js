(() => {
  function $(id) { return document.getElementById(id); }

  let copy = null;
  let node = null;
  let reachedChoice = false;
  let finished = false;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function beatsBefore(choiceInclusive) {
    const list = (copy && copy.beats) || [];
    const out = [];
    for (const beat of list) {
      out.push(beat);
      if (beat.choices && beat.choices.length) {
        if (!choiceInclusive) out.pop();
        break;
      }
    }
    return out;
  }

  function beatsAfterChoice() {
    const list = (copy && copy.beats) || [];
    let seen = false;
    const out = [];
    for (const beat of list) {
      if (beat.choices && beat.choices.length) { seen = true; continue; }
      if (seen) out.push(beat);
    }
    return out;
  }

  function render() {
    const host = $("tutorial-beats");
    if (!host || !copy) return;
    const visible = finished ? (copy.beats || []) : beatsBefore(true);
    host.innerHTML = visible.map((beat) => {
      if (!beat.text) return "";
      return `<p class="tutorial-line" data-id="${escapeHtml(beat.id)}">${escapeHtml(beat.text)}</p>`;
    }).join("");

    const action = $("tutorial-action");
    const ending = $("tutorial-end");
    const credits = $("tutorial-credits");
    if (credits) credits.textContent = copy.credits || "";

    const choiceBeat = (copy.beats || []).find((b) => b.choices && b.choices.length);
    const choice = choiceBeat && choiceBeat.choices[0];
    if (action) {
      if (!finished && choice) {
        action.hidden = false;
        action.disabled = false;
        action.textContent = choice.label || "繼續";
      } else {
        action.hidden = true;
      }
    }
    if (ending) {
      const endBeat = (copy.beats || []).find((b) => b.closing);
      if (finished && endBeat) {
        ending.hidden = false;
        ending.textContent = endBeat.closing;
      ending.className = "ending comedy";
      } else {
        ending.hidden = true;
      }
    }
  }

  function playChoice() {
    if (finished || !copy) return;
    finished = true;
    const host = $("tutorial-beats");
    if (host) {
      beatsAfterChoice().forEach((beat) => {
        const p = document.createElement("p");
        p.className = "tutorial-line just-in";
        p.textContent = beat.text || "";
        host.appendChild(p);
      });
    }
    const action = $("tutorial-action");
    if (action) action.hidden = true;
    const endBeat = (copy.beats || []).find((b) => b.result);
    const ending = $("tutorial-end");
    if (ending && endBeat && endBeat.closing) {
      ending.hidden = false;
      ending.textContent = endBeat.closing;
      ending.className = "ending comedy";
    }
    if (window.ShanheTutorial && window.ShanheTutorial.onFinished) {
      window.ShanheTutorial.onFinished({
        node,
        result: (endBeat && endBeat.result) || "COMEDY_FAIL",
        terminal_label: (endBeat && endBeat.closing) || "摔進泥坑",
      });
    }
  }

  async function start(options) {
    node = options && options.node;
    const src = (node && node.copy_src) || "stages/tutorial-kick.copy.json";
    const res = await fetch("assets/" + src.replace(/^assets\//, ""));
    if (!res.ok) throw new Error("教學文案載入失敗");
    copy = await res.json();
    finished = false;
    reachedChoice = false;
    const title = $("tutorial-title");
    const meta = $("tutorial-meta");
    if (title) title.textContent = copy.title || (node && node.title) || "學那一腳";
    if (meta) meta.textContent = (copy.location || "青禾渡岸上") + (copy.chapter ? `・第${copy.chapter}章` : "");
    render();
  }

  window.ShanheTutorial = { start, playChoice };
})();
