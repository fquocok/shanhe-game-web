(() => {
  const BONES = {
    torso: { parent: null, length: 46 },
    head: { parent: "torso", length: 16 },
    armL_upper: { parent: "torso", length: 20, along: 0.9 },
    armL_lower: { parent: "armL_upper", length: 18 },
    armR_upper: { parent: "torso", length: 20, along: 0.9 },
    armR_lower: { parent: "armR_upper", length: 18 },
    legL_upper: { parent: null, length: 24 },
    legL_lower: { parent: "legL_upper", length: 22 },
    legR_upper: { parent: null, length: 24 },
    legR_lower: { parent: "legR_upper", length: 22 },
    weapon: { parent: "armR_lower", length: 0, along: 1 },
  };
  const DRAW_ORDER = [
    "legL_upper", "legL_lower",
    "legR_upper", "legR_lower",
    "armL_upper", "armL_lower",
    "torso",
    "armR_upper", "armR_lower",
    "head",
    "weapon",
  ];
  const WEAPONS = {
    pole: { length: 86, tip: "spear" },
    blade: { length: 34, tip: "blade" },
    staff: { length: 74, tip: "none" },
    hidden: { length: 16, tip: "dart" },
  };
  const DEFAULT_POSE = {
    root: { x: 0, y: 0 },
    bones: {
      torso: 180, head: 180,
      armL_upper: -34, armL_lower: -16,
      armR_upper: 34, armR_lower: 16,
      legL_upper: 16, legL_lower: 8,
      legR_upper: -16, legR_lower: -8,
      weapon: 200,
    },
  };

  const NS = "http://www.w3.org/2000/svg";
  const instances = new Map();
  const catalog = { moves: {}, meta: null };
  let reducedMotion = false;

  function degRad(deg) {
    return (deg * Math.PI) / 180;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function lerpAngle(a, b, t) {
    const d = ((((b - a) % 360) + 540) % 360) - 180;
    return a + d * t;
  }

  function smooth(t) {
    return t * t * (3 - 2 * t);
  }

  function el(name, attrs) {
    const node = document.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attrs || {})) {
      node.setAttribute(key, String(value));
    }
    return node;
  }

  function mergePose(base, next) {
    const pose = {
      root: { x: base.root?.x || 0, y: base.root?.y || 0 },
      bones: { ...DEFAULT_POSE.bones, ...(base.bones || {}) },
    };
    if (next.root) {
      pose.root.x = next.root.x ?? pose.root.x;
      pose.root.y = next.root.y ?? pose.root.y;
    }
    if (next.bones) Object.assign(pose.bones, next.bones);
    return pose;
  }

  function interpolate(a, b, t) {
    const u = smooth(Math.max(0, Math.min(1, t)));
    const pose = { root: { x: lerp(a.root.x, b.root.x, u), y: lerp(a.root.y, b.root.y, u) }, bones: {} };
    const keys = new Set([...Object.keys(a.bones), ...Object.keys(b.bones)]);
    for (const key of keys) {
      const av = a.bones[key] ?? DEFAULT_POSE.bones[key] ?? 0;
      const bv = b.bones[key] ?? DEFAULT_POSE.bones[key] ?? av;
      pose.bones[key] = lerpAngle(av, bv, u);
    }
    return pose;
  }

  function poseAt(move, timeMs) {
    const poses = (move.poses || []).map((item, index) => {
      const t = item.t != null ? item.t : index / Math.max(1, move.poses.length - 1);
      return { t, pose: mergePose(DEFAULT_POSE, item) };
    }).sort((a, b) => a.t - b.t);
    if (!poses.length) return mergePose(DEFAULT_POSE, {});
    const duration = Math.max(1, move.duration_ms || 500);
    let u = timeMs / duration;
    if (move.loop) {
      u = u % 1;
    } else {
      u = Math.max(0, Math.min(1, u));
    }
    if (u <= poses[0].t) return poses[0].pose;
    for (let i = 1; i < poses.length; i += 1) {
      if (u <= poses[i].t) {
        const span = poses[i].t - poses[i - 1].t || 1;
        return interpolate(poses[i - 1].pose, poses[i].pose, (u - poses[i - 1].t) / span);
      }
    }
    return poses[poses.length - 1].pose;
  }

  function jointPositions(pose, weaponType) {
    const bones = pose.bones;
    const root = pose.root || { x: 0, y: 0 };
    const pos = { hip: { x: root.x, y: root.y } };
    const world = {};
    const origin = {};

    function place(id) {
      if (origin[id]) return;
      const def = BONES[id];
      let start = pos.hip;
      if (def.parent) {
        place(def.parent);
        const parentDef = BONES[def.parent];
        const along = def.along == null ? 1 : def.along;
        const parentAngle = world[def.parent];
        const parentOrigin = origin[def.parent];
        start = {
          x: parentOrigin.x + Math.sin(degRad(parentAngle)) * parentDef.length * along,
          y: parentOrigin.y + Math.cos(degRad(parentAngle)) * parentDef.length * along,
        };
      }
      origin[id] = start;
      world[id] = bones[id] ?? DEFAULT_POSE.bones[id] ?? 0;
      const length = id === "weapon" ? (WEAPONS[weaponType] || WEAPONS.pole).length : def.length;
      pos[id] = {
        start,
        end: {
          x: start.x + Math.sin(degRad(world[id])) * length,
          y: start.y + Math.cos(degRad(world[id])) * length,
        },
        angle: world[id],
        length,
      };
    }

    Object.keys(BONES).forEach(place);
    return pos;
  }

  function buildWeapon(group, type) {
    group.replaceChildren();
    const spec = WEAPONS[type] || WEAPONS.pole;
    group.dataset.weapon = type;
    const shaft = el("line", { class: "rig-stroke rig-weapon", x1: 0, y1: 0, x2: 0, y2: spec.length });
    group.appendChild(shaft);
    if (spec.tip === "spear") {
      group.appendChild(el("polygon", {
        class: "rig-fill rig-weapon-tip",
        points: `0,${spec.length - 1} 3,${spec.length - 8} 0,${spec.length + 4} -3,${spec.length - 8}`,
      }));
    } else if (spec.tip === "blade") {
      group.appendChild(el("line", { class: "rig-stroke rig-weapon-guard", x1: -4, y1: 5, x2: 4, y2: 5 }));
      group.appendChild(el("path", {
        class: "rig-stroke rig-weapon-blade",
        d: `M0 6 L0 ${spec.length} M0 ${spec.length} L3 ${spec.length - 6}`,
      }));
    } else if (spec.tip === "dart") {
      group.appendChild(el("line", {
        class: "rig-stroke rig-weapon-dart",
        x1: 0, y1: spec.length - 2, x2: 0, y2: spec.length + 3,
      }));
    }
  }

  function buildSvg(weaponType) {
    const svg = el("svg", {
      class: "rig-svg",
      viewBox: "-48 -100 96 170",
      preserveAspectRatio: "xMidYMax meet",
      "aria-hidden": "true",
    });
    const root = el("g", { class: "rig-root" });
    svg.appendChild(root);
    const nodes = {};
    for (const id of DRAW_ORDER) {
      if (id === "head") {
        const g = el("g", { class: "rig-bone rig-head-g", "data-bone": "head" });
        g.appendChild(el("circle", { class: "rig-stroke rig-head", cx: 0, cy: 7, r: 7.2 }));
        root.appendChild(g);
        nodes[id] = g;
        continue;
      }
      if (id === "weapon") {
        const g = el("g", { class: "rig-bone rig-weapon-g", "data-bone": "weapon" });
        buildWeapon(g, weaponType);
        root.appendChild(g);
        nodes[id] = g;
        continue;
      }
      const line = el("line", {
        class: "rig-stroke rig-bone-" + id,
        "data-bone": id,
        x1: 0, y1: 0, x2: 0, y2: BONES[id].length,
      });
      root.appendChild(line);
      nodes[id] = line;
    }
    return { svg, nodes };
  }

  function applyPose(instance, pose) {
    const placed = jointPositions(pose, instance.weapon);
    for (const [id, node] of Object.entries(instance.nodes)) {
      const item = placed[id];
      if (!item) continue;
      if (id === "head" || id === "weapon") {
        // Local +Y should follow world angle 0 = down. SVG rotate(θ) sends (0,L) to (-L sinθ, L cosθ),
        // so θ = -angle yields (L sin a, L cos a).
        node.setAttribute(
          "transform",
          `translate(${item.start.x.toFixed(2)} ${item.start.y.toFixed(2)}) rotate(${(-item.angle).toFixed(2)})`,
        );
        continue;
      }
      node.removeAttribute("transform");
      node.setAttribute("x1", item.start.x.toFixed(2));
      node.setAttribute("y1", item.start.y.toFixed(2));
      node.setAttribute("x2", item.end.x.toFixed(2));
      node.setAttribute("y2", item.end.y.toFixed(2));
    }
  }

  function tick(instance, now) {
    if (!instance.playing) return;
    const move = instance.playing;
    const elapsed = now - instance.startedAt;
    if (reducedMotion && !move.loop) {
      applyPose(instance, poseAt(move, move.contact_ms || move.duration_ms || 0));
      instance.playing = null;
      if (instance.onDone) instance.onDone();
      return;
    }
    applyPose(instance, poseAt(move, elapsed));
    const duration = move.duration_ms || 500;
    if (!move.loop && elapsed >= duration) {
      instance.playing = null;
      if (instance.onDone) instance.onDone();
    }
  }

  function ensureLoop() {
    if (ensureLoop.running) return;
    ensureLoop.running = true;
    const step = (now) => {
      let any = false;
      for (const instance of instances.values()) {
        if (instance.playing) {
          tick(instance, now);
          any = true;
        }
      }
      if (any) {
        requestAnimationFrame(step);
      } else {
        ensureLoop.running = false;
      }
    };
    requestAnimationFrame(step);
  }

  function mount(host, options) {
    if (!host) return null;
    const existing = instances.get(host);
    if (existing) {
      if (options && options.weapon && options.weapon !== existing.weapon) {
        setWeapon(host, options.weapon);
      }
      return existing;
    }
    const weapon = (options && options.weapon) || "pole";
    const { svg, nodes } = buildSvg(weapon);
    host.replaceChildren(svg);
    const instance = {
      host, svg, nodes, weapon,
      playing: null, startedAt: 0, onDone: null,
    };
    instances.set(host, instance);
    applyPose(instance, mergePose(DEFAULT_POSE, {}));
    return instance;
  }

  function setWeapon(host, weapon) {
    const instance = instances.get(host);
    if (!instance) return;
    instance.weapon = WEAPONS[weapon] ? weapon : "pole";
    buildWeapon(instance.nodes.weapon, instance.weapon);
    instance.svg.dataset.weapon = instance.weapon;
    if (!instance.playing) applyPose(instance, mergePose(DEFAULT_POSE, {}));
  }

  function play(host, moveOrId, options) {
    const instance = instances.get(host) || mount(host, options);
    if (!instance) return 0;
    const move = typeof moveOrId === "string" ? catalog.moves[moveOrId] : moveOrId;
    if (!move) return 0;
    if (options && options.weapon) setWeapon(host, options.weapon);
    instance.playing = move;
    instance.startedAt = performance.now();
    instance.onDone = options && options.onDone;
    if (reducedMotion && !move.loop) {
      applyPose(instance, poseAt(move, move.duration_ms || 0));
      instance.playing = null;
      if (instance.onDone) instance.onDone();
      return 0;
    }
    ensureLoop();
    return move.duration_ms || 0;
  }

  function stop(host, rest) {
    const instance = instances.get(host);
    if (!instance) return;
    instance.playing = null;
    if (rest) applyPose(instance, mergePose(DEFAULT_POSE, {}));
  }

  function resetAll() {
    for (const [host, instance] of instances) {
      instance.playing = null;
      applyPose(instance, mergePose(DEFAULT_POSE, {}));
    }
  }

  async function loadCatalog(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("無法載入動作目錄");
    const meta = await res.json();
    catalog.meta = meta;
    const base = url.replace(/[^/]+$/, "");
    const files = meta.files || [];
    await Promise.all(files.map(async (file) => {
      const response = await fetch(base + file);
      if (!response.ok) return;
      const move = await response.json();
      if (move && move.id) catalog.moves[move.id] = move;
    }));
    return catalog;
  }

  window.ShanheRig = {
    mount,
    setWeapon,
    play,
    stop,
    resetAll,
    loadCatalog,
    poseAt,
    interpolate,
    setReduced(value) { reducedMotion = Boolean(value); },
    isReduced() { return reducedMotion; },
    getCatalog() { return catalog; },
    getMove(id) { return catalog.moves[id] || null; },
    defaultPose: DEFAULT_POSE,
    weapons: Object.keys(WEAPONS),
  };
})();
