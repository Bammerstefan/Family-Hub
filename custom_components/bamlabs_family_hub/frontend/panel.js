/* BamLabs Family Hub — no external libraries, local Home Assistant storage. */
const FAMILY_HUB_UI_VERSION = "1.4.0";
class BamLabsFamilyHubPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({mode: "open"});
    this.data = {school_years:[],school_year_active:{},birthday_settings:{enabled:false,days_before:7,hour:8},members: [], tasks: [], routines: [], routine_checks: [], events: [], external_calendars: [], calendar_members: {}, rewards: [], pro_savings_goals: [], pro_goal_history: [], pro_goal_requests: [], pro_badge_settings: {}, pro_badge_awards: [], point_entries: [], task_completions: [], school_plan: [], school_modes: {}, school_absences: [], school_holiday_settings: {}, school_holiday_cache: {}, school_pack_settings: {}, school_pack_checks: [], work_plan: [], work_exceptions: [], family_lists: [], family_challenge: {enabled:false,goal:30}, overview_settings:{order:["tasks","events","work","birthdays","school","meals"],hidden:[]}};
    this.externalEvents = [];
    this.externalSources = [];
    this.externalError = "";
    this.externalBusy = false;
    this.externalRange = "";
    this.externalLastSync = null;
    this.externalLastAttempt = 0;
    this._syncInterval = null;
    this.calendarMode = "month";
    this.calendarAnchor = new Date();
    this.weekAnchor = new Date();
    this.weekMemberFilter = "";
    this.editEvent = null;
    this.tab = "today";
    this._lastRenderedTab = null;
    this.mealWeekAnchor = new Date();
    this.mealWeekData = null;
    this.mealWeekBusy = false;
    this.mealWeekError = "";
    this.busy = false;
    this.loaded = false;
    this.error = "";
    this.editMember = null;
    this.editTask = null;
    this.editRoutine = null;
    this.editSchool = null;
    this.schoolNewFor = null;
    this.schoolNewDay = 0;
    this.editSchoolAbsence = null;
    this.schoolAbsenceOpen = false;
    this.packOpenFor = {};
    this.packDay = "tomorrow";
    this.editWork = null;
    this.workNewFor = null;
    this.workNewDay = 0;
    this.editList = null;
    this.listTypeFilter = "all";
    this.childAccounts = null;
    this.qrFor = null;
    this.childForm = null;
    this.showCalendarSetup = false;
    this.pushDevices = [];
    this.pushDevicesLoaded = false;
    this.pushSettingsOpen = false;
    this.notificationCenterOpen = false;
    this.overviewSettingsOpen = false;
    this.maintenanceOpen = false;
    this.maintenanceReport = null;
    this.overviewDraft = null;
    this.taskFilter = "";
    this.backendVersion = "";
    this.savedNotice = "";
    this.displayMode = false;
    this.displaySlide = 0;
    this.displaySettingsOpen = false;
    this._displayInterval = null;
    this._lastSlide = Date.now();
    this._mountedOnce = false;
  }
  connectedCallback() {
    // HA normally re-mounts the custom panel after navigating away and back.
    // On re-entry, return the restricted tablet account to the name selection.
    if (this._mountedOnce && this.loaded && this._hass && this.data._tablet_mode) {
      this.displayMode=false;
      this.load();
    }
    this._mountedOnce=true;
    // Refresh visible calendar data regularly while this panel is mounted.
    // Home Assistant's Google integration remains responsible for Google polling.
    if (!this._displayInterval) {
      this._displayInterval = setInterval(() => {
        if(!this.isConnected || !this.loaded || !this.displayMode)return;
        const settings=this.data.display_settings||{};
        const seconds=settings.rotate_seconds||30;
        if(Date.now()-this._lastSlide>=seconds*1000) {
          this.displaySlide+=1;
          this._lastSlide=Date.now();
          this.render();
        } else {
          const clock=this.shadowRoot.querySelector(".display-time");
          const date=this.shadowRoot.querySelector(".display-date");
          const now=new Date();
          if(clock)clock.textContent=now.toLocaleTimeString("de-AT",{hour:"2-digit",minute:"2-digit"});
          if(date)date.textContent=now.toLocaleDateString("de-AT",{weekday:"long",day:"numeric",month:"long",year:"numeric"});
        }
      }, 10000);
    }
    if (!this._syncInterval) {
      this._syncInterval = setInterval(() => {
        if (this.isConnected && this.loaded && this._hass) this.refreshExternalEvents(true);
      }, 5 * 60 * 1000);
    }
  }
  disconnectedCallback() {
    if (this._displayInterval) clearInterval(this._displayInterval);
    this._displayInterval=null;
    if (this._syncInterval) clearInterval(this._syncInterval);
    this._syncInterval = null;
  }
  set hass(value) {
    this._hass = value;
    if (!this.loaded && !this.busy) this.load();
  }
  async load() {
    if (!this._hass) return;
    this.busy = true;
    try {
      this.data = await this._hass.callWS({type:"bamlabs_family_hub/tablet_enter"});
      this.tab = "today";
      this.mealWeekData = null;
      this.loaded = true;
      this.error = "";
      this.checkVersion();
      if (this.data._role === "admin") {
        this.loadCalendarSources();
        this.loadPushDevices();
        this.refreshExternalEvents();
        // Read-only preview, loaded only if Meal Planner is present.
        if (this.data._meal_planner_available) this.loadMealWeek();
      }
    } catch(e) { this.error = e.message || String(e); }
    finally { this.busy = false; this.render(); }
  }
  async checkVersion() {
    try {
      const info = await this._hass.callWS({type:"bamlabs_family_hub/version"});
      this.backendVersion = info.backend_version || "unbekannt";
    } catch (e) {
      this.backendVersion = "nicht abrufbar";
    }
    this.render();
  }
  reloadHub() {
    // A cache-busted page navigation refreshes the browser view.
    // Installing a new integration release is done through Marketplace.
    const url = new URL(window.location.href);
    url.searchParams.set("family_hub_refresh", String(Date.now()));
    window.location.assign(url.toString());
  }
  async request(type, payload={}) {
    if (this.busy) return;
    this.busy = true;
    try {
      this.data = await this._hass.callWS({type:`bamlabs_family_hub/${type}`, ...payload});
      this.error = "";
      const saveLabels={display_settings_save:"Bildschirmmodus",calendar_select:"Kalenderauswahl",calendar_member_assign:"Kalenderzuordnung",reminder_settings_save:"Erinnerungseinstellungen",push_settings_save:"Handy-Einstellungen",member_save:"Familienmitglied",task_save:"Aufgabe",routine_save:"Tagesablauf",school_save:"Wochenplan-Eintrag",school_mode_save:"Plantyp",school_absence_save:"Ferien / Abwesenheit",school_pack_config_save:"Schultaschen-Packliste",work_save:"Dienstplan",list_save:"Liste",list_item_add:"Listeneintrag",list_reset:"Liste",tablet_settings_save:"Tablet-Zugang",challenge_settings_save:"Familien-Challenge",family_reward_claim:"Familienbelohnung",event_save:"Termin",reward_save:"Belohnung",pro_goal_save:"PRO-Sparziel",pro_goal_deposit:"Sterne zurückgelegt",pro_goal_complete:"Wunsch abgeschlossen",pro_goal_request:"Sparwunsch angefragt",pro_goal_request_decide:"Sparwunsch bearbeitet",pro_badge_settings_save:"Abzeichen-Einstellung"};
      this.savedNotice = saveLabels[type] ? `✅ ${saveLabels[type]} erfolgreich gespeichert.` : "";
      if(type === "tablet_settings_save" && this.childAccounts) this.childAccounts.tablet_user_id=payload.user_id;
      this.editMember = null;
      this.editTask = null;
      this.editEvent = null;
      if (type === "list_save") this.editList = null;
    } catch(e) { this.error = e.message || String(e); this.savedNotice = ""; }
    finally { this.busy = false; this.render(); }
  }
  async loadCalendarSources() {
    if (!this._hass) return;
    try { this.externalSources = await this._hass.callWS({type:"bamlabs_family_hub/calendar_sources"}); this.render(); }
    catch(e) { this.externalError = e.message || String(e); this.render(); }
  }
  async selectCalendars(ids) {
    if (!this._hass || this.externalBusy) return;
    this.externalBusy = true;
    try {
      this.data = await this._hass.callWS({type:"bamlabs_family_hub/calendar_select", entity_ids:ids});
      this.externalEvents = []; this.externalRange = ""; this.externalLastSync = null; this.externalError = "";
      this.savedNotice = "✅ Kalenderauswahl erfolgreich gespeichert.";
    } catch(e) { this.externalError = e.message || String(e); }
    finally { this.externalBusy = false; this.render(); this.refreshExternalEvents(); }
  }
  async assignCalendarMember(entityId, memberId) {
    if (!this._hass || this.externalBusy) return;
    this.externalBusy = true;
    try {
      this.data = await this._hass.callWS({type:"bamlabs_family_hub/calendar_member_assign", entity_id:entityId, member_id:memberId});
      this.externalError = "";
      this.savedNotice = "✅ Kalenderzuordnung erfolgreich gespeichert.";
    } catch(e) {this.externalError = e.message || String(e); this.savedNotice = "";}
    finally {this.externalBusy = false; this.render();}
  }
  calendarMemberPicker(src) {
    const wrap = this.el("label","field");
    wrap.append(this.el("span","field-title",`Person für „${src.name}“`));
    const dropdown = this.el("select");
    const blank = this.el("option",null,"Gemeinsamer Kalender (grün)"); blank.value = ""; dropdown.append(blank);
    for(const member of this.data.members) {
      const opt = this.el("option",null,member.name); opt.value = member.id; dropdown.append(opt);
    }
    dropdown.value = (this.data.calendar_members || {})[src.id] || "";
    dropdown.addEventListener("change",()=>this.assignCalendarMember(src.id,dropdown.value));
    wrap.append(dropdown);
    return wrap;
  }
  async refreshExternalEvents(force=false) {
    if (!this._hass || !this.loaded || this.externalBusy || this.data._role === "child") return;
    // Avoid repeated network requests when the user quickly changes views.
    if (force && Date.now() - this.externalLastAttempt < 15000) return;
    const a=this.tab === "week" ? this.weekAnchor : this.calendarAnchor;
    const start=this.addDays(this.monday(new Date(a.getFullYear(),a.getMonth(),1)),-7);
    const end=this.addDays(this.monday(new Date(a.getFullYear(),a.getMonth()+1,0)),13);
    const from=this.isoDate(start), to=this.isoDate(end), range=`${from}|${to}`;
    if (!force && this.externalRange===range) return;
    if (!(this.data.external_calendars||[]).length) { this.externalEvents=[];this.externalRange=range;this.render();return; }
    this.externalBusy = true;
    this.externalLastAttempt = Date.now();
    try {
      const result = await this._hass.callWS({type:"bamlabs_family_hub/calendar_events", start:from, end:to});
      this.externalEvents = result.events || []; this.externalRange = range;
      this.externalLastSync = new Date();
      this.externalError = "";
    } catch(e) { this.externalError = e.message || String(e); }
    finally { this.externalBusy = false; this.render(); }
  }
  el(tag, cls, value) {
    const node=document.createElement(tag);
    if(cls) node.className=cls;
    if(value!==undefined) node.textContent=value;
    return node;
  }
  memberName(id) { return this.data.members.find(m=>m.id===id)?.name || "Unbekannt"; }
  completedFor(task, mid) {return (task.done_members || (task.done ? task.assignees || [] : [])).includes(mid);}
  completedForAll(task) {return (task.assignees || []).length ? task.assignees.every(mid=>this.completedFor(task,mid)) : !!task.done;}
  setTaskMember(taskId, memberId) {return this.request("task_toggle",{task_id:taskId,member_id:memberId});}

  dateLabel(value) { if (!value) return "Ohne Fälligkeit"; const [y,m,d]=value.split("-"); return `${d}.${m}.${y}`; }
  button(text, action, cls="btn") {
    const b=this.el("button", cls, text); b.type="button"; b.disabled=this.busy; b.addEventListener("click",action);return b;
  }
  input(label,type,value,name) {
    const w=this.el("label","field"); w.append(this.el("span","field-title",label));
    const inp=this.el("input"); inp.type=type;inp.name=name;inp.value=value||"";
    if(type==="text") inp.maxLength=160;
    w.append(inp);return w;
  }
  cardTitle(text) { return this.el("h2", "heading", text); }
  render() {
    const root=this.shadowRoot;
    root.replaceChildren();
    const style=this.el("style");
    style.textContent=`
      :host {display:block;min-height:100%;font-family:var(--primary-font-family,system-ui,-apple-system,sans-serif);color:var(--primary-text-color,#192238);background:var(--primary-background-color,#f5f7fb)}
      *,*:before,*:after{box-sizing:border-box}button,input,select,textarea{font:inherit}button{cursor:pointer}
      .overview-editor{display:grid;gap:9px;margin:15px 0}.overview-editor-row{display:flex;align-items:center;gap:9px;border:1px solid var(--divider-color,#dde3eb);background:var(--card-background-color,#fff);padding:10px;border-radius:12px;min-width:0}.overview-editor-row input{width:21px;height:21px;flex-shrink:0}.overview-editor-name{flex:1;min-width:0;font-weight:650}.overview-move{padding:7px 11px;min-width:38px}.page{max-width:1120px;margin:0 auto;padding:24px 20px 60px}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}.brand{font-size:25px;font-weight:800;letter-spacing:-.6px}.small{font-size:13px;color:var(--secondary-text-color,#697386)}.nav{display:flex;gap:9px;overflow:auto;margin:23px 0}.tab{border:1px solid var(--divider-color,#dfe5ee);background:var(--card-background-color,#fff);padding:11px 16px;border-radius:12px;color:inherit;white-space:nowrap;font-weight:650}.tab.selected{background:#1464db;color:white;border-color:#1464db}
      .grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:15px}.panel{padding:21px;background:var(--card-background-color,#fff);border:1px solid var(--divider-color,#dfe5ee);border-radius:18px;box-shadow:0 2px 10px #00000008;margin-bottom:16px}.stat{font-size:32px;font-weight:800;margin-top:10px}.heading{font-size:19px;margin:0 0 16px}.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.btn{padding:10px 14px;border-radius:10px;background:#1464db;border:1px solid #1464db;color:#fff;font-weight:650}.secondary{background:transparent;color:var(--primary-text-color,#192238);border-color:var(--divider-color,#cfd6df)}.danger{color:#c32929}.list{display:grid;gap:12px;margin-top:12px}.item{display:flex;align-items:center;gap:13px;border:1px solid var(--divider-color,#e4e8ef);border-radius:12px;padding:12px}.item-main{flex:1;min-width:0}.item-title{font-weight:700;overflow-wrap:anywhere}.desc{font-size:13px;white-space:pre-wrap;margin-top:5px;color:var(--secondary-text-color,#697386)}.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}.chip{display:inline-block;padding:4px 9px;border-radius:999px;background:var(--secondary-background-color,#eef1f6);font-size:12px}.dot{width:15px;height:15px;border-radius:50%;flex-shrink:0;border:1px solid #0002}.check{width:21px;height:21px;cursor:pointer}.done .item-title{text-decoration:line-through;opacity:.6}.field{display:grid;gap:5px;font-weight:650;font-size:14px}.field input,.field textarea,.field select{width:100%;min-height:39px;color:var(--primary-text-color,#192238);background:var(--card-background-color,#fff);border:1px solid var(--divider-color,#cbd3de);border-radius:9px;padding:9px}.field textarea{min-height:86px}.formgrid{display:grid;grid-template-columns:1fr 1fr;gap:13px;margin:15px 0}.full{grid-column:1/-1}.colors{display:flex;gap:8px;flex-wrap:wrap}.person-choice{display:flex;gap:7px;align-items:center;padding:6px 0}.save-success{padding:14px 17px;border-radius:12px;background:#e4f7e9;color:#195c31;font-weight:750;margin:0 0 15px;border:1px solid #a5dfb6}.notice{padding:13px 15px;border-radius:10px;background:#fff2dd;color:#6f4a0b;margin-bottom:15px}.empty{color:var(--secondary-text-color,#697386);padding:24px 0;text-align:center}.footer{margin-top:35px;text-align:center}.tag-high{color:#ba3d25}.muted{color:var(--secondary-text-color,#697386)}.calbar{display:flex;align-items:center;gap:10px;justify-content:space-between;flex-wrap:wrap;margin:12px 0 18px}.calgrid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:5px}.calday{min-height:104px;border:1px solid var(--divider-color,#dfe5ee);border-radius:10px;padding:6px;min-width:0;background:var(--card-background-color,#fff)}.calday.outside{opacity:.48}.daynum{font-weight:750;margin-bottom:6px}.calentry{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%;border:0;border-left:4px solid #1464db;background:var(--secondary-background-color,#eef1f6);text-align:left;border-radius:5px;margin:3px 0;padding:5px;color:var(--primary-text-color,#192238);font-size:12px}.calweek{display:grid;gap:9px}.calendar-stack{display:grid;gap:7px}.calhead{font-size:12px;text-align:center;font-weight:700;padding:8px 2px;color:var(--secondary-text-color,#697386)}.caldate{font-weight:750;margin:8px 0}.calfilters{display:flex;gap:7px;flex-wrap:wrap}
      .week-days{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:9px}.week-column{border:1px solid var(--divider-color,#dfe5ee);border-radius:12px;padding:10px;min-width:0}.week-column.today{border-color:var(--primary-color,#1464db);border-width:2px}.week-card{padding:8px;margin-top:9px;background:var(--secondary-background-color,#eef1f6);border-radius:9px;border-left:4px solid #1464db;overflow-wrap:anywhere;font-size:13px}.week-card .check{width:18px;height:18px}.week-check{display:flex;gap:8px;align-items:flex-start}.week-meta{font-size:11px;opacity:.8;margin-top:4px}.week-summary{margin:10px 0 18px}.week-column h3{font-size:14px;margin:0 0 7px}.week-column .small{font-size:11px} .progress-person{border-top:1px solid var(--divider-color,#dfe5ee);padding:14px 0;display:grid;gap:8px}.progress-head{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center}.progress-track{height:12px;background:var(--secondary-background-color,#eef1f6);border-radius:999px;overflow:hidden}.progress-fill{height:100%;border-radius:999px;transition:width .2s}.progress-person .btn{justify-self:start} 
      .child-welcome{margin-bottom:16px}.child-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:16px}.child-stat{display:grid;gap:4px;align-content:center;border-radius:13px;background:var(--secondary-background-color,#eef1f6);padding:12px;text-align:center}.child-stat-number{font-size:24px;font-weight:800}.child-task{min-height:62px;cursor:pointer}.child-task .check{width:28px;height:28px;flex-shrink:0}.child-action{min-height:48px;margin-top:12px}
      .hero-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:16px}.hero-card{padding:18px;border-radius:18px;background:linear-gradient(180deg,#ffffff,#f7faff);border:1px solid var(--divider-color,#dfe5ee);box-shadow:0 2px 10px #00000006}.hero-icon{font-size:28px}.hero-value{font-size:30px;font-weight:800;margin-top:6px}.hero-label{font-size:14px;color:var(--secondary-text-color,#697386);margin-top:4px}.big-link-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:16px 0 20px}.big-link{display:grid;gap:6px;align-content:start;text-align:left;padding:18px;border-radius:18px;border:1px solid var(--divider-color,#dfe5ee);background:var(--card-background-color,#fff)}.big-link-icon{font-size:28px}.big-link-title{font-weight:800;font-size:18px}.big-link small{font-size:13px;color:var(--secondary-text-color,#697386)}.member-card-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.member-card{border:1px solid var(--divider-color,#dfe5ee);border-radius:18px;padding:16px;background:var(--card-background-color,#fff);display:grid;gap:10px}.member-head{display:flex;align-items:center;gap:12px}.member-avatar{width:46px;height:46px;border-radius:50%;display:grid;place-items:center;color:#fff;font-weight:800;font-size:19px;flex-shrink:0}.member-name{font-size:18px;font-weight:800}.member-task-count{font-size:14px;color:var(--secondary-text-color,#697386)}.member-badges{display:flex;gap:8px;flex-wrap:wrap}.member-badge{padding:6px 10px;border-radius:999px;background:var(--secondary-background-color,#eef1f6);font-size:13px;font-weight:700}.section-note{margin-top:-8px;margin-bottom:16px}.focus-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.kid-hero{background:linear-gradient(135deg,#fff6cc,#ffe8f0 50%,#ecf6ff);border:1px solid #f2df9d}.kid-big-title{font-size:28px;font-weight:900;line-height:1.1}.kid-sub{font-size:15px;color:#4d5b73}.kid-quick-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:14px}.child-big-btn{display:grid;gap:6px;justify-items:center;align-content:center;text-align:center;min-height:92px;padding:14px;border-radius:18px;border:0;background:#ffffff}.child-big-btn span:first-child{font-size:30px}.child-big-btn strong{font-size:18px}.kid-section-title{font-size:24px;font-weight:900;margin:0 0 8px}.kid-section-note{font-size:14px;color:var(--secondary-text-color,#697386);margin-bottom:12px}.kid-stack{display:grid;gap:12px}.kid-empty{padding:18px;border-radius:16px;background:#fff9e8;border:1px dashed #e6d28b;font-weight:700}.mini-note{font-size:12px;color:var(--secondary-text-color,#697386)}
      .brand{font-weight:900;letter-spacing:-.7px}.page{max-width:1280px}.nav{gap:8px;flex-wrap:wrap;overflow:visible}.tab{border-radius:17px;padding:11px 16px}.tab.selected{background:linear-gradient(120deg,#3784d7,#7461ce);border-color:#5c70d0;color:#fff}.panel{border-radius:21px}.big-link{transition:transform .15s,box-shadow .15s;box-shadow:0 5px 15px #1c31550c}.big-link:hover,.child-big-btn:hover{transform:translateY(-2px)}.hero-card:nth-child(1){background:#f0eaff}.hero-card:nth-child(2){background:#e4f7ed}.hero-card:nth-child(3){background:#fff0d9}.hero-card:nth-child(4){background:#e7f4ff} .hero-action{display:grid;text-align:left;justify-items:start;color:#283348!important;cursor:pointer;min-height:150px;transition:transform .15s,box-shadow .15s} .hero-action:hover{transform:translateY(-2px);box-shadow:0 9px 24px #39205f22}.hero-action:focus-visible{outline:3px solid #216db8;outline-offset:3px}.hero-action .hero-value,.hero-action .hero-label{color:#283348}.hero-hint{font-size:13px;margin-top:6px;font-weight:750;color:#6048a1}.kid-quick-grid{grid-template-columns:repeat(4,minmax(0,1fr))}.child-big-btn{border:1px solid #ebe4f1;box-shadow:0 5px 14px #50638510}.child-task{border-radius:17px;min-height:76px}.child-task .check{width:32px;height:32px}.member-card{border-radius:21px}.big-link:focus-visible,.tab:focus-visible,.routine-step:focus-visible,.child-big-btn:focus-visible{outline:3px solid #0077c8;outline-offset:3px}
      .routine-hero{background:linear-gradient(135deg,#fff5dc,#f1e9ff 55%,#e5f8f2);border:1px solid #e7ddec}.routine-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.routine-card{border-radius:22px;padding:19px;background:var(--card-background-color,#fff);border:1px solid var(--divider-color,#e4e8ef);box-shadow:0 7px 22px #1e35510c}.routine-head{display:flex;gap:13px;align-items:center;margin-bottom:12px}.routine-emoji{font-size:40px;line-height:1}.routine-name{font-size:23px;font-weight:850}.routine-step-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.routine-step{position:relative;border:2px solid var(--divider-color,#dfe5ee);border-radius:17px;background:#f7f9ff;color:var(--primary-text-color,#192238);padding:14px 10px;min-height:108px;display:grid;justify-items:center;align-content:center;gap:7px;text-align:center;font-weight:800}.routine-step strong{font-size:15px}.routine-step .routine-symbol{font-size:32px}.routine-step.done{background:#e4f9ed;border-color:#69c58d}.routine-step.done strong{text-decoration:none}.routine-meter{height:12px;border-radius:99px;background:#ebedf3;overflow:hidden;margin:10px 0}.routine-meter-fill{height:100%;background:linear-gradient(90deg,#6ab6ee,#66d0a3);border-radius:99px}.routine-management{display:grid;gap:12px}.routine-form-steps{display:grid;gap:8px;grid-column:1/-1}.routine-step-edit{display:grid;grid-template-columns:100px 1fr auto;gap:8px;align-items:center}.routine-day{display:inline-flex;align-items:center;gap:6px;padding:7px 10px;border-radius:12px;background:var(--secondary-background-color,#f0f2f6);margin:3px}.routine-day input{width:20px;height:20px}.routine-avatar{font-size:14px;font-weight:800;border-radius:40px;padding:5px 10px;background:#f1f4ff}.kid-hero{box-shadow:0 10px 28px #6d8fd214}.panel{box-shadow:0 5px 19px #2b45680b}.tab{min-height:46px}.btn{min-height:42px}.routine-quiet{font-size:13px;color:var(--secondary-text-color,#697386)} .today-routines{margin:14px 0 25px} .routine-person-label{border-left:5px solid #6d7e9c;padding:7px 12px;margin-bottom:12px;border-radius:8px;background:var(--secondary-background-color,#eef1f6);font-weight:800;font-size:16px}
      .tablet-picker-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:16px;margin:20px 0}.tablet-person{border:2px solid var(--divider-color,#dfe5ee);background:var(--card-background-color,#fff);color:var(--primary-text-color,#192238);border-radius:22px;min-height:170px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;font-size:21px;font-weight:800;cursor:pointer}.tablet-person-avatar{height:86px;width:86px;border-radius:50%;color:#fff;display:grid;place-items:center;font-size:35px;font-weight:900}.tablet-person:focus-visible{outline:4px solid #1464db;outline-offset:3px}.tablet-person{border-color:var(--person-color,#dfe5ee);border-width:3px;background:linear-gradient(180deg,var(--person-tint,#f3f6fb),var(--card-background-color,#fff));min-height:190px}.tablet-person-avatar{background:var(--person-color,#5685d1);font-size:42px;box-shadow:0 5px 15px #00000013}.tablet-person strong{font-size:24px}.tablet-person .small{font-size:13px}
      @media(max-width:700px){.routine-grid{grid-template-columns:1fr}.routine-step-edit{grid-template-columns:85px 1fr}.routine-step-edit button{grid-column:1/-1}.routine-step-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.routine-step{min-height:104px}}

      /* Clearly separated mobile reminder settings for large families. */
      .push-toggle{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;text-align:left;padding:16px 18px;border:1px solid var(--divider-color,#dfe5ee);border-radius:16px;background:var(--secondary-background-color,#eef1f6);color:var(--primary-text-color,#192238);font-weight:800;font-size:17px;min-height:58px}
      .push-toggle:focus-visible{outline:3px solid #2485dd;outline-offset:2px}
      .push-person-list{display:grid;gap:16px;margin:20px 0}
      .push-person-card{border:1px solid var(--divider-color,#dfe5ee);border-left:6px solid var(--person-accent,#6b90d6);border-radius:17px;padding:18px;background:var(--card-background-color,#fff);display:grid;gap:12px}
      .push-person-heading{display:flex;align-items:center;gap:10px;font-size:18px;font-weight:850;border-bottom:1px solid var(--divider-color,#dfe5ee);padding-bottom:12px}
      .push-person-avatar{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:var(--person-accent,#6b90d6);color:white;font-size:17px;font-weight:800}
      .push-person-card .field{margin:0}.push-person-card .person-choice{margin:0}.push-person-actions{border-top:1px solid var(--divider-color,#dfe5ee);padding-top:13px;display:flex;gap:10px}
      .push-person-actions .btn{min-height:46px}
      /* Family tablet: show all activities grouped by person, never mixed between children. */
      .routine-person-list{display:grid;gap:24px}
      .routine-person-group{border-radius:22px;overflow:hidden;border:1px solid var(--divider-color,#dfe5ee);background:var(--card-background-color,#fff)}
      .routine-person-head{padding:18px 20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
      .routine-person-avatar{width:52px;height:52px;display:grid;place-items:center;border-radius:50%;background:#ffffff25;border:2px solid currentColor;font-weight:900;font-size:25px;flex-shrink:0}
      .routine-person-heading{display:grid;gap:4px;flex:1;min-width:120px}
      .routine-person-heading strong{font-size:24px}
      .routine-person-heading span{font-size:14px;font-weight:600}
      .routine-person-status{border:1px solid currentColor;border-radius:999px;padding:7px 11px;font-size:14px;font-weight:800}
      .routine-person-progress{padding:0 20px}
      .routine-person-cards{padding:12px 18px 20px;display:grid;gap:14px;grid-template-columns:1fr}
      .routine-person-cards .routine-card{margin:0}
      /* High-contrast labels on light routine buttons in Home Assistant dark mode. */
      .routine-step{color:#253349!important;background:#f7f9ff}
      .routine-step .small{color:#52647c!important}
      .routine-step.done{color:#14532d!important;background:#e4f9ed}
      .routine-step.done .small{color:#166534!important}
      @media(max-width:650px){.routine-person-head{padding:14px 12px}.routine-person-heading strong{font-size:20px}.routine-person-cards{padding:10px}.routine-person-status{font-size:12px}}

      .school-person{margin:18px 0;padding:14px;border:1px solid var(--divider-color,#dfe5ee);border-radius:19px}.school-person-head{display:flex;align-items:center;gap:12px;padding:8px 12px;margin-bottom:12px;border-radius:12px;background:var(--secondary-background-color,#eef1f6);font-size:20px}.school-avatar{display:grid;place-items:center;color:white;width:40px;height:40px;border-radius:50%;font-weight:850}.school-week{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}.school-day{background:var(--secondary-background-color,#eef1f6);border-radius:16px;padding:12px;min-width:0}.school-day h3{margin:0 0 12px}.school-day-now{outline:3px solid #7ccfb5}.school-entry{display:flex;align-items:center;gap:10px;padding:12px;margin:8px 0;border:1px solid var(--divider-color,#dfe5ee);border-radius:14px;background:var(--card-background-color,#fff);font-size:15px;overflow-wrap:anywhere}.school-entry-icon{font-size:28px}.school-entry-info{display:grid;gap:4px;flex:1;min-width:0}.school-entry .btn{padding:8px;min-width:38px}.school-section .field{min-width:0}
      .family-list-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.family-list-card{border:1px solid var(--divider-color,#dfe5ee);border-radius:20px;padding:18px;background:var(--card-background-color,#fff);min-width:0}.family-list-title{font-size:21px;font-weight:800}.family-list-row{display:flex;align-items:center;gap:12px;border-radius:14px;padding:12px;margin-top:9px;border:1px solid var(--divider-color,#dfe5ee);background:var(--secondary-background-color,#f3f6fa)}.family-list-row input{width:27px;height:27px;flex-shrink:0;accent-color:#21a879}.family-list-row span{font-size:16px;font-weight:650;overflow-wrap:anywhere}.family-list-muted{opacity:.55;text-decoration:line-through}.family-list-actions{margin-top:14px;display:flex;flex-wrap:wrap;gap:8px}.family-list-progress{height:12px;border-radius:20px;background:var(--secondary-background-color,#ecf0f5);overflow:hidden;margin:12px 0}.family-list-progress div{height:100%;background:#30b790;border-radius:20px}.family-list-type{font-size:13px;color:var(--secondary-text-color,#697386)}@media(max-width:780px){.family-list-grid{grid-template-columns:1fr}}

      .display-launch{background:linear-gradient(120deg,#6d54c9,#2775bc);border-color:transparent;min-height:44px}
      .display-wrap{position:relative;min-height:min(76vh,780px);border-radius:30px;overflow:hidden;color:#fff;background:linear-gradient(125deg,#183455,#624680 70%,#d0797e);display:flex;flex-direction:column;padding:clamp(20px,4vw,50px);gap:20px}
      .display-photo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:brightness(.43)}
      .display-shade{position:absolute;inset:0;background:linear-gradient(90deg,#0b2143cc,#18253a40)}
      .display-main{position:relative;display:grid;gap:16px;align-content:center;flex:1;z-index:1}
      .display-time{font-size:clamp(68px,12vw,150px);font-weight:900;line-height:1;letter-spacing:-4px;color:#fff}
      .display-date{font-size:clamp(18px,3vw,31px);font-weight:750;color:#fff}
      .display-next{display:grid;gap:10px;background:#0f244c9c;padding:20px;border-radius:20px;max-width:610px}
      .display-next-item{font-size:clamp(16px,2vw,22px);display:flex;justify-content:space-between;gap:12px}
      .display-controls{z-index:2;display:flex;justify-content:flex-end}.display-exit{background:#ffffff;color:#233452;border:0;border-radius:16px;min-height:48px;padding:12px 18px;font-weight:800}
      .display-intro{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}
      .display-setting-card{border:1px solid var(--divider-color,#dfe5ee);border-radius:18px;padding:18px;margin-top:14px}
      @media(min-width:900px){.page{max-width:1450px}.hero-card{min-height:150px}.big-link{min-height:150px}}
      @media(max-width:650px){.display-wrap{min-height:70vh;padding:18px}.display-time{letter-spacing:-2px}}
      .family-day-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;align-items:start}.family-day-column{background:var(--card-background-color,#fff);border:1px solid var(--divider-color,#dfe5ee);border-radius:22px;padding:18px;min-width:0}.family-day-column.today{border:2px solid #5194ec}.family-day-heading{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:8px}.family-day-heading h2{font-size:24px;margin:0}.family-day-summary{margin:0 0 16px;color:var(--secondary-text-color,#697386);font-size:14px}.family-day-member{border:1px solid var(--divider-color,#dde5ef);border-left:6px solid var(--member-color,#64748b);border-radius:15px;padding:12px;margin:12px 0}.family-day-person{display:flex;align-items:center;gap:9px;font-size:18px;font-weight:800;margin-bottom:10px}.family-day-avatar{display:grid;place-items:center;width:36px;height:36px;border-radius:50%;background:var(--member-color,#64748b);color:white}.family-day-entry{display:flex;align-items:flex-start;gap:10px;margin:7px 0;padding:9px;border-radius:10px;background:var(--secondary-background-color,#f1f5fb);font-size:14px;overflow-wrap:anywhere}.family-day-time{font-weight:800;white-space:nowrap;font-size:13px}.family-day-empty{padding:16px;text-align:center;background:var(--secondary-background-color,#f1f5fb);border-radius:14px}.family-day-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:15px}.family-day-actions .btn{min-height:44px}@media(max-width:850px){.family-day-grid{grid-template-columns:1fr}}
      .kid-week-head{display:flex;align-items:center;gap:12px;margin-bottom:16px}.kid-week-avatar{display:grid;place-items:center;border-radius:50%;width:54px;height:54px;font-size:27px;flex-shrink:0}.kid-week-controls{display:flex;gap:8px;flex-wrap:wrap;justify-content:space-between;align-items:center;margin-bottom:18px}.kid-week-days{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.kid-week-day{border:2px solid var(--divider-color,#dde5ef);background:var(--card-background-color,#fff);border-radius:19px;padding:15px;min-width:0}.kid-week-day.is-today{border-color:var(--kid-color,#3b82f6);box-shadow:0 0 0 2px color-mix(in srgb,var(--kid-color,#3b82f6) 16%,transparent)}.kid-week-date{font-weight:850;font-size:19px;margin-bottom:12px}.kid-week-date small{display:block;font-size:13px;font-weight:500;color:var(--secondary-text-color,#687386)}.kid-week-group{margin-top:12px;display:grid;gap:8px}.kid-week-group-title{font-weight:750;font-size:14px}.kid-week-entry{display:flex;align-items:flex-start;gap:9px;padding:10px;border-radius:12px;background:var(--secondary-background-color,#f1f5fb);overflow-wrap:anywhere}.kid-week-entry .check{width:24px;height:24px;flex-shrink:0}.kid-week-entry-text{font-size:15px;font-weight:650}.kid-week-empty{color:var(--secondary-text-color,#687386);font-size:13px;padding:12px;background:var(--secondary-background-color,#f1f5fb);border-radius:12px}
      .family-stats-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px;margin-top:18px}.family-stats-person{border:1px solid var(--divider-color,#dfe5ee);border-left:6px solid var(--family-person-color,#6688bb);background:var(--card-background-color,#fff);border-radius:17px;padding:15px;min-width:0}.family-stats-name{font-size:20px;font-weight:850;margin-bottom:12px}.family-stats-counts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.family-stats-number{background:var(--secondary-background-color,#f4f7fa);border-radius:12px;padding:11px 7px;display:flex;flex-direction:column;text-align:center;gap:5px;min-width:0}.family-stats-number strong{font-size:19px}.family-stats-number .small{font-size:11px}.family-challenge-count{font-size:19px;font-weight:850;margin:14px 0}.family-progress-track{height:23px;border-radius:99px;background:var(--secondary-background-color,#e5e9ef);overflow:hidden;border:1px solid var(--divider-color,#dfe5ee)}.family-progress-fill{height:100%;background:linear-gradient(90deg,#19ab9b,#81cd6e);transition:width .2s}.family-challenge-finish{font-weight:850;font-size:20px;padding:18px;border-radius:15px;background:var(--secondary-background-color,#f1f7f0);margin:14px 0}.family-reward-card{border:2px solid var(--divider-color,#dfe5ee);border-radius:16px;padding:16px;margin-top:15px;background:var(--secondary-background-color,#f3f7fb);display:grid;gap:8px}.family-reward-title{font-size:19px;font-weight:800;overflow-wrap:anywhere}.family-reward-card .btn{justify-self:start}.family-challenge-form{display:grid;gap:12px;margin-top:18px;max-width:490px}.family-challenge-toggle{display:flex;align-items:center;gap:12px;cursor:pointer;font-weight:750}.family-challenge-toggle input{width:23px;height:23px}@media(max-width:700px){.family-stats-grid{grid-template-columns:1fr}.family-stats-number strong{font-size:16px}}
      .kid-success-hero{border-top:6px solid var(--success-color,#3b82f6)}.kid-success-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:18px 0}.kid-success-stat{border:1px solid var(--divider-color,#dfe5ee);background:var(--secondary-background-color,#f4f7fa);border-radius:18px;padding:18px 10px;display:flex;align-items:center;flex-direction:column;gap:8px;text-align:center}.kid-success-symbol{font-size:34px}.kid-success-number{font-size:30px}.kid-success-label{font-size:13px;font-weight:700}.kid-success-message{padding:14px;background:var(--secondary-background-color,#f4f7fa);border-radius:14px;font-weight:750;font-size:17px;margin-bottom:20px}.kid-success-days{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px;margin-bottom:18px}.kid-success-day{display:flex;flex-direction:column;align-items:center;gap:7px;padding:12px 3px;border-radius:13px;background:var(--secondary-background-color,#f4f7fa);text-align:center}.kid-success-day.is-today{outline:2px solid var(--success-color,#3b82f6)}.kid-success-dayname{font-size:14px;font-weight:800}.kid-success-dayicon{font-size:26px}.kid-success-daycount{font-size:11px;color:var(--secondary-text-color,#697386)}@media(max-width:650px){.kid-success-stats{grid-template-columns:1fr}.kid-success-days{grid-template-columns:repeat(4,minmax(0,1fr))}}
      @media(max-width:950px){.kid-week-days{grid-template-columns:1fr}.hero-grid,.big-link-grid,.kid-quick-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.member-card-grid,.focus-grid{grid-template-columns:1fr}}@media(max-width:850px){.week-days{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:450px){.week-days{grid-template-columns:1fr}}@media(max-width:650px){.page{padding:14px 12px 40px}.grid{grid-template-columns:1fr 1fr}.formgrid{grid-template-columns:1fr}.item{align-items:flex-start}.actions{gap:5px}.btn{padding:9px 10px}.brand{font-size:22px}.calday{min-height:77px;padding:4px}.calentry{font-size:10px;padding:3px}.daynum{font-size:12px}.child-stats{gap:5px}.child-stat{padding:10px 3px}.child-stat-number{font-size:18px}.child-action{width:100%}.child-task{min-height:66px}.hero-grid,.big-link-grid,.kid-quick-grid{grid-template-columns:1fr}.member-card-grid,.focus-grid{grid-template-columns:1fr}.kid-big-title{font-size:24px}}`;
    style.textContent += `.overview-title{font-size:23px;font-weight:850;margin:0 0 5px}.overview-sub{margin:0 0 14px;color:var(--secondary-text-color,#697386);font-size:14px}.overview-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:18px}.overview-tile{display:grid;align-content:start;gap:9px;min-width:0;padding:16px;border-radius:17px;background:var(--card-background-color,#fff);border:1px solid var(--divider-color,#dfe5ee);border-left:5px solid #5b8cef;text-align:left;color:var(--primary-text-color,#192238);min-height:118px}.overview-tile:hover{box-shadow:0 5px 20px #00000012}.overview-tile:focus-visible{outline:3px solid var(--primary-color,#1464db);outline-offset:2px}.overview-tile strong{font-size:16px}.overview-tile .overview-line{font-size:14px;line-height:1.45;overflow-wrap:anywhere}.overview-tile .overview-note{font-size:12px;color:var(--secondary-text-color,#697386)}@media(min-width:1000px){.overview-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:520px){.overview-grid{grid-template-columns:minmax(0,1fr)}.overview-tile{min-height:auto;padding:14px}}`;
    style.textContent += `.school-year-archive{margin:12px 0;padding:12px;border:1px solid var(--divider-color,#cbd5e1);border-radius:12px}.school-year-archive summary{cursor:pointer;font-weight:700;line-height:1.6}.school-year-archive .actions{align-items:end;flex-wrap:wrap}.school-year-archive .actions .field{min-width:180px;flex:1}.school-year-archive .item{min-width:0;flex-wrap:wrap}`;
    style.textContent += `.birthday-row{display:flex;align-items:center;gap:12px;padding:12px;margin:10px 0;border-left:5px solid #9e81d4;background:var(--secondary-background-color,#f1f5fb);border-radius:12px;min-width:0}.birthday-avatar{font-size:29px;flex-shrink:0}.birthday-countdown{font-size:14px;white-space:nowrap}.birthday-panel{margin-top:14px}@media(max-width:390px){.birthday-row{gap:7px;padding:9px}.birthday-countdown{font-size:12px}}`;
    style.textContent += `.meal-week-days{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:16px}.meal-day-card{border:1px solid var(--divider-color,#dce2ea);border-radius:16px;padding:15px;background:var(--card-background-color,#fff)}.meal-day-card.today{border:3px solid var(--primary-color,#39afaa)}.meal-day-title{font-weight:850;font-size:19px;margin-bottom:12px}.meal-row{padding:10px;border-radius:10px;background:var(--secondary-background-color,#f4f7fc);margin-top:8px;display:flex;flex-direction:column;gap:4px}.meal-row strong{font-size:13px}.meal-row span{font-size:17px;font-weight:750;overflow-wrap:anywhere}@media(max-width:680px){.meal-week-days{grid-template-columns:1fr}}`;
    style.textContent += `.school-absence-panel{margin:16px 0;padding:14px;border:1px solid var(--divider-color,#aaa);border-radius:16px}.school-absence-panel>.btn{width:100%;text-align:left}.school-absence-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:10px;border-radius:12px;background:var(--secondary-background-color,#eee);margin:8px 0}.school-absence-row>span{flex:1;min-width:170px;overflow-wrap:anywhere}.school-live-info{display:flex;flex-wrap:wrap;gap:10px;padding:12px;background:var(--secondary-background-color,#eee);border-left:5px solid var(--primary-color,#03a9f4);border-radius:10px;margin:10px 0}.school-absence-badge{border:1px solid var(--warning-color,#eab308);background:var(--secondary-background-color,#eee);border-radius:10px;padding:12px;font-weight:700;margin:10px 0}`;
    style.textContent += `.kid-lesson-entry{display:block;padding:10px 12px;min-width:0;overflow-wrap:normal}.kid-lesson-info{display:flex;flex-wrap:wrap;align-items:center;gap:5px 12px;min-width:0}.kid-lesson-time{display:inline-block;flex:0 0 auto;font-size:12px;font-weight:750;color:var(--secondary-text-color,#687386);white-space:nowrap}.kid-lesson-entry .kid-week-entry-text{flex:1 1 125px;min-width:0;overflow-wrap:break-word;word-break:normal}.kid-lesson-entry.is-current{outline:2px solid var(--kid-color,#3b82f6);background:color-mix(in srgb,var(--kid-color,#3b82f6) 12%,var(--secondary-background-color,#f1f5fb))}.kid-lesson-entry.is-past{opacity:.7}.kid-school-status{margin:12px 0;padding:12px 14px;border-radius:12px;background:color-mix(in srgb,var(--kid-color,#3b82f6) 13%,var(--card-background-color,#fff));border:1px solid var(--kid-color,#3b82f6);line-height:1.5}.kid-routines-fold{margin-top:12px;border:1px solid var(--divider-color,#dde5ef);border-radius:12px;padding:10px 12px}.kid-routines-fold summary{cursor:pointer;list-style:revert;padding:3px}.kid-routines-fold .kid-week-entry{margin-top:8px}@media(max-width:450px){.kid-lesson-info{gap:3px 10px}.kid-lesson-entry .kid-week-entry-text{flex-basis:100%}}`;
    style.textContent += `.school-pack-settings{border:1px solid var(--divider-color,#999);border-radius:15px;padding:13px;margin:14px 0;min-width:0}.school-pack-settings>.btn{width:100%;text-align:left}.school-pack-switch{display:flex;align-items:center;gap:12px;margin:15px 0;cursor:pointer}.school-pack-switch input{width:23px;height:23px}.school-pack-subject{display:flex;flex-wrap:wrap;align-items:end;gap:8px;margin:12px 0;padding:11px;background:var(--secondary-background-color,#eee);border-radius:12px}.school-pack-subject>.field{flex:1 1 230px;min-width:0}.school-pack-subject input{max-width:100%;box-sizing:border-box}.school-pack-subject button{flex:none;min-height:43px}.school-pack-days{display:flex;flex-wrap:wrap;gap:10px;margin:15px 0}.school-pack-child{border-top:5px solid var(--kid-color,#3b82f6)}.school-pack-progress{font-size:18px;font-weight:800;margin:12px 0}.school-pack-item{display:flex;align-items:center;gap:14px;margin:10px 0;border-radius:14px;background:var(--secondary-background-color,#eee);padding:16px;min-height:55px;cursor:pointer}.school-pack-item input{width:25px;height:25px;flex:none;accent-color:var(--kid-color,#3b82f6)}.school-pack-item span{display:flex;flex-direction:column;gap:5px;min-width:0}.school-pack-item strong{font-size:17px;overflow-wrap:break-word}.school-pack-item small{color:var(--secondary-text-color,#777)}.school-pack-item.done{opacity:.75}.school-pack-item.done strong{text-decoration:line-through}.school-pack-finished{padding:17px;border:2px solid var(--kid-color,#3b82f6);border-radius:14px;font-weight:800;margin-top:14px}`;
    style.textContent += `.work-week{grid-template-columns:repeat(auto-fit,minmax(min(100%,295px),1fr));align-items:stretch}.work-week .school-day{min-width:0}.work-entry{display:grid;grid-template-columns:32px minmax(0,1fr);align-items:start;gap:10px;padding:12px}.work-entry .school-entry-icon{font-size:24px;line-height:1.4}.work-entry-info{min-width:0;overflow-wrap:break-word;word-break:normal}.work-entry-info strong{font-size:16px;line-height:1.35}.work-entry-info .small{font-size:13px;line-height:1.5;overflow-wrap:normal;white-space:normal}.work-entry-actions{grid-column:1/-1;display:flex;justify-content:flex-end;gap:8px;margin-top:2px}.work-entry-actions .btn{min-width:42px;min-height:40px;flex:none}.hub-content-start{scroll-margin-top:14px;height:1px}.work-date-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,270px),1fr));gap:12px;margin:12px 0 22px}.work-date-card{min-width:0;padding:14px;border:1px solid var(--divider-color,#555);border-radius:15px;background:var(--secondary-background-color,#262626);display:flex;flex-direction:column;gap:10px}.work-date-person{padding:6px 9px;font-weight:700;background:var(--card-background-color,#222);border-radius:8px}.work-date-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:9px;background:var(--card-background-color,#222);border-radius:8px;overflow-wrap:anywhere}.work-date-row>span{min-width:0;flex:1 1 130px}.work-date-row .btn{padding:7px 10px;flex:none}@media(max-width:700px){.work-week,.work-date-grid{grid-template-columns:1fr}}`;
    style.textContent += `.pro-badge-person{border:1px solid var(--divider-color,#666);border-left:5px solid var(--badge-color,#7d78df);border-radius:16px;padding:14px;margin:14px 0;min-width:0}.pro-badge-person h3{margin:0 0 12px}.pro-badge-switch{display:flex;gap:12px;align-items:center;padding:12px;background:var(--secondary-background-color,#333);border-radius:12px;cursor:pointer;font-weight:700}.pro-badge-switch input{accent-color:var(--primary-color,#4a9ed8);height:24px;width:24px;flex:none}.pro-badge-count{font-weight:800;margin:14px 0}.pro-badge-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,175px),1fr));gap:10px}.pro-badge-tile{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:8px;padding:14px 9px;min-width:0;min-height:135px;border-radius:14px;background:var(--secondary-background-color,#333);border:1px solid var(--divider-color,#555)}.pro-badge-tile.is-unlocked{border:2px solid var(--badge-color,#7d78df)}.pro-badge-tile.is-locked{opacity:.7}.pro-badge-tile .pro-badge-icon{font-size:32px}.pro-badge-tile strong{font-size:14px;overflow-wrap:anywhere}.pro-badge-tile .small{font-size:12px}.pro-badge-tile.is-new{animation:pro-badge-pop .65s ease-out 1}@keyframes pro-badge-pop{0%{transform:scale(.88)}55%{transform:scale(1.055)}100%{transform:scale(1)}}@media(prefers-reduced-motion:reduce){.pro-badge-tile.is-new{animation:none}}@media(max-width:430px){.pro-badge-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.pro-badge-tile{min-height:125px;padding:10px 6px}}`;
    root.append(style);
    const page=this.el("main","page");
    const header=this.el("div","top");
    const left=this.el("div");left.append(this.el("div","brand","🏡 BamLabs Family Hub"),this.el("div","small","Bunt, einfach und freundlich für die ganze Familie"));
    const tools=this.el("div","actions");
    const versionText=this.backendVersion
      ? `Oberfläche v${FAMILY_HUB_UI_VERSION} · Backend v${this.backendVersion}`
      : `Oberfläche v${FAMILY_HUB_UI_VERSION}`;
    tools.append(this.el("span","small",versionText));
    const reload=this.button("🔄 Aktualisieren",()=>this.reloadHub(),"btn secondary");
    reload.title="Oberfläche neu laden. Neue Versionen über den Marketplace installieren.";
    tools.append(reload);
    header.append(left,tools);page.append(header);
    if(this.backendVersion && this.backendVersion!==FAMILY_HUB_UI_VERSION && this.backendVersion!=="nicht abrufbar") {
      page.append(this.el("div","notice",`Oberfläche und Backend haben verschiedene Versionen (${versionText}). Bitte das Update im Marketplace installieren, Home Assistant neu starten und dann Aktualisieren drücken.`));
    }
    if(this.loaded && this.displayMode) {
      this.renderDisplay(page);
      root.append(page);
      return;
    }
    if(this.loaded && this.data._role === "tablet_picker") {
      this.renderTabletPicker(page);
      root.append(page);
      return;
    }
    if(this.loaded && this.data._tablet_mode) {
      const switchBar=this.el("div","actions");
      switchBar.append(this.button("👧 Kind wechseln",()=>this.selectTabletMember(""),"btn secondary"));
      page.append(switchBar);
    }
    if(this.loaded && this.data._role !== "tablet_picker" && this.data.display_settings?.enabled) {
      const displayActions=this.el("div","actions");
      displayActions.append(this.button("🖼️ Bildschirmmodus",()=>{this.displayMode=true;this._lastSlide=Date.now();this.render();},"btn display-launch"));
      page.append(displayActions);
    }
    const nav=this.el("nav","nav");
    const child = this.data._role === "child";
    const assignedParent=child && this.data.members?.[0]?.role==="parent";
    const tabs = child ? [["today","🌞 Heute"],["childweek","🗓️ Meine Woche"],["success","🏆 Erfolge"],["routines","🌈 Mein Tag"],["school","🎒 Schule"],["lists","🛒 Listen"],["tasks","✅ Aufgaben"],["calendar","📅 Termine"]]
                       : [["today","🏡 Start"],["dayplan","📋 Tagesplan"],["familystats","🏆 Familie"],["week","🗓️ Woche"],["routines","🌈 Routinen"],["school","🎒 Schule & Kita"],["work","💼 Dienstplan"],["lists","🛒 Listen"],["calendar","📅 Kalender"],["tasks","✅ Aufgaben"],["members","👨‍👩‍👧 Familie"],["settings","⚙️ Einstellungen"]];
    if(child && !assignedParent && this.data.school_pack_settings?.[this.data.members?.[0]?.id]?.enabled) tabs.splice(5,0,["pack","🎒 Schultasche"]);
    if(assignedParent){const schoolTab=tabs.find(t=>t[0]==="school");if(schoolTab){schoolTab[0]="work";schoolTab[1]="💼 Mein Dienstplan";}}
    if(this.data._meal_planner_available) tabs.push(["meals","🍽️ Unser Essen"]);
    tabs.forEach(([id,label])=>{
      nav.append(this.button(label,()=>{this.tab=id;this.editMember=null;this.editTask=null;this.editEvent=null;this.render();if(id==="meals")this.loadMealWeek();if((id==="calendar"||id==="week"||id==="dayplan")&&!child)this.refreshExternalEvents();},`tab ${this.tab===id?"selected":""}`));
    });page.append(nav);
    if(this.savedNotice) page.append(this.el("div","save-success",this.savedNotice));
    if(this.error) page.append(this.el("div","notice",`Hinweis: ${this.error}`));
    // Admin: content follows the navigation directly. Children have a separate
    // welcome/shortcut card, so their scroll target is inserted after that card.
    if(!child) page.append(this.el("div","hub-content-start"));
    if(!this.loaded) {page.append(this.el("div","panel",this.busy?"Daten werden geladen …":"Keine Verbindung zu Family Hub. Bitte Integration prüfen."));root.append(page);return;}
    if(child){
      this.renderChild(page);
    }else{
      if(this.tab==="today") this.renderToday(page);
      if(this.tab==="dayplan") this.renderDayPlan(page);
      if(this.tab==="familystats") this.renderFamilyStats(page);
      if(this.tab==="routines") this.renderRoutines(page);
      if(this.tab==="school") this.renderSchool(page);
      if(this.tab==="pack") this.renderSchoolPack(page);
      if(this.tab==="work") this.renderWork(page);
      if(this.tab==="lists") this.renderLists(page);
      if(this.tab==="week") this.renderWeek(page);
      if(this.tab==="members") this.renderMembers(page);
      if(this.tab==="calendar") this.renderCalendar(page);
      if(this.tab==="tasks") this.renderTasks(page);
      if(this.tab==="settings") this.renderSettings(page);
      if(this.tab==="meals") this.renderMealWeek(page);
    }
    page.append(this.el("div","small footer","Der Family Hub speichert die Familiendaten lokal in Home Assistant."));
    root.append(page);
    // Scroll only when the selected section actually changes, not when data refreshes.
    // This also handles the large children menu and its shortcut tiles.
    const moved=this._lastRenderedTab!==null && this._lastRenderedTab!==this.tab;
    this._lastRenderedTab=this.tab;
    if(moved){
      requestAnimationFrame(()=>{
        if(this.isConnected && this._lastRenderedTab===this.tab){
          this.shadowRoot.querySelector(".hub-content-start")?.scrollIntoView({behavior:"smooth",block:"start"});
        }
      });
    }
  }
  async selectTabletMember(memberId) {
    if(this.busy) return;
    this.busy=true;
    try {
      this.data=await this._hass.callWS({type:"bamlabs_family_hub/tablet_select", member_id:memberId});
      this.tab="today";
      this.error="";
      this.savedNotice="";
    } catch(e) { this.error=e.message||String(e); }
    finally {this.busy=false;this.render();}
  }
  renderTabletPicker(page) {
    const panel=this.el("section","panel");
    panel.append(this.cardTitle("🌈 Wer bist du?"));
    panel.append(this.el("p","small","Tippe auf dein farbiges Bild. Hier könnt ihr euch am selben Tablet abwechseln."));
    const grid=this.el("div","tablet-picker-grid");
    for(const member of this.data.members||[]) {
      const btn=this.button("",()=>this.selectTabletMember(member.id),"tablet-person");
      btn.style.setProperty("--person-color",member.color||"#5685d1");
      btn.style.setProperty("--person-tint",(member.color||"#5685d1")+"20");
      const avatar=this.el("span","tablet-person-avatar",member.avatar||"🙂");
      btn.append(avatar,this.el("strong",null,member.name),this.el("span","small","Antippen & loslegen"));
      grid.append(btn);
    }
    if(!grid.childNodes.length)panel.append(this.el("p","small","Noch keine Familienmitglieder eingerichtet."));
    panel.append(grid);
    panel.append(this.el("p","small","🔒 Erwachseneinstellungen sind mit dem Tablet-Konto nicht zugänglich. Die Farben und Symbole können Eltern im Profil bearbeiten."));
    page.append(panel);
  }
  renderWeek(page) {
    const start=this.monday(this.weekAnchor);
    const end=this.addDays(start,6);
    const from=this.isoDate(start), to=this.isoDate(end);
    const today=this.isoDate(new Date());
    const panel=this.el("section","panel");
    panel.append(this.cardTitle("🗓️ Wochenplan der Familie"));
    panel.append(this.el("p","small","Alle Termine und fälligen Aufgaben auf einen Blick. Häkchen ändern den Aufgabenstatus direkt."));
    const controls=this.el("div","calbar");
    const dates=this.el("div","actions");
    dates.append(this.button("‹ Vorherige",()=>this.shiftWeek(-7),"btn secondary"));
    dates.append(this.button("Diese Woche",()=>{this.weekAnchor=new Date();this.render();this.refreshExternalEvents();},"btn secondary"));
    dates.append(this.button("Nächste ›",()=>this.shiftWeek(7),"btn secondary"));
    controls.append(dates);
    controls.append(this.el("strong",null,`${this.dateLabel(from)} – ${this.dateLabel(to)}`));
    const filter=this.el("label","field");
    filter.append(this.el("span",null,"Person"));
    const select=this.el("select");
    const all=this.el("option",null,"Alle Familienmitglieder");all.value="";select.append(all);
    for(const member of this.data.members){const option=this.el("option",null,member.name);option.value=member.id;select.append(option);}
    select.value=this.weekMemberFilter;
    select.addEventListener("change",()=>{this.weekMemberFilter=select.value;this.render();});
    filter.append(select);controls.append(filter);panel.append(controls);
    const visible=(members)=>!this.weekMemberFilter||!members?.length||(members||[]).includes(this.weekMemberFilter);
    const allTasks=(this.data.tasks||[]).filter(t=>!t.done&&t.due&&t.due>=from&&t.due<=to&&visible(t.assignees));
    // Only items overlapping the week are shown, including multi-day and repeating events.
    const events=this.occurrences(from,to).filter(o=>visible(o.event.members));
    const summary=this.el("div","small week-summary",`${allTasks.length} offene Aufgaben · ${events.length} Termine in dieser Woche`);
    panel.append(summary);
    const days=this.el("div","week-days");
    for(let i=0;i<7;i++) {
      const date=this.addDays(start,i), iso=this.isoDate(date);
      const day=this.el("section",`week-column${iso===today?" today":""}`);
      day.append(this.el("h3",null,date.toLocaleDateString("de-AT",{weekday:"long",day:"numeric",month:"numeric"})));
      const tasks=allTasks.filter(t=>t.due===iso);
      for(const task of tasks) {
        const card=this.el("div","week-card");
        const row=this.el("div","week-check");
        row.append(this.el("span",null,task.title));card.append(row);
        if(task.assignees?.length>1){
          task.assignees.forEach(mid=>{
            if(this.weekMemberFilter && this.weekMemberFilter!==mid)return;
            const cb=this.el("input","check");cb.type="checkbox";cb.checked=this.completedFor(task,mid);cb.disabled=this.busy;
            cb.addEventListener("change",()=>this.setTaskMember(task.id,mid));
            const label=this.el("label","person-choice");label.append(cb,this.el("span",null,this.memberName(mid)));card.append(label);
          });
        }else{
          const cb=this.el("input","check");cb.type="checkbox";cb.checked=!!task.done;cb.disabled=this.busy;
          cb.addEventListener("change",()=>this.setTaskMember(task.id,task.assignees?.[0]||""));
          row.prepend(cb);
        }
        const assigned=(task.assignees||[]).map(id=>this.memberName(id)).join(", ");
        if(assigned)card.append(this.el("div","week-meta",assigned));
        if(task.points)card.append(this.el("div","week-meta",`⭐ ${task.points} Punkte`));
        if(task.assignees?.length===1){const person=this.data.members.find(m=>m.id===task.assignees[0]);if(person)card.style.borderLeftColor=person.color;}
        day.append(card);
      }
      for(const occurrence of events.filter(o=>o.start<=iso&&o.end>=iso)) {
        const card=this.el("div","week-card");card.style.borderLeftColor=this.eventColor(occurrence.event);
        const label=occurrence.time&&occurrence.start===iso?`${occurrence.time} ${occurrence.event.title}`:occurrence.event.title;
        card.append(this.el("div",null,label));
        if(occurrence.event.members?.length)card.append(this.el("div","week-meta",occurrence.event.members.map(id=>this.memberName(id)).join(", ")));
        if(occurrence.event.external)card.append(this.el("div","week-meta","Home Assistant · nur lesen"));
        day.append(card);
      }
      if(!tasks.length&&!events.some(o=>o.start<=iso&&o.end>=iso))day.append(this.el("div","small","Keine Einträge"));
      days.append(day);
    }
    panel.append(days);
    const actions=this.el("div","actions");actions.style.marginTop="20px";
    actions.append(this.button("+ Aufgabe",()=>{this.tab="tasks";this.editTask={title:"",description:"",due:from,priority:"normal",repeat:"none",points:0,assignees:[]};this.render();}));
    actions.append(this.button("+ Termin",()=>{this.tab="calendar";this.calendarAnchor=new Date(start);this.editEvent={title:"",description:"",start:`${from}T09:00`,end:`${from}T10:00`,all_day:false,repeat:"none",members:[]};this.render();},"btn secondary"));
    panel.append(actions);
    page.append(panel);
    if(this.externalError)page.append(this.el("div","notice",`Kalendersynchronisierung: ${this.externalError}`));
  }
  shiftWeek(days) {
    this.weekAnchor=this.addDays(this.weekAnchor,days);
    this.render();
    this.refreshExternalEvents();
  }
  renderDayPlan(page) {
    const intro=this.el("section","panel");
    intro.append(this.cardTitle("📋 Heute & morgen in unserer Familie"));
    intro.append(this.el("p","small","Alle wichtigen Dinge an einem Platz: Termine, Aufgaben, Schule und Tagesabläufe – nach Personen geordnet."));
    const actions=this.el("div","actions");
    actions.append(this.button("✅ Aufgaben bearbeiten",()=>{this.tab="tasks";this.render();},"btn secondary"));
    actions.append(this.button("📅 Kalender öffnen",()=>{this.tab="calendar";this.render();this.refreshExternalEvents();},"btn secondary"));
    actions.append(this.button("🌈 Routinen öffnen",()=>{this.tab="routines";this.render();},"btn secondary"));
    intro.append(actions);page.append(intro);

    const columns=this.el("div","family-day-grid");
    const first=new Date();
    for(let offset=0;offset<2;offset++) {
      const date=this.addDays(first,offset), iso=this.isoDate(date), weekday=(date.getDay()+6)%7;
      const personEvents=this.occurrences(iso,iso);
      const dayTasks=(this.data.tasks||[]).filter(t=>t.due && (offset===0 ? t.due<=iso : t.due===iso));
      const dayRoutines=(this.data.routines||[]).filter(r=>(r.days||[]).includes(weekday));
      const school=(this.data.school_plan||[]).filter(x=>Number(x.weekday)===weekday && !this.schoolAbsenceFor(x.member_id,iso) && (this.data.members||[]).some(m=>m.id===x.member_id&&m.role!=="parent"));
      const work=(this.data.members||[]).filter(m=>m.role==="parent").flatMap(m=>this.workForDate(m.id,date).map(x=>({...x,member_id:m.id})));
      const col=this.el("section",`family-day-column${offset===0?" today":""}`);
      const heading=this.el("div","family-day-heading");
      heading.append(this.el("h2",null,offset===0?"🌞 Heute":"🌤️ Morgen"),this.el("strong",null,date.toLocaleDateString("de-AT",{weekday:"short",day:"numeric",month:"short"})));
      col.append(heading);
      const count=dayTasks.length+personEvents.length+school.length+work.length+dayRoutines.length;
      col.append(this.el("p","family-day-summary",count?`${count} Einträge für diesen Tag` : "Heute ist noch nichts geplant"));
      let any=false;
      const members=[...(this.data.members||[]),{id:"",name:"Gemeinsam",color:"#64748b",avatar:"🏡"}];
      for(const member of members){
        const mid=member.id;
        const tasks=dayTasks.filter(t=>mid ? (t.assignees||[]).includes(mid)&&!this.completedFor(t,mid) : !(t.assignees||[]).length&&!this.completedForAll(t));
        const events=personEvents.filter(o=>mid ? (o.event.members||[]).includes(mid) : !(o.event.members||[]).length);
        const schoolAbsence=mid?this.schoolAbsenceFor(mid,iso):null;
        const schoolItems=schoolAbsence?[]:school.filter(x=>mid && x.member_id===mid).sort((a,b)=>(a.time||"").localeCompare(b.time||""));
        const workItems=work.filter(x=>mid && x.member_id===mid).sort((a,b)=>(a.time||"").localeCompare(b.time||""));
        const routines=dayRoutines.filter(r=>mid && (r.member_ids||[]).includes(mid));
        if(!tasks.length&&!events.length&&!schoolItems.length&&!workItems.length&&!routines.length&&!schoolAbsence)continue;
        any=true;
        const group=this.el("div","family-day-member");group.style.setProperty("--member-color",member.color||"#64748b");
        const header=this.el("div","family-day-person");
        header.append(this.el("span","family-day-avatar",member.avatar||member.name.slice(0,1).toUpperCase()),this.el("span",null,member.name));
        group.append(header);
        const add=(icon,text)=>{const item=this.el("div","family-day-entry");item.append(this.el("span",null,icon),this.el("span",null,text));group.append(item);};
        events.forEach(o=>add("📅",`${o.time?o.time+" · ":""}${o.event.title}`));
        if(schoolAbsence)add("🏖️",this.schoolAbsenceText(schoolAbsence));
        schoolItems.forEach(e=>add(e.icon||"🎒",`${e.time?e.time+" · ":""}${e.title}`));
        workItems.forEach(e=>add("💼",`${e.time?e.time+(e.end_time?"–"+e.end_time:"")+" · ":""}${this.workKindLabel(e)}`));
        routines.forEach(r=>{
          const total=(r.steps||[]).length;
          if(offset===0){
            const done=(r.steps||[]).filter(step=>this.routineDone(r,mid,step.id)).length;
            add(r.icon||"🌈",`${r.title} · ${done} von ${total} geschafft`);
          }else add(r.icon||"🌈",`${r.title} · ${total} Schritte`);
        });
        tasks.forEach(t=>add(t.icon||"✅",`${t.title}${offset===0 && t.due<iso?" · überfällig":""}`));
        col.append(group);
      }
      if(!any)col.append(this.el("div","family-day-empty","🎉 Alles frei – keine offenen Einträge!"));
      const shortcuts=this.el("div","family-day-actions");
      shortcuts.append(this.button("➕ Aufgabe",()=>{this.tab="tasks";this.editTask={title:"",description:"",due:iso,priority:"normal",repeat:"none",points:0,assignees:[]};this.render();},"btn secondary"));
      shortcuts.append(this.button("➕ Termin",()=>{this.tab="calendar";this.calendarAnchor=new Date(`${iso}T12:00:00`);this.editEvent={title:"",description:"",start:`${iso}T09:00`,end:`${iso}T10:00`,all_day:false,repeat:"none",members:[]};this.render();},"btn secondary"));
      col.append(shortcuts);columns.append(col);
    }
    page.append(columns);
    page.append(this.el("p","small","Erledigte Aufgaben werden pro Person ausgeblendet. Morgen sind Routinen nur eine Vorschau; abhaken kannst du sie am jeweiligen Tag. Kalender aus Home Assistant werden lesend eingeblendet."));
  }
  birthdayDays(person, now=new Date()) {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(person.birthday||""))return null;
    const bits=person.birthday.split("-").map(Number);
    const year=now.getFullYear();
    const anniversary=(y)=>{const d=new Date(y,bits[1]-1,bits[2],12);return d.getMonth()===bits[1]-1?d:new Date(y,1,28,12);};
    const start=new Date(year,now.getMonth(),now.getDate(),12);
    let next=anniversary(year);if(next<start)next=anniversary(year+1);
    return {days:Math.round((next-start)/86400000),date:next};
  }
  renderBirthdays(page, compact=false) {
    const people=(this.data.members||[]).map(person=>({person,next:this.birthdayDays(person)})).filter(x=>x.next!==null).sort((a,b)=>a.next.days-b.next.days);
    if(!people.length)return;
    const card=this.el("section","panel birthday-panel");card.append(this.cardTitle("🎂 Unsere nächsten Geburtstage"));
    people.slice(0,compact?2:8).forEach(({person,next})=>{
      const row=this.el("div","birthday-row");row.style.borderLeftColor=person.color||"#8c7de0";
      row.append(this.el("span","birthday-avatar",person.avatar||"🎂"));
      const body=this.el("div","item-main");body.append(this.el("strong",null,person.name),this.el("div","small",next.date.toLocaleDateString("de-AT",{day:"numeric",month:"long"})));
      row.append(body,this.el("strong","birthday-countdown",next.days===0?"🎉 Heute!":next.days===1?"Morgen!":`Noch ${next.days} Tage`));card.append(row);
    });
    page.append(card);
  }
  renderFamilyOverview(page, today, iso, due, events) {
    // Compact, parent-only summary. All data is derived from existing state.
    const section=this.el("section","family-overview");
    section.append(this.el("h2","overview-title","🏡 Heute auf einen Blick"));
    section.append(this.el("p","overview-sub",today.toLocaleDateString("de-AT",{weekday:"long",day:"numeric",month:"long",year:"numeric"})));
    const grid=this.el("div","overview-grid");
    const configured=this.data.overview_settings||{};
    const keys=["tasks","events","work","birthdays","school","meals"];
    const order=Array.isArray(configured.order)&&configured.order.length===keys.length&&keys.every(k=>configured.order.includes(k))?configured.order:keys;
    const hidden=Array.isArray(configured.hidden)?configured.hidden:[];
    const tiles=new Map();
    const tile=(key,title,lines,tab,color,note)=>{
      const btn=this.button("",()=>{
        this.tab=tab;
        this.render();
        if(tab==="calendar"||tab==="dayplan")this.refreshExternalEvents();
        if(tab==="meals"&&!this.mealWeekData&&!this.mealWeekBusy)this.loadMealWeek();
      },"overview-tile");
      btn.style.borderLeftColor=color;
      btn.append(this.el("strong",null,title));
      for(const line of lines.slice(0,3))btn.append(this.el("div","overview-line",line));
      if(note)btn.append(this.el("div","overview-note",note));
      tiles.set(key,btn);
    };
    const taskCount=(this.data.tasks||[]).filter(t=>!this.completedForAll(t)).length;
    tile("tasks","✅ Aufgaben",[`${due.length} heute fällig`,`${taskCount} insgesamt offen`],"tasks","#24a879","Tippen zum Erledigen");
    const timed=events.slice().sort((a,b)=>(a.time||"").localeCompare(b.time||""));
    tile("events","📅 Termine",timed.length?timed.slice(0,2).map(x=>`${x.time?x.time+" · ":""}${x.event.title}`):["Heute keine Familientermine"],"calendar","#5385db",`${events.length} heute`);
    const shifts=(this.data.members||[]).filter(m=>m.role==="parent").flatMap(m=>this.workForDate(m.id,today).map(s=>({name:m.name,shift:s}))).sort((a,b)=>(a.shift.time||"").localeCompare(b.shift.time||""));
    tile("work","💼 Dienstzeiten",shifts.length?shifts.slice(0,3).map(x=>`${x.name}: ${x.shift.time?x.shift.time+(x.shift.end_time?"–"+x.shift.end_time:"")+" · ":""}${this.workKindLabel(x.shift)}`):["Heute keine Dienste eingetragen"],"work","#b180da",shifts.length>3?`+ ${shifts.length-3} weitere`:"Dienstplan öffnen");
    const birthdays=(this.data.members||[]).map(person=>({person,next:this.birthdayDays(person,today)})).filter(x=>x.next&&x.next.days<=30).sort((a,b)=>a.next.days-b.next.days);
    tile("birthdays","🎂 Geburtstage",birthdays.length?birthdays.slice(0,2).map(x=>`${x.person.avatar||"🎂"} ${x.person.name}: ${x.next.days===0?"heute!":x.next.days===1?"morgen":`in ${x.next.days} Tagen`}`):["In den nächsten 30 Tagen keine Geburtstage"],"members","#ea9a42","Geburtstage bearbeiten");
    const school=(this.data.school_plan||[]).filter(s=>s.weekday===(today.getDay()+6)%7 && !this.schoolAbsenceFor(s.member_id,iso) && (this.data.members||[]).some(m=>m.id===s.member_id&&m.role!=="parent"));
    const students=[...new Set(school.map(s=>s.member_id))];
    tile("school","🎒 Schule & Kita",students.length?students.slice(0,2).map(id=>`${this.memberName(id)}: ${school.filter(s=>s.member_id===id).length} Einträge`):["Heute keine Schuleinträge"],"school","#dc7ca0",students.length>2?`+ ${students.length-2} weitere Kinder`:"Wochenplan öffnen");
    if(this.data._meal_planner_available){
      const mealDay=this.mealWeekData?.days?.find(d=>d.date===iso);
      const lines=[];
      if(mealDay){
        for(const [key,label] of [["mittag","Mittag"],["abend","Abend"]]) {
          const food=mealDay[key];lines.push(`${label}: ${food?.name?`${food.symbol||"🍽️"} ${food.name}`:"Noch nichts geplant"}`);
        }
      }else lines.push(this.mealWeekBusy?"Speiseplan wird geladen …":"Speiseplan öffnen");
      tile("meals","🍽️ Unser Essen",lines,"meals","#e4a037","Vom BamLabs Meal Planner");
    }
    for(const key of order){if(!hidden.includes(key)&&tiles.has(key))grid.append(tiles.get(key));}
    if(!grid.children.length){
      section.append(this.el("p","small","Alle Kacheln sind ausgeblendet. Unter ⚙️ Einstellungen kannst du sie wieder aktivieren."));
    }else section.append(grid);
    page.append(section);
  }
  renderToday(page) {
    const pending=this.data.tasks.filter(t=>!this.completedForAll(t));
    const today=new Date();
    const localDate=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;
    const due=pending.filter(t=>t.due && t.due<=localDate);
    const todayEvents=this.occurrences(localDate,localDate);

    this.renderFamilyOverview(page,today,localDate,due,todayEvents);
    const stats=this.el("section","hero-grid");
    const todayRoutines=(this.data.routines||[]).filter(r=>this.routineToday(r));
    const pendingRoutineSteps=todayRoutines.reduce((sum,r)=>sum+(r.member_ids||[]).reduce((sub,id)=>sub+(r.steps||[]).filter(step=>!this.routineDone(r,id,step.id)).length,0),0);
    [["🌈",todayRoutines.length,"Routinen heute"],["✅",pending.length,"Offene Aufgaben"],["⏰",due.length,"Heute wichtig"],["📅",todayEvents.length,"Termine heute"]].forEach(([icon,v,l],index)=>{
      const c=index===0?this.button("",()=>{this.tab="routines";this.render();},"hero-card hero-action"):this.el("div","hero-card");
      c.append(this.el("div","hero-icon",icon),this.el("div","hero-value",String(v)),this.el("div","hero-label",l));
      if(index===0){
        c.append(this.el("div","hero-hint",todayRoutines.length?`${pendingRoutineSteps} Schritte noch offen · Jetzt ansehen ›`:"Tippen und Tagesabläufe ansehen ›"));
        c.setAttribute("aria-label",`Routinen öffnen: ${todayRoutines.length} heute, ${pendingRoutineSteps} offene Schritte`);
      }
      stats.append(c);
    });
    page.append(stats);
    this.renderBirthdays(page,true);
    const todaysWork=(this.data.members||[]).filter(m=>m.role==="parent").flatMap(m=>this.workForDate(m.id,today).map(x=>({...x,member_id:m.id})));
    if(todaysWork.length){
      const workPeek=this.el("section","panel");workPeek.append(this.cardTitle("💼 Heute im Dienst"));
      for(const member of (this.data.members||[]).filter(m=>m.role==="parent")){
        for(const entry of todaysWork.filter(s=>s.member_id===member.id).sort((a,b)=>(a.time||"").localeCompare(b.time||""))){
          const row=this.el("div","school-entry");row.append(this.el("span",null,"💼"),this.el("span",null,`${member.name}: ${entry.time?entry.time+(entry.end_time?"–"+entry.end_time:"")+" Uhr · ":""}${this.workKindLabel(entry)}`));workPeek.append(row);
        }
      }
      workPeek.append(this.button("💼 Dienstplan öffnen",()=>{this.tab="work";this.render();},"btn secondary"));page.append(workPeek);
    }
    const todaysSchool=(this.data.school_plan||[]).filter(s=>s.weekday===(today.getDay()+6)%7 && !this.schoolAbsenceFor(s.member_id,this.isoDate(today)) && (this.data.members||[]).some(m=>m.id===s.member_id&&m.role!=="parent"));
    if(todaysSchool.length){
      const schoolPeek=this.el("section","panel");
      schoolPeek.append(this.cardTitle("🎒 Heute in Schule & Kita"));
      const byPerson=this.el("div","member-card-grid");
      for(const m of this.data.members){
        const entries=todaysSchool.filter(x=>x.member_id===m.id).sort((a,b)=>(a.time||"").localeCompare(b.time||""));
        if(!entries.length)continue;
        const group=this.el("section","member-card");
        const head=this.el("div","member-head");
        const marker=this.el("span","school-avatar",m.name.slice(0,1).toUpperCase());marker.style.background=m.color;
        head.append(marker,this.el("strong",null,m.name));group.append(head);
        for(const e of entries)group.append(this.el("div","school-entry",`${e.icon}  ${e.time?e.time+" Uhr · ":""}${e.title}`));
        byPerson.append(group);
      }
      schoolPeek.append(byPerson);
      schoolPeek.append(this.button("🎒 Ganze Woche ansehen",()=>{this.tab="school";this.render();},"btn secondary"));
      page.append(schoolPeek);
    }

    const progress=this.el("section","panel");
    progress.append(this.cardTitle("🧒 Wer hat noch etwas zu tun?"));
    progress.append(this.el("p","small section-note","Es werden nur Familienmitglieder mit offenen Aufgaben angezeigt."));
    if(!this.data.members.length)progress.append(this.el("div","empty","Lege zuerst Familienmitglieder an."));
    const activeMembers=this.data.members.filter(m=>pending.some(t=>(t.assignees||[]).includes(m.id)&&!this.completedFor(t,m.id)));
    if(!activeMembers.length && this.data.members.length) progress.append(this.el("div","empty","🎉 Super! Niemand hat gerade offene zugewiesene Aufgaben."));
    const memberGrid=this.el("div","member-card-grid");
    for(const member of activeMembers){
      const mine=this.data.tasks.filter(t=>(t.assignees||[]).includes(member.id));
      const completed=mine.filter(t=>this.completedFor(t,member.id)).length;
      const open=mine.filter(t=>!this.completedFor(t,member.id)).length;
      const overdue=mine.filter(t=>!this.completedFor(t,member.id)&&t.due&&t.due<localDate).length;
      const dueToday=mine.filter(t=>!this.completedFor(t,member.id)&&t.due===localDate).length;
      const ratio=mine.length?Math.round(completed/mine.length*100):0;
      const block=this.el("div","member-card");
      const head=this.el("div","member-head");
      const avatar=this.el("div","member-avatar",member.name.slice(0,1).toUpperCase()); avatar.style.background=member.color;
      const titleWrap=this.el("div");
      titleWrap.append(this.el("div","member-name",member.name),this.el("div","member-task-count",`${open} offene Aufgabe${open===1?"":"n"}`));
      head.append(avatar,titleWrap); block.append(head);
      const track=this.el("div","progress-track");track.setAttribute("role","progressbar");track.setAttribute("aria-valuenow",String(completed));track.setAttribute("aria-valuemin","0");track.setAttribute("aria-valuemax",String(mine.length));track.setAttribute("aria-label",`Erledigte Aufgaben von ${member.name}`);
      const fill=this.el("div","progress-fill");fill.style.width=`${ratio}%`;fill.style.background=member.color;track.append(fill);block.append(track);
      block.append(this.el("div","small",`${completed} von ${mine.length} geschafft (${ratio} %)`));
      const badges=this.el("div","member-badges");
      badges.append(this.el("span","member-badge",`✅ ${open} offen`));
      if(dueToday)badges.append(this.el("span","member-badge",`📅 ${dueToday} heute`));
      if(overdue)badges.append(this.el("span","member-badge",`⏰ ${overdue} überfällig`));
      block.append(badges);
      block.append(this.button("Aufgaben ansehen",()=>{this.taskFilter=member.id;this.tab="tasks";this.render();},"btn secondary"));
      memberGrid.append(block);
    }
    progress.append(memberGrid);
    page.append(progress);

    const focus=this.el("section","focus-grid");
    const card=this.el("section","panel");
    card.append(this.cardTitle("✅ Heute wichtig"));
    if(!due.length) card.append(this.el("div","empty","Keine fälligen Aufgaben – heute ist alles im grünen Bereich!"));
    else due.sort((a,b)=>a.due.localeCompare(b.due)).forEach(t=>card.append(this.taskRow(t)));
    card.append(this.button("Alle Aufgaben öffnen",()=>{this.tab="tasks";this.render();},"btn secondary"));
    focus.append(card);
    const appointments=this.el("section","panel");appointments.append(this.cardTitle("📅 Heute los"));
    if(!todayEvents.length) appointments.append(this.el("div","empty","Heute keine Termine."));
    else todayEvents.forEach(o=>appointments.append(this.eventRow(o)));
    appointments.append(this.button("Kalender öffnen",()=>{this.tab="calendar";this.render();},"btn secondary"));
    focus.append(appointments);
    page.append(focus);
  }
  isoDate(d) {return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;}
  addDays(date,n) {const d=new Date(date.getFullYear(),date.getMonth(),date.getDate());d.setDate(d.getDate()+n);return d;}
  monday(date) {return this.addDays(date,-((date.getDay()+6)%7));}
  monthStep(date,months) {return new Date(date.getFullYear(),date.getMonth()+months,1);}
  // Expand recurring events only for the visible window. No unbounded loops or stored duplicates.
  occurrences(from,to) {
    const out=[];const fromD=new Date(`${from}T00:00:00`),toD=new Date(`${to}T00:00:00`);
    for(const ev of (this.data.events||[])) {
      const first=new Date(`${ev.start.slice(0,10)}T00:00:00`);
      const endDate=new Date(`${ev.end.slice(0,10)}T00:00:00`);
      const duration=Math.max(0,Math.round((endDate-first)/86400000));
      let occurrence=first;let n=0;
      while(occurrence<=toD && n<10000) {
        const last=this.addDays(occurrence,duration);
        if(last>=fromD && occurrence<=toD){
          const startISO=this.isoDate(occurrence),endISO=this.isoDate(last);
          out.push({event:ev,start:startISO,end:endISO,time:ev.all_day?"":ev.start.slice(11,16)});
        }
        if(ev.repeat==="none")break;
        n++;
        if(ev.repeat==="daily")occurrence=this.addDays(first,n);
        else if(ev.repeat==="weekly")occurrence=this.addDays(first,n*7);
        else if(ev.repeat==="monthly") {
          const target=this.monthStep(first,n);
          if(first.getDate()>new Date(target.getFullYear(),target.getMonth()+1,0).getDate())continue;
          occurrence=new Date(target.getFullYear(),target.getMonth(),first.getDate());
        } else if(ev.repeat==="yearly"){
          const year=first.getFullYear()+n;
          if(first.getMonth()===1 && first.getDate()===29 && new Date(year,1,29).getMonth()!==1)continue;
          occurrence=new Date(year,first.getMonth(),first.getDate());
        } else break;
      }
    }
    for(const ext of this.externalEvents) {
      if(!ext.start || !ext.end)continue;
      const start=ext.start.slice(0,10);
      // HA/ICS all-day end is exclusive, unlike Family Hub's inclusive end.
      let last=ext.end.slice(0,10);
      if(ext.all_day && last>start) last=this.isoDate(this.addDays(new Date(`${last}T00:00:00`),-1));
      if(last<from || start>to)continue;
      const assigned=(this.data.calendar_members||{})[ext.calendar];
      const ev={id:"external",title:ext.title,description:ext.description||"",members:assigned?[assigned]:[],
        start:ext.start,end:ext.end,all_day:ext.all_day,external:true,source:ext.calendar};
      out.push({event:ev,start,end:last,time:ext.all_day?"":ext.start.slice(11,16)});
    }
    // Birthdays are calculated from member profiles, never written as duplicate events.
    if(this.tab === "calendar") {
      const startYear=Number(from.slice(0,4)), endYear=Number(to.slice(0,4));
      for(const member of (this.data.members||[])) {
        if(!/^\d{4}-\d{2}-\d{2}$/.test(member.birthday||"")) continue;
        const month=Number(member.birthday.slice(5,7)), day=Number(member.birthday.slice(8,10));
        for(let year=startYear;year<=endYear;year++) {
          // 29 February is shown on 28 February in non-leap years.
          const realDay=month===2&&day===29&&new Date(year,1,29).getMonth()!==1?28:day;
          const iso=`${year}-${String(month).padStart(2,"0")}-${String(realDay).padStart(2,"0")}`;
          if(iso<from||iso>to)continue;
          const ev={id:`birthday:${member.id}:${year}`,title:`🎂 ${member.name} hat Geburtstag`,
            members:[member.id],all_day:true,start:`${iso}T00:00`,end:`${iso}T23:59`,
            external:true,source:"Geburtstag",description:"Jährlich aus dem Familienprofil"};
          out.push({event:ev,start:iso,end:iso,time:""});
        }
      }
    }
    // Holiday ranges come from the regional cache, not duplicated as editable events.
    if(this.tab === "calendar") {
      for(const person of (this.data.members||[]).filter(m=>m.role!=="parent")) {
        const cfg=(this.data.school_holiday_settings||{})[person.id];
        if(!cfg?.enabled)continue;
        const entries=(this.data.school_holiday_cache||{})[`${cfg.country}:${cfg.region}`]?.entries||[];
        for(const holiday of entries) {
          if(holiday.end<from||holiday.start>to)continue;
          if(holiday.kind==="school"&&cfg.school===false||holiday.kind==="public"&&cfg.public===false)continue;
          const manual=(this.data.school_absences||[]).some(a=>a.member_id===person.id&&a.start<=holiday.end&&a.end>=holiday.start);
          if(manual)continue;
          const ev={id:`holiday:${person.id}:${holiday.start}:${holiday.kind}`,title:`${holiday.kind==="school"?"🏖️":"📅"} ${holiday.name} · ${person.name}`,
            members:[person.id],all_day:true,start:holiday.start+"T00:00",end:holiday.end+"T23:59",external:true,source:"Ferienkalender",description:"Automatisch geladen – nur lesen"};
          out.push({event:ev,start:holiday.start,end:holiday.end,time:""});
        }
      }
    }
    // Work shifts and absences appear read-only in the family calendar only.
    if(this.tab === "calendar") {
    const datesFrom=new Date(`${from}T00:00:00`),datesTo=new Date(`${to}T00:00:00`);
    for(let day=new Date(datesFrom);day<=datesTo;day=this.addDays(day,1)) {
      const iso=this.isoDate(day);
      for(const person of (this.data.members||[]).filter(m=>m.role==="parent")) {
        for(const shift of this.workForDate(person.id,day)) {
          const text=this.workKindLabel(shift);
          const ev={id:"work:"+(shift.id||iso),title:`${person.name} · ${text}`,members:[person.id],all_day:!shift.time,
            start:iso+(shift.time?`T${shift.time}`:"T00:00"),end:iso+(shift.end_time?`T${shift.end_time}`:"T23:59"),external:true,source:"Dienstplan",description:""};
          out.push({event:ev,start:iso,end:iso,time:shift.time||""});
        }
      }
    }
    }
    return out.sort((a,b)=>(a.start+a.time).localeCompare(b.start+b.time));
  }
  eventColor(ev) {return (this.data.members.find(m=>(ev.members||[]).includes(m.id))?.color||(ev.external?"#16a085":"#1464db"));}
  eventRow(o) {
    const ev=o.event;const r=this.el("div","item");const dot=this.el("span","dot");dot.style.background=this.eventColor(ev);r.append(dot);
    const body=this.el("div","item-main");body.append(this.el("div","item-title",ev.title));
    const meta=[`${this.dateLabel(o.start)}${o.end!==o.start?" – "+this.dateLabel(o.end):""}`,ev.all_day?"Ganztägig":ev.start.slice(11,16)+" – "+ev.end.slice(11,16),...(ev.external?[`Home Assistant: ${ev.source}`,...ev.members.map(id=>this.memberName(id))]:ev.members.map(id=>this.memberName(id)))];
    body.append(this.el("div","small",meta.join(" · ")));
    if(ev.description)body.append(this.el("div","desc",ev.description));r.append(body);
    if(ev.external){r.append(this.el("span","chip","Nur lesen"));return r;}
    const buttons=this.el("div","actions");buttons.append(this.button("✎",()=>{this.tab="calendar";this.editEvent={...ev,members:[...ev.members]};this.render();},"btn secondary"));
    buttons.append(this.button("×",()=>{if(confirm(`Termin „${ev.title}“ samt Wiederholungen löschen?`))this.request("event_delete",{event_id:ev.id});},"btn secondary danger"));r.append(buttons);return r;
  }
  renderCalendar(page) {
    const section=this.el("section","panel");section.append(this.cardTitle("Familienkalender"));
    const hint=this.el("div","actions");
    hint.append(this.el("span","small",`${(this.data.external_calendars||[]).length} Home-Assistant-Kalender eingeblendet`));
    hint.append(this.button("⚙️ Kalender einstellen",()=>{this.tab="settings";this.showCalendarSetup=true;this.render();this.loadCalendarSources();},"btn secondary"));
    section.append(hint);
    const bar=this.el("div","calbar"),move=this.el("div","actions");
    move.append(this.button("‹",()=>{this.changeCalendar(-1);},"btn secondary"),this.button("Heute",()=>{this.calendarAnchor=new Date();this.render();},"btn secondary"),this.button("›",()=>{this.changeCalendar(1);},"btn secondary"));bar.append(move);
    const d=this.calendarAnchor;
    const label=this.calendarMode==="month"?d.toLocaleDateString("de-AT",{month:"long",year:"numeric"}):this.calendarMode==="week"?`Woche ab ${this.dateLabel(this.isoDate(this.monday(d)))}`:this.dateLabel(this.isoDate(d));
    bar.append(this.el("strong",null,label));
    const modes=this.el("div","actions");[["day","Tag"],["week","Woche"],["month","Monat"]].forEach(([key,text])=>modes.append(this.button(text,()=>{this.calendarMode=key;this.render();},`btn ${key===this.calendarMode?"":"secondary"}`)));bar.append(modes);section.append(bar);
    section.append(this.button(this.editEvent?"Bearbeitung abbrechen":"+ Termin hinzufügen",()=>{const d=this.isoDate(this.calendarAnchor);this.editEvent=this.editEvent?null:{title:"",description:"",start:`${d}T09:00`,end:`${d}T10:00`,all_day:false,repeat:"none",members:[]};this.render();}));
    if(this.editEvent)section.append(this.eventForm());
    let first,last;
    if(this.calendarMode==="month"){
      first=this.monday(new Date(d.getFullYear(),d.getMonth(),1));last=this.addDays(this.monday(new Date(d.getFullYear(),d.getMonth()+1,0)),6);
      const grid=this.el("div","calgrid");["Mo","Di","Mi","Do","Fr","Sa","So"].forEach(v=>grid.append(this.el("div","calhead",v)));
      const entries=this.occurrences(this.isoDate(first),this.isoDate(last));
      for(let date=new Date(first);date<=last;date=this.addDays(date,1)){
        const iso=this.isoDate(date),cell=this.el("div",`calday ${date.getMonth()!==d.getMonth()?"outside":""}`);
        const day=this.button(String(date.getDate()),()=>{this.calendarAnchor=new Date(date);this.calendarMode="day";this.render();},"btn secondary");day.style.padding="3px 7px";cell.append(day);
        const dayEntries=entries.filter(o=>o.start<=iso&&o.end>=iso);
        dayEntries.slice(0,3).forEach(o=>{const e=this.button(`${o.time?o.time+" ":""}${o.event.title}`,()=>{this.calendarAnchor=new Date(date);this.calendarMode="day";this.render();},"calentry");e.style.borderLeftColor=this.eventColor(o.event);cell.append(e);});
        if(dayEntries.length>3)cell.append(this.el("div","small",`+${dayEntries.length-3} weitere`));grid.append(cell);
      }
      section.append(grid);
    } else {
      first=this.calendarMode==="week"?this.monday(d):d;last=this.calendarMode==="week"?this.addDays(first,6):d;
      const entries=this.occurrences(this.isoDate(first),this.isoDate(last));const stack=this.el("div","calweek");
      for(let date=new Date(first);date<=last;date=this.addDays(date,1)){
        const iso=this.isoDate(date),day=this.el("div");day.append(this.el("div","caldate",date.toLocaleDateString("de-AT",{weekday:"long",day:"numeric",month:"long"})));
        const daily=entries.filter(o=>o.start<=iso&&o.end>=iso);if(!daily.length)day.append(this.el("div","small","Keine Termine"));else daily.forEach(o=>day.append(this.eventRow(o)));
        stack.append(day);
      }section.append(stack);
    }
    section.append(this.el("p","small","Wiederholungen gelten für die gesamte Terminserie. Termine werden lokal gespeichert; Home-Assistant-Kalender werden lesend eingeblendet. Google-Kalender müssen vorher in Home Assistant eingerichtet sein."));page.append(section);
  }
  changeCalendar(delta) {
    const d=this.calendarAnchor;
    this.calendarAnchor=this.calendarMode==="month"?this.monthStep(d,delta):this.addDays(d,delta*(this.calendarMode==="week"?7:1));this.render();this.refreshExternalEvents();
  }
  eventForm() {
    const event=this.editEvent,form=this.el("form","formgrid");
    const name=this.input("Termin","text",event.title,"title");name.querySelector("input").required=true;
    const all=this.el("label","field");all.append(this.el("span",null,"Art"));const allSelect=this.el("select");[["false","Mit Uhrzeit"],["true","Ganztägig"]].forEach(([v,label])=>{const o=this.el("option",null,label);o.value=v;allSelect.append(o);});allSelect.value=String(event.all_day);all.append(allSelect);
    const start=this.input("Beginn",event.all_day?"date":"datetime-local",event.start,"start");const end=this.input("Ende (einschließlich bei ganztägig)",event.all_day?"date":"datetime-local",event.end,"end");
    const syncType=()=>{const flag=allSelect.value==="true";for(const field of [start,end]){const inp=field.querySelector("input");const val=inp.value;inp.type=flag?"date":"datetime-local";inp.value=flag?val.slice(0,10):`${val.slice(0,10)}T09:00`;}};
    allSelect.addEventListener("change",syncType);
    const rep=this.el("label","field");rep.append(this.el("span",null,"Wiederholung"));const repeat=this.el("select");[["none","Keine"],["daily","Täglich"],["weekly","Wöchentlich"],["monthly","Monatlich"],["yearly","Jährlich"]].forEach(([v,label])=>{const o=this.el("option",null,label);o.value=v;repeat.append(o);});repeat.value=event.repeat;rep.append(repeat);
    const desc=this.el("label","field full");desc.append(this.el("span",null,"Beschreibung (optional)"));const textarea=this.el("textarea");textarea.value=event.description;textarea.maxLength=1500;desc.append(textarea);
    const assigned=this.el("fieldset","field full");assigned.style.border="0";assigned.style.padding="0";assigned.append(this.el("legend",null,"Für Familienmitglieder (mehrere möglich)"));const checks=[];
    this.data.members.forEach(m=>{const lab=this.el("label","person-choice");const ch=this.el("input");ch.type="checkbox";ch.value=m.id;ch.checked=event.members.includes(m.id);checks.push(ch);lab.append(ch,this.el("span",null,m.name));assigned.append(lab);});
    const submit=this.el("button","btn","Termin speichern");submit.type="submit";form.append(name,all,start,end,rep,desc,assigned,submit);
    form.addEventListener("submit",e=>{e.preventDefault();this.request("event_save",{event_id:event.id||"",title:name.querySelector("input").value,description:textarea.value,start:start.querySelector("input").value,end:end.querySelector("input").value,all_day:allSelect.value==="true",repeat:repeat.value,members:checks.filter(c=>c.checked).map(c=>c.value)});});
    return form;
  }
  async fetchChildAccounts() {
    try {
      this.childAccounts = await this._hass.callWS({type:"bamlabs_family_hub/child_accounts"});
      this.error="";this.render();
    } catch(e){this.error=e.message||String(e);this.render();}
  }
  async assignChildAccount(memberId, userId) {
    try {
      const result=await this._hass.callWS({type:"bamlabs_family_hub/child_assign",member_id:memberId,user_id:userId});
      this.childAccounts.assignments=result.assignments;this.qrFor=null;this.error="";this.render();
    }catch(e){this.error=e.message||String(e);this.render();}
  }
  async showChildQr(member) {
    const url=new URL("/bamlabs-family-hub",window.location.origin);
    url.searchParams.set("child",member.id);
    try {
      const response=await this._hass.callWS({type:"bamlabs_family_hub/child_qr",member_id:member.id,url:url.href});
      this.qrFor={member:member.name,url:url.href,image:response.image};this.error="";this.render();
    }catch(e){this.error=e.message||String(e);this.render();}
  }
  async loadPushDevices() {
    if (!this._hass || this.data?._role !== "admin") return;
    try {this.pushDevices = await this._hass.callWS({type:"bamlabs_family_hub/push_devices"});this.pushDevicesLoaded=true;this.render();}
    catch(e) {this.pushDevicesLoaded=true;this.error=e.message||String(e);this.render();}
  }
  async testPush(memberId, device) {
    try {
      const result=await this._hass.callWS({type:"bamlabs_family_hub/push_test",member_id:memberId,device:device||""});
      this.error=result.sent?"✅ Home Assistant hat die Testnachricht angenommen. Wenn sie nicht ankommt, prüfe die Benachrichtigungsfreigabe der Home-Assistant-App und teste das Gerät unter Entwicklerwerkzeuge → Aktionen.":"⚠️ Keine Nachricht gesendet: "+((result.errors||[]).join("; ")||result.reason||"Unbekannte Ursache");
    } catch(e){this.error=e.message||String(e);}
    this.render();
  }
  async diagnosePush() {
    try {
      const result=await this._hass.callWS({type:"bamlabs_family_hub/push_diagnose"});
      const lines=(result.members||[]).map(m=>`${m.name} (${String(m.hour).padStart(2,"0")}:00 Uhr, ${m.due} offene fällige Aufgaben): ${m.reason}`);
      this.error=`🔎 Erinnerungsprüfung, ${result.local_time}:\n${lines.join("\n")||"Keine Familienmitglieder angelegt."}`;
    } catch(e){this.error=e.message||String(e);}
    this.render();
  }
  renderDisplay(page) {
    const settings=this.data.display_settings||{};
    const photos=(settings.photos||[]).filter(p=>/^\/local\/[a-zA-Z0-9_\-/%.]+\.(jpg|jpeg|png|webp)$/i.test(p)&&!p.includes(".."));
    const wrap=this.el("section","display-wrap");
    if(photos.length){
      const img=this.el("img","display-photo");img.src=photos[this.displaySlide%photos.length];img.alt="Familienfoto";
      img.addEventListener("error",()=>{img.style.display="none";});wrap.append(img);
    }
    wrap.append(this.el("div","display-shade"));
    const controls=this.el("div","display-controls");
    controls.append(this.button("✕ Schließen",()=>{this.displayMode=false;this.render();},"display-exit"));wrap.append(controls);
    const inner=this.el("div","display-main");const now=new Date();
    inner.append(this.el("div","display-time",now.toLocaleTimeString("de-AT",{hour:"2-digit",minute:"2-digit"})));
    inner.append(this.el("div","display-date",now.toLocaleDateString("de-AT",{weekday:"long",day:"numeric",month:"long",year:"numeric"})));
    const agenda=this.el("div","display-next");agenda.append(this.el("strong",null,"📅 Als Nächstes"));
    const today=this.isoDate(now),until=this.isoDate(this.addDays(now,6));
    const upcoming=this.occurrences(today,until).filter(o=>o.end>=today).slice(0,4);
    if(upcoming.length)upcoming.forEach(o=>{
      const line=this.el("div","display-next-item");
      line.append(this.el("span",null,o.event.title),this.el("span",null,`${this.dateLabel(o.start)}${o.time?" · "+o.time:""}`));
      agenda.append(line);
    });
    else agenda.append(this.el("div",null,"🌈 Heute ist Zeit für euch!"));
    inner.append(agenda);wrap.append(inner);page.append(wrap);
  }
  async downloadBackup() {
    try {
      const snapshot=await this._hass.callWS({type:"bamlabs_family_hub/backup_export"});
      const blob=new Blob([JSON.stringify(snapshot,null,2)],{type:"application/json;charset=utf-8"});
      const url=URL.createObjectURL(blob);
      const link=document.createElement("a");link.href=url;
      link.download=`family-hub-sicherung-${new Date().toISOString().slice(0,10)}.json`;
      document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
      this.error="";this.savedNotice="✅ Datensicherung zum Download bereitgestellt.";
    }catch(e){this.error=e.message||String(e);this.savedNotice="";}
    this.render();
  }
  async checkSystem() {
    try {this.maintenanceReport=await this._hass.callWS({type:"bamlabs_family_hub/system_check"});this.error="";}
    catch(e){this.error=e.message||String(e);}
    this.render();
  }
  renderSettings(page) {
    const intro=this.el("section","panel");
    intro.append(this.cardTitle("⚙️ Einstellungen"));
    intro.append(this.el("p",null,"Hier verbindest du Kalender und richtest den Handy-Zugang für Kinder ein."));
    const maintenance=this.el("section","display-setting-card");
    maintenance.append(this.cardTitle("🛡️ Sicherheit & Datensicherung"));
    maintenance.append(this.el("p","small","Nur für Eltern mit Administratorrechten. Der JSON-Export enthält persönliche Familiendaten und Gerätezuordnungen. Bitte sicher aufbewahren."));
    maintenance.append(this.button(this.maintenanceOpen?"▴ Schließen":"▾ Wartung öffnen",()=>{this.maintenanceOpen=!this.maintenanceOpen;this.render();},"btn secondary"));
    if(this.maintenanceOpen){
      maintenance.append(this.button("📥 Daten als JSON sichern",()=>this.downloadBackup(),"btn"));
      maintenance.append(this.el("p","small","Für eine vollständige Wiederherstellung bitte ein Home-Assistant-Backup verwenden. JSON-Import ist aus Sicherheitsgründen noch nicht verfügbar."));
      maintenance.append(this.button("🔍 Systemprüfung starten",()=>this.checkSystem(),"btn secondary"));
      if(this.maintenanceReport){
        const c=this.maintenanceReport.counts||{};
        maintenance.append(this.el("p","small",`${c.members||0} Personen · ${c.tasks||0} Aufgaben · ${c.events||0} Termine · ${c.school_plan||0} Schulstunden · ${c.routines||0} Routinen · ${c.family_lists||0} Listen`));
        for(const x of this.maintenanceReport.checks||[])maintenance.append(this.el("p","small",`${x.ok?"✅":"⚠️"} ${x.label}: ${x.ok?"OK":x.detail}`));
      }
    }
    intro.append(maintenance);
    const dashboard=this.el("section","display-setting-card");
    dashboard.append(this.cardTitle("🏡 Startseite selbst gestalten"));
    dashboard.append(this.el("p","small","Wähle aus, welche Kacheln auf der Eltern-Startseite erscheinen, und ändere ihre Reihenfolge. Der Speiseplan wird nur bei installiertem Meal Planner angezeigt."));
    dashboard.append(this.button(this.overviewSettingsOpen?"▴ Startseiten-Einstellungen schließen":"▾ Startseiten-Kacheln einstellen",()=>{
      this.overviewSettingsOpen=!this.overviewSettingsOpen;
      if(this.overviewSettingsOpen){
        const saved=this.data.overview_settings||{};
        const keys=["tasks","events","work","birthdays","school","meals"];
        this.overviewDraft={order:Array.isArray(saved.order)&&saved.order.length===6&&keys.every(k=>saved.order.includes(k))?[...saved.order]:keys,hidden:[...(saved.hidden||[])]};
      }else this.overviewDraft=null;
      this.render();
    },"btn secondary"));
    if(this.overviewSettingsOpen&&this.overviewDraft){
      const names={tasks:"✅ Aufgaben",events:"📅 Termine",work:"💼 Dienstzeiten",birthdays:"🎂 Geburtstage",school:"🎒 Schule & Kita",meals:"🍽️ Unser Essen"};
      const rows=this.el("div","overview-editor");
      const draft=this.overviewDraft;
      draft.order.forEach((key,i)=>{
        const line=this.el("div","overview-editor-row");
        const check=this.el("input");check.type="checkbox";check.checked=!draft.hidden.includes(key);check.setAttribute("aria-label",`${names[key]} anzeigen`);
        check.addEventListener("change",()=>{draft.hidden=check.checked?draft.hidden.filter(k=>k!==key):[...draft.hidden,key];});
        const title=this.el("span","overview-editor-name",names[key]);
        line.append(check,title);
        const up=this.button("↑",()=>{if(i>0){[draft.order[i-1],draft.order[i]]=[draft.order[i],draft.order[i-1]];this.render();}},"btn secondary overview-move");
        const down=this.button("↓",()=>{if(i<draft.order.length-1){[draft.order[i+1],draft.order[i]]=[draft.order[i],draft.order[i+1]];this.render();}},"btn secondary overview-move");
        up.disabled=i===0;down.disabled=i===draft.order.length-1;
        up.setAttribute("aria-label",`${names[key]} nach oben`);down.setAttribute("aria-label",`${names[key]} nach unten`);
        line.append(up,down);rows.append(line);
      });
      dashboard.append(rows);
      dashboard.append(this.button("✓ Startseite speichern",async()=>{
        await this.request("overview_settings_save",{order:[...draft.order],hidden:[...draft.hidden]});
        if(!this.error){this.savedNotice="✅ Startseiten-Kacheln erfolgreich gespeichert.";this.overviewSettingsOpen=false;this.overviewDraft=null;}
        this.render();
      }));
    }
    intro.append(dashboard);

    const display=this.el("section","display-setting-card");
    display.append(this.cardTitle("🖼️ Bildschirmmodus fürs Tablet"));
    display.append(this.el("p","small","Große Uhr und kommende Termine. Optional Familienfotos aus dem Home-Assistant-Ordner /config/www/. Der Bildschirmmodus startet nur, wenn du ihn antippst."));
    display.append(this.button(this.displaySettingsOpen?"▴ Schließen":"▾ Bildschirmmodus einstellen",()=>{this.displaySettingsOpen=!this.displaySettingsOpen;this.render();},"btn secondary"));
    if(this.displaySettingsOpen) {
      const settings=this.data.display_settings||{enabled:false,photos:[],rotate_seconds:30};
      const line=this.el("label","person-choice");
      const enabled=this.el("input");enabled.type="checkbox";enabled.checked=!!settings.enabled;
      line.append(enabled,this.el("span",null,"Bildschirmmodus anbieten"));display.append(line);
      const photos=this.el("label","field");photos.append(this.el("span","field-title","Familienfotos – ein lokaler Bildpfad pro Zeile"));
      const textarea=this.el("textarea");textarea.rows=5;textarea.placeholder="/local/familie/foto1.jpg\n/local/familie/foto2.jpg";textarea.value=(settings.photos||[]).join("\n");photos.append(textarea);display.append(photos);
      const interval=this.el("label","field");interval.append(this.el("span","field-title","Bildwechsel"));
      const select=this.el("select");[15,30,60].forEach(v=>{const option=this.el("option",null,`${v} Sekunden`);option.value=String(v);select.append(option);});
      select.value=String(settings.rotate_seconds||30);interval.append(select);display.append(interval);
      display.append(this.el("p","small","Bilder kommen in /config/www/familie/ und werden als /local/familie/datei.jpg eingetragen. Nur Fotos verwenden, die allen Nutzern des Family Hub gezeigt werden dürfen."));
      display.append(this.button("✓ Bildschirmmodus speichern",()=>this.request("display_settings_save",{enabled:enabled.checked,photos:textarea.value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean),rotate_seconds:Number(select.value)}),"btn"));
    }
    intro.append(display);

    intro.append(this.el("h3",null,"📅 Home-Assistant-Kalender einblenden"));
    intro.append(this.el("p","small","Du kannst Kalender anzeigen, die schon mit Home Assistant verbunden sind. Termine werden anschließend automatisch aktualisiert, solange Family Hub geöffnet ist."));
    intro.append(this.button(this.showCalendarSetup?"▴ Kalender-Einstellungen schließen":"⚙️ Kalender auswählen und zuordnen",()=>{this.showCalendarSetup=!this.showCalendarSetup;this.render();if(this.showCalendarSetup)this.loadCalendarSources();},"btn"));
    if(this.showCalendarSetup){
      const setup=this.el("div","panel");
      setup.append(this.el("h3",null,"1. Wähle deinen Kalender"));
      setup.append(this.el("p","small","Wenn dein Google-Kalender bereits unter Home Assistant → Geräte & Dienste eingerichtet ist, kannst du ihn gleich auswählen."));
      if(this.externalError)setup.append(this.el("div","notice",this.externalError));
      if(this.externalBusy)setup.append(this.el("p","small","Kalender werden geladen …"));
      const selection=[];
      for(const src of this.externalSources){
        const line=this.el("label","person-choice");
        const cb=this.el("input");cb.type="checkbox";cb.value=src.id;cb.checked=(this.data.external_calendars||[]).includes(src.id);
        selection.push(cb);line.append(cb,this.el("span",null,src.name));setup.append(line);
      }
      if(!this.externalSources.length)setup.append(this.el("p","small","Noch keine Kalender gefunden? Dann öffne Home Assistant → Einstellungen → Geräte & Dienste → Integration hinzufügen und richte dort deinen Kalender ein. Kehre anschließend hierher zurück."));
      const actions=this.el("div","actions");
      actions.append(this.button("🔄 Kalender suchen",()=>this.loadCalendarSources(),"btn secondary"));
      actions.append(this.button("✓ Auswahl speichern",async()=>{await this.selectCalendars(selection.filter(c=>c.checked).map(c=>c.value));},"btn"));
      setup.append(actions);
      if((this.data.external_calendars||[]).length){
        setup.append(this.el("h3",null,"2. Kalender zuordnen"));
        setup.append(this.el("p","small","Wähle für jeden gespeicherten Kalender ein Familienmitglied, damit seine Termine in dessen Farbe erscheinen."));
        for(const src of this.externalSources.filter(e=>(this.data.external_calendars||[]).includes(e.id)))
          setup.append(this.calendarMemberPicker(src));
      }
      setup.append(this.el("h3",null,"3. Google Kalender noch nicht verbunden?"));
      setup.append(this.el("p","small","Die Google-Verbindung wird von Home Assistant eingerichtet. Öffne Einstellungen → Geräte & Dienste → Integration hinzufügen → Google Calendar. Folge den dortigen Schritten. Anschließend kommst du zurück und klickst auf „Kalender suchen“."));
      setup.append(this.el("p","small","Hinweis: Eine direkte Anmeldung mit Google ist in Family Hub noch nicht verfügbar. Dafür ist eine eigene sichere Google-Anmeldeintegration nötig."));
      setup.append(this.el("h3",null,"4. Automatische Aktualisierung"));
      setup.append(this.el("p","small",this.externalLastSync?`Zuletzt geladen: ${this.externalLastSync.toLocaleString("de-AT",{dateStyle:"short",timeStyle:"short"})}`:"Noch keine erfolgreiche Aktualisierung."));
      setup.append(this.el("p","small","Verbundene Kalender werden bei geöffnetem Family Hub ungefähr alle fünf Minuten aktualisiert. Termine werden nur angezeigt, nicht in Google verändert."));
      setup.append(this.button("🔄 Termine jetzt laden",()=>this.refreshExternalEvents(true),"btn secondary"));
      intro.append(setup);
    }
    const remind=this.el("section","panel");
    remind.append(this.el("h3",null,"🔔 Aufgabenerinnerungen"));
    remind.append(this.el("p","small","Family Hub kann täglich eine Erinnerung für heute fällige und überfällige Aufgaben in Home Assistant anzeigen – auch wenn der Family Hub geschlossen ist. Es werden keine Handy-Push-Nachrichten verschickt."));
    const settings=this.data.reminder_settings||{enabled:false,hour:8,include_overdue:true};
    const enabled=this.el("input"); enabled.type="checkbox";enabled.checked=!!settings.enabled;
    const enabledRow=this.el("label","person-choice");enabledRow.append(enabled,this.el("span",null,"Tägliche Erinnerungen aktivieren"));remind.append(enabledRow);
    const timeLabel=this.el("label","field");timeLabel.append(this.el("span","field-title","Uhrzeit"));
    const hour=this.el("select");
    for(const h of [8,12,18]){const opt=this.el("option");opt.value=String(h);opt.textContent=`${String(h).padStart(2,"0")}:00 Uhr`;hour.append(opt);}
    hour.value=String(settings.hour??8);timeLabel.append(hour);remind.append(timeLabel);
    const overdue=this.el("input");overdue.type="checkbox";overdue.checked=settings.include_overdue!==false;
    const overdueRow=this.el("label","person-choice");overdueRow.append(overdue,this.el("span",null,"Überfällige Aufgaben einbeziehen"));remind.append(overdueRow);
    const buttons=this.el("div","actions");
    buttons.append(this.button("✓ Erinnerungseinstellungen speichern",()=>this.request("reminder_settings_save",{enabled:enabled.checked,hour:Number(hour.value),include_overdue:overdue.checked}),"btn"));
    buttons.append(this.button("🔔 Test-Erinnerung",async()=>{try{const result=await this._hass.callWS({type:"bamlabs_family_hub/reminder_test"});this.error=result.sent?`Test-Benachrichtigung wurde in Home Assistant erstellt (${result.count} fällige Aufgaben). Öffne Home Assistant → Benachrichtigungen (Glocke). Dies ist keine Handy-Push-Nachricht.`:"Test konnte keine Benachrichtigung erstellen.";}catch(e){this.error=e.message||String(e);}this.render();},"btn secondary"));
    remind.append(buttons);intro.append(remind);
    const push=this.el("section","panel");
    const pushToggle=this.button("",()=>{this.pushSettingsOpen=!this.pushSettingsOpen;this.render();},"push-toggle");
    pushToggle.setAttribute("aria-expanded",String(this.pushSettingsOpen));
    pushToggle.setAttribute("aria-label",this.pushSettingsOpen?"Erinnerungen aufs Handy zuklappen":"Erinnerungen aufs Handy aufklappen");
    pushToggle.append(this.el("span",null,"📲 Erinnerungen aufs Handy"),this.el("span",null,this.pushSettingsOpen?"▲ Zuklappen":"▼ Aufklappen"));
    push.append(pushToggle);
    if(this.pushSettingsOpen){
    push.append(this.el("p","small","Nur mit der offiziellen Home-Assistant-Handy-App. Jeder Person ein Handy zuordnen; dann werden ausschließlich ihre eigenen fälligen Aufgaben geschickt. Standardmäßig ausgeschaltet. Wähle die Uhrzeit für jede Person. Automatische Nachrichten kommen nur bei offenen heute fälligen oder überfälligen Aufgaben; nach einem Neustart auch dann, wenn die Erinnerungszeit schon vorbei ist. Bei älteren Handy-Diensten öffnet das Tippen auf die Push-Nachricht direkt den Family Hub."));
    const ps=this.data.push_settings||{enabled:false,devices:{}};
    const pushEnabled=this.el("input");pushEnabled.type="checkbox";pushEnabled.checked=!!ps.enabled;
    const enableRow=this.el("label","person-choice");enableRow.append(pushEnabled,this.el("span",null,"Tägliche Handy-Erinnerungen aktivieren"));push.append(enableRow);
    if(!this.pushDevicesLoaded)push.append(this.el("p","small","Handy-Liste wird geladen …"));
    if(this.pushDevicesLoaded && !this.pushDevices.length)push.append(this.el("p","notice","Noch kein Handy gefunden. Installiere und verbinde die Home-Assistant-App auf dem jeweiligen Handy und erlaube Benachrichtigungen. Anschließend hier neu laden."));
    const deviceInputs={};
    const hourInputs={};
    const overdueInputs={};
    const people=this.el("div","push-person-list");
    for(const m of this.data.members){
      const person=this.el("section","push-person-card");
      person.style.setProperty("--person-accent",/^#[0-9a-fA-F]{6}$/.test(m.color||"")?m.color:"#6b90d6");
      const heading=this.el("div","push-person-heading");
      const avatar=this.el("span","push-person-avatar",(m.name||"?").slice(0,1).toUpperCase());
      heading.append(avatar,this.el("span",null,m.name));person.append(heading);
      const field=this.el("label","field");field.append(this.el("span","field-title",`Handy für ${m.name}`));
      const sel=this.el("select");const none=this.el("option",null,"Kein Handy ausgewählt");none.value="";sel.append(none);
      for(const dev of this.pushDevices){const opt=this.el("option",null,dev.name);opt.value=dev.id;sel.append(opt);}
      const configured=(ps.devices||{})[m.id]||"";
      if(configured && !this.pushDevices.some(d=>d.id===configured)){
        const missing=this.el("option",null,`Nicht mehr verfügbar: ${configured}`);missing.value=configured;sel.append(missing);
      }
      sel.value=configured;deviceInputs[m.id]=sel;field.append(sel);
      const timing=this.el("label","field");timing.append(this.el("span","field-title",`Erinnerungszeit für ${m.name}`));
      const time=this.el("select");
      for(let h=0;h<24;h++){const opt=this.el("option",null,`${String(h).padStart(2,"0")}:00 Uhr`);opt.value=String(h);time.append(opt);}
      time.value=String((ps.hours||{})[m.id]??settings.hour??8);
      timing.append(time);hourInputs[m.id]=time;
      const late=this.el("input");late.type="checkbox";late.checked=(ps.include_overdue||{})[m.id]??(settings.include_overdue!==false);
      overdueInputs[m.id]=late;
      const lateRow=this.el("label","person-choice");lateRow.append(late,this.el("span",null,`Auch überfällige Aufgaben für ${m.name} melden`));
      person.append(field,timing,lateRow);
      const line=this.el("div","push-person-actions");
      line.append(this.button(`🔔 Test an ${m.name}s Handy`,()=>this.testPush(m.id,sel.value),"btn secondary"));
      person.append(line);people.append(person);
    }
    push.append(people);
    const pushActions=this.el("div","actions");
    pushActions.append(this.button("✓ Handy-Zuordnung speichern",()=>this.request("push_settings_save",{enabled:pushEnabled.checked,
      devices:Object.fromEntries(Object.entries(deviceInputs).map(([k,v])=>[k,v.value])),
      hours:Object.fromEntries(Object.entries(hourInputs).map(([k,v])=>[k,Number(v.value)])),
      include_overdue:Object.fromEntries(Object.entries(overdueInputs).map(([k,v])=>[k,v.checked]))}),"btn"));
    pushActions.append(this.button("🔄 Handys suchen",()=>this.loadPushDevices(),"btn secondary"));
    pushActions.append(this.button("🔎 Erinnerungen prüfen",()=>this.diagnosePush(),"btn secondary"));
    push.append(pushActions);
    }
    intro.append(push);

    // Central notification preferences do not change the existing device assignments.
    const center=this.el("section","panel");
    center.append(this.button(this.notificationCenterOpen?"🔔 Benachrichtigungszentrale ▴ Zuklappen":"🔔 Benachrichtigungszentrale ▾ Aufklappen",()=>{this.notificationCenterOpen=!this.notificationCenterOpen;this.render();},"push-toggle"));
    if(this.notificationCenterOpen){
      center.append(this.el("p","small","Wähle für jedes Familienmitglied, welche Nachrichten aufs bereits zugeordnete Handy kommen dürfen. Aufgaben, Geburtstage und Dienstbeginn behalten ihre bisherigen Einstellungen. Neue Schultaschen- und Terminerinnerungen sind standardmäßig aus. Die Benachrichtigungsarten benötigen zusätzlich ihre jeweilige Aktivierung und ein zugeordnetes Handy."));
      const cfg=this.data.notification_center||{};
      const qRow=this.el("label","person-choice");const qOn=this.el("input");qOn.type="checkbox";qOn.checked=!!cfg.quiet_enabled;
      qRow.append(qOn,this.el("span",null,"🌙 Ruhezeit für Handy-Nachrichten aktivieren"));center.append(qRow);
      const qTimes=this.el("div","grid two");
      const makeHour=(title,val)=>{const field=this.el("label","field");field.append(this.el("span","field-title",title));const select=this.el("select");for(let h=0;h<24;h++){const opt=this.el("option",null,`${String(h).padStart(2,"0")}:00 Uhr`);opt.value=String(h);select.append(opt);}select.value=String(val);field.append(select);qTimes.append(field);return select;};
      const qStart=makeHour("Ab",cfg.quiet_start??21),qEnd=makeHour("Bis",cfg.quiet_end??7);
      center.append(qTimes);
      center.append(this.el("p","small","Während der Ruhezeit werden keine automatischen Handy-Erinnerungen gesendet. Terminerinnerungen können dadurch entfallen, wenn der Termin während der Ruhezeit beginnt. Testnachrichten kannst du weiterhin manuell versenden."));
      const categories={tasks:"✅ Offene Aufgaben",schoolbag:"🎒 Schultasche am Vorabend",events:"📅 Eigene Family-Hub-Termine",birthday:"🎂 Geburtstage (nur Eltern)",work:"💼 Dienstbeginn (nur Eltern)"};
      const checkboxes={};
      for(const m of this.data.members||[]){
        const panel=this.el("section","push-person-card");panel.style.setProperty("--person-accent",/^#[0-9a-fA-F]{6}$/.test(m.color||"")?m.color:"#6b90d6");
        panel.append(this.el("strong",null,`${m.avatar||"🙂"} ${m.name}`));
        const map={};for(const [id,title] of Object.entries(categories)){
          if((id==="birthday"||id==="work")&&m.role!=="parent")continue;
          const line=this.el("label","person-choice"),cb=this.el("input");cb.type="checkbox";
          cb.checked=(cfg.categories?.[m.id]?.[id])??(id==="tasks"||id==="birthday"||id==="work");
          line.append(cb,this.el("span",null,title));panel.append(line);map[id]=cb;
        }checkboxes[m.id]=map;center.append(panel);
      }
      center.append(this.button("✓ Benachrichtigungen speichern",()=>this.request("notification_center_save",{
        quiet_enabled:qOn.checked,quiet_start:Number(qStart.value),quiet_end:Number(qEnd.value),
        categories:Object.fromEntries(Object.entries(checkboxes).map(([mid, kinds])=>[mid,Object.fromEntries(Object.entries(kinds).map(([kind,cb])=>[kind,cb.checked]))]))
      }),"btn"));
    }
    intro.append(center);

    intro.append(this.el("h3",null,"📱 Kinder & Handy-Zugang"));
    intro.append(this.el("p","small","Jedes Kind bekommt einen persönlichen QR-Code. Der Code öffnet Family Hub auf dem Handy – ohne Passwort im QR-Code. Zur Anmeldung benötigt das Kind einmalig ein eigenes Home-Assistant-Konto ohne Administratorrechte."));
    intro.append(this.el("p","small","1. Unter Einstellungen → Personen → Benutzer ein eigenes normales Benutzerkonto für jedes Kind anlegen. 2. Hier das Konto mit dem Kind verbinden. 3. QR-Code mit dem Handy scannen und beim ersten Aufruf anmelden. Danach sieht das Kind nur seine zugewiesenen Aufgaben und Termine."));
    intro.append(this.button(this.childAccounts?"Benutzer neu laden":"Kinderkonten anzeigen",()=>this.fetchChildAccounts(),"btn secondary"));
    intro.append(this.el("h3",null,"🖥️ Familientablet mit Kinderauswahl"));
    intro.append(this.el("p","small","Für das Küchentablet ein eigenes Home-Assistant-Konto ohne Administratorrechte anlegen. Nur dieses Konto zeigt die großen Kinderkacheln. Die Elternverwaltung bleibt geschützt und ist mit dem Tablet-Konto nicht zugänglich."));
    if(this.childAccounts) {
      const field=this.el("label","field"); field.append(this.el("span","field-title","Home-Assistant-Konto für das Familientablet"));
      const choice=this.el("select");const empty=this.el("option",null,"Nicht eingerichtet");empty.value="";choice.append(empty);
      for(const user of this.childAccounts.users) {
        if(Object.prototype.hasOwnProperty.call(this.childAccounts.assignments||{},user.id)) continue;
        const opt=this.el("option",null,user.name);opt.value=user.id;choice.append(opt);
      }
      choice.value=this.childAccounts.tablet_user_id||"";
      field.append(choice);intro.append(field);
      intro.append(this.button("💾 Tablet-Zugang speichern",()=>this.request("tablet_settings_save",{user_id:choice.value}),"btn"));
      intro.append(this.el("p","small","Danach am Tablet mit genau diesem Benutzer anmelden und den Family Hub öffnen. Beim Öffnen des Family Hub erscheint immer zuerst die Kinderauswahl. Über „Kind wechseln“ kommt man auch direkt zurück. Für Elternfunktionen ist eine separate Anmeldung mit einem Administrator-Konto erforderlich."));
    }
    page.append(intro);
    if(!this.childAccounts)return;
    const items=this.el("div","list");
    for(const m of this.data.members){
      const wrap=this.el("section","panel");
      const head=this.el("div","item");const dot=this.el("span","dot");dot.style.background=m.color;
      head.append(dot,this.el("strong",null,m.name));wrap.append(head);
      const label=this.el("label","field");label.append(this.el("span","field-title","Home-Assistant-Konto für dieses Kind"));
      const select=this.el("select");
      const empty=this.el("option",null,"Noch nicht verbunden");empty.value="";select.append(empty);
      this.childAccounts.users.forEach(u=>{const opt=this.el("option",null,u.name);opt.value=u.id;select.append(opt);});
      const assigned=Object.entries(this.childAccounts.assignments).find(([,id])=>id===m.id)?.[0]||"";
      select.value=assigned;
      select.addEventListener("change",()=>this.assignChildAccount(m.id,select.value));label.append(select);wrap.append(label);
      const buttons=this.el("div","actions");
      const qrButton=this.button("📷 QR-Code anzeigen",()=>this.showChildQr(m));qrButton.disabled=!assigned;buttons.append(qrButton);wrap.append(buttons);
      if(this.qrFor && this.qrFor.member===m.name){
        const picture=this.el("img");picture.src=this.qrFor.image;picture.alt=`QR-Code für ${m.name}`;
        picture.style.cssText="display:block;width:220px;max-width:100%;margin:16px auto;border-radius:12px;background:white;padding:12px";
        wrap.append(picture);
        wrap.append(this.el("p","small","Scannen und beim ersten Öffnen mit dem zugeordneten Home-Assistant-Konto anmelden."));
        const link=this.el("a",null,"Link zum Kinderzugang öffnen");link.href=this.qrFor.url;link.target="_blank";link.rel="noopener noreferrer";wrap.append(link);
      }
      items.append(wrap);
    }
    page.append(items);
  }
  pointBalance(memberId) {
    return (this.data.point_entries || []).filter(e => e.member_id === memberId).reduce((sum,e) => sum + Number(e.amount || 0), 0);
  }
  renderProSavings(page, child=false) {
    const members=this.data.members||[];
    const goals=this.data.pro_savings_goals||[];
    const requests=this.data.pro_goal_requests||[];
    const section=this.el("section","panel");
    section.append(this.cardTitle(child ? "🎁 Meine Wünsche" : "🎁 PRO · Wünsche & Sparziele"));
    section.append(this.el("p","small",child
      ? "Du entscheidest, wie viele freie Sterne du sparen möchtest. Mama oder Papa bestätigen deinen Wunsch. Deine übrigen Sterne bleiben für kleine Belohnungen frei."
      : "Kinder wählen selbst einen Sparbetrag. Eltern bestätigen ihn. Gesparte Sterne können nicht gleichzeitig für kleine Belohnungen ausgegeben werden."));
    for(const m of members){
      const goal=goals.find(g=>g.member_id===m.id);
      const pending=requests.find(r=>r.member_id===m.id);
      const balance=Math.max(0,this.pointBalance(m.id));
      const card=this.el("div","pro-goal-card");
      card.style.cssText="padding:16px;margin:12px 0;border-radius:14px;background:var(--card-background-color,rgba(128,128,128,.12));min-width:0;overflow-wrap:anywhere";
      card.style.borderLeft=`5px solid ${m.color||"#16a3a3"}`;
      card.append(this.el("strong",null,`${m.avatar||"🌟"} ${m.name}`));
      if(goal){
        card.append(this.el("h3",null,`${goal.emoji||"🎁"} ${goal.title}`));
        const target=Math.max(1,Number(goal.target)||1);
        const saved=Math.max(0,Number(goal.saved)||0);
        const remaining=Math.max(0,target-saved);
        const percent=Math.min(100,Math.round(saved/target*100));
        const bar=this.el("div","pro-goal-bar");
        bar.style.cssText="height:14px;border-radius:12px;background:rgba(128,128,128,.25);overflow:hidden;margin:12px 0";
        const fill=this.el("div","pro-goal-fill");fill.style.cssText=`background:#21a88b;height:100%;width:${percent}%`;bar.append(fill);
        card.append(bar,this.el("div",null,`⭐ ${saved} von ${target} Sternen gespart (${percent} %)`));
        const stats=this.el("div","pro-saving-stats");
        stats.style.cssText="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:12px 0";
        for(const [title,value] of [["⭐ Für kleine Belohnungen frei",balance],["🎁 Bis zum Wunsch fehlen",remaining]]){
          const tile=this.el("div",null);
          tile.style.cssText="padding:12px;border-radius:12px;background:var(--secondary-background-color,rgba(128,128,128,.13));min-width:0";
          tile.append(this.el("div","small",title),this.el("strong",null,String(value)));
          stats.append(tile);
        }
        card.append(stats);
        if(saved>=target)card.append(this.el("div","pro-goal-ready","🎉 Geschafft! Dein Wunsch ist vollständig angespart."));
        if(pending){
          card.append(this.el("p","notice",child
            ? `⏳ ${pending.amount} Sterne angefragt. Warte auf die Bestätigung deiner Eltern.`
            : `⏳ ${m.name} möchte ${pending.amount} Sterne für „${goal.title}“ sparen.`));
          if(!child){
            const actions=this.el("div","actions");
            actions.append(this.button("✅ Bestätigen",()=>this.request("pro_goal_request_decide",{request_id:pending.id,approve:true}),"btn"));
            actions.append(this.button("❌ Ablehnen",()=>this.request("pro_goal_request_decide",{request_id:pending.id,approve:false}),"btn secondary"));
            card.append(actions);
          }
        }
        if(child && remaining>0 && balance>0){
          const max=Math.min(balance,remaining);
          const form=this.el("form","formgrid");
          const amount=this.input("Wie viele Sterne möchtest du sparen?","number",String(Math.min(10,max)),"proWishAmount");
          const input=amount.querySelector("input");input.min="1";input.max=String(max);input.step="1";input.required=true;
          const options=this.el("div","actions");
          for(const [label,n] of [["⭐ 5",5],["⭐ 10",10],["⭐ Alle freien",max]]){
            if(n<=max)options.append(this.button(label,()=>{input.value=String(n);},"btn secondary"));
          }
          const submit=this.el("button","btn","🙋 Eltern um Bestätigung bitten");submit.type="submit";
          form.append(amount,options,submit);
          form.addEventListener("submit",e=>{
            e.preventDefault();const n=Number(input.value);
            if(!Number.isInteger(n)||n<1||n>max){this.error=`Bitte 1 bis ${max} Sterne auswählen.`;this.render();return;}
            this.request("pro_goal_request",{member_id:m.id,amount:n});
          });
          card.append(form);
          card.append(this.el("p","small",`Beispiel: Wenn du ${Math.min(20,max)} Sterne sparst, bleiben ${balance-Math.min(20,max)} Sterne für kleine Belohnungen frei.`));
        }
        if(!child){
          if(saved<target && balance>0){
            const deposit=this.el("form","formgrid");
            const amount=this.input("Direkt durch Eltern zurücklegen","number",String(Math.min(balance,remaining)),"proDepositAmount");
            amount.querySelector("input").min="1";amount.querySelector("input").max=String(Math.min(balance,remaining));amount.querySelector("input").required=true;
            const button=this.el("button","btn secondary","⭐ Direkt sparen");button.type="submit";
            deposit.append(amount,button);
            deposit.addEventListener("submit",e=>{e.preventDefault();this.request("pro_goal_deposit",{member_id:m.id,amount:Number(amount.querySelector("input").value)});});
            card.append(deposit);
          }
          if(saved>=target)card.append(this.button("🎁 Wunsch als erfüllt markieren",()=>{if(confirm(`Wunsch „${goal.title}“ für ${m.name} abschließen?`))this.request("pro_goal_complete",{member_id:m.id});},"btn"));
        }
      }else card.append(this.el("div","small",child?"Hier ist noch kein großer Wunsch eingetragen.":"Noch kein Wunsch hinterlegt."));
      if(!child){
        const form=this.el("form","formgrid");
        const title=this.input("Wunsch","text",goal?.title||"","proGoalTitle");title.querySelector("input").required=true;
        const target=this.input("Benötigte Sterne","number",String(goal?.target||100),"proGoalTarget");target.querySelector("input").min="1";target.querySelector("input").max="100000";
        const emoji=this.input("Symbol","text",goal?.emoji||"🎁","proGoalEmoji");emoji.querySelector("input").maxLength=8;
        const save=this.el("button","btn",goal?"Wunsch ändern":"Wunsch anlegen");save.type="submit";
        form.append(title,target,emoji,save);
        form.addEventListener("submit",e=>{e.preventDefault();this.request("pro_goal_save",{member_id:m.id,title:title.querySelector("input").value,target:Number(target.querySelector("input").value),emoji:emoji.querySelector("input").value});});
        card.append(form);
        if(goal)card.append(this.button("Wunsch entfernen (Sterne zurückgeben)",()=>{if(confirm(`Wunsch von ${m.name} entfernen und die gesparten Sterne zurückgeben?`))this.request("pro_goal_delete",{member_id:m.id});},"btn secondary"));
      }
      const history=(this.data.pro_goal_history||[]).filter(h=>h.member_id===m.id).slice().reverse().slice(0,5);
      if(history.length){
        const historyWrap=this.el("div","pro-goal-history");historyWrap.append(this.el("strong",null,"🎉 Erfüllte Wünsche"));
        for(const h of history)historyWrap.append(this.el("div","small",`${h.emoji||"🎁"} ${h.title} · ⭐ ${h.target} · ${new Date(h.at).toLocaleDateString("de-DE")}`));
        card.append(historyWrap);
      }
      section.append(card);
    }
    page.append(section);
  }
  renderProBadges(page, child=false) {
    const section=this.el("section","panel pro-badges-section");
    section.append(this.cardTitle(child ? "🏅 Meine Abzeichen" : "🏅 PRO · Abzeichen & Meilensteine"));
    section.append(this.el("p","small",child
      ? "Für kleine und große Erfolge bekommst du besondere Abzeichen. Du musst nicht schneller sein als andere!"
      : "Abzeichen sind freiwillig. Pro Kind einzeln einschalten oder ausschalten. Bereits verdiente Abzeichen bleiben gespeichert."));
    const rules=[
      ["tasks_5","✅","5 Aufgaben geschafft","tasks",5],
      ["tasks_10","✅","10 Aufgaben geschafft","tasks",10],
      ["tasks_25","🏆","25 Aufgaben geschafft","tasks",25],
      ["tasks_50","🏆","50 Aufgaben geschafft","tasks",50],
      ["routine_10","🌈","10 Routine-Schritte","routines",10],
      ["routine_25","🌈","25 Routine-Schritte","routines",25],
      ["stars_100","⭐","100 Sterne gesammelt","stars",100],
      ["wish_1","🎁","Erster Wunsch erfüllt","wishes",1]
    ];
    for (const m of this.data.members||[]) {
      const enabled=this.data.pro_badge_settings?.[m.id]===true;
      const card=this.el("div","pro-badge-person");
      card.style.setProperty("--badge-color",m.color||"#7d78df");
      card.append(this.el("h3",null,`${m.avatar||"🌟"} ${m.name}`));
      if(!child){
        const toggle=this.el("label","pro-badge-switch");
        const check=this.el("input");check.type="checkbox";check.checked=enabled;
        check.addEventListener("change",()=>this.request("pro_badge_settings_save",{member_id:m.id,enabled:check.checked}));
        toggle.append(check,this.el("span",null,"Erfolgsabzeichen für dieses Kind aktivieren"));
        card.append(toggle);
      }
      if(!enabled){card.append(this.el("p","small",child ? "Meine Abzeichen sind gerade ausgeschaltet." : "Ausgeschaltet – kein Abzeichen wird angezeigt."));section.append(card);continue;}
      const completed=(this.data.task_completions||[]).filter(e=>e.member_id===m.id).length;
      const routine=(this.data.routine_checks||[]).filter(e=>e.member_id===m.id).length;
      const earned=(this.data.point_entries||[]).filter(e=>e.member_id===m.id&&e.kind==="earned").reduce((s,e)=>s+Math.max(0,Number(e.amount||0)),0);
      const wishes=(this.data.pro_goal_history||[]).filter(e=>e.member_id===m.id).length;
      const metrics={tasks:completed,routines:routine,stars:earned,wishes};
      const awards=(this.data.pro_badge_awards||[]).filter(a=>a.member_id===m.id);
      const obtained=new Map(awards.map(a=>[a.badge_id,a]));
      const unlocked=awards.length;
      card.append(this.el("div","pro-badge-count",`🏅 ${unlocked} von ${rules.length} Abzeichen gesammelt`));
      const grid=this.el("div","pro-badge-grid");
      for(const [id,icon,label,kind,target] of rules){
        const award=obtained.get(id);
        const tile=this.el("div",`pro-badge-tile ${award?"is-unlocked":"is-locked"}`);
        const isNew=award?.at && (Date.now()-new Date(award.at).getTime())<20000;
        if(isNew)tile.classList.add("is-new");
        tile.append(this.el("div","pro-badge-icon",award?icon:"🔒"));
        tile.append(this.el("strong",null,label));
        tile.append(this.el("span","small",award
          ? `🎉 Verdient am ${new Date(award.at).toLocaleDateString("de-DE")}`
          : `${Math.min(metrics[kind],target)} / ${target} geschafft`));
        grid.append(tile);
      }
      card.append(grid);
      section.append(card);
    }
    page.append(section);
  }
  renderRewards(page, child=false) {
    const members = this.data.members || [];
    const rewards = this.data.rewards || [];
    const section = this.el("section","panel");
    section.append(this.cardTitle(child ? "⭐ Meine Sterne & Belohnungen" : "🏆 Punkte & Belohnungen"));
    section.append(this.el("p","small",child ? "Hier siehst du deine Sterne. Für erledigte Aufgaben bekommst du Punkte und kannst sie gegen schöne Belohnungen tauschen." : "Eltern vergeben Punkte bei Aufgaben und lösen Belohnungen ein. Selbst angelegte Kinderaufgaben bringen keine Punkte."));
    members.forEach(m => {
      const item = this.el("div","item");
      item.append(this.el("strong",null,m.name),this.el("span","chip",`⭐ ${this.pointBalance(m.id)} Punkte`));
      section.append(item);
    });
    if (rewards.length) {
      section.append(this.el("h3",null,"Belohnungen"));
      rewards.forEach(reward => {
        const item=this.el("div","item");
        const info=this.el("div","item-main");
        info.append(this.el("strong",null,reward.title),this.el("div","small",`⭐ ${reward.cost} Punkte`));
        item.append(info);
        if (!child) {
          const actions=this.el("div","actions");
          const picker=this.el("select");
          members.forEach(m => {const opt=this.el("option",null,m.name);opt.value=m.id;picker.append(opt);});
          actions.append(picker);
          actions.append(this.button("Einlösen",()=>{
            if (!picker.value) return;
            const name=members.find(m=>m.id===picker.value)?.name || "das Mitglied";
            if (confirm(`${reward.title} für ${name} einlösen (${reward.cost} Punkte)?`)) this.request("reward_redeem",{reward_id:reward.id,member_id:picker.value});
          },"btn secondary"));
          actions.append(this.button("×",()=>{if(confirm(`Belohnung „${reward.title}“ löschen?`)) this.request("reward_delete",{reward_id:reward.id});},"btn secondary danger"));
          item.append(actions);
        }
        section.append(item);
      });
    } else section.append(this.el("p","small","Noch keine Belohnungen angelegt."));
    if (!child) {
      const form=this.el("form","formgrid");
      const title=this.input("Neue Belohnung","text","","rewardTitle");title.querySelector("input").required=true;
      const cost=this.input("Benötigte Punkte","number","10","rewardCost");
      cost.querySelector("input").min="1";cost.querySelector("input").max="10000";cost.querySelector("input").required=true;
      const submit=this.el("button","btn","Belohnung hinzufügen");submit.type="submit";
      form.append(title,cost,submit);
      form.addEventListener("submit",e=>{e.preventDefault();this.request("reward_save",{title:title.querySelector("input").value,cost:Number(cost.querySelector("input").value)});});
      section.append(form);
    }
    page.append(section);
    this.renderProSavings(page,child);
    this.renderProBadges(page,child);
  }
  renderLists(page, child=false) {
    const lists=(this.data.family_lists || []);
    const intro=this.el("section","panel");
    intro.append(this.cardTitle("🛒 Unsere Listen"));
    intro.append(this.el("p","small",child ? "Tippe auf ein Kästchen, wenn etwas erledigt oder eingepackt ist." : "Einkaufen, Packen und Checklisten – direkt im Family Hub. Funktioniert ohne Meal Planner."));
    if(!child) {
      const add=this.button(this.editList?"✕ Formular schließen":"➕ Neue Liste",()=>{this.editList=this.editList?null:{title:"",icon:"🛒",list_type:"shopping",member_ids:[]};this.render();});
      intro.append(add);
      if(this.editList){
        const f=this.el("form","formgrid");
        const name=this.input("Name der Liste","text",this.editList.title,"listTitle");name.querySelector("input").required=true;
        const typeField=this.el("label","field");typeField.append(this.el("span","field-title","Art der Liste"));
        const typeSel=this.el("select");[["shopping","🛒 Einkaufsliste"],["packing","🎒 Packliste"],["checklist","✅ Checkliste"]].forEach(([id,t])=>{const o=this.el("option",null,t);o.value=id;typeSel.append(o);});typeSel.value=this.editList.list_type;typeField.append(typeSel);
        const iconField=this.el("label","field");iconField.append(this.el("span","field-title","Symbol"));
        const ico=this.el("select");["🛒","🎒","🏖️","🏫","🧳","🏊","🎉","✅","🧸","🍎","🧼","🚗","🐶","⚽","🎨"].forEach(sym=>{const o=this.el("option",null,sym);o.value=sym;ico.append(o);});ico.value=this.editList.icon;iconField.append(ico);
        const assigned=this.el("fieldset","field full");assigned.append(this.el("legend","field-title","Für wen ist diese Liste sichtbar?"));
        assigned.append(this.el("p","small","Ohne Auswahl: nur für Eltern. Für gemeinsame Kinderlisten wähle die passenden Kinder aus."));
        const boxes=[];for(const m of this.data.members){const lab=this.el("label","person-choice");const cb=this.el("input");cb.type="checkbox";cb.checked=this.editList.member_ids.includes(m.id);cb.value=m.id;boxes.push(cb);lab.append(cb,this.el("span",null,m.name));assigned.append(lab);}
        const save=this.el("button","btn","✅ Liste speichern");save.type="submit";
        f.append(name,typeField,iconField,assigned,save);f.addEventListener("submit",e=>{e.preventDefault();this.request("list_save",{list_id:this.editList.id||"",title:name.querySelector("input").value,list_type:typeSel.value,icon:ico.value,member_ids:boxes.filter(c=>c.checked).map(c=>c.value)}).then(()=>{if(!this.error)this.editList=null;});});intro.append(f);
      }
    }
    page.append(intro);
    const grid=this.el("div","family-list-grid");
    const typeNames={shopping:"Einkaufen",packing:"Packen",checklist:"Checkliste"};
    for(const list of lists){
      const card=this.el("section","family-list-card");
      card.append(this.el("div","family-list-title",`${list.icon||"✅"} ${list.title}`));
      card.append(this.el("div","family-list-type",typeNames[list.list_type]||"Liste"));
      const items=list.items||[];const done=items.filter(i=>i.done).length;
      card.append(this.el("p","small",`${done} von ${items.length} geschafft`));
      const bar=this.el("div","family-list-progress");const fill=this.el("div");fill.style.width=`${items.length?Math.round(done/items.length*100):0}%`;bar.append(fill);card.append(bar);
      if(items.length===0)card.append(this.el("p","small","Noch keine Einträge."));
      for(const item of items){
        const row=this.el("label","family-list-row");const cb=this.el("input");cb.type="checkbox";cb.checked=!!item.done;cb.disabled=this.busy;cb.addEventListener("change",()=>this.request("list_item_toggle",{list_id:list.id,item_id:item.id}));
        const caption=this.el("span",item.done?"family-list-muted":null,`${item.icon||"✅"} ${item.title}`);row.append(cb,caption);
        if(!child){const del=this.button("×",()=>{if(confirm("Eintrag löschen?"))this.request("list_item_delete",{list_id:list.id,item_id:item.id});},"btn secondary danger");del.setAttribute("aria-label",`${item.title} löschen`);del.style.marginLeft="auto";row.append(del);}
        card.append(row);
      }
      if(!child){
        const form=this.el("form","actions");form.style.marginTop="12px";
        const inp=this.el("input");inp.type="text";inp.placeholder="Neuer Eintrag, z. B. Zahnbürste";inp.maxLength=100;inp.required=true;inp.style.flex="1";
        const sym=this.el("select");["✅","🛒","🎒","🍎","🧼","🧸","🏊","⚽","🎨","🚗"].forEach(icon=>{const opt=this.el("option",null,icon);opt.value=icon;sym.append(opt);});
        const add=this.el("button","btn","＋");add.type="submit";add.setAttribute("aria-label","Eintrag hinzufügen");
        form.append(sym,inp,add);form.addEventListener("submit",e=>{e.preventDefault();this.request("list_item_add",{list_id:list.id,title:inp.value,icon:sym.value});});card.append(form);
        const actions=this.el("div","family-list-actions");
        actions.append(this.button("✎ Bearbeiten",()=>{this.editList={...list,member_ids:[...list.member_ids]};this.render();},"btn secondary"));
        actions.append(this.button("🔄 Neu beginnen",()=>{if(confirm("Alle Häkchen dieser Liste zurücksetzen?"))this.request("list_reset",{list_id:list.id});},"btn secondary"));
        actions.append(this.button("🗑 Löschen",()=>{if(confirm(`Liste „${list.title}“ endgültig löschen?`))this.request("list_delete",{list_id:list.id});},"btn secondary danger"));card.append(actions);
      }
      grid.append(card);
    }
    if(!lists.length)page.append(this.el("section","panel",child?"Hier sind noch keine Listen für dich freigegeben.":"Noch keine Listen. Erstelle z. B. eine Einkaufsliste oder Packliste für den Schwimmbadbesuch."));
    else page.append(grid);
  }

  workForDate(memberId, date) {
    const iso=this.isoDate(date);
    const exceptions=(this.data.work_exceptions||[]).filter(x=>x.member_id===memberId&&x.date===iso);
    return (exceptions.length?exceptions:(this.data.work_plan||[]).filter(x=>x.member_id===memberId&&Number(x.weekday)===(date.getDay()+6)%7)).slice().sort((a,b)=>(a.time||"").localeCompare(b.time||""));
  }
  workKindLabel(entry) {
    return entry.kind==="vacation"?"🏖️ Urlaub":entry.kind==="sick"?"🤒 Krankenstand":entry.kind==="free"?"🏡 Frei":`💼 ${entry.title}`;
  }
  renderWorkExceptions(section, people, child) {
    const h=this.el("h3",null,"📅 Wechselnde Dienste, Urlaub und freie Tage");section.append(h);
    section.append(this.el("p","small","Datumsbezogene Einträge ersetzen den regelmäßigen Dienstplan am betreffenden Tag. So kannst du jede Woche anders planen."));
    const d=this.el("div","actions");
    d.append(this.button("‹ Vorige Woche",()=>{this.workDateAnchor=this.addDays(this.workDateAnchor||new Date(),-7);this.render();},"btn secondary"));
    d.append(this.button("Diese Woche",()=>{this.workDateAnchor=new Date();this.render();},"btn secondary"));
    d.append(this.button("Nächste Woche ›",()=>{this.workDateAnchor=this.addDays(this.workDateAnchor||new Date(),7);this.render();},"btn secondary"));section.append(d);
    const monday=this.monday(this.workDateAnchor||new Date());
    section.append(this.el("p","small",`Woche: ${this.dateLabel(this.isoDate(monday))} – ${this.dateLabel(this.isoDate(this.addDays(monday,6)))}`));
    const grid=this.el("div","work-date-grid");
    for(let index=0;index<7;index++) {
      const date=this.addDays(monday,index),iso=this.isoDate(date);
      const card=this.el("div","work-date-card");card.append(this.el("strong",null,date.toLocaleDateString("de-AT",{weekday:"long",day:"numeric",month:"numeric"})));
      for(const member of people) {
        const rows=this.workForDate(member.id,date);
        if(!rows.length)continue;
        const label=this.el("div","work-date-person",member.name);label.style.borderLeft=`4px solid ${member.color||"#42b0a0"}`;card.append(label);
        rows.forEach(item=>{const line=this.el("div","work-date-row");line.append(this.el("span",null,`${this.workKindLabel(item)}${item.time?" · "+item.time+(item.end_time?"–"+item.end_time:""):""}`));
          if(!child && item.date){
            line.append(this.button("✏️",()=>{this.editWorkException={...item};this.render();},"btn secondary"));
            line.append(this.button("🗑️",()=>{if(confirm("Diese Tagesänderung löschen?"))this.request("work_exception_delete",{entry_id:item.id});},"btn secondary"));
          }card.append(line);});
      }
      if(!child)card.append(this.button("➕ Tagesänderung",()=>{this.editWorkException={date:iso,member_id:people[0]?.id||"",kind:"shift",title:"",time:"",end_time:""};this.render();},"btn secondary"));
      grid.append(card);
    }
    section.append(grid);
    if(child)return;
    const edit=this.editWorkException;
    if(edit) {
      const form=this.el("form","formgrid");form.append(this.el("h3",null,"📅 Tagesänderung eintragen"));
      const memberField=this.el("label","field");memberField.append(this.el("span","field-title","Familienmitglied"));
      const member=this.el("select");people.forEach(x=>{const option=this.el("option",null,x.name);option.value=x.id;member.append(option);});member.value=edit.member_id;member.disabled=!!edit.id;memberField.append(member);
      const date=this.input("Datum","date",edit.date||this.isoDate(new Date()),"date");date.querySelector("input").required=true;
      const kindField=this.el("label","field");kindField.append(this.el("span","field-title","Art"));
      const kind=this.el("select");[["shift","💼 Dienst"],["free","🏡 Frei"],["vacation","🏖️ Urlaub"],["sick","🤒 Krankenstand"]].forEach(([value,text])=>{const opt=this.el("option",null,text);opt.value=value;kind.append(opt);});kind.value=edit.kind||"shift";kindField.append(kind);
      const title=this.input("Dienstbezeichnung","text",edit.title||"","title");
      const start=this.input("Beginn","time",edit.time||"","time");const end=this.input("Ende","time",edit.end_time||"","end_time");
      const toggle=()=>{const show=kind.value==="shift";title.style.display=show?"":"none";start.style.display=show?"":"none";end.style.display=show?"":"none";title.querySelector("input").required=show;start.querySelector("input").required=show;end.querySelector("input").required=show;};kind.addEventListener("change",toggle);toggle();
      form.append(memberField,date,kindField,title,start,end);
      const save=this.el("button","btn","💾 Tagesänderung speichern");save.type="submit";form.append(save,this.button("Abbrechen",()=>{this.editWorkException=null;this.render();},"btn secondary"));
      form.addEventListener("submit",e=>{e.preventDefault();this.request("work_exception_save",{entry_id:edit.id||"",member_id:member.value,date:date.querySelector("input").value,kind:kind.value,title:title.querySelector("input").value,time:start.querySelector("input").value,end_time:end.querySelector("input").value}).then(()=>{if(!this.error){this.editWorkException=null;this.render();}});});
      section.append(form);
    }
    const alerts=this.data.work_alert||{enabled:false,minutes:30};
    const alertCard=this.el("section","panel");alertCard.append(this.el("h3",null,"🔔 Erinnerung vor Dienstbeginn"));
    alertCard.append(this.el("p","small","Optional. Verwendet das bereits bei Erinnerungen aufs Handy hinterlegte Gerät des Elternteils."));
    const checkbox=this.el("input");checkbox.type="checkbox";checkbox.checked=!!alerts.enabled;
    const label=this.el("label","field");label.append(checkbox,this.el("span",null," Dienst-Erinnerungen aktivieren"));alertCard.append(label);
    const minutes=this.el("select");[10,15,30,60].forEach(n=>{const opt=this.el("option",null,`${n} Minuten vorher`);opt.value=String(n);minutes.append(opt);});minutes.value=String(alerts.minutes||30);alertCard.append(minutes);
    alertCard.append(this.button("💾 Erinnerungen speichern",()=>this.request("work_alert_save",{enabled:checkbox.checked,minutes:Number(minutes.value)}),"btn"));section.append(alertCard);
  }

  renderWork(page, child=false) {
    const section=this.el("section","panel school-section");
    section.append(this.cardTitle(child?"💼 Mein Dienstplan":"💼 Dienstplan der Eltern"));
    section.append(this.el("p","small",child?"Hier stehen deine Arbeitszeiten.":"Hier legst du den üblichen Wochenplan fest. Darunter kannst du für einzelne Tage abweichende Dienste, Urlaub und Krankenstand eintragen. Pro Tag sind auch mehrere Dienste möglich. Eine Endzeit vor der Startzeit bedeutet Nachtdienst über Mitternacht."));
    const days=["Montag","Dienstag","Mittwoch","Donnerstag","Freitag","Samstag","Sonntag"];
    const people=(this.data.members||[]).filter(m=>m.role==="parent");
    const entries=(this.data.work_plan||[]).slice().sort((a,b)=>Number(a.weekday)-Number(b.weekday)||(a.time||"").localeCompare(b.time||""));
    const currentDay=(new Date().getDay()+6)%7;
    for(const person of people){
      const group=this.el("section","school-person");
      const head=this.el("div","school-person-head");head.style.borderLeft=`7px solid ${person.color||"#41a89c"}`;
      head.append(this.el("span","school-avatar",person.avatar||"👤"),this.el("strong",null,person.name));group.append(head);
      const week=this.el("div","school-week work-week");
      for(let d=0;d<7;d++){
        const day=this.el("section",`school-day ${d===currentDay?"school-day-now":""}`);
        day.append(this.el("h3",null,`${d===currentDay?"☀️ Heute · ":""}${days[d]}`));
        const items=entries.filter(e=>e.member_id===person.id&&Number(e.weekday)===d);
        if(!items.length)day.append(this.el("div","small","Frei / kein Dienst eingetragen"));
        for(const item of items){
          const card=this.el("div","school-entry work-entry");card.append(this.el("span","school-entry-icon","💼"));
          const info=this.el("div","school-entry-info");info.append(this.el("strong",null,item.title));
          if(item.time)info.append(this.el("span","small",`${item.time}${item.end_time?" – "+item.end_time:""} Uhr${item.end_time&&item.end_time<item.time?" · Folgetag":""}`));
          card.append(info);
          if(!child){
            const workActions=this.el("div","work-entry-actions");
            const change=this.button("✏️",()=>{this.editWork={...item};this.workNewFor=null;this.render();},"btn secondary");change.title="Dienst bearbeiten";
            const remove=this.button("🗑️",()=>{if(confirm(`Dienst „${item.title}“ löschen?`))this.request("work_delete",{entry_id:item.id});},"btn secondary");remove.title="Dienst löschen";
            workActions.append(change,remove);card.append(workActions);
          }
          day.append(card);
        }
        if(!child)day.append(this.button("➕ Dienst",()=>{this.editWork=null;this.workNewFor=person.id;this.workNewDay=d;this.render();},"btn secondary"));
        week.append(day);
      }
      group.append(week);section.append(group);
    }
    if(!child){
      const edit=this.editWork, selected=edit?.member_id||this.workNewFor;
      if(selected&&people.some(m=>m.id===selected)){
        const person=people.find(m=>m.id===selected);
        const model=edit||{member_id:selected,weekday:this.workNewDay,title:"",time:"",end_time:""};
        section.append(this.el("h3",null,`${edit?"✏️ Dienst bearbeiten":"➕ Dienst hinzufügen"} · ${person.name}`));
        const form=this.el("form","formgrid");
        const dayLabel=this.el("label","field");dayLabel.append(this.el("span","field-title","Wochentag"));
        const day=this.el("select");days.forEach((name,i)=>{const o=this.el("option",null,name);o.value=String(i);day.append(o);});day.value=String(model.weekday);dayLabel.append(day);
        const title=this.input("Dienst / Tätigkeit (z. B. Frühdienst)","text",model.title,"title");title.querySelector("input").required=true;title.querySelector("input").maxLength=80;
        const start=this.input("Arbeitsbeginn","time",model.time||"","time");
        const end=this.input("Arbeitsende","time",model.end_time||"","end_time");
        const save=this.el("button","btn",edit?"💾 Änderungen speichern":"➕ Dienst speichern");save.type="submit";
        form.append(dayLabel,title,start,end,save,this.button("Abbrechen",()=>{this.editWork=null;this.workNewFor=null;this.render();},"btn secondary"));
        form.addEventListener("submit",e=>{e.preventDefault();this.request("work_save",{entry_id:model.id||"",member_id:selected,weekday:Number(day.value),title:title.querySelector("input").value,time:start.querySelector("input").value,end_time:end.querySelector("input").value}).then(()=>{if(!this.error){this.editWork=null;this.workNewFor=null;this.render();}});});
        section.append(form);
      }else section.append(this.el("p","small","Tippe beim gewünschten Elternteil auf ➕ Dienst."));
    }
    if(people.length)this.renderWorkExceptions(section,people,child);
    if(!people.length)section.append(this.el("div","empty",child?"Kein Dienstplan hinterlegt.":"Lege unter 👨‍👩‍👧 Familie zuerst ein Mitglied mit der Rolle Elternteil fest."));
    page.append(section);
  }

  schoolAbsenceFor(memberId, iso) {
    const manual=(this.data.school_absences||[]).find(a=>a.member_id===memberId && a.start<=iso && a.end>=iso);
    if(manual)return manual;
    const cfg=(this.data.school_holiday_settings||{})[memberId];
    if(!cfg?.enabled)return null;
    const cached=(this.data.school_holiday_cache||{})[`${cfg.country}:${cfg.region}`];
    return (cached?.entries||[]).filter(h=>(h.kind==="school"&&cfg.school!==false)||(h.kind==="public"&&cfg.public!==false))
      .filter(h=>h.start<=iso&&h.end>=iso)
      .map(h=>({kind:h.kind==="school"?"holiday":"free",note:h.name,start:h.start,end:h.end,automatic:true}))[0]||null;
  }
  schoolAbsenceText(a) {
    const labels={holiday:"🏖️ Ferien",illness:"🤒 Krank",free:"🏡 Schulfrei / Feiertag",other:"📌 Abwesend"};
    return `${labels[a.kind]||"📌 Abwesend"}${a.note?" · "+a.note:""}`;
  }
  schoolNowNext(memberId, now=new Date()) {
    const today=this.isoDate(now);
    const absence=this.schoolAbsenceFor(memberId,today);
    if(absence)return {absence};
    const weekday=(now.getDay()+6)%7;
    const lessons=(this.data.school_plan||[]).filter(e=>e.member_id===memberId&&Number(e.weekday)===weekday&&e.time).sort((a,b)=>a.time.localeCompare(b.time));
    const clock=`${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
    const current=lessons.find(e=>e.end_time&&e.time<=clock&&clock<e.end_time)||null;
    const next=lessons.find(e=>e.time>clock)||null;
    return {current,next,hasLessons:lessons.length>0};
  }

  renderAutoHolidays(section, people) {
    const wrap=this.el("details","school-absence-panel");
    wrap.open=!!this.autoHolidayOpen;
    wrap.addEventListener("toggle",()=>{this.autoHolidayOpen=wrap.open;});
    wrap.append(this.el("summary",null,"🌍 Schulferien & Feiertage automatisch · Österreich / Deutschland"));
    wrap.append(this.el("p","small","Freiwillig pro Kind. Wähle Land und Bundesland. Bei aktivierter Funktion werden verfügbare Ferien und Feiertage automatisch geladen und lokal gespeichert. Eigene schulfreie Tage bleiben erhalten und haben Vorrang."));
    const regions={AT:[["AT-1","Burgenland"],["AT-2","Kärnten"],["AT-3","Niederösterreich"],["AT-4","Oberösterreich"],["AT-5","Salzburg"],["AT-6","Steiermark"],["AT-7","Tirol"],["AT-8","Vorarlberg"],["AT-9","Wien"]],DE:[["DE-BW","Baden-Württemberg"],["DE-BY","Bayern"],["DE-BE","Berlin"],["DE-BB","Brandenburg"],["DE-HB","Bremen"],["DE-HH","Hamburg"],["DE-HE","Hessen"],["DE-MV","Mecklenburg-Vorpommern"],["DE-NI","Niedersachsen"],["DE-NW","Nordrhein-Westfalen"],["DE-RP","Rheinland-Pfalz"],["DE-SL","Saarland"],["DE-SN","Sachsen"],["DE-ST","Sachsen-Anhalt"],["DE-SH","Schleswig-Holstein"],["DE-TH","Thüringen"]]};
    const settings=this.data.school_holiday_settings||{};
    for(const person of people){
      const cfg=settings[person.id]||{enabled:false,country:"AT",region:"AT-4",school:true,public:true};
      const box=this.el("div","school-absence-row");box.style.display="block";box.style.borderLeft=`5px solid ${person.color||"#1d9caa"}`;
      box.append(this.el("strong",null,`${person.avatar||"🎒"} ${person.name}`));
      const form=this.el("form","formgrid");
      const addSelect=(name,values,selected)=>{const label=this.el("label","field");label.append(this.el("span","field-title",name));const sel=this.el("select");values.forEach(([v,t])=>{const o=this.el("option",null,t);o.value=v;sel.append(o);});sel.value=selected;label.append(sel);form.append(label);return sel;};
      const enabled=addSelect("Automatischer Kalender",[["off","Aus – nichts automatisch laden"],["on","Ein – Ferien und Feiertage anzeigen"]],cfg.enabled?"on":"off");
      const country=addSelect("Land",[["AT","🇦🇹 Österreich"],["DE","🇩🇪 Deutschland"]],cfg.country||"AT");
      const region=addSelect("Bundesland",regions[country.value],cfg.region||"AT-4");
      const updateRegions=()=>{const old=region.value;region.replaceChildren();regions[country.value].forEach(([v,t])=>{const o=this.el("option",null,t);o.value=v;region.append(o);});region.value=regions[country.value].some(([v])=>v===old)?old:regions[country.value][0][0];};
      country.addEventListener("change",updateRegions);
      const school=addSelect("Schulferien",[["yes","Anzeigen"],["no","Nicht anzeigen"]],cfg.school!==false?"yes":"no");
      const publicH=addSelect("Gesetzliche Feiertage",[["yes","Anzeigen"],["no","Nicht anzeigen"]],cfg.public!==false?"yes":"no");
      const submit=this.el("button","btn","💾 Ferien-Einstellungen speichern");submit.type="submit";form.append(submit);
      form.addEventListener("submit",e=>{e.preventDefault();this.request("school_holiday_save",{member_id:person.id,enabled:enabled.value==="on",country:country.value,region:region.value,school:school.value==="yes",public:publicH.value==="yes"}).then(()=>{this.autoHolidayOpen=true;});});
      box.append(form);
      if(cfg.enabled){
        const cached=(this.data.school_holiday_cache||{})[`${cfg.country}:${cfg.region}`];
        const status=!cached?"⏳ Noch keine Daten geladen (bitte kurz warten und aktualisieren).":`📅 Letzter Abruf: ${cached.updated||"unbekannt"} · ${(cached.entries||[]).length} Termine${cached.status==="partial"?" · Teilweise geladen":""}`;
        box.append(this.el("div","small",status));
        if(cached?.entries?.length){const future=cached.entries.filter(x=>x.end>=this.isoDate(new Date())).slice().sort((a,b)=>a.start.localeCompare(b.start)).slice(0,4);for(const h of future)box.append(this.el("div","small",`${h.kind==="school"?"🏖️":"📅"} ${h.name}: ${h.start}${h.end!==h.start?" bis "+h.end:""}`));}
      }
      wrap.append(box);
    }
    const actions=this.el("div","actions");actions.append(this.button("🔄 Ferientermine neu laden",()=>this.request("school_holiday_refresh",{}).then(()=>{this.autoHolidayOpen=true;}),"btn secondary"));wrap.append(actions);
    wrap.append(this.el("p","small","Quelle: OpenHolidays API (Open Data). Internetzugang beim Abruf erforderlich. Schulautonome Tage, einzelne Schultypen und regionale Ausnahmen bitte bei den manuellen Abwesenheiten prüfen und ergänzen."));
    section.append(wrap);
  }

  renderSchoolAbsences(section,people) {
    const area=this.el("div","school-absence-panel");
    const toggle=this.button(`${this.schoolAbsenceOpen?"▾":"▸"} 🏖️ Ferien, Feiertage & Abwesenheiten`,()=>{this.schoolAbsenceOpen=!this.schoolAbsenceOpen;this.render();},"btn secondary");
    area.append(toggle);
    if(!this.schoolAbsenceOpen){section.append(area);return;}
    area.append(this.el("p","small","Gilt nur für das ausgewählte Kind. Der normale Wochenplan bleibt gespeichert und wird an diesen Tagen ausgeblendet."));
    const rows=(this.data.school_absences||[]).slice().sort((a,b)=>a.start.localeCompare(b.start));
    for(const a of rows){
      const member=people.find(p=>p.id===a.member_id);
      if(!member)continue;
      const item=this.el("div","school-absence-row");
      item.append(this.el("span",null,`${member.avatar||"👤"} ${member.name}: ${this.schoolAbsenceText(a)} · ${a.start}${a.end!==a.start?" bis "+a.end:""}`));
      item.append(this.button("✏️",()=>{this.editSchoolAbsence={...a};this.render();},"btn secondary"));
      item.append(this.button("🗑️",()=>{if(confirm("Abwesenheit löschen?"))this.request("school_absence_delete",{entry_id:a.id});},"btn secondary"));
      area.append(item);
    }
    const model=this.editSchoolAbsence||{member_id:people[0]?.id||"",kind:"holiday",start:this.isoDate(new Date()),end:this.isoDate(new Date()),note:""};
    const form=this.el("form","formgrid");
    const selectField=(label,options,value)=>{
      const field=this.el("label","field");field.append(this.el("span","field-title",label));
      const select=this.el("select");for(const [v,t] of options){const option=this.el("option",null,t);option.value=v;select.append(option);}select.value=value;field.append(select);return [field,select];
    };
    const [personField,person]=selectField("Kind",people.map(p=>[p.id,p.name]),model.member_id);
    const [kindField,kind]=selectField("Art",[["holiday","🏖️ Ferien"],["free","🏡 Feiertag / Schulfrei"],["illness","🤒 Krank"],["other","📌 Sonstige Abwesenheit"]],model.kind);
    const start=this.input("Von", "date", model.start,"start");
    const end=this.input("Bis (einschließlich)", "date",model.end,"end");
    const note=this.input("Hinweis (optional)","text",model.note||"","note");
    const submit=this.el("button","btn",model.id?"💾 Änderung speichern":"➕ Abwesenheit eintragen");submit.type="submit";
    form.append(personField,kindField,start,end,note,submit);
    if(model.id)form.append(this.button("Abbrechen",()=>{this.editSchoolAbsence=null;this.render();},"btn secondary"));
    form.addEventListener("submit",event=>{
      event.preventDefault();
      this.request("school_absence_save",{entry_id:model.id||"",member_id:person.value,kind:kind.value,start:start.querySelector("input").value,end:end.querySelector("input").value,note:note.querySelector("input").value}).then(()=>{if(!this.error)this.editSchoolAbsence=null;});
    });
    area.append(form);section.append(area);
  }
  packSettings(memberId) {
    return this.data.school_pack_settings?.[memberId] || {enabled:false,subjects:{}};
  }
  packItemsFor(memberId,iso){
    if(this.schoolAbsenceFor(memberId,iso))return [];
    const settings=this.packSettings(memberId);
    if(!settings.enabled)return [];
    const weekday=(new Date(iso+"T12:00:00").getDay()+6)%7;
    const lessons=(this.data.school_plan||[]).filter(x=>x.member_id===memberId&&Number(x.weekday)===weekday);
    const seen=new Set(),results=[];
    for(const lesson of lessons){
      const subject=(lesson.title||"").trim().toLocaleLowerCase("de");
      for(const name of settings.subjects?.[subject]||[]){
        const key=subject+"|"+name.toLocaleLowerCase("de");
        if(!seen.has(key)){seen.add(key);results.push({key,name,subject:lesson.title});}
      }
    }
    return results;
  }
  renderPackSettings(group,person,mine){
    const settings=this.packSettings(person.id), box=this.el("div","school-pack-settings");
    const open=!!this.packOpenFor[person.id];
    box.append(this.button(`${open?"▾":"▸"} 🎒 Schultaschen-Packliste ${settings.enabled?"(aktiv)":"(aus)"}`,()=>{this.packOpenFor[person.id]=!open;this.render();},"btn secondary"));
    if(!open){group.append(box);return;}
    const toggle=this.el("label","school-pack-switch");
    const cb=this.el("input");cb.type="checkbox";cb.checked=!!settings.enabled;cb.disabled=this.busy;
    cb.addEventListener("change",()=>this.request("school_pack_config_save",{member_id:person.id,enabled:cb.checked,subject:"",items:[]}));
    toggle.append(cb,this.el("strong",null,"Packliste für "+person.name+" aktivieren"));box.append(toggle);
    box.append(this.el("p","small","Optional: Nur bei aktiviertem Häkchen erscheint die Packliste im Kinderkonto. Die Liste wird aus dem Stundenplan für morgen erstellt. An schulfreien Tagen wird nichts angezeigt."));
    const subjectNames=[...new Set(mine.map(s=>(s.title||"").trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"de"));
    if(!subjectNames.length)box.append(this.el("div","small","Trage zuerst Unterrichtsfächer im Stundenplan ein."));
    for(const subject of subjectNames){
      const key=subject.toLocaleLowerCase("de"), saved=settings.subjects?.[key]||[];
      const row=this.el("form","school-pack-subject");
      const label=this.el("label","field");label.append(this.el("span","field-title",`📚 ${subject} – Was muss in die Tasche?`));
      const input=this.el("input");input.type="text";input.value=saved.join(", ");input.placeholder="z. B. Turnsachen, Trinkflasche";input.maxLength=2000;label.append(input);
      const save=this.el("button","btn secondary","💾 Speichern");save.type="submit";
      row.append(label,save);
      row.addEventListener("submit",ev=>{ev.preventDefault();const items=input.value.split(",").map(s=>s.trim()).filter(Boolean);this.request("school_pack_config_save",{member_id:person.id,enabled:!!this.packSettings(person.id).enabled,subject,items});});
      box.append(row);
    }
    group.append(box);
  }
  renderSchoolPack(page){
    const me=this.data.members?.[0];if(!me)return;
    const settings=this.packSettings(me.id);if(!settings.enabled)return;
    const target=this.packDay==="today"?new Date():this.addDays(new Date(),1);
    const iso=this.isoDate(target),absent=this.schoolAbsenceFor(me.id,iso);
    const items=this.packItemsFor(me.id,iso),done=new Set((this.data.school_pack_checks||[]).filter(c=>c.member_id===me.id&&c.date===iso).map(c=>c.key));
    const section=this.el("section","panel school-pack-child");
    section.style.setProperty("--kid-color",me.color||"#3b82f6");
    section.append(this.cardTitle("🎒 Meine Schultasche"));
    section.append(this.el("p","small","Schau nach, was du für die Schule brauchst. Tippe auf ein Kästchen, wenn es eingepackt ist."));
    const controls=this.el("div","school-pack-days");
    for(const [day,label] of [["today","Heute"],["tomorrow","Morgen"]])controls.append(this.button(label,()=>{this.packDay=day;this.render();},`btn ${this.packDay===day?"":"secondary"}`));
    section.append(controls);
    section.append(this.el("h3",null,target.toLocaleDateString("de-AT",{weekday:"long",day:"numeric",month:"long"})));
    if(absent)section.append(this.el("div","school-absence-badge",this.schoolAbsenceText(absent)+" – keine Schultasche nötig."));
    else if(!items.length)section.append(this.el("div","kid-week-empty","🎈 Für diesen Tag sind keine Sachen hinterlegt."));
    else {
      section.append(this.el("div","school-pack-progress",`${items.filter(i=>done.has(i.key)).length} von ${items.length} eingepackt`));
      for(const item of items){
        const row=this.el("label",`school-pack-item ${done.has(item.key)?"done":""}`);
        const cb=this.el("input");cb.type="checkbox";cb.checked=done.has(item.key);cb.disabled=this.busy;
        cb.setAttribute("aria-label",`${item.name} einpacken`);
        cb.addEventListener("change",()=>this.request("school_pack_toggle",{date:iso,key:item.key}));
        const text=this.el("span");text.append(this.el("strong",null,item.name),this.el("small",null,`Für ${item.subject}`));
        row.append(cb,text);section.append(row);
      }
      if(items.every(i=>done.has(i.key)))section.append(this.el("div","school-pack-finished","🎉 Super! Deine Schultasche ist fertig!"));
    }
    page.append(section);
  }

  renderSchool(page, child=false) {
    const section=this.el("section","panel school-section");
    section.append(this.cardTitle(child ? "🎒 Mein Wochenplan" : "🎒 Schule & Kindergarten"));
    section.append(this.el("p","small",child ? "Hier siehst du deine Tage, Unterrichtsstunden und Pausen." : "Wähle für jedes Kind Kindergarten (ein Eintrag pro Tag) oder Stundenplan (beliebig viele Stunden mit Fach und Uhrzeit). Bestehende Einträge bleiben beim Wechsel erhalten."));
    const days=["Montag","Dienstag","Mittwoch","Donnerstag","Freitag","Samstag","Sonntag"];
    const entries=(this.data.school_plan||[]).slice().sort((a,b)=>Number(a.weekday)-Number(b.weekday)||(a.time||"").localeCompare(b.time||"")||(a.title||"").localeCompare(b.title||""));
    const currentDay=(new Date().getDay()+6)%7;
    const people=(this.data.members||[]).filter(m=>m.role!=="parent");
    if(!child && people.length){this.renderAutoHolidays(section,people);this.renderSchoolAbsences(section,people);}
    for(const person of people){
      const mine=entries.filter(x=>x.member_id===person.id);
      const savedMode=(this.data.school_modes||{})[person.id];
      const mode=savedMode||([0,1,2,3,4,5,6].some(d=>mine.filter(x=>Number(x.weekday)===d).length>1)?"school":"kindergarten");
      const group=this.el("section","school-person");
      const header=this.el("div","school-person-head");header.style.borderLeft=`7px solid ${person.color||"#41a89c"}`;
      const avatar=this.el("span","school-avatar",person.name.slice(0,1).toUpperCase());avatar.style.background=person.color||"#41a89c";
      header.append(avatar,this.el("strong",null,person.name));group.append(header);
      if(!child){
        const choose=this.el("label","field");choose.append(this.el("span","field-title","Plan für "+person.name));
        const modeSel=this.el("select");
        for(const [value,name] of [["kindergarten","🧸 Kindergarten · 1 Eintrag pro Tag"],["school","📚 Stundenplan · mehrere Stunden pro Tag"]]){
          const o=this.el("option",null,name);o.value=value;modeSel.append(o);
        }
        modeSel.value=mode;
        modeSel.addEventListener("change",()=>this.request("school_mode_save",{member_id:person.id,mode:modeSel.value}).then(()=>{this.editSchool=null;}));
        choose.append(modeSel);group.append(choose);
      } else group.append(this.el("p","small",mode==="school"?"📚 Mein Stundenplan":"🧸 Mein Kindergartenplan"));
      if(!child && mode==="school") {
        const archive=this.el("details","school-year-archive");
        const active=(this.data.school_year_active||{})[person.id]||"Bisheriger Stundenplan";
        archive.append(this.el("summary",null,`📚 Schuljahre verwalten · Aktuell: ${active}`));
        archive.append(this.el("p","small","Beim Start eines neuen Schuljahrs wird der bisherige Stundenplan archiviert. Der neue Plan übernimmt die Fächer als Vorlage – du musst nur Änderungen eintragen."));
        const row=this.el("div","actions");
        const next=this.input("Neues Schuljahr (z. B. 2027/28)","text","","new-school-year");
        next.querySelector("input").maxLength=32;
        row.append(next,this.button("📚 Neues Schuljahr starten",()=>{
          const label=next.querySelector("input").value.trim();
          if(!label)return alert("Bitte das neue Schuljahr eingeben.");
          if(confirm(`Stundenplan von ${person.name} als „${active}“ archivieren und „${label}“ beginnen?`))
            this.request("school_year_start",{member_id:person.id,new_label:label});
        },"btn secondary"));archive.append(row);
        const old=(this.data.school_years||[]).filter(y=>y.member_id===person.id).slice().reverse();
        if(old.length){archive.append(this.el("strong",null,"Gespeicherte Schuljahre"));
          old.forEach(y=>{const r=this.el("div","item");r.append(this.el("div","item-main",`${y.label} · ${(y.lessons||[]).length} Einträge · gesichert ${y.saved_at||""}`));
            r.append(this.button("↩ Wiederherstellen",()=>{if(confirm(`Den aktuellen Stundenplan von ${person.name} durch „${y.label}“ ersetzen? Der aktuelle wird vorher automatisch archiviert.`))this.request("school_year_restore",{member_id:person.id,year_id:y.id});},"btn secondary"));archive.append(r);});
        } else archive.append(this.el("div","small","Noch keine archivierten Schuljahre."));
        group.append(archive);
      }
      if(!child && mode==="school")this.renderPackSettings(group,person,mine);
      if(mode==="school"){
        const status=this.schoolNowNext(person.id);
        const banner=this.el("div","school-live-info");
        if(status.absence)banner.append(this.el("strong",null,this.schoolAbsenceText(status.absence)));
        else if(status.current||status.next){
          if(status.current)banner.append(this.el("strong",null,`📚 Jetzt: ${status.current.title}${status.current.end_time?" bis "+status.current.end_time:""}`));
          else banner.append(this.el("span",null,"⏳ Gerade keine Unterrichtsstunde"));
          if(status.next)banner.append(this.el("span",null,`➡️ Danach: ${status.next.title} · ${status.next.time} Uhr`));
        }else banner.append(this.el("span",null,"🌿 Aktuell kein Unterricht eingetragen"));
        group.append(banner);
      }
      const week=this.el("div","school-week");
      for(let d=0;d<7;d++){
        if(d>4&&!mine.some(x=>Number(x.weekday)===d))continue;
        const block=this.el("section",`school-day ${d===currentDay?"school-day-now":""}`);
        block.append(this.el("h3",null,`${d===currentDay?"☀️ Heute · ":""}${days[d]}`));
        const dayDate=this.addDays(this.monday(new Date()),d);
        const dayAbsence=this.schoolAbsenceFor(person.id,this.isoDate(dayDate));
        const dayItems=mine.filter(x=>Number(x.weekday)===d);
        if(dayAbsence)block.append(this.el("div","school-absence-badge",this.schoolAbsenceText(dayAbsence)));
        if(!dayItems.length && !dayAbsence)block.append(this.el("div","small","Noch nichts eingetragen"));
        for(const item of dayAbsence&&child?[]:dayItems){
          const card=this.el("div","school-entry");card.append(this.el("span","school-entry-icon",item.icon||"🎒"));
          const info=this.el("div","school-entry-info");info.append(this.el("strong",null,item.title));
          if(item.time)info.append(this.el("span","small",`${item.time}${item.end_time?" – "+item.end_time:""} Uhr`));
          card.append(info);
          if(!child){
            card.append(this.button("✏️",()=>{this.editSchool={...item};this.schoolNewFor=null;this.render();},"btn secondary"));
            card.append(this.button("🗑️",()=>{if(confirm(`Eintrag „${item.title}“ löschen?`))this.request("school_delete",{entry_id:item.id});},"btn secondary"));
          }
          block.append(card);
        }
        if(!child&&(mode==="school"||!dayItems.length)){
          block.append(this.button(mode==="school"?"➕ Stunde":"➕ Eintrag",()=>{this.editSchool=null;this.schoolNewFor=person.id;this.schoolNewDay=d;this.render();},"btn secondary"));
        }
        week.append(block);
      }
      group.append(week);section.append(group);
    }
    if(!child && people.length){
      const edit=this.editSchool;
      const selected=edit?.member_id||this.schoolNewFor;
      if(selected){
        const person=people.find(m=>m.id===selected);
        const mode=(this.data.school_modes||{})[selected]||([0,1,2,3,4,5,6].some(d=>entries.filter(x=>x.member_id===selected&&Number(x.weekday)===d).length>1)?"school":"kindergarten");
        const model=edit||{member_id:selected,weekday:this.schoolNewDay,title:"",icon:mode==="school"?"📚":"🎒",time:"",end_time:""};
        const form=this.el("form","formgrid");
        const heading=this.el("h3",null,`${edit?"✏️ Bearbeiten":"➕ Hinzufügen"} · ${person?.name||""} · ${mode==="school"?"Stundenplan":"Kindergarten"}`);
        section.append(heading);
        const dayField=this.el("label","field");dayField.append(this.el("span","field-title","Wochentag"));
        const day=this.el("select");days.forEach((name,i)=>{const o=this.el("option",null,name);o.value=String(i);day.append(o);});day.value=String(model.weekday);dayField.append(day);
        const title=this.input(mode==="school"?"Fach / Unterricht (z. B. Mathematik)":"Was steht an?", "text",model.title,"title");
        title.querySelector("input").required=true;title.querySelector("input").maxLength=80;
        const clock=this.input("Beginn (optional)","time",model.time||"","time");
        const end=this.input("Ende (optional)","time",model.end_time||"","end_time");
        const iconField=this.el("label","field");iconField.append(this.el("span","field-title","Bildsymbol"));
        const icon=this.el("select");for(const value of ["🎒","📚","✏️","🎨","⚽","🎵","🧮","🔬","📖","🏊","🧸","🥪","🚌","🌳","🧩"]){const o=this.el("option",null,value);o.value=value;icon.append(o);}icon.value=model.icon||"🎒";iconField.append(icon);
        const save=this.el("button","btn",edit?"💾 Änderungen speichern":"➕ Eintrag speichern");save.type="submit";
        form.append(dayField,title,clock,end,iconField,save);
        form.append(this.button("Abbrechen",()=>{this.editSchool=null;this.schoolNewFor=null;this.render();},"btn secondary"));
        form.addEventListener("submit",e=>{
          e.preventDefault();
          const payload={entry_id:model.id||"",member_id:selected,weekday:Number(day.value),title:title.querySelector("input").value,time:clock.querySelector("input").value,end_time:end.querySelector("input").value,icon:icon.value};
          this.request("school_save",payload).then(()=>{if(!this.error){this.editSchool=null;this.schoolNewFor=null;this.render();}});
        });
        section.append(form);
      } else section.append(this.el("p","small","Tippe beim gewünschten Kind und Tag auf ➕ Stunde oder ➕ Eintrag."));
    }
    if(!people.length)section.append(this.el("div","empty","Lege zuerst ein Familienmitglied an."));
    page.append(section);
  }
  async loadMealWeek() {
    if(!this._hass || !this.data._meal_planner_available || this.mealWeekBusy)return;
    this.mealWeekBusy=true;
    this.mealWeekError="";
    this.render();
    try {
      const requested=this.isoDate(this.monday(this.mealWeekAnchor));
      this.mealWeekData=await this._hass.callWS({type:"bamlabs_family_hub/meal_week",week_start:requested});
    } catch(e) {
      this.mealWeekData=null;
      this.mealWeekError=e.message||String(e);
    } finally {this.mealWeekBusy=false;this.render();}
  }
  renderMealWeek(page) {
    if(!this.data._meal_planner_available)return;
    const sec=this.el("section","panel");
    sec.append(this.cardTitle("🍽️ Unser Essen"));
    sec.append(this.el("p","small","Der Wochenplan aus BamLabs Meal Planner – hier nur zum Anschauen."));
    const toolbar=this.el("div","actions");
    toolbar.append(this.button("‹ Vorige Woche",()=>{this.mealWeekAnchor=this.addDays(this.mealWeekAnchor,-7);this.loadMealWeek();},"btn secondary"));
    toolbar.append(this.button("Diese Woche",()=>{this.mealWeekAnchor=new Date();this.loadMealWeek();},"btn secondary"));
    toolbar.append(this.button("Nächste Woche ›",()=>{this.mealWeekAnchor=this.addDays(this.mealWeekAnchor,7);this.loadMealWeek();},"btn secondary"));
    sec.append(toolbar);
    if(this.mealWeekBusy)sec.append(this.el("p","small","🍲 Speiseplan wird geladen …"));
    if(this.mealWeekError)sec.append(this.el("p","notice",`Speiseplan konnte nicht geladen werden: ${this.mealWeekError}`));
    const week=this.mealWeekData;
    if(!this.mealWeekBusy && week && !week.installed)sec.append(this.el("p","small","Meal Planner ist nicht eingerichtet."));
    if(week?.installed && !this.mealWeekBusy){
      const days=this.el("div","meal-week-days");
      const today=this.isoDate(new Date());
      const fmt=d=>new Date(`${d}T12:00:00`).toLocaleDateString("de-AT",{weekday:"long",day:"numeric",month:"long"});
      for(const day of (week.days||[])) {
        const card=this.el("div",`meal-day-card ${day.date===today?"today":""}`);
        card.append(this.el("div","meal-day-title",`${day.date===today?"🌞 ":""}${fmt(day.date)}`));
        for(const [slot,label] of [["mittag","🥗 Mittagessen"],["abend","🌙 Abendessen"]]) {
          const meal=day[slot]||{};
          const row=this.el("div","meal-row");
          row.append(this.el("strong",null,label),this.el("span",null,meal.name?`${meal.symbol||"🍽️"} ${meal.name}`:"Noch nichts geplant"));
          card.append(row);
        }
        days.append(card);
      }
      sec.append(days);
    }
    page.append(sec);
  }
  renderChild(page) {
    const me = this.data.members[0];
    const tasks = this.data.tasks || [];
    const open = tasks.filter(t => !t.done).sort((a,b) => (a.due || "9999").localeCompare(b.due || "9999"));
    const finished = tasks.filter(t => t.done);
    const now = new Date();
    const localDay = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const today = localDay(now);
    const doNow = open.filter(t => t.due && t.due <= today);
    const later = open.filter(t => !t.due || t.due > today);
    const dueToday = open.filter(t => t.due === today).length;
    const overdue = open.filter(t => t.due && t.due < today).length;

    const welcome = this.el("section", "panel child-welcome kid-hero");
    welcome.style.borderLeft = `6px solid ${me?.color || "#1464db"}`;
    welcome.append(this.el("div","kid-big-title",`🌈 Hallo ${me?.name || "du"}!`));
    const birthday=this.birthdayDays(me||{});
    if(birthday && birthday.days<=30)welcome.append(this.el("div","kid-sub",birthday.days===0?"🎉 Alles Gute zum Geburtstag!":`🎂 Noch ${birthday.days} Tage bis zu deinem Geburtstag!`));
    welcome.append(this.el("p", "kid-sub", "Schön, dass du da bist. Tippe einfach auf die großen Felder. Wenn du etwas geschafft hast, mach ein Häkchen.") );
    const stats = this.el("div", "child-stats");
    [["✅",`${open.length}`,"Noch zu tun"],["⭐",`${this.pointBalance(me?.id)}`,"Sterne"],["📅",`${dueToday}`,"Heute dran"]].forEach(([icon,value,label]) => {
      const stat = this.el("div", "child-stat");
      stat.append(this.el("span", "child-stat-number", `${icon} ${value}`), this.el("span", "small", label));
      stats.append(stat);
    });
    welcome.append(stats);
    const quick=this.el("div","kid-quick-grid");
    const q1=this.button("",()=>{this.tab="tasks";this.render();},"child-big-btn"); q1.append(this.el("span",null,"✅"),this.el("strong",null,"Aufgaben"),this.el("span","mini-note","Was mache ich?"));
    const q2=this.button("",()=>{this.tab="calendar";this.render();},"child-big-btn"); q2.append(this.el("span",null,"📅"),this.el("strong",null,"Termine"),this.el("span","mini-note","Was kommt heute?"));
    const q3=this.button("",()=>{this.tab="today";this.render();},"child-big-btn"); q3.append(this.el("span",null,"⭐"),this.el("strong",null,"Sterne"),this.el("span","mini-note","Meine Belohnungen"));
    const q4=this.button("",()=>{this.tab="routines";this.render();},"child-big-btn"); q4.append(this.el("span",null,"🌈"),this.el("strong",null,"Mein Tag"),this.el("span","mini-note","Meine Routine"));
    const isParent=me?.role==="parent";
    const q5=this.button("",()=>{this.tab=isParent?"work":"school";this.render();},"child-big-btn"); q5.append(this.el("span",null,isParent?"💼":"🎒"),this.el("strong",null,isParent?"Mein Dienstplan":"Schule & Kita"),this.el("span","mini-note",isParent?"Meine Arbeitszeiten":"Mein Wochenplan"));
    const q6=this.button("",()=>{this.tab="lists";this.render();},"child-big-btn"); q6.append(this.el("span",null,"🛒"),this.el("strong",null,"Listen"),this.el("span","mini-note","Was fehlt noch?"));
    const q7=this.button("",()=>{this.tab="childweek";this.weekAnchor=new Date();this.render();},"child-big-btn"); q7.append(this.el("span",null,"🗓️"),this.el("strong",null,"Meine Woche"),this.el("span","mini-note","Was kommt als Nächstes?"));
    const q8=this.button("",()=>{this.tab="success";this.render();},"child-big-btn"); q8.append(this.el("span",null,"🏆"),this.el("strong",null,"Meine Erfolge"),this.el("span","mini-note","Was habe ich geschafft?"));
    quick.append(q4,q7,q5,q6,q1,q2,q3,q8);
    if(this.data._meal_planner_available) {
      const mealBtn=this.button("",()=>{this.tab="meals";this.render();this.loadMealWeek();},"child-big-btn");
      mealBtn.append(this.el("span",null,"🍽️"),this.el("strong",null,"Unser Essen"),this.el("span","mini-note","Was gibt es diese Woche?"));
      quick.append(mealBtn);
    }
    if(!isParent && this.data.school_pack_settings?.[me?.id]?.enabled){
      const bag=this.button("",()=>{this.tab="pack";this.render();},"child-big-btn");
      bag.append(this.el("span",null,"🎒"),this.el("strong",null,"Schultasche"),this.el("span","mini-note","Was brauche ich morgen?"));
      quick.append(bag);
    }
    welcome.append(quick);
    if(overdue) welcome.append(this.el("p", "notice", `⏰ Achtung: ${overdue} ${overdue===1?"Aufgabe ist":"Aufgaben sind"} schon überfällig.`));
    page.append(welcome);
    // Place the children's target immediately before the actual selected view.
    // Keeping it after the large welcome card avoids landing on the shortcuts.
    page.append(this.el("div","hub-content-start"));

    if(this.tab === "meals") this.renderMealWeek(page);
    if(this.tab === "success") this.renderChildSuccess(page);
    if(this.tab === "childweek") this.renderChildWeek(page);
    if(this.tab === "routines") this.renderRoutines(page, true);
    if(this.tab === "school" && !isParent) this.renderSchool(page, true);
    if(this.tab === "pack" && !isParent) this.renderSchoolPack(page);
    if(this.tab === "work" && isParent) this.renderWork(page, true);
    if(this.tab === "lists") this.renderLists(page, true);
    if(this.tab === "today") this.renderRoutines(page, true);
    if(this.tab === "today" && !isParent && (this.schoolAbsenceFor(me.id,this.isoDate(new Date()))||(this.data.school_plan||[]).some(s=>s.weekday===(new Date().getDay()+6)%7))){
      const peek=this.el("section","panel");peek.append(this.cardTitle("🎒 Heute in Schule & Kita"));
      const absent=this.schoolAbsenceFor(me.id,this.isoDate(new Date()));
      if(absent)peek.append(this.el("div","school-absence-badge",this.schoolAbsenceText(absent)));
      else for(const e of (this.data.school_plan||[]).filter(s=>s.weekday===(new Date().getDay()+6)%7).sort((a,b)=>(a.time||"").localeCompare(b.time||""))){peek.append(this.el("div","school-entry",`${e.icon}  ${e.time?e.time+" Uhr · ":""}${e.title}`));}
      peek.append(this.button("Meine Woche ansehen",()=>{this.tab="school";this.render();},"btn secondary"));page.append(peek);
    }
    if(this.tab === "today") this.renderRewards(page, true);
    if(this.tab === "tasks") this.renderRewards(page, true);

    if(this.tab === "today" || this.tab === "tasks") {
      const section = this.el("section", "panel");
      section.append(this.el("h2","kid-section-title","🚀 Mach jetzt"));
      section.append(this.el("p","kid-section-note","Diese Aufgaben sind heute dran oder schon überfällig."));
      if(!doNow.length) section.append(this.el("div", "kid-empty", "Heute ist im Moment nichts Dringendes offen. Super!"));
      else doNow.forEach(t=>section.append(this.childTaskRow(t, today)));
      page.append(section);

      const laterSection = this.el("section", "panel");
      laterSection.append(this.el("h2","kid-section-title","🧩 Später"));
      laterSection.append(this.el("p","kid-section-note","Diese Aufgaben kannst du als Nächstes machen."));
      if(!later.length) laterSection.append(this.el("div", "kid-empty", "Keine weiteren offenen Aufgaben."));
      else later.forEach(t=>laterSection.append(this.childTaskRow(t, today)));
      laterSection.append(this.button(this.childForm === "task" ? "Abbrechen" : "➕ Eigene Aufgabe", () => {
        this.childForm = this.childForm === "task" ? null : "task"; this.render();
      }, "btn child-action"));
      if(this.childForm === "task") {
        const form=this.el("form","formgrid");
        const title=this.input("Was möchtest du machen?","text","","title"); title.querySelector("input").required=true;
        const due=this.input("Wann ungefähr? (freiwillig)","date","","due");
        const submit=this.el("button","btn","Aufgabe speichern"); submit.type="submit";
        form.append(title,due,submit);
        form.addEventListener("submit",e=>{
          e.preventDefault();
          this.request("child_task_create",{title:title.querySelector("input").value,due:due.querySelector("input").value}).then(()=>{
            if(!this.error) this.childForm=null;
            this.render();
          });
        });
        laterSection.append(form);
      }
      page.append(laterSection);

      if(finished.length) {
        const done = this.el("section", "panel");
        done.append(this.el("h2","kid-section-title",`🎉 Schon geschafft (${finished.length})`));
        done.append(this.el("p","kid-section-note","Wenn du aus Versehen ein Häkchen gesetzt hast, tippe einfach noch einmal darauf."));
        if(this.tab === "tasks") finished.forEach(t => done.append(this.childTaskRow(t, today)));
        else done.append(this.button(`🌟 ${finished.length} erledigte Aufgaben ansehen`,()=>{this.tab="tasks";this.render();},"btn secondary child-action"));
        page.append(done);
      }
    }
    if(this.tab === "today" || this.tab === "calendar") {
      const section=this.el("section","panel");
      section.append(this.el("h2","kid-section-title","📅 Meine Termine"));
      section.append(this.el("p","kid-section-note","Hier siehst du, was heute und bald los ist."));
      const events=[...(this.data.events || [])].sort((a,b)=>a.start.localeCompare(b.start));
      const upcoming = this.tab === "today" ? events.filter(e=>(e.end || e.start).slice(0,10)>=today).slice(0,5) : events;
      if(!upcoming.length) section.append(this.el("div","kid-empty","Gerade sind keine Termine eingetragen."));
      else upcoming.forEach(ev=>{
        const item=this.el("div","item");
        const info=this.el("div","item-main");
        const dateStr=ev.start.slice(0,10);
        const hour=ev.all_day || !ev.start.includes("T") ? "Ganztägig" : ev.start.slice(11,16)+" Uhr";
        info.append(this.el("strong",null,ev.title),this.el("div","small",`${this.dateLabel(dateStr)} · ${hour}`));
        item.append(info);section.append(item);
      });
      section.append(this.button(this.childForm==="event"?"Abbrechen":"➕ Eigener Termin",()=>{
        this.childForm=this.childForm==="event"?null:"event";this.render();
      },"btn child-action"));
      if(this.childForm==="event") {
        const form=this.el("form","formgrid");
        const title=this.input("Was ist geplant?","text","","title"); title.querySelector("input").required=true;
        const start=this.input("Beginn","datetime-local","","start");start.querySelector("input").required=true;
        const end=this.input("Ende","datetime-local","","end");end.querySelector("input").required=true;
        const submit=this.el("button","btn","Termin speichern");submit.type="submit";
        form.append(title,start,end,submit);
        form.addEventListener("submit",e=>{
          e.preventDefault();
          const begin=start.querySelector("input").value;
          const finish=end.querySelector("input").value;
          if(finish < begin) {this.error="Das Ende muss nach dem Beginn liegen.";this.render();return;}
          this.request("child_event_create",{title:title.querySelector("input").value,start:begin,end:finish,all_day:false}).then(()=>{
            if(!this.error) this.childForm=null;
            this.render();
          });
        });
        section.append(form);
      }
      page.append(section);
    }
  }
  renderChallengeBlock(page, editable=false) {
    const progress=this.data._challenge_progress||{enabled:false,goal:30,tasks:0,steps:0,count:0};
    if(!editable && !progress.enabled) return;
    const panel=this.el("section","panel family-challenge");
    panel.append(this.cardTitle("🤝 Unsere Familien-Challenge"));
    if(progress.enabled) {
      const target=Math.max(1,Number(progress.goal)||30),count=Number(progress.count)||0;
      const heading=this.el("div","family-challenge-count",`${Math.min(count,target)} von ${target} gemeinsamen Schritten`);
      panel.append(heading);
      const meter=this.el("div","family-progress-track");
      const fill=this.el("div","family-progress-fill");fill.style.width=`${Math.min(100,100*count/target)}%`;meter.append(fill);
      meter.setAttribute("role","progressbar");meter.setAttribute("aria-valuemin","0");meter.setAttribute("aria-valuemax",String(target));meter.setAttribute("aria-valuenow",String(Math.min(count,target)));
      panel.append(meter);
      panel.append(this.el("p","small",`✅ ${progress.tasks||0} Aufgaben · 🌈 ${progress.steps||0} Routine-Schritte – zusammen als Familie`));
      if(count>=target)panel.append(this.el("div","family-challenge-finish","🎉 Geschafft! Gemeinsam sind wir stark! 🎊"));
      if(progress.reward_title) {
        const reward=this.el("div","family-reward-card");
        reward.append(this.el("strong",null,`${progress.reward_emoji||"🎁"} Unsere Familienbelohnung`));
        reward.append(this.el("div","family-reward-title",progress.reward_title));
        const status=progress.reward_claimed ? "✅ Diese Woche schon eingelöst" : progress.reward_unlocked ? "🎉 Freigeschaltet!" : "🔒 Gemeinsam schaffen wir das!";
        reward.append(this.el("p","small",status));
        if(editable && progress.reward_unlocked && !progress.reward_claimed) {
          reward.append(this.button("🎁 Belohnung als eingelöst markieren",()=>this.request("family_reward_claim"),"btn"));
        }
        panel.append(reward);
      }
    } else panel.append(this.el("p","small","Die gemeinsame Challenge ist noch ausgeschaltet. Die persönlichen Punkte funktionieren unabhängig davon."));
    if(editable) {
      const settings=this.el("form","family-challenge-form");
      const enLabel=this.el("label","family-challenge-toggle");const en=this.el("input");en.type="checkbox";en.checked=!!progress.enabled;
      enLabel.append(en,this.el("span",null,"Gemeinsames Wochenziel aktivieren"));settings.append(enLabel);
      const goalLabel=this.el("label","field");goalLabel.append(this.el("span",null,"Unser Wochenziel (Aufgaben + Routine-Schritte)"));
      const goal=this.el("input");goal.type="number";goal.min="1";goal.max="500";goal.required=true;goal.value=String(progress.goal||30);
      goalLabel.append(goal);settings.append(goalLabel);
      const rewardTitleLabel=this.el("label","field");rewardTitleLabel.append(this.el("span",null,"Gemeinsame Belohnung (freiwillig)"));
      const rewardTitle=this.el("input");rewardTitle.type="text";rewardTitle.maxLength=100;rewardTitle.placeholder="z. B. Spieleabend mit der Familie";rewardTitle.value=this.data.family_challenge?.reward_title||"";
      rewardTitleLabel.append(rewardTitle);settings.append(rewardTitleLabel);
      const emojiLabel=this.el("label","field");emojiLabel.append(this.el("span",null,"Symbol zur Belohnung"));
      const emoji=this.el("input");emoji.type="text";emoji.maxLength=8;emoji.value=this.data.family_challenge?.reward_emoji||"🎁";
      emojiLabel.append(emoji);settings.append(emojiLabel);
      const save=this.button("💾 Familienziel & Belohnung speichern",()=>{},"btn");save.type="submit";settings.append(save);
      settings.addEventListener("submit",ev=>{ev.preventDefault();const amount=Number(goal.value);if(!Number.isInteger(amount)||amount<1||amount>500){this.error="Bitte ein Wochenziel zwischen 1 und 500 wählen.";this.render();return;}this.request("challenge_settings_save",{enabled:en.checked,goal:amount,reward_title:rewardTitle.value.trim(),reward_emoji:emoji.value.trim()||"🎁"});});
      panel.append(settings);
      panel.append(this.el("p","small","Das Ziel startet jede Woche am Montag automatisch neu. Keine Rangliste und kein Vergleich zwischen Kindern."));
    }
    page.append(panel);
  }
  renderFamilyStats(page) {
    const today=new Date(),start=this.monday(today),end=this.addDays(start,6);
    const from=this.isoDate(start),to=this.isoDate(end);
    const panel=this.el("section","panel");
    panel.append(this.cardTitle("🏆 Unsere Familienwoche"));
    panel.append(this.el("p","small",`Montag ${this.dateLabel(from)} bis Sonntag ${this.dateLabel(to)} · Jeder kleine Erfolg zählt!`));
    const grid=this.el("div","family-stats-grid");
    for(const member of this.data.members||[]) {
      const mine=id=>id===member.id;
      const tasks=(this.data.task_completions||[]).filter(e=>mine(e.member_id)&&e.date>=from&&e.date<=to).length;
      const steps=(this.data.routine_checks||[]).filter(e=>mine(e.member_id)&&e.date>=from&&e.date<=to).length;
      const stars=(this.data.point_entries||[]).filter(e=>mine(e.member_id)&&e.kind==="earned"&&typeof e.at==="string"&&e.at.slice(0,10)>=from&&e.at.slice(0,10)<=to).reduce((v,e)=>v+Number(e.amount||0),0);
      const card=this.el("div","family-stats-person");card.style.setProperty("--family-person-color",member.color||"#64748b");
      const name=this.el("div","family-stats-name",`${member.avatar||"🙂"} ${member.name}`);card.append(name);
      const counts=this.el("div","family-stats-counts");
      [["✅",tasks,"Aufgaben"],["🌈",steps,"Routine-Schritte"],["⭐",stars,"Neue Sterne"]].forEach(([icon,n,label])=>{
        const tile=this.el("div","family-stats-number");tile.append(this.el("strong",null,`${icon} ${n}`),this.el("span","small",label));counts.append(tile);
      });
      card.append(counts);grid.append(card);
    }
    if(!grid.childNodes.length)grid.append(this.el("p","small","Lege zuerst Familienmitglieder an."));
    panel.append(grid);panel.append(this.el("p","small","Die Wochenstatistik zählt erledigte Aufgaben erst seit v0.3.31. Bereits früher erledigte Aufgaben werden nicht rückwirkend geschätzt."));
    page.append(panel);
    this.renderChallengeBlock(page,true);
  }
  renderChildSuccess(page) {
    const me=this.data.members[0];
    const today=new Date();
    const start=this.monday(today);
    const end=this.addDays(start,6);
    const from=this.isoDate(start), to=this.isoDate(end);
    const myId=me?.id;
    const completions=(this.data.task_completions||[]).filter(e=>e.member_id===myId&&e.date>=from&&e.date<=to);
    const routineChecks=(this.data.routine_checks||[]).filter(e=>e.member_id===myId&&e.date>=from&&e.date<=to);
    const earned=(this.data.point_entries||[]).filter(e=>e.member_id===myId&&e.kind==="earned"&&typeof e.at==="string"&&e.at.slice(0,10)>=from&&e.at.slice(0,10)<=to);
    const points=earned.reduce((sum,e)=>sum+Number(e.amount||0),0);
    const card=this.el("section","panel kid-success-hero");
    card.style.setProperty("--success-color",me?.color||"#3b82f6");
    card.append(this.el("h2","kid-section-title",`🏆 ${me?.name||"Meine"} – meine Erfolge`));
    card.append(this.el("p","kid-section-note",`Diese Woche: ${this.dateLabel(from)} bis ${this.dateLabel(to)}`));
    const summary=this.el("div","kid-success-stats");
    [["✅",completions.length,"Aufgaben geschafft"],["🌈",routineChecks.length,"Routine-Schritte"],["⭐",points,"Sterne gesammelt"]].forEach(([symbol,count,caption])=>{
      const tile=this.el("div","kid-success-stat");
      tile.append(this.el("span","kid-success-symbol",symbol),this.el("strong","kid-success-number",String(count)),this.el("span","kid-success-label",caption));
      summary.append(tile);
    });
    card.append(summary);
    card.append(this.el("div","kid-success-message",completions.length+routineChecks.length===0
      ? "🌱 Jeder kleine Schritt zählt. Fang heute an!"
      : "🎉 Toll gemacht! Du kannst stolz auf dich sein!"));
    const days=this.el("div","kid-success-days");
    for(let i=0;i<7;i++){
      const day=this.addDays(start,i),iso=this.isoDate(day);
      const count=completions.filter(e=>e.date===iso).length+routineChecks.filter(e=>e.date===iso).length;
      const item=this.el("div","kid-success-day");
      if(iso===this.isoDate(today))item.classList.add("is-today");
      item.append(this.el("div","kid-success-dayname",["Mo","Di","Mi","Do","Fr","Sa","So"][i]));
      item.append(this.el("div","kid-success-dayicon",count?"🌟":"🌱"));
      item.append(this.el("div","kid-success-daycount",count?`${count} geschafft`:"–"));
      days.append(item);
    }
    card.append(this.el("h3",null,"📅 Meine Woche auf einen Blick"),days);
    card.append(this.el("p","small","Wir zählen Aufgaben und Routine-Schritte ab Version 0.3.31. Ältere erledigte Aufgaben können wir nicht rückwirkend datieren. Deine bisherigen Sterne bleiben erhalten."));
    page.append(card);
    this.renderChallengeBlock(page,false);
    this.renderProSavings(page,true);
    this.renderProBadges(page,true);
    if(completions.length) {
      const list=this.el("section","panel");
      list.append(this.cardTitle("🎉 Das hast du geschafft"));
      for(const c of [...completions].sort((a,b)=>b.at.localeCompare(a.at)).slice(0,15)){
        const item=this.el("div","item");
        item.append(this.el("span",null,"✅"),this.el("div","item-main",c.title||"Aufgabe"),this.el("span","small",this.dateLabel(c.date)));
        list.append(item);
      }
      page.append(list);
    }
  }
  renderChildWeek(page) {
    // The backend already filters child/tablet state by the selected member.
    const me=this.data.members[0];
    const start=this.monday(this.weekAnchor);
    const today=this.isoDate(new Date());
    const from=this.isoDate(start), to=this.isoDate(this.addDays(start,6));
    const title=this.el("section","panel");
    const header=this.el("div","kid-week-head");
    const avatar=this.el("span","kid-week-avatar",me?.avatar||"🙂");
    avatar.style.background=(me?.color||"#3b82f6")+"26";
    const heading=this.el("div");
    heading.append(this.el("h2","kid-section-title",`🗓️ ${me?.name||"Meine"} – meine Woche`));
    heading.append(this.el("p","kid-section-note","Hier siehst du, was an jedem Tag los ist."));
    header.append(avatar,heading);title.append(header);
    const controls=this.el("div","kid-week-controls");
    controls.append(this.button("‹ Letzte Woche",()=>{this.weekAnchor=this.addDays(this.weekAnchor,-7);this.render();},"btn secondary"));
    controls.append(this.button("Diese Woche",()=>{this.weekAnchor=new Date();this.render();},"btn secondary"));
    controls.append(this.button("Nächste Woche ›",()=>{this.weekAnchor=this.addDays(this.weekAnchor,7);this.render();},"btn secondary"));
    title.append(controls);
    const grid=this.el("div","kid-week-days");
    const tasks=this.data.tasks||[];
    const school=this.data.school_plan||[];
    const routines=this.data.routines||[];
    const occurrences=this.occurrences(from,to);
    for(let i=0;i<7;i++) {
      const date=this.addDays(start,i), iso=this.isoDate(date), weekday=(date.getDay()+6)%7;
      const day=this.el("section",`kid-week-day${iso===today?" is-today":""}`);
      day.style.setProperty("--kid-color",me?.color||"#3b82f6");
      const dhead=this.el("div","kid-week-date",`${["Montag","Dienstag","Mittwoch","Donnerstag","Freitag","Samstag","Sonntag"][i]} ${date.getDate()}.${date.getMonth()+1}.`);
      if(iso===today)dhead.append(this.el("small",null,"🌟 Heute"));
      day.append(dhead);
      let count=0;
      const addGroup=(symbol,label,entries,renderEntry)=>{
        if(!entries.length)return;
        const group=this.el("div","kid-week-group");
        group.append(this.el("div","kid-week-group-title",`${symbol} ${label}`));
        entries.forEach(item=>group.append(renderEntry(item)));
        day.append(group);count+=entries.length;
      };
      const due=tasks.filter(t=>t.due===iso&&!t.done);
      addGroup("✅","Aufgaben",due,task=>{
        const row=this.el("div","kid-week-entry");
        if(iso===today){
          const cb=this.el("input","check");cb.type="checkbox";cb.disabled=this.busy;cb.checked=!!task.done;
          cb.setAttribute("aria-label",`${task.title} erledigen`);
          cb.addEventListener("change",()=>this.setTaskMember(task.id,me?.id||""));
          row.append(cb);
        } else row.append(this.el("span",null,task.icon||"✅"));
        row.append(this.el("span","kid-week-entry-text",task.title));return row;
      });
      if(me?.role==="parent") {
        addGroup("💼","Dienstplan",this.workForDate(me.id,date),entry=>{
          const row=this.el("div","kid-week-entry");row.append(this.el("span",null,"💼"),this.el("span","kid-week-entry-text",`${entry.time?entry.time+(entry.end_time?"–"+entry.end_time:"")+" · ":""}${this.workKindLabel(entry)}`));return row;
        });
      } else {
        const absence=this.schoolAbsenceFor(me.id,iso);
        if(absence)addGroup("🏖️","Schule & Kita",[absence],entry=>this.el("div","kid-week-entry",this.schoolAbsenceText(entry)));
        else {
          const lessons=school.filter(x=>Number(x.weekday)===weekday).sort((a,b)=>(a.time||"").localeCompare(b.time||""));
          if(iso===today && lessons.length){
            const status=this.schoolNowNext(me.id);
            const info=this.el("div","kid-school-status");
            if(status.current){
              info.append(this.el("strong",null,`📚 Jetzt: ${status.current.title}`));
              if(status.current.end_time)info.append(this.el("div","small",`Bis ${status.current.end_time} Uhr`));
            } else if(status.next){
              info.append(this.el("strong",null,`☕ Gerade frei – danach: ${status.next.title}`));
            } else if(lessons.some(l=>l.end_time)){
              info.append(this.el("strong",null,"🎉 Der Unterricht ist für heute vorbei"));
            }
            if(status.current && status.next)info.append(this.el("div","small",`➡️ Danach: ${status.next.title} um ${status.next.time} Uhr`));
            else if(!status.current && status.next)info.append(this.el("div","small",`Beginn ${status.next.time} Uhr`));
            if(info.childNodes.length)day.append(info);
          }
          addGroup("🎒","Schule & Kita",lessons,entry=>{
            const row=this.el("div","kid-week-entry kid-lesson-entry");
            const times=this.el("span","kid-lesson-time",entry.time?`${entry.time}${entry.end_time?"–"+entry.end_time:""} Uhr`:"Ohne Uhrzeit");
            const subject=this.el("span","kid-week-entry-text",`${entry.icon||"📚"} ${entry.title}`);
            const details=this.el("span","kid-lesson-info");details.append(times,subject);
            row.append(details);
            if(iso===today && entry.time && entry.end_time){
              const now=new Date(),clock=`${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
              if(entry.time<=clock && clock<entry.end_time)row.classList.add("is-current");
              else if(entry.end_time<=clock)row.classList.add("is-past");
            }
            return row;
          });
        }
      }
      const dayRoutines=routines.filter(r=>(r.days||[]).includes(weekday));
      if(dayRoutines.length){
        const details=this.el("details","kid-routines-fold");
        const summary=this.el("summary","kid-week-group-title",`🌈 Routinen (${dayRoutines.length})`);
        details.append(summary);
        for(const r of dayRoutines){
          const row=this.el("div","kid-week-entry");
          row.append(this.el("span",null,r.icon||"🌈"),this.el("span","kid-week-entry-text",`${r.title} (${(r.steps||[]).length} Schritte)`));
          details.append(row);
        }
        day.append(details);count+=dayRoutines.length;
      }
      addGroup("📅","Termine",occurrences.filter(o=>o.start<=iso&&o.end>=iso),o=>{
        const row=this.el("div","kid-week-entry");row.append(this.el("span",null,"📅"),this.el("span","kid-week-entry-text",`${o.time&&o.start===iso?o.time+" · ":""}${o.event.title}`));return row;
      });
      if(!count)day.append(this.el("div","kid-week-empty","🎈 Heute ist nichts geplant."));
      grid.append(day);
    }
    title.append(grid);
    title.append(this.el("p","small","Routinen kannst du am jeweiligen Tag unter 🌈 Mein Tag abhaken. Aufgaben lassen sich hier nur für heute abhaken."));
    page.append(title);
  }
  childTaskRow(task, today) {
    const item=this.el("label",`item child-task ${task.done?"done":""}`);
    const check=this.el("input","check");check.type="checkbox";check.checked=!!task.done;check.disabled=this.busy;
    check.setAttribute("aria-label",`${task.title} ${task.done?"wieder öffnen":"erledigen"}`);
    check.addEventListener("change",()=>this.request("task_toggle",{task_id:task.id}));
    const details=this.el("span","item-main");details.append(this.el("strong","item-title",`${task.icon||"✅"} ${task.title}`));
    if(task.points > 0) details.append(this.el("div","small",`⭐ ${task.points} Punkte`));
    if(task.repeat && task.repeat!=="none") details.append(this.el("div","small","🔁 Wiederkehrende Aufgabe"));
    if(task.due){
      const due=this.el("div","small",`${task.due<today && !task.done ? "⏰" : "📅"} Bis ${this.dateLabel(task.due)}`);
      if(!task.done && task.due<today) due.classList.add("tag-high");
      details.append(due);
    }
    item.append(check,details);
    return item;
  }
  iconOptions() {
    return [["✅","Erledigen"],["🌞","Sonne"],["🌙","Mond"],["🪥","Zähne putzen"],["👕","Anziehen"],["🥣","Frühstück"],["🎒","Schultasche"],["🛏️","Bett"],["🧸","Spielen"],["📚","Lesen"],["🧼","Hände waschen"],["🍽️","Essen"],["🐶","Haustier"],["⭐","Stern"],["💧","Trinken"],["🧹","Aufräumen"],["🚿","Duschen"],["🚲","Draußen"],["🎨","Malen"],["🌈","Regenbogen"],["🏠","Zuhause"],["🎵","Musik"]];
  }
  iconPicker(label, selected="✅") {
    const field=this.el("label","field"); field.append(this.el("span","field-title",label));
    const select=this.el("select");
    for (const [symbol,title] of this.iconOptions()) {const opt=this.el("option",null,`${symbol} ${title}`);opt.value=symbol;select.append(opt);}
    select.value=selected;field.append(select);return field;
  }
  routineDone(routine,memberId,stepId) {
    const today=this.isoDate(new Date());
    return (this.data.routine_checks||[]).some(c=>c.routine_id===routine.id&&c.member_id===memberId&&c.step_id===stepId&&c.date===today);
  }
  routineToday(routine) {return (routine.days||[]).includes((new Date().getDay()+6)%7);}
  renderRoutines(page,child=false) {
    const section=this.el("section","panel routine-hero");
    section.append(this.cardTitle(child?"🌈 Mein Tagesablauf":"🌈 Unsere Tagesabläufe"));
    section.append(this.el("p","small",child?"Tippe auf ein Bild, wenn du etwas geschafft hast. Morgen geht es wieder von vorne los.":"Morgen, Abend oder eigene Routinen. Große Bilder helfen auch Kindern, die noch nicht lesen können."));
    const all=(this.data.routines||[]);
    const today=all.filter(r=>this.routineToday(r));
    if(child){
      if(!today.length)section.append(this.el("div","kid-empty","🎈 Heute hast du keine Routine. Viel Spaß!"));
      else {const grid=this.el("div","routine-grid");today.forEach(r=>grid.append(this.routineCard(r,this.data._member_id)));section.append(grid);}
    }else{
      const todaySection=this.el("section","today-routines");
      todaySection.append(this.el("h3","kid-section-title","🌞 Das steht heute an"));
      todaySection.append(this.el("p","kid-section-note","Jedes Kind kann seine Schritte direkt hier auf dem Familientablet abhaken."));
      const personList=this.el("div","routine-person-list");
      // Keep all routines of one child together, in the configured member order.
      for(const member of this.data.members){
        const mine=today.filter(r=>(r.member_ids||[]).includes(member.id));
        if(!mine.length)continue;
        const group=this.el("section","routine-person-group");
        const head=this.el("div","routine-person-head");
        const hex=/^#[0-9a-fA-F]{6}$/.test(member.color||"")?member.color:"#64748b";
        head.style.backgroundColor=hex;
        // White or dark text, depending on the luminance of the profile colour.
        const red=parseInt(hex.slice(1,3),16),green=parseInt(hex.slice(3,5),16),blue=parseInt(hex.slice(5,7),16);
        const luminance=(0.2126*red+0.7152*green+0.0722*blue)/255;
        head.style.color=luminance>0.62?"#142033":"#ffffff";
        const avatar=this.el("span","routine-person-avatar",member.name.slice(0,1).toUpperCase());
        const who=this.el("div","routine-person-heading");
        who.append(this.el("strong",null,`👤 ${member.name}`));
        const total=mine.reduce((sum,r)=>sum+(r.steps||[]).length,0);
        const done=mine.reduce((sum,r)=>sum+(r.steps||[]).filter(step=>this.routineDone(r,member.id,step.id)).length,0);
        who.append(this.el("span",null,done===total?"🎉 Alles geschafft!":`${done} von ${total} Schritten geschafft`));
        head.append(avatar,who);
        const status=this.el("span","routine-person-status",done===total?"✅ Fertig":"🧩 Noch zu tun");
        head.append(status);
        group.append(head);
        const progress=this.el("div","routine-person-progress");
        const meter=this.el("div","routine-meter");
        const fill=this.el("div","routine-meter-fill");
        fill.style.width=`${total?done/total*100:100}%`;
        fill.style.backgroundColor=hex;
        meter.append(fill);progress.append(meter);group.append(progress);
        const cards=this.el("div","routine-person-cards");
        mine.forEach(r=>cards.append(this.routineCard(r,member.id)));
        group.append(cards);
        personList.append(group);
      }
      if(!personList.children.length) todaySection.append(this.el("div","kid-empty","🎉 Heute steht keine Routine an."));
      else todaySection.append(personList);
      section.append(todaySection);
      section.append(this.el("h3","kid-section-title","⚙️ Routinen verwalten"));
      const grid=this.el("div","routine-grid");
      if(!all.length)section.append(this.el("div","kid-empty","Noch keine Tagesabläufe erstellt. Beginne mit einer Morgenroutine!"));
      all.forEach(r=>{
        const card=this.el("div","routine-card");
        card.append(this.el("div","routine-name",`${r.icon} ${r.title}`));
        card.append(this.el("p","routine-quiet",`${(r.member_ids||[]).map(id=>this.memberName(id)).join(", ")} · ${["Mo","Di","Mi","Do","Fr","Sa","So"].filter((_,i)=>r.days.includes(i)).join(" · ")}`));
        const row=this.el("div","actions");
        row.append(this.button("✏️ Bearbeiten",()=>{this.editRoutine=JSON.parse(JSON.stringify(r));this.render();},"btn secondary"));
        row.append(this.button("🗑️ Löschen",()=>{if(confirm(`Routine „${r.title}“ löschen?`))this.request("routine_delete",{routine_id:r.id});},"btn secondary danger"));
        card.append(row);
        grid.append(card);
      });
      section.append(grid);
      section.append(this.button(this.editRoutine?"Abbrechen":"➕ Neuen Tagesablauf erstellen",()=>{this.editRoutine=this.editRoutine?null:{title:"",icon:"🌞",days:[0,1,2,3,4,5,6],member_ids:[],steps:[{id:"",icon:"🪥",title:"Zähne putzen"},{id:"",icon:"👕",title:"Anziehen"}]};this.render();},"btn"));
      if(this.editRoutine)section.append(this.routineForm());
    }
    page.append(section);
  }
  routineCard(r,memberId,compact=false) {
    const card=this.el("section","routine-card");
    const me=this.data.members.find(m=>m.id===memberId);
    if(!compact){const head=this.el("div","routine-head");head.append(this.el("span","routine-emoji",r.icon),this.el("span","routine-name",r.title));card.append(head);}
    else card.append(this.el("div","routine-quiet",`${me?.name||"Person"} · heute`));
    const done=r.steps.filter(step=>this.routineDone(r,memberId,step.id)).length;
    card.append(this.el("div","small",done===r.steps.length?"🎉 Alles geschafft!":`${done} von ${r.steps.length} geschafft`));
    const meter=this.el("div","routine-meter");const fill=this.el("div","routine-meter-fill");fill.style.width=`${done/(r.steps.length||1)*100}%`;meter.append(fill);card.append(meter);
    const steps=this.el("div","routine-step-grid");
    for(const step of r.steps){
      const checked=this.routineDone(r,memberId,step.id);
      const b=this.button("",()=>this.request("routine_toggle",{routine_id:r.id,step_id:step.id,member_id:memberId}),`routine-step ${checked?"done":""}`);
      b.setAttribute("aria-pressed",String(checked));b.setAttribute("aria-label",`${step.title}: ${checked?"geschafft":"noch offen"}`);
      b.append(this.el("span","routine-symbol",step.icon),this.el("strong",null,step.title),this.el("span","small",checked?"✅ Geschafft":"Tippe mich an"));
      steps.append(b);
    }
    card.append(steps);return card;
  }
  routineForm() {
    const model=this.editRoutine;
    const form=this.el("form","formgrid");
    const title=this.input("Wie heißt die Routine?","text",model.title,"title");title.querySelector("input").required=true;
    const icon=this.iconPicker("Bild für den Tagesablauf",model.icon);
    title.querySelector("input").addEventListener("input",()=>{model.title=title.querySelector("input").value;});
    icon.querySelector("select").addEventListener("change",()=>{model.icon=icon.querySelector("select").value;});
    const days=this.el("fieldset","full");days.style.border="0";days.style.padding="0";days.append(this.el("legend","field-title","An welchen Tagen?"));
    const dayChecks=[];
    ["Mo","Di","Mi","Do","Fr","Sa","So"].forEach((day,i)=>{const lab=this.el("label","routine-day");const cb=this.el("input");cb.type="checkbox";cb.checked=model.days.includes(i);dayChecks.push(cb);cb.addEventListener("change",()=>{model.days=dayChecks.map((c,j)=>c.checked?j:null).filter(v=>v!==null);});lab.append(cb,this.el("span",null,day));days.append(lab);});
    const people=this.el("fieldset","full");people.style.border="0";people.style.padding="0";people.append(this.el("legend","field-title","Für wen?"));
    const who=[];this.data.members.forEach(m=>{const lab=this.el("label","person-choice");const cb=this.el("input");cb.type="checkbox";cb.checked=model.member_ids.includes(m.id);who.push([m.id,cb]);cb.addEventListener("change",()=>{model.member_ids=who.filter(([_,c])=>c.checked).map(([id])=>id);});lab.append(cb,this.el("span",null,m.name));people.append(lab);});
    const stepBlock=this.el("div","routine-form-steps");stepBlock.append(this.el("h3",null,"🧩 Schritte – in der richtigen Reihenfolge"));
    const redraw=()=>{
      stepBlock.querySelectorAll(".routine-step-edit").forEach(node=>node.remove());
      model.steps.forEach((step,i)=>{
        const row=this.el("div","routine-step-edit");const iconField=this.iconPicker("Bild",step.icon||"✅");
        iconField.querySelector("select").addEventListener("change",()=>{step.icon=iconField.querySelector("select").value;});
        const text=this.input(`Schritt ${i+1}`,"text",step.title,"step");text.querySelector("input").required=true;
        text.querySelector("input").addEventListener("input",()=>{step.title=text.querySelector("input").value;});
        row.append(iconField,text,this.button("×",()=>{model.steps.splice(i,1);this.render();},"btn secondary danger"));stepBlock.append(row);
      });
    };
    redraw();
    const add=this.button("➕ Schritt hinzufügen",()=>{if(model.steps.length<12){model.steps.push({id:"",icon:"✅",title:""});this.render();}},"btn secondary");
    add.classList.add("full");const save=this.el("button","btn full","✅ Tagesablauf speichern");save.type="submit";
    form.append(title,icon,days,people,stepBlock,add,save);
    form.addEventListener("submit",e=>{
      e.preventDefault();
      if(!model.steps.length){this.error="Bitte mindestens einen Schritt hinzufügen";this.render();return;}
      const chosenDays=dayChecks.map((v,i)=>v.checked?i:null).filter(v=>v!==null);
      const member_ids=who.filter(([_,cb])=>cb.checked).map(([id])=>id);
      if(!chosenDays.length||!member_ids.length){this.error="Bitte Person und Wochentag wählen";this.render();return;}
      this.request("routine_save",{routine_id:model.id||"",title:title.querySelector("input").value,icon:icon.querySelector("select").value,days:chosenDays,member_ids,steps:model.steps.map(s=>({...s,title:s.title.trim()}))}).then(()=>{if(!this.error){this.editRoutine=null;this.render();}});
    });
    return form;
  }
  renderMembers(page) {
    const card=this.el("section","panel");card.append(this.cardTitle("Familienmitglieder"));
    const add=this.button(this.editMember?"Bearbeitung abbrechen":"+ Familienmitglied hinzufügen",()=>{this.editMember=this.editMember?null:{name:"",color:"#3B82F6",avatar:"🙂",role:"child"};this.render();});card.append(add);
    if(this.editMember){
      const f=this.el("form","formgrid");const n=this.input("Name","text",this.editMember.name,"name");n.querySelector("input").required=true;
      const c=this.input("Farbe","color",this.editMember.color,"color");
      const avatarLabel=this.el("label","field");
      avatarLabel.append(this.el("span","field-title","Bild-Symbol für die Kinderauswahl"));
      const avatarSelect=this.el("select");
      ["🙂","👧","👦","🧒","👩","👨","👶","🦊","🐻","🐼","🐰","🦄","🐱","🐶","🌈","⭐"].forEach(symbol=>{
        const o=this.el("option",null,symbol);o.value=symbol;avatarSelect.append(o);
      });
      avatarSelect.value=this.editMember.avatar||"🙂";
      avatarLabel.append(avatarSelect);
      const roleLabel=this.el("label","field");roleLabel.append(this.el("span","field-title","Familienrolle"));
      const roleSel=this.el("select");for(const [value,label] of [["child","🧒 Kind"],["parent","👨‍👩‍👧 Elternteil"]]){const opt=this.el("option",null,label);opt.value=value;roleSel.append(opt);}
      roleSel.value=this.editMember.role||"child";roleLabel.append(roleSel);
      const birthday=this.input("Geburtsdatum (optional)","date",this.editMember.birthday||"","birthday");
      f.append(n,c,avatarLabel,roleLabel,birthday);
      const save=this.el("div","full");const submit=this.el("button","btn","Speichern");submit.type="submit";save.append(submit);
      f.append(save);f.addEventListener("submit",e=>{e.preventDefault();this.request("member_save",{member_id:this.editMember.id||"",name:n.querySelector("input").value,color:c.querySelector("input").value,avatar:avatarSelect.value,role:roleSel.value,birthday:birthday.querySelector("input").value});});card.append(f);
    }
    const list=this.el("div","list");
    this.data.members.forEach(m=>{const r=this.el("div","item");const dot=this.el("span","dot");dot.style.background=m.color;
      const name=this.el("div","item-main item-title",`${m.avatar||"🙂"} ${m.name} · ${m.role==="parent"?"Elternteil":"Kind"}${m.birthday?" · 🎂 "+m.birthday.slice(8,10)+"."+m.birthday.slice(5,7)+".":""}`);r.append(dot,name);
      r.append(this.button("Bearbeiten",()=>{this.editMember={...m};this.render();},"btn secondary"));
      r.append(this.button("Löschen",()=>{if(confirm(`„${m.name}“ löschen? Aufgaben bleiben erhalten, aber die Zuordnung wird entfernt.`))this.request("member_delete",{member_id:m.id});},"btn secondary danger"));list.append(r);
    });
    if(!this.data.members.length)list.append(this.el("div","empty","Noch keine Familienmitglieder angelegt."));
    card.append(list);page.append(card);
    const settings=this.data.birthday_settings||{};
    const notify=this.el("section","panel");notify.append(this.cardTitle("🎁 Geburtstags-Erinnerungen für Eltern"));
    notify.append(this.el("p","small","Optional. Standardmäßig ausgeschaltet. Am Geburtstag und einmal vorab erhalten Eltern eine Home-Assistant-Mitteilung; bei eingerichteten Eltern-Handys zusätzlich eine Push-Nachricht."));
    const form=this.el("form","formgrid");
    const enabled=this.el("label","field");enabled.append(this.el("span","field-title","Erinnerung aktivieren"));
    const checkbox=this.el("input");checkbox.type="checkbox";checkbox.checked=!!settings.enabled;checkbox.style.width="24px";enabled.append(checkbox);
    const lead=this.el("label","field");lead.append(this.el("span","field-title","Vorher erinnern"));const leadSel=this.el("select");
    [1,3,7,14].forEach(n=>{const o=this.el("option",null,`${n} Tag${n!==1?"e":""} vorher`);o.value=n;leadSel.append(o);});leadSel.value=String(settings.days_before||7);lead.append(leadSel);
    const hour=this.el("label","field");hour.append(this.el("span","field-title","Uhrzeit"));const hourSel=this.el("select");
    for(let h=0;h<24;h++){const o=this.el("option",null,`${String(h).padStart(2,"0")}:00 Uhr`);o.value=h;hourSel.append(o);}hourSel.value=String(settings.hour??8);hour.append(hourSel);
    const save=this.el("button","btn","Erinnerungen speichern");save.type="submit";
    form.append(enabled,lead,hour,save);form.addEventListener("submit",ev=>{ev.preventDefault();this.request("birthday_settings_save",{enabled:checkbox.checked,days_before:Number(leadSel.value),hour:Number(hourSel.value)});});
    notify.append(form);page.append(notify);
    this.renderBirthdays(page);

  }
  renderTasks(page) {
    const card=this.el("section","panel");card.append(this.cardTitle("Aufgaben & Haushalt"));
    card.append(this.button(this.editTask?"Bearbeitung abbrechen":"+ Neue Aufgabe",()=>{this.editTask=this.editTask?null:{title:"",description:"",due:"",priority:"normal",repeat:"none",points:0,assignees:[]};this.render();}));
    if(this.editTask){
      const f=this.el("form","formgrid");const title=this.input("Aufgabe","text",this.editTask.title,"title");title.querySelector("input").required=true;
      const due=this.input("Fällig am (optional)","date",this.editTask.due,"due");
      const iconField=this.iconPicker("Symbol zur Aufgabe",this.editTask.icon||"✅");
      const desc=this.el("label","field full");desc.append(this.el("span","field-title","Beschreibung (optional)"));
      const ta=this.el("textarea");ta.value=this.editTask.description||"";ta.maxLength=1500;desc.append(ta);
      const priority=this.el("label","field");priority.append(this.el("span","field-title","Priorität"));
      const select=this.el("select");[["low","Niedrig"],["normal","Normal"],["high","Hoch"]].forEach(([k,v])=>{const o=this.el("option",null,v);o.value=k;select.append(o);});select.value=this.editTask.priority;priority.append(select);
      const recurring=this.el("label","field");recurring.append(this.el("span","field-title","Wiederholung"));
      const repeat=this.el("select");[["none","Einmalig"],["daily","Jeden Tag"],["weekly","Jede Woche"],["biweekly","Alle 2 Wochen"],["monthly","Jeden Monat"],["yearly","Jedes Jahr"]].forEach(([id,label])=>{const opt=this.el("option",null,label);opt.value=id;repeat.append(opt);});
      repeat.value=this.editTask.repeat||"none";recurring.append(repeat);
      recurring.append(this.el("span","small","Bei Wiederholung bitte den ersten Fälligkeitstag wählen (z. B. Samstag). Nach dem Abhaken entsteht automatisch der nächste Termin."));
      const earned=this.input("Punkte für diese Aufgabe (0–100)","number",String(this.editTask.points||0),"points");
      earned.querySelector("input").min="0";earned.querySelector("input").max="100";
      const assigned=this.el("fieldset","field full");assigned.style.border="0";assigned.style.padding="0";
      assigned.append(this.el("legend","field-title","Zuständig (mehrere möglich)"));
      const checks=[];
      this.data.members.forEach(m=>{const label=this.el("label","person-choice");const ch=this.el("input");ch.type="checkbox";ch.value=m.id;ch.checked=this.editTask.assignees.includes(m.id);checks.push(ch);label.append(ch,this.el("span",null,m.name));assigned.append(label);});
      if(!this.data.members.length)assigned.append(this.el("span","small","Noch keine Personen angelegt – Aufgabe kann auch unzugeordnet bleiben."));
      const bottom=this.el("div","full");const save=this.el("button","btn","Aufgabe speichern");save.type="submit";bottom.append(save);
      f.append(title,iconField,due,priority,recurring,earned,desc,assigned,bottom);
      f.addEventListener("submit",e=>{e.preventDefault();this.request("task_save",{task_id:this.editTask.id||"",title:title.querySelector("input").value,description:ta.value,due:due.querySelector("input").value,priority:select.value,repeat:repeat.value,points:Number(earned.querySelector("input").value),icon:iconField.querySelector("select").value,assignees:checks.filter(c=>c.checked).map(c=>c.value)});});
      card.append(f);
    }
    const filter=this.el("label","field");filter.append(this.el("span","field-title","Aufgaben anzeigen für"));
    const picker=this.el("select");const all=this.el("option",null,"Alle Familienmitglieder");all.value="";picker.append(all);
    for(const member of this.data.members){const option=this.el("option",null,member.name);option.value=member.id;picker.append(option);}
    picker.value=this.taskFilter||"";
    picker.addEventListener("change",()=>{this.taskFilter=picker.value;this.render();});filter.append(picker);card.append(filter);
    const visible=this.data.tasks.filter(t=>!this.taskFilter||(t.assignees||[]).includes(this.taskFilter));
    const pending=visible.filter(t=>this.taskFilter?!this.completedFor(t,this.taskFilter):!this.completedForAll(t)).sort((a,b)=>(a.due||"9999").localeCompare(b.due||"9999"));
    const done=visible.filter(t=>this.taskFilter?this.completedFor(t,this.taskFilter):this.completedForAll(t));
    card.append(this.el("h3",null,`Offen (${pending.length})`));
    if(!pending.length)card.append(this.el("div","empty","Keine offenen Aufgaben."));else pending.forEach(t=>card.append(this.taskRow(t)));
    card.append(this.el("h3",null,`Erledigt (${done.length})`));
    done.forEach(t=>card.append(this.taskRow(t)));page.append(card);
    this.renderRewards(page);
  }
  taskRow(t) {
    const fullyDone=this.completedForAll(t);
    const r=this.el("div",`item ${fullyDone?"done":""}`);
    if((t.assignees||[]).length<=1){
      const ch=this.el("input","check");ch.type="checkbox";ch.checked=fullyDone;ch.title="Erledigt ändern";ch.disabled=this.busy;
      ch.addEventListener("change",()=>this.setTaskMember(t.id,t.assignees?.[0]||""));r.append(ch);
    }
    const main=this.el("div","item-main");main.append(this.el("div","item-title",`${t.icon||"✅"} ${t.title}`));
    if(t.description)main.append(this.el("div","desc",t.description));
    const tags=this.el("div","chips");if(t.due)tags.append(this.el("span","chip",`📅 ${this.dateLabel(t.due)}`));
    if(t.points>0)tags.append(this.el("span","chip",`⭐ ${t.points} Punkte`));
    if(t.priority==="high")tags.append(this.el("span","chip tag-high","Wichtig"));
    const repeatNames={daily:"Täglich",weekly:"Wöchentlich",biweekly:"Alle 2 Wochen",monthly:"Monatlich",yearly:"Jährlich"};
    if(repeatNames[t.repeat])tags.append(this.el("span","chip",`🔁 ${repeatNames[t.repeat]}`));
    if(t.completed_repeat)tags.append(this.el("span","chip","🔁 Wiederholung erstellt"));
    t.assignees.forEach(id=>{const member=this.data.members.find(m=>m.id===id);if(member){const chip=this.el("span","chip",member.name);chip.style.borderLeft=`4px solid ${member.color}`;tags.append(chip);}});
    main.append(tags);
    if(t.assignees?.length>1){
      const statuses=this.el("div","member-badges");statuses.style.marginTop="12px";
      for(const mid of t.assignees){
        const label=this.el("label","person-choice");
        const cb=this.el("input","check");cb.type="checkbox";cb.checked=this.completedFor(t,mid);cb.disabled=this.busy;
        cb.addEventListener("change",()=>this.setTaskMember(t.id,mid));
        label.append(cb,this.el("span",null,`${this.memberName(mid)} · ${cb.checked?"geschafft":"offen"}`));statuses.append(label);
      }
      main.append(statuses);
    }
    r.append(main);
    const buttons=this.el("div","actions");buttons.append(this.button("✎",()=>{this.tab="tasks";this.editTask={...t,assignees:[...t.assignees]};this.render();},"btn secondary"));
    buttons.append(this.button("×",()=>{if(confirm(`Aufgabe „${t.title}“ wirklich löschen?`))this.request("task_delete",{task_id:t.id});},"btn secondary danger"));r.append(buttons);return r;
  }
}
customElements.define("bamlabs-family-hub-panel",BamLabsFamilyHubPanel);

/* PRO preview: responsive savings goal cards. */
