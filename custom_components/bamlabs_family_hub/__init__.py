"""BamLabs Family Hub: local family members and shared tasks."""
from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta
from calendar import monthrange
from homeassistant.util import dt as dt_util
from pathlib import Path
from uuid import uuid4
from urllib.parse import urlsplit, urlencode
import logging
from homeassistant.helpers.aiohttp_client import async_get_clientsession

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

_LOGGER = logging.getLogger(__name__)
# ISO 3166-2 codes used by OpenHolidays. Never send arbitrary user URLs.
HOLIDAY_REGIONS = {
    "AT": {"AT-1", "AT-2", "AT-3", "AT-4", "AT-5", "AT-6", "AT-7", "AT-8", "AT-9"},
    "DE": {"DE-BW", "DE-BY", "DE-BE", "DE-BB", "DE-HB", "DE-HH", "DE-HE", "DE-MV", "DE-NI", "DE-NW", "DE-RP", "DE-SL", "DE-SN", "DE-ST", "DE-SH", "DE-TH"},
}



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
    state = {"members": data.get("members", []), "tasks": data.get("tasks", []), "events": data.get("events", []), "external_calendars": data.get("external_calendars", []), "calendar_members": data.get("calendar_members", {}), "child_users": data.get("child_users", {}), "tablet_user_id": data.get("tablet_user_id", ""), "rewards": data.get("rewards", []), "point_entries": data.get("point_entries", []), "task_completions": data.get("task_completions", []), "reminder_settings": data.get("reminder_settings", {"enabled": False, "hour": 8, "include_overdue": True}), "reminder_last_sent": data.get("reminder_last_sent", ""), "push_settings": data.get("push_settings", {"enabled": False, "devices": {}}), "push_last_sent": data.get("push_last_sent", {}), "routines": data.get("routines", []), "routine_checks": data.get("routine_checks", []), "school_plan": data.get("school_plan", []), "school_years": data.get("school_years", []), "school_year_active": data.get("school_year_active", {}), "school_modes": data.get("school_modes", {}), "school_absences": data.get("school_absences", []), "school_holiday_settings": data.get("school_holiday_settings", {}), "school_holiday_cache": data.get("school_holiday_cache", {}), "school_pack_settings": data.get("school_pack_settings", {}), "school_pack_checks": data.get("school_pack_checks", []), "work_plan": data.get("work_plan", []), "work_exceptions": data.get("work_exceptions", []), "work_alert": data.get("work_alert", {"enabled": False, "minutes": 30}), "work_alert_sent": data.get("work_alert_sent", []), "family_lists": data.get("family_lists", []), "display_settings": data.get("display_settings", {"enabled": False, "photos": [], "rotate_seconds": 30}), "family_challenge": data.get("family_challenge", {"enabled": False, "goal": 30}), "family_reward_claims": data.get("family_reward_claims", []), "birthday_settings": data.get("birthday_settings", {"enabled": False, "days_before": 7, "hour": 8}), "birthday_last_sent": data.get("birthday_last_sent", ""), "notification_center": data.get("notification_center", {"quiet_enabled": False, "quiet_start": 21, "quiet_end": 7, "categories": {}}), "extra_alert_sent": data.get("extra_alert_sent", [])}
    lock = asyncio.Lock()
    hub_data = hass.data.setdefault(DOMAIN, {})
    hub_data.update({"state": state, "store": store, "lock": lock, "tablet_selection": {}, "hass": hass})

    # Register websocket commands when the config entry loads, rather than
    # relying exclusively on async_setup. This also fixes updates where the
    # frontend loads the new calendar form but event_save is unknown.
    _register_commands_once(hass)

    # Download the selected regional calendar without blocking Home Assistant startup.
    if any(c.get("enabled") for c in state["school_holiday_settings"].values() if isinstance(c, dict)):
        hass.async_create_task(_refresh_school_holidays(hass))

    # Scheduled reminder works when the Family Hub browser is closed.
    if not hub_data.get("reminder_unsubscribe"):
        async def _reminder_tick(now):
            await _send_task_reminder(hass, force=False)
            await _send_mobile_reminders(hass)
            await _send_work_alerts(hass)
            await _send_birthday_reminders(hass)
            await _send_extra_notifications(hass)
            if now.hour == 3 and now.minute < 5:
                await _refresh_school_holidays(hass)
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
            module_url=f"/{DOMAIN}_static/panel.js?v=0.3.47",
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
    if user.id == hub["state"].get("tablet_user_id"):
        member_id = hub.setdefault("tablet_selection", {}).get(user.id)
    else:
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


def _challenge_progress(state):
    """Aggregate task completions and checked routine steps in the local current week."""
    today = dt_util.now().date()
    start = (today - timedelta(days=today.weekday())).isoformat()
    finish = (today + timedelta(days=6-today.weekday())).isoformat()
    tasks = sum(1 for e in state.get("task_completions", []) if start <= e.get("date", "") <= finish)
    steps = sum(1 for e in state.get("routine_checks", []) if start <= e.get("date", "") <= finish)
    cfg = state.get("family_challenge", {})
    goal = cfg.get("goal", 30)
    goal = goal if isinstance(goal, int) and not isinstance(goal, bool) and 1 <= goal <= 500 else 30
    claims = state.get("family_reward_claims", [])
    claimed = any(e.get("week_start") == start for e in claims if isinstance(e, dict))
    reward_title = str(cfg.get("reward_title") or "").strip()[:100]
    reward_emoji = str(cfg.get("reward_emoji") or "🎁").strip()[:8] or "🎁"
    enabled = cfg.get("enabled") is True
    return {"enabled": enabled, "goal": goal,
            "tasks": tasks, "steps": steps, "count": tasks + steps,
            "week_start": start, "week_end": finish,
            "reward_title": reward_title if enabled else "",
            "reward_emoji": reward_emoji,
            "reward_unlocked": enabled and tasks + steps >= goal,
            "reward_claimed": claimed}


def _meal_planner_installed(hub):
    """Only show meal navigation when the separately installed integration is loaded."""
    hass = hub.get("hass")
    meal = hass.data.get("meal_planner") if hass else None
    return isinstance(meal, dict) and isinstance(meal.get("data"), dict)


