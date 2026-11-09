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
from homeassistant.helpers.event import async_track_time_change
from homeassistant.components import persistent_notification
from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers import entity_registry as er

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
    state = {"members": data.get("members", []), "tasks": data.get("tasks", []), "events": data.get("events", []), "external_calendars": data.get("external_calendars", []), "calendar_members": data.get("calendar_members", {}), "child_users": data.get("child_users", {}), "rewards": data.get("rewards", []), "point_entries": data.get("point_entries", []), "reminder_settings": data.get("reminder_settings", {"enabled": False, "hour": 8, "include_overdue": True}), "reminder_last_sent": data.get("reminder_last_sent", ""), "push_settings": data.get("push_settings", {"enabled": False, "devices": {}}), "push_last_sent": data.get("push_last_sent", {}), "routines": data.get("routines", []), "routine_checks": data.get("routine_checks", [])}
    lock = asyncio.Lock()
    hub_data = hass.data.setdefault(DOMAIN, {})
    hub_data.update({"state": state, "store": store, "lock": lock})

    # Register websocket commands when the config entry loads, rather than
    # relying exclusively on async_setup. This also fixes updates where the
    # frontend loads the new calendar form but event_save is unknown.
    _register_commands_once(hass)

    # Scheduled reminder works when the Family Hub browser is closed.
    if not hub_data.get("reminder_unsubscribe"):
        async def _reminder_tick(now):
            await _send_task_reminder(hass, force=False)
            await _send_mobile_reminders(hass)
        def _schedule_tick(now):
            hass.async_create_task(_reminder_tick(now))
        hub_data["reminder_unsubscribe"] = async_track_time_change(
            hass, _schedule_tick, hour=list(range(24)), minute=list(range(0, 60, 5)), second=0
        )

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
            module_url=f"/{DOMAIN}_static/panel.js?v=0.3.20",
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
        unsubscribe = hub.pop("reminder_unsubscribe", None)
        if unsubscribe:
            unsubscribe()
        hub["panel_registered"] = False
    return True


def _child_member(hub, connection):
    """Return the member selected for this authenticated HA account, or None."""
    user = connection.user
    if not user or not user.is_active or user.is_admin:
        return None
    member_id = hub["state"].get("child_users", {}).get(user.id)
    return member_id if member_id in {m["id"] for m in hub["state"]["members"]} else None


def _done_members(task):
    """Legacy tasks marked done=True were completed for all assigned people."""
    assigned = task.get("assignees", [])
    if isinstance(task.get("done_members"), list):
        return set(task["done_members"]) & set(assigned)
    return set(assigned) if task.get("done") else set()


def _done_for(task, member_id):
    if not task.get("assignees"):
        return bool(task.get("done"))
    return member_id in _done_members(task)


