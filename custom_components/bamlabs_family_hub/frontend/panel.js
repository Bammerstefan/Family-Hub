/* BamLabs Family Hub 0.1.0 — no external libraries, local Home Assistant storage. */
class BamLabsFamilyHubPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({mode: "open"});
    this.data = {members: [], tasks: []};
    this.tab = "today";
    this.busy = false;
    this.loaded = false;
    this.error = "";
    this.editMember = null;
    this.editTask = null;
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
    } catch(e) { this.error = e.message || String(e); }
    finally { this.busy = false; this.render(); }
  }
  async request(type, payload={}) {
    if (this.busy) return;
    this.busy = true;
    try {
      this.data = await this._hass.callWS({type:`bamlabs_family_hub/${type}`, ...payload});
      this.error = "";
      this.editMember = null;
      this.editTask = null;
    } catch(e) { this.error = e.message || String(e); }
    finally { this.busy = false; this.render(); }
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
      .grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:15px}.panel{padding:21px;background:var(--card-background-color,#fff);border:1px solid var(--divider-color,#dfe5ee);border-radius:18px;box-shadow:0 2px 10px #00000008;margin-bottom:16px}.stat{font-size:32px;font-weight:800;margin-top:10px}.heading{font-size:19px;margin:0 0 16px}.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.btn{padding:10px 14px;border-radius:10px;background:#1464db;border:1px solid #1464db;color:#fff;font-weight:650}.secondary{background:transparent;color:var(--primary-text-color,#192238);border-color:var(--divider-color,#cfd6df)}.danger{color:#c32929}.list{display:grid;gap:12px;margin-top:12px}.item{display:flex;align-items:center;gap:13px;border:1px solid var(--divider-color,#e4e8ef);border-radius:12px;padding:12px}.item-main{flex:1;min-width:0}.item-title{font-weight:700;overflow-wrap:anywhere}.desc{font-size:13px;white-space:pre-wrap;margin-top:5px;color:var(--secondary-text-color,#697386)}.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}.chip{display:inline-block;padding:4px 9px;border-radius:999px;background:var(--secondary-background-color,#eef1f6);font-size:12px}.dot{width:15px;height:15px;border-radius:50%;flex-shrink:0;border:1px solid #0002}.check{width:21px;height:21px;cursor:pointer}.done .item-title{text-decoration:line-through;opacity:.6}.field{display:grid;gap:5px;font-weight:650;font-size:14px}.field input,.field textarea,.field select{width:100%;min-height:39px;color:var(--primary-text-color,#192238);background:var(--card-background-color,#fff);border:1px solid var(--divider-color,#cbd3de);border-radius:9px;padding:9px}.field textarea{min-height:86px}.formgrid{display:grid;grid-template-columns:1fr 1fr;gap:13px;margin:15px 0}.full{grid-column:1/-1}.colors{display:flex;gap:8px;flex-wrap:wrap}.person-choice{display:flex;gap:7px;align-items:center;padding:6px 0}.notice{padding:13px 15px;border-radius:10px;background:#fff2dd;color:#6f4a0b;margin-bottom:15px}.empty{color:var(--secondary-text-color,#697386);padding:24px 0;text-align:center}.footer{margin-top:35px;text-align:center}.tag-high{color:#ba3d25}.muted{color:var(--secondary-text-color,#697386)}
      @media(max-width:650px){.page{padding:14px 12px 40px}.grid{grid-template-columns:1fr 1fr}.formgrid{grid-template-columns:1fr}.item{align-items:flex-start}.actions{gap:5px}.btn{padding:9px 10px}.brand{font-size:22px}}`;
    root.append(style);
    const page=this.el("main","page");
    const header=this.el("div","top");
    const left=this.el("div");left.append(this.el("div","brand","🏡 BamLabs Family Hub"),this.el("div","small","Dein Familienalltag – gemeinsam organisiert"));
    header.append(left,this.el("span","small","Kostenlose Grundversion · v0.1.0"));page.append(header);
    const nav=this.el("nav","nav");
    [["today","Übersicht"],["tasks","Aufgaben"],["members","Familie"]].forEach(([id,label])=>{
      nav.append(this.button(label,()=>{this.tab=id;this.editMember=null;this.editTask=null;this.render();},`tab ${this.tab===id?"selected":""}`));
    });page.append(nav);
    if(this.error) page.append(this.el("div","notice",`Hinweis: ${this.error}`));
    if(!this.loaded) {page.append(this.el("div","panel",this.busy?"Daten werden geladen …":"Keine Verbindung zu Family Hub. Bitte Integration prüfen."));root.append(page);return;}
    if(this.tab==="today") this.renderToday(page);
    if(this.tab==="members") this.renderMembers(page);
    if(this.tab==="tasks") this.renderTasks(page);
    page.append(this.el("div","small footer","Daten werden lokal in Home Assistant gespeichert. Kalender und PRO-Funktionen folgen in späteren Versionen."));
    root.append(page);
  }
  renderToday(page) {
    const pending=this.data.tasks.filter(t=>!t.done);
    const today=new Date();const localDate=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;
    const due=pending.filter(t=>t.due && t.due<=localDate);
    const stats=this.el("div","grid");
    [[this.data.members.length,"Familienmitglieder"],[pending.length,"Offene Aufgaben"],[due.length,"Heute fällig / überfällig"]].forEach(([v,l])=>{
      const c=this.el("div","panel");c.append(this.el("div","small",l),this.el("div","stat",String(v)));stats.append(c);
    });page.append(stats);
    const card=this.el("section","panel");card.append(this.cardTitle("Heute im Blick"));
    if(!due.length) card.append(this.el("div","empty","Keine fälligen Aufgaben – Zeit für etwas Schönes!"));
    else due.sort((a,b)=>a.due.localeCompare(b.due)).forEach(t=>card.append(this.taskRow(t)));
    card.append(this.button("Alle Aufgaben öffnen",()=>{this.tab="tasks";this.render();},"btn secondary"));page.append(card);
    const family=this.el("section","panel");family.append(this.cardTitle("Unsere Familie"));
    if(!this.data.members.length) family.append(this.el("p","muted","Lege zuerst eure Familienmitglieder an."));
    else {const chips=this.el("div","chips");this.data.members.forEach(m=>{const c=this.el("span","chip",m.name);c.style.borderLeft=`5px solid ${m.color}`;chips.append(c);});family.append(chips);}
    family.append(this.el("p","small","Tipp: Aufgaben können mehreren Familienmitgliedern zugeordnet werden."));page.append(family);
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
