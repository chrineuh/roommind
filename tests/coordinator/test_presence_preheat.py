"""Away temperature and heating up before a learned arrival."""

from __future__ import annotations

import time
from unittest.mock import AsyncMock, MagicMock

import pytest

from .conftest import _create_coordinator, _make_store_mock, make_mock_states_get
from .test_master_device import _room_with_device

AREA = "living_room_abc12345"


@pytest.fixture(autouse=True)
def _midday(freezer):
    """Arrivals are predicted for later today; keep "now" away from midnight."""
    freezer.move_to("2026-11-04 19:00:00+00:00")


def _setup(
    hass,
    *,
    preheat: bool,
    arrival_in_min: float | None,
    away_heat=None,
    preheat_minutes=60,
    location: bool = False,
    offset_deg: float | None = None,
    gps_accuracy: float = 20,
    extra_settings: dict | None = None,
):
    room = _room_with_device(AREA, "climate.living_trv", presence_persons=["person.a"])
    if away_heat is not None:
        room["away_heat"] = away_heat
    store = _make_store_mock({AREA: room})
    history = {}
    if arrival_in_min is not None:
        arrival = time.time() + arrival_in_min * 60
        history = {"person.a": [arrival - w * 7 * 86400 for w in (1, 2, 3)]}
    store.get_settings.return_value = {
        "climate_control_active": True,
        "presence_enabled": True,
        "presence_persons": ["person.a"],
        "presence_preheat": preheat,
        "presence_preheat_minutes": preheat_minutes,
        "arrival_history": history,
        "presence_location": location,
        **(extra_settings or {}),
    }
    person = MagicMock()
    person.entity_id = "person.a"
    person.state = "not_home"
    person.attributes = {}
    hass.config.latitude = 48.137
    hass.config.longitude = 11.575
    if offset_deg is not None:
        # North of home by offset_deg (1° latitude ≈ 111 km)
        person.attributes = {
            "latitude": hass.config.latitude + offset_deg,
            "longitude": hass.config.longitude,
            "gps_accuracy": gps_accuracy,
        }
    base = make_mock_states_get(temp="16.0")
    hass.states.get = MagicMock(side_effect=lambda eid: person if eid == "person.a" else base(eid))
    hass.services.async_call = AsyncMock()
    hass.data = {"roommind": {"store": store}}
    return room


@pytest.mark.asyncio
async def test_away_heat_replaces_eco(hass, mock_config_entry):
    _setup(hass, preheat=False, arrival_in_min=None, away_heat=15.0)
    coordinator = _create_coordinator(hass, mock_config_entry)
    data = await coordinator._async_update_data()
    live = data["rooms"][AREA]
    assert live["presence_away"] is True
    assert live["heat_target"] == 15.0


@pytest.mark.asyncio
async def test_preheats_when_arrival_is_within_lead(hass, mock_config_entry):
    room = _setup(hass, preheat=True, arrival_in_min=30, away_heat=15.0)
    coordinator = _create_coordinator(hass, mock_config_entry)
    data = await coordinator._async_update_data()
    live = data["rooms"][AREA]
    assert live["predicted_arrival"] is not None
    assert live["presence_preheat_active"] is True
    assert live["presence_away"] is False
    assert live["heat_target"] == room.get("comfort_heat", room.get("comfort_temp"))


@pytest.mark.asyncio
async def test_waits_when_arrival_is_far(hass, mock_config_entry):
    _setup(hass, preheat=True, arrival_in_min=180, away_heat=15.0, preheat_minutes=60)
    coordinator = _create_coordinator(hass, mock_config_entry)
    data = await coordinator._async_update_data()
    live = data["rooms"][AREA]
    assert live["predicted_arrival"] is not None
    assert live["presence_preheat_active"] is False
    assert live["heat_target"] == 15.0


@pytest.mark.asyncio
async def test_preheat_off_ignores_history(hass, mock_config_entry):
    _setup(hass, preheat=False, arrival_in_min=30, away_heat=15.0)
    coordinator = _create_coordinator(hass, mock_config_entry)
    data = await coordinator._async_update_data()
    assert data["rooms"][AREA]["predicted_arrival"] is None
    assert data["rooms"][AREA]["heat_target"] == 15.0


@pytest.mark.asyncio
async def test_location_near_home_preheats_without_history(hass, mock_config_entry):
    _setup(hass, preheat=True, arrival_in_min=None, away_heat=15.0, location=True, offset_deg=0.005)
    coordinator = _create_coordinator(hass, mock_config_entry)
    data = await coordinator._async_update_data()
    live = data["rooms"][AREA]
    assert live["arrival_source"] == "location"
    assert live["presence_preheat_active"] is True
    assert live["heat_target"] != 15.0


@pytest.mark.asyncio
async def test_location_disabled_ignores_gps(hass, mock_config_entry):
    _setup(hass, preheat=True, arrival_in_min=None, away_heat=15.0, location=False, offset_deg=0.005)
    coordinator = _create_coordinator(hass, mock_config_entry)
    data = await coordinator._async_update_data()
    assert data["rooms"][AREA]["predicted_arrival"] is None
    assert data["rooms"][AREA]["heat_target"] == 15.0