def _all_done(task):
    assigned = task.get("assignees", [])
    return all(_done_for(task, mid) for mid in assigned) if assigned else bool(task.get("done"))


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
            "tasks": [{**t, "done": _done_for(t, member_id)} for t in state["tasks"] if member_id in t.get("assignees", [])],
            "events": [e for e in state["events"] if member_id in e.get("members", [])],
            "external_calendars": [], "calendar_members": {},
            "rewards": state.get("rewards", []),
            "point_entries": [e for e in state.get("point_entries", []) if e.get("member_id") == member_id],
            "routines": [r for r in state.get("routines", []) if member_id in r.get("member_ids", [])],
            "routine_checks": [c for c in state.get("routine_checks", []) if c.get("member_id") == member_id]}


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
            old_completed = _done_members(task)
            task["assignees"] = [i for i in task.get("assignees", []) if i != msg["member_id"]]
            task["done_members"] = [i for i in task["assignees"] if i in old_completed]
            task["done"] = _all_done(task)
        for event in hub["state"]["events"]:
            event["members"] = [i for i in event.get("members", []) if i != msg["member_id"]]
        hub["state"]["calendar_members"] = {k: v for k, v in hub["state"].get("calendar_members", {}).items() if v != msg["member_id"]}
        for routine in hub["state"].get("routines", []):
            routine["member_ids"] = [mid for mid in routine.get("member_ids", []) if mid != msg["member_id"]]
        hub["state"]["routine_checks"] = [c for c in hub["state"].get("routine_checks", []) if c.get("member_id") != msg["member_id"]]
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
    vol.Optional("points", default=0): vol.All(vol.Coerce(int), vol.Range(min=0, max=100)),
    vol.Optional("icon", default="✅"): str,
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
        icon = _routine_icon(msg.get("icon", "✅"))
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
        fields = {"title": title, "description": description, "due": due, "priority": msg["priority"], "assignees": assignees, "repeat": msg["repeat"], "repeat_anchor": due if msg["repeat"] != "none" else "", "points": msg["points"], "icon": icon}
        if task:
            old_done = _done_members(task)
            task.update(fields)
            task["done_members"] = [mid for mid in assignees if mid in old_done]
            task["done"] = _all_done(task)
        else:
            tasks.append({"id": uuid4().hex, **fields, "done": False, "done_members": []})
        await hub["store"].async_save(hub["state"])
        connection.send_result(msg["id"], hub["state"])


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/task_toggle",
    vol.Required("task_id"): str,
    vol.Optional("member_id", default=""): str,
})
@websocket_api.async_response
async def ws_task_toggle(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if hub is None or (not _owner(connection) and not _child_member(hub, connection)):
        connection.send_error(msg["id"], "unauthorized", "Keine Berechtigung")
        return
    async with hub["lock"]:
        tasks = hub["state"]["tasks"]
        task = next((t for t in tasks if t["id"] == msg["task_id"]), None)
        if task is None:
            connection.send_error(msg["id"], "not_found", "Aufgabe nicht gefunden")
            return
        assignees = task.get("assignees", [])
        if _owner(connection):
            member_id = msg.get("member_id") or (assignees[0] if len(assignees) == 1 else "")
            if assignees and member_id not in assignees:
                connection.send_error(msg["id"], "invalid_data", "Bitte die Person auswählen, die die Aufgabe erledigt hat")
                return
        else:
            member_id = _child_member(hub, connection)
            if member_id not in assignees:
                connection.send_error(msg["id"], "unauthorized", "Das ist nicht deine Aufgabe")
                return

        current = _done_for(task, member_id) if assignees else bool(task.get("done"))
        if current:
            # Never remove a generated next task if someone already worked on it.
            successor_id = task.get("next_task_id")
            successor = next((t for t in tasks if t["id"] == successor_id), None) if successor_id else None
            if successor and (successor.get("done") or _done_members(successor)):
                connection.send_error(msg["id"], "invalid_data", "Die nächste Wiederholung wurde schon begonnen; bitte zuerst diese Aufgabe prüfen")
                return
            awards = [e for e in hub["state"]["point_entries"] if e.get("task_id") == task["id"]
                      and e.get("kind") == "earned" and (not assignees or e.get("member_id") == member_id)]
            for award in awards:
                balance = sum(e["amount"] for e in hub["state"]["point_entries"] if e["member_id"] == award["member_id"])
                if balance < award["amount"]:
                    connection.send_error(msg["id"], "invalid_data", "Punkte wurden bereits eingelöst. Bitte zuerst mit den Eltern klären.")
                    return
            remove_ids = {e["id"] for e in awards}
            hub["state"]["point_entries"] = [e for e in hub["state"]["point_entries"] if e["id"] not in remove_ids]
            if assignees:
                task["done_members"] = [mid for mid in assignees if mid in _done_members(task) and mid != member_id]
            else:
                task["done"] = False
            if successor:
                tasks.remove(successor)
                task["repeat"] = task.pop("completed_repeat", "none")
                task.pop("next_task_id", None)
        else:
            if assignees:
                task["done_members"] = [mid for mid in assignees if mid in (_done_members(task) | {member_id})]
            else:
                task["done"] = True
            awarded_people = [member_id] if assignees else []
            if task.get("points", 0) > 0:
                for person in awarded_people:
                    if not any(e.get("task_id") == task["id"] and e.get("member_id") == person and e.get("kind") == "earned"
                               for e in hub["state"]["point_entries"]):
                        hub["state"]["point_entries"].append({"id": uuid4().hex, "kind": "earned", "task_id": task["id"],
                            "member_id": person, "amount": task["points"], "label": task["title"],
                            "at": dt_util.now().isoformat()})
            if _all_done(task):
                kind = task.get("repeat", "none")
                if kind != "none" and not task.get("next_task_id"):
                    next_task = {k: task[k] for k in ("title", "description", "priority", "assignees", "repeat", "points")}
                    next_task["assignees"] = list(next_task["assignees"])
                    next_task["icon"] = task.get("icon", "✅")
                    next_task["repeat_anchor"] = task.get("repeat_anchor") or task["due"]
                    next_task["due"] = _next_task_due(task, dt_util.now().date())
                    next_task["id"] = uuid4().hex
                    next_task["done"] = False
                    next_task["done_members"] = []
                    next_task["series_id"] = task.get("series_id") or task["id"]
                    task["next_task_id"] = next_task["id"]
                    task["completed_repeat"] = kind
                    task["repeat"] = "none"
                    tasks.append(next_task)
        task["done"] = _all_done(task)
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




@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/reward_save",
    vol.Optional("reward_id", default=""): str,
    vol.Required("title"): str,
    vol.Required("cost"): vol.All(vol.Coerce(int), vol.Range(min=1, max=10000)),
})
@websocket_api.async_response
async def ws_reward_save(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if hub is None or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern können Belohnungen ändern")
        return
    try:
        title = _text(msg["title"], 90)
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_data", str(err))
        return
    async with hub["lock"]:
        rewards = hub["state"]["rewards"]
        existing = next((r for r in rewards if r["id"] == msg["reward_id"]), None)
        if msg["reward_id"] and existing is None:
            connection.send_error(msg["id"], "not_found", "Belohnung nicht gefunden")
            return
        if existing:
            existing.update({"title": title, "cost": msg["cost"]})
        else:
            rewards.append({"id": uuid4().hex, "title": title, "cost": msg["cost"]})
        await hub["store"].async_save(hub["state"])
        connection.send_result(msg["id"], _visible_state(hub, connection))


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/reward_delete",
    vol.Required("reward_id"): str,
})
@websocket_api.async_response
async def ws_reward_delete(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if hub is None or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Keine Berechtigung")
        return
    async with hub["lock"]:
        hub["state"]["rewards"] = [r for r in hub["state"]["rewards"] if r["id"] != msg["reward_id"]]
        await hub["store"].async_save(hub["state"])
        connection.send_result(msg["id"], _visible_state(hub, connection))


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/reward_redeem",
    vol.Required("reward_id"): str,
    vol.Required("member_id"): str,
})
@websocket_api.async_response
async def ws_reward_redeem(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if hub is None or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern können Punkte einlösen")
        return
    async with hub["lock"]:
        reward = next((r for r in hub["state"]["rewards"] if r["id"] == msg["reward_id"]), None)
        member = next((m for m in hub["state"]["members"] if m["id"] == msg["member_id"]), None)
        if not reward or not member:
            connection.send_error(msg["id"], "not_found", "Person oder Belohnung nicht gefunden")
            return
        balance = sum(e["amount"] for e in hub["state"]["point_entries"] if e["member_id"] == member["id"])
        if balance < reward["cost"]:
            connection.send_error(msg["id"], "invalid_data", "Noch nicht genügend Punkte gesammelt")
            return
        hub["state"]["point_entries"].append({"id": uuid4().hex, "kind": "redeemed", "member_id": member["id"],
            "amount": -reward["cost"], "label": reward["title"], "at": dt_util.now().isoformat()})
        await hub["store"].async_save(hub["state"])
        connection.send_result(msg["id"], _visible_state(hub, connection))


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


async def _send_task_reminder(hass, force=False):
    """Create one HA notification per configured day; no child data exposed via WS."""
    hub = hass.data.get(DOMAIN)
    if not hub or "state" not in hub:
        return {"sent": False, "reason": "not_ready"}
    async with hub["lock"]:
        state = hub["state"]
        settings = state.get("reminder_settings", {})
        now = dt_util.now()
        today = now.date().isoformat()
        if not force:
            if not settings.get("enabled", False) or now.hour != int(settings.get("hour", 8)):
                return {"sent": False, "reason": "disabled_or_not_due"}
            if state.get("reminder_last_sent") == today:
                return {"sent": False, "reason": "already_sent"}
        pending = [task for task in state.get("tasks", []) if not task.get("done") and task.get("due")
                   and (task["due"] == today or (settings.get("include_overdue", True) and task["due"] < today))]
        if not pending and not force:
            return {"sent": False, "reason": "no_tasks"}
        member_names = {member["id"]: member.get("name", "Familienmitglied") for member in state.get("members", [])}
        lines = []
        for task in sorted(pending, key=lambda item: item["due"])[:20]:
            assigned = ", ".join(member_names.get(mid, "Familienmitglied") for mid in task.get("assignees", []) if not _done_for(task, mid)) or "Nicht zugeordnet"
            tag = "Überfällig" if task["due"] < today else "Heute"
            lines.append(f"- **{tag}:** {task.get('title', 'Aufgabe')[:160]} ({assigned})")
        if len(pending) > 20:
            lines.append(f"- … und {len(pending)-20} weitere Aufgaben")
        if force:
            # A genuine test notification is created even when no tasks are due.
            # Keep it separate from the regular daily reminder.
            if not lines:
                lines = ["✅ Der Benachrichtigungstest war erfolgreich.",
                         "Heute sind keine offenen Aufgaben fällig oder überfällig."]
            else:
                lines.insert(0, "✅ Der Benachrichtigungstest war erfolgreich.")
            title = "Family Hub – Test-Erinnerung"
            notification_id = f"{DOMAIN}_reminder_test"
        else:
            title = "Family Hub – Aufgabenerinnerung"
            notification_id = f"{DOMAIN}_task_reminder"
        persistent_notification.async_create(hass, "\n".join(lines), title=title,
                                             notification_id=notification_id)
        if not force:
            state["reminder_last_sent"] = today
            await hub["store"].async_save(state)
        return {"sent": True, "count": len(pending)}


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/reminder_settings_save",
    vol.Required("enabled"): bool,
    vol.Required("hour"): vol.In([8, 12, 18]),
    vol.Required("include_overdue"): bool,
})
@websocket_api.async_response
async def ws_reminder_settings_save(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Administratoren")
        return
    async with hub["lock"]:
        hub["state"]["reminder_settings"] = {"enabled": msg["enabled"], "hour": msg["hour"], "include_overdue": msg["include_overdue"]}
        await hub["store"].async_save(hub["state"])
    connection.send_result(msg["id"], _visible_state(hub, connection))


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/reminder_test"})
@websocket_api.async_response
async def ws_reminder_test(hass, connection, msg):
    if not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Administratoren")
        return
    result = await _send_task_reminder(hass, force=True)
    connection.send_result(msg["id"], result)


def _mobile_targets(hass):
    """Find legacy mobile-app actions and newer mobile-app notification entities."""
    targets = [
        {"id": name, "name": name.removeprefix("mobile_app_").replace("_", " ") + " (App)", "kind": "service"}
        for name in sorted(hass.services.async_services().get("notify", {}))
        if name.startswith("mobile_app_")
    ]
    registry = er.async_get(hass)
    for entry in registry.entities.values():
        if entry.domain == "notify" and entry.platform == "mobile_app" and not entry.disabled_by:
            targets.append({"id": "entity:" + entry.entity_id,
                            "name": (entry.original_name or entry.entity_id) + " (Benachrichtigungsgerät)",
                            "kind": "entity"})
    return targets


def _mobile_services(hass):
    return {target["id"] for target in _mobile_targets(hass)}


async def _send_mobile_reminders(hass, *, test_member=None, test_target=None):
    """Send a daily private digest to the configured mobile device for each member."""
    hub = hass.data.get(DOMAIN)
    if not hub or "state" not in hub:
        return {"sent": 0, "reason": "not_ready"}
    available = set(_mobile_services(hass))
    now = dt_util.now()
    today = now.date().isoformat()
    async with hub["lock"]:
        state = hub["state"]
        settings = state.get("push_settings", {})
        if test_member is None and not settings.get("enabled", False):
            return {"sent": 0, "reason": "disabled"}
        reminder = state.get("reminder_settings", {})
        devices = dict(settings.get("devices", {}))
        last = dict(state.get("push_last_sent", {}))
        members = list(state.get("members", []))
        tasks = list(state.get("tasks", []))
        include_overdue = reminder.get("include_overdue", True)
        member_hours = dict(settings.get("hours", {}))
        member_overdue = dict(settings.get("include_overdue", {}))
    sent = 0
    errors = []
    for member in members:
        mid = member["id"]
        if test_member is not None and mid != test_member:
            continue
        service = test_target if test_member == mid and test_target else devices.get(mid, "")
        if not service or service not in available:
            if test_member == mid:
                errors.append("Kein verfügbares Handy für dieses Familienmitglied ausgewählt")
            continue
        if test_member is None and last.get(mid) == today:
            continue
        if test_member is None and now.hour < int(member_hours.get(mid, reminder.get("hour", 8))):
            continue
        allow_overdue = member_overdue.get(mid, include_overdue) is not False
        pending = [task for task in tasks if not _done_for(task, mid) and mid in task.get("assignees", [])
                   and task.get("due") and (task["due"] == today or (allow_overdue and task["due"] < today))]
        if not pending and test_member is None:
            continue
        if test_member is not None:
            message = f"Hallo {member['name']}! ✅ Die Handy-Testnachricht vom Family Hub funktioniert."
        else:
            names = [t.get("title", "Aufgabe")[:70] for t in sorted(pending, key=lambda t: t["due"])[:5]]
            message = f"Hallo {member['name']}! Du hast {len(pending)} offene Aufgaben für heute oder früher: " + "; ".join(names)
            if len(pending) > 5:
                message += f" (+{len(pending)-5} weitere)"
        try:
            if service.startswith("entity:"):
                await hass.services.async_call("notify", "send_message",
                    {"title": "BamLabs Family Hub", "message": message},
                    target={"entity_id": service.removeprefix("entity:")}, blocking=True)
            else:
                # The mobile companion app recognizes both iOS url and Android clickAction.
                # Point to the existing HA panel, not an unauthenticated external address.
                await hass.services.async_call("notify", service,
                    {"title": "BamLabs Family Hub", "message": message,
                     "data": {"url": "/" + PANEL_URL, "clickAction": "/" + PANEL_URL}}, blocking=True)
        except Exception as err:
            errors.append(f"{member['name']}: {err}")
            continue
        sent += 1
        if test_member is None:
            async with hub["lock"]:
                hub["state"].setdefault("push_last_sent", {})[mid] = today
                await hub["store"].async_save(hub["state"])
    return {"sent": sent, "errors": errors[:5]}


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/push_diagnose"})
@websocket_api.async_response
async def ws_push_diagnose(hass, connection, msg):
    """Explain whether the automatic push reminder can currently run."""
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Administratoren")
        return
    now = dt_util.now()
    today = now.date().isoformat()
    async with hub["lock"]:
        state = hub["state"]
        push = state.get("push_settings", {})
        reminder = state.get("reminder_settings", {})
        members = list(state.get("members", []))
        tasks = list(state.get("tasks", []))
        last = dict(state.get("push_last_sent", {}))
        devices = dict(push.get("devices", {}))
        hours = dict(push.get("hours", {}))
        per_member_overdue = dict(push.get("include_overdue", {}))
        enabled = bool(push.get("enabled", False))
    available = _mobile_services(hass)
    results = []
    for member in members:
        mid = member["id"]
        hour = int(hours.get(mid, reminder.get("hour", 8)))
        overdue = per_member_overdue.get(mid, reminder.get("include_overdue", True)) is not False
        due_count = sum(1 for task in tasks if not _done_for(task, mid) and mid in task.get("assignees", [])
                        and task.get("due") and (task["due"] == today or (overdue and task["due"] < today)))
        dev = devices.get(mid, "")
        sent_today = last.get(mid) == today
        if not enabled:
            reason = "Automatische Handy-Erinnerungen sind ausgeschaltet. Bitte aktivieren und speichern."
        elif not dev:
            reason = "Kein Handy zugeordnet. Bitte Gerät auswählen und Zuordnung speichern."
        elif dev not in available:
            reason = "Das gespeicherte Handy ist nicht mehr in Home Assistant verfügbar. Handys neu suchen."
        elif sent_today:
            reason = "Heute wurde für diese Person bereits eine automatische Erinnerung versendet."
        elif not due_count:
            reason = "Keine offenen Aufgaben für heute oder früher gefunden (oder überfällige Aufgaben deaktiviert)."
        elif now.hour < hour:
            reason = "Geplante Erinnerungszeit ist heute noch nicht erreicht."
        else:
            reason = "Alle Bedingungen erfüllt. Die automatische Prüfung erfolgt alle fünf Minuten."
        results.append({"name": member.get("name", "Person"), "hour": hour, "due": due_count,
                        "enabled": enabled, "device": bool(dev), "sent_today": sent_today,
                        "reason": reason})
    connection.send_result(msg["id"], {"local_time": now.strftime("%d.%m.%Y %H:%M"), "members": results})


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/push_devices"})
@websocket_api.async_response
async def ws_push_devices(hass, connection, msg):
    if not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Administratoren")
        return
    connection.send_result(msg["id"], _mobile_targets(hass))


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/push_settings_save",
    vol.Required("enabled"): bool,
    vol.Required("devices"): dict,
    vol.Optional("hours", default={}): dict,
    vol.Optional("include_overdue", default={}): dict,
})
@websocket_api.async_response
async def ws_push_settings_save(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Administratoren")
        return
    available = set(_mobile_services(hass))
    async with hub["lock"]:
        members = {m["id"] for m in hub["state"]["members"]}
        incoming = msg["devices"]
        if len(incoming) > 50 or any(not isinstance(k, str) or k not in members or
                not isinstance(v, str) or (v and v not in available) for k, v in incoming.items()):
            connection.send_error(msg["id"], "invalid_devices", "Ungültige Handyzuordnung")
            return
        raw_hours = msg.get("hours", {})
        raw_overdue = msg.get("include_overdue", {})
        if (len(raw_hours) > 50 or len(raw_overdue) > 50 or
            any(k not in members or type(v) is not int or v < 0 or v > 23
                for k, v in raw_hours.items()) or
            any(k not in members or type(v) is not bool for k, v in raw_overdue.items())):
            connection.send_error(msg["id"], "invalid_settings", "Ungültige Erinnerungszeiten")
            return
        hub["state"]["push_settings"] = {
            "enabled": msg["enabled"],
            "devices": {k: v for k, v in incoming.items() if v},
            "hours": dict(raw_hours), "include_overdue": dict(raw_overdue),
        }
        await hub["store"].async_save(hub["state"])
    connection.send_result(msg["id"], _visible_state(hub, connection))


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/push_test", vol.Required("member_id"): str, vol.Optional("device", default=""): str})
@websocket_api.async_response
async def ws_push_test(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Administratoren")
        return
    if msg["member_id"] not in {m["id"] for m in hub["state"]["members"]}:
        connection.send_error(msg["id"], "not_found", "Familienmitglied nicht gefunden")
        return
    device = msg.get("device", "")
    if device and device not in _mobile_services(hass):
        connection.send_error(msg["id"], "invalid_device", "Das ausgewählte Handy ist nicht mehr verfügbar. Bitte Geräte neu suchen.")
        return
    connection.send_result(msg["id"], await _send_mobile_reminders(
        hass, test_member=msg["member_id"], test_target=device or None))


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/version"})
@websocket_api.async_response
async def ws_version(hass, connection, msg):
    """Report installed backend version to help diagnose stale frontend caches."""
    from homeassistant.loader import async_get_integration
    integration = await async_get_integration(hass, DOMAIN)
    connection.send_result(msg["id"], {"backend_version": integration.version})



# Routines are independent from task rewards: completing a routine never credits points.
_ROUTINE_ICONS = {"🌞", "🌙", "🪥", "👕", "🥣", "🎒", "🛏️", "🧸", "📚", "🧼", "🍽️", "🐶", "⭐", "💧", "🧹", "🚿", "🚲", "🎨", "🌈", "✅", "🏠", "🎵"}


def _routine_icon(value):
    if value not in _ROUTINE_ICONS:
        raise ValueError("Bitte ein Symbol aus der Liste wählen")
    return value


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/routine_save",
    vol.Optional("routine_id", default=""): str,
    vol.Required("title"): str,
    vol.Required("icon"): str,
    vol.Required("days"): [vol.All(vol.Coerce(int), vol.Range(min=0, max=6))],
    vol.Required("member_ids"): [str],
    vol.Required("steps"): [dict],
})
@websocket_api.async_response
async def ws_routine_save(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern können Routinen bearbeiten")
        return
    try:
        title = _text(msg["title"], 70)
        icon = _routine_icon(msg["icon"])
        days = sorted(set(msg["days"]))
        people = list(dict.fromkeys(msg["member_ids"]))
        if not days or not people or len(people) > 30:
            raise ValueError("Mindestens einen Wochentag und eine Person wählen")
        steps = []
        if not 1 <= len(msg["steps"]) <= 12:
            raise ValueError("Bitte 1 bis 12 Schritte anlegen")
        for raw in msg["steps"]:
            if not isinstance(raw, dict):
                raise ValueError("Ungültiger Schritt")
            steps.append({"id": str(raw.get("id") or uuid4().hex)[:40],
                          "title": _text(raw.get("title", ""), 65),
                          "icon": _routine_icon(raw.get("icon", "✅"))})
        if len({v["id"] for v in steps}) != len(steps):
            raise ValueError("Doppelte Schrittkennungen")
    except (ValueError, TypeError) as err:
        connection.send_error(msg["id"], "invalid_data", str(err))
        return
    async with hub["lock"]:
        state = hub["state"]
        existing_members = {m["id"] for m in state["members"]}
        if any(mid not in existing_members for mid in people):
            connection.send_error(msg["id"], "invalid_data", "Unbekanntes Familienmitglied")
            return
        routines = state["routines"]
        item = next((r for r in routines if r["id"] == msg["routine_id"]), None) if msg["routine_id"] else None
        if msg["routine_id"] and item is None:
            connection.send_error(msg["id"], "not_found", "Routine nicht gefunden")
            return
        payload = {"title": title, "icon": icon, "days": days, "member_ids": people, "steps": steps}
        if item:
            item.update(payload)
            # Retain valid check marks for unchanged steps/people.
            valid_steps = {step["id"] for step in steps}
            state["routine_checks"] = [c for c in state["routine_checks"] if c["routine_id"] != item["id"] or
                                        (c["member_id"] in people and c["step_id"] in valid_steps)]
        else:
            routines.append({"id": uuid4().hex, **payload})
        await hub["store"].async_save(state)
    connection.send_result(msg["id"], _visible_state(hub, connection))


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/routine_delete", vol.Required("routine_id"): str})
@websocket_api.async_response
async def ws_routine_delete(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern")
        return
    async with hub["lock"]:
        state = hub["state"]
        if not any(r["id"] == msg["routine_id"] for r in state["routines"]):
            connection.send_error(msg["id"], "not_found", "Routine nicht gefunden")
            return
        state["routines"] = [r for r in state["routines"] if r["id"] != msg["routine_id"]]
        state["routine_checks"] = [c for c in state["routine_checks"] if c["routine_id"] != msg["routine_id"]]
        await hub["store"].async_save(state)
    connection.send_result(msg["id"], _visible_state(hub, connection))


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/routine_toggle",
    vol.Required("routine_id"): str,
    vol.Required("step_id"): str,
    vol.Optional("member_id", default=""): str,
})
@websocket_api.async_response
async def ws_routine_toggle(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub:
        connection.send_error(msg["id"], "not_ready", "Family Hub nicht bereit")
        return
    is_admin = _owner(connection)
    child_id = _child_member(hub, connection) if not is_admin else None
    if not is_admin and not child_id:
        connection.send_error(msg["id"], "unauthorized", "Kein Zugriff")
        return
    async with hub["lock"]:
        state = hub["state"]
        routine = next((r for r in state["routines"] if r["id"] == msg["routine_id"]), None)
        mid = msg["member_id"] if is_admin else child_id
        if not routine or mid not in routine["member_ids"] or msg["step_id"] not in {s["id"] for s in routine["steps"]}:
            connection.send_error(msg["id"], "invalid_data", "Schritt oder Person nicht zugeordnet")
            return
        today = dt_util.now().date()
        if today.weekday() not in routine["days"]:
            connection.send_error(msg["id"], "invalid_data", "Diese Routine ist heute nicht geplant")
            return
        key = (routine["id"], mid, msg["step_id"], today.isoformat())
        logs = state["routine_checks"]
        found = next((c for c in logs if (c["routine_id"],c["member_id"],c["step_id"],c["date"]) == key), None)
        if found:
            logs.remove(found)
        else:
            logs.append({"routine_id": key[0], "member_id": key[1], "step_id": key[2], "date": key[3]})
        cutoff = (today - timedelta(days=90)).isoformat()
        state["routine_checks"] = [c for c in logs if c.get("date", "") >= cutoff]
        await hub["store"].async_save(state)
    connection.send_result(msg["id"], _visible_state(hub, connection))

def _register_commands_once(hass: HomeAssistant) -> None:
    """Ensure all websocket commands are available to the configured panel."""
    hub_data = hass.data.setdefault(DOMAIN, {})
    if hub_data.get("commands_registered"):
        return
    for command in (
        ws_version, ws_reminder_settings_save, ws_reminder_test, ws_push_diagnose, ws_push_devices, ws_push_settings_save, ws_push_test, ws_state, ws_member_save, ws_member_delete,
        ws_task_save, ws_task_toggle, ws_task_delete,
        ws_routine_save, ws_routine_delete, ws_routine_toggle,
        ws_reward_save, ws_reward_delete, ws_reward_redeem,
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
