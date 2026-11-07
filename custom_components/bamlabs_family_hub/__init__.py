"""BamLabs Family Hub: local family members and shared tasks."""
from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta
from calendar import monthrange
from homeassistant.util import dt as dt_util
from pathlib import Path
from uuid import uuid4
from urllib.parse import urlsplit

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


_TASK_REPEATS = ("none", "daily", "weekly", "biweekly", "monthly", "yearly")


def _next_task_due(task, today):
    """Find next future scheduled occurrence. Do not create backlog after missed weeks."""
    initial = date.fromisoformat(task["due"])
    anchor = date.fromisoformat(task.get("repeat_anchor") or task["due"])
    kind = task.get("repeat", "none")
    minimum = max(initial, today)
    if kind in ("daily", "weekly", "biweekly"):
        step = {"daily": 1, "weekly": 7, "biweekly": 14}[kind]
        intervals = (minimum - initial).days // step + 1
        return (initial + timedelta(days=intervals * step)).isoformat()
    if kind in ("monthly", "yearly"):
        def month_occurrence(offset):
            index = anchor.year * 12 + anchor.month - 1 + offset
            y, m0 = divmod(index, 12)
            m = m0 + 1
            return date(y, m, min(anchor.day, monthrange(y, m)[1]))
        if kind == "monthly":
            offset = (minimum.year - anchor.year) * 12 + minimum.month - anchor.month
            offset = max(0, offset)
            candidate = month_occurrence(offset)
            if candidate <= minimum:
                candidate = month_occurrence(offset + 1)
        else:
            offset = max(0, minimum.year - anchor.year)
            candidate = month_occurrence(offset * 12)
            if candidate <= minimum:
                candidate = month_occurrence((offset + 1) * 12)
        return candidate.isoformat()
    raise ValueError("Ungültige Wiederholung")


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
    state = {"members": data.get("members", []), "tasks": data.get("tasks", []), "events": data.get("events", []), "external_calendars": data.get("external_calendars", []), "calendar_members": data.get("calendar_members", {}), "child_users": data.get("child_users", {})}
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
            module_url=f"/{DOMAIN}_static/panel.js?v=0.3.8",
            require_admin=False,
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


def _child_member(hub, connection):
    """Return the member selected for this authenticated HA account, or None."""
    user = connection.user
    if not user or not user.is_active or user.is_admin:
        return None
    member_id = hub["state"].get("child_users", {}).get(user.id)
    return member_id if member_id in {m["id"] for m in hub["state"]["members"]} else None


