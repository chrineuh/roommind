"""Coordinator wiring of the boiler release (input_boolean/switch) of a compressor group."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from .conftest import _create_coordinator, _make_store_mock, make_mock_states_get
from .test_master_device import _room_with_device


def _release_state(state: str):
    st = MagicMock()
    st.state = state
    st.attributes = {}
    return st


def _setup(hass, temp: str, release_state: str, **group_extra):
    room = _room_with_device("living_room_abc12345", "climate.living_trv")
    store = _make_store_mock({"living_room_abc12345": room})
    store.get_settings.return_value = {
        "climate_control_active": True,
        "compressor_groups": [
            {
                "id": "g1",
                "name": "Oil",
                "members": ["climate.living_trv"],
                "release_entity": "input_boolean.burner",
                **group_extra,
            }
        ],
    }
    release = _release_state(release_state)
    base_get = make_mock_states_get(temp=temp)
    hass.states.get = MagicMock(side_effect=lambda eid: release if eid == "input_boolean.burner" else base_get(eid))
    hass.services.async_call = AsyncMock()
    hass.data = {"roommind": {"store": store}}


def _release_calls(hass):
    return [
        c.args[1]
        for c in hass.services.async_call.call_args_list
        if len(c.args) >= 3 and c.args[0] == "input_boolean" and c.args[2].get("entity_id") == "input_boolean.burner"
    ]


@pytest.mark.asyncio
async def test_release_turns_on_when_room_heats(hass, mock_config_entry):
    _setup(hass, temp="18.0", release_state="off")
    coordinator = _create_coordinator(hass, mock_config_entry)
    await coordinator._async_update_data()
    assert _release_calls(hass) == ["turn_on"]
    status = coordinator.get_release_status()["g1"]
    assert status["on"] is True
    assert status["demand_count"] == 1


@pytest.mark.asyncio
async def test_release_turns_off_when_no_room_heats(hass, mock_config_entry):
    _setup(hass, temp="23.0", release_state="on")
    coordinator = _create_coordinator(hass, mock_config_entry)
    await coordinator._async_update_data()
    assert _release_calls(hass) == ["turn_off"]


@pytest.mark.asyncio
async def test_release_waits_for_enough_rooms(hass, mock_config_entry):
    # Threshold capped at the group's room count (1), so the single room still releases.
    _setup(hass, temp="18.0", release_state="off", release_min_demand=3)
    coordinator = _create_coordinator(hass, mock_config_entry)
    await coordinator._async_update_data()
    assert _release_calls(hass) == ["turn_on"]


@pytest.mark.asyncio
async def test_release_unavailable_is_left_alone(hass, mock_config_entry):
    _setup(hass, temp="18.0", release_state="unavailable")
    coordinator = _create_coordinator(hass, mock_config_entry)
    await coordinator._async_update_data()
    assert _release_calls(hass) == []


@pytest.mark.asyncio
async def test_release_status_reports_boiler_temperature(hass, mock_config_entry):
    _setup(hass, temp="18.0", release_state="off", boiler_temp_sensor="sensor.boiler")
    base = hass.states.get.side_effect
    boiler = MagicMock()
    boiler.state = "52.5"
    boiler.attributes = {"unit_of_measurement": "°C"}
    hass.states.get = MagicMock(side_effect=lambda eid: boiler if eid == "sensor.boiler" else base(eid))
    coordinator = _create_coordinator(hass, mock_config_entry)
    await coordinator._async_update_data()
    status = coordinator.get_release_status()["g1"]
    assert status["boiler_temp"] == 52.5
    assert status["reason"] == "residual_heat"


def _onoff(state):
    st = MagicMock()
    st.state = state
    st.attributes = {}
    return st


@pytest.mark.asyncio
async def test_status_reports_burner_pump_dhw_and_creates_sensor(hass, mock_config_entry):
    _setup(
        hass,
        temp="18.0",
        release_state="off",
        burner_entity="binary_sensor.burner",
        pump_entity="switch.pump",
        dhw_entity="sensor.dhw_power",
    )
    base = hass.states.get.side_effect
    extra = {
        "binary_sensor.burner": _onoff("on"),
        "switch.pump": _onoff("off"),
        "sensor.dhw_power": _onoff("120"),
    }
    hass.states.get = MagicMock(side_effect=lambda eid: extra.get(eid) or base(eid))
    coordinator = _create_coordinator(hass, mock_config_entry)
    added = []
    coordinator.async_add_entities = added.extend
    await coordinator._async_update_data()
    status = coordinator.get_release_status()["g1"]
    assert (status["burner_on"], status["pump_on"], status["dhw_on"]) == (True, False, True)
    assert len(added) == 1
    sensor = added[0]
    assert sensor.group_id == "g1"
    assert sensor.native_value == status["weighted_demand"]
    assert sensor.extra_state_attributes["reason"] == status["reason"]
    # Created once
    await coordinator._async_update_data()
    assert len(added) == 1


@pytest.mark.asyncio
async def test_reset_boiler_learning(hass, mock_config_entry):
    _setup(hass, temp="18.0", release_state="off")
    coordinator = _create_coordinator(hass, mock_config_entry)
    coordinator._release_manager.load_thermal({"g1": {"heat_rate": 1.0, "cool_rate": 0.1}})
    coordinator.reset_boiler_learning("g1")
    assert coordinator._release_manager.get_thermal("g1") is None
    assert coordinator._release_manager.thermal_dirty is True