def _visible_state(hub, connection):
    """Never give a child's account other people's tasks, events or calendar sources."""
    state = hub["state"]
    if _owner(connection):
        return {**state, "_meal_planner_available": _meal_planner_installed(hub), "_challenge_progress": _challenge_progress(state), "_role": "admin"}
    user = connection.user
    if user and user.is_active and user.id == state.get("tablet_user_id"):
        member_id = _child_member(hub, connection)
        if not member_id:
            return {"_role": "tablet_picker", "members": [
                {"id": m["id"], "name": m["name"], "color": m["color"], "avatar": m.get("avatar", "🙂")}
                for m in state["members"]], "tasks": [], "events": [], "routines": [],
                "point_entries": [], "task_completions": [], "rewards": [], "routine_checks": [], "school_plan": [], "school_years": [], "school_year_active": {}, "school_modes": {}, "school_absences": [], "school_holiday_settings": {}, "school_holiday_cache": {}, "school_pack_settings": {}, "school_pack_checks": [], "birthday_settings": {"enabled": False}, "work_plan": [], "work_exceptions": [], "family_lists": [],
                "external_calendars": [], "calendar_members": {}}
    member_id = _child_member(hub, connection)
    if not member_id:
        return None
    return {"_meal_planner_available": _meal_planner_installed(hub), "_challenge_progress": _challenge_progress(state), "_role": "child", "_tablet_mode": bool(user and user.id == state.get("tablet_user_id")), "_member_id": member_id,
            "members": [m for m in state["members"] if m["id"] == member_id],
            "tasks": [{**t, "done": _done_for(t, member_id)} for t in state["tasks"] if member_id in t.get("assignees", [])],
            "events": [e for e in state["events"] if member_id in e.get("members", [])],
            "external_calendars": [], "calendar_members": {},
            "rewards": state.get("rewards", []),
            "point_entries": [e for e in state.get("point_entries", []) if e.get("member_id") == member_id],
            "task_completions": [e for e in state.get("task_completions", []) if e.get("member_id") == member_id],
            "routines": [r for r in state.get("routines", []) if member_id in r.get("member_ids", [])],
            "routine_checks": [c for c in state.get("routine_checks", []) if c.get("member_id") == member_id],
            "school_plan": [s for s in state.get("school_plan", []) if s.get("member_id") == member_id],
            "school_year_active": {member_id: state.get("school_year_active", {}).get(member_id, "")},
            "school_modes": {member_id: state.get("school_modes", {}).get(member_id, "kindergarten")},
            "school_absences": [a for a in state.get("school_absences", []) if a.get("member_id") == member_id],
            "school_holiday_settings": {member_id: state.get("school_holiday_settings", {}).get(member_id, {})},
            "school_holiday_cache": _child_holiday_cache(state, member_id),
            "school_pack_settings": {member_id: state.get("school_pack_settings", {}).get(member_id, {"enabled": False, "subjects": {}})},
            "school_pack_checks": [c for c in state.get("school_pack_checks", []) if c.get("member_id") == member_id],
            "work_plan": [s for s in state.get("work_plan", []) if s.get("member_id") == member_id],
            "work_exceptions": [s for s in state.get("work_exceptions", []) if s.get("member_id") == member_id],
            "birthday_settings": {"enabled": False},
            "display_settings": state.get("display_settings", {"enabled": False, "photos": [], "rotate_seconds": 30}),
            "family_lists": [l for l in state.get("family_lists", []) if member_id in l.get("member_ids", [])]}


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/display_settings_save",
    vol.Required("enabled"): bool,
    vol.Required("photos"): [str],
    vol.Required("rotate_seconds"): vol.In([15, 30, 60]),
})
@websocket_api.async_response
async def ws_display_settings_save(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern dürfen den Bildschirmmodus einstellen")
        return
    photos = msg["photos"]
    if len(photos) > 12 or any(
        len(path) > 240
        or not path.startswith("/local/")
        or path.startswith("/local//")
        or ".." in path
        or "?" in path or "#" in path or "\\" in path
        or not path.lower().endswith((".jpg", ".jpeg", ".png", ".webp"))
        for path in photos
    ):
        connection.send_error(msg["id"], "invalid_data", "Nur lokale Bildpfade wie /local/familie/foto.jpg sind erlaubt (maximal 12 Bilder)")
        return
    async with hub["lock"]:
        hub["state"]["display_settings"] = {"enabled": msg["enabled"], "photos": photos,
            "rotate_seconds": msg["rotate_seconds"]}
        await hub["store"].async_save(hub["state"])
    connection.send_result(msg["id"], _visible_state(hub, connection))


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/tablet_enter"})
@websocket_api.async_response
async def ws_tablet_enter(hass, connection, msg):
    """Open Family Hub: dedicated tablet account always begins at the person picker.

    No administrator can impersonate a child by switching the UI; the endpoint
    returns the administrator's normal view to existing administrator sessions.
    """
    hub = hass.data.get(DOMAIN)
    if not hub:
        connection.send_error(msg["id"], "not_ready", "Family Hub ist nicht eingerichtet")
        return
    user = connection.user
    if user and user.is_active and not user.is_admin and user.id == hub["state"].get("tablet_user_id"):
        hub.setdefault("tablet_selection", {}).pop(user.id, None)
    result = _visible_state(hub, connection)
    if result is None:
        connection.send_error(msg["id"], "unauthorized", "Dieses Konto ist keinem Familienmitglied zugeordnet")
        return
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/tablet_select",
    vol.Required("member_id"): str,
})
@websocket_api.async_response
async def ws_tablet_select(hass, connection, msg):
    """Choose a child on a dedicated non-admin tablet account; never grant admin access."""
    hub = hass.data.get(DOMAIN)
    user = connection.user
    if (not hub or not user or not user.is_active or user.is_admin
            or user.id != hub["state"].get("tablet_user_id")):
        connection.send_error(msg["id"], "unauthorized", "Kein Tablet-Zugang")
        return
    member_id = msg["member_id"]
    if member_id and member_id not in {m["id"] for m in hub["state"]["members"]}:
        connection.send_error(msg["id"], "invalid_member", "Kind nicht gefunden")
        return
    if member_id:
        hub.setdefault("tablet_selection", {})[user.id] = member_id
    else:
        hub.setdefault("tablet_selection", {}).pop(user.id, None)
    connection.send_result(msg["id"], _visible_state(hub, connection))


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/tablet_settings_save",
    vol.Required("user_id"): str,
})
@websocket_api.async_response
async def ws_tablet_settings_save(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Administratoren")
        return
    uid = msg["user_id"]
    if uid:
        user = await hass.auth.async_get_user(uid)
        if not user or not user.is_active or user.is_admin or user.system_generated:
            connection.send_error(msg["id"], "invalid_user", "Bitte ein aktives Nicht-Admin-Konto wählen")
            return
        if uid in hub["state"].get("child_users", {}):
            connection.send_error(msg["id"], "invalid_user", "Dieses Konto ist bereits einem Kind zugeordnet")
            return
    async with hub["lock"]:
        hub["state"]["tablet_user_id"] = uid
        hub.setdefault("tablet_selection", {}).clear()
        await hub["store"].async_save(hub["state"])
    connection.send_result(msg["id"], _visible_state(hub, connection))


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
    vol.Optional("avatar", default="🙂"): str,
    vol.Optional("role", default="child"): vol.In(("child", "parent")),
    vol.Optional("birthday", default=""): str,
})
@websocket_api.async_response
async def ws_member_save(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if hub is None or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Keine Berechtigung")
        return
    try:
        name, color = _text(msg["name"], 60), _color(msg["color"])
        birthday = _optional_date(msg.get("birthday", ""))
        if birthday and date.fromisoformat(birthday) > dt_util.now().date():
            raise ValueError("Geburtsdatum darf nicht in der Zukunft liegen")
        avatar = msg.get("avatar", "🙂")
        if avatar not in ("🙂", "👧", "👦", "🧒", "👩", "👨", "👶", "🦊", "🐻", "🐼", "🐰", "🦄", "🐱", "🐶", "🌈", "⭐"):
            raise ValueError("Bitte ein vorhandenes Profil-Symbol wählen")
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
            member.update(name=name, color=color, avatar=avatar, role=msg["role"], birthday=birthday)
        else:
            members.append({"id": uuid4().hex, "name": name, "color": color, "avatar": avatar, "role": msg["role"], "birthday": birthday})
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
        hub["state"]["school_plan"] = [s for s in hub["state"].get("school_plan", []) if s.get("member_id") != msg["member_id"]]
        hub["state"]["school_years"] = [y for y in hub["state"].get("school_years", []) if y.get("member_id") != msg["member_id"]]
        hub["state"].setdefault("school_year_active", {}).pop(msg["member_id"], None)
        hub["state"].setdefault("school_modes", {}).pop(msg["member_id"], None)
        hub["state"]["school_absences"] = [a for a in hub["state"].get("school_absences", []) if a.get("member_id") != msg["member_id"]]
        hub["state"].get("school_holiday_settings", {}).pop(msg["member_id"], None)
        hub["state"].setdefault("school_pack_settings", {}).pop(msg["member_id"], None)
        hub["state"]["school_pack_checks"] = [c for c in hub["state"].get("school_pack_checks", []) if c.get("member_id") != msg["member_id"]]
        hub["state"]["work_plan"] = [s for s in hub["state"].get("work_plan", []) if s.get("member_id") != msg["member_id"]]
        hub["state"]["work_exceptions"] = [s for s in hub["state"].get("work_exceptions", []) if s.get("member_id") != msg["member_id"]]
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
            hub["state"]["task_completions"] = [e for e in hub["state"].get("task_completions", [])
                if not (e.get("task_id") == task["id"] and e.get("member_id") == member_id)]
            if assignees:
                task["done_members"] = [mid for mid in assignees if mid in _done_members(task) and mid != member_id]
            else:
                task["done"] = False
            if successor:
                tasks.remove(successor)
                task["repeat"] = task.pop("completed_repeat", "none")
                task.pop("next_task_id", None)
        else:
            if assignees and not any(e.get("task_id") == task["id"] and e.get("member_id") == member_id
                                     for e in hub["state"].get("task_completions", [])):
                now = dt_util.now()
                cutoff = (now.date() - timedelta(days=180)).isoformat()
                history = hub["state"].setdefault("task_completions", [])
                history.append({"task_id": task["id"], "member_id": member_id,
                                "date": now.date().isoformat(), "at": now.isoformat(),
                                "title": task.get("title", "Aufgabe")[:160]})
                hub["state"]["task_completions"] = [e for e in history if e.get("date", "") >= cutoff]
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
        "assignments": hub["state"].get("child_users", {}), "tablet_user_id": hub["state"].get("tablet_user_id", "")})


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
            if user_id == hub["state"].get("tablet_user_id"):
                connection.send_error(msg["id"], "invalid_data", "Dieses Konto ist für das Familientablet reserviert")
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


