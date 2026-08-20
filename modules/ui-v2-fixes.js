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

    let overlayTrigger=null;
    function closeOverlay(kind){
      const host=root(), backdrop=host&&host.firstElementChild;
      if(!backdrop||kind&&backdrop.dataset.overlay!==kind)return;
      host.innerHTML='';
      const target=overlayTrigger;overlayTrigger=null;
      if(target&&target.isConnected)target.focus();
    }
    function openHelp(key,trigger){
      const definitions=typeof HELP_DEFINITIONS==='object'?HELP_DEFINITIONS:{},definition=definitions[key],host=root();
      if(!definition||!host||host.firstElementChild)return;
      overlayTrigger=trigger;
      const units=definition.units?'<div class="help-detail"><b>Units</b><p>'+esc(definition.units)+'</p></div>':'';
      const reported=value=>value===undefined||value===null||value===''?'Not reported by device':String(value);
      const current=reported(trigger&&trigger.dataset.helpValue),raw=trigger&&trigger.dataset.helpRaw,source=reported(trigger&&trigger.dataset.helpSource),confidence=trigger&&trigger.dataset.helpConfidence;
      const rawRow=raw!==undefined&&raw!==''&&String(raw)!==current?'<p><b>Raw value:</b> '+esc(raw)+'</p>':'';
      const confidenceRow=confidence!==undefined&&confidence!==''?'<p><b>Confidence:</b> '+esc(confidence)+'</p>':'';
      const technical='<div class="help-detail help-technical"><b>Technical data</b><p><b>Current displayed value:</b> '+esc(current)+'</p>'+rawRow+'<p><b>Technical source:</b> '+esc(source)+'</p>'+confidenceRow+'</div>';
      host.innerHTML='<div class="sheet-backdrop help-backdrop" data-overlay="help"><section class="sheet help-sheet" role="dialog" aria-modal="true" aria-labelledby="helpTitle" tabindex="-1">'
        +'<div class="help-sheet-head"><span class="help-mark">?</span><div><small>Field guide</small><h2 id="helpTitle">'+esc(definition.title)+'</h2></div></div>'
        +'<div class="help-detail"><b>What it means</b><p>'+esc(definition.meaning)+'</p></div>'+units
        +'<div class="help-detail"><b>How to read it</b><p>'+esc(definition.guidance)+'</p></div>'+technical
        +'<button type="button" class="help-close" data-help-close>Close</button></section></div>';
      $('.help-sheet',host).focus();
    }

    function setDiagTab(name){
      $$('[data-diag-tab]').forEach(b=>{const selected=b.dataset.diagTab===name;b.classList.toggle('active',selected);b.setAttribute('aria-selected',String(selected));b.tabIndex=selected?0:-1;});
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
      if(root()&&root().firstElementChild)return;
      overlayTrigger=$('#settingsBtn');
      const model=value('.title h1','MF885');
      const firmware=value('#deviceFirmware','—');
      const software=value('#deviceSoftware','—');
      const softwareRevision=value('#deviceSoftwareRevision','—');
      const network=value('#mode','Unknown');
      const operator=value('#headerMeta','—');
      const apn=value('#apn','—');
      const poll=value('#pollSeconds','30');
      const powerButton=$('#powerBtn'),powerAvailable=!!(powerButton&&!powerButton.disabled);
      root().innerHTML='<div class="sheet-backdrop settings-backdrop" data-overlay="settings"><div class="sheet settings-sheet" role="dialog" aria-modal="true" aria-label="Router settings">'
        +'<div class="settings-head"><div><small>Router</small><h2>Settings</h2></div><button class="settings-close" type="button" aria-label="Close">×</button></div>'
        +'<div class="settings-group"><div class="settings-row"><span>Model</span><b>'+esc(model)+'</b></div><div class="settings-row"><span>Firmware</span><b>'+esc(firmware)+'</b></div><div class="settings-row"><span>Software</span><b>'+esc(software)+'</b></div><div class="settings-row"><span>Dashboard build</span><b>'+esc(softwareRevision)+'</b></div></div>'
        +'<div class="settings-group"><div class="settings-row"><span>Operator</span><b>'+esc(operator)+'</b></div><div class="settings-row"><span>Network</span><b>'+esc(network)+'</b></div><div class="settings-row"><span>APN</span><b>'+esc(apn)+'</b></div><div class="settings-row"><span>Auto refresh</span><b>'+esc(poll)+' s</b></div></div>'
        +'<button type="button" class="settings-primary" data-settings-open-diag>Open diagnostics</button>'
        +'<button type="button" data-settings-capabilities>Detect capabilities</button>'
        +'<button type="button" data-settings-preflight>Run read-only preflight</button>'
        +'<button type="button" data-settings-app-auth>Run APP auth probe (GET only)</button>'
        +'<button type="button" data-settings-firmware-canary>Verify WEBUI canary file (no flash)</button>'
        +'<button type="button" data-settings-last-power>Last power report</button>'
        +'<button type="button" class="danger" data-settings-power'+(powerAvailable?'':' disabled aria-disabled="true"')+'>Reboot / Power</button>'
        +'</div></div>';
      $('.settings-close').onclick=()=>closeOverlay('settings');
      $('.settings-backdrop').onclick=e=>{if(e.target.classList.contains('settings-backdrop'))closeOverlay('settings')};
      $('[data-settings-open-diag]').onclick=()=>{closeOverlay('settings');const t=$('[data-tab="diagnostics"]');if(t)t.click();};
      $('[data-settings-capabilities]').onclick=()=>{closeOverlay('settings');const t=$('[data-tab="overview"]');if(t)t.click();setTimeout(()=>{const d=$('#detectAll');if(d){d.scrollIntoView({behavior:'smooth',block:'center'});d.focus();d.click();}},100);};
      $('[data-settings-preflight]').onclick=()=>{closeOverlay('settings');const t=$('[data-tab="overview"]');if(t)t.click();setTimeout(()=>{const p=$('#safePreflight');if(p)p.click();},0);};
      $('[data-settings-app-auth]').onclick=()=>{closeOverlay('settings');const t=$('[data-tab="overview"]');if(t)t.click();setTimeout(()=>{const p=$('#appAuthProbe');if(p)p.click();},0);};
      $('[data-settings-firmware-canary]').onclick=()=>{closeOverlay('settings');const t=$('[data-tab="overview"]');if(t)t.click();setTimeout(()=>{const p=$('#firmwareCanaryValidate');if(p)p.click();},0);};
      $('[data-settings-last-power]').onclick=()=>{closeOverlay('settings');const t=$('[data-tab="overview"]');if(t)t.click();setTimeout(()=>{const p=$('#lastPowerReportBtn');if(p)p.click();},0);};
      $('[data-settings-power]').onclick=()=>{closeOverlay('settings');setTimeout(()=>{const p=$('#powerBtn');if(p)p.click();},0);};
    }

    // One delegated listener covers initial and refresh-generated help controls.
    document.addEventListener('click',e=>{
      const trigger=e.target.closest&&e.target.closest('[data-help-key]');
      if(!trigger)return;
      e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();
      if(trigger.closest('#screen-sms'))return;
      openHelp(trigger.dataset.helpKey,trigger);
    },true);
    document.addEventListener('click',e=>{
      if(e.target.closest&&e.target.closest('[data-help-close]')){e.preventDefault();closeOverlay('help');return;}
      if(e.target.classList&&e.target.classList.contains('help-backdrop'))closeOverlay('help');
    });
    document.addEventListener('keydown',e=>{
      if(e.key==='Escape'&&root()&&root().querySelector('[data-overlay="help"]')){e.preventDefault();closeOverlay('help');}
    });

    // Replace the temporary v2 settings popup with a compact, consistent sheet.
    const settings=$('#settingsBtn');
    if(settings) settings.onclick=e=>{e.preventDefault();e.stopPropagation();openSettings();};

    // Diagnostics sub-tabs were visual only in the first v2 build. Make them functional.
    $$('[data-diag-tab]').forEach(b=>{b.onclick=()=>setDiagTab(b.dataset.diagTab);b.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const tabs=$$('[data-diag-tab]'),current=tabs.indexOf(b),next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(current+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;setDiagTab(tabs[next].dataset.diagTab);tabs[next].focus();};});
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
    .sms-expanded .sms-main p{display:none}
    .sms-expanded-content{grid-column:2/-1;min-width:0}
    .sms-full-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:16px;line-height:1.5;color:var(--text);padding:8px 0 12px;user-select:text;-webkit-user-select:text}
    .sms-inline-actions{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
    .sms-inline-actions button{padding:9px;border:1px solid var(--line);background:#122230;color:white;border-radius:10px}
    .sms-inline-actions .danger{color:var(--red);border-color:rgba(255,75,85,.5)}
    @media(prefers-reduced-motion:reduce){.row-menu{transition:none}}

    .help-inline{display:inline-flex;align-items:center;gap:5px;min-width:0}.help-action{position:relative;display:inline-flex;align-items:center;gap:4px}
    .help-button{display:inline-grid!important;place-items:center;flex:0 0 auto;width:24px!important;height:24px!important;min-width:24px;padding:0!important;margin:0!important;border:0!important;border-radius:50%!important;background:transparent!important;color:#bdeeff!important;font-size:12px!important;font-weight:800!important;line-height:1!important;vertical-align:middle;cursor:help;touch-action:manipulation}
    .help-button:hover{color:#fff!important;background:rgba(25,199,255,.12)!important}.help-button:focus-visible,.help-close:focus-visible{outline:3px solid var(--cyan)!important;outline-offset:3px}
    .panel-wrap{position:relative}.panel-help-controls{position:absolute;right:0;bottom:-6px}.panel-help-controls .help-button{width:24px!important;height:24px!important;min-width:24px;font-size:12px!important}.metric span,.device-row span,.usage-row span{display:flex;align-items:center;gap:5px}.card-title .help-button{margin-left:auto!important}.cap-row .help-button{margin-left:6px!important}.footer-inner>.help-button{align-self:center}
    .help-backdrop{padding-top:max(20px,env(safe-area-inset-top));overscroll-behavior:contain}.help-sheet{max-width:620px;margin:0 auto;width:100%;padding-bottom:max(20px,env(safe-area-inset-bottom));box-shadow:0 -20px 60px rgba(0,0,0,.45)}
    .help-sheet-head{display:flex;gap:13px;align-items:center;margin-bottom:15px}.help-sheet-head h2{margin:2px 0 0}.help-sheet-head small{color:var(--cyan);text-transform:uppercase;letter-spacing:.08em}.help-mark{display:grid;place-items:center;width:42px;height:42px;border-radius:50%;background:#12354b;color:var(--cyan);font-size:22px;font-weight:800}
    .help-detail{background:#08131d;border:1px solid var(--line);border-radius:13px;padding:12px 14px;margin:9px 0}.help-detail b{color:#dff6ff}.help-detail p{color:var(--muted);line-height:1.55;margin:6px 0 0}.help-close{min-height:46px}
    @media(max-width:560px){.help-button{width:24px!important;height:24px!important;min-width:24px}.help-sheet{border-radius:20px 20px 0 0}.footer-inner{gap:5px}.help-action>.help-button{position:absolute;right:-5px;bottom:-7px}}
    @media(prefers-reduced-motion:reduce){.help-button,.help-sheet,.sheet-backdrop{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
    .settings-sheet{max-width:620px;margin:0 auto;width:100%;}
    .settings-group{border:1px solid var(--line);border-radius:14px;background:#08131d;padding:0 13px;margin-bottom:11px}
    .settings-row{display:grid;grid-template-columns:1fr minmax(0,62%);gap:14px;padding:11px 0;border-top:1px solid var(--line)}
    .settings-row:first-child{border-top:0}.settings-row span{color:var(--muted)}.settings-row b{text-align:right;overflow-wrap:anywhere}
    .settings-primary{border-color:#32627d!important;color:var(--cyan)!important}
  `;
  output = output.replace("</style>", `${css}</style>`);

  output = output.replace(
    '<div class="diag-tabs"><button class="active">Connection</button><button>SIM</button><button>Network</button><button>Logs</button></div>',
    '<div class="diag-tabs" role="tablist" aria-label="Diagnostic sections"><button class="active" type="button" role="tab" aria-selected="true" data-diag-tab="connection">Connection</button><button type="button" role="tab" aria-selected="false" data-diag-tab="sim">SIM</button><button type="button" role="tab" aria-selected="false" data-diag-tab="network">Network</button><button type="button" role="tab" aria-selected="false" data-diag-tab="logs">Logs</button></div>'
  );
  output = output.replace('<article class="card diag-card"><h3>Connection state', '<article class="card diag-card" data-diag-section="connection sim"><h3>Connection state');
  output = output.replace('<article class="card diag-card"><h3>Network details', '<article class="card diag-card" data-diag-section="network"><h3>Network details');
  output = output.replace('<article class="card diag-card"><h3>APN details', '<article class="card diag-card" data-diag-section="connection network"><h3>APN details');
  output = output.replace('<article class="card diag-card"><h3>Ping / reachability</h3>', '<article class="card diag-card" data-diag-section="connection logs"><h3>Ping / reachability</h3>');

  const logCard = `<article class="card diag-card diag-hidden" data-diag-section="logs"><h3>Diagnostic log <button class="help-button" type="button" data-help-key="diagnosticLog" aria-label="Explain Diagnostic log">?</button></h3><div id="diagnosticLog">${diagnosticsLogHtml(model)}</div></article>`;
  output = output.replace('</section>\n  </div><footer class="footerbar">', `${logCard}</section>\n  </div><footer class="footerbar">`);

  // A replacement callback keeps the script's `$$` selector helper intact;
  // replacement strings interpret `$$` as a single literal dollar sign.
  output = output.replace('</body>', () => `<script>${enhancementScript()}</script></body>`);
  return output;
}

module.exports = { enhanceHtml };