@pytest.mark.asyncio
async def test_far_away_is_a_trip_with_vacation_temperature(hass, mock_config_entry):
    _setup(
        hass,
        preheat=True,
        arrival_in_min=30,  # usual arrival soon, but the person is 330 km away
        away_heat=15.0,
        location=True,
        offset_deg=3.0,
        extra_settings={"vacation_temp": 12.0, "presence_trip_km": 100},
    )
    coordinator = _create_coordinator(hass, mock_config_entry)
    data = await coordinator._async_update_data()
    live = data["rooms"][AREA]
    assert live["presence_trip"] is True
    assert live["predicted_arrival"] is None
    assert live["presence_preheat_active"] is False
    assert live["heat_target"] == 12.0


@pytest.mark.asyncio
async def test_trip_without_vacation_temperature_keeps_away(hass, mock_config_entry):
    _setup(hass, preheat=False, arrival_in_min=None, away_heat=15.0, location=True, offset_deg=3.0)
    coordinator = _create_coordinator(hass, mock_config_entry)
    data = await coordinator._async_update_data()
    live = data["rooms"][AREA]
    assert live["presence_trip"] is True
    assert live["heat_target"] == 15.0


@pytest.mark.asyncio
async def test_trip_vacation_can_be_turned_off(hass, mock_config_entry):
    _setup(
        hass,
        preheat=False,
        arrival_in_min=None,
        away_heat=15.0,
        location=True,
        offset_deg=3.0,
        extra_settings={"vacation_temp": 12.0, "presence_trip_vacation": False},
    )
    coordinator = _create_coordinator(hass, mock_config_entry)
    data = await coordinator._async_update_data()
    assert data["rooms"][AREA]["heat_target"] == 15.0


@pytest.mark.asyncio
async def test_coarse_gps_fix_is_ignored(hass, mock_config_entry):
    _setup(hass, preheat=False, arrival_in_min=None, away_heat=15.0, location=True, offset_deg=3.0, gps_accuracy=5000)
    coordinator = _create_coordinator(hass, mock_config_entry)
    data = await coordinator._async_update_data()
    assert data["rooms"][AREA]["presence_trip"] is False


@pytest.mark.asyncio
async def test_heading_home_from_far_is_tracked_over_cycles(hass, mock_config_entry, freezer):
    _setup(hass, preheat=True, arrival_in_min=None, away_heat=15.0, location=True, offset_deg=0.5)
    person = hass.states.get("person.a")
    coordinator = _create_coordinator(hass, mock_config_entry)
    await coordinator._async_update_data()
    # 10 minutes later 0.1° (~11 km) closer: ~67 km/h, ~44 km left → ~40 min
    freezer.tick(600)
    person.attributes = {**person.attributes, "latitude": hass.config.latitude + 0.4}
    data = await coordinator._async_update_data()
    live = data["rooms"][AREA]
    assert live["arrival_source"] == "location"
    assert 30 * 60 < live["predicted_arrival"] - time.time() < 50 * 60
    assert live["presence_preheat_active"] is True  # within the 60 min fallback lead


@pytest.mark.asyncio
async def test_arrival_summary_reports_distance(hass, mock_config_entry):
    _setup(hass, preheat=True, arrival_in_min=None, location=True, offset_deg=1.0)
    coordinator = _create_coordinator(hass, mock_config_entry)
    await coordinator._async_update_data()
    summary = coordinator.get_arrival_summary({"presence_persons": ["person.a"]})["person.a"]
    assert summary["home"] is False
    assert 105 < summary["distance_km"] < 116


@pytest.mark.asyncio
async def test_distance_uses_nearest_home_zone(hass, mock_config_entry):
    """A person's own home zone counts: 330 km from HA's home, but next to their second home."""
    _setup(
        hass,
        preheat=False,
        arrival_in_min=None,
        away_heat=15.0,
        location=True,
        offset_deg=3.0,
        extra_settings={"presence_home_zones": {"person.a": ["zone.cabin"]}, "vacation_temp": 12.0},
    )
    person = hass.states.get("person.a")
    cabin = MagicMock()
    cabin.state = "0"
    cabin.attributes = {
        "friendly_name": "Cabin",
        "latitude": person.attributes["latitude"] + 0.2,  # ~22 km from the person
        "longitude": person.attributes["longitude"],
    }
    base = hass.states.get.side_effect
    hass.states.get = MagicMock(side_effect=lambda eid: cabin if eid == "zone.cabin" else base(eid))
    coordinator = _create_coordinator(hass, mock_config_entry)
    data = await coordinator._async_update_data()
    assert data["rooms"][AREA]["presence_trip"] is False
    summary = coordinator.get_arrival_summary({"presence_persons": ["person.a"]})["person.a"]
    assert 20 < summary["distance_km"] < 25


@pytest.mark.asyncio
async def test_person_at_extra_home_zone_is_home(hass, mock_config_entry):
    _setup(
        hass,
        preheat=False,
        arrival_in_min=None,
        away_heat=15.0,
        extra_settings={"presence_home_zones": {"person.a": ["zone.garden"]}},
    )
    hass.states.get("person.a").state = "Garden"
    base = hass.states.get.side_effect
    garden = MagicMock()
    garden.state = "0"
    garden.attributes = {"friendly_name": "Garden"}
    hass.states.get = MagicMock(side_effect=lambda eid: garden if eid == "zone.garden" else base(eid))
    coordinator = _create_coordinator(hass, mock_config_entry)
    data = await coordinator._async_update_data()
    assert data["rooms"][AREA]["presence_away"] is False
