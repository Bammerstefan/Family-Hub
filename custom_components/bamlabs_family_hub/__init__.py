"""BamLabs Family Hub: local family members and shared tasks."""
from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta
from homeassistant.util import dt as dt_util
from pathlib import Path
from uuid import uuid4

import voluptuous as vol
from homeassistant.components import panel_custom, websocket_api
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store
from homeassistant.config_entries import ConfigEntry

from .const import DOMAIN, PANEL_URL, STORAGE_KEY, STORAGE_VERSION, TITLE


def _text(value, maximum=180):
    """Safely normalize user-provided plain text."""
    if not isinstance(value, str):
        raise ValueError("Ungültiger Text")
    value = value.strip()
    if not value or len(value) > maximum:
        raise ValueError(f"Text muss 1 bis {maximum} Zeichen enthalten")
    return value


def _optional_date(value):
    if not value:
        return ""
    try:
        return date.fromisoformat(value).isoformat()
    except (TypeError, ValueError) as err:
        raise ValueError("Ungültiges Fälligkeitsdatum") from err


def _color(value):
    if not isinstance(value, str) or len(value) != 7 or value[0] != "#" or any(c not in "0123456789abcdefABCDEF" for c in value[1:]):
        raise ValueError("Ungültige Farbe")
    return value


