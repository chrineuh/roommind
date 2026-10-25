"""Tests for the boiler release of a compressor group."""

from custom_components.roommind.managers.boiler_release import (
    REASON_COUNT,
    REASON_MAX_WAIT,
    REASON_MIN_OFF,
    REASON_MIN_RUN,
    REASON_NO_DEMAND,
    REASON_RUNNING,
    REASON_URGENT,
    REASON_WAITING,
    REASON_WEIGHTED,
    BoilerReleaseManager,
    ReleaseConfig,
    RoomHeatDemand,
    decide_release,
    room_weight,
)
from custom_components.roommind.managers.compressor_group_manager import CompressorGroupManager


def _d(area="a", power=1.0, deficit=0.5):
    return RoomHeatDemand(area_id=area, power=power, deficit=deficit)


def _cfg(**kw):
    return ReleaseConfig(entity_id="input_boolean.burner", **kw)


class TestDecideRelease:
    def test_no_demand_is_off(self):
        assert decide_release([], True, _cfg(), 3, 0) == (False, REASON_NO_DEMAND)

    def test_running_stays_on_while_any_room_heats(self):
        assert decide_release([_d(power=0.05)], True, _cfg(min_demand=3), 3, 0) == (True, REASON_RUNNING)

    def test_count_mode_waits_for_enough_rooms(self):
        cfg = _cfg(min_demand=2)
        assert decide_release([_d("a")], False, cfg, 3, 0) == (False, REASON_WAITING)
        assert decide_release([_d("a"), _d("b")], False, cfg, 3, 0) == (True, REASON_COUNT)

    def test_threshold_capped_at_member_rooms(self):
        assert decide_release([_d("a")], False, _cfg(min_demand=5), 1, 0) == (True, REASON_COUNT)

    def test_smart_ignores_many_tiny_demands(self):
        cfg = _cfg(min_demand=2, smart=True)
        tiny = [_d(str(i), power=0.1, deficit=0.1) for i in range(5)]
        assert decide_release(tiny, False, cfg, 5, 0) == (False, REASON_WAITING)

    def test_smart_weighted_demand_releases(self):
        cfg = _cfg(min_demand=2, smart=True)
        demands = [_d("a", power=1.0, deficit=0.5), _d("b", power=1.0, deficit=0.5)]
        assert decide_release(demands, False, cfg, 3, 0) == (True, REASON_WEIGHTED)

    def test_smart_urgent_room_releases_alone(self):
        cfg = _cfg(min_demand=3, smart=True, urgent_delta=1.5)
        assert decide_release([_d(power=0.2, deficit=2.0)], False, cfg, 3, 0) == (True, REASON_URGENT)

    def test_smart_max_wait_releases(self):
        cfg = _cfg(min_demand=3, smart=True, max_wait_seconds=600)
        assert decide_release([_d(power=0.2, deficit=0.2)], False, cfg, 3, 601) == (True, REASON_MAX_WAIT)

    def test_room_weight_uses_deficit(self):
        assert room_weight(_d(power=0.1, deficit=0.75), 1.5) == 0.5
        assert room_weight(_d(power=0.1, deficit=None), 1.5) == 0.1
        assert room_weight(_d(power=3.0, deficit=9.0), 1.5) == 1.0


class TestBoilerReleaseManager:
    def test_adopts_entity_state_on_first_cycle(self):
        mgr = BoilerReleaseManager()
        assert mgr.evaluate("g", _cfg(), [_d()], 1, True, 900, 300, now=0) is True
        assert mgr.get_state("g").reason == REASON_RUNNING

    def test_min_run_keeps_burner_on(self):
        mgr = BoilerReleaseManager()
        assert mgr.evaluate("g", _cfg(), [_d()], 1, False, 900, 300, now=0) is True
        mgr.confirm("g", True, now=0)
        assert mgr.evaluate("g", _cfg(), [], 1, True, 900, 300, now=100) is True
        assert mgr.get_state("g").reason == REASON_MIN_RUN
        assert mgr.evaluate("g", _cfg(), [], 1, True, 900, 300, now=901) is False

    def test_min_off_keeps_burner_off(self):
        mgr = BoilerReleaseManager()
        mgr.evaluate("g", _cfg(), [_d()], 1, True, 0, 300, now=0)
        mgr.confirm("g", True, now=0)
        assert mgr.evaluate("g", _cfg(), [], 1, True, 0, 300, now=10) is False
        mgr.confirm("g", False, now=10)
        assert mgr.evaluate("g", _cfg(), [_d()], 1, False, 0, 300, now=100) is False
        assert mgr.get_state("g").reason == REASON_MIN_OFF
        assert mgr.evaluate("g", _cfg(), [_d()], 1, False, 0, 300, now=311) is True

    def test_wait_timer_tracks_rooms_while_off(self):
        mgr = BoilerReleaseManager()
        cfg = _cfg(min_demand=3, smart=True, max_wait_seconds=600)
        small = [_d("a", power=0.2, deficit=0.2)]
        assert mgr.evaluate("g", cfg, small, 3, False, 0, 0, now=0) is False
        mgr.confirm("g", False, now=0)
        assert mgr.evaluate("g", cfg, small, 3, False, 0, 0, now=300) is False
        assert mgr.evaluate("g", cfg, small, 3, False, 0, 0, now=601) is True
        assert mgr.get_state("g").reason == REASON_MAX_WAIT
        mgr.confirm("g", True, now=601)
        assert mgr.get_state("g").waiting_since == {}

    def test_wait_timer_resets_when_room_stops_demanding(self):
        mgr = BoilerReleaseManager()
        cfg = _cfg(min_demand=3, smart=True, max_wait_seconds=600)
        small = [_d("a", power=0.2, deficit=0.2)]
        mgr.evaluate("g", cfg, small, 3, False, 0, 0, now=0)
        mgr.evaluate("g", cfg, [], 3, False, 0, 0, now=300)
        assert mgr.evaluate("g", cfg, small, 3, False, 0, 0, now=700) is False

    def test_prune_drops_removed_groups(self):
        mgr = BoilerReleaseManager()
        mgr.evaluate("g", _cfg(), [], 1, False, 0, 0, now=0)
        mgr.prune(set())
        assert mgr.get_state("g") is None


def test_group_config_loads_release_fields():
    mgr = CompressorGroupManager()
    mgr.load_groups(
        [
            {
                "id": "g1",
                "name": "Oil",
                "members": ["climate.trv1"],
                "min_run_minutes": 10,
                "min_off_minutes": 10,
                "release_entity": "input_boolean.burner",
                "release_min_demand": 2,
                "release_smart": True,
                "release_urgent_delta": 2.0,
                "release_max_wait_minutes": 30,
            }
        ]
    )
    g = mgr.get_groups()["g1"]
    assert g.release_entity == "input_boolean.burner"
    assert g.release_min_demand == 2
    assert g.release_smart is True
    assert g.release_urgent_delta == 2.0
    assert g.release_max_wait_seconds == 1800