def _notify_category(state, member_id, category):
    """Missing values retain legacy reminders; new kinds start disabled."""
    defaults = {"tasks": True, "birthday": True, "work": True, "schoolbag": False, "events": False}
    per_person = state.get("notification_center", {}).get("categories", {}).get(member_id, {})
    return per_person.get(category, defaults.get(category, False)) is True


def _notify_in_quiet(state, now):
    """Quiet interval supports a range crossing midnight (local HA time)."""
    cfg = state.get("notification_center", {})
    if not cfg.get("quiet_enabled", False):
        return False
    start, end = int(cfg.get("quiet_start", 21)), int(cfg.get("quiet_end", 7))
    if start == end:
        return False
    return (start <= now.hour < end) if start < end else (now.hour >= start or now.hour < end)


async def _send_to_mobile(hass, target, title, message):
    """Shared HA companion-app notification sender."""
    if target.startswith("entity:"):
        await hass.services.async_call("notify", "send_message", {"title": title, "message": message},
                                       target={"entity_id": target.removeprefix("entity:")}, blocking=True)
    else:
        await hass.services.async_call("notify", target, {"title": title, "message": message,
            "data": {"url": "/" + PANEL_URL, "clickAction": "/" + PANEL_URL}}, blocking=True)


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
        if test_member is None and (not _notify_category(state, mid, "tasks") or _notify_in_quiet(state, now)):
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


