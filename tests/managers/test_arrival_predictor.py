"""Tests for learning arrival times."""

from datetime import datetime, timedelta

from homeassistant.util import dt as dt_util

from custom_components.roommind.managers.arrival_predictor import MIN_AWAY_SECONDS, ArrivalPredictor


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
    got = dt_util.as_local(datetime.fromtimestamp(pred, tz=dt_util.UTC))
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
    got = dt_util.as_local(datetime.fromtimestamp(pred, tz=dt_util.UTC))
    assert (got.hour, got.minute) == (15, 30)

    p2 = ArrivalPredictor()
    p2.load_state(p.get_state())
    summary = p2.summary("person.a", _ts(monday, 8, 0))
    assert summary["arrivals"] == 3
    assert summary["typical"][0] == "17:00"
    p2.prune({"person.b"})
    assert "person.a" not in p2.get_state()
