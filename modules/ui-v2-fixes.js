// Interaction fixes layered on top of UI v2 without touching the router backend.
// This module transforms the generated HTML and adds only client-side UI behavior.

function esc(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function diagnosticsLogHtml(model) {
  const diagnostics = model && model.cellularDiagnostics || {};
  const endpointErrors = diagnostics.endpointErrors || {};
  const errors = model && model.errors || {};
  const rows = [];

  Object.keys(endpointErrors).forEach(key => {
    rows.push(`<div class="diag-row"><span>${esc(key)}</span><b class="diag-log-error">${esc(endpointErrors[key])}</b></div>`);
  });
  Object.keys(errors).forEach(key => {
    if (!errors[key]) return;
    rows.push(`<div class="diag-row"><span>${esc(key)}</span><b class="diag-log-error">${esc(errors[key])}</b></div>`);
  });

  const values = diagnostics.values || {};
  ["sim", "registration", "pdpState", "operator", "band", "rsrp", "rsrq", "sinr"].forEach(key => {
    const item = values[key];
    if (!item || (item.raw === null || item.raw === undefined || item.raw === "")) return;
    const source = item.source ? ` · ${item.source}` : "";
    rows.push(`<div class="diag-row"><span>${esc(key)}</span><b>${esc(String(item.raw))}${esc(source)}</b></div>`);
  });

  if (!rows.length) rows.push('<div class="diag-empty">No diagnostic errors or raw parser details are currently available.</div>');
  return rows.join("");
}

function enhancementScript() {
  return `(function(){
    const $=(q,r=document)=>r.querySelector(q), $$=(q,r=document)=>Array.from(r.querySelectorAll(q));
    const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const root=()=>$('#sheetRoot');

    function closeOverlay(){ if(root()) root().innerHTML=''; }

    function setDiagTab(name){
      $$('[data-diag-tab]').forEach(b=>b.classList.toggle('active',b.dataset.diagTab===name));
      $$('[data-diag-section]').forEach(card=>{
        const sections=String(card.dataset.diagSection||'').split(/\\s+/);
        card.classList.toggle('diag-hidden',!sections.includes(name));
      });

      // Connection state is reused by Connection and SIM. On the SIM tab show
      // only the SIM stage; on Connection show the full registration chain.
      const stageCard=$('[data-diag-section~="sim"]');
      if(stageCard){
        $$('.diag-stage',stageCard).forEach((row,index)=>{
          row.classList.toggle('diag-stage-hidden',name==='sim' && index!==0);
        });
        const heading=$('h3',stageCard);
        if(heading) heading.textContent=name==='sim'?'SIM state':'Connection state';
      }
    }

    function setMessageExpanded(row,expanded){
      const menu=$('.row-menu',row);
      row.classList.toggle('sms-expanded',expanded);
      row.setAttribute('aria-expanded',String(expanded));
      if(menu){
        menu.type='button';
        menu.setAttribute('aria-expanded',String(expanded));
        menu.setAttribute('aria-label',expanded?'Collapse message':'Expand message');
      }
      const old=$('.sms-expanded-content',row);
      if(old) old.remove();
      if(!expanded)return;

      const detail=document.createElement('div');
      detail.className='sms-expanded-content';
      const full=document.createElement('div');
      full.className='sms-full-text';
      full.textContent=row.dataset.text||$('.sms-main p',row)?.textContent||'';
      const actions=document.createElement('div');
      actions.className='sms-inline-actions';
      [['copy','Copy'],['share','Share'],['delete','Delete']].forEach(([action,label])=>{
        const button=document.createElement('button');
        button.type='button';
        button.dataset.smsAction=action;
        button.textContent=label;
        if(action==='delete')button.className='danger';
        actions.appendChild(button);
      });
      detail.append(full,actions);
      row.appendChild(detail);
    }

    function toggleMessage(row){
      const expanded=!row.classList.contains('sms-expanded');
      $$('.sms-row.sms-expanded').forEach(other=>{if(other!==row)setMessageExpanded(other,false)});
      setMessageExpanded(row,expanded);
    }

    function value(id,fallback='—'){const e=$(id);return e&&e.textContent.trim()?e.textContent.trim():fallback;}
    function openSettings(){
      const model=value('.title h1','MF885');
      const firmware=value('#deviceFirmware','—');
      const software=value('#deviceSoftware','—');
      const network=value('#mode','Unknown');
      const operator=value('#headerMeta','—');
      root().innerHTML='<div class="sheet-backdrop settings-backdrop"><div class="sheet settings-sheet" role="dialog" aria-modal="true" aria-label="Router settings">'
        +'<div class="settings-head"><div><small>Router</small><h2>Settings</h2></div><button class="settings-close" type="button" aria-label="Close">×</button></div>'
        +'<div class="settings-group"><div class="settings-row"><span>Model</span><b>'+esc(model)+'</b></div><div class="settings-row"><span>Firmware</span><b>'+esc(firmware)+'</b></div><div class="settings-row"><span>Software</span><b>'+esc(software)+'</b></div></div>'
        +'<div class="settings-group"><div class="settings-row"><span>Operator</span><b>'+esc(operator)+'</b></div><div class="settings-row"><span>Network</span><b>'+esc(network)+'</b></div><div class="settings-row"><span>Auto refresh</span><b>30 s</b></div></div>'
        +'<button type="button" class="settings-primary" data-settings-open-diag>Open diagnostics</button>'
        +'<button type="button" data-settings-capabilities>Detect capabilities</button>'
        +'<button type="button" class="danger" data-settings-power>Reboot / Power</button>'
        +'</div></div>';
      $('.settings-close').onclick=closeOverlay;
      $('.settings-backdrop').onclick=e=>{if(e.target.classList.contains('settings-backdrop'))closeOverlay()};
      $('[data-settings-open-diag]').onclick=()=>{closeOverlay();const t=$('[data-tab="diagnostics"]');if(t)t.click();};
      $('[data-settings-capabilities]').onclick=()=>{closeOverlay();const t=$('[data-tab="overview"]');if(t)t.click();setTimeout(()=>{const d=$('#detectAll');if(d){d.scrollIntoView({behavior:'smooth',block:'center'});d.focus();}},100);};
      $('[data-settings-power]').onclick=()=>{closeOverlay();setTimeout(()=>{const p=$('#powerBtn');if(p)p.click();},0);};
    }

    // Replace the temporary v2 settings popup with a compact, consistent sheet.
    const settings=$('#settingsBtn');
    if(settings) settings.onclick=e=>{e.preventDefault();e.stopPropagation();openSettings();};

    // Diagnostics sub-tabs were visual only in the first v2 build. Make them functional.
    $$('[data-diag-tab]').forEach(b=>b.onclick=()=>setDiagTab(b.dataset.diagTab));
    setDiagTab('connection');

    // Delegation also covers rows replaced later by zmiApplySmsHistory/applySms.
    document.addEventListener('click',e=>{
      const row=e.target.closest&&e.target.closest('.sms-row');
      if(!row)return;
      const action=e.target.closest('[data-sms-action]');
      if(action){
        e.preventDefault();e.stopPropagation();
        if(window.zmiSmsAction)window.zmiSmsAction(row,action.dataset.smsAction);
        return;
      }
      e.preventDefault();e.stopPropagation();
      toggleMessage(row);
    },true);

    // Normalize both initial and dynamically generated controls.
    $$('.sms-row').forEach(row=>setMessageExpanded(row,false));
  })();`;
}

function enhanceHtml(html, model) {
  let output = String(html || "");

  const css = `
    .diag-hidden,.diag-stage-hidden{display:none!important}
    .diag-log-error{color:var(--red)!important;max-width:62%;overflow-wrap:anywhere;text-align:right}
    .diag-empty{color:var(--muted);padding:8px 0;line-height:1.45}
    .sms-row{cursor:pointer}
    .row-menu{transition:transform .2s ease}
    .sms-expanded .row-menu{transform:rotate(90deg)}
    .sms-expanded .sms-main p{white-space:pre-wrap;overflow-wrap:anywhere}
    .sms-expanded-content{grid-column:2/-1;min-width:0}
    .sms-full-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:16px;line-height:1.5;color:var(--text);padding:8px 0 12px;user-select:text;-webkit-user-select:text}
    .sms-inline-actions{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
    .sms-inline-actions button{padding:9px;border:1px solid var(--line);background:#122230;color:white;border-radius:10px}
    .sms-inline-actions .danger{color:var(--red);border-color:rgba(255,75,85,.5)}
    @media(prefers-reduced-motion:reduce){.row-menu{transition:none}}
    .settings-sheet{max-width:620px;margin:0 auto;width:100%;}
    .settings-group{border:1px solid var(--line);border-radius:14px;background:#08131d;padding:0 13px;margin-bottom:11px}
    .settings-row{display:grid;grid-template-columns:1fr minmax(0,62%);gap:14px;padding:11px 0;border-top:1px solid var(--line)}
    .settings-row:first-child{border-top:0}.settings-row span{color:var(--muted)}.settings-row b{text-align:right;overflow-wrap:anywhere}
    .settings-primary{border-color:#32627d!important;color:var(--cyan)!important}
  `;
  output = output.replace("</style>", `${css}</style>`);

  output = output.replace(
    '<div class="diag-tabs"><button class="active">Connection</button><button>SIM</button><button>Network</button><button>Logs</button></div>',
    '<div class="diag-tabs"><button class="active" type="button" data-diag-tab="connection">Connection</button><button type="button" data-diag-tab="sim">SIM</button><button type="button" data-diag-tab="network">Network</button><button type="button" data-diag-tab="logs">Logs</button></div>'
  );
  output = output.replace('<article class="card diag-card"><h3>Connection state</h3>', '<article class="card diag-card" data-diag-section="connection sim"><h3>Connection state</h3>');
  output = output.replace('<article class="card diag-card"><h3>Network details</h3>', '<article class="card diag-card" data-diag-section="network"><h3>Network details</h3>');
  output = output.replace('<article class="card diag-card"><h3>APN details</h3>', '<article class="card diag-card" data-diag-section="connection network"><h3>APN details</h3>');
  output = output.replace('<article class="card diag-card"><h3>Ping / reachability</h3>', '<article class="card diag-card" data-diag-section="connection logs"><h3>Ping / reachability</h3>');

  const logCard = `<article class="card diag-card diag-hidden" data-diag-section="logs"><h3>Diagnostic log</h3>${diagnosticsLogHtml(model)}</article>`;
  output = output.replace('</section>\n  </div><footer class="footerbar">', `${logCard}</section>\n  </div><footer class="footerbar">`);

  // A replacement callback keeps the script's `$$` selector helper intact;
  // replacement strings interpret `$$` as a single literal dollar sign.
  output = output.replace('</body>', () => `<script>${enhancementScript()}</script></body>`);
  return output;
}

module.exports = { enhanceHtml };
