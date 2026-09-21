(function(){
  function initials(name,email){
    const src=(name||email||'Softmarc User').trim();
    return src.split(/\s+/).slice(0,2).map(s=>s[0]).join('').toUpperCase()||'SU';
  }
  function go(url){ window.location.href=url; }

  let user={};
  try{ user=JSON.parse(localStorage.getItem('softmarc_user')||'{}'); }catch(e){}
  const ini=initials(user.full_name,user.email);

  // User avatars / mini profile
  document.querySelectorAll('#avatarInitials,.avatar-top,.user-mini-avatar').forEach(el=>{
    if(user.avatar_image){
      el.innerHTML='<img src="'+user.avatar_image+'" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">';
    }else if(!el.textContent || el.textContent.trim()==='AB' || el.textContent.trim()==='SU' || el.classList.contains('user-mini-avatar')){
      el.textContent=ini;
    }
  });
  document.querySelectorAll('.user-mini-name,#sidebarName').forEach(el=>el.textContent=user.full_name||user.email||'Softmarc User');
  document.querySelectorAll('.user-mini-role').forEach(el=>el.textContent=user.role||'Student');
  document.querySelectorAll('#adminLink').forEach(el=>{ el.style.display=(user.role==='admin')?'flex':'none'; });

  // Make top-right profile circle redirect to profile page.
  document.querySelectorAll('#avatarInitials,.avatar-top').forEach(el=>{
    el.style.cursor='pointer';
    el.setAttribute('title','Go to Profile');
    el.setAttribute('role','button');
    el.setAttribute('tabindex','0');
    el.addEventListener('click',function(ev){
      ev.preventDefault(); ev.stopImmediatePropagation();
      if(!/profile\.html(?:$|[?#])/.test(location.pathname)) go('profile.html');
    },true);
    el.addEventListener('keydown',function(ev){
      if(ev.key==='Enter' || ev.key===' '){ ev.preventDefault(); if(!/profile\.html(?:$|[?#])/.test(location.pathname)) go('profile.html'); }
    });
  });

  // Logout
  document.querySelectorAll('#logoutBtn').forEach(el=>el.addEventListener('click',function(ev){
    ev.preventDefault(); ev.stopImmediatePropagation();
    localStorage.removeItem('softmarc_user');
    go('index.html');
  },true));

  // Add theme toggle button to pages where it is missing (Profile, Certificates, Assessments, Admin, etc.)
  function ensureThemeToggle(){
    if(document.getElementById('themeToggle')) return;
    const topbar=document.querySelector('.topbar');
    if(!topbar) return;
    let container=topbar.querySelector('.topbar-actions') || topbar.querySelector('.topbar-right') || topbar.querySelector('#topbarActionContainer');
    if(!container){
      container=document.createElement('div');
      container.className='topbar-actions';
      topbar.appendChild(container);
    }
    if(container.id==='topbarActionContainer'){
      container.style.display='flex';
      container.style.alignItems='center';
      container.style.gap='10px';
    }
    const btn=document.createElement('button');
    btn.type='button';
    btn.id='themeToggle';
    btn.className='icon-btn softmarc-theme-btn';
    btn.title='Toggle theme';
    btn.setAttribute('aria-label','Toggle light/dark theme');
    btn.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>';
    const avatar=container.querySelector('#avatarInitials,.avatar,.avatar-top');
    if(avatar) container.insertBefore(btn, avatar);
    else container.insertBefore(btn, container.firstChild);
  }
  ensureThemeToggle();

  // Theme: capture-phase handler prevents older page-specific listeners from toggling twice.
  const savedTheme=localStorage.getItem('softmarc_theme') || document.documentElement.getAttribute('data-theme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);
  document.body && document.body.setAttribute('data-theme', savedTheme);
  document.querySelectorAll('#themeToggle').forEach(btn=>{
    btn.addEventListener('click',function(ev){
      ev.preventDefault(); ev.stopImmediatePropagation();
      const current=document.documentElement.getAttribute('data-theme')==='dark'?'dark':'light';
      const next=current==='dark'?'light':'dark';
      document.documentElement.setAttribute('data-theme',next);
      document.body && document.body.setAttribute('data-theme',next);
      localStorage.setItem('softmarc_theme',next);
      const sel=document.getElementById('themeSelect'); if(sel) sel.value=next;
    },true);
  });

  // Mobile sidebar: capture-phase handler prevents double open/close if page also has a listener.
  const sidebar=document.getElementById('sidebar'), scrim=document.getElementById('scrim'), toggle=document.getElementById('menuToggle');
  function setSidebar(open){
    if(!sidebar) return;
    sidebar.classList.toggle('open', !!open);
    if(scrim) scrim.classList.toggle('show', !!open);
  }
  if(toggle&&sidebar){
    toggle.addEventListener('click',function(ev){
      ev.preventDefault(); ev.stopImmediatePropagation();
      setSidebar(!sidebar.classList.contains('open'));
    },true);
  }
  if(scrim&&sidebar){
    scrim.addEventListener('click',function(ev){
      ev.preventDefault(); ev.stopImmediatePropagation();
      setSidebar(false);
    },true);
  }
})();

/* Live time tracking: counts seconds while the tab is visible and reports them to /api/time.
   This is what powers the dashboard "Hours logged" stat — no manual action needed. */
(function(){
  var pending = 0, last = Date.now();
  function whoami(){ try { return JSON.parse(localStorage.getItem('softmarc_user')||'null'); } catch(e){ return null; } }
  function tick(){ var n = Date.now(); if (document.visibilityState !== 'hidden') pending += Math.round((n - last) / 1000); last = n; }
  function flush(){
    tick(); var secs = Math.min(pending, 120); pending = 0;
    if (secs < 5) return;
    var u = whoami(); if (!u || !u.id) return;
    var body = JSON.stringify({ student_id: u.id, seconds: secs });
    try { if (navigator.sendBeacon) { navigator.sendBeacon('/api/time', new Blob([body], {type:'application/json'})); return; } } catch(e){}
    try { fetch('/api/time', { method:'POST', headers:{'Content-Type':'application/json'}, body: body, keepalive:true }).catch(function(){}); } catch(e){}
  }
  setInterval(tick, 5000);
  setInterval(flush, 30000);
  document.addEventListener('visibilitychange', function(){ last = Date.now(); if (document.visibilityState === 'hidden') flush(); });
  window.addEventListener('pagehide', flush);
})();
