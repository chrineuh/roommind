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

With a boiler temperature sensor the release also learns how the boiler and
its heating circuit behave: how fast the water heats up while released and
how fast it cools down while idle (smoothed per cycle, kept across restarts).
That is used twice:

* While the boiler water is still warm enough to heat the radiators the
  burner is not started: the rooms use the stored heat first, which saves
  starts and keeps the burner from short-cycling on small demands.
* Smart mode starts a cold boiler earlier by its learned heat-up time, so the
  water is warm when a waiting room reaches the maximum wait.

When a burner entity is known, heat-up is learned from the burner actually
firing instead of the release. While domestic hot water is being charged the
boiler temperature says nothing about the heating circuit, so learning pauses.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from time import monotonic

RELEASE_ENTITY_DOMAINS = ("input_boolean", "switch")
DEFAULT_RELEASE_MIN_DEMAND = 1
DEFAULT_RELEASE_URGENT_DELTA = 1.5
DEFAULT_RELEASE_MAX_WAIT_MINUTES = 45
DEFAULT_BOILER_USABLE_TEMP = 45.0
DEFAULT_RELEASE_KEEP_DEMAND = 0.5  # weighted rooms that keep a running release on
MIN_ROOM_WEIGHT = 0.2  # a room asking for less than this share of heat is not counted as demand

# Learning of the boiler's heat-up / cool-down rates (K per minute)
_RATE_ALPHA = 0.2  # weight of a new observation
_RATE_MIN_DT_S = 30.0  # shorter steps are mostly sensor noise
_RATE_MAX_DT_S = 900.0  # longer gaps (restart, outage) say nothing about one step
_HEAT_LEARN_MARGIN = 15.0  # near its own setpoint the boiler stops rising; that is no heat-up rate
_MIN_RATE = 0.01

REASON_NO_DEMAND = "no_demand"
REASON_RUNNING = "running"
REASON_COUNT = "demand_count"
REASON_WEIGHTED = "weighted_demand"
REASON_URGENT = "urgent"
REASON_MAX_WAIT = "max_wait"
REASON_WAITING = "collecting_demand"
REASON_MIN_RUN = "min_run"
REASON_MIN_OFF = "min_off"
REASON_RESIDUAL_HEAT = "residual_heat"
REASON_PREHEAT = "preheat"
REASON_LOW_DEMAND = "low_demand"


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
    usable_temp: float = DEFAULT_BOILER_USABLE_TEMP
    keep_demand: float = DEFAULT_RELEASE_KEEP_DEMAND


@dataclass
class BoilerThermal:
    """Learned thermal behaviour of the boiler and its heating circuit."""

    heat_rate: float | None = None  # K/min while released and below the usable range
    cool_rate: float | None = None  # K/min lost while not released (positive)
    last_temp: float | None = None
    last_ts: float | None = None
    last_on: bool | None = None

    def observe(self, temp: float, on: bool, now: float, usable_temp: float, paused: bool = False) -> bool:
        """Feed one boiler reading; return True when a learned rate changed.

        *on* is whether the boiler is heating (burner firing, or released when
        the burner state is unknown). *paused* drops the reference point, e.g.
        while hot water is charged.
        """
        if paused:
            self.last_temp = self.last_ts = self.last_on = None
            return False
        changed = False
        if self.last_temp is not None and self.last_ts is not None and self.last_on == on:
            dt = now - self.last_ts
            if _RATE_MIN_DT_S <= dt <= _RATE_MAX_DT_S:
                rate = (temp - self.last_temp) / (dt / 60)
                if on and rate > _MIN_RATE and self.last_temp < usable_temp + _HEAT_LEARN_MARGIN:
                    self.heat_rate = _ema(self.heat_rate, rate)
                    changed = True
                elif not on and rate < -_MIN_RATE:
                    self.cool_rate = _ema(self.cool_rate, -rate)
                    changed = True
            elif dt < _RATE_MIN_DT_S:
                return False  # keep the older reference point for a longer step
        self.last_temp, self.last_ts, self.last_on = temp, now, on
        return changed

    def lead_seconds(self, temp: float | None, usable_temp: float) -> float:
        """Learned time a cold boiler needs to become usable (0 when warm or unknown)."""
        if temp is None or temp >= usable_temp or not self.heat_rate:
            return 0.0
        return (usable_temp - temp) / self.heat_rate * 60

    def warm_seconds(self, temp: float | None, usable_temp: float) -> float | None:
        """Learned time until a warm idle boiler drops below usable (None when unknown)."""
        if temp is None or not self.cool_rate:
            return None
        return max(0.0, (temp - usable_temp) / self.cool_rate * 60)