def _visible_state(hub, connection):
    """Never give a child's account other people's tasks, events or calendar sources."""
    state = hub["state"]
    if _owner(connection):
        return {**state, "_role": "admin"}
    member_id = _child_member(hub, connection)
    if not member_id:
        return None
    return {"_role": "child", "_member_id": member_id,
            "members": [m for m in state["members"] if m["id"] == member_id],
            "tasks": [t for t in state["tasks"] if member_id in t.get("assignees", [])],
            "events": [e for e in state["events"] if member_id in e.get("members", [])],
            "external_calendars": [], "calendar_members": {}}


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/state"})
@websocket_api.async_response
async def ws_state(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if hub is None:
        connection.send_error(msg["id"], "not_ready", "Family Hub ist nicht eingerichtet")
        return
    result = _visible_state(hub, connection)
    if result is None:
        connection.send_error(msg["id"], "unauthorized", "Dein Benutzerkonto ist noch keinem Familienmitglied zugeordnet. Bitte frage deine Eltern.")
        return
    connection.send_result(msg["id"], result)


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
        for uid, mid in list(hub["state"].get("child_users", {}).items()):
            if mid == msg["member_id"]:
                hub["state"]["child_users"].pop(uid, None)
        for task in hub["state"]["tasks"]:
            task["assignees"] = [i for i in task.get("assignees", []) if i != msg["member_id"]]
        for event in hub["state"]["events"]:
            event["members"] = [i for i in event.get("members", []) if i != msg["member_id"]]
        hub["state"]["calendar_members"] = {k: v for k, v in hub["state"].get("calendar_members", {}).items() if v != msg["member_id"]}
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
    vol.Optional("repeat", default="none"): vol.In(_TASK_REPEATS),
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
        if msg["repeat"] != "none" and not due:
            raise ValueError("Wiederkehrende Aufgaben benötigen ein Fälligkeitsdatum")
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
        fields = {"title": title, "description": description, "due": due, "priority": msg["priority"], "assignees": assignees, "repeat": msg["repeat"], "repeat_anchor": due if msg["repeat"] != "none" else ""}
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
    if hub is None or (not _owner(connection) and not _child_member(hub, connection)):
        connection.send_error(msg["id"], "unauthorized", "Keine Berechtigung")
        return
    async with hub["lock"]:
        task = next((t for t in hub["state"]["tasks"] if t["id"] == msg["task_id"]), None)
        if task and not _owner(connection) and _child_member(hub, connection) not in task.get("assignees", []):
            connection.send_error(msg["id"], "unauthorized", "Das ist nicht deine Aufgabe")
            return
        if task is None:
            connection.send_error(msg["id"], "not_found", "Aufgabe nicht gefunden")
            return
        tasks = hub["state"]["tasks"]
        if task.get("done"):
            successor_id = task.get("next_task_id")
            successor = next((t for t in tasks if t["id"] == successor_id), None) if successor_id else None
            if successor and successor.get("done"):
                connection.send_error(msg["id"], "invalid_data", "Eine spätere Wiederholung wurde bereits erledigt. Diese alte Aufgabe kann nicht wieder geöffnet werden.")
                return
            if successor:
                tasks.remove(successor)
                task["repeat"] = task.pop("completed_repeat", "none")
                task.pop("next_task_id", None)
            task["done"] = False
        else:
            task["done"] = True
            kind = task.get("repeat", "none")
            if kind != "none":
                next_task = {k: task[k] for k in ("title", "description", "priority", "assignees", "repeat")}
                next_task["assignees"] = list(next_task["assignees"])
                next_task["repeat_anchor"] = task.get("repeat_anchor") or task["due"]
                next_task["due"] = _next_task_due(task, dt_util.now().date())
                next_task["id"] = uuid4().hex
                next_task["done"] = False
                next_task["series_id"] = task.get("series_id") or task["id"]
                task["next_task_id"] = next_task["id"]
                task["completed_repeat"] = kind
                task["repeat"] = "none"
                tasks.append(next_task)
        await hub["store"].async_save(hub["state"])
        connection.send_result(msg["id"], _visible_state(hub, connection))


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
        hub["state"]["calendar_members"] = {k: v for k, v in hub["state"].get("calendar_members", {}).items() if k in ids}
        await hub["store"].async_save(hub["state"])
        connection.send_result(msg["id"], hub["state"])


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/calendar_member_assign",
    vol.Required("entity_id"): str,
    vol.Required("member_id"): str,
})
@websocket_api.async_response
async def ws_calendar_member_assign(hass, connection, msg):
    """Associate an external calendar with a family member (display only)."""
    hub = hass.data.get(DOMAIN)
    if hub is None or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Administratoren")
        return
    calendar_id, member_id = msg["entity_id"], msg["member_id"]
    if calendar_id not in hub["state"].get("external_calendars", []):
        connection.send_error(msg["id"], "invalid_calendar", "Kalender ist nicht ausgewählt")
        return
    if member_id and member_id not in {m["id"] for m in hub["state"]["members"]}:
        connection.send_error(msg["id"], "invalid_member", "Familienmitglied nicht gefunden")
        return
    async with hub["lock"]:
        mappings = hub["state"].setdefault("calendar_members", {})
        if member_id:
            mappings[calendar_id] = member_id
        else:
            mappings.pop(calendar_id, None)
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


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/child_accounts"})
@websocket_api.async_response
async def ws_child_accounts(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if hub is None or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern/Administratoren")
        return
    users = await hass.auth.async_get_users()
    connection.send_result(msg["id"], {
        "users": [{"id": u.id, "name": u.name or "Benutzer", "active": u.is_active}
                  for u in users if u.is_active and not u.is_admin and not u.system_generated],
        "assignments": hub["state"].get("child_users", {})})


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/child_assign",
    vol.Required("member_id"): str,
    vol.Required("user_id"): str,
})
@websocket_api.async_response
async def ws_child_assign(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if hub is None or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern/Administratoren")
        return
    member_id, user_id = msg["member_id"], msg["user_id"]
    async with hub["lock"]:
        if member_id not in {m["id"] for m in hub["state"]["members"]}:
            connection.send_error(msg["id"], "invalid_data", "Unbekanntes Familienmitglied")
            return
        assignments = hub["state"].setdefault("child_users", {})
        if user_id:
            user = await hass.auth.async_get_user(user_id)
            if user is None or not user.is_active or user.is_admin or user.system_generated:
                connection.send_error(msg["id"], "invalid_data", "Bitte ein normales, aktives Home-Assistant-Konto auswählen")
                return
            # One Home Assistant account per child, one account cannot belong to multiple children.
            assignments.pop(user_id, None)
        for uid, mid in list(assignments.items()):
            if mid == member_id:
                assignments.pop(uid, None)
        if user_id:
            assignments[user_id] = member_id
        await hub["store"].async_save(hub["state"])
        connection.send_result(msg["id"], {"assignments": dict(assignments)})


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/child_qr",
    vol.Required("member_id"): str,
    vol.Required("url"): str,
})
@websocket_api.async_response
async def ws_child_qr(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if hub is None or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern/Administratoren")
        return
    if msg["member_id"] not in {m["id"] for m in hub["state"]["members"]}:
        connection.send_error(msg["id"], "invalid_data", "Unbekanntes Kind")
        return
    url = msg["url"]
    parts = urlsplit(url)
    if (len(url) > 500 or parts.scheme not in ("http", "https")
            or parts.path != f"/{PANEL_URL}" or not parts.hostname
            or parts.username or parts.password):
        connection.send_error(msg["id"], "invalid_data", "Ungültige Home-Assistant-Adresse")
        return
    # SVG QR is only a shortcut to the normal Home Assistant login. It never contains tokens.
    import qrcode
    from qrcode.image.svg import SvgPathImage
    qr = qrcode.make(url, image_factory=SvgPathImage, box_size=7, border=3)
    import base64
    connection.send_result(msg["id"], {"image": "data:image/svg+xml;base64," + base64.b64encode(qr.to_string()).decode("ascii")})


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/child_task_create",
    vol.Required("title"): str,
    vol.Optional("due", default=""): str,
})
@websocket_api.async_response
async def ws_child_task_create(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    member_id = _child_member(hub, connection) if hub else None
    if not member_id:
        connection.send_error(msg["id"], "unauthorized", "Kein Kinderzugang")
        return
    try:
        title, due = _text(msg["title"], 160), _optional_date(msg["due"])
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_data", str(err))
        return
    async with hub["lock"]:
        hub["state"]["tasks"].append({"id": uuid4().hex, "title": title, "description": "",
            "due": due, "priority": "normal", "assignees": [member_id], "done": False})
        await hub["store"].async_save(hub["state"])
        connection.send_result(msg["id"], _visible_state(hub, connection))


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/child_event_create",
    vol.Required("title"): str,
    vol.Required("start"): str,
    vol.Required("end"): str,
    vol.Required("all_day"): bool,
})
@websocket_api.async_response
async def ws_child_event_create(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    member_id = _child_member(hub, connection) if hub else None
    if not member_id:
        connection.send_error(msg["id"], "unauthorized", "Kein Kinderzugang")
        return
    try:
        title = _text(msg["title"], 160)
        start = _event_time(msg["start"], msg["all_day"])
        end = _event_time(msg["end"], msg["all_day"])
        if end < start:
            raise ValueError("Ende darf nicht vor dem Beginn liegen")
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_data", str(err))
        return
    async with hub["lock"]:
        hub["state"]["events"].append({"id": uuid4().hex, "title": title, "description": "",
            "start": start, "end": end, "all_day": msg["all_day"], "repeat": "none", "members": [member_id]})
        await hub["store"].async_save(hub["state"])
        connection.send_result(msg["id"], _visible_state(hub, connection))


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/version"})
@websocket_api.async_response
async def ws_version(hass, connection, msg):
    """Report installed backend version to help diagnose stale frontend caches."""
    from homeassistant.loader import async_get_integration
    integration = await async_get_integration(hass, DOMAIN)
    connection.send_result(msg["id"], {"backend_version": integration.version})


def _register_commands_once(hass: HomeAssistant) -> None:
    """Ensure all websocket commands are available to the configured panel."""
    hub_data = hass.data.setdefault(DOMAIN, {})
    if hub_data.get("commands_registered"):
        return
    for command in (
        ws_version, ws_state, ws_member_save, ws_member_delete,
        ws_task_save, ws_task_toggle, ws_task_delete,
        ws_event_save, ws_event_delete,
        ws_calendar_sources, ws_calendar_select, ws_calendar_member_assign, ws_calendar_events,
        ws_child_accounts, ws_child_assign, ws_child_qr,
        ws_child_task_create, ws_child_event_create,
    ):
        websocket_api.async_register_command(hass, command)
    hub_data["commands_registered"] = True


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Register commands during regular integration setup as well."""
    _register_commands_once(hass)
    return True
