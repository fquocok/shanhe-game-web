(() => {
  const labelEl = document.getElementById("build-label");
  const toast = document.getElementById("pwa-update");
  const reloadBtn = document.getElementById("pwa-reload");

  function showLabel(data) {
    if (!labelEl || !data) return;
    const built = String(data.built || "").trim();
    const name = String(data.label || "測試版").trim();
    const rev = String(data.rev || "").trim();
    labelEl.textContent = [name, rev, built].filter(Boolean).join(" · ");
    labelEl.hidden = false;
  }

  fetch("version.json", { cache: "no-store" })
    .then((res) => (res.ok ? res.json() : null))
    .then(showLabel)
    .catch(() => {});

  if (!("serviceWorker" in navigator)) return;

  // 只在「這一頁載入時已經有控制中的 SW」之後又換了新的，才提示重新載入。
  // 第一次安裝會經過 controllerchange，不可當成「有新版本」。
  const pageStartedWithController = Boolean(navigator.serviceWorker.controller);
  let prompted = false;

  function showReload() {
    if (prompted || !toast) return;
    prompted = true;
    toast.hidden = false;
  }

  if (reloadBtn) {
    reloadBtn.onclick = () => {
      window.location.reload();
    };
  }

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (pageStartedWithController) showReload();
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js", { scope: "./" })
      .then((reg) => {
        if (reg.waiting && pageStartedWithController) showReload();
        return reg.update();
      })
      .catch(() => {});
  });
})();
