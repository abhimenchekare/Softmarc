/* Softmarc admin — quiz editor used by the Manage Quizzes tab.
   A quiz belongs to a course (not to one subtopic), and this editor writes the
   whole thing in one save: title, pass mark and every question with its answer.
   Public API: SoftmarcAssessments.open(opts) / .state
   Nothing about this file appears on a learner's screen; answers are only ever
   sent to a signed-in admin. */
(function () {
  var API = '/api';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (m) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]; }); };

  var current = null;      // the open editor's state
  var autoClose = null;    // the "saved, closing now" timer — must not fire into a reopened session

  function emit() { try { document.dispatchEvent(new CustomEvent('sm:assessments-changed')); } catch (e) {} }
  function blank() { return { question_text: '', option_a: '', option_b: '', option_c: '', option_d: '', correct_option: '' }; }

  // ---------- styles ----------
  function css() {
    if ($('saeStyle')) return;
    var st = document.createElement('style'); st.id = 'saeStyle';
    st.textContent = [
      '.sae-overlay{position:fixed;inset:0;z-index:400;display:none;align-items:flex-start;justify-content:center;padding:24px 16px;background:rgba(2,6,23,.6);backdrop-filter:blur(6px);overflow:auto}',
      '.sae-overlay.on{display:flex}',
      '.sae-dlg{width:min(880px,96vw);background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:18px;box-shadow:0 30px 80px rgba(2,6,23,.35);overflow:hidden;font-family:inherit}',
      '.sae-head{padding:18px 22px;background:linear-gradient(180deg,var(--surface,#fff),var(--surface-hover,#f8fafc));border-bottom:1px solid var(--border,#e2e8f0);display:flex;align-items:flex-start;justify-content:space-between;gap:14px}',
      '.sae-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:var(--cyan-bg,#e0f2fe);color:var(--cyan,#0369a1);font-size:11px;font-weight:800;letter-spacing:.4px;text-transform:uppercase}',
      '.sae-head h2{margin:8px 0 2px;font-size:19px;font-weight:800;color:var(--navy-950,#0a1930)}',
      '.sae-head p{margin:0;font-size:12.5px;color:var(--text-600,#475569)}',
      '.sae-x{border:1px solid var(--border,#e2e8f0);background:var(--bg,#f8fafc);border-radius:10px;width:34px;height:34px;font-size:17px;line-height:1;cursor:pointer;color:var(--text-700,#334155)}',
      '.sae-x:hover{background:var(--border,#e2e8f0)}',
      '.sae-body{padding:18px 22px;max-height:min(66vh,760px);overflow:auto}',
      '.sae-meta{display:grid;grid-template-columns:1fr 150px;gap:12px;margin-bottom:16px}',
      '.sae-f label{display:block;font-size:11px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:var(--text-500,#64748b);margin-bottom:5px}',
      '.sae-f input,.sae-f textarea,.sae-f select{width:100%;box-sizing:border-box;border:1px solid var(--border,#e2e8f0);border-radius:10px;padding:9px 11px;font:inherit;font-size:13.5px;background:var(--bg,#fff);color:var(--text-900,#0f172a)}',
      '.sae-f input:focus,.sae-f textarea:focus{outline:2px solid var(--cyan-600,#0891b2);outline-offset:1px;border-color:transparent}',
      '.sae-q{border:1px solid var(--border,#e2e8f0);border-radius:14px;padding:14px 16px;margin-bottom:12px;background:var(--surface,#fff);box-shadow:0 2px 10px rgba(10,40,80,.04)}',
      '.sae-q-head{display:flex;align-items:center;gap:10px;margin-bottom:9px}',
      '.sae-num{width:26px;height:26px;flex:0 0 26px;border-radius:50%;background:var(--navy-950,#0a1930);color:#fff;font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center}',
      '.sae-q-head textarea{flex:1;min-height:44px;resize:vertical;border:1px solid var(--border,#e2e8f0);border-radius:10px;padding:9px 11px;font:inherit;font-size:13.5px;background:var(--bg,#fff)}',
      '.sae-tools{display:flex;gap:4px}',
      '.sae-ic{border:1px solid var(--border,#e2e8f0);background:var(--bg,#f8fafc);border-radius:8px;min-width:28px;height:28px;padding:0 6px;font-size:12px;font-weight:800;cursor:pointer;color:var(--text-600,#475569)}',
      '.sae-ic:hover{background:var(--border,#e2e8f0);color:var(--navy-950,#0a1930)}',
      '.sae-ic.del:hover{background:#fee2e2;border-color:#fca5a5;color:#b91c1c}',
      '.sae-opts{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-left:36px}',
      '.sae-opt{display:flex;align-items:center;gap:8px;border:1px solid var(--border,#e2e8f0);border-radius:10px;padding:6px 9px;background:var(--bg,#fff);transition:.14s}',
      '.sae-opt.right{border-color:#22c55e;background:#f0fdf4}',
      '.sae-opt input[type=radio]{accent-color:#16a34a;margin:0;cursor:pointer}',
      '.sae-opt span.k{font-size:11px;font-weight:900;color:var(--text-500,#64748b)}',
      '.sae-opt input[type=text]{flex:1;min-width:0;border:0;background:transparent;font:inherit;font-size:13px;color:var(--text-900,#0f172a)}',
      '.sae-opt input[type=text]:focus{outline:none}',
      '.sae-foot{display:flex;align-items:center;gap:10px;padding:14px 22px;border-top:1px solid var(--border,#e2e8f0);background:var(--surface-hover,#f8fafc);flex-wrap:wrap}',
      '.sae-btn{border:1px solid var(--border,#e2e8f0);background:var(--surface,#fff);color:var(--text-900,#0f172a);border-radius:10px;padding:9px 15px;font-size:13px;font-weight:800;cursor:pointer}',
      '.sae-btn.primary{background:var(--cyan-600,#0891b2);border-color:var(--cyan-700,#0e7490);color:#fff}',
      '.sae-btn.primary:hover{filter:brightness(1.06)}',
      '.sae-btn[disabled]{opacity:.55;cursor:progress}',
      '.sae-msg{flex:1;font-size:12.5px;font-weight:700;color:var(--text-600,#475569);min-width:180px}',
      '.sae-msg.err{color:#b91c1c}.sae-msg.ok{color:#15803d}',
      '.sae-hint{font-size:12px;color:var(--text-500,#64748b);margin:0 0 12px}',
      '.sae-empty{border:1px dashed var(--border,#cbd5e1);border-radius:14px;padding:26px;text-align:center;color:var(--text-600,#475569);font-size:13px;background:var(--bg,#f8fafc)}',
      '@media(max-width:720px){.sae-meta{grid-template-columns:1fr}.sae-opts{grid-template-columns:1fr;margin-left:0}}'
    ].join('');
    document.head.appendChild(st);
  }

  // ---------- markup ----------
  function template() {
    if ($('saeOverlay')) return;
    var d = document.createElement('div');
    d.className = 'sae-overlay'; d.id = 'saeOverlay'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true');
    d.innerHTML = '<div class="sae-dlg" id="saeDlg">' +
      '<div class="sae-head"><div><span class="sae-pill" id="saePill">Quiz</span><h2 id="saeTitle">Edit quiz</h2><p id="saeSub"></p></div>' +
      '<button type="button" class="sae-x" id="saeClose" aria-label="Close">&times;</button></div>' +
      '<div class="sae-body">' +
      '<p class="sae-hint">Students see these questions as the MCQ step of the course. They must reach the pass mark before the exercise unlocks. Save writes everything at once.</p>' +
      '<div class="sae-meta">' +
      '<div class="sae-f"><label for="saeName">Quiz title</label><input id="saeName" placeholder="e.g. Assembly Design check"></div>' +
      '<div class="sae-f"><label for="saePass">Pass mark %</label><input id="saePass" type="number" min="10" max="100" step="5" value="60"></div>' +
      '</div><div id="saeList"></div>' +
      '<button type="button" class="sae-btn" id="saeAdd">+ Add question</button>' +
      '</div>' +
      '<div class="sae-foot"><div class="sae-msg" id="saeMsg"></div>' +
      '<button type="button" class="sae-btn" id="saeCancel">Cancel</button>' +
      '<button type="button" class="sae-btn primary" id="saeSave">Save quiz</button></div>' +
      '</div>';
    document.body.appendChild(d);
    d.addEventListener('mousedown', function (e) { if (e.target === d) close(); });
    d.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); e.stopPropagation(); save(); }
    });
    $('saeClose').onclick = close; $('saeCancel').onclick = close;
    $('saeAdd').onclick = function () { current.questions.push(blank()); current.dirty = true; render(); msg('Unsaved changes', ''); focusLast(); };
    $('saeSave').onclick = save;
  }

  function focusCard(i) {
    var cards = document.querySelectorAll('#saeList .sae-q');
    var c = cards[Math.max(0, Math.min(i, cards.length - 1))];
    if (!c) return;
    var t = c.querySelector('textarea');
    if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
    if (typeof c.scrollIntoView === 'function') c.scrollIntoView({ block: 'center' });
  }
  function focusLast() {
    var cards = document.querySelectorAll('#saeList .sae-q');
    var last = cards[cards.length - 1];
    if (last) { var t = last.querySelector('textarea'); if (t) { t.focus(); if (typeof last.scrollIntoView === 'function') last.scrollIntoView({ block: 'center' }); } }
  }
  function msg(text, kind) { var m = $('saeMsg'); m.textContent = text || ''; m.className = 'sae-msg' + (kind ? ' ' + kind : ''); }
  function stopAutoClose() { if (autoClose) { clearTimeout(autoClose); autoClose = null; } }

  function render() {
    var list = $('saeList');
    var qs = current.questions;
    $('saeName').value = current.title;
    $('saePass').value = current.pass_pct;
    $('saePill').textContent = current.courseTitle || 'Quiz';
    $('saeTitle').textContent = current.title || 'Untitled quiz';
    $('saeSub').textContent = qs.length + ' question' + (qs.length === 1 ? '' : 's') + ' · pass mark ' + current.pass_pct + '%';
    if (!qs.length) {
      list.innerHTML = '<div class="sae-empty">No questions yet. Add the first one — a good check is 3 to 5 questions with one clearly correct answer.</div>';
      return;
    }
    list.innerHTML = qs.map(function (q, i) {
      var opts = ['A', 'B', 'C', 'D'].map(function (k) {
        var val = q['option_' + k.toLowerCase()] || '';
        var on = q.correct_option === k;
        return '<label class="sae-opt' + (on ? ' right' : '') + '"><input type="radio" name="cor' + i + '" data-i="' + i + '" data-k="' + k + '"' + (on ? ' checked' : '') + ' aria-label="Correct answer for question ' + (i + 1) + ' option ' + k + '">' +
          '<span class="k">' + k + '.</span><input type="text" data-i="' + i + '" data-f="option_' + k.toLowerCase() + '" value="' + esc(val) + '" placeholder="Option ' + k + '"></label>';
      }).join('');
      return '<div class="sae-q" data-i="' + i + '"><div class="sae-q-head"><span class="sae-num">' + (i + 1) + '</span>' +
        '<textarea data-i="' + i + '" data-f="question_text" placeholder="Question ' + (i + 1) + '…" rows="2">' + esc(q.question_text) + '</textarea>' +
        '<div class="sae-tools">' +
        '<button type="button" class="sae-ic" data-act="up" data-i="' + i + '" title="Move up">↑</button>' +
        '<button type="button" class="sae-ic" data-act="down" data-i="' + i + '" title="Move down">↓</button>' +
        '<button type="button" class="sae-ic" data-act="dup" data-i="' + i + '" title="Duplicate">⧉</button>' +
        '<button type="button" class="sae-ic del" data-act="del" data-i="' + i + '" title="Delete">✕</button>' +
        '</div></div><div class="sae-opts">' + opts + '</div></div>';
    }).join('');

    list.querySelectorAll('input[type=text],textarea').forEach(function (el) {
      el.addEventListener('input', function () {
        current.questions[+el.dataset.i][el.dataset.f] = el.value;
        current.dirty = true; msg('Unsaved changes', '');
      });
      // Enter walks the form instead of ending the edit: question → A → B → C → D → next question
      el.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' || e.shiftKey) return;
        e.preventDefault();
        var i = +el.dataset.i, card = list.querySelectorAll('.sae-q')[i];
        if (!card) return;
        var inputs = [...card.querySelectorAll('input[type=text]')];
        if (el.tagName === 'TEXTAREA') { if (inputs[0]) inputs[0].focus(); return; }
        var k = inputs.indexOf(el);
        if (k >= 0 && k < inputs.length - 1) { inputs[k + 1].focus(); return; }
        var next = list.querySelectorAll('.sae-q')[i + 1];
        if (next) { next.querySelector('textarea').focus(); }
        else { $('saeAdd').focus(); }
      });
    });
    list.querySelectorAll('input[type=radio]').forEach(function (el) {
      el.addEventListener('change', function () {
        var i = +el.dataset.i; current.questions[i].correct_option = el.dataset.k; current.dirty = true;
        var card = list.querySelectorAll('.sae-q')[i];
        card.querySelectorAll('.sae-opt').forEach(function (o, k) { o.classList.toggle('right', 'ABCD'[k] === el.dataset.k); });
        msg('Unsaved changes', '');
      });
    });
    list.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.onclick = function () {
        var i = +btn.dataset.i, a = btn.dataset.act, arr = current.questions;
        if (a === 'del') {
          if (String(arr[i].question_text || '').trim() && !confirm('Delete question ' + (i + 1) + '? It disappears from the quiz when you press Save.')) return;
          arr.splice(i, 1);
        }
        else if (a === 'dup') arr.splice(i + 1, 0, JSON.parse(JSON.stringify(arr[i])));
        else if (a === 'up' && i > 0) { var t = arr[i - 1]; arr[i - 1] = arr[i]; arr[i] = t; }
        else if (a === 'down' && i < arr.length - 1) { var u = arr[i + 1]; arr[i + 1] = arr[i]; arr[i] = u; }
        current.dirty = true; render();
      };
    });
  }

  function validate() {
    var qs = current.questions;
    if (!$('saeName').value.trim()) return 'Give the quiz a title.';
    if (!qs.length) return 'Add at least one question, or delete the quiz from the list on the left.';
    for (var i = 0; i < qs.length; i++) {
      var q = qs[i];
      if (!String(q.question_text).trim()) return 'Question ' + (i + 1) + ' has no text.';
      var filled = ['a', 'b', 'c', 'd'].filter(function (k) { return String(q['option_' + k] || '').trim(); });
      if (filled.length < 2) return 'Question ' + (i + 1) + ' needs at least two answer options.';
      if (!q.correct_option || !String(q['option_' + q.correct_option.toLowerCase()] || '').trim())
        return 'Question ' + (i + 1) + ': mark which option is correct (the green one).';
    }
    return '';
  }

  async function save() {
    if (!current) return;
    var err = validate();
    if (err) { msg(err, 'err'); return; }
    var payload = {
      title: $('saeName').value.trim(),
      pass_pct: Math.max(1, Math.min(100, parseInt($('saePass').value, 10) || 60)),
      questions: current.questions
    };
    var btn = $('saeSave'); btn.disabled = true; msg('Saving…', '');
    try {
      var res = await fetch(API + '/quizzes/' + encodeURIComponent(current.quizId) + '/assessment', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      if (!res.ok) {
        var e = await res.json().catch(function () { return {}; });
        throw new Error(e.error || ('server answered ' + res.status));
      }
      var out = await res.json().catch(function () { return {}; });
      current.questions = (out.questions || []).map(function (x) {
        return { id: x.id, question_text: x.question_text, option_a: x.option_a, option_b: x.option_b, option_c: x.option_c, option_d: x.option_d, correct_option: x.correct_option };
      });
      current.title = payload.title;
      current.pass_pct = payload.pass_pct;
      current.dirty = false;
      msg('Saved — ' + current.questions.length + ' question' + (current.questions.length === 1 ? '' : 's') + ', pass mark ' + payload.pass_pct + '%.', 'ok');
      render(); emit();
      var opened = current;
      stopAutoClose();
      autoClose = setTimeout(function () { if (current === opened && !current.dirty) close(); autoClose = null; }, 900);
    } catch (e2) {
      msg('Could not save: ' + e2.message, 'err');
    } finally { btn.disabled = false; }
  }

  function close() {
    if (current && current.dirty && !confirm('You have unsaved question changes. Close anyway?')) return;
    stopAutoClose();
    var ov = $('saeOverlay'); if (ov) ov.classList.remove('on');
    document.body.classList.remove('sae-lock');
    current = null;
  }

  async function open(opts) {
    css(); template(); stopAutoClose();
    var quizId = Number(opts && opts.quizId);
    if (!quizId) { alert('Pick a quiz in the list first.'); return; }
    current = {
      quizId: quizId,
      courseTitle: (opts && opts.courseTitle) || '',
      title: (opts && opts.quizTitle) || '',
      pass_pct: opts && opts.passPct != null && opts.passPct !== '' ? +opts.passPct : 60,
      questions: [], dirty: false, loading: true
    };
    $('saeOverlay').classList.add('on');
    $('saeList').innerHTML = ''; msg('Loading questions…', '');
    render();
    try {
      var res = await fetch(API + '/quizzes/' + encodeURIComponent(quizId));
      if (!res.ok) throw new Error('server answered ' + res.status);
      var d = await res.json();
      current.title = (d && d.title) || current.title;
      if (d && d.pass_pct != null && d.pass_pct !== '') current.pass_pct = +d.pass_pct;
      current.questions = ((d && d.questions) || []).map(function (x) {
        return { id: x.id, question_text: x.question_text, option_a: x.option_a, option_b: x.option_b, option_c: x.option_c, option_d: x.option_d, correct_option: x.correct_option };
      });
    } catch (e) {
      msg('Could not load this quiz: ' + e.message, 'err');
    }
    current.loading = false;
    var wantAdd = !!opts.addBlank;
    if (!current.questions.length) { current.questions = [blank()]; wantAdd = false; }
    current.dirty = wantAdd;
    msg(wantAdd ? 'New question — press Save quiz when you are done.' : '', '');
    render();
    if (wantAdd) {
      current.questions.push(blank());
      render();
      focusCard(current.questions.length - 1);
    } else if (opts.focusQuestionId != null) {
      var at = -1;
      current.questions.forEach(function (q, i) { if (Number(q.id) === Number(opts.focusQuestionId)) at = i; });
      if (at >= 0) { focusCard(at); msg('Editing question ' + (at + 1) + ' of ' + current.questions.length + ' — press Save quiz to keep the change.', ''); }
      else { var t0 = $('saeList').querySelector('textarea'); if (t0) t0.focus(); }
    } else {
      var t = $('saeList').querySelector('textarea'); if (t) t.focus();
    }
  }

  window.SoftmarcAssessments = {
    open: open, close: close, save: save,
    get state() { return current ? { open: true, quizId: current.quizId, title: current.title, pass_pct: current.pass_pct, questions: current.questions, dirty: current.dirty } : { open: false }; }
  };
})();
