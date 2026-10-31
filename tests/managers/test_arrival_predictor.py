"""Tests for learning arrival times."""

from datetime import datetime, timedelta

import pytest
from homeassistant.util import dt as dt_util

from custom_components.roommind.managers.arrival_predictor import (
    MIN_AWAY_SECONDS,
    NEAR_ETA_S,
    ArrivalPredictor,
    distance_km,
)


def _ts(day: datetime, hh: int, mm: int) -> float:
    return day.replace(hour=hh, minute=mm, second=0, microsecond=0).timestamp()


def _monday(weeks_ago: int) -> datetime:
    today = dt_util.now().replace(hour=0, minute=0, second=0, microsecond=0)
    monday = today - timedelta(days=today.weekday())
    return monday - timedelta(weeks=weeks_ago)


def _learn_day(p: ArrivalPredictor, day: datetime, leave=(7, 30), back=(17, 0), eid="person.a"):
    p.observe(eid, True, _ts(day, 6, 0))
    p.observe(eid, False, _ts(day, *leave))
    p.observe(eid, True, _ts(day, *back))


def test_first_reading_records_no_arrival():
    p = ArrivalPredictor()
    day = _monday(1)
    p.observe("person.a", False, _ts(day, 6, 0))
    p.observe("person.a", True, _ts(day, 17, 0))
    assert p.get_state() == {}


def test_short_absence_is_ignored():
    p = ArrivalPredictor()
    day = _monday(1)
    p.observe("person.a", True, _ts(day, 6, 0))
    p.observe("person.a", False, _ts(day, 7, 0))
    p.observe("person.a", True, _ts(day, 7, 0) + MIN_AWAY_SECONDS - 60)
    assert p.get_state() == {}
    assert p.dirty is False


def test_predicts_same_weekday_after_enough_days():
    p = ArrivalPredictor()
    for weeks, mm in ((3, 0), (2, 10), (1, 20)):
        _learn_day(p, _monday(weeks), back=(17, mm))
    assert p.dirty is True
    monday = _monday(0)
    now = _ts(monday, 8, 0)
    p.observe("person.a", True, _ts(monday, 6, 0))
    p.observe("person.a", False, _ts(monday, 7, 30))
    pred = p.predict(["person.a"], now)
    assert pred is not None
    assert pred[1] == "learned"
    got = dt_util.as_local(datetime.fromtimestamp(pred[0], tz=dt_util.UTC))
    assert (got.hour, got.minute) == (17, 0)  # the early quantile of 17:00/17:10/17:20


def test_no_prediction_with_too_few_days_or_when_home():
    p = ArrivalPredictor()
    for weeks in (2, 1):
        _learn_day(p, _monday(weeks))
    monday = _monday(0)
    p.observe("person.a", True, _ts(monday, 6, 0))
    p.observe("person.a", False, _ts(monday, 7, 30))
    assert p.predict(["person.a"], _ts(monday, 8, 0)) is None
    _learn_day(p, _monday(3))
    p.observe("person.a", True, _ts(monday, 9, 0))
    assert p.predict(["person.a"], _ts(monday, 9, 5)) is None  # home again


def test_no_prediction_after_usual_arrival_time():
    p = ArrivalPredictor()
    for weeks in (3, 2, 1):
        _learn_day(p, _monday(weeks))
    monday = _monday(0)
    p.observe("person.a", True, _ts(monday, 6, 0))
    p.observe("person.a", False, _ts(monday, 7, 30))
    assert p.predict(["person.a"], _ts(monday, 19, 0)) is None


def test_earliest_of_several_people_and_persistence():
    p = ArrivalPredictor()
    for weeks in (3, 2, 1):
        _learn_day(p, _monday(weeks), back=(17, 0), eid="person.a")
        _learn_day(p, _monday(weeks), back=(15, 30), eid="person.b")
    monday = _monday(0)
    for eid in ("person.a", "person.b"):
        p.observe(eid, True, _ts(monday, 6, 0))
        p.observe(eid, False, _ts(monday, 7, 30))
    pred = p.predict(["person.a", "person.b"], _ts(monday, 8, 0))
    got = dt_util.as_local(datetime.fromtimestamp(pred[0], tz=dt_util.UTC))
    assert (got.hour, got.minute) == (15, 30)

    p2 = ArrivalPredictor()
    p2.load_state(p.get_state())
    summary = p2.summary("person.a", _ts(monday, 8, 0))
    assert summary["arrivals"] == 3
    assert summary["typical"][0] == "17:00"
    p2.prune({"person.b"})
    assert "person.a" not in p2.get_state()


