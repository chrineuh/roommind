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

With location (person/device tracker with GPS) the distance to home is
followed as well:

* Someone heading home is expected at distance / approach speed, someone
  within the "near" radius right away. That beats the learned time when
  they come earlier than usual.
* Someone farther than the trip distance is on a trip: the learned time is
  ignored (they will not be home at the usual hour) and the room can use the
  vacation temperature until they head back.
* Coming home after more than a day away is not learned as an arrival time,
  so trips do not skew the weekday pattern.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from homeassistant.util import dt as dt_util

MIN_AWAY_SECONDS = 20 * 60  # shorter absences (a walk to the bin) are no arrival
HISTORY_DAYS = 56  # eight weeks of arrivals
MIN_DAYS = 3  # arrivals on this many different days before predicting
EARLY_QUANTILE = 0.25  # aim for the earlier arrivals: better warm a bit early than late
MAX_EVENTS = 400  # per entity, a safety net for flapping trackers
MAX_LEARN_AWAY_SECONDS = 16 * 3600  # longer absences are trips, not a daily pattern

# Location
DEFAULT_NEAR_KM = 1.0
DEFAULT_TRIP_KM = 100.0
MAX_GPS_ACCURACY_M = 1000  # coarser fixes (cell towers) are ignored
SPEED_WINDOW_S = 20 * 60  # approach speed from the readings of the last 20 minutes
MIN_SPEED_SPAN_S = 3 * 60  # ... spanning at least 3 minutes
MIN_APPROACH_KMH = 3.0  # slower than walking pace is no approach
NEAR_ETA_S = 5 * 60


@dataclass
class _Tracker:
    home: bool | None = None
    away_since: float | None = None
    arrivals: list[float] = field(default_factory=list)
    distance_km: float | None = None
    distances: deque[tuple[float, float]] = field(default_factory=lambda: deque(maxlen=60))


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in km."""
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


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

    def observe(
        self,
        entity_id: str,
        is_home: bool | None,
        now: float,
        distance: float | None = None,
    ) -> None:
        """Feed the entity's current home/away state (None = unknown, ignored) and distance to home in km."""
        if is_home is None:
            return
        t = self._trackers.setdefault(entity_id, _Tracker())
        self._observe_distance(t, 0.0 if is_home else distance, now)
        if t.home is None:
            # First reading after start: an away start time is unknown, so no arrival can be measured yet.
            t.home = is_home
            t.away_since = None
            return
        if t.home and not is_home:
            t.away_since = now
        elif not t.home and is_home:
            if t.away_since is not None and MIN_AWAY_SECONDS <= now - t.away_since <= MAX_LEARN_AWAY_SECONDS:
                t.arrivals.append(now)
                cutoff = now - HISTORY_DAYS * 86400
                t.arrivals = [a for a in t.arrivals if a >= cutoff][-MAX_EVENTS:]
                self.dirty = True
            t.away_since = None
        t.home = is_home

    @staticmethod
    def _observe_distance(t: _Tracker, distance: float | None, now: float) -> None:
        t.distance_km = distance
        if distance is None:
            return
        t.distances.append((now, distance))
        while t.distances and now - t.distances[0][0] > SPEED_WINDOW_S:
            t.distances.popleft()

    def approach_kmh(self, entity_id: str) -> float | None:
        """Speed towards home over the last minutes (positive = coming closer), None without enough readings."""
        t = self._trackers.get(entity_id)
        if not t or len(t.distances) < 2:
            return None
        (t0, d0), (t1, d1) = t.distances[0], t.distances[-1]
        if t1 - t0 < MIN_SPEED_SPAN_S:
            return None
        return (d0 - d1) / ((t1 - t0) / 3600)

    def location_eta(self, entity_id: str, now: float, near_km: float = DEFAULT_NEAR_KM) -> float | None:
        """Expected arrival from distance and approach speed, None when not heading home."""
        t = self._trackers.get(entity_id)
        if not t or t.home is not False or t.distance_km is None:
            return None
        if t.distance_km <= near_km:
            return now + NEAR_ETA_S
        speed = self.approach_kmh(entity_id)
        if speed is None or speed < MIN_APPROACH_KMH:
            return None
        return now + t.distance_km / speed * 3600

    def on_trip(self, entity_id: str, trip_km: float = DEFAULT_TRIP_KM) -> bool:
        """Away and farther than *trip_km* from home (and not heading back fast)."""
        t = self._trackers.get(entity_id)
        return bool(t and t.home is False and t.distance_km is not None and t.distance_km > trip_km)

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

    def predict(
        self,
        entity_ids: list[str],
        now: float,
        use_location: bool = False,
        near_km: float = DEFAULT_NEAR_KM,
        trip_km: float = DEFAULT_TRIP_KM,
    ) -> tuple[float, str] | None:
        """Earliest expected arrival among the given entities that are away, with its source.

        Source is "location" (heading home / nearby) or "learned" (usual time).
        With location, someone on a trip gets no learned arrival.
        """
        best: tuple[float, str] | None = None
        for eid in entity_ids:
            t = self._trackers.get(eid)
            if t is None or t.home is not False:
                continue
            candidates: list[tuple[float, str]] = []
            if use_location:
                eta = self.location_eta(eid, now, near_km)
                if eta is not None:
                    candidates.append((eta, "location"))
            if not (use_location and self.on_trip(eid, trip_km)):
                learned = self.predict_entity(eid, now)
                if learned is not None:
                    candidates.append((learned, "learned"))
            for c in candidates:
                if best is None or c[0] < best[0]:
                    best = c
        return best

    def all_on_trip(self, entity_ids: list[str], trip_km: float = DEFAULT_TRIP_KM) -> bool:
        """Every entity is known to be on a trip (no location or someone home: False)."""
        return bool(entity_ids) and all(self.on_trip(eid, trip_km) for eid in entity_ids)

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
        speed = self.approach_kmh(entity_id)
        return {
            "arrivals": len(events),
            "typical": typical,
            "home": t.home if t else None,
            "next": self.predict_entity(entity_id, now) if t and t.home is False else None,
            "distance_km": round(t.distance_km, 1) if t and t.distance_km is not None else None,
            "approach_kmh": round(speed) if speed is not None else None,
            "eta": self.location_eta(entity_id, now) if t else None,
        }
