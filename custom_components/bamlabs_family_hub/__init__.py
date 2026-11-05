"""BamLabs Family Hub: local family members and shared tasks."""
from __future__ import annotations

import asyncio
from datetime import date
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
    state = {"members": data.get("members", []), "tasks": data.get("tasks", [])}
    lock = asyncio.Lock()
    hass.data[DOMAIN] = {"state": state, "store": store, "lock": lock}

    if not hass.data[DOMAIN].get("panel_registered"):
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
            module_url=f"/{DOMAIN}_static/panel.js?v=0.1.0",
            require_admin=True,
        )
        hass.data[DOMAIN]["panel_registered"] = True

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload panel and retain local stored data."""
    from homeassistant.components.frontend import async_remove_panel
    async_remove_panel(hass, PANEL_URL, warn_if_unknown=True)
    hass.data.pop(DOMAIN, None)
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


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Register commands once before config entry load."""
    for command in (ws_state, ws_member_save, ws_member_delete, ws_task_save, ws_task_toggle, ws_task_delete):
        websocket_api.async_register_command(hass, command)
    return True
