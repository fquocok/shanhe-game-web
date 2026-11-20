(() => {
  function $(id) { return document.getElementById(id); }

  const riverSvg = `
    <svg class="map-river" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <path d="M -4 78 C 18 70, 22 88, 40 80 C 58 72, 62 90, 86 76 C 96 70, 104 74, 108 72"
            fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>
      <path d="M -4 82 C 20 74, 26 92, 44 84 C 60 76, 66 92, 88 80 C 98 74, 104 78, 108 76"
            fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.45"/>
    </svg>`;

  let hooks = {};
  let manifest = null;
  let channel = "private";

  function toast(message) {
    const el = $("map-toast");
    if (!el) return;
    el.textContent = message || "";
    el.hidden = !message;
    if (message) {
      window.clearTimeout(toast._t);
      toast._t = window.setTimeout(() => { el.hidden = true; }, 2200);
    }
  }

  function render() {
    const sheet = $("map-sheet");
    if (!sheet || !manifest) return;
    const save = window.ShanheSave ? window.ShanheSave.load() : null;
    const nodes = manifest.nodes || [];
    sheet.innerHTML = riverSvg + nodes.map((node) => {
      const access = window.ShanheSave
        ? window.ShanheSave.accessFor(node, save, channel)
        : { state: "open", label: "", enterable: true };
      const x = Number(node.x);
      const y = Number(node.y);
      const cls = ["map-node", "is-" + access.state];
      if (!access.enterable) cls.push("is-blocked");
      const badge = access.state === "cleared"
        ? (access.entry && access.entry.result === "DEFEAT" ? "再" : "過")
        : access.state === "preparing" ? "候"
        : access.state === "locked" ? "封"
        : "入";
      const status = access.state === "preparing"
        ? "準備中"
        : access.state === "locked"
          ? "未開放"
          : access.state === "cleared"
            ? (access.entry && access.entry.terminal_label) || "已過"
            : (node.blurb || "可入");
      return `<button type="button" class="${cls.join(" ")}" data-id="${escapeAttr(node.id)}"
          style="left:${x}%;top:${y}%;" ${access.enterable ? "" : "aria-disabled=\"true\""}>
          <span class="map-seal">${badge}</span>
          <span class="map-node-title">${escapeHtml(node.title)}</span>
          <span class="map-node-status">${escapeHtml(status)}</span>
        </button>`;
    }).join("");

    sheet.querySelectorAll(".map-node").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-id");
        const node = nodes.find((n) => n.id === id);
        const access = window.ShanheSave
          ? window.ShanheSave.accessFor(node, window.ShanheSave.load(), channel)
          : { enterable: true, state: "open" };
        if (!access.enterable) {
          toast(access.label === "準備中" ? "這關還在準備中，先去鏢船看看。" : "這一處尚未開放。");
          return;
        }
        if (hooks.onEnter) hooks.onEnter(node);
      });
    });
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }
  function escapeAttr(value) { return escapeHtml(value).replace(/`/g, ""); }

  function mount(options) {
    hooks = options || {};
    manifest = hooks.manifest;
    channel = hooks.channel || "private";
    const title = $("map-title");
    const sub = $("map-sub");
    if (title) title.textContent = (manifest && manifest.title) || "青禾渡一帶";
    if (sub) sub.textContent = (manifest && manifest.subtitle) || "測試用地圖";
    const resetBtn = $("btn-reset-save");
    if (resetBtn && !resetBtn.dataset.bound) {
      resetBtn.dataset.bound = "1";
      resetBtn.addEventListener("click", () => {
        if (hooks.onResetRequest) hooks.onResetRequest();
      });
    }
    render();
  }

  window.ShanheMap = { mount, render, toast };
})();