# Per-child timetable kind: existing school entries are preserved when switching.
@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/school_mode_save",
    vol.Required("member_id"): str,
    vol.Required("mode"): vol.In(("kindergarten", "school")),
})
@websocket_api.async_response
async def ws_school_mode_save(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern dürfen den Plantyp ändern")
        return
    if msg["member_id"] not in {m["id"] for m in hub["state"]["members"] if m.get("role", "child") == "child"}:
        connection.send_error(msg["id"], "invalid_data", "Bitte ein Kind auswählen")
        return
    async with hub["lock"]:
        hub["state"].setdefault("school_modes", {})[msg["member_id"]] = msg["mode"]
        await hub["store"].async_save(hub["state"])
    connection.send_result(msg["id"], _visible_state(hub, connection))


# Weekly school/kindergarten timetable: admin-only writes, member-scoped reads.
_SCHOOL_ICONS = ("🎒", "📚", "✏️", "🎨", "⚽", "🎵", "🧮", "🔬", "📖", "🏊", "🧸", "🥪", "🚌", "🌳", "🧩")


# School-year snapshots preserve older timetables without duplicating live lessons.
@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/school_year_start",
    vol.Required("member_id"): str,
    vol.Required("new_label"): str,
})
@websocket_api.async_response
async def ws_school_year_start(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern")
        return
    try:
        label = _text(msg["new_label"], 32)
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_data", str(err))
        return
    async with hub["lock"]:
        state = hub["state"]
        mid = msg["member_id"]
        if mid not in {m["id"] for m in state["members"] if m.get("role", "child") == "child"}:
            connection.send_error(msg["id"], "invalid_data", "Kind nicht gefunden")
            return
        active = state.setdefault("school_year_active", {})
        current_label = active.get(mid, "Bisheriger Stundenplan")
        if label == current_label:
            connection.send_error(msg["id"], "invalid_data", "Bitte ein anderes Schuljahr eingeben")
            return
        # Store a deep copy. Existing record snapshots must not be mutated by future edits.
        import copy
        lessons = [copy.deepcopy(s) for s in state.get("school_plan", []) if s.get("member_id") == mid]
        archived = state.setdefault("school_years", [])
        archived.append({"id": uuid4().hex, "member_id": mid, "label": current_label,
                         "lessons": lessons, "saved_at": dt_util.now().date().isoformat()})
        active[mid] = label
        # The new school year begins with a *copy* so only changed subjects need editing.
        await hub["store"].async_save(state)
    connection.send_result(msg["id"], _visible_state(hub, connection))


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/school_year_restore",
    vol.Required("member_id"): str,
    vol.Required("year_id"): str,
})
@websocket_api.async_response
async def ws_school_year_restore(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern")
        return
    import copy
    async with hub["lock"]:
        state = hub["state"]
        mid = msg["member_id"]
        archive = next((y for y in state.get("school_years", []) if y.get("id") == msg["year_id"] and y.get("member_id") == mid), None)
        if archive is None:
            connection.send_error(msg["id"], "not_found", "Schuljahr nicht gefunden")
            return
        active = state.setdefault("school_year_active", {})
        current = [copy.deepcopy(s) for s in state.get("school_plan", []) if s.get("member_id") == mid]
        state.setdefault("school_years", []).append({"id": uuid4().hex, "member_id": mid,
            "label": active.get(mid, "Bisheriger Stundenplan"), "lessons": current,
            "saved_at": dt_util.now().date().isoformat()})
        # Recreate lesson IDs to avoid unintended reuse of old UI editing references.
        restored = [{**copy.deepcopy(s), "id": uuid4().hex, "member_id": mid} for s in archive.get("lessons", [])]
        state["school_plan"] = [s for s in state.get("school_plan", []) if s.get("member_id") != mid] + restored
        active[mid] = archive.get("label", "Archiv")
        await hub["store"].async_save(state)
    connection.send_result(msg["id"], _visible_state(hub, connection))

@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/school_save",
    vol.Optional("entry_id", default=""): str,
    vol.Required("member_id"): str,
    vol.Required("weekday"): vol.All(vol.Coerce(int), vol.Range(min=0, max=6)),
    vol.Required("title"): str,
    vol.Required("icon"): vol.In(_SCHOOL_ICONS),
    vol.Optional("time", default=""): str,
    vol.Optional("end_time", default=""): str,
})
@websocket_api.async_response
async def ws_school_save(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern dürfen den Stundenplan bearbeiten")
        return
    try:
        title = _text(msg["title"], 80)
        time = msg["time"]
        end_time = msg["end_time"]
        if end_time:
            datetime.strptime(end_time, "%H:%M")
            if len(end_time) != 5 or not time:
                raise ValueError("Für das Ende bitte eine gültige Startzeit angeben")
            if end_time <= time:
                raise ValueError("Die Endzeit muss nach dem Beginn liegen")
        if time:
            datetime.strptime(time, "%H:%M")
            if len(time) != 5:
                raise ValueError("Uhrzeit muss HH:MM sein")
        if msg["member_id"] not in {m["id"] for m in hub["state"]["members"] if m.get("role", "child") == "child"}:
            raise ValueError("Bitte ein Kind auswählen")
    except (ValueError, TypeError) as err:
        connection.send_error(msg["id"], "invalid_data", str(err))
        return
    async with hub["lock"]:
        entries = hub["state"].setdefault("school_plan", [])
        existing = next((s for s in entries if s["id"] == msg["entry_id"]), None) if msg["entry_id"] else None
        if msg["entry_id"] and not existing:
            connection.send_error(msg["id"], "not_found", "Eintrag nicht gefunden")
            return
        mode = hub["state"].get("school_modes", {}).get(msg["member_id"], "kindergarten")
        if mode == "kindergarten":
            conflicting = [e for e in entries if e.get("member_id") == msg["member_id"]
                           and int(e.get("weekday", -1)) == msg["weekday"] and e.get("id") != msg["entry_id"]]
            if conflicting:
                connection.send_error(msg["id"], "invalid_data", "Für diesen Tag gibt es bereits einen Eintrag. Bitte diesen bearbeiten oder den Plantyp Stundenplan wählen.")
                return
        values = {"member_id": msg["member_id"], "weekday": msg["weekday"], "title": title,
                  "icon": msg["icon"], "time": time, "end_time": end_time}
        if existing:
            existing.update(values)
        else:
            entries.append({"id": uuid4().hex, **values})
        await hub["store"].async_save(hub["state"])
    connection.send_result(msg["id"], _visible_state(hub, connection))


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/school_delete", vol.Required("entry_id"): str})
@websocket_api.async_response
async def ws_school_delete(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern")
        return
    async with hub["lock"]:
        old = hub["state"].setdefault("school_plan", [])
        new = [s for s in old if s.get("id") != msg["entry_id"]]
        if len(new) == len(old):
            connection.send_error(msg["id"], "not_found", "Eintrag nicht gefunden")
            return
        hub["state"]["school_plan"] = new
        await hub["store"].async_save(hub["state"])
    connection.send_result(msg["id"], _visible_state(hub, connection))





# Optional school holidays and statutory holidays from OpenHolidays (ODbL).
# Cached per region and always read-only; manually entered absences take precedence.
def _holiday_key(settings):
    return f"{settings.get('country', '')}:{settings.get('region', '')}"


def _child_holiday_cache(state, member_id):
    cfg = state.get("school_holiday_settings", {}).get(member_id, {})
    key = _holiday_key(cfg)
    if not cfg.get("enabled") or not cfg.get("country"):
        return {}
    return {key: state.get("school_holiday_cache", {}).get(key, {})}


def _school_absence_at(state, member_id, iso):
    manual = next((a for a in state.get("school_absences", [])
                   if a.get("member_id") == member_id and a.get("start", "") <= iso <= a.get("end", "")), None)
    if manual:
        return manual
    cfg = state.get("school_holiday_settings", {}).get(member_id, {})
    if not cfg.get("enabled"):
        return None
    for holiday in state.get("school_holiday_cache", {}).get(_holiday_key(cfg), {}).get("entries", []):
        if (holiday.get("kind") == "school" and not cfg.get("school", True)) or (holiday.get("kind") == "public" and not cfg.get("public", True)):
            continue
        if holiday.get("start", "") <= iso <= holiday.get("end", ""):
            return {"kind": "holiday" if holiday.get("kind") == "school" else "free", "note": holiday.get("name", ""),
                    "start": holiday["start"], "end": holiday["end"], "automatic": True}
    return None


def _holiday_is_regional(item, region):
    if item.get("nationwide") is True:
        return True
    subdivisions = item.get("subdivisions") or []
    if not subdivisions:
        return True
    return any((sub.get("code") if isinstance(sub, dict) else sub) == region for sub in subdivisions)


async def _refresh_school_holidays(hass, force=False):
    hub = hass.data.get(DOMAIN)
    if not hub or "state" not in hub:
        return
    configurations = list(hub["state"].get("school_holiday_settings", {}).values())
    selected = {(_holiday_key(cfg), cfg["country"], cfg["region"]) for cfg in configurations
                if isinstance(cfg, dict) and cfg.get("enabled") and cfg.get("region") in HOLIDAY_REGIONS.get(cfg.get("country"), ())}
    if not selected:
        return
    now = dt_util.now().date()
    from_date = (now - timedelta(days=31)).isoformat()
    to_date = (now + timedelta(days=540)).isoformat()
    session = async_get_clientsession(hass)
    for key, country, region in selected:
        current = hub["state"].get("school_holiday_cache", {}).get(key, {})
        if not force and current.get("updated", "") >= (now - timedelta(days=5)).isoformat() and current.get("valid_to", "") >= to_date:
            continue
        all_entries = []
        success = 0
        for kind, route in (("school", "SchoolHolidays"), ("public", "PublicHolidays")):
            params = {"countryIsoCode": country, "validFrom": from_date, "validTo": to_date, "languageIsoCode": "DE"}
            if kind == "school":
                params["subdivisionCode"] = region
            url = "https://openholidaysapi.org/" + route + "?" + urlencode(params)
            try:
                import aiohttp
                async with session.get(url, headers={"Accept": "application/json"}, timeout=aiohttp.ClientTimeout(total=15)) as response:
                    response.raise_for_status()
                    raw = await response.json()
                if not isinstance(raw, list):
                    raise ValueError("Unerwartetes Antwortformat")
                entries = []
                for item in raw:
                    if not isinstance(item, dict) or not _holiday_is_regional(item, region):
                        continue
                    start = item.get("startDate")
                    end = item.get("endDate")
                    try:
                        date.fromisoformat(start)
                        date.fromisoformat(end)
                    except (ValueError, TypeError):
                        continue
                    names = item.get("name") or []
                    if isinstance(names, list):
                        name = next((n.get("text") for n in names if isinstance(n, dict) and str(n.get("language", "")).lower() == "de"), None)
                        name = name or next((n.get("text") for n in names if isinstance(n, dict)), None)
                    else:
                        name = str(names)
                    entries.append({"kind": kind, "start": start, "end": end, "name": str(name or ("Ferien" if kind == "school" else "Feiertag"))[:100]})
                all_entries.extend(entries)
                success += 1
            except (OSError, ValueError, TimeoutError, aiohttp.ClientError) as err:
                _LOGGER.warning("Ferienabruf für %s (%s) fehlgeschlagen: %s", key, kind, err)
                # Keep cached entries of the unavailable category rather than losing known holidays.
                all_entries.extend(e for e in current.get("entries", []) if e.get("kind") == kind)
        if success:
            async with hub["lock"]:
                hub["state"].setdefault("school_holiday_cache", {})[key] = {
                    "entries": all_entries, "updated": now.isoformat(), "valid_to": to_date,
                    "status": "ok" if success == 2 else "partial",
                }
                await hub["store"].async_save(hub["state"])


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/school_holiday_save",
    vol.Required("member_id"): str,
    vol.Required("enabled"): bool,
    vol.Required("country"): vol.In(("AT", "DE")),
    vol.Required("region"): str,
    vol.Optional("school", default=True): bool,
    vol.Optional("public", default=True): bool,
})
@websocket_api.async_response
async def ws_school_holiday_save(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern können Ferien automatisch aktivieren")
        return
    if msg["region"] not in HOLIDAY_REGIONS[msg["country"]]:
        connection.send_error(msg["id"], "invalid_data", "Ungültiges Bundesland")
        return
    if msg["member_id"] not in {m["id"] for m in hub["state"].get("members", []) if m.get("role", "child") != "parent"}:
        connection.send_error(msg["id"], "invalid_data", "Kind nicht gefunden")
        return
    async with hub["lock"]:
        hub["state"].setdefault("school_holiday_settings", {})[msg["member_id"]] = {
            "enabled": msg["enabled"], "country": msg["country"], "region": msg["region"],
            "school": msg["school"], "public": msg["public"],
        }
        await hub["store"].async_save(hub["state"])
    if msg["enabled"]:
        hass.async_create_task(_refresh_school_holidays(hass, force=True))
    connection.send_result(msg["id"], _visible_state(hub, connection))


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/school_holiday_refresh"})
@websocket_api.async_response
async def ws_school_holiday_refresh(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern")
        return
    await _refresh_school_holidays(hass, force=True)
    connection.send_result(msg["id"], _visible_state(hub, connection))

# Date-range school/kindergarten absences. Kept separate from recurring timetable.
@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/school_absence_save",
    vol.Optional("entry_id", default=""): str,
    vol.Required("member_id"): str,
    vol.Required("kind"): vol.In(("holiday", "illness", "free", "other")),
    vol.Required("start"): str,
    vol.Required("end"): str,
    vol.Optional("note", default=""): str,
})
@websocket_api.async_response
async def ws_school_absence_save(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern dürfen Abwesenheiten bearbeiten")
        return
    try:
        start = date.fromisoformat(msg["start"])
        end = date.fromisoformat(msg["end"])
        if start.isoformat() != msg["start"] or end.isoformat() != msg["end"]:
            raise ValueError("Datum muss JJJJ-MM-TT sein")
        if end < start or (end - start).days > 365:
            raise ValueError("Bitte einen Zeitraum von maximal 366 Tagen auswählen")
        if msg["member_id"] not in {m["id"] for m in hub["state"]["members"] if m.get("role", "child") == "child"}:
            raise ValueError("Bitte ein Kind auswählen")
        note = _text(msg["note"], 100) if msg["note"].strip() else ""
    except (ValueError, TypeError) as err:
        connection.send_error(msg["id"], "invalid_data", str(err))
        return
    async with hub["lock"]:
        entries = hub["state"].setdefault("school_absences", [])
        old = next((x for x in entries if x.get("id") == msg["entry_id"]), None) if msg["entry_id"] else None
        if msg["entry_id"] and not old:
            connection.send_error(msg["id"], "not_found", "Eintrag nicht gefunden")
            return
        # A day may have only one effective school absence per member.
        if any(x.get("member_id") == msg["member_id"] and x.get("id") != msg["entry_id"]
               and x.get("start", "") <= end.isoformat() and x.get("end", "") >= start.isoformat()
               for x in entries):
            connection.send_error(msg["id"], "invalid_data", "Dieser Zeitraum überschneidet sich mit einer vorhandenen Abwesenheit")
            return
        values = {"member_id": msg["member_id"], "kind": msg["kind"],
                  "start": start.isoformat(), "end": end.isoformat(), "note": note}
        if old:
            old.update(values)
        else:
            entries.append({"id": uuid4().hex, **values})
        await hub["store"].async_save(hub["state"])
    connection.send_result(msg["id"], _visible_state(hub, connection))


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/school_absence_delete", vol.Required("entry_id"): str})
@websocket_api.async_response
async def ws_school_absence_delete(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern")
        return
    async with hub["lock"]:
        old = hub["state"].setdefault("school_absences", [])
        remaining = [x for x in old if x.get("id") != msg["entry_id"]]
        if len(old) == len(remaining):
            connection.send_error(msg["id"], "not_found", "Eintrag nicht gefunden")
            return
        hub["state"]["school_absences"] = remaining
        await hub["store"].async_save(hub["state"])
    connection.send_result(msg["id"], _visible_state(hub, connection))


# Weekly recurring work shifts are independent of children's school/kindergarten timetables.
@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/work_save",
    vol.Optional("entry_id", default=""): str,
    vol.Required("member_id"): str,
    vol.Required("weekday"): vol.All(vol.Coerce(int), vol.Range(min=0, max=6)),
    vol.Required("title"): str,
    vol.Optional("time", default=""): str,
    vol.Optional("end_time", default=""): str,
})
@websocket_api.async_response
async def ws_work_save(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern dürfen den Dienstplan bearbeiten")
        return
    try:
        title = _text(msg["title"], 80)
        start = msg["time"]
        end = msg["end_time"]
        for value in (start, end):
            if value and (len(value) != 5 or datetime.strptime(value, "%H:%M").strftime("%H:%M") != value):
                raise ValueError("Bitte Uhrzeiten im Format HH:MM eintragen")
        if end and not start:
            raise ValueError("Bitte eine Startzeit angeben")
        if not any(m["id"] == msg["member_id"] and m.get("role", "child") == "parent" for m in hub["state"]["members"]):
            raise ValueError("Bitte einen Elternteil auswählen")
    except (ValueError, TypeError) as err:
        connection.send_error(msg["id"], "invalid_data", str(err))
        return
    async with hub["lock"]:
        entries = hub["state"].setdefault("work_plan", [])
        existing = next((s for s in entries if s.get("id") == msg["entry_id"]), None) if msg["entry_id"] else None
        if msg["entry_id"] and not existing:
            connection.send_error(msg["id"], "not_found", "Dienst nicht gefunden")
            return
        values = {"member_id": msg["member_id"], "weekday": msg["weekday"], "title": title,
                  "time": start, "end_time": end}
        if existing:
            existing.update(values)
        else:
            entries.append({"id": uuid4().hex, **values})
        await hub["store"].async_save(hub["state"])
    connection.send_result(msg["id"], _visible_state(hub, connection))


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/work_delete", vol.Required("entry_id"): str})
@websocket_api.async_response
async def ws_work_delete(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern")
        return
    async with hub["lock"]:
        entries = hub["state"].setdefault("work_plan", [])
        new = [s for s in entries if s.get("id") != msg["entry_id"]]
        if len(new) == len(entries):
            connection.send_error(msg["id"], "not_found", "Dienst nicht gefunden")
            return
        hub["state"]["work_plan"] = new
        await hub["store"].async_save(hub["state"])
    connection.send_result(msg["id"], _visible_state(hub, connection))


# Date-specific overrides supersede recurring work shifts. More than one shift may be added
# for the same day; a leave/sick/day-off entry replaces all services on that date.
_WORK_STATES = ("shift", "free", "vacation", "sick")


def _work_for_date(state, member_id, day):
    overrides = [x for x in state.get("work_exceptions", []) if x.get("member_id") == member_id and x.get("date") == day.isoformat()]
    if overrides:
        return sorted(overrides, key=lambda x: x.get("time", ""))
    weekday = day.weekday()
    return sorted((x for x in state.get("work_plan", []) if x.get("member_id") == member_id and x.get("weekday") == weekday), key=lambda x: x.get("time", ""))


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/work_exception_save",
    vol.Optional("entry_id", default=""): str,
    vol.Required("member_id"): str,
    vol.Required("date"): str,
    vol.Required("kind"): vol.In(_WORK_STATES),
    vol.Optional("title", default=""): str,
    vol.Optional("time", default=""): str,
    vol.Optional("end_time", default=""): str,
})
@websocket_api.async_response
async def ws_work_exception_save(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern dürfen Dienständerungen bearbeiten")
        return
    try:
        chosen_date = _optional_date(msg["date"])
        if not chosen_date:
            raise ValueError("Datum fehlt")
        if not any(m["id"] == msg["member_id"] and m.get("role") == "parent" for m in hub["state"]["members"]):
            raise ValueError("Elternteil auswählen")
        for value in (msg["time"], msg["end_time"]):
            if value and (len(value) != 5 or datetime.strptime(value, "%H:%M").strftime("%H:%M") != value):
                raise ValueError("Zeit im Format HH:MM eintragen")
        if msg["kind"] == "shift":
            title = _text(msg["title"], 80)
            if not msg["time"] or not msg["end_time"]:
                raise ValueError("Arbeitsbeginn und -ende angeben")
        else:
            title = {"free":"Frei", "vacation":"Urlaub", "sick":"Krankenstand"}[msg["kind"]]
    except (ValueError, TypeError) as err:
        connection.send_error(msg["id"], "invalid_data", str(err))
        return
    async with hub["lock"]:
        entries = hub["state"].setdefault("work_exceptions", [])
        found = next((e for e in entries if e.get("id") == msg["entry_id"]), None) if msg["entry_id"] else None
        if msg["entry_id"] and not found:
            connection.send_error(msg["id"], "not_found", "Dienständerung nicht gefunden")
            return
        # Prevent editing another member's entry by a guessed id; admins only but consistent.
        if found and found.get("member_id") != msg["member_id"]:
            connection.send_error(msg["id"], "invalid_data", "Person stimmt nicht überein")
            return
        if msg["kind"] != "shift":
            entries[:] = [e for e in entries if not (e.get("member_id") == msg["member_id"] and e.get("date") == chosen_date and e is not found)]
        else:
            entries[:] = [e for e in entries if not (e.get("member_id") == msg["member_id"] and e.get("date") == chosen_date and e.get("kind") != "shift" and e is not found)]
        values = {"member_id": msg["member_id"], "date": chosen_date, "kind": msg["kind"],
                  "title": title, "time": msg["time"] if msg["kind"] == "shift" else "",
                  "end_time": msg["end_time"] if msg["kind"] == "shift" else ""}
        if found:
            found.update(values)
        else:
            entries.append({"id": uuid4().hex, **values})
        await hub["store"].async_save(hub["state"])
    connection.send_result(msg["id"], _visible_state(hub, connection))


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/work_exception_delete", vol.Required("entry_id"): str})
@websocket_api.async_response
async def ws_work_exception_delete(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern")
        return
    async with hub["lock"]:
        old = hub["state"].setdefault("work_exceptions", [])
        new = [e for e in old if e.get("id") != msg["entry_id"]]
        if len(new) == len(old):
            connection.send_error(msg["id"], "not_found", "Eintrag nicht gefunden")
            return
        hub["state"]["work_exceptions"] = new
        await hub["store"].async_save(hub["state"])
    connection.send_result(msg["id"], _visible_state(hub, connection))


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/work_alert_save",
    vol.Required("enabled"): bool,
    vol.Required("minutes"): vol.In([10, 15, 30, 60]),
})
@websocket_api.async_response
async def ws_work_alert_save(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern")
        return
    async with hub["lock"]:
        hub["state"]["work_alert"] = {"enabled": msg["enabled"], "minutes": msg["minutes"]}
        await hub["store"].async_save(hub["state"])
    connection.send_result(msg["id"], _visible_state(hub, connection))


async def _send_work_alerts(hass):
    """Optional reminders: at most once per shift, only to explicitly assigned phones."""
    hub = hass.data.get(DOMAIN)
    if not hub or "state" not in hub:
        return
    async with hub["lock"]:
        state = hub["state"]
        settings = state.get("work_alert", {})
        if not settings.get("enabled", False):
            return
        minutes = int(settings.get("minutes", 30))
        members = [m for m in state.get("members", []) if m.get("role") == "parent"]
        targets = dict(state.get("push_settings", {}).get("devices", {}))
        available = set(_mobile_services(hass))
        sent = set(state.get("work_alert_sent", []))
        now = dt_util.now()
        jobs = []
        for member in members:
            if not _notify_category(state, member["id"], "work") or _notify_in_quiet(state, now):
                continue
            target = targets.get(member["id"], "")
            if target not in available:
                continue
            for day in (now.date(), now.date() + timedelta(days=1)):
                for work in _work_for_date(state, member["id"], day):
                    if work.get("kind", "shift") != "shift" or not work.get("time"):
                        continue
                    start = datetime.combine(day, datetime.strptime(work["time"], "%H:%M").time(), tzinfo=now.tzinfo)
                    remain = (start-now).total_seconds()/60
                    key = f"{member['id']}:{day.isoformat()}:{work.get('id')}"
                    if key not in sent and 0 <= remain <= minutes and remain > minutes-5.1:
                        jobs.append((key, target, member["name"], work, day))
    for key, target, name, work, day in jobs:
        message = f"Hallo {name}! Dein {work['title']} beginnt heute um {work['time']} Uhr." if day == dt_util.now().date() else f"Hallo {name}! Dein {work['title']} beginnt um {work['time']} Uhr."
        try:
            if target.startswith("entity:"):
                await hass.services.async_call("notify", "send_message", {"title":"Family Hub · Dienstbeginn", "message":message}, target={"entity_id":target.removeprefix("entity:")}, blocking=True)
            else:
                await hass.services.async_call("notify", target, {"title":"Family Hub · Dienstbeginn", "message":message, "data":{"url":"/"+PANEL_URL}}, blocking=True)
        except Exception:
            continue
        async with hub["lock"]:
            entries = hub["state"].setdefault("work_alert_sent", [])
            if key not in entries:
                entries.append(key)
            # Retain only a bounded history to avoid unbounded storage growth.
            hub["state"]["work_alert_sent"] = entries[-1000:]
            await hub["store"].async_save(hub["state"])


# Standalone family shopping and packing lists. Never depend on Meal Planner.
_LIST_TYPES = ("shopping", "packing", "checklist")
_LIST_ICONS = ("🛒", "🎒", "🏖️", "🏫", "🧳", "🏊", "🎉", "✅", "🧸", "🍎", "🧼", "🚗", "🐶", "⚽", "🎨")


def _list_visible_to_member(item, member_id):
    return member_id in item.get("member_ids", [])


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/list_save",
    vol.Optional("list_id", default=""): str,
    vol.Required("title"): str,
    vol.Required("list_type"): vol.In(_LIST_TYPES),
    vol.Required("icon"): vol.In(_LIST_ICONS),
    vol.Required("member_ids"): [str],
})
@websocket_api.async_response
async def ws_list_save(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern dürfen Listen verwalten")
        return
    try:
        title = _text(msg["title"], 80)
        ids = list(dict.fromkeys(msg["member_ids"]))
        if not set(ids).issubset({m["id"] for m in hub["state"]["members"]}):
            raise ValueError("Ungültige Familienmitglieder")
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_data", str(err))
        return
    async with hub["lock"]:
        entries = hub["state"].setdefault("family_lists", [])
        current = next((e for e in entries if e.get("id") == msg["list_id"]), None) if msg["list_id"] else None
        if msg["list_id"] and current is None:
            connection.send_error(msg["id"], "not_found", "Liste nicht gefunden")
            return
        values = {"title": title, "list_type": msg["list_type"], "icon": msg["icon"], "member_ids": ids}
        if current:
            current.update(values)
        else:
            entries.append({"id": uuid4().hex, "items": [], **values})
        await hub["store"].async_save(hub["state"])
    connection.send_result(msg["id"], _visible_state(hub, connection))


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/list_item_add",
    vol.Required("list_id"): str,
    vol.Required("title"): str,
    vol.Optional("icon", default="✅"): vol.In(_LIST_ICONS),
})
@websocket_api.async_response
async def ws_list_item_add(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern können Einträge erstellen")
        return
    try:
        title = _text(msg["title"], 100)
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_data", str(err))
        return
    async with hub["lock"]:
        entry = next((e for e in hub["state"].setdefault("family_lists", []) if e.get("id") == msg["list_id"]), None)
        if not entry:
            connection.send_error(msg["id"], "not_found", "Liste nicht gefunden")
            return
        if len(entry["items"]) >= 100:
            connection.send_error(msg["id"], "limit", "Maximal 100 Einträge pro Liste")
            return
        entry["items"].append({"id": uuid4().hex, "title": title, "icon": msg["icon"], "done": False})
        await hub["store"].async_save(hub["state"])
    connection.send_result(msg["id"], _visible_state(hub, connection))


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/list_item_toggle",
    vol.Required("list_id"): str,
    vol.Required("item_id"): str,
})
@websocket_api.async_response
async def ws_list_item_toggle(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub:
        connection.send_error(msg["id"], "not_ready", "Family Hub nicht bereit")
        return
    admin = _owner(connection)
    member = _child_member(hub, connection) if not admin else None
    if not admin and not member:
        connection.send_error(msg["id"], "unauthorized", "Kein Zugriff")
        return
    async with hub["lock"]:
        entry = next((e for e in hub["state"].setdefault("family_lists", []) if e.get("id") == msg["list_id"]), None)
        if not entry or (not admin and not _list_visible_to_member(entry, member)):
            connection.send_error(msg["id"], "unauthorized", "Liste nicht freigegeben")
            return
        item = next((i for i in entry["items"] if i.get("id") == msg["item_id"]), None)
        if item is None:
            connection.send_error(msg["id"], "not_found", "Eintrag nicht gefunden")
            return
        item["done"] = not item.get("done", False)
        await hub["store"].async_save(hub["state"])
    connection.send_result(msg["id"], _visible_state(hub, connection))


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/list_item_delete",
    vol.Required("list_id"): str,
    vol.Required("item_id"): str,
})
@websocket_api.async_response
async def ws_list_item_delete(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern")
        return
    async with hub["lock"]:
        entry = next((e for e in hub["state"].setdefault("family_lists", []) if e.get("id") == msg["list_id"]), None)
        if not entry:
            connection.send_error(msg["id"], "not_found", "Liste nicht gefunden")
            return
        before = len(entry["items"])
        entry["items"] = [i for i in entry["items"] if i.get("id") != msg["item_id"]]
        if before == len(entry["items"]):
            connection.send_error(msg["id"], "not_found", "Eintrag nicht gefunden")
            return
        await hub["store"].async_save(hub["state"])
    connection.send_result(msg["id"], _visible_state(hub, connection))


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/list_reset",
    vol.Required("list_id"): str,
})
@websocket_api.async_response
async def ws_list_reset(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern")
        return
    async with hub["lock"]:
        entry = next((e for e in hub["state"].setdefault("family_lists", []) if e.get("id") == msg["list_id"]), None)
        if not entry:
            connection.send_error(msg["id"], "not_found", "Liste nicht gefunden")
            return
        for item in entry["items"]:
            item["done"] = False
        await hub["store"].async_save(hub["state"])
    connection.send_result(msg["id"], _visible_state(hub, connection))


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/list_delete",
    vol.Required("list_id"): str,
})
@websocket_api.async_response
async def ws_list_delete(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern")
        return
    async with hub["lock"]:
        entries = hub["state"].setdefault("family_lists", [])
        updated = [e for e in entries if e.get("id") != msg["list_id"]]
        if len(entries) == len(updated):
            connection.send_error(msg["id"], "not_found", "Liste nicht gefunden")
            return
        hub["state"]["family_lists"] = updated
        await hub["store"].async_save(hub["state"])
    connection.send_result(msg["id"], _visible_state(hub, connection))

@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/challenge_settings_save",
    vol.Required("enabled"): bool,
    vol.Required("goal"): vol.All(vol.Coerce(int), vol.Range(min=1, max=500)),
    vol.Optional("reward_title", default=""): vol.All(str, vol.Length(max=100)),
    vol.Optional("reward_emoji", default="🎁"): vol.All(str, vol.Length(max=8)),
})
@websocket_api.async_response
async def ws_challenge_settings_save(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern dürfen das Familienziel ändern")
        return
    async with hub["lock"]:
        hub["state"]["family_challenge"] = {"enabled": msg["enabled"], "goal": msg["goal"], "reward_title": msg["reward_title"].strip(), "reward_emoji": msg["reward_emoji"].strip() or "🎁"}
        await hub["store"].async_save(hub["state"])
        connection.send_result(msg["id"], _visible_state(hub, connection))



@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/family_reward_claim",
})
@websocket_api.async_response
async def ws_family_reward_claim(hass, connection, msg):
    """Parents acknowledge the shared reward once per calendar week."""
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern dürfen die Familienbelohnung einlösen")
        return
    async with hub["lock"]:
        state = hub["state"]
        progress = _challenge_progress(state)
        if not progress["reward_unlocked"] or not progress["reward_title"]:
            connection.send_error(msg["id"], "not_ready", "Familienbelohnung ist noch nicht freigeschaltet")
            return
        if progress["reward_claimed"]:
            connection.send_error(msg["id"], "already_claimed", "Diese Wochenbelohnung wurde bereits eingelöst")
            return
        state.setdefault("family_reward_claims", []).append({
            "week_start": progress["week_start"],
            "reward_title": progress["reward_title"],
            "reward_emoji": progress["reward_emoji"],
            "claimed_at": dt_util.now().isoformat(),
        })
        await hub["store"].async_save(state)
        connection.send_result(msg["id"], _visible_state(hub, connection))


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/meal_week",
    vol.Optional("week_start", default=""): str,
})
@websocket_api.async_response
async def ws_meal_week(hass, connection, msg):
    """Optional read-only meal list. Never expose full Meal Planner storage to a child."""
    hub = hass.data.get(DOMAIN)
    if not hub or _visible_state(hub, connection) is None:
        connection.send_error(msg["id"], "unauthorized", "Kein Zugriff auf Family Hub")
        return
    planner = hass.data.get("meal_planner")
    if not isinstance(planner, dict) or not isinstance(planner.get("data"), dict):
        connection.send_result(msg["id"], {"installed": False, "days": []})
        return
    # Do not use Meal Planner's administrator-only get API: this endpoint
    # intentionally exposes ONLY seven dates, two names and optional symbols.
    start = dt_util.now().date()
    if msg["week_start"]:
        try:
            start = date.fromisoformat(msg["week_start"])
        except ValueError:
            connection.send_error(msg["id"], "invalid_date", "Ungültige Kalenderwoche")
            return
    today = dt_util.now().date()
    if abs((start - today).days) > 370:
        connection.send_error(msg["id"], "invalid_date", "Woche außerhalb des erlaubten Bereichs")
        return
    start -= timedelta(days=start.weekday())
    data = planner["data"]
    plans = data.get("plans") if isinstance(data.get("plans"), dict) else {}
    recipes = data.get("recipes") if isinstance(data.get("recipes"), list) else []
    by_id = {str(r.get("id")): r for r in recipes if isinstance(r, dict) and r.get("id") is not None}

    def public_meal(value):
        if not isinstance(value, (str, int)) or not value:
            return {"name": "", "symbol": ""}
        item = by_id.get(str(value))
        if item:
            name = item.get("name", "")
            symbol = item.get("photo_symbol", "🍽️")
            return {"name": str(name)[:160], "symbol": str(symbol)[:8] if isinstance(symbol, str) else "🍽️"}
        # Allow simple custom meals stored as plain text; no recipe metadata.
        return {"name": str(value)[:160], "symbol": "🍽️"}

    days = []
    for offset in range(7):
        day = (start + timedelta(days=offset)).isoformat()
        meals = plans.get(day)
        if not isinstance(meals, dict):
            meals = {}
        days.append({"date": day, "mittag": public_meal(meals.get("mittag")),
                     "abend": public_meal(meals.get("abend"))})
    connection.send_result(msg["id"], {"installed": True, "week_start": start.isoformat(), "days": days})