def _ema(old: float | None, new: float) -> float:
    return new if old is None else old + _RATE_ALPHA * (new - old)


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
    boiler_temp: float | None = None,
    lead_seconds: float = 0.0,
) -> tuple[bool, str]:
    """Return (release on?, reason) before min-run/min-off are applied.

    Once on, the release keeps running only while the rooms still take a real
    share of heat (weighted demand of at least ``keep_demand``); a room that
    only trickles (an MPC holding a few percent) does not keep the burner going.
    While the boiler water is still warm no burner start is needed: the rooms
    take that heat through the circuit first.
    """
    if not demands:
        return False, REASON_NO_DEMAND
    weighted = sum(room_weight(d, cfg.urgent_delta) for d in demands)
    urgent = cfg.smart and any(d.deficit is not None and d.deficit >= cfg.urgent_delta for d in demands)
    if currently_on:
        if urgent or weighted >= cfg.keep_demand - 1e-9:
            return True, REASON_RUNNING
        return False, REASON_LOW_DEMAND
    if urgent:
        return True, REASON_URGENT
    if boiler_temp is not None and boiler_temp >= cfg.usable_temp:
        return False, REASON_RESIDUAL_HEAT
    # A threshold above the number of rooms in the group could never be reached.
    needed = max(1, min(cfg.min_demand, max(1, member_room_count)))
    if cfg.smart:
        if longest_wait_seconds >= cfg.max_wait_seconds:
            return True, REASON_MAX_WAIT
        # Start a cold boiler early enough to be warm when the wait runs out.
        if lead_seconds > 0 and longest_wait_seconds + lead_seconds >= cfg.max_wait_seconds:
            return True, REASON_PREHEAT
        if weighted >= needed - 1e-9:
            return True, REASON_WEIGHTED
        return False, REASON_WAITING
    # Count only rooms that really ask for heat, not the ones holding a trickle.
    if sum(1 for d in demands if room_weight(d, cfg.urgent_delta) >= MIN_ROOM_WEIGHT) >= needed:
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
    boiler_temp: float | None = None
    lead_seconds: float = 0.0


class BoilerReleaseManager:
    """Track and decide the release of every group that has a release entity."""

    def __init__(self) -> None:
        self._states: dict[str, ReleaseState] = {}
        self._thermal: dict[str, BoilerThermal] = {}
        self.thermal_dirty = False

    def prune(self, group_ids: set[str]) -> None:
        for gid in list(self._states):
            if gid not in group_ids:
                del self._states[gid]
        for gid in list(self._thermal):
            if gid not in group_ids:
                del self._thermal[gid]
                self.thermal_dirty = True

    def get_thermal(self, group_id: str) -> BoilerThermal | None:
        return self._thermal.get(group_id)

    def load_thermal(self, data: dict) -> None:
        """Restore learned rates ({group_id: {heat_rate, cool_rate}})."""
        for gid, d in (data or {}).items():
            self._thermal[gid] = BoilerThermal(heat_rate=d.get("heat_rate"), cool_rate=d.get("cool_rate"))

    def reset_thermal(self, group_id: str) -> None:
        """Forget what was learned about a group's boiler."""
        if self._thermal.pop(group_id, None) is not None:
            self.thermal_dirty = True

    def get_thermal_state(self) -> dict:
        return {
            gid: {"heat_rate": t.heat_rate, "cool_rate": t.cool_rate}
            for gid, t in self._thermal.items()
            if t.heat_rate is not None or t.cool_rate is not None
        }

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
        boiler_temp: float | None = None,
        burner_on: bool | None = None,
        dhw_active: bool = False,
    ) -> bool:
        """Decide the release for this cycle and return whether it should be on."""
        now = monotonic() if now is None else now
        state = self._states.setdefault(group_id, ReleaseState())
        if state.on is None:
            # First cycle (or restart): take over what the entity shows, timers unknown.
            state.on = entity_is_on

        thermal = self._thermal.setdefault(group_id, BoilerThermal())
        heating = burner_on if burner_on is not None else state.on
        if boiler_temp is not None and thermal.observe(boiler_temp, heating, now, cfg.usable_temp, paused=dhw_active):
            self.thermal_dirty = True
        state.boiler_temp = boiler_temp
        state.lead_seconds = thermal.lead_seconds(boiler_temp, cfg.usable_temp)

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

        want, reason = decide_release(
            demands,
            state.on,
            cfg,
            member_room_count,
            longest_wait,
            boiler_temp=boiler_temp,
            lead_seconds=state.lead_seconds,
        )

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
