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


def _setup(hass, *, preheat: bool, arrival_in_min: float | None, away_heat=None, preheat_minutes=60):
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
    }
    person = MagicMock()
    person.entity_id = "person.a"
    person.state = "not_home"
    person.attributes = {}
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