# Optional, per-child school-bag checklist. Disabled by default; parent edits only.
def _pack_items(state, member_id, iso):
    settings = state.get("school_pack_settings", {}).get(member_id, {})
    if not settings.get("enabled", False):
        return []
    day = date.fromisoformat(iso)
    if _school_absence_at(state, member_id, iso):
        return []
    weekday = day.weekday()
    subjects = settings.get("subjects", {})
    result = []
    seen = set()
    for lesson in state.get("school_plan", []):
        if lesson.get("member_id") != member_id or int(lesson.get("weekday", -1)) != weekday:
            continue
        subject = str(lesson.get("title", "")).strip().casefold()
        for item in subjects.get(subject, []):
            key = subject + "|" + item.casefold()
            if key not in seen:
                seen.add(key)
                result.append({"key": key, "name": item, "subject": lesson.get("title", "")})
    return result


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/school_pack_config_save",
    vol.Required("member_id"): str,
    vol.Required("enabled"): bool,
    vol.Required("subject"): str,
    vol.Required("items"): [str],
})
@websocket_api.async_response
async def ws_school_pack_config_save(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern dürfen die Packliste einstellen")
        return
    member_id = msg["member_id"]
    if member_id not in {m["id"] for m in hub["state"]["members"] if m.get("role", "child") != "parent"}:
        connection.send_error(msg["id"], "invalid_data", "Bitte ein Kind auswählen")
        return
    try:
        subject = msg["subject"].strip().casefold()
        if len(subject) > 80 or len(msg["items"]) > 25:
            raise ValueError("Zu viele oder zu lange Angaben")
        clean = list(dict.fromkeys(_text(item, 80) for item in msg["items"]))
        if clean and not subject:
            raise ValueError("Bitte ein Unterrichtsfach wählen")
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_data", str(err))
        return
    async with hub["lock"]:
        current = hub["state"].setdefault("school_pack_settings", {}).setdefault(member_id, {"enabled": False, "subjects": {}})
        current["enabled"] = msg["enabled"]
        subjects = current.setdefault("subjects", {})
        if subject:
            if clean:
                subjects[subject] = clean
            else:
                subjects.pop(subject, None)
        await hub["store"].async_save(hub["state"])
    connection.send_result(msg["id"], _visible_state(hub, connection))


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/school_pack_toggle",
    vol.Required("date"): str,
    vol.Required("key"): str,
})
@websocket_api.async_response
async def ws_school_pack_toggle(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    member_id = _child_member(hub, connection) if hub else None
    if not member_id:
        connection.send_error(msg["id"], "unauthorized", "Nur das zugeordnete Kind darf seine Packliste abhaken")
        return
    try:
        target = date.fromisoformat(msg["date"])
        today = dt_util.now().date()
        if target not in (today, today + timedelta(days=1)):
            raise ValueError("Packlisten sind nur für heute und morgen verfügbar")
        iso = target.isoformat()
        if msg["key"] not in {i["key"] for i in _pack_items(hub["state"], member_id, iso)}:
            raise ValueError("Dieser Gegenstand gehört nicht zur Packliste")
    except (TypeError, ValueError) as err:
        connection.send_error(msg["id"], "invalid_data", str(err))
        return
    async with hub["lock"]:
        checks = hub["state"].setdefault("school_pack_checks", [])
        previous = next((x for x in checks if x.get("member_id") == member_id and x.get("date") == iso and x.get("key") == msg["key"]), None)
        if previous:
            checks.remove(previous)
        else:
            checks.append({"member_id": member_id, "date": iso, "key": msg["key"]})
        cutoff = (dt_util.now().date() - timedelta(days=90)).isoformat()
        hub["state"]["school_pack_checks"] = [x for x in checks if x.get("date", "") >= cutoff]
        await hub["store"].async_save(hub["state"])
    connection.send_result(msg["id"], _visible_state(hub, connection))


def _birthday_next(birthday, today):
    """Next anniversary; Feb 29 occurs on Feb 28 during non-leap years."""
    try:
        original = date.fromisoformat(birthday)
    except (TypeError, ValueError):
        return None
    def anniv(year):
        try:
            return date(year, original.month, original.day)
        except ValueError:
            return date(year, 2, 28)
    next_day = anniv(today.year)
    return next_day if next_day >= today else anniv(today.year + 1)


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/birthday_settings_save",
    vol.Required("enabled"): bool,
    vol.Required("days_before"): vol.All(vol.Coerce(int), vol.In((1, 3, 7, 14))),
    vol.Required("hour"): vol.All(vol.Coerce(int), vol.Range(min=0, max=23)),
})
@websocket_api.async_response
async def ws_birthday_settings_save(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern dürfen Erinnerungen ändern")
        return
    async with hub["lock"]:
        hub["state"]["birthday_settings"] = {"enabled": msg["enabled"], "days_before": msg["days_before"], "hour": msg["hour"]}
        await hub["store"].async_save(hub["state"])
    connection.send_result(msg["id"], _visible_state(hub, connection))


async def _send_birthday_reminders(hass):
    """Optional parent-only birthday notice; at most once per day."""
    hub = hass.data.get(DOMAIN)
    if not hub or "state" not in hub:
        return
    now = dt_util.now()
    today = now.date()
    async with hub["lock"]:
        state = hub["state"]
        settings = state.get("birthday_settings", {})
        if not settings.get("enabled") or now.hour != int(settings.get("hour", 8)):
            return
        if state.get("birthday_last_sent") == today.isoformat():
            return
        lead = int(settings.get("days_before", 7))
        upcoming = []
        for person in state.get("members", []):
            nxt = _birthday_next(person.get("birthday", ""), today)
            if nxt is None:
                continue
            days = (nxt - today).days
            if days in (0, lead):
                upcoming.append((person.get("name", "Familienmitglied"), days))
        if not upcoming:
            return
        # Commit before sending to avoid duplicate notices if the scheduler ticks again.
        state["birthday_last_sent"] = today.isoformat()
        await hub["store"].async_save(state)
        devices = dict(state.get("push_settings", {}).get("devices", {}))
        parents = [m["id"] for m in state.get("members", []) if m.get("role") == "parent"
                   and _notify_category(state, m["id"], "birthday") and not _notify_in_quiet(state, now)]
    lines = [f"🎉 {name} hat heute Geburtstag!" if days == 0 else f"🎁 {name} hat in {days} Tagen Geburtstag." for name, days in upcoming]
    message = "\n".join(lines)
    persistent_notification.async_create(hass, message, title="Family Hub – Geburtstage", notification_id=f"{DOMAIN}_birthdays")
    available = _mobile_services(hass)
    for service in set(devices.get(pid, "") for pid in parents):
        if service and service in available:
            try:
                await hass.services.async_call("notify", service, {"title": "🎂 Family Hub – Geburtstag", "message": message}, blocking=True)
            except Exception:
                pass  # The in-HA notification remains visible if the phone is offline.


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/notification_center_save",
    vol.Required("quiet_enabled"): bool,
    vol.Required("quiet_start"): vol.All(vol.Coerce(int), vol.Range(min=0, max=23)),
    vol.Required("quiet_end"): vol.All(vol.Coerce(int), vol.Range(min=0, max=23)),
    vol.Required("categories"): dict,
})
@websocket_api.async_response
async def ws_notification_center_save(hass, connection, msg):
    hub = hass.data.get(DOMAIN)
    if not hub or not _owner(connection):
        connection.send_error(msg["id"], "unauthorized", "Nur Eltern dürfen Erinnerungen ändern")
        return
    categories = msg["categories"]
    members = {member["id"] for member in hub["state"]["members"]}
    allowed = {"tasks", "birthday", "work", "schoolbag", "events"}
    if len(categories) > 50 or any(mid not in members or not isinstance(kinds, dict) or
        len(kinds) > 5 or any(kind not in allowed or type(value) is not bool
            for kind, value in kinds.items()) for mid, kinds in categories.items()):
        connection.send_error(msg["id"], "invalid_settings", "Ungültige Benachrichtigungseinstellungen")
        return
    async with hub["lock"]:
        hub["state"]["notification_center"] = {
            "quiet_enabled": msg["quiet_enabled"], "quiet_start": msg["quiet_start"],
            "quiet_end": msg["quiet_end"], "categories": categories,
        }
        await hub["store"].async_save(hub["state"])
    connection.send_result(msg["id"], _visible_state(hub, connection))


