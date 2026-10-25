"""Heat release for a boiler (e.g. an oil burner) shared by a compressor group.

The group's release entity (``input_boolean.*`` or ``switch.*``) enables the
burner. It is switched on once enough member rooms need heat, so the burner
runs fewer, longer cycles instead of starting for every small demand, and it
stays on while any member room still heats (rooms with a small demand take
heat during that run). The group's min-run and min-off times apply to the
release as well.

Smart mode weighs each room by how much heat the room's learned model (MPC)
asks for, instead of counting a room that wants 5 % the same as one that
wants 100 %. A room far below its target, or one that has waited too long,
releases the burner on its own so nobody is left cold.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from time import monotonic

RELEASE_ENTITY_DOMAINS = ("input_boolean", "switch")
DEFAULT_RELEASE_MIN_DEMAND = 1
DEFAULT_RELEASE_URGENT_DELTA = 1.5
DEFAULT_RELEASE_MAX_WAIT_MINUTES = 45

REASON_NO_DEMAND = "no_demand"
REASON_RUNNING = "running"
REASON_COUNT = "demand_count"
REASON_WEIGHTED = "weighted_demand"
REASON_URGENT = "urgent"
REASON_MAX_WAIT = "max_wait"
REASON_WAITING = "collecting_demand"
REASON_MIN_RUN = "min_run"
REASON_MIN_OFF = "min_off"


@dataclass
class RoomHeatDemand:
    """One member room that currently asks for heat."""

    area_id: str
    power: float  # 0..1, share of full heating power the room's controller asks for
    deficit: float | None  # heat target minus current temperature in K, None without a reading


@dataclass
class ReleaseConfig:
    """Release settings of one compressor group."""

    entity_id: str
    min_demand: int = DEFAULT_RELEASE_MIN_DEMAND
    smart: bool = False
    urgent_delta: float = DEFAULT_RELEASE_URGENT_DELTA
    max_wait_seconds: float = DEFAULT_RELEASE_MAX_WAIT_MINUTES * 60


def room_weight(demand: RoomHeatDemand, urgent_delta: float) -> float:
    """How much of a 'full' room this demand is worth in smart mode (0..1)."""
    weight = max(0.0, min(1.0, demand.power))
    if demand.deficit is not None and urgent_delta > 0:
        weight = max(weight, min(1.0, demand.deficit / urgent_delta))
    return weight


def decide_release(
    demands: list[RoomHeatDemand],
    currently_on: bool,
    cfg: ReleaseConfig,
    member_room_count: int,
    longest_wait_seconds: float,
) -> tuple[bool, str]:
    """Return (release on?, reason) before min-run/min-off are applied."""
    if not demands:
        return False, REASON_NO_DEMAND
    if currently_on:
        return True, REASON_RUNNING
    # A threshold above the number of rooms in the group could never be reached.
    needed = max(1, min(cfg.min_demand, max(1, member_room_count)))
    if cfg.smart:
        if any(d.deficit is not None and d.deficit >= cfg.urgent_delta for d in demands):
            return True, REASON_URGENT
        if longest_wait_seconds >= cfg.max_wait_seconds:
            return True, REASON_MAX_WAIT
        if sum(room_weight(d, cfg.urgent_delta) for d in demands) >= needed - 1e-9:
            return True, REASON_WEIGHTED
        return False, REASON_WAITING
    if len(demands) >= needed:
        return True, REASON_COUNT
    return False, REASON_WAITING


@dataclass
class ReleaseState:
    """Runtime state of one group's release."""

    on: bool | None = None  # None until the first decision (adopts the entity's state)
    on_since: float | None = None
    off_since: float | None = None
    reason: str = REASON_NO_DEMAND
    waiting_since: dict[str, float] = field(default_factory=dict)
    demand_count: int = 0
    weighted_demand: float = 0.0


class BoilerReleaseManager:
    """Track and decide the release of every group that has a release entity."""

    def __init__(self) -> None:
        self._states: dict[str, ReleaseState] = {}

    def prune(self, group_ids: set[str]) -> None:
        for gid in list(self._states):
            if gid not in group_ids:
                del self._states[gid]

    def get_state(self, group_id: str) -> ReleaseState | None:
        return self._states.get(group_id)

    def evaluate(
        self,
        group_id: str,
        cfg: ReleaseConfig,
        demands: list[RoomHeatDemand],
        member_room_count: int,
        entity_is_on: bool,
        min_run_seconds: float,
        min_off_seconds: float,
        now: float | None = None,
    ) -> bool:
        """Decide the release for this cycle and return whether it should be on."""
        now = monotonic() if now is None else now
        state = self._states.setdefault(group_id, ReleaseState())
        if state.on is None:
            # First cycle (or restart): take over what the entity shows, timers unknown.
            state.on = entity_is_on

        demanding = {d.area_id for d in demands}
        for area_id in list(state.waiting_since):
            if area_id not in demanding:
                del state.waiting_since[area_id]
        if not state.on:
            for area_id in demanding:
                state.waiting_since.setdefault(area_id, now)
        longest_wait = max((now - t for t in state.waiting_since.values()), default=0.0)

        state.demand_count = len(demands)
        state.weighted_demand = round(sum(room_weight(d, cfg.urgent_delta) for d in demands), 2)

        want, reason = decide_release(demands, state.on, cfg, member_room_count, longest_wait)

        if state.on and not want and state.on_since is not None and now - state.on_since < min_run_seconds:
            want, reason = True, REASON_MIN_RUN
        elif not state.on and want and state.off_since is not None and now - state.off_since < min_off_seconds:
            want, reason = False, REASON_MIN_OFF

        state.reason = reason
        return want

    def confirm(self, group_id: str, on: bool, now: float | None = None) -> None:
        """Record the switch state after the command went out."""
        now = monotonic() if now is None else now
        state = self._states.setdefault(group_id, ReleaseState())
        if on and state.on is not True:
            state.on_since = now
            state.off_since = None
            state.waiting_since.clear()
        elif not on and state.on is not False:
            state.off_since = now
            state.on_since = None
        state.on = on
