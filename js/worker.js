/* Pyodide battle worker. UI thread never recomputes damage. */
let pyodide = null;
let ready = false;
const WORKSPACE = "/shanhe";

function post(payload) {
  self.postMessage(payload);
}

async function init() {
  const t0 = performance.now();
  post({ type: "progress", message: "正在安置 Python 執行環境…" });
  const root = new URL("../", self.location.href);
  const pyodideUrl = new URL("vendor/pyodide/", root).href;
  importScripts(new URL("pyodide.js", pyodideUrl).href);
  pyodide = await loadPyodide({ indexURL: pyodideUrl });
  post({ type: "progress", message: "正在解開戰鬥引擎…" });
  const response = await fetch(new URL("packages/engine.zip", root).href);
  if (!response.ok) throw new Error("engine.zip 下載失敗：" + response.status);
  const bytes = await response.arrayBuffer();
  const zipBytes = Math.round(bytes.byteLength);
  pyodide.FS.mkdirTree(WORKSPACE);
  pyodide.unpackArchive(bytes, "zip", { extractDir: WORKSPACE });
  post({ type: "progress", message: "正在備妥鏢船…" });
  await pyodide.runPythonAsync(`
import sys
sys.path.insert(0, ${JSON.stringify(WORKSPACE)})
import bridge
`);
  ready = true;
  const loadMs = Math.round(performance.now() - t0);
  post({ type: "ready", loadMs, zipBytes });
}

async function invoke(fn, args) {
  const api = pyodide.pyimport("bridge");
  const result = api[fn](...args);
  const data = result.toJs({ dict_converter: Object.fromEntries });
  result.destroy?.();
  return JSON.parse(JSON.stringify(data));
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === "init") {
      if (!ready) await init();
      return;
    }
    if (!ready) throw new Error("引擎尚未就緒");
    const map = {
      start: () => invoke("start", [WORKSPACE, msg.encounterId || "encounter:shanhe:qinghedu_barge_night_raid"]),
      request_auto: () => invoke("request_auto", [Boolean(msg.enabled)]),
      step_auto: () => invoke("step_auto", []),
      play_to_end: () => invoke("play_to_end", [msg.maxCycles || 200]),
      select_action: () => invoke("select_action", [msg.actionId]),
      select_target: () => invoke("select_target", [msg.targetId]),
      submit: () => invoke("submit", []),
      reset: () => invoke("reset", []),
    };
    if (!map[msg.type]) throw new Error("未知指令：" + msg.type);
    const state = await map[msg.type]();
    post({ type: "state", action: msg.type, state });
  } catch (error) {
    post({ type: "error", message: String(error && error.message ? error.message : error) });
  }
};