async def _send_extra_notifications(hass):
    """Opt-in schoolbag and event alerts, protected from repeats across restarts."""
    hub = hass.data.get(DOMAIN)
    if not hub or "state" not in hub:
        return
    now = dt_util.now()
    async with hub["lock"]:
        state = hub["state"]
        if _notify_in_quiet(state, now):
            return
        members = list(state.get("members", []))
        devices = dict(state.get("push_settings", {}).get("devices", {}))
        events = list(state.get("events", []))
        already = set(state.get("extra_alert_sent", []))
        available = set(_mobile_services(hass))
        messages = []
        today = now.date().isoformat()
        tomorrow = (now.date() + timedelta(days=1)).isoformat()
        for member in members:
            mid = member["id"]
            target = devices.get(mid, "")
            if not target or target not in available:
                continue
            # Schoolbag reminder only in the evening before a day with actual items.
            if _notify_category(state, mid, "schoolbag") and now.hour >= 18:
                items = _pack_items(state, mid, tomorrow)
                outstanding = {i["key"]: i for i in items}
                for check in state.get("school_pack_checks", []):
                    if check.get("member_id") == mid and check.get("date") == tomorrow:
                        outstanding.pop(check.get("key"), None)
                key = f"schoolbag:{mid}:{tomorrow}"
                if outstanding and key not in already:
                    names = ", ".join(i["name"] for i in list(outstanding.values())[:7])
                    messages.append((key, target, "🎒 Schultasche für morgen", f"Hallo {member['name']}! Für morgen einpacken: {names}."))
            # Family Hub appointments only; Google calendar remains read-only and has its own notifications.
            if _notify_category(state, mid, "events"):
                for event in events:
                    if mid not in event.get("members", []) or event.get("all_day"):
                        continue
                    try:
                        start = datetime.fromisoformat(event.get("start", ""))
                        if start.tzinfo is None:
                            start = start.replace(tzinfo=now.tzinfo)
                        minutes = (start - now).total_seconds() / 60
                    except (TypeError, ValueError):
                        continue
                    key = f"event:{mid}:{event.get('id', '')}:{start.isoformat()}"
                    # The five-minute scheduler can catch the whole preceding hour.
                    if 0 < minutes <= 60 and key not in already:
                        messages.append((key, target, "📅 Termin in Kürze", f"Hallo {member['name']}! {event.get('title', 'Termin')[:100]} beginnt um {start.strftime('%H:%M')} Uhr."))
    for key, target, title, message in messages:
        try:
            await _send_to_mobile(hass, target, title, message)
        except Exception as err:
            _LOGGER.warning("Family Hub konnte Erinnerung nicht versenden: %s", err)
            continue
        async with hub["lock"]:
            history = hub["state"].setdefault("extra_alert_sent", [])
            if key not in history:
                history.append(key)
                hub["state"]["extra_alert_sent"] = history[-1500:]
                await hub["store"].async_save(hub["state"])


