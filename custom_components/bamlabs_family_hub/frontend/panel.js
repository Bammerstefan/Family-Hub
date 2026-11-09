/* BamLabs Family Hub — no external libraries, local Home Assistant storage. */
const FAMILY_HUB_UI_VERSION = "0.3.23";
class BamLabsFamilyHubPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({mode: "open"});
    this.data = {members: [], tasks: [], routines: [], routine_checks: [], events: [], external_calendars: [], calendar_members: {}, rewards: [], point_entries: []};
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
    this.busy = false;
    this.loaded = false;
    this.error = "";
    this.editMember = null;
    this.editTask = null;
    this.editRoutine = null;
    this.childAccounts = null;
    this.qrFor = null;
    this.childForm = null;
    this.showCalendarSetup = false;
    this.pushDevices = [];
    this.pushDevicesLoaded = false;
    this.taskFilter = "";
    this.backendVersion = "";
    this.savedNotice = "";
  }
  connectedCallback() {
    // Refresh visible calendar data regularly while this panel is mounted.
    // Home Assistant's Google integration remains responsible for Google polling.
    if (!this._syncInterval) {
      this._syncInterval = setInterval(() => {
        if (this.isConnected && this.loaded && this._hass) this.refreshExternalEvents(true);
      }, 5 * 60 * 1000);
    }
  }
  disconnectedCallback() {
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
      this.data = await this._hass.callWS({type:"bamlabs_family_hub/state"});
      this.loaded = true;
      this.error = "";
      this.checkVersion();
      if (this.data._role === "admin") {
        this.loadCalendarSources();
        this.loadPushDevices();
        this.refreshExternalEvents();
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
      const saveLabels={calendar_select:"Kalenderauswahl",calendar_member_assign:"Kalenderzuordnung",reminder_settings_save:"Erinnerungseinstellungen",push_settings_save:"Handy-Einstellungen",member_save:"Familienmitglied",task_save:"Aufgabe",routine_save:"Tagesablauf",tablet_settings_save:"Tablet-Zugang",event_save:"Termin",reward_save:"Belohnung"};
      this.savedNotice = saveLabels[type] ? `✅ ${saveLabels[type]} erfolgreich gespeichert.` : "";
      if(type === "tablet_settings_save" && this.childAccounts) this.childAccounts.tablet_user_id=payload.user_id;
      this.editMember = null;
      this.editTask = null;
      this.editEvent = null;
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
      .page{max-width:1120px;margin:0 auto;padding:24px 20px 60px}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}.brand{font-size:25px;font-weight:800;letter-spacing:-.6px}.small{font-size:13px;color:var(--secondary-text-color,#697386)}.nav{display:flex;gap:9px;overflow:auto;margin:23px 0}.tab{border:1px solid var(--divider-color,#dfe5ee);background:var(--card-background-color,#fff);padding:11px 16px;border-radius:12px;color:inherit;white-space:nowrap;font-weight:650}.tab.selected{background:#1464db;color:white;border-color:#1464db}
      .grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:15px}.panel{padding:21px;background:var(--card-background-color,#fff);border:1px solid var(--divider-color,#dfe5ee);border-radius:18px;box-shadow:0 2px 10px #00000008;margin-bottom:16px}.stat{font-size:32px;font-weight:800;margin-top:10px}.heading{font-size:19px;margin:0 0 16px}.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.btn{padding:10px 14px;border-radius:10px;background:#1464db;border:1px solid #1464db;color:#fff;font-weight:650}.secondary{background:transparent;color:var(--primary-text-color,#192238);border-color:var(--divider-color,#cfd6df)}.danger{color:#c32929}.list{display:grid;gap:12px;margin-top:12px}.item{display:flex;align-items:center;gap:13px;border:1px solid var(--divider-color,#e4e8ef);border-radius:12px;padding:12px}.item-main{flex:1;min-width:0}.item-title{font-weight:700;overflow-wrap:anywhere}.desc{font-size:13px;white-space:pre-wrap;margin-top:5px;color:var(--secondary-text-color,#697386)}.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}.chip{display:inline-block;padding:4px 9px;border-radius:999px;background:var(--secondary-background-color,#eef1f6);font-size:12px}.dot{width:15px;height:15px;border-radius:50%;flex-shrink:0;border:1px solid #0002}.check{width:21px;height:21px;cursor:pointer}.done .item-title{text-decoration:line-through;opacity:.6}.field{display:grid;gap:5px;font-weight:650;font-size:14px}.field input,.field textarea,.field select{width:100%;min-height:39px;color:var(--primary-text-color,#192238);background:var(--card-background-color,#fff);border:1px solid var(--divider-color,#cbd3de);border-radius:9px;padding:9px}.field textarea{min-height:86px}.formgrid{display:grid;grid-template-columns:1fr 1fr;gap:13px;margin:15px 0}.full{grid-column:1/-1}.colors{display:flex;gap:8px;flex-wrap:wrap}.person-choice{display:flex;gap:7px;align-items:center;padding:6px 0}.save-success{padding:14px 17px;border-radius:12px;background:#e4f7e9;color:#195c31;font-weight:750;margin:0 0 15px;border:1px solid #a5dfb6}.notice{padding:13px 15px;border-radius:10px;background:#fff2dd;color:#6f4a0b;margin-bottom:15px}.empty{color:var(--secondary-text-color,#697386);padding:24px 0;text-align:center}.footer{margin-top:35px;text-align:center}.tag-high{color:#ba3d25}.muted{color:var(--secondary-text-color,#697386)}.calbar{display:flex;align-items:center;gap:10px;justify-content:space-between;flex-wrap:wrap;margin:12px 0 18px}.calgrid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:5px}.calday{min-height:104px;border:1px solid var(--divider-color,#dfe5ee);border-radius:10px;padding:6px;min-width:0;background:var(--card-background-color,#fff)}.calday.outside{opacity:.48}.daynum{font-weight:750;margin-bottom:6px}.calentry{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%;border:0;border-left:4px solid #1464db;background:var(--secondary-background-color,#eef1f6);text-align:left;border-radius:5px;margin:3px 0;padding:5px;color:var(--primary-text-color,#192238);font-size:12px}.calweek{display:grid;gap:9px}.calendar-stack{display:grid;gap:7px}.calhead{font-size:12px;text-align:center;font-weight:700;padding:8px 2px;color:var(--secondary-text-color,#697386)}.caldate{font-weight:750;margin:8px 0}.calfilters{display:flex;gap:7px;flex-wrap:wrap}
      .week-days{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:9px}.week-column{border:1px solid var(--divider-color,#dfe5ee);border-radius:12px;padding:10px;min-width:0}.week-column.today{border-color:var(--primary-color,#1464db);border-width:2px}.week-card{padding:8px;margin-top:9px;background:var(--secondary-background-color,#eef1f6);border-radius:9px;border-left:4px solid #1464db;overflow-wrap:anywhere;font-size:13px}.week-card .check{width:18px;height:18px}.week-check{display:flex;gap:8px;align-items:flex-start}.week-meta{font-size:11px;opacity:.8;margin-top:4px}.week-summary{margin:10px 0 18px}.week-column h3{font-size:14px;margin:0 0 7px}.week-column .small{font-size:11px} .progress-person{border-top:1px solid var(--divider-color,#dfe5ee);padding:14px 0;display:grid;gap:8px}.progress-head{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center}.progress-track{height:12px;background:var(--secondary-background-color,#eef1f6);border-radius:999px;overflow:hidden}.progress-fill{height:100%;border-radius:999px;transition:width .2s}.progress-person .btn{justify-self:start} 
      .child-welcome{margin-bottom:16px}.child-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:16px}.child-stat{display:grid;gap:4px;align-content:center;border-radius:13px;background:var(--secondary-background-color,#eef1f6);padding:12px;text-align:center}.child-stat-number{font-size:24px;font-weight:800}.child-task{min-height:62px;cursor:pointer}.child-task .check{width:28px;height:28px;flex-shrink:0}.child-action{min-height:48px;margin-top:12px}
      .hero-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:16px}.hero-card{padding:18px;border-radius:18px;background:linear-gradient(180deg,#ffffff,#f7faff);border:1px solid var(--divider-color,#dfe5ee);box-shadow:0 2px 10px #00000006}.hero-icon{font-size:28px}.hero-value{font-size:30px;font-weight:800;margin-top:6px}.hero-label{font-size:14px;color:var(--secondary-text-color,#697386);margin-top:4px}.big-link-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:16px 0 20px}.big-link{display:grid;gap:6px;align-content:start;text-align:left;padding:18px;border-radius:18px;border:1px solid var(--divider-color,#dfe5ee);background:var(--card-background-color,#fff)}.big-link-icon{font-size:28px}.big-link-title{font-weight:800;font-size:18px}.big-link small{font-size:13px;color:var(--secondary-text-color,#697386)}.member-card-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.member-card{border:1px solid var(--divider-color,#dfe5ee);border-radius:18px;padding:16px;background:var(--card-background-color,#fff);display:grid;gap:10px}.member-head{display:flex;align-items:center;gap:12px}.member-avatar{width:46px;height:46px;border-radius:50%;display:grid;place-items:center;color:#fff;font-weight:800;font-size:19px;flex-shrink:0}.member-name{font-size:18px;font-weight:800}.member-task-count{font-size:14px;color:var(--secondary-text-color,#697386)}.member-badges{display:flex;gap:8px;flex-wrap:wrap}.member-badge{padding:6px 10px;border-radius:999px;background:var(--secondary-background-color,#eef1f6);font-size:13px;font-weight:700}.section-note{margin-top:-8px;margin-bottom:16px}.focus-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.kid-hero{background:linear-gradient(135deg,#fff6cc,#ffe8f0 50%,#ecf6ff);border:1px solid #f2df9d}.kid-big-title{font-size:28px;font-weight:900;line-height:1.1}.kid-sub{font-size:15px;color:#4d5b73}.kid-quick-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:14px}.child-big-btn{display:grid;gap:6px;justify-items:center;align-content:center;text-align:center;min-height:92px;padding:14px;border-radius:18px;border:0;background:#ffffff}.child-big-btn span:first-child{font-size:30px}.child-big-btn strong{font-size:18px}.kid-section-title{font-size:24px;font-weight:900;margin:0 0 8px}.kid-section-note{font-size:14px;color:var(--secondary-text-color,#697386);margin-bottom:12px}.kid-stack{display:grid;gap:12px}.kid-empty{padding:18px;border-radius:16px;background:#fff9e8;border:1px dashed #e6d28b;font-weight:700}.mini-note{font-size:12px;color:var(--secondary-text-color,#697386)}
      .brand{font-weight:900;letter-spacing:-.7px}.page{max-width:1280px}.nav{gap:8px;flex-wrap:wrap;overflow:visible}.tab{border-radius:17px;padding:11px 16px}.tab.selected{background:linear-gradient(120deg,#3784d7,#7461ce);border-color:#5c70d0;color:#fff}.panel{border-radius:21px}.big-link{transition:transform .15s,box-shadow .15s;box-shadow:0 5px 15px #1c31550c}.big-link:hover,.child-big-btn:hover{transform:translateY(-2px)}.hero-card:nth-child(1){background:#f0eaff}.hero-card:nth-child(2){background:#e4f7ed}.hero-card:nth-child(3){background:#fff0d9}.hero-card:nth-child(4){background:#e7f4ff} .hero-action{display:grid;text-align:left;justify-items:start;color:#283348!important;cursor:pointer;min-height:150px;transition:transform .15s,box-shadow .15s} .hero-action:hover{transform:translateY(-2px);box-shadow:0 9px 24px #39205f22}.hero-action:focus-visible{outline:3px solid #216db8;outline-offset:3px}.hero-action .hero-value,.hero-action .hero-label{color:#283348}.hero-hint{font-size:13px;margin-top:6px;font-weight:750;color:#6048a1}.kid-quick-grid{grid-template-columns:repeat(4,minmax(0,1fr))}.child-big-btn{border:1px solid #ebe4f1;box-shadow:0 5px 14px #50638510}.child-task{border-radius:17px;min-height:76px}.child-task .check{width:32px;height:32px}.member-card{border-radius:21px}.big-link:focus-visible,.tab:focus-visible,.routine-step:focus-visible,.child-big-btn:focus-visible{outline:3px solid #0077c8;outline-offset:3px}
      .routine-hero{background:linear-gradient(135deg,#fff5dc,#f1e9ff 55%,#e5f8f2);border:1px solid #e7ddec}.routine-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.routine-card{border-radius:22px;padding:19px;background:var(--card-background-color,#fff);border:1px solid var(--divider-color,#e4e8ef);box-shadow:0 7px 22px #1e35510c}.routine-head{display:flex;gap:13px;align-items:center;margin-bottom:12px}.routine-emoji{font-size:40px;line-height:1}.routine-name{font-size:23px;font-weight:850}.routine-step-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.routine-step{position:relative;border:2px solid var(--divider-color,#dfe5ee);border-radius:17px;background:#f7f9ff;color:var(--primary-text-color,#192238);padding:14px 10px;min-height:108px;display:grid;justify-items:center;align-content:center;gap:7px;text-align:center;font-weight:800}.routine-step strong{font-size:15px}.routine-step .routine-symbol{font-size:32px}.routine-step.done{background:#e4f9ed;border-color:#69c58d}.routine-step.done strong{text-decoration:none}.routine-meter{height:12px;border-radius:99px;background:#ebedf3;overflow:hidden;margin:10px 0}.routine-meter-fill{height:100%;background:linear-gradient(90deg,#6ab6ee,#66d0a3);border-radius:99px}.routine-management{display:grid;gap:12px}.routine-form-steps{display:grid;gap:8px;grid-column:1/-1}.routine-step-edit{display:grid;grid-template-columns:100px 1fr auto;gap:8px;align-items:center}.routine-day{display:inline-flex;align-items:center;gap:6px;padding:7px 10px;border-radius:12px;background:var(--secondary-background-color,#f0f2f6);margin:3px}.routine-day input{width:20px;height:20px}.routine-avatar{font-size:14px;font-weight:800;border-radius:40px;padding:5px 10px;background:#f1f4ff}.kid-hero{box-shadow:0 10px 28px #6d8fd214}.panel{box-shadow:0 5px 19px #2b45680b}.tab{min-height:46px}.btn{min-height:42px}.routine-quiet{font-size:13px;color:var(--secondary-text-color,#697386)} .today-routines{margin:14px 0 25px} .routine-person-label{border-left:5px solid #6d7e9c;padding:7px 12px;margin-bottom:12px;border-radius:8px;background:var(--secondary-background-color,#eef1f6);font-weight:800;font-size:16px}
      .tablet-picker-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:16px;margin:20px 0}.tablet-person{border:2px solid var(--divider-color,#dfe5ee);background:var(--card-background-color,#fff);color:var(--primary-text-color,#192238);border-radius:22px;min-height:170px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;font-size:21px;font-weight:800;cursor:pointer}.tablet-person-avatar{height:86px;width:86px;border-radius:50%;color:#fff;display:grid;place-items:center;font-size:35px;font-weight:900}.tablet-person:focus-visible{outline:4px solid #1464db;outline-offset:3px}
      @media(max-width:700px){.routine-grid{grid-template-columns:1fr}.routine-step-edit{grid-template-columns:85px 1fr}.routine-step-edit button{grid-column:1/-1}.routine-step-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.routine-step{min-height:104px}}

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

      @media(max-width:950px){.hero-grid,.big-link-grid,.kid-quick-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.member-card-grid,.focus-grid{grid-template-columns:1fr}}@media(max-width:850px){.week-days{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:450px){.week-days{grid-template-columns:1fr}}@media(max-width:650px){.page{padding:14px 12px 40px}.grid{grid-template-columns:1fr 1fr}.formgrid{grid-template-columns:1fr}.item{align-items:flex-start}.actions{gap:5px}.btn{padding:9px 10px}.brand{font-size:22px}.calday{min-height:77px;padding:4px}.calentry{font-size:10px;padding:3px}.daynum{font-size:12px}.child-stats{gap:5px}.child-stat{padding:10px 3px}.child-stat-number{font-size:18px}.child-action{width:100%}.child-task{min-height:66px}.hero-grid,.big-link-grid,.kid-quick-grid{grid-template-columns:1fr}.member-card-grid,.focus-grid{grid-template-columns:1fr}.kid-big-title{font-size:24px}}`;
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
    const nav=this.el("nav","nav");
    const child = this.data._role === "child";
    const tabs = child ? [["today","🌞 Heute"],["routines","🌈 Mein Tag"],["tasks","✅ Aufgaben"],["calendar","📅 Termine"]]
                       : [["today","🏡 Start"],["week","🗓️ Woche"],["routines","🌈 Routinen"],["calendar","📅 Kalender"],["tasks","✅ Aufgaben"],["members","👨‍👩‍👧 Familie"],["settings","⚙️ Einstellungen"]];
    tabs.forEach(([id,label])=>{
      nav.append(this.button(label,()=>{this.tab=id;this.editMember=null;this.editTask=null;this.editEvent=null;this.render();if((id==="calendar"||id==="week")&&!child)this.refreshExternalEvents();},`tab ${this.tab===id?"selected":""}`));
    });page.append(nav);
    if(this.savedNotice) page.append(this.el("div","save-success",this.savedNotice));
    if(this.error) page.append(this.el("div","notice",`Hinweis: ${this.error}`));
    if(!this.loaded) {page.append(this.el("div","panel",this.busy?"Daten werden geladen …":"Keine Verbindung zu Family Hub. Bitte Integration prüfen."));root.append(page);return;}
    if(child){
      this.renderChild(page);
    }else{
      if(this.tab==="today") this.renderToday(page);
      if(this.tab==="routines") this.renderRoutines(page);
      if(this.tab==="week") this.renderWeek(page);
      if(this.tab==="members") this.renderMembers(page);
      if(this.tab==="calendar") this.renderCalendar(page);
      if(this.tab==="tasks") this.renderTasks(page);
      if(this.tab==="settings") this.renderSettings(page);
    }
    page.append(this.el("div","small footer","Der Family Hub speichert die Familiendaten lokal in Home Assistant."));
    root.append(page);
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
    panel.append(this.el("p","small","Tippe auf dein Bild. Dann siehst du deine Aufgaben und deinen Tag."));
    const grid=this.el("div","tablet-picker-grid");
    for(const member of this.data.members||[]) {
      const btn=this.button("",()=>this.selectTabletMember(member.id),"tablet-person");
      const avatar=this.el("span","tablet-person-avatar",(member.name||"?").slice(0,1).toUpperCase());
      avatar.style.backgroundColor=member.color;
      btn.append(avatar,this.el("strong",null,member.name));
      grid.append(btn);
    }
    if(!grid.childNodes.length)panel.append(this.el("p","small","Noch keine Familienmitglieder eingerichtet."));
    panel.append(grid);
    panel.append(this.el("p","small","🔒 Einstellungen für Erwachsene sind nur mit dem Elternkonto zugänglich."));
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
  renderToday(page) {
    const pending=this.data.tasks.filter(t=>!this.completedForAll(t));
    const today=new Date();
    const localDate=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;
    const due=pending.filter(t=>t.due && t.due<=localDate);
    const todayEvents=this.occurrences(localDate,localDate);

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
  renderSettings(page) {
    const intro=this.el("section","panel");
    intro.append(this.cardTitle("⚙️ Einstellungen"));
    intro.append(this.el("p",null,"Hier verbindest du Kalender und richtest den Handy-Zugang für Kinder ein."));
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
    push.append(this.el("h3",null,"📲 Erinnerungen aufs Handy"));
    push.append(this.el("p","small","Nur mit der offiziellen Home-Assistant-Handy-App. Jeder Person ein Handy zuordnen; dann werden ausschließlich ihre eigenen fälligen Aufgaben geschickt. Standardmäßig ausgeschaltet. Wähle die Uhrzeit für jede Person. Automatische Nachrichten kommen nur bei offenen heute fälligen oder überfälligen Aufgaben; nach einem Neustart auch dann, wenn die Erinnerungszeit schon vorbei ist. Bei älteren Handy-Diensten öffnet das Tippen auf die Push-Nachricht direkt den Family Hub."));
    const ps=this.data.push_settings||{enabled:false,devices:{}};
    const pushEnabled=this.el("input");pushEnabled.type="checkbox";pushEnabled.checked=!!ps.enabled;
    const enableRow=this.el("label","person-choice");enableRow.append(pushEnabled,this.el("span",null,"Tägliche Handy-Erinnerungen aktivieren"));push.append(enableRow);
    if(!this.pushDevicesLoaded)push.append(this.el("p","small","Handy-Liste wird geladen …"));
    if(this.pushDevicesLoaded && !this.pushDevices.length)push.append(this.el("p","notice","Noch kein Handy gefunden. Installiere und verbinde die Home-Assistant-App auf dem jeweiligen Handy und erlaube Benachrichtigungen. Anschließend hier neu laden."));
    const deviceInputs={};
    const hourInputs={};
    const overdueInputs={};
    for(const m of this.data.members){
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
      push.append(field,timing,lateRow);
      const line=this.el("div","actions");line.append(this.button("🔔 Test ans Handy",()=>this.testPush(m.id,sel.value),"btn secondary"));push.append(line);
    }
    const pushActions=this.el("div","actions");
    pushActions.append(this.button("✓ Handy-Zuordnung speichern",()=>this.request("push_settings_save",{enabled:pushEnabled.checked,
      devices:Object.fromEntries(Object.entries(deviceInputs).map(([k,v])=>[k,v.value])),
      hours:Object.fromEntries(Object.entries(hourInputs).map(([k,v])=>[k,Number(v.value)])),
      include_overdue:Object.fromEntries(Object.entries(overdueInputs).map(([k,v])=>[k,v.checked]))}),"btn"));
    pushActions.append(this.button("🔄 Handys suchen",()=>this.loadPushDevices(),"btn secondary"));
    pushActions.append(this.button("🔎 Erinnerungen prüfen",()=>this.diagnosePush(),"btn secondary"));
    push.append(pushActions);intro.append(push);

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
      intro.append(this.el("p","small","Danach am Tablet mit genau diesem Benutzer anmelden und den Family Hub öffnen. Zwischen Kindern kann man über „Kind wechseln“ umschalten. Für Elternfunktionen ist ein anderer Login erforderlich."));
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
    quick.append(q4,q1,q2,q3); welcome.append(quick);
    if(overdue) welcome.append(this.el("p", "notice", `⏰ Achtung: ${overdue} ${overdue===1?"Aufgabe ist":"Aufgaben sind"} schon überfällig.`));
    page.append(welcome);

    if(this.tab === "routines") this.renderRoutines(page, true);
    if(this.tab === "today") this.renderRoutines(page, true);
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
    const add=this.button(this.editMember?"Bearbeitung abbrechen":"+ Familienmitglied hinzufügen",()=>{this.editMember=this.editMember?null:{name:"",color:"#3B82F6"};this.render();});card.append(add);
    if(this.editMember){
      const f=this.el("form","formgrid");const n=this.input("Name","text",this.editMember.name,"name");n.querySelector("input").required=true;
      const c=this.input("Farbe","color",this.editMember.color,"color");f.append(n,c);
      const save=this.el("div","full");const submit=this.el("button","btn","Speichern");submit.type="submit";save.append(submit);
      f.append(save);f.addEventListener("submit",e=>{e.preventDefault();this.request("member_save",{member_id:this.editMember.id||"",name:n.querySelector("input").value,color:c.querySelector("input").value});});card.append(f);
    }
    const list=this.el("div","list");
    this.data.members.forEach(m=>{const r=this.el("div","item");const dot=this.el("span","dot");dot.style.background=m.color;
      const name=this.el("div","item-main item-title",m.name);r.append(dot,name);
      r.append(this.button("Bearbeiten",()=>{this.editMember={...m};this.render();},"btn secondary"));
      r.append(this.button("Löschen",()=>{if(confirm(`„${m.name}“ löschen? Aufgaben bleiben erhalten, aber die Zuordnung wird entfernt.`))this.request("member_delete",{member_id:m.id});},"btn secondary danger"));list.append(r);
    });
    if(!this.data.members.length)list.append(this.el("div","empty","Noch keine Familienmitglieder angelegt."));
    card.append(list);page.append(card);
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
