(() => {
  const MOTION_CLASSES = ["mot-idle", "mot-attack", "mot-hit", "mot-dodge", "mot-block"];
  let lastDurationMs = 0;
  let unitEl = () => null;
  let roleOf = () => "";
  const timers = new Map();

  function reduced() {
    return window.ShanheRig?.isReduced?.() || false;
  }

  function configure(options) {
    if (options.unitEl) unitEl = options.unitEl;
    if (options.roleOf) roleOf = options.roleOf;
  }

  function catalog() {
    return window.ShanheRig?.getCatalog?.() || { moves: {}, meta: null };
  }

  function weaponFor(role, family) {
    const meta = catalog().meta || {};
    if (family && meta.weapon_by_family && meta.weapon_by_family[family]) {
      return meta.weapon_by_family[family];
    }
    return (meta.default_weapon_by_role && meta.default_weapon_by_role[role]) || "pole";
  }

  function attackMoveId(moveName, weapon, family) {
    const meta = catalog().meta || {};
    if (moveName && meta.by_move_name && meta.by_move_name[moveName]) {
      return meta.by_move_name[moveName];
    }
    const type = weapon || weaponFor("", family);
    return (meta.fallback_attack && meta.fallback_attack[type]) || "attack-pole";
  }

  function reactMoveId(kind, details) {
    const meta = catalog().meta || {};
    if (details?.dodged) return "dodge";
    if (details?.parried) return "block";
    if (kind === "DODGE_CONFIRMED") return "dodge";
    if (kind === "PARRY_CONFIRMED") return "block";
    if (meta.by_event && meta.by_event[kind]) return meta.by_event[kind];
    return "hit";
  }

  function clearTimer(node) {
    const id = timers.get(node);
    if (id) {
      clearTimeout(id);
      timers.delete(node);
    }
  }

  function clearMotion(node, keepIdle) {
    if (!node) return;
    MOTION_CLASSES.forEach((name) => {
      if (name === "mot-idle" && keepIdle) return;
      node.classList.remove(name);
    });
  }

  function mountUnit(node, role) {
    if (!node || !window.ShanheRig) return;
    const host = node.querySelector(".rig-mount");
    if (!host) return;
    const weapon = weaponFor(role);
    window.ShanheRig.mount(host, { weapon });
    if (!node.classList.contains("down") && !reduced()) {
      node.classList.add("mot-idle");
      window.ShanheRig.play(host, "idle");
    }
  }

  function vectorToward(fromEl, toEl, distance) {
    if (!fromEl || !toEl) return { x: 0, y: -distance };
    const a = fromEl.getBoundingClientRect();
    const b = toEl.getBoundingClientRect();
    const dx = (b.left + b.width / 2) - (a.left + a.width / 2);
    const dy = (b.top + b.height / 2) - (a.top + a.height / 2);
    const len = Math.hypot(dx, dy) || 1;
    return { x: (dx / len) * distance, y: (dy / len) * distance };
  }

  function setVec(node, prefix, vec) {
    node.style.setProperty(`--${prefix}-x`, `${vec.x.toFixed(1)}px`);
    node.style.setProperty(`--${prefix}-y`, `${vec.y.toFixed(1)}px`);
  }

  function playIdle(node) {
    if (!node || node.classList.contains("down") || reduced()) return;
    const host = node.querySelector(".rig-mount");
    clearMotion(node);
    node.classList.add("mot-idle");
    if (host) window.ShanheRig.play(host, "idle");
  }

  function after(node, duration, fn) {
    clearTimer(node);
    const id = window.setTimeout(() => {
      timers.delete(node);
      fn();
    }, duration);
    timers.set(node, id);
  }

  function playAttack(actorId, targetId, moveName, family) {
    const actor = unitEl(actorId);
    const target = unitEl(targetId);
    if (!actor) return 0;
    const role = roleOf(actorId);
    const weapon = weaponFor(role, family);
    const moveId = attackMoveId(moveName, weapon, family);
    const move = window.ShanheRig?.getMove?.(moveId);
    const duration = reduced() ? 0 : (move?.duration_ms || 480);
    const contact = reduced() ? 0 : (move?.contact_ms ?? Math.round(duration * 0.45));
    const lunge = vectorToward(actor, target, 22);
    setVec(actor, "lunge", lunge);
    clearMotion(actor);
    actor.style.setProperty("--mot-dur", `${Math.max(duration, 280)}ms`);
    actor.classList.add("mot-attack");
    const host = actor.querySelector(".rig-mount");
    if (host) window.ShanheRig.play(host, moveId, { weapon });
    lastDurationMs = Math.max(lastDurationMs, duration);
    after(actor, duration + 30, () => playIdle(actor));
    return contact;
  }

  function playReact(targetId, kind, actorId, details) {
    const target = unitEl(targetId);
    const actor = unitEl(actorId);
    if (!target) return 0;
    const moveId = reactMoveId(kind, details);
    const move = window.ShanheRig?.getMove?.(moveId);
    const duration = reduced() ? 0 : (move?.duration_ms || 360);
    const away = vectorToward(actor, target, 1);
    // Knock the target away from the actor.
    const knock = { x: away.x * 16, y: away.y * 16 };
    const side = { x: away.y >= 0 ? 16 : -16, y: 0 };
    setVec(target, "knock", knock);
    setVec(target, "side", side);
    clearMotion(target);
    target.style.setProperty("--mot-dur", `${Math.max(duration, 240)}ms`);
    if (moveId === "dodge") target.classList.add("mot-dodge");
    else if (moveId === "block") target.classList.add("mot-block");
    else target.classList.add("mot-hit");
    const host = target.querySelector(".rig-mount");
    if (host) window.ShanheRig.play(host, moveId);
    lastDurationMs = Math.max(lastDurationMs, duration);
    after(target, duration + 30, () => playIdle(target));
    return duration;
  }

  function playDown(id) {
    const node = unitEl(id);
    if (!node) return;
    clearTimer(node);
    clearMotion(node);
    const host = node.querySelector(".rig-mount");
    if (host) window.ShanheRig.stop(host, true);
  }

  function reset() {
    lastDurationMs = 0;
    for (const node of timers.keys()) clearTimer(node);
    if (window.ShanheRig) window.ShanheRig.resetAll();
  }

  function beginStep() {
    lastDurationMs = reduced() ? 280 : 0;
  }

  function note(ms) {
    lastDurationMs = Math.max(lastDurationMs, Number(ms) || 0);
  }

  window.ShanheMotion = {
    configure,
    mountUnit,
    playAttack,
    playReact,
    playIdle,
    playDown,
    reset,
    beginStep,
    note,
    attackMoveId,
    weaponFor,
    lastDuration() { return lastDurationMs; },
  };
})();