def _register_commands_once(hass: HomeAssistant) -> None:
    """Ensure all websocket commands are available to the configured panel."""
    hub_data = hass.data.setdefault(DOMAIN, {})
    if hub_data.get("commands_registered"):
        return
    for command in (
        ws_version, ws_notification_center_save, ws_birthday_settings_save, ws_reminder_settings_save, ws_reminder_test, ws_push_diagnose, ws_push_devices, ws_push_settings_save, ws_push_test, ws_state, ws_member_save, ws_member_delete,
        ws_task_save, ws_task_toggle, ws_task_delete,
        ws_routine_save, ws_routine_delete, ws_routine_toggle, ws_school_mode_save, ws_school_year_start, ws_school_year_restore, ws_school_save, ws_school_delete, ws_school_absence_save, ws_school_absence_delete, ws_school_holiday_save, ws_school_holiday_refresh, ws_school_pack_config_save, ws_school_pack_toggle, ws_work_save, ws_work_delete, ws_work_exception_save, ws_work_exception_delete, ws_work_alert_save,
        ws_list_save, ws_list_item_add, ws_list_item_toggle, ws_list_item_delete, ws_list_reset, ws_list_delete,
        ws_reward_save, ws_reward_delete, ws_reward_redeem,
        ws_event_save, ws_event_delete,
        ws_calendar_sources, ws_calendar_select, ws_calendar_member_assign, ws_calendar_events,
        ws_child_accounts, ws_child_assign, ws_child_qr, ws_tablet_enter, ws_tablet_select, ws_tablet_settings_save, ws_display_settings_save,
        ws_child_task_create, ws_child_event_create, ws_challenge_settings_save, ws_family_reward_claim, ws_meal_week,
    ):
        websocket_api.async_register_command(hass, command)
    hub_data["commands_registered"] = True


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Register commands during regular integration setup as well."""
    _register_commands_once(hass)
    return True