# ── location ────────────────────────────────────────────────────────


def _away(p: ArrivalPredictor, eid: str, t0: float, distance: float | None = None):
    p.observe(eid, True, t0 - 3600)
    p.observe(eid, False, t0, distance)


def test_distance_km_known_value():
    # Munich → Vienna, ~355 km
    assert distance_km(48.137, 11.575, 48.208, 16.373) == pytest.approx(355, abs=5)
    assert distance_km(48.0, 11.0, 48.0, 11.0) == 0


def test_eta_from_approach_speed():
    p = ArrivalPredictor()
    t0 = 1_800_000_000.0
    _away(p, "person.a", t0, 30.0)
    p.observe("person.a", False, t0 + 600, 20.0)  # 10 km in 10 min = 60 km/h
    assert p.approach_kmh("person.a") == pytest.approx(60)
    eta = p.location_eta("person.a", t0 + 600)
    assert eta == pytest.approx(t0 + 600 + 20 * 60)  # 20 km at 60 km/h
    assert p.predict(["person.a"], t0 + 600, use_location=True) == (pytest.approx(eta), "location")
    # Location ignored when not enabled
    assert p.predict(["person.a"], t0 + 600) is None


def test_no_eta_when_moving_away_or_too_few_readings():
    p = ArrivalPredictor()
    t0 = 1_800_000_000.0
    _away(p, "person.a", t0, 10.0)
    assert p.location_eta("person.a", t0) is None  # a single reading
    p.observe("person.a", False, t0 + 60, 9.0)
    assert p.approach_kmh("person.a") is None  # span under 3 minutes
    p.observe("person.a", False, t0 + 600, 15.0)
    assert p.location_eta("person.a", t0 + 600) is None  # moving away


def test_near_radius_means_arriving_now():
    p = ArrivalPredictor()
    t0 = 1_800_000_000.0
    _away(p, "person.a", t0, 0.6)
    assert p.location_eta("person.a", t0, near_km=1.0) == t0 + NEAR_ETA_S


def test_speed_window_drops_old_readings():
    p = ArrivalPredictor()
    t0 = 1_800_000_000.0
    _away(p, "person.a", t0, 50.0)
    p.observe("person.a", False, t0 + 3600, 40.0)  # the old reading is outside the 20 min window
    assert p.approach_kmh("person.a") is None


def test_trip_suppresses_learned_time_but_not_heading_home():
    p = ArrivalPredictor()
    for weeks in (3, 2, 1):
        _learn_day(p, _monday(weeks))
    monday = _monday(0)
    t0 = _ts(monday, 8, 0)
    _away(p, "person.a", t0, 400.0)
    assert p.on_trip("person.a", 100) is True
    assert p.all_on_trip(["person.a"], 100) is True
    assert p.predict(["person.a"], t0, use_location=True, trip_km=100) is None
    assert p.predict(["person.a"], t0)[1] == "learned"  # without location the usual time stays
    # Driving back: 400 → 300 km in an hour
    p.observe("person.a", False, t0 + 600, 383.3)
    p.observe("person.a", False, t0 + 1200, 366.7)
    pred = p.predict(["person.a"], t0 + 1200, use_location=True, trip_km=100)
    assert pred is not None and pred[1] == "location"


def test_all_on_trip_needs_everyone():
    p = ArrivalPredictor()
    t0 = 1_800_000_000.0
    _away(p, "person.a", t0, 400.0)
    _away(p, "person.b", t0, 5.0)
    assert p.all_on_trip(["person.a", "person.b"], 100) is False
    assert p.all_on_trip([], 100) is False
    p.observe("person.b", False, t0 + 60, None)  # no GPS: not known to be on a trip
    assert p.all_on_trip(["person.a", "person.b"], 100) is False


def test_home_resets_distance():
    p = ArrivalPredictor()
    t0 = 1_800_000_000.0
    _away(p, "person.a", t0, 400.0)
    p.observe("person.a", True, t0 + 3600, 400.0)
    assert p.on_trip("person.a") is False
    assert p.summary("person.a", t0 + 3600)["distance_km"] == 0


def test_multi_day_trip_is_not_learned():
    p = ArrivalPredictor()
    t0 = 1_800_000_000.0
    p.observe("person.a", True, t0)
    p.observe("person.a", False, t0 + 60)
    p.observe("person.a", True, t0 + 60 + 3 * 86400)
    assert p.get_state() == {}
