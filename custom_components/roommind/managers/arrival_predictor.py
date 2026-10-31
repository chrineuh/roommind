"""Learn when people come home, so a room can be warm on arrival.

Every presence entity (person, device tracker, binary sensor, boolean) is
watched each cycle. Coming home after being away for a while is recorded
with its local weekday and time of day. While everyone of a room is away,
the expected arrival is taken from earlier arrivals on the same weekday
(or, with too few of those, the same kind of day: Monday–Friday or the
weekend), so the room can start heating before the door opens.

Only arrivals later than now count, and only when they happened on enough
different days; a person who rarely comes home at this time gets no
prediction, and the room stays at its away temperature.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from homeassistant.util import dt as dt_util

MIN_AWAY_SECONDS = 20 * 60  # shorter absences (a walk to the bin) are no arrival
HISTORY_DAYS = 56  # eight weeks of arrivals
MIN_DAYS = 3  # arrivals on this many different days before predicting
EARLY_QUANTILE = 0.25  # aim for the earlier arrivals: better warm a bit early than late
MAX_EVENTS = 400  # per entity, a safety net for flapping trackers


@dataclass
class _Tracker:
    home: bool | None = None
    away_since: float | None = None
    arrivals: list[float] = field(default_factory=list)


def _local(ts: float) -> datetime:
    local: datetime = dt_util.as_local(datetime.fromtimestamp(ts, tz=UTC))
    return local


def _minute_of_day(d: datetime) -> int:
    return d.hour * 60 + d.minute


def _quantile(values: list[int], q: float) -> int:
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, round(q * (len(ordered) - 1))))
    return ordered[idx]


class ArrivalPredictor:
    """Record arrivals per presence entity and predict the next one."""

    def __init__(self) -> None:
        self._trackers: dict[str, _Tracker] = {}
        self.dirty = False

    # ── persistence ─────────────────────────────────────────────────

    def load_state(self, data: dict) -> None:
        for eid, arrivals in (data or {}).items():
            self._trackers[eid] = _Tracker(arrivals=[float(t) for t in arrivals][-MAX_EVENTS:])

    def get_state(self) -> dict:
        return {eid: t.arrivals for eid, t in self._trackers.items() if t.arrivals}

    # ── learning ────────────────────────────────────────────────────

    def observe(self, entity_id: str, is_home: bool | None, now: float) -> None:
        """Feed the entity's current home/away state (None = unknown, ignored)."""
        if is_home is None:
            return
        t = self._trackers.setdefault(entity_id, _Tracker())
        if t.home is None:
            # First reading after start: an away start time is unknown, so no arrival can be measured yet.
            t.home = is_home
            t.away_since = None
            return
        if t.home and not is_home:
            t.away_since = now
        elif not t.home and is_home:
            if t.away_since is not None and now - t.away_since >= MIN_AWAY_SECONDS:
                t.arrivals.append(now)
                cutoff = now - HISTORY_DAYS * 86400
                t.arrivals = [a for a in t.arrivals if a >= cutoff][-MAX_EVENTS:]
                self.dirty = True
            t.away_since = None
        t.home = is_home

    def prune(self, entity_ids: set[str]) -> None:
        for eid in list(self._trackers):
            if eid not in entity_ids:
                del self._trackers[eid]
                self.dirty = True

    # ── prediction ──────────────────────────────────────────────────

    def _arrival_minutes(self, entity_id: str, now: float) -> list[tuple[str, int]]:
        """(local date, minute of day) of recent arrivals that match today's weekday, else today's kind of day."""
        t = self._trackers.get(entity_id)
        if not t or not t.arrivals:
            return []
        today = _local(now)
        cutoff = now - HISTORY_DAYS * 86400
        events = [_local(a) for a in t.arrivals if cutoff <= a < now]
        same_day = [e for e in events if e.weekday() == today.weekday()]
        pool = same_day
        if len({e.date() for e in same_day}) < MIN_DAYS:
            weekend = today.weekday() >= 5
            pool = [e for e in events if (e.weekday() >= 5) == weekend]
        return [(e.date().isoformat(), _minute_of_day(e)) for e in pool]

    def predict_entity(self, entity_id: str, now: float) -> float | None:
        """Expected arrival time (epoch seconds) of one entity later today, or None."""
        now_local = _local(now)
        now_min = _minute_of_day(now_local)
        later = [(d, m) for d, m in self._arrival_minutes(entity_id, now) if m > now_min]
        if len({d for d, _ in later}) < MIN_DAYS:
            return None
        minute = _quantile([m for _, m in later], EARLY_QUANTILE)
        midnight = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
        return (midnight + timedelta(minutes=minute)).timestamp()

    def predict(self, entity_ids: list[str], now: float) -> float | None:
        """Earliest expected arrival among the given entities that are away."""
        times = []
        for eid in entity_ids:
            t = self._trackers.get(eid)
            if t is None or t.home is not False:
                continue
            p = self.predict_entity(eid, now)
            if p is not None:
                times.append(p)
        return min(times) if times else None

    def summary(self, entity_id: str, now: float) -> dict:
        """Typical arrival per weekday (median, HH:MM) and the number of recorded arrivals."""
        t = self._trackers.get(entity_id)
        events = [_local(a) for a in (t.arrivals if t else []) if a >= now - HISTORY_DAYS * 86400]
        typical: dict[int, str] = {}
        for wd in range(7):
            mins = [_minute_of_day(e) for e in events if e.weekday() == wd]
            if mins:
                m = _quantile(mins, 0.5)
                typical[wd] = f"{m // 60:02d}:{m % 60:02d}"
        return {
            "arrivals": len(events),
            "typical": typical,
            "home": t.home if t else None,
            "next": self.predict_entity(entity_id, now) if t and t.home is False else None,
        }
