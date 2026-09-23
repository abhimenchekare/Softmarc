/* Softmarc — device credential holder.
   Loads first on every page, attaches the signed session token to /api calls,
   and sends a visitor back to sign-in when the token is missing or expired.
   This file only carries the token; the server still decides who may see what. */
(function () {
  var TK = 'softmarc_token', UK = 'softmarc_user';
  function get() { try { return localStorage.getItem(TK) || ''; } catch (e) { return ''; } }
  function set(t) { try { t ? localStorage.setItem(TK, t) : localStorage.removeItem(TK); } catch (e) {} }
  function user() { try { return JSON.parse(localStorage.getItem(UK) || '{}') || {}; } catch (e) { return {}; } }

  window.SoftmarcAuth = {
    token: get,
    setToken: set,
    user: user,
    isAdmin: function () { return user().role === 'admin'; },
    isTrainer: function () { return user().role === 'trainer'; },
    isExpired: function () {
      var t = get(); if (!t) return true;
      try { var p = JSON.parse(atob(t.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))); return !p.exp || p.exp < Date.now(); }
      catch (e) { return false; } /* server is the authority */
    },
    clear: function () { set(''); try { localStorage.removeItem(UK); } catch (e) {} }
  };

  var native = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    try {
      var rel = url.indexOf('/api/') === 0 || url.indexOf('/api?') === 0;
      var abs = url.indexOf(location.origin) === 0 && url.indexOf('/api/') >= 0;
      if ((rel || abs) && get()) {
        var opts = init ? Object.assign({}, init) : {};
        var h = new Headers(opts.headers || (input && input.headers) || undefined);
        h.set('x-auth', get());
        opts.headers = h;
        if (typeof input !== 'string' && !opts.method) opts.method = input.method;
        return guard(native.call(this, typeof input === 'string' ? input : input, opts));
      }
    } catch (e) { /* never break a call because of the wrapper */ }
    return guard(native.call(this, input, init));
  };
  function guard(pr) {
    if (!pr || !pr.then) return pr;
    return pr.then(function (res) {
      try {
        if (res && res.status === 401 && !window.__smExpired) {
          res.clone().json().then(function (b) {
            if (b && b.code === 'auth_required') {
              window.__smExpired = 1;
              window.SoftmarcAuth.clear();
              if (!/index\.html|^\/$/.test(location.pathname))
                location.href = 'index.html?expired=1';
            }
          }).catch(function () {});
        }
      } catch (e) {}
      return res;
    });
  }

  // logout on any page must also drop the token
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('#logoutBtn') : null;
    if (a) window.SoftmarcAuth.clear();
  }, true);

  // Keep role-only workspaces out of the wrong account before the first API answer.
  document.addEventListener('DOMContentLoaded', function () {
    var role=user().role || '';
    var adm = /(^|\/)(admin|analytics)\.html$/.test(location.pathname);
    var trainer = /(^|\/)trainer_dashboard\.html$/.test(location.pathname);
    if ((adm || trainer) && !get()) { window.__smExpired = 1; location.href = 'index.html'; return; }
    if (adm && role !== 'admin') { location.href = role==='trainer' ? 'trainer_dashboard.html' : 'soft_dashboard.html'; return; }
    if (trainer && role !== 'trainer' && role !== 'admin') location.href = 'soft_dashboard.html';
  });
})();