def _owner(connection):
    # Restrict edits to Home Assistant administrators for MVP (shared family data).
    return connection.user is not None and connection.user.is_admin


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up a single Family Hub instance."""
    store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
    data = await store.async_load()
    if not isinstance(data, dict):
        data = {}
    state = {"members": data.get("members", []), "tasks": data.get("tasks", []), "events": data.get("events", []), "external_calendars": data.get("external_calendars", [])}
    lock = asyncio.Lock()
    hub_data = hass.data.setdefault(DOMAIN, {})
    hub_data.update({"state": state, "store": store, "lock": lock})

    # Register websocket commands when the config entry loads, rather than
    # relying exclusively on async_setup. This also fixes updates where the
    # frontend loads the new calendar form but event_save is unknown.
    _register_commands_once(hass)

    if not hub_data.get("panel_registered"):
        path = Path(__file__).parent / "frontend"
        await hass.http.async_register_static_paths([
            StaticPathConfig(f"/{DOMAIN}_static", str(path), cache_headers=False)
        ])
        await panel_custom.async_register_panel(
            hass,
            webcomponent_name="bamlabs-family-hub-panel",
            frontend_url_path=PANEL_URL,
            sidebar_title="Family Hub",
            sidebar_icon="mdi:home-heart",
            module_url=f"/{DOMAIN}_static/panel.js?v=0.3.0",
            require_admin=True,
        )
        hub_data["panel_registered"] = True

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload panel and retain local stored data."""
    from homeassistant.components.frontend import async_remove_panel
    async_remove_panel(hass, PANEL_URL, warn_if_unknown=True)
    hub = hass.data.get(DOMAIN)
    if hub is not None:
        hub.pop("state", None)
        hub.pop("store", None)
        hub.pop("lock", None)
        hub["panel_registered"] = False
    return True


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/state"})
@websocket_api.async_response
async def ws_state(hass, connection, msg):
    """Return the current family state."""
    hub = hass.data.get(DOMAIN)
    if hub is None:
        connection.send_error(msg["id"], "not_ready", "Family Hub ist nicht eingerichtet")
        return
    if not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Administratoren")
        return
    async with hub["lock"]:
        connection.send_result(msg["id"], hub["state"])


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/member_save",
    vol.Optional("member_id", default=""): str,
    vol.Required("name"): str,
    vol.Required("color"): str,
})
@websocket_api.async_response
async def ws_member_save(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if hub is None or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Keine Berechtigung")
        return
    try:
        name, color = _text(msg["name"], 60), _color(msg["color"])
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_data", str(err))
        return
    async with hub["lock"]:
        members = hub["state"]["members"]
        member = next((m for m in members if m["id"] == msg["member_id"]), None) if msg["member_id"] else None
        if msg["member_id"] and member is None:
            connection.send_error(msg["id"], "not_found", "Familienmitglied nicht gefunden")
            return
        if member:
            member.update(name=name, color=color)
        else:
            members.append({"id": uuid4().hex, "name": name, "color": color})
        await hub["store"].async_save(hub["state"])
        connection.send_result(msg["id"], hub["state"])


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/member_delete", vol.Required("member_id"): str})
@websocket_api.async_response
async def ws_member_delete(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if hub is None or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Keine Berechtigung")
        return
    async with hub["lock"]:
        before = len(hub["state"]["members"])
        hub["state"]["members"] = [m for m in hub["state"]["members"] if m["id"] != msg["member_id"]]
        if len(hub["state"]["members"]) == before:
            connection.send_error(msg["id"], "not_found", "Familienmitglied nicht gefunden")
            return
        for task in hub["state"]["tasks"]:
            task["assignees"] = [i for i in task.get("assignees", []) if i != msg["member_id"]]
        for event in hub["state"]["events"]:
            event["members"] = [i for i in event.get("members", []) if i != msg["member_id"]]
        await hub["store"].async_save(hub["state"])
        connection.send_result(msg["id"], hub["state"])


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/task_save",
    vol.Optional("task_id", default=""): str,
    vol.Required("title"): str,
    vol.Optional("description", default=""): str,
    vol.Optional("due", default=""): str,
    vol.Required("priority"): vol.In(["normal", "high", "low"]),
    vol.Required("assignees"): [str],
})
@websocket_api.async_response
async def ws_task_save(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if hub is None or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Keine Berechtigung")
        return
    try:
        title = _text(msg["title"], 160)
        description = msg["description"].strip()[:1500]
        due = _optional_date(msg["due"])
        assignees = list(dict.fromkeys(msg["assignees"]))
        if len(assignees) > 30:
            raise ValueError("Zu viele Personen")
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_data", str(err))
        return
    async with hub["lock"]:
        ids = {m["id"] for m in hub["state"]["members"]}
        if any(i not in ids for i in assignees):
            connection.send_error(msg["id"], "invalid_data", "Unbekanntes Familienmitglied")
            return
        tasks = hub["state"]["tasks"]
        task = next((t for t in tasks if t["id"] == msg["task_id"]), None) if msg["task_id"] else None
        if msg["task_id"] and task is None:
            connection.send_error(msg["id"], "not_found", "Aufgabe nicht gefunden")
            return
        fields = {"title": title, "description": description, "due": due, "priority": msg["priority"], "assignees": assignees}
        if task:
            task.update(fields)
        else:
            tasks.append({"id": uuid4().hex, **fields, "done": False})
        await hub["store"].async_save(hub["state"])
        connection.send_result(msg["id"], hub["state"])


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/task_toggle", vol.Required("task_id"): str})
@websocket_api.async_response
async def ws_task_toggle(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if hub is None or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Keine Berechtigung")
        return
    async with hub["lock"]:
        task = next((t for t in hub["state"]["tasks"] if t["id"] == msg["task_id"]), None)
        if task is None:
            connection.send_error(msg["id"], "not_found", "Aufgabe nicht gefunden")
            return
        task["done"] = not task.get("done", False)
        await hub["store"].async_save(hub["state"])
        connection.send_result(msg["id"], hub["state"])


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/task_delete", vol.Required("task_id"): str})
@websocket_api.async_response
async def ws_task_delete(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if hub is None or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Keine Berechtigung")
        return
    async with hub["lock"]:
        hub["state"]["tasks"] = [t for t in hub["state"]["tasks"] if t["id"] != msg["task_id"]]
        await hub["store"].async_save(hub["state"])
        connection.send_result(msg["id"], hub["state"])




def _event_time(value, all_day=False):
    """Validate ISO local times; all-day events use plain YYYY-MM-DD."""
    if not isinstance(value, str):
        raise ValueError("Ungültige Zeitangabe")
    try:
        if all_day:
            return date.fromisoformat(value).isoformat()
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is not None:
            raise ValueError("Lokale Uhrzeit ohne Zeitzone verwenden")
        if len(value) != 16 or value[10] != "T":
            raise ValueError("Datum und Uhrzeit fehlen")
        return parsed.isoformat(timespec="minutes")
    except (ValueError, TypeError) as err:
        raise ValueError("Ungültiges Datum oder ungültige Uhrzeit") from err


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/event_save",
    vol.Optional("event_id", default=""): str,
    vol.Required("title"): str,
    vol.Optional("description", default=""): str,
    vol.Required("start"): str,
    vol.Required("end"): str,
    vol.Required("all_day"): bool,
    vol.Required("repeat"): vol.In(["none", "daily", "weekly", "monthly", "yearly"]),
    vol.Required("members"): [str],
})
@websocket_api.async_response
async def ws_event_save(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if hub is None or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Keine Berechtigung")
        return
    try:
        title = _text(msg["title"], 160)
        description = msg["description"]
        if not isinstance(description, str) or len(description) > 1500:
            raise ValueError("Beschreibung zu lang")
        all_day = msg["all_day"]
        start = _event_time(msg["start"], all_day)
        end = _event_time(msg["end"], all_day)
        if end < start:
            raise ValueError("Das Enddatum darf nicht vor dem Start liegen")
        members = list(dict.fromkeys(msg["members"]))
        if len(members) > 30:
            raise ValueError("Zu viele Personen")
    except (ValueError, TypeError) as err:
        connection.send_error(msg["id"], "invalid_data", str(err))
        return
    async with hub["lock"]:
        member_ids = {m["id"] for m in hub["state"]["members"]}
        if any(m not in member_ids for m in members):
            connection.send_error(msg["id"], "invalid_data", "Unbekanntes Familienmitglied")
            return
        events = hub["state"]["events"]
        event = next((e for e in events if e["id"] == msg["event_id"]), None) if msg["event_id"] else None
        if msg["event_id"] and event is None:
            connection.send_error(msg["id"], "not_found", "Termin nicht gefunden")
            return
        fields = {"title": title, "description": description.strip(), "start": start,
                  "end": end, "all_day": all_day, "repeat": msg["repeat"], "members": members}
        if event:
            event.update(fields)
        else:
            events.append({"id": uuid4().hex, **fields})
        await hub["store"].async_save(hub["state"])
        connection.send_result(msg["id"], hub["state"])


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/event_delete", vol.Required("event_id"): str})
@websocket_api.async_response
async def ws_event_delete(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if hub is None or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Keine Berechtigung")
        return
    async with hub["lock"]:
        events = hub["state"]["events"]
        if not any(e["id"] == msg["event_id"] for e in events):
            connection.send_error(msg["id"], "not_found", "Termin nicht gefunden")
            return
        hub["state"]["events"] = [e for e in events if e["id"] != msg["event_id"]]
        await hub["store"].async_save(hub["state"])
        connection.send_result(msg["id"], hub["state"])


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/calendar_sources"})
@websocket_api.async_response
async def ws_calendar_sources(hass, connection, msg):
    """List readable HA calendar entities for Family Hub."""
    if not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Administratoren")
        return
    entities = [
        {"id": state.entity_id, "name": state.name or state.entity_id}
        for state in hass.states.async_all("calendar")
        if state.state not in ("unavailable", "unknown")
    ]
    connection.send_result(msg["id"], sorted(entities, key=lambda e: e["name"].lower()))


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/calendar_select",
    vol.Required("entity_ids"): [str],
})
@websocket_api.async_response
async def ws_calendar_select(hass, connection, msg):
    """Save selected external calendars without altering their events."""
    hub = hass.data.get(DOMAIN)
    if hub is None or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Keine Berechtigung")
        return
    ids = list(dict.fromkeys(msg["entity_ids"]))
    if len(ids) > 25 or any(not ent.startswith("calendar.") or hass.states.get(ent) is None for ent in ids):
        connection.send_error(msg["id"], "invalid_calendars", "Ungültige Kalenderauswahl")
        return
    async with hub["lock"]:
        hub["state"]["external_calendars"] = ids
        await hub["store"].async_save(hub["state"])
        connection.send_result(msg["id"], hub["state"])


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/calendar_events",
    vol.Required("start"): str,
    vol.Required("end"): str,
})
@websocket_api.async_response
async def ws_calendar_events(hass, connection, msg):
    """Fetch selected Home Assistant calendars read-only in a bounded window."""
    hub = hass.data.get(DOMAIN)
    if hub is None or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Keine Berechtigung")
        return
    try:
        start_date = date.fromisoformat(msg["start"])
        end_date = date.fromisoformat(msg["end"])
    except (TypeError, ValueError):
        connection.send_error(msg["id"], "invalid_date", "Ungültiger Kalenderzeitraum")
        return
    if end_date < start_date or (end_date - start_date).days > 62:
        connection.send_error(msg["id"], "invalid_range", "Maximal 63 Tage pro Abfrage")
        return
    selected = hub["state"].get("external_calendars", [])
    if not selected:
        connection.send_result(msg["id"], {"events": [], "warnings": []})
        return
    zone = dt_util.get_time_zone(hass.config.time_zone)
    start = datetime.combine(start_date, datetime.min.time(), tzinfo=zone)
    end = datetime.combine(end_date + timedelta(days=1), datetime.min.time(), tzinfo=zone)
    try:
        # Supported HA calendar service, returning expansion of recurring events.
        response = await hass.services.async_call(
            "calendar", "get_events",
            {"entity_id": selected, "start_date_time": start.isoformat(), "end_date_time": end.isoformat()},
            blocking=True, return_response=True,
        )
    except Exception as exc:
        connection.send_error(msg["id"], "calendar_unavailable", "Kalender konnten nicht geladen werden; Home-Assistant-Protokoll prüfen")
        return
    results = []
    for entity_id in selected:
        entries = (response or {}).get(entity_id, {}).get("events", [])
        for item in entries[:500]:
            start_val = item.get("start", "")
            end_val = item.get("end", "")
            if isinstance(start_val, (datetime, date)):
                start_val = start_val.isoformat()
            if isinstance(end_val, (datetime, date)):
                end_val = end_val.isoformat()
            if not isinstance(start_val, str) or not isinstance(end_val, str) or not start_val:
                continue
            results.append({
                "calendar": entity_id, "title": str(item.get("summary", "Termin"))[:180],
                "description": str(item.get("description", "") or "")[:1500],
                "start": start_val, "end": end_val,
                "all_day": len(start_val) == 10,
            })
    connection.send_result(msg["id"], {"events": results[:1000], "warnings": []})


def _register_commands_once(hass: HomeAssistant) -> None:
    """Ensure all websocket commands are available to the configured panel."""
    hub_data = hass.data.setdefault(DOMAIN, {})
    if hub_data.get("commands_registered"):
        return
    for command in (
        ws_state, ws_member_save, ws_member_delete,
        ws_task_save, ws_task_toggle, ws_task_delete,
        ws_event_save, ws_event_delete,
        ws_calendar_sources, ws_calendar_select, ws_calendar_events,
    ):
        websocket_api.async_register_command(hass, command)
    hub_data["commands_registered"] = True


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Register commands during regular integration setup as well."""
    _register_commands_once(hass)
    return True
