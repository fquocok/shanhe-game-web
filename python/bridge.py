"""Headless web adapter over BattleScreenSession. UI may only consume presentation data."""
from __future__ import annotations

import json
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any

from shanhe_stat_overlay import install_shanhe_stat_profiles

install_shanhe_stat_profiles()

from battle_core.game_facing_encounter import encounter_configuration
from battle_core.interactive_battle_screen import BattleScreenSession

DEFAULT_ENCOUNTER = "encounter:shanhe:qinghedu_barge_night_raid"
KIND_LABELS_FALLBACK = {
    "VICTORY": "鏢船守住了",
    "DEFEAT": "鏢船失守",
}


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if is_dataclass(value):
        return _jsonable(asdict(value))
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(v) for v in value]
    if isinstance(value, Path):
        return str(value)
    if hasattr(value, "value") and not callable(value):
        try:
            return _jsonable(value.value)
        except Exception:
            pass
    return str(value)


class ShanheBattleBridge:
    def __init__(self, workspace: str | Path, encounter_id: str = DEFAULT_ENCOUNTER):
        self.workspace = Path(workspace)
        self.encounter_id = encounter_id
        self.aliases = self._load_aliases()
        self.faction_names = self._load_faction_names()
        self.meta = self._load_encounter_meta()
        self.session: BattleScreenSession | None = None
        self.last_events: list[dict[str, Any]] = []

    def _load_aliases(self) -> dict[str, Any]:
        path = self.workspace / "game_content" / "shanhe" / "presentation_aliases.json"
        if not path.exists():
            return {}
        return json.loads(path.read_text(encoding="utf-8"))

    def _load_faction_names(self) -> dict[str, str]:
        registry_path = self.workspace / "game_content" / "factions" / "faction_registry.json"
        names: dict[str, str] = {}
        if not registry_path.exists():
            return names
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
        for faction_id, filename in registry.get("factions", {}).items():
            raw = json.loads((registry_path.parent / filename).read_text(encoding="utf-8"))
            names[faction_id] = raw.get("name") or faction_id
        return names

    def _load_encounter_meta(self) -> dict[str, Any]:
        registry = json.loads((self.workspace / "game_content" / "encounters" / "encounter_registry.json").read_text(encoding="utf-8"))
        filename = registry["encounters"][self.encounter_id]
        raw = json.loads((self.workspace / "game_content" / "encounters" / filename).read_text(encoding="utf-8"))
        return raw.get("metadata") or {}

    def start(self) -> dict[str, Any]:
        config, _loader = encounter_configuration(self.workspace, self.encounter_id)
        self.session = BattleScreenSession(self.workspace, configuration=config)
        self.last_events = []
        return self.public_state()

    def _require(self) -> BattleScreenSession:
        if self.session is None:
            raise RuntimeError("battle has not started")
        return self.session

    def _drain_presentation(self) -> None:
        session = self._require()
        if not session.presentation_busy:
            return
        events = list(session.settled_presentation_events or ())
        beat = session.current_presentation_beat()
        if beat is not None:
            events.append(_jsonable(asdict(beat)))
        self.last_events.extend(events)
        # Skip visual timing; the web UI owns pacing. Encounter closure is still reported via terminal_result.
        session.finish_presentation(session.feedback_generation)
        if session.presentation_busy and session.terminal_result:
            session.presentation_busy = False
            session.active_auto_cycle_id = None

    def request_auto(self, enabled: bool = True) -> dict[str, Any]:
        session = self._require()
        session.request_auto(enabled)
        return self.public_state()

    def step_auto(self) -> dict[str, Any]:
        session = self._require()
        self.last_events = []
        if session.effective_control_mode() not in ("AUTO_FRIENDLY_CONTROL", "ALLY_ONLY_AUTO_RESOLUTION"):
            session.request_auto(True)
        state = session.continue_auto_cycle()
        events = list(session.settled_presentation_events or ())
        self.last_events.extend(_jsonable(events))
        self._drain_presentation()
        return self.public_state()

    def play_to_end(self, max_cycles: int = 200) -> dict[str, Any]:
        session = self._require()
        session.request_auto(True)
        collected: list[dict[str, Any]] = []
        cycles = 0
        while session.terminal_result is None and cycles < max_cycles:
            self.step_auto()
            collected.extend(self.last_events)
            cycles += 1
        self.last_events = collected
        state = self.public_state()
        state["cycles"] = cycles
        state["reached_end"] = session.terminal_result is not None
        return state

    def select_action(self, action_id: str) -> dict[str, Any]:
        self._require().select_action(action_id)
        return self.public_state()

    def select_target(self, target_id: str) -> dict[str, Any]:
        self._require().select_target(target_id)
        return self.public_state()

    def submit(self) -> dict[str, Any]:
        session = self._require()
        self.last_events = []
        session.submit()
        self.last_events.extend(_jsonable(list(session.settled_presentation_events or ())))
        self._drain_presentation()
        return self.public_state()

    def reset(self) -> dict[str, Any]:
        return self.start()

    def _actor_view(self, runtime_id: str, fallback_name: str, team: str) -> dict[str, Any]:
        session = self._require()
        engine = session.controller.service.settlement_bridge.engine
        state = engine.state_by_id(runtime_id)
        participant = session.controller.participants.get(runtime_id)
        target = session.controller.targets.get(runtime_id)
        display = fallback_name
        if target is not None:
            display = target.display_name
        elif participant is not None:
            display = participant.bound.loadout.display_name
        hp = int(state.current_hp) if state is not None else 0
        max_hp = int(getattr(state, "max_hp", 0) or 0) if state is not None else 0
        if max_hp <= 0 and participant is not None:
            max_hp = int(participant.bound.state.max_hp or 0)
        defeated = bool(state.defeated) if state is not None else True
        shield = int(getattr(state, "current_shield", 0) or 0) if state is not None else 0
        loadout_ref = None
        if session.configuration:
            mapping = None
            # recover loadout from encounter mappings via resolver is not needed; use aliases by weapon
        weapon_family = None
        if participant is not None:
            weapon_family = participant.bound.view.family
        return {
            "id": runtime_id,
            "name": display,
            "team": team,
            "hp": hp,
            "max_hp": max_hp,
            "shield": shield,
            "alive": not defeated,
            "weapon_family": weapon_family,
        }

    def _label_kind(self, kind: str) -> str:
        raw = str(kind)
        if "." in raw:
            raw = raw.rsplit(".", 1)[-1]
        labels = (self.aliases.get("event_kind_labels") or {})
        return labels.get(raw, labels.get(kind, KIND_LABELS_FALLBACK.get(raw, raw)))

    def _label_action(self, display_name: str, loadout_hint: str | None = None) -> str:
        labels = self.aliases.get("martial_loadout_labels") or {}
        if loadout_hint and loadout_hint in labels:
            return labels[loadout_hint]["display_name"]
        return display_name

    def public_state(self) -> dict[str, Any]:
        session = self._require()
        raw = session.screen_state()
        player_id = session.configuration.player_runtime_id if session.configuration else raw["player"]["character_id"]
        player = self._actor_view(player_id, (raw.get("player") or {}).get("display_name") or "玩家", "player")
        allies = []
        for item in raw.get("friendly_participants") or ():
            identity = item["character_id"]
            if identity == player_id:
                continue
            allies.append(self._actor_view(identity, item.get("display_name") or identity, "player"))
        enemies = []
        for item in raw.get("enemies") or ():
            enemies.append(self._actor_view(item["character_id"], item.get("display_name") or item["character_id"], "enemy"))

        action_labels = self.aliases.get("action_id_labels") or {}
        actions = []
        for action in raw.get("actions") or ():
            mapped = action_labels.get(action["action_id"]) or {}
            actions.append({
                "action_id": action["action_id"],
                "display_name": mapped.get("display_name") or action.get("display_name"),
                "set_name": mapped.get("set_name"),
                "engine_name": action.get("display_name"),
                "enabled": bool(action.get("enabled")),
                "reason": action.get("reason_text") or "",
            })

        events = []
        for event in self.last_events:
            kind = event.get("kind") or event.get("event_type") or event.get("type") or ""
            if isinstance(kind, dict):
                kind = kind.get("value") or str(kind)
            events.append({
                "kind": kind,
                "label": self._label_kind(str(kind)),
                "actor_id": event.get("actor_id"),
                "target_ids": event.get("target_ids") or event.get("targets") or [],
                "details": event.get("details") or {},
                "sequence": event.get("sequence") or event.get("presentation_sequence"),
            })

        terminal = raw.get("terminal_result")
        return {
            "encounter_id": self.encounter_id,
            "title": self.meta.get("worldview_title") or raw.get("snapshot", {}).get("battle_id") or self.encounter_id,
            "chapter": self.meta.get("chapter"),
            "location": self.meta.get("location_name"),
            "flavor": self.meta.get("flavor"),
            "credits": self.meta.get("credits"),
            "control_mode": raw.get("control_mode"),
            "auto_enabled": bool(raw.get("auto_enabled")),
            "formal_turn": session.controller.formal_turn,
            "terminal_result": terminal,
            "terminal_label": None if not terminal else self._label_kind(str(terminal)),
            "player": player,
            "allies": allies,
            "enemies": enemies,
            "actions": actions,
            "selected_action_id": raw.get("selected_action_id"),
            "selected_target_id": raw.get("selected_target_id"),
            "events": events,
            "log": list(raw.get("combat_log") or ())[-12:],
            "error": raw.get("error"),
            "presentation_busy": bool(raw.get("presentation_busy")),
        }


# Module-level helpers for the Pyodide worker (single battle at a time).
_bridge: ShanheBattleBridge | None = None


def _active() -> ShanheBattleBridge:
    if _bridge is None:
        raise RuntimeError("call start() first")
    return _bridge


def start(workspace: str, encounter_id: str = DEFAULT_ENCOUNTER) -> dict[str, Any]:
    global _bridge
    _bridge = ShanheBattleBridge(workspace, encounter_id)
    return _bridge.start()


def request_auto(enabled: bool = True) -> dict[str, Any]:
    return _active().request_auto(enabled)


def step_auto() -> dict[str, Any]:
    return _active().step_auto()


def play_to_end(max_cycles: int = 200) -> dict[str, Any]:
    return _active().play_to_end(max_cycles)


def select_action(action_id: str) -> dict[str, Any]:
    return _active().select_action(action_id)


def select_target(target_id: str) -> dict[str, Any]:
    return _active().select_target(target_id)


def submit() -> dict[str, Any]:
    return _active().submit()


def reset() -> dict[str, Any]:
    return _active().reset()
