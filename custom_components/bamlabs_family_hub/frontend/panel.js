/* BamLabs Family Hub 0.3.4 — no external libraries, local Home Assistant storage. */
class BamLabsFamilyHubPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({mode: "open"});
    this.data = {members: [], tasks: [], events: [], external_calendars: []};
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
    this.editEvent = null;
    this.tab = "today";
    this.busy = false;
    this.loaded = false;
    this.error = "";
    this.editMember = null;
    this.editTask = null;
    this.childAccounts = null;
    this.qrFor = null;
    this.childForm = null;
    this.showCalendarSetup = false;
    this.backendVersion = "";
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
      this.editMember = null;
      this.editTask = null;
      this.editEvent = null;
    } catch(e) { this.error = e.message || String(e); }
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
    } catch(e) { this.externalError = e.message || String(e); }
    finally { this.externalBusy = false; this.render(); this.refreshExternalEvents(); }
  }
  async refreshExternalEvents(force=false) {
    if (!this._hass || !this.loaded || this.externalBusy || this.data._role === "child") return;
    // Avoid repeated network requests when the user quickly changes views.
    if (force && Date.now() - this.externalLastAttempt < 15000) return;
    const a=this.calendarAnchor;
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
      .grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:15px}.panel{padding:21px;background:var(--card-background-color,#fff);border:1px solid var(--divider-color,#dfe5ee);border-radius:18px;box-shadow:0 2px 10px #00000008;margin-bottom:16px}.stat{font-size:32px;font-weight:800;margin-top:10px}.heading{font-size:19px;margin:0 0 16px}.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.btn{padding:10px 14px;border-radius:10px;background:#1464db;border:1px solid #1464db;color:#fff;font-weight:650}.secondary{background:transparent;color:var(--primary-text-color,#192238);border-color:var(--divider-color,#cfd6df)}.danger{color:#c32929}.list{display:grid;gap:12px;margin-top:12px}.item{display:flex;align-items:center;gap:13px;border:1px solid var(--divider-color,#e4e8ef);border-radius:12px;padding:12px}.item-main{flex:1;min-width:0}.item-title{font-weight:700;overflow-wrap:anywhere}.desc{font-size:13px;white-space:pre-wrap;margin-top:5px;color:var(--secondary-text-color,#697386)}.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}.chip{display:inline-block;padding:4px 9px;border-radius:999px;background:var(--secondary-background-color,#eef1f6);font-size:12px}.dot{width:15px;height:15px;border-radius:50%;flex-shrink:0;border:1px solid #0002}.check{width:21px;height:21px;cursor:pointer}.done .item-title{text-decoration:line-through;opacity:.6}.field{display:grid;gap:5px;font-weight:650;font-size:14px}.field input,.field textarea,.field select{width:100%;min-height:39px;color:var(--primary-text-color,#192238);background:var(--card-background-color,#fff);border:1px solid var(--divider-color,#cbd3de);border-radius:9px;padding:9px}.field textarea{min-height:86px}.formgrid{display:grid;grid-template-columns:1fr 1fr;gap:13px;margin:15px 0}.full{grid-column:1/-1}.colors{display:flex;gap:8px;flex-wrap:wrap}.person-choice{display:flex;gap:7px;align-items:center;padding:6px 0}.notice{padding:13px 15px;border-radius:10px;background:#fff2dd;color:#6f4a0b;margin-bottom:15px}.empty{color:var(--secondary-text-color,#697386);padding:24px 0;text-align:center}.footer{margin-top:35px;text-align:center}.tag-high{color:#ba3d25}.muted{color:var(--secondary-text-color,#697386)}.calbar{display:flex;align-items:center;gap:10px;justify-content:space-between;flex-wrap:wrap;margin:12px 0 18px}.calgrid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:5px}.calday{min-height:104px;border:1px solid var(--divider-color,#dfe5ee);border-radius:10px;padding:6px;min-width:0;background:var(--card-background-color,#fff)}.calday.outside{opacity:.48}.daynum{font-weight:750;margin-bottom:6px}.calentry{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%;border:0;border-left:4px solid #1464db;background:var(--secondary-background-color,#eef1f6);text-align:left;border-radius:5px;margin:3px 0;padding:5px;color:var(--primary-text-color,#192238);font-size:12px}.calweek{display:grid;gap:9px}.calendar-stack{display:grid;gap:7px}.calhead{font-size:12px;text-align:center;font-weight:700;padding:8px 2px;color:var(--secondary-text-color,#697386)}.caldate{font-weight:750;margin:8px 0}.calfilters{display:flex;gap:7px;flex-wrap:wrap}
      @media(max-width:650px){.page{padding:14px 12px 40px}.grid{grid-template-columns:1fr 1fr}.formgrid{grid-template-columns:1fr}.item{align-items:flex-start}.actions{gap:5px}.btn{padding:9px 10px}.brand{font-size:22px}.calday{min-height:77px;padding:4px}.calentry{font-size:10px;padding:3px}.daynum{font-size:12px}}`;
    root.append(style);
    const page=this.el("main","page");
    const header=this.el("div","top");
    const left=this.el("div");left.append(this.el("div","brand","🏡 BamLabs Family Hub"),this.el("div","small","Dein Familienalltag – gemeinsam organisiert"));
    const tools=this.el("div","actions");
    const versionText=this.backendVersion
      ? `Oberfläche v0.3.4 · Backend v${this.backendVersion}`
      : "Oberfläche v0.3.4";
    tools.append(this.el("span","small",versionText));
    const reload=this.button("🔄 Aktualisieren",()=>this.reloadHub(),"btn secondary");
    reload.title="Oberfläche neu laden. Neue Versionen über den Marketplace installieren.";
    tools.append(reload);
    header.append(left,tools);page.append(header);
    if(this.backendVersion && this.backendVersion!=="0.3.4" && this.backendVersion!=="nicht abrufbar") {
      page.append(this.el("div","notice",`Oberfläche und Backend haben verschiedene Versionen (${versionText}). Bitte das Update im Marketplace installieren, Home Assistant neu starten und dann Aktualisieren drücken.`));
    }
    const nav=this.el("nav","nav");
    const child = this.data._role === "child";
    const tabs = child ? [["today","🏡 Mein Tag"],["tasks","✅ Aufgaben"],["calendar","📅 Termine"]]
                       : [["today","Übersicht"],["calendar","Kalender"],["tasks","Aufgaben"],["members","Familie"],["settings","⚙️ Einstellungen"]];
    tabs.forEach(([id,label])=>{
      nav.append(this.button(label,()=>{this.tab=id;this.editMember=null;this.editTask=null;this.editEvent=null;this.render();if(id==="calendar"&&!child)this.refreshExternalEvents(true);},`tab ${this.tab===id?"selected":""}`));
    });page.append(nav);
    if(this.error) page.append(this.el("div","notice",`Hinweis: ${this.error}`));
    if(!this.loaded) {page.append(this.el("div","panel",this.busy?"Daten werden geladen …":"Keine Verbindung zu Family Hub. Bitte Integration prüfen."));root.append(page);return;}
    if(child){
      this.renderChild(page);
    }else{
      if(this.tab==="today") this.renderToday(page);
      if(this.tab==="members") this.renderMembers(page);
      if(this.tab==="calendar") this.renderCalendar(page);
      if(this.tab==="tasks") this.renderTasks(page);
      if(this.tab==="settings") this.renderSettings(page);
    }
    page.append(this.el("div","small footer","Daten werden lokal in Home Assistant gespeichert. PRO-Funktionen folgen in späteren Versionen."));
    root.append(page);
  }
  renderToday(page) {
    const pending=this.data.tasks.filter(t=>!t.done);
    const today=new Date();const localDate=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;
    const due=pending.filter(t=>t.due && t.due<=localDate);
    const stats=this.el("div","grid");
    [[this.data.members.length,"Familienmitglieder"],[pending.length,"Offene Aufgaben"],[due.length,"Heute fällig / überfällig"],[this.occurrences(localDate,localDate).length,"Termine heute"]].forEach(([v,l])=>{
      const c=this.el("div","panel");c.append(this.el("div","small",l),this.el("div","stat",String(v)));stats.append(c);
    });page.append(stats);
    const card=this.el("section","panel");card.append(this.cardTitle("Heute im Blick"));
    if(!due.length) card.append(this.el("div","empty","Keine fälligen Aufgaben – Zeit für etwas Schönes!"));
    else due.sort((a,b)=>a.due.localeCompare(b.due)).forEach(t=>card.append(this.taskRow(t)));
    card.append(this.button("Alle Aufgaben öffnen",()=>{this.tab="tasks";this.render();},"btn secondary"));page.append(card);
    const appointments=this.el("section","panel");appointments.append(this.cardTitle("Termine heute"));
    const todayEvents=this.occurrences(localDate,localDate);
    if(!todayEvents.length) appointments.append(this.el("div","empty","Heute keine Termine."));
    else todayEvents.forEach(o=>appointments.append(this.eventRow(o)));
    appointments.append(this.button("Kalender öffnen",()=>{this.tab="calendar";this.render();},"btn secondary"));page.append(appointments);
    const family=this.el("section","panel");family.append(this.cardTitle("Unsere Familie"));
    if(!this.data.members.length) family.append(this.el("p","muted","Lege zuerst eure Familienmitglieder an."));
    else {const chips=this.el("div","chips");this.data.members.forEach(m=>{const c=this.el("span","chip",m.name);c.style.borderLeft=`5px solid ${m.color}`;chips.append(c);});family.append(chips);}
    family.append(this.el("p","small","Tipp: Aufgaben können mehreren Familienmitgliedern zugeordnet werden."));page.append(family);
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
      const ev={id:"external",title:ext.title,description:ext.description||"",members:[],
        start:ext.start,end:ext.end,all_day:ext.all_day,external:true,source:ext.calendar};
      out.push({event:ev,start,end:last,time:ext.all_day?"":ext.start.slice(11,16)});
    }
    return out.sort((a,b)=>(a.start+a.time).localeCompare(b.start+b.time));
  }
  eventColor(ev) {return ev.external?"#16a085":(this.data.members.find(m=>(ev.members||[]).includes(m.id))?.color||"#1464db");}
  eventRow(o) {
    const ev=o.event;const r=this.el("div","item");const dot=this.el("span","dot");dot.style.background=this.eventColor(ev);r.append(dot);
    const body=this.el("div","item-main");body.append(this.el("div","item-title",ev.title));
    const meta=[`${this.dateLabel(o.start)}${o.end!==o.start?" – "+this.dateLabel(o.end):""}`,ev.all_day?"Ganztägig":ev.start.slice(11,16)+" – "+ev.end.slice(11,16),...(ev.external?[`Home Assistant: ${ev.source}`]:ev.members.map(id=>this.memberName(id)))];
    body.append(this.el("div","small",meta.join(" · ")));
    if(ev.description)body.append(this.el("div","desc",ev.description));r.append(body);
    if(ev.external){r.append(this.el("span","chip","Nur lesen"));return r;}
    const buttons=this.el("div","actions");buttons.append(this.button("✎",()=>{this.tab="calendar";this.editEvent={...ev,members:[...ev.members]};this.render();},"btn secondary"));
    buttons.append(this.button("×",()=>{if(confirm(`Termin „${ev.title}“ samt Wiederholungen löschen?`))this.request("event_delete",{event_id:ev.id});},"btn secondary danger"));r.append(buttons);return r;
  }
  renderCalendar(page) {
    const section=this.el("section","panel");section.append(this.cardTitle("Familienkalender"));
    const extCard=this.el("div","panel");extCard.append(this.el("strong",null,"Home-Assistant-Kalender einblenden"));
    extCard.append(this.el("p","small","Dauerhaft verbunden: Google- und andere Home-Assistant-Kalender werden automatisch ca. alle 5 Minuten aktualisiert, solange Family Hub geöffnet ist. Neue Termine erscheinen auch beim nächsten Öffnen. Änderungen erfolgen weiterhin im ursprünglichen Kalender."));
    const syncText = this.externalLastSync
      ? `Letzte Aktualisierung: ${this.externalLastSync.toLocaleString("de-AT", {dateStyle:"short",timeStyle:"short"})}`
      : "Noch keine erfolgreiche Kalenderaktualisierung";
    extCard.append(this.el("p","small",syncText));
    if(this.externalError) extCard.append(this.el("div","notice",this.externalError));
    if(this.externalBusy) extCard.append(this.el("div","small","Kalender werden geladen …"));
    const selections=[];
    for(const src of this.externalSources){
      const lab=this.el("label","person-choice");const check=this.el("input");check.type="checkbox";
      check.value=src.id;check.checked=(this.data.external_calendars||[]).includes(src.id);
      selections.push(check);lab.append(check,this.el("span",null,src.name));extCard.append(lab);
    }
    if(!this.externalSources.length)extCard.append(this.el("p","small","Keine Home-Assistant-Kalender gefunden. Lege zuerst unter Geräte & Dienste einen Kalender an."));
    const controls=this.el("div","actions");
    controls.append(this.button("Auswahl speichern",()=>this.selectCalendars(selections.filter(c=>c.checked).map(c=>c.value)),"btn secondary"));
    controls.append(this.button("Termine aktualisieren",()=>this.refreshExternalEvents(true),"btn secondary"));
    extCard.append(controls);section.append(extCard);
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
  renderSettings(page) {
    const intro=this.el("section","panel");
    intro.append(this.cardTitle("⚙️ Einstellungen"));
    intro.append(this.el("p",null,"Hier verbindest du Kalender und richtest den Handy-Zugang für Kinder ein."));
    intro.append(this.el("h3",null,"📅 Kalender verbinden"));
    intro.append(this.el("p","small","Du kannst Kalender anzeigen, die schon mit Home Assistant verbunden sind. Termine werden anschließend automatisch aktualisiert, solange Family Hub geöffnet ist."));
    intro.append(this.button("📅 Kalender verbinden",()=>{this.showCalendarSetup=!this.showCalendarSetup;this.render();if(this.showCalendarSetup)this.loadCalendarSources();},"btn"));
    if(this.showCalendarSetup){
      const setup=this.el("div","panel");
      setup.append(this.el("h3",null,"1. Wähle deinen Kalender"));
      setup.append(this.el("p","small","Wenn dein Google-Kalender bereits unter Home Assistant → Geräte & Dienste eingerichtet ist, kannst du ihn gleich auswählen."));
      if(this.externalError)setup.append(this.el("div","notice",this.externalError));
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
      setup.append(this.el("h3",null,"2. Google Kalender noch nicht verbunden?"));
      setup.append(this.el("p","small","Die Google-Verbindung wird von Home Assistant eingerichtet. Öffne Einstellungen → Geräte & Dienste → Integration hinzufügen → Google Calendar. Folge den dortigen Schritten. Anschließend kommst du zurück und klickst auf „Kalender suchen“."));
      setup.append(this.el("p","small","Hinweis: Eine direkte Anmeldung mit Google ist in Family Hub noch nicht verfügbar. Dafür ist eine eigene sichere Google-Anmeldeintegration nötig."));
      setup.append(this.el("h3",null,"3. Automatische Aktualisierung"));
      setup.append(this.el("p","small",this.externalLastSync?`Zuletzt geladen: ${this.externalLastSync.toLocaleString("de-AT",{dateStyle:"short",timeStyle:"short"})}`:"Noch keine erfolgreiche Aktualisierung."));
      setup.append(this.el("p","small","Verbundene Kalender werden bei geöffnetem Family Hub ungefähr alle fünf Minuten aktualisiert. Termine werden nur angezeigt, nicht in Google verändert."));
      setup.append(this.button("🔄 Termine jetzt laden",()=>this.refreshExternalEvents(true),"btn secondary"));
      intro.append(setup);
    }
    intro.append(this.el("h3",null,"📱 Kinder & Handy-Zugang"));
    intro.append(this.el("p","small","Jedes Kind bekommt einen persönlichen QR-Code. Der Code öffnet Family Hub auf dem Handy – ohne Passwort im QR-Code. Zur Anmeldung benötigt das Kind einmalig ein eigenes Home-Assistant-Konto ohne Administratorrechte."));
    intro.append(this.el("p","small","1. Unter Einstellungen → Personen → Benutzer ein eigenes normales Benutzerkonto für jedes Kind anlegen. 2. Hier das Konto mit dem Kind verbinden. 3. QR-Code mit dem Handy scannen und beim ersten Aufruf anmelden. Danach sieht das Kind nur seine zugewiesenen Aufgaben und Termine."));
    intro.append(this.button(this.childAccounts?"Benutzer neu laden":"Kinderkonten anzeigen",()=>this.fetchChildAccounts(),"btn secondary"));
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
  renderChild(page) {
    const me=this.data.members[0];
    const card=this.el("section","panel");
    card.append(this.cardTitle(`👋 Hallo ${me?.name||"!"}!`));
    card.append(this.el("p","small","Hier siehst du nur deine Aufgaben und Termine."));
    page.append(card);
    if(this.tab==="today" || this.tab==="tasks"){
      const tasks=this.el("section","panel");tasks.append(this.cardTitle("✅ Meine Aufgaben"));
      const open=this.data.tasks.filter(t=>!t.done);
      if(!open.length)tasks.append(this.el("p","empty","Alles erledigt – super! 🎉"));
      else open.forEach(t=>{
        const item=this.el("div","item");
        const check=this.el("input","check");check.type="checkbox";check.checked=!!t.done;
        check.addEventListener("change",()=>this.request("task_toggle",{task_id:t.id}));
        const details=this.el("div","item-main");details.append(this.el("strong",null,t.title));
        if(t.due)details.append(this.el("div","small",`Bis ${this.dateLabel(t.due)}`));
        item.append(check,details);tasks.append(item);
      });
      const add=this.button(this.childForm==="task"?"Abbrechen":"➕ Aufgabe eintragen",()=>{this.childForm=this.childForm==="task"?null:"task";this.render();});tasks.append(add);
      if(this.childForm==="task"){
        const form=this.el("form","formgrid");const title=this.input("Was möchtest du erledigen?","text","","title");title.querySelector("input").required=true;
        const due=this.input("Bis wann? (freiwillig)","date","","due");const button=this.el("button","btn","Speichern");button.type="submit";
        form.append(title,due,button);form.addEventListener("submit",e=>{e.preventDefault();this.childForm=null;this.request("child_task_create",{title:title.querySelector("input").value,due:due.querySelector("input").value});});tasks.append(form);
      }
      page.append(tasks);
    }
    if(this.tab==="today" || this.tab==="calendar"){
      const box=this.el("section","panel");box.append(this.cardTitle("📅 Meine Termine"));
      const events=[...(this.data.events||[])].sort((a,b)=>a.start.localeCompare(b.start));
      if(!events.length)box.append(this.el("p","empty","Noch keine Termine eingetragen."));
      else events.forEach(ev=>{const item=this.el("div","item");const info=this.el("div","item-main");info.append(this.el("strong",null,ev.title),this.el("div","small",ev.start.replace("T"," ")));item.append(info);box.append(item);});
      box.append(this.button(this.childForm==="event"?"Abbrechen":"➕ Termin eintragen",()=>{this.childForm=this.childForm==="event"?null:"event";this.render();}));
      if(this.childForm==="event"){
        const form=this.el("form","formgrid");const title=this.input("Was ist geplant?","text","","title");title.querySelector("input").required=true;
        const start=this.input("Beginn","datetime-local","","start");start.querySelector("input").required=true;
        const end=this.input("Ende","datetime-local","","end");end.querySelector("input").required=true;
        const submit=this.el("button","btn","Termin speichern");submit.type="submit";
        form.append(title,start,end,submit);
        form.addEventListener("submit",e=>{e.preventDefault();this.childForm=null;this.request("child_event_create",{title:title.querySelector("input").value,start:start.querySelector("input").value,end:end.querySelector("input").value,all_day:false});});box.append(form);
      }
      page.append(box);
    }
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
    card.append(this.button(this.editTask?"Bearbeitung abbrechen":"+ Neue Aufgabe",()=>{this.editTask=this.editTask?null:{title:"",description:"",due:"",priority:"normal",assignees:[]};this.render();}));
    if(this.editTask){
      const f=this.el("form","formgrid");const title=this.input("Aufgabe","text",this.editTask.title,"title");title.querySelector("input").required=true;
      const due=this.input("Fällig am (optional)","date",this.editTask.due,"due");
      const desc=this.el("label","field full");desc.append(this.el("span","field-title","Beschreibung (optional)"));
      const ta=this.el("textarea");ta.value=this.editTask.description||"";ta.maxLength=1500;desc.append(ta);
      const priority=this.el("label","field");priority.append(this.el("span","field-title","Priorität"));
      const select=this.el("select");[["low","Niedrig"],["normal","Normal"],["high","Hoch"]].forEach(([k,v])=>{const o=this.el("option",null,v);o.value=k;select.append(o);});select.value=this.editTask.priority;priority.append(select);
      const assigned=this.el("fieldset","field full");assigned.style.border="0";assigned.style.padding="0";
      assigned.append(this.el("legend","field-title","Zuständig (mehrere möglich)"));
      const checks=[];
      this.data.members.forEach(m=>{const label=this.el("label","person-choice");const ch=this.el("input");ch.type="checkbox";ch.value=m.id;ch.checked=this.editTask.assignees.includes(m.id);checks.push(ch);label.append(ch,this.el("span",null,m.name));assigned.append(label);});
      if(!this.data.members.length)assigned.append(this.el("span","small","Noch keine Personen angelegt – Aufgabe kann auch unzugeordnet bleiben."));
      const bottom=this.el("div","full");const save=this.el("button","btn","Aufgabe speichern");save.type="submit";bottom.append(save);
      f.append(title,due,priority,desc,assigned,bottom);
      f.addEventListener("submit",e=>{e.preventDefault();this.request("task_save",{task_id:this.editTask.id||"",title:title.querySelector("input").value,description:ta.value,due:due.querySelector("input").value,priority:select.value,assignees:checks.filter(c=>c.checked).map(c=>c.value)});});
      card.append(f);
    }
    const pending=this.data.tasks.filter(t=>!t.done).sort((a,b)=>(a.due||"9999").localeCompare(b.due||"9999"));
    const done=this.data.tasks.filter(t=>t.done);
    card.append(this.el("h3",null,`Offen (${pending.length})`));
    if(!pending.length)card.append(this.el("div","empty","Keine offenen Aufgaben."));else pending.forEach(t=>card.append(this.taskRow(t)));
    card.append(this.el("h3",null,`Erledigt (${done.length})`));
    done.forEach(t=>card.append(this.taskRow(t)));page.append(card);
  }
  taskRow(t) {
    const r=this.el("div",`item ${t.done?"done":""}`);const ch=this.el("input","check");ch.type="checkbox";ch.checked=!!t.done;ch.title="Erledigt ändern";ch.disabled=this.busy;ch.addEventListener("change",()=>this.request("task_toggle",{task_id:t.id}));r.append(ch);
    const main=this.el("div","item-main");main.append(this.el("div","item-title",t.title));
    if(t.description)main.append(this.el("div","desc",t.description));
    const tags=this.el("div","chips");if(t.due)tags.append(this.el("span","chip",`📅 ${this.dateLabel(t.due)}`));
    if(t.priority==="high")tags.append(this.el("span","chip tag-high","Wichtig"));
    t.assignees.forEach(id=>{const member=this.data.members.find(m=>m.id===id);if(member){const chip=this.el("span","chip",member.name);chip.style.borderLeft=`4px solid ${member.color}`;tags.append(chip);}});
    main.append(tags);r.append(main);
    const buttons=this.el("div","actions");buttons.append(this.button("✎",()=>{this.tab="tasks";this.editTask={...t,assignees:[...t.assignees]};this.render();},"btn secondary"));
    buttons.append(this.button("×",()=>{if(confirm(`Aufgabe „${t.title}“ wirklich löschen?`))this.request("task_delete",{task_id:t.id});},"btn secondary danger"));r.append(buttons);return r;
  }
}
customElements.define("bamlabs-family-hub-panel",BamLabsFamilyHubPanel);
