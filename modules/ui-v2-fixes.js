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
    }

    function openMessage(row){
      const sender=$('.sms-main b',row)?.textContent||'Unknown sender';
      const date=$('.sms-main time',row)?.textContent||'';
      const text=row.dataset.text||$('.sms-main p',row)?.textContent||'';
      root().innerHTML='<div class="sheet-backdrop sms-detail-backdrop"><div class="sheet sms-detail-sheet" role="dialog" aria-modal="true" aria-label="SMS message">'
        +'<div class="sms-detail-head"><div><small>SMS from</small><h2>'+esc(sender)+'</h2><time>'+esc(date)+'</time></div><button class="sms-detail-close" type="button" aria-label="Close">×</button></div>'
        +'<div class="sms-full-text">'+esc(text)+'</div>'
        +'<button type="button" class="sms-detail-actions">Message actions</button>'
        +'<button type="button" data-detail-close>Close</button></div></div>';
      $('.sms-detail-close').onclick=closeOverlay;
      $('[data-detail-close]').onclick=closeOverlay;
      $('.sms-detail-backdrop').onclick=e=>{if(e.target.classList.contains('sms-detail-backdrop'))closeOverlay()};
      $('.sms-detail-actions').onclick=()=>{
        closeOverlay();
        const menu=$('.row-menu',row);
        if(menu) menu.click();
      };
    }

    function value(id,fallback='—'){const e=$(id);return e&&e.textContent.trim()?e.textContent.trim():fallback;}
    function openSettings(){
      const model=value('.title h1','MF885');
      const firmware=value('#deviceFirmware','—');
      const software=value('#deviceSoftware','—');
      const network=value('#mode','Unknown');
      const operator=value('#headerMeta','—');
      const apn=value('#apn','—');
      root().innerHTML='<section class="settings-view" role="dialog" aria-modal="true" aria-label="Settings">'
        +'<header class="settings-header"><button type="button" class="settings-back">‹</button><h1>Settings</h1><span></span></header>'
        +'<div class="settings-tabs"><button class="active" type="button">General</button><button type="button" data-settings-diag>Diagnostics</button></div>'
        +'<article class="settings-card"><h3>Device</h3>'
        +'<div class="settings-row"><span>Model</span><b>'+esc(model)+'</b></div>'
        +'<div class="settings-row"><span>Firmware</span><b>'+esc(firmware)+'</b></div>'
        +'<div class="settings-row"><span>Software</span><b>'+esc(software)+'</b></div></article>'
        +'<article class="settings-card"><h3>Network</h3>'
        +'<div class="settings-row"><span>Operator</span><b>'+esc(operator)+'</b></div>'
        +'<div class="settings-row"><span>Mode</span><b>'+esc(network)+'</b></div>'
        +'<div class="settings-row"><span>APN</span><b>'+esc(apn)+'</b></div></article>'
        +'<article class="settings-card"><h3>Dashboard</h3>'
        +'<div class="settings-row"><span>Auto refresh</span><b>30 seconds</b></div>'
        +'<button class="settings-primary" type="button" data-settings-open-diag>Open diagnostics</button></article>'
        +'</section>';
      $('.settings-back').onclick=closeOverlay;
      $$('[data-settings-diag],[data-settings-open-diag]').forEach(b=>b.onclick=()=>{closeOverlay();const t=$('[data-tab="diagnostics"]');if(t)t.click();});
    }

    // Override the temporary v2 settings sheet with a proper full settings view.
    const settings=$('#settingsBtn');
    if(settings) settings.onclick=e=>{e.preventDefault();e.stopPropagation();openSettings();};

    // Diagnostics sub-tabs were visual only in the first v2 build. Make them functional.
    $$('[data-diag-tab]').forEach(b=>b.onclick=()=>setDiagTab(b.dataset.diagTab));
    setDiagTab('connection');

    // Open the entire SMS on row tap; keep the chevron for the existing actions sheet.
    document.addEventListener('click',e=>{
      const row=e.target.closest&&e.target.closest('.sms-row');
      if(!row || e.target.closest('.row-menu')) return;
      openMessage(row);
    });
  })();`;
}

function enhanceHtml(html, model) {
  let output = String(html || "");

  const css = `
    .diag-hidden{display:none!important}
    .diag-log-error{color:var(--red)!important;max-width:62%;overflow-wrap:anywhere;text-align:right}
    .diag-empty{color:var(--muted);padding:8px 0;line-height:1.45}
    .sms-row{cursor:pointer}
    .sms-detail-sheet{padding-bottom:calc(22px + env(safe-area-inset-bottom));}
    .sms-detail-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;border-bottom:1px solid var(--line);padding-bottom:13px;margin-bottom:15px}
    .sms-detail-head small,.sms-detail-head time{display:block;color:var(--muted);font-size:12px}
    .sms-detail-head h2{margin:3px 0 5px;font-size:22px}
    .sms-detail-close{width:42px!important;height:42px;padding:0!important;margin:0!important;border-radius:50%!important;font-size:28px!important;line-height:1!important}
    .sms-full-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:17px;line-height:1.5;color:var(--text);background:#08131d;border:1px solid var(--line);border-radius:14px;padding:15px;min-height:92px;margin-bottom:12px;user-select:text;-webkit-user-select:text}
    .settings-view{position:fixed;inset:0;z-index:50;overflow:auto;background:radial-gradient(circle at 50% -15%,#102a40 0,#07111c 40%,#050b12 100%);padding:calc(18px + env(safe-area-inset-top)) 14px calc(96px + env(safe-area-inset-bottom));color:var(--text)}
    .settings-header{max-width:732px;margin:0 auto 18px;display:grid;grid-template-columns:48px 1fr 48px;align-items:center}
    .settings-header h1{text-align:center;font-size:20px;margin:0}
    .settings-back{border:0;background:none;color:var(--cyan);font-size:42px;line-height:1;padding:0;text-align:left}
    .settings-tabs{max-width:732px;margin:0 auto 13px;display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid var(--line)}
    .settings-tabs button{border:0;background:none;color:var(--muted);padding:11px 4px;position:relative}
    .settings-tabs button.active{color:var(--cyan)}
    .settings-tabs button.active:after{content:"";position:absolute;left:18px;right:18px;bottom:-1px;height:2px;background:var(--cyan)}
    .settings-card{max-width:732px;margin:0 auto 12px;background:linear-gradient(145deg,rgba(16,31,46,.97),rgba(10,23,35,.98));border:1px solid var(--line);border-radius:18px;padding:15px}
    .settings-card h3{margin:0 0 9px;font-size:16px}
    .settings-row{display:grid;grid-template-columns:1fr minmax(0,60%);gap:14px;padding:10px 0;border-top:1px solid var(--line)}
    .settings-row span{color:var(--muted)}.settings-row b{text-align:right;overflow-wrap:anywhere}
    .settings-primary{width:100%;margin-top:11px;border:1px solid #38566f;background:#132536;color:var(--text);padding:12px;border-radius:12px}
  `;
  output = output.replace("</style>", `${css}</style>`);

  output = output.replace(
    '<div class="diag-tabs"><button class="active">Connection</button><button>SIM</button><button>Network</button><button>Logs</button></div>',
    '<div class="diag-tabs"><button class="active" type="button" data-diag-tab="connection">Connection</button><button type="button" data-diag-tab="sim">SIM</button><button type="button" data-diag-tab="network">Network</button><button type="button" data-diag-tab="logs">Logs</button></div>'
  );
  output = output.replace('<article class="card diag-card"><h3>Connection state</h3>', '<article class="card diag-card" data-diag-section="connection sim"><h3>Connection state</h3>');
  output = output.replace('<article class="card diag-card"><h3>Network details</h3>', '<article class="card diag-card" data-diag-section="network"><h3>Network details</h3>');
  output = output.replace('<article class="card diag-card"><h3>APN details</h3>', '<article class="card diag-card" data-diag-section="connection"><h3>APN details</h3>');
  output = output.replace('<article class="card diag-card"><h3>Ping / reachability</h3>', '<article class="card diag-card" data-diag-section="connection"><h3>Ping / reachability</h3>');

  const logCard = `<article class="card diag-card diag-hidden" data-diag-section="logs"><h3>Diagnostic log</h3>${diagnosticsLogHtml(model)}</article>`;
  output = output.replace('</section>\n  </div><footer class="footerbar">', `${logCard}</section>\n  </div><footer class="footerbar">`);

  output = output.replace('</body>', `<script>${enhancementScript()}</script></body>`);
  return output;
}

module.exports = { enhanceHtml };
