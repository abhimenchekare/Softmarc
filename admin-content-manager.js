(function(){
  if(!window.SoftmarcContent) return;

  const API_HOST = '/api';
  const $ = id => document.getElementById(id);
  const esc = s => String(s||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const getCourses = () => SoftmarcContent.getCourses();
  let selectedCourseId = null;
  let creatingNewCourse = false;
  let selectedSubtopicId = null;
  let activeContentTab = 'topics';

  async function dbCreateCourse(fields){
    const res = await fetch(`${API_HOST}/courses`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(fields)
    });
    if(!res.ok) throw new Error((await res.json()).error || 'Failed');
    return res.json();
  }

  async function dbUpdateCourse(id, fields){
    const res = await fetch(`${API_HOST}/courses/${id}`, {
      method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(fields)
    });
    if(!res.ok) throw new Error((await res.json()).error || 'Failed');
    return res.json();
  }

  async function dbDeleteCourse(id){
    const res = await fetch(`${API_HOST}/courses/${id}`, { method:'DELETE' });
    if(!res.ok) throw new Error('Failed');
    return res.json();
  }

  async function dbCreateSubtopic(courseId, fields){
    const res = await fetch(`${API_HOST}/courses/${courseId}/subtopics`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(fields)
    });
    if(!res.ok) throw new Error((await res.json()).error || 'Failed');
    return res.json();
  }

  async function dbUpdateSubtopic(id, fields){
    const res = await fetch(`${API_HOST}/subtopics/${id}`, {
      method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(fields)
    });
    if(!res.ok) throw new Error((await res.json()).error || 'Failed');
    return res.json();
  }

  async function dbDeleteSubtopic(id){
    const res = await fetch(`${API_HOST}/subtopics/${id}`, { method:'DELETE' });
    if(!res.ok) throw new Error('Failed');
    return res.json();
  }

  async function dbAddPlaylistResource(subtopicId, fields){
    const res=await fetch(`${API_HOST}/subtopics/${subtopicId}/resources`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(fields)});
    if(!res.ok) throw new Error((await res.json()).error||'Could not add material');
    return res.json();
  }
  async function dbDeletePlaylistResource(id){
    const res=await fetch(`${API_HOST}/subtopic-resources/${id}`,{method:'DELETE'});
    if(!res.ok) throw new Error((await res.json()).error||'Could not remove material');
    return res.json();
  }

  // Upload a file to the server (videos/ or pdfs/ or images/). Returns saved path.
  async function uploadFile(kind, file){
    const fd = new FormData();
    fd.append('type', kind);
    fd.append('file', file);
    const res = await fetch(`${API_HOST}/upload`, { method:'POST', body: fd });
    if(!res.ok){
      let msg = 'Upload failed ('+res.status+')';
      try{ const e = await res.json(); if(e && e.error) msg = e.error; }catch(_){ }
      throw new Error(msg);
    }
    const data = await res.json();
    return data.path; // relative, e.g. videos/1710000_name.mp4
  }

  // Upload state: kind -> Promise while in flight. Prevents the
  // "clicked Save while still uploading -> everything disappears" race.
  const uploading = {};

  function startUpload(kind, urlInputId){
    return e => {
      const f = e.target.files[0];
      if(!f) return;
      // Capture the destination now. Uploading a large file can take minutes; saving it into the
      // subtopic the admin happens to click later would be much worse than refusing the upload.
      const target = (kind==='video' || kind==='pdf') ? selectedResourceSubtopic(selectedCourse()) : null;
      if((kind==='video' || kind==='pdf') && (!target || !target._database_id)){
        showError('Choose and save a final subtopic page before uploading a '+kind+'.');
        e.target.value=''; return;
      }
      const mb = Math.round((f.size/1048576)*10)/10;
      const pr = (async()=>{
        try{
          setStatus('Uploading '+kind+' ('+mb+' MB)\u2026 keep this page open until it finishes\u2026','info');
          const p = await uploadFile(kind, f);
          const inp = $(urlInputId); if(inp) inp.value = p;
          if(kind==='image'){ const pv=$('cmPreview'); if(pv) pv.style.backgroundImage='url("'+p+'")'; }
          if(kind==='video' || kind==='pdf'){
            // forcedVal is deliberate: this is the upload itself finishing, so it must pass the
            // "don't save while an upload is running" guard below. The captured target makes it
            // impossible for a delayed upload to land on a different subtopic.
            await saveResources(kind, p, target);
          } else {
            showStatus('✅ Image uploaded — press "Save to Database" to apply it');
          }
        }catch(err){
          showError(kind[0].toUpperCase()+kind.slice(1)+' upload failed: '+err.message);
        }finally{
          delete uploading[kind];
          e.target.value='';
        }
      })();
      uploading[kind] = pr;
    };
  }

  let databaseCourses = [];
  async function loadDatabaseCourses(){
    try{
      const res = await fetch(`${API_HOST}/courses`);
      if(res.ok) databaseCourses = await res.json();
    }catch(e){
      console.warn('Could not load from Database');
      databaseCourses = [];
    }
  }

  function getCoursesForAdmin(){
    if(databaseCourses.length > 0) return databaseCourses.map(c => ({
      id: c.slug || SoftmarcContent.slug(c.title),
      _database_id: c.id,
      title: c.title,
      slug: c.slug,
      tag: c.tag || 'Course',
      short_description: c.short_description || '',
      description: c.description || '',
      duration_hours: c.duration_hours || 10,
      level: c.level || 'Beginner',
      image: c.image || SoftmarcContent.defaultImage(c.title, c.tag),
      status: c.status || 'active',
      display_order: c.display_order || 0,
      subtopics: (c.subtopics||[]).map(s => ({
        id: s.slug || SoftmarcContent.slug(s.title),
        _database_id: s.id,
        parentSubtopicId: s.parent_subtopic_id==null?null:Number(s.parent_subtopic_id),
        title: s.title,
        dur: s.dur || '15 min',
        description: s.description || '',
        videoUrl: s.video_url || '',
        pdfUrl: s.pdf_url || '',
        resources: Array.isArray(s.resources)?s.resources.map(r=>({id:r.id,title:r.title||'',resource_type:r.resource_type||'',file_url:r.file_url||'',display_order:r.display_order||0})):[],
        exercise: s.exercise || ''
      }))
    }));
    return getCourses();
  }

  function saveCourses(c, msg){
    SoftmarcContent.saveCourses(c);
    renderAll();
    showStatus(msg || 'Saved locally.');
  }

  let selectedCourseDatabaseId = null;
  let selectedSubtopicDatabaseId = null;
  // A tree-page selection is independent from the materials picker, so editing a folder never
  // silently switches the editor to one of its final lesson pages.
  let selectedResourceSubtopicId = null;
  let subtopicEditorMode = 'add';
  // The parent used by the next “Add inner subtopic” action. Any page can be a parent.
  let subtopicParentDraftDatabaseId = null;

  function selectedCourse(){
    if(creatingNewCourse) return null;
    const cs=getCoursesForAdmin();
    if(!selectedCourseId && cs[0]) { selectedCourseId=cs[0].id; selectedCourseDatabaseId=cs[0]._database_id; }
    const c = cs.find(c=>c.id===selectedCourseId) || cs[0] || null;
    if(c) selectedCourseDatabaseId = c._database_id;
    return c;
  }

  function selectedSubtopic(){
    const c=selectedCourse();
    if(!c) return null;
    if(!selectedSubtopicId && c.subtopics && c.subtopics[0]) { selectedSubtopicId=c.subtopics[0].id; selectedSubtopicDatabaseId=c.subtopics[0]._database_id; }
    const s = (c.subtopics||[]).find(s=>s.id===selectedSubtopicId) || (c.subtopics||[])[0] || null;
    if(s) selectedSubtopicDatabaseId = s._database_id;
    return s;
  }

  const SVG = inner => '<svg class="cm-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+inner+'</svg>';
  const ICO = {
    add:   SVG('<path d="M12 5v14M5 12h14"/>'),
    save:  SVG('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>'),
    del:   SVG('<path d="M3 6h18M8 6V4h8v2M18 6l-1 14H7L6 6"/><path d="M10 11v6M14 11v6"/>'),
    sync:  SVG('<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>'),
    video: SVG('<path d="m22 8-5 4 5 4V8z"/><rect x="2" y="6" width="14" height="12" rx="2"/>'),
    doc:   SVG('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'),
    ex:    SVG('<path d="M14.7 6.3a5 5 0 1 0-4.4 4.4L4 17v3h3l6.3-6.3a5 5 0 0 0 1.4-7.4z"/>'),
    edit:  SVG('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
    check: SVG('<path d="M20 6 9 17l-5-5"/>')
  };
  // every status line is colour-coded by what it says, so the admin never has to read twice to
  // know whether the button they pressed actually did something
  function classify(msg){
    const m=String(msg||''); if(!m) return '';
    if(/fail|error|not there|could not|required|first|⚠/i.test(m)) return 'err';
    if(/\u2705|saved|added|updated|deleted|refreshed|reachable|synced/i.test(m)) return 'ok';
    return 'info';
  }
  function setStatus(msg, kind){
    const el=$('cmStatus'); if(!el) return;
    el.textContent = msg||''; el.dataset.kind = kind || classify(msg);
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  }
  function showStatus(msg){ setStatus(msg); }
  // a button that is doing work must look like it is doing work — otherwise the admin presses it
  // twice, and a long upload looks exactly like a dead page
  function guard(fn){
    const ids=[].slice.call(arguments,1);
    return async function(){
      const btns=ids.map($).filter(Boolean), orig=btns.map(b=>b.innerHTML);
      btns.forEach(b=>{ b.disabled=true; b.classList.remove('was-ok','was-err'); b.innerHTML='<span class="cm-spin" aria-hidden="true"></span>'+(btns.length>1?'Working\u2026':'Saving\u2026'); });
      try{ await fn.apply(this, arguments); }
      catch(e){ setStatus('Something went wrong: '+(e&&e.message?e.message:e),'err'); }
      finally{
        // these panels are re-rendered by the save itself, so the buttons we grabbed may be gone:
        // look them up by id again before deciding what to flash
        btns.forEach((b,i)=>{ try{ if(b.isConnected){ b.innerHTML=orig[i]; b.disabled=false; } }catch(e){} });
        const kind=($('cmStatus')&&$('cmStatus').dataset.kind)||'';
        const live=ids.map($).filter(Boolean);
        live.forEach(b=>{ b.disabled=false; if(kind) b.classList.add(kind==='err'?'was-err':'was-ok'); });
        setTimeout(()=>ids.map($).filter(Boolean).forEach(b=>b.classList.remove('was-ok','was-err')),1100);
      }
    };
  }
  function note(msg, kind){ setStatus(msg, kind); const el=$('cmStatus'); try{ if(el && el.scrollIntoView) el.scrollIntoView({block:'nearest'}); }catch(e){} return false; }
  async function checkDocReach(u){
    const url=String(u||'').trim(); if(!url) return;
    const ext=(url.split('?')[0].match(/\.([a-z0-9]+)$/i)||[])[1]||'';
    const hint=/^(ppt|pps|pot)$/i.test(ext) ? '  This old PowerPoint format is not used in the lesson screen. Save it as .pptx and upload that file.' : '';
    try{
      const r=await fetch(url,{method:'HEAD'});
      if(r.ok){
        const mb=r.headers&&r.headers.get&&r.headers.get('content-length');
        const size=mb?(' ('+Math.round((+mb)/1024/102.4)/10+' MB)'):'';
        const big=mb&&(+mb)>100*1024*1024;
        showStatus(big ? '⚠️ Saved, but the file is '+Math.round(+mb/1048576)+' MB — viewers give up above ~100 MB.'+hint
                       : '✅ File is reachable at that path'+size+'. Learners will see it.'+hint);
      } else {
        showStatus('⚠️ Saved, but the server answered '+r.status+' for '+url+' — the file is not there. Upload it again or fix the path.'+hint);
      }
    }catch(e){ showStatus('⚠️ Saved, but that path could not be read from this browser — check it opens at '+url+hint); }
  }
  function showError(msg){ setStatus(msg, 'err'); }

  function injectStyle(){
    if($('cmStyle')) return;
    const st=document.createElement('style'); st.id='cmStyle';
    st.textContent=[
    /* ---- shell ---- */
    '.content-manager{margin:0 28px 28px}',
    '.cm-shell{background:var(--surface);border:1px solid var(--border);border-radius:18px;box-shadow:var(--shadow-sm);overflow:hidden}',
    '.cm-top{padding:18px 22px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;background:linear-gradient(180deg,var(--surface),var(--surface-hover))}',
    '.cm-top h2{font-family:var(--font-display);font-size:18px;margin:0;display:flex;align-items:center;gap:8px}',
    '.cm-top p{font-size:12.5px;color:var(--text-500);margin:5px 0 0;max-width:62ch;line-height:1.5}',
    /* ---- tabs ---- */
    '.cm-tabs{display:flex;gap:6px;padding:10px 16px;border-bottom:1px solid var(--border);background:var(--surface-hover);flex-wrap:wrap}',
    '.cm-tab{display:inline-flex;align-items:center;gap:7px;border:1px solid transparent;background:transparent;color:var(--text-600);border-radius:10px;padding:9px 14px;font:800 12.5px var(--font-body);cursor:pointer;transition:background .16s,color .16s,box-shadow .16s}',
    '.cm-tab:hover{background:var(--surface);color:var(--text-900)}',
    '.cm-tab.active{background:#0A1930;color:#fff;border-color:#0A1930;box-shadow:0 6px 16px -8px rgba(10,25,48,.7)}',
    '.cm-tab:focus-visible{outline:3px solid rgba(37,99,235,.35);outline-offset:2px}',
    '.cm-panel{display:none;padding:20px}.cm-panel.active{display:block;animation:cmFade .22s ease}',
    '@keyframes cmFade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}',
    '.cm-grid{display:grid;grid-template-columns:minmax(400px,470px) minmax(0,1fr);gap:18px;align-items:start}',
    /* ---- cards + fields ---- */
    '.cm-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px;box-shadow:0 1px 2px rgba(10,40,80,.04)}',
    '.cm-card h3{font-family:var(--font-display);font-size:15px;margin:0 0 14px;display:flex;align-items:center;gap:8px}',
    '.cm-card h3::before{content:"";width:3px;height:15px;border-radius:2px;background:#0A1930}',
    '.cm-field{margin-bottom:13px}',
    '.cm-field label{display:block;font-size:11px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;color:var(--text-500);margin-bottom:6px}',
    '.cm-field input,.cm-field textarea,.cm-field select{width:100%;border:1px solid var(--border);background:var(--surface-hover);border-radius:10px;padding:10px 12px;color:var(--text-900);font:500 13px var(--font-body);transition:border-color .16s,box-shadow .16s,background .16s}',
    '.cm-field textarea{min-height:86px;resize:vertical;line-height:1.5}',
    '.cm-field input:focus-visible,.cm-field textarea:focus-visible,.cm-field select:focus-visible{outline:none;border-color:#2563EB;background:var(--surface);box-shadow:0 0 0 3px rgba(37,99,235,.16)}',
    '.cm-field input[type=file]{padding:8px;font-size:12px;cursor:pointer;border-style:dashed}',
    '.cm-field input[type=file]::file-selector-button{border:1px solid var(--border);background:var(--surface);color:var(--text-900);border-radius:8px;padding:6px 10px;margin-right:10px;font:800 11.5px var(--font-body);cursor:pointer}',
    '.cm-field input[type=file]::file-selector-button:hover{border-color:#0A1930}',
    '.cm-two{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
    /* ---- buttons ---- */
    '.cm-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:14px;padding-top:14px;border-top:1px dashed var(--border)}',
    '.cm-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--border);background:var(--surface);border-radius:10px;padding:10px 15px;font:800 12.5px var(--font-body);letter-spacing:.01em;color:var(--text-700);cursor:pointer;white-space:nowrap;transition:transform .12s,box-shadow .18s,background .18s,border-color .18s,color .18s}',
    '.cm-btn:hover{transform:translateY(-1px);border-color:#0A1930;color:#0A1930;box-shadow:0 8px 18px -12px rgba(10,25,48,.6)}',
    '.cm-btn:active{transform:translateY(0) scale(.985)}',
    '.cm-btn:focus-visible{outline:3px solid rgba(37,99,235,.35);outline-offset:2px}',
    '.cm-btn[disabled]{opacity:.6;cursor:progress;transform:none;box-shadow:none}',
    '.cm-btn.primary{background:linear-gradient(180deg,#14304f,#0A1930);color:#fff;border-color:#0A1930;box-shadow:0 1px 0 rgba(255,255,255,.14) inset,0 8px 18px -12px rgba(10,25,48,.9)}',
    '.cm-btn.primary:hover{background:linear-gradient(180deg,#1a3c63,#0d2143);color:#fff;border-color:#0d2143}',
    '.cm-btn.danger{color:#B91C1C;border-color:#FECACA;background:#fff}',
    '.cm-btn.danger:hover{background:#FEF2F2;border-color:#DC2626;color:#B91C1C}',
    '.cm-btn.ghost{background:transparent;border-color:transparent;color:var(--text-600);padding:9px 11px}',
    '.cm-btn.ghost:hover{background:var(--surface-hover);border-color:var(--border);color:var(--text-900)}',
    '.cm-ico{width:15px;height:15px;flex:0 0 15px}',
    '.cm-spin{width:13px;height:13px;flex:0 0 13px;border-radius:50%;border:2px solid currentColor;border-top-color:transparent;animation:cmSpin .7s linear infinite;display:inline-block}',
    '@keyframes cmSpin{to{transform:rotate(360deg)}}',
    '.cm-btn.was-ok{animation:cmOk .95s ease}',
    '.cm-btn.was-err{animation:cmErr .95s ease}',
    '@keyframes cmOk{0%{box-shadow:0 0 0 0 rgba(22,163,74,.55)}100%{box-shadow:0 0 0 11px rgba(22,163,74,0)}}',
    '@keyframes cmErr{0%,60%{box-shadow:0 0 0 0 rgba(220,38,38,.5)}100%{box-shadow:0 0 0 11px rgba(220,38,38,0)}}',
    /* ---- lists ---- */
    '.cm-list{display:flex;flex-direction:column;gap:8px;max-height:560px;overflow:auto;padding:2px;margin:-2px}',
    '.cm-topic-tree{gap:7px;max-height:620px;padding:3px}.cm-outline-row{--depth:0;position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;margin-left:calc(var(--depth) * 13px);padding:10px 10px 10px 12px;border:1px solid var(--border);border-radius:11px;background:var(--surface);box-shadow:0 1px 0 rgba(15,23,42,.02);transition:border-color .15s,box-shadow .15s,background .15s}.cm-outline-row::before{content:"";position:absolute;left:-7px;top:50%;width:6px;border-top:1px solid var(--border)}.cm-outline-row[data-depth="0"]::before{display:none}.cm-outline-row:hover{border-color:#9AAAC0}.cm-outline-row.active{border-color:#0A1930;background:linear-gradient(90deg,#F5F8FC,#FFF);box-shadow:0 0 0 1px #0A1930 inset,0 8px 18px -17px rgba(10,25,48,.9)}.cm-outline-select{display:grid;grid-template-columns:auto minmax(0,1fr);column-gap:8px;row-gap:3px;min-width:0;border:0;background:transparent;text-align:left;color:var(--text-700);padding:0;cursor:pointer}.cm-outline-index{align-self:start;font:900 10px var(--font-mono);line-height:1;color:#52657F;padding:5px 6px;border-radius:6px;background:#F4F7FA;border:1px solid #DCE4EE;white-space:nowrap}.cm-outline-copy{min-width:0}.cm-outline-copy b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;line-height:1.35;color:var(--text-900)}.cm-outline-copy small{display:flex;gap:5px;align-items:center;margin-top:3px;color:var(--text-500);font-size:10.5px;line-height:1.35}.cm-outline-kind{font:900 9px var(--font-body);letter-spacing:.04em;text-transform:uppercase;color:#0F766E;background:#ECFDF5;border:1px solid #BBF7D0;border-radius:999px;padding:2px 5px}.cm-outline-kind.folder{color:#1D4ED8;background:#EFF6FF;border-color:#BFDBFE}.cm-outline-actions{display:flex;align-items:center;gap:5px}.cm-outline-actions button{border:1px solid var(--border);border-radius:7px;background:var(--surface-hover);color:var(--text-700);font:800 10.5px var(--font-body);padding:6px 7px;white-space:nowrap;cursor:pointer}.cm-outline-actions button:hover{border-color:#0A1930;background:#F1F5F9;color:#0A1930}.cm-outline-actions .cm-outline-child{background:#0A1930;border-color:#0A1930;color:#fff}.cm-outline-actions .cm-outline-child:hover{background:#15385D;color:#fff}.cm-edit-summary{display:flex;align-items:center;gap:8px;padding:10px 12px;margin:0 0 13px;border:1px solid #BFDBFE;border-radius:10px;background:#F8FBFF;color:#1E3A5F;font-size:12px;line-height:1.4}.cm-edit-summary b{color:#0A1930}.cm-edit-summary .cm-outline-kind{margin-left:auto}.cm-form-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:13px}.cm-form-heading h3{margin:0}.cm-form-heading .cm-btn{padding:7px 10px;font-size:11px}',
    '.cm-item{border:1px solid var(--border);border-radius:12px;padding:11px 12px;background:var(--surface);display:flex;gap:11px;align-items:flex-start;cursor:pointer;transition:border-color .15s,box-shadow .15s,transform .12s}',
    '.cm-item:hover{border-color:#0A1930;transform:translateY(-1px);box-shadow:0 8px 18px -14px rgba(10,25,48,.8)}',
    '.cm-item:focus-visible{outline:3px solid rgba(37,99,235,.35);outline-offset:2px}',
    '.cm-item.active{border-color:#0A1930;background:#F7F9FC;box-shadow:0 0 0 1px #0A1930 inset}',
    '.cm-item strong{display:block;font-size:13px;line-height:1.35;color:var(--text-900)}',
    '.cm-item span{display:block;font-size:11.5px;color:var(--text-500);margin-top:3px;line-height:1.45}',
    '.cm-num{width:30px;height:30px;flex:0 0 30px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:var(--surface-hover);border:1px solid var(--border);font:900 12px var(--font-body);color:var(--text-600)}',
    '.cm-item.active .cm-num{background:#0A1930;border-color:#0A1930;color:#fff}',
    '.cm-thumb{width:72px;height:50px;border-radius:9px;background-size:cover;background-position:center;flex:0 0 72px;background-color:var(--border);border:1px solid var(--border)}',
    '.cm-chips{display:flex;gap:5px;margin-top:6px;flex-wrap:wrap}',
    '.cm-chip{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:800;padding:3px 8px;border-radius:999px;border:1px solid var(--border);color:var(--text-500);background:var(--surface-hover)}',
    '.cm-chip svg{width:11px;height:11px}',
    '.cm-chip.on{border-color:#BBF7D0;background:#F0FDF4;color:#166534}',
    '.cm-chip.off{border-style:dashed;border-color:#FCD9A8;background:#FFFBEB;color:#92400E}',
    /* ---- toolbar, previews, status ---- */
    '.cm-quickbar{position:sticky;top:0;z-index:3;display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 16px;padding:12px 14px;border:1px solid var(--border);border-radius:12px;background:var(--surface-hover);box-shadow:0 1px 0 var(--border)}',
    '.cm-preview{height:150px;border-radius:12px;background-size:cover;background-position:center;border:1px solid var(--border);margin-bottom:14px;background-color:var(--surface-hover)}',
    '.cm-help,.cm-note{font-size:11.5px;color:var(--text-500);line-height:1.5}',
    '.cm-help{margin:10px 0 0;padding-top:10px;border-top:1px dashed var(--border)}',
    '.cm-status{display:inline-flex;align-items:center;gap:8px;min-height:34px;padding:8px 13px;border-radius:999px;border:1px solid var(--border);background:var(--surface-hover);color:var(--text-600);font:700 12px var(--font-body);max-width:52ch;line-height:1.4}',
    '.cm-status:empty{display:none}',
    '.cm-status[data-kind="ok"]{border-color:#BBF7D0;background:#F0FDF4;color:#166534}',
    '.cm-status[data-kind="err"]{border-color:#FECACA;background:#FEF2F2;color:#991B1B}',
    '.cm-status.pop{animation:cmPop .3s ease}',
    '@keyframes cmPop{from{transform:translateY(-3px);opacity:.55}to{transform:none;opacity:1}}',
    '.cm-upload-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
    '.cm-resource-preview{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px}',
    '.cm-resource-box{border:1px solid var(--border);border-radius:12px;background:var(--surface-hover);padding:12px 13px;display:flex;flex-direction:column;gap:6px}',
    '.cm-resource-box.set{border-color:#BBF7D0;background:#F7FEF9}',
    '.cm-resource-box.missing{border-style:dashed;border-color:#FCD9A8;background:#FFFCF5}',
    '.cm-resource-box b{display:flex;align-items:center;gap:6px;font-size:11px;letter-spacing:.03em;text-transform:uppercase;color:var(--text-500);margin:0}',
    '.cm-resource-box b svg{width:13px;height:13px}',
    '.cm-resource-box span{font-size:11.5px;color:var(--text-700);word-break:break-word;line-height:1.45}',
    '.cm-resource-box span strong,.cm-resource-box span small{display:block}.cm-resource-box span strong{font-size:12px;color:var(--text-900)}.cm-resource-box span small{margin-top:2px;color:var(--text-500)}',
    '.cm-resource-preview.cm-playlist{grid-template-columns:1fr;gap:8px}.cm-playlist .cm-resource-box{display:grid;grid-template-columns:125px minmax(0,1fr) auto;align-items:center;gap:12px;padding:10px 12px}.cm-playlist .cm-resource-box em{font-style:normal}.cm-resource-delete{padding:7px 10px;font-size:11px}',
    '.cm-db-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;font-size:10.5px;font-weight:800;background:#DCFCE7;color:#166534;border:1px solid #BBF7D0}',
    '.cm-db-badge.error{background:#FEF2F2;color:#991B1B;border-color:#FECACA}',
    /* ---- dark ---- */
    'html[data-theme="dark"] .cm-tab.active,body[data-theme="dark"] .cm-tab.active{background:#fff;color:#0A1930;border-color:#fff}',
    'html[data-theme="dark"] .cm-btn.primary,body[data-theme="dark"] .cm-btn.primary{background:#fff;color:#0A1930;border-color:#fff}',
    'html[data-theme="dark"] .cm-btn.primary:hover,body[data-theme="dark"] .cm-btn.primary:hover{background:#e8eefc;color:#0A1930}',
    'html[data-theme="dark"] .cm-item.active,html[data-theme="dark"] .cm-quickbar{background:#0f2039}',
    'html[data-theme="dark"] .cm-outline-row{background:#101D32}html[data-theme="dark"] .cm-outline-row.active{background:linear-gradient(90deg,#102846,#101D32);border-color:#60A5FA}html[data-theme="dark"] .cm-outline-index{background:#172A45;border-color:#294566;color:#B8C8DE}html[data-theme="dark"] .cm-outline-actions button{background:#172A45;border-color:#294566;color:#D7E1EF}html[data-theme="dark"] .cm-outline-actions .cm-outline-child{background:#EAF2FF;border-color:#EAF2FF;color:#0A1930}html[data-theme="dark"] .cm-edit-summary{background:#0E263F;border-color:#275681;color:#C8DCF5}html[data-theme="dark"] .cm-edit-summary b{color:#F1F5F9}',
    'html[data-theme="dark"] .cm-resource-box.set{background:#0c1f16;border-color:#166534}',
    'html[data-theme="dark"] .cm-resource-box.missing,html[data-theme="dark"] .cm-chip.off{background:#201a0c;border-color:#92400E}',
    'html[data-theme="dark"] .cm-status[data-kind="ok"]{background:#0c1f16;color:#86efac;border-color:#166534}',
    'html[data-theme="dark"] .cm-status[data-kind="err"]{background:#240f12;color:#fca5a5;border-color:#7f1d1d}',
    /* ---- small screens ---- */
    '@media(max-width:1000px){.cm-grid{grid-template-columns:1fr}.content-manager{margin:0 20px 20px}.cm-resource-preview{grid-template-columns:1fr}.cm-quickbar{position:static}}',
    '@media(max-width:560px){.cm-two{grid-template-columns:1fr}.cm-playlist .cm-resource-box{grid-template-columns:1fr;gap:6px}.cm-playlist .cm-resource-delete{justify-self:start}.cm-outline-row{margin-left:calc(var(--depth) * 7px);padding:9px}.cm-outline-actions{gap:3px}.cm-outline-actions button{padding:6px}.cm-outline-actions .cm-outline-edit{font-size:0}.cm-outline-actions .cm-outline-edit svg{width:14px;height:14px;display:block}.cm-edit-summary{align-items:flex-start;flex-wrap:wrap}.cm-edit-summary .cm-outline-kind{margin-left:0}}',
    '@media (prefers-reduced-motion: reduce){.cm-shell *{animation:none!important;transition:none!important}}'
    ].join('');
    document.head.appendChild(st);
  }

  function build(){
    injectStyle();
    const tabs=document.querySelector('.tabs');
    if(tabs && !$('tabBtnContent')){
      const btn=document.createElement('button');
      btn.className='tab'; btn.id='tabBtnContent'; btn.textContent='Course Manager';
      btn.onclick=()=>window.switchAdminTab('content');
      tabs.appendChild(btn);
    }
    const main=document.querySelector('main.main')||document.body;
    if($('secContent')) return;
    const sec=document.createElement('div'); sec.className='section-wrapper content-manager'; sec.id='secContent';
    sec.innerHTML='<div class="cm-shell"><div class="cm-top"><div><h2>Course Manager <span class="cm-db-badge" id="cmDatabaseBadge">Database Sync</span></h2><p>Create a course, then build unlimited nested subtopic pages. Add videos, PDF/PPTX, MCQ and exercises only on the final subtopic page. Changes sync to Database for every student.</p></div><div class="cm-status" id="cmStatus"></div></div><div class="cm-tabs" role="tablist"><button class="cm-tab active" data-cm-tab="topics">Main Topics / Courses</button><button class="cm-tab" data-cm-tab="subtopics">Subtopic Pages</button><button class="cm-tab" data-cm-tab="resources">Final-page Materials</button></div><section class="cm-panel active" id="cmPanelTopics"></section><section class="cm-panel" id="cmPanelSubtopics"></section><section class="cm-panel" id="cmPanelResources"></section></div>';
    main.appendChild(sec);
    sec.querySelectorAll('.cm-tab').forEach(b=>b.onclick=()=>setContentTab(b.dataset.cmTab));
  }

  function setContentTab(tab){
    activeContentTab=tab;
    document.querySelectorAll('.cm-tab').forEach(b=>b.classList.toggle('active',b.dataset.cmTab===tab));
    $('cmPanelTopics').classList.toggle('active',tab==='topics');
    $('cmPanelSubtopics').classList.toggle('active',tab==='subtopics');
    $('cmPanelResources').classList.toggle('active',tab==='resources');
    renderAll();
  }

  async function renderAll(){
    await loadDatabaseCourses();
    renderTopics(); renderSubtopics(); renderResources();
    const badge = $('cmDatabaseBadge');
    if(badge){
      if(databaseCourses.length > 0){
        badge.textContent = 'Database Synced ('+databaseCourses.length+' courses)';
        badge.className = 'cm-db-badge';
      } else {
        badge.textContent = 'No courses yet';
        badge.className = 'cm-db-badge error';
      }
    }
  }

  function courseOptions(){
    return getCoursesForAdmin().map(c=>'<option value="'+esc(c.id)+'" '+(c.id===selectedCourseId?'selected':'')+'>'+esc(c.title)+'</option>').join('');
  }
  function mainSubtopics(c){return (c?.subtopics||[]).filter(s=>s.parentSubtopicId==null);}
  function childSubtopics(c,parent){const parentId=typeof parent==='object'?parent._database_id:parent;return (c?.subtopics||[]).filter(s=>Number(s.parentSubtopicId)===Number(parentId));}
  function hasChildSubtopics(c,subtopic){return childSubtopics(c,subtopic).length>0;}
  function subtopicTree(c){
    const all=(c?.subtopics||[]).slice(),byParent=new Map(),ids=new Set(all.map(s=>Number(s._database_id)));
    all.forEach(s=>{const parent=s.parentSubtopicId;if(parent!=null&&ids.has(Number(parent))){if(!byParent.has(Number(parent)))byParent.set(Number(parent),[]);byParent.get(Number(parent)).push(s);}});
    const roots=all.filter(s=>s.parentSubtopicId==null||!ids.has(Number(s.parentSubtopicId)));
    const make=(sub,path,seen)=>{const id=Number(sub._database_id);if(seen.has(id))return Object.assign({},sub,{children:[],path});const nextSeen=new Set(seen);nextSeen.add(id);return Object.assign({},sub,{path,children:(byParent.get(id)||[]).map((child,index)=>make(child,path.concat(index+1),nextSeen))});};
    return roots.map((root,index)=>make(root,[index+1],new Set()));
  }
  function flattenTree(nodes,out){(nodes||[]).forEach(node=>{out.push(node);flattenTree(node.children,out);});return out;}
  function topicPathText(node){return (node.path||[]).join('.')||'1';}
  function topicPathTitle(node){return (node.ancestorTitles||[]).concat(node.title||'').filter(Boolean).join(' › ');}
  function annotateTree(nodes,parents){return (nodes||[]).map(node=>{const copy=Object.assign({},node,{ancestorTitles:parents||[]});copy.children=annotateTree(node.children,(parents||[]).concat(node.title||''));return copy;});}
  function materialSubtopics(c){return flattenTree(annotateTree(subtopicTree(c),[]),[]).filter(node=>!(node.children||[]).length);}
  function descendantDatabaseIds(node, out){
    out=out||new Set();if(!node)return out;out.add(Number(node._database_id));(node.children||[]).forEach(child=>descendantDatabaseIds(child,out));return out;
  }
  function parentSubtopicOptions(c, selectedParentId, excludeSubtopicDatabaseId){
    const nodes=flattenTree(annotateTree(subtopicTree(c),[]),[]),selected=selectedParentId==null?0:Number(selectedParentId);
    const edited=nodes.find(node=>Number(node._database_id)===Number(excludeSubtopicDatabaseId));
    const blocked=edited?descendantDatabaseIds(edited):new Set();
    return '<option value="">Make this a first-level subtopic page</option>'+nodes.filter(node=>!blocked.has(Number(node._database_id))).map(node=>'<option value="'+esc(node._database_id)+'" '+(Number(node._database_id)===selected?'selected':'')+'>Inside page '+esc(topicPathText(node))+': '+esc(topicPathTitle(node))+'</option>').join('');
  }
  function subtopicOptions(c, selectedId){
    return materialSubtopics(c).map(node=>'<option value="'+esc(node.id)+'" '+(node.id===selectedId?'selected':'')+'>Final page '+esc(topicPathText(node))+': '+esc(topicPathTitle(node))+'</option>').join('');
  }
  function selectedResourceSubtopic(c){
    const leaves=materialSubtopics(c);if(!leaves.length)return null;
    return leaves.find(node=>node.id===selectedResourceSubtopicId)||leaves[0];
  }

  function fileOf(u){ const t=String(u||'').split('?')[0]; const m=t.match(/\/([^\/]+)$/); return m?m[1]:t; }
  function playlistItems(s){
    const stored=Array.isArray(s&&s.resources)?s.resources:[];
    const items=stored.map(r=>({id:r.id,kind:r.resource_type==='video'?'video':'document',title:r.title||fileOf(r.file_url),url:r.file_url||'',order:Number(r.display_order)||0,legacy:false}));
    // Existing courses continue to work without an admin migration pass.
    if(s&&s.videoUrl&&!items.some(x=>x.kind==='video'&&x.url===s.videoUrl))items.unshift({id:null,kind:'video',title:fileOf(s.videoUrl),url:s.videoUrl,order:-2,legacy:true});
    if(s&&s.pdfUrl&&!items.some(x=>x.kind==='document'&&x.url===s.pdfUrl))items.push({id:null,kind:'document',title:fileOf(s.pdfUrl),url:s.pdfUrl,order:-1,legacy:true});
    return items.sort((a,b)=>a.order-b.order||String(a.title).localeCompare(String(b.title)));
  }
  function attachChips(s){
    const list=playlistItems(s),v=list.filter(x=>x.kind==='video').length,d=list.filter(x=>x.kind==='document').length,e=String(s.exercise||'').trim();
    const one=(ic,lab,n)=>'<span class="cm-chip '+(n?'on':'off')+'" title="'+n+' attached">'+ic+lab+' '+n+'</span>';
    return '<span class="cm-chips">'+one(ICO.video,'video',v)+one(ICO.doc,'doc',d)+one(ICO.ex,'exercise',e?1:0)+'</span>';
  }
  function coverage(c){
    const ss=(c&&c.subtopics)||[];
    const videos=ss.reduce((n,x)=>n+playlistItems(x).filter(r=>r.kind==='video').length,0);
    const docs=ss.reduce((n,x)=>n+playlistItems(x).filter(r=>r.kind==='document').length,0);
    return ss.length ? ss.length+' subtopics · '+videos+' videos · '+docs+' documents' : 'no subtopics yet';
  }

  function renderTopics(){
    const el=$('cmPanelTopics'); if(!el) return;
    const cs=getCoursesForAdmin(); const c=selectedCourse();
    el.innerHTML='<div class="cm-quickbar"><button class="cm-btn primary" id="cmNewCourseTop">'+ICO.add+'Add Main Topic</button><button class="cm-btn" id="cmSaveCourseTop">'+ICO.save+'Save Main Topic</button><button class="cm-btn ghost" id="cmRefreshFromDb">'+ICO.sync+'Refresh from Database</button><span class="cm-note" style="margin-left:auto">'+cs.length+' topic'+(cs.length===1?'':'s')+' in the database</span></div><div class="cm-grid"><div class="cm-card"><h3>Main Topics / Courses</h3><div class="cm-list">'+(cs.map(x=>'<div class="cm-item '+(x.id===selectedCourseId?'active':'')+'" data-course="'+esc(x.id)+'"><div class="cm-thumb" style="background-image:url(\''+esc(x.image)+'\')"></div><div><strong>'+esc(x.title)+'</strong><span>'+esc(x.tag)+' · '+(x.subtopics||[]).length+' subtopics · order '+(isFinite(Number(x.display_order))?Math.round(Number(x.display_order)):0)+' · '+x.duration_hours+' hrs · '+(x._database_id?'<b>Synced</b>':'<b>Local only</b>')+'</span><span>'+coverage(x)+'</span></div></div>').join('')||'<p class="cm-help">No courses yet. Click "+ Add Main Topic" to create one.</p>')+'</div></div><div class="cm-card"><h3>'+(c ? 'Edit' : 'Add New')+' Main Topic</h3><div class="cm-preview" id="cmPreview" style="background-image:url(\''+esc(c?.image||'')+'\')"></div><div class="cm-two"><div class="cm-field"><label>Topic title</label><input id="cmTitle" value="'+esc(c?.title||'')+'" placeholder="Enter topic title"></div><div class="cm-field"><label>Tag / category</label><input id="cmTag" value="'+esc(c?.tag||'')+'" placeholder="e.g. CATIA, CAD"></div></div><div class="cm-two"><div class="cm-field"><label>Duration hours</label><input id="cmHours" type="number" value="'+esc(c?.duration_hours||10)+'"></div><div class="cm-field"><label>Display order</label><input id="cmOrder" type="number" min="0" step="1" value="'+((c&&isFinite(Number(c.display_order)))?Math.round(Number(c.display_order)):cs.length)+'" placeholder="0"></div></div><div class="cm-field"><label>Course description</label><textarea id="cmDesc" placeholder="Brief description">'+esc(c?.short_description||'')+'</textarea></div><div class="cm-field"><label>Preview image URL</label><input id="cmImage" value="'+esc(c?.image||'')+'" placeholder="Paste image URL"></div><div class="cm-field"><label>Upload preview image</label><input id="cmImageFile" type="file" accept="image/*"></div><div class="cm-actions"><button class="cm-btn primary" id="cmSaveCourse">'+ICO.save+'Save to Database</button><button class="cm-btn danger" id="cmDeleteCourse">'+ICO.del+'Delete from Database</button></div><p class="cm-help">Saves to the database, so every student sees it. The lesson page reads the database, so a change shows up on the next lesson open.</p></div></div>';
    el.querySelectorAll('[data-course]').forEach(i=>i.onclick=()=>{creatingNewCourse=false; selectedCourseId=i.dataset.course; selectedSubtopicId=null; selectedResourceSubtopicId=null; subtopicEditorMode='add'; renderAll();});
    const newCourse=()=>{creatingNewCourse=true; selectedCourseId=null; selectedCourseDatabaseId=null; selectedSubtopicId=null; selectedResourceSubtopicId=null; subtopicEditorMode='add'; renderAll(); setTimeout(()=>$('cmTitle')&&$('cmTitle').focus(),0);};
    $('cmNewCourseTop').onclick=newCourse;
    $('cmSaveCourseTop').onclick=guard(saveCourse,'cmSaveCourseTop','cmSaveCourse');
    $('cmRefreshFromDb').onclick=guard(async()=>{showStatus('Refreshing from the database\u2026'); await loadDatabaseCourses(); await renderAll(); setStatus('Database refreshed \u2014 '+databaseCourses.length+' course'+(databaseCourses.length===1?'':'s')+' loaded.','ok');},'cmRefreshFromDb');
    $('cmImageFile').onchange=startUpload('image','cmImage');
    $('cmImage').oninput=e=>$('cmPreview').style.backgroundImage='url("'+e.target.value+'")';
    $('cmSaveCourse').onclick=guard(saveCourse,'cmSaveCourse','cmSaveCourseTop');
    $('cmDeleteCourse').onclick=guard(deleteCourse,'cmDeleteCourse');
  }

  async function saveCourse(){
    const titleEl=$('cmTitle'); if(!titleEl) return;
    const title=titleEl.value.trim();
    if(!title){ note('A topic title is required before this can be saved.','err'); titleEl.focus(); return; }
    const fields = {
      title,
      slug: SoftmarcContent.slug(title),
      tag: $('cmTag').value.trim()||'Course',
      short_description: $('cmDesc').value.trim(),
      duration_hours: Number($('cmHours').value||10),
      image: $('cmImage').value.trim() || SoftmarcContent.defaultImage(title, $('cmTag').value.trim()),
      display_order: (function(){ var el=$('cmOrder'); if(el && el.value!=='' && isFinite(Number(el.value))) return Math.max(0, Math.round(Number(el.value))); return getCoursesForAdmin().length; })()
    };
    try {
      if(uploading.image){ showStatus('Waiting for the image upload to finish\u2026'); try{ await uploading.image; }catch(e){} }
      showStatus('Saving to the database\u2026');
      if(!creatingNewCourse && selectedCourseDatabaseId){
        await dbUpdateCourse(selectedCourseDatabaseId, fields);
        showStatus('Course updated in the database.');
      } else {
        const result = await dbCreateCourse(fields);
        creatingNewCourse = false;
        selectedCourseDatabaseId = result.id;
        selectedCourseId = result.slug || SoftmarcContent.slug(fields.title);
        showStatus('New course created in the database.');
      }
      await renderAll();
      // a course row has no video of its own, so nothing to reach-check here \u2014 but the answer
      // must come back from the server before we call it saved
      await verifyCourseOnServer(fields);
    } catch(err) {
      showError('Database save failed: '+err.message);
      let cs=getCourses(); let c=selectedCourseId?cs.find(x=>x.id===selectedCourseId):null;
      if(!c){c={id:SoftmarcContent.slug(title),subtopics:[],display_order:cs.length}; cs.push(c); selectedCourseId=c.id;}
      c.title=title; c.slug=SoftmarcContent.slug(title); c.tag=fields.tag; c.short_description=fields.short_description; c.duration_hours=fields.duration_hours; c.image=fields.image;
      saveCourses(cs, 'Saved in this browser only \u2014 the database did not accept it, so other students will not see it yet.');
      setStatus('Database save failed: '+err.message+' \u2014 kept in this browser only, try again when the connection is back.','err');
    }
  }
  async function verifyCourseOnServer(fields){
    try{
      const res = await fetch(`${API_HOST}/courses`, { cache:'no-store' });
      if(!res.ok){ setStatus('Saved, but the database could not be re-read to confirm it ('+res.status+').','err'); return; }
      const rows = await res.json();
      const row = (rows||[]).find(x => (selectedCourseDatabaseId && x.id===selectedCourseDatabaseId) || x.title===fields.title);
      if(!row){ setStatus('Saved, but this course is not in the database list \u2014 press Refresh from Database.','err'); return; }
      const diffs=[];
      if(String(row.title||'')!==fields.title) diffs.push('title');
      if(Number(row.duration_hours||0)!==Number(fields.duration_hours||0)) diffs.push('duration');
      if(String(row.short_description||'')!==String(fields.short_description||'')) diffs.push('description');
      if(diffs.length){ setStatus('Saved, but the database still shows a different '+diffs.join(', ')+' \u2014 press Refresh from Database, then save once more.','err'); return; }
      try{ if(SoftmarcContent.refreshFromDatabase) SoftmarcContent.refreshFromDatabase(); }catch(e){}
      setStatus('\u2705 Verified on the server: '+row.title+'. A learner opening the lesson page now gets this.','ok');
    }catch(e){}
  }

  async function deleteCourse(){
    if(!selectedCourseId){ note('Pick a main topic in the list on the left first.','err'); return; }
    if(!confirm('Delete this main topic and all subtopics?')) return;
    try {
      showStatus('Deleting...');
      if(selectedCourseDatabaseId) await dbDeleteCourse(selectedCourseDatabaseId);
      selectedCourseId=null; selectedCourseDatabaseId=null; selectedSubtopicId=null; selectedSubtopicDatabaseId=null;
      await renderAll();
      showStatus('Course deleted.');
    } catch(err) {
      showError('Delete failed: '+err.message);
    }
  }

  function startNewSubtopic(parentDatabaseId){
    subtopicEditorMode='add';subtopicParentDraftDatabaseId=parentDatabaseId==null?null:Number(parentDatabaseId);renderSubtopics();
    setTimeout(()=>{$('cmSubTitle')&&$('cmSubTitle').focus();},0);
  }
  function selectSubtopicForEdit(id){
    selectedSubtopicId=id;selectedSubtopicDatabaseId=null;subtopicEditorMode='edit';subtopicParentDraftDatabaseId=null;renderSubtopics();
  }
  function renderSubtopics(){
    const el=$('cmPanelSubtopics');if(!el)return;const c=selectedCourse(),roots=subtopicTree(c),total=(c?.subtopics||[]).length||0;
    const allNodes=flattenTree(roots,[]),editing=subtopicEditorMode==='edit'?selectedSubtopic():null;
    const editMode=!!(editing&&editing._database_id),parentValue=editMode?editing.parentSubtopicId:subtopicParentDraftDatabaseId;
    const row=(node)=>{const folder=(node.children||[]).length>0,active=editMode&&node.id===editing.id,kind=folder?'Folder':'Final lesson';return '<div class="cm-outline-row '+(active?'active':'')+'" data-depth="'+Math.max(0,(node.path||[]).length-1)+'" style="--depth:'+Math.max(0,(node.path||[]).length-1)+'"><button class="cm-outline-select" type="button" data-edit-sub="'+esc(node.id)+'" title="Edit '+esc(node.title)+'"><span class="cm-outline-index">'+esc(topicPathText(node))+'</span><span class="cm-outline-copy"><b>'+esc(node.title)+'</b><small><span class="cm-outline-kind '+(folder?'folder':'')+'">'+kind+'</span><span>'+esc(node.dur||'15 min')+(folder?' · '+node.children.length+' inner page'+(node.children.length===1?'':'s'):' · ready for materials')+'</span></small></span></button><span class="cm-outline-actions"><button class="cm-outline-edit" type="button" data-edit-sub="'+esc(node.id)+'" title="Edit this subtopic page">'+ICO.edit+'<span>Edit</span></button><button class="cm-outline-child" type="button" data-add-child="'+esc(node._database_id)+'" title="Add an inner subtopic page">+ Child</button></span></div>';};
    const editorTitle=editMode?'Edit subtopic page':'Add a subtopic page';
    // This explicit summary makes it clear whether the form will add a page or edit the selected page.
    const editNode=editMode?flattenTree(annotateTree(roots,[]),[]).find(node=>Number(node._database_id)===Number(editing._database_id)):null;
    const clearSummary=editMode?'<div class="cm-edit-summary">'+ICO.edit+'<span>Editing <b>Page '+esc(editNode?topicPathText(editNode):'')+': '+esc(editing.title)+'</b>. Save changes when you are finished.</span><span class="cm-outline-kind '+(hasChildSubtopics(c,editing)?'folder':'')+'">'+(hasChildSubtopics(c,editing)?'Folder':'Final lesson')+'</span></div>':'';
    const heading='<div class="cm-form-heading"><h3>'+editorTitle+'</h3>'+(editMode?'<button class="cm-btn ghost" type="button" id="cmNewSubtopic">'+ICO.add+'New page</button>':'')+'</div>';
    const action=editMode?'<button class="cm-btn primary" id="cmSaveSubtopic">'+ICO.save+'Save changes</button><button class="cm-btn danger" id="cmDeleteSubtopic">'+ICO.del+'Delete this page</button>':'<button class="cm-btn primary" id="cmAddSubtopic">'+ICO.add+'Add subtopic page</button><button class="cm-btn ghost" id="cmCancelSubtopic">Cancel</button>';
    const parentLabel=editMode?'Move this page inside':'Place this page inside';
    const parentNote=editMode?'Choose another allowed parent page, or make this a first-level page. This page and its inner pages are excluded to prevent a loop.':'Choose any existing page to make its next inner subtopic page. Leave it on the first option to add a first-level subtopic page.';
    el.innerHTML='<div class="cm-quickbar"><button class="cm-btn primary" id="cmAddSubtopicTop">'+ICO.add+'Add first subtopic</button><button class="cm-btn '+(editMode?'':'ghost')+'" id="cmEditSelectedTop" '+(editMode?'':'disabled')+'>'+ICO.edit+'Edit selected page</button><button class="cm-btn danger" id="cmDeleteSubtopicTop">'+ICO.del+'Delete selected page</button><span class="cm-note" style="margin-left:auto">'+roots.length+' first-level page'+(roots.length===1?'':'s')+' · '+total+' total in '+(c?esc(c.title):'this course')+'</span></div><div class="cm-grid"><div class="cm-card"><h3>Subtopic page outline</h3><p class="cm-note" style="margin:5px 0 12px">Select <b>Edit</b> to update a page, or use <b>+ Child</b> to add the next level. Every action stays visible at every depth.</p><div class="cm-field"><label>Course / main topic</label><select id="cmSubCourseSelect">'+courseOptions()+'</select></div><div class="cm-list cm-topic-tree">'+(allNodes.map(row).join('')||'<p class="cm-help">No subtopic pages yet. Add the first one from the form.</p>')+'</div></div><div class="cm-card">'+heading+clearSummary+'<div class="cm-field"><label>'+parentLabel+'</label><select id="cmSubParent">'+parentSubtopicOptions(c,parentValue,editMode?editing._database_id:null)+'</select><p class="cm-note">'+parentNote+'</p></div><div class="cm-field"><label>Subtopic page title</label><input id="cmSubTitle" value="'+esc(editMode?editing.title:'')+'" placeholder="Example: Line & Point"></div><div class="cm-two"><div class="cm-field"><label>Duration</label><input id="cmSubDur" value="'+esc(editMode?editing.dur||'15 min':'20 min')+'" placeholder="20 min"></div><div class="cm-field"><label>Display order</label><input id="cmSubOrder" type="number" min="0" value="'+(editMode?(isFinite(Number(editing.display_order))?Math.max(0,Math.round(Number(editing.display_order))):0):total)+'"></div></div><div class="cm-field"><label>Page description</label><textarea id="cmSubDesc" placeholder="Brief description">'+esc(editMode?(editing.description||''):'')+'</textarea></div><div class="cm-actions">'+action+'</div><p class="cm-help">Folders contain inner subtopic pages. Videos, PDF/PPTX, MCQ and exercises are attached only to a final lesson page with no inner subtopics.</p></div></div>';
    $('cmSubCourseSelect').onchange=e=>{creatingNewCourse=false;selectedCourseId=e.target.value;selectedSubtopicId=null;selectedSubtopicDatabaseId=null;selectedResourceSubtopicId=null;subtopicEditorMode='add';subtopicParentDraftDatabaseId=null;renderAll();};
    el.querySelectorAll('[data-edit-sub]').forEach(button=>button.onclick=event=>{event.stopPropagation();selectSubtopicForEdit(button.dataset.editSub);});
    el.querySelectorAll('[data-add-child]').forEach(button=>button.onclick=event=>{event.stopPropagation();startNewSubtopic(button.dataset.addChild);});
    $('cmAddSubtopicTop').onclick=()=>startNewSubtopic(null);
    const newButton=$('cmNewSubtopic');if(newButton)newButton.onclick=()=>startNewSubtopic(null);
    const cancelButton=$('cmCancelSubtopic');if(cancelButton)cancelButton.onclick=()=>startNewSubtopic(null);
    const editTop=$('cmEditSelectedTop');if(editTop)editTop.onclick=()=>{if(selectedSubtopic())selectSubtopicForEdit(selectedSubtopicId);};
    $('cmDeleteSubtopicTop').onclick=guard(deleteSubtopic,'cmDeleteSubtopicTop','cmDeleteSubtopic');
    const addButton=$('cmAddSubtopic');if(addButton)addButton.onclick=guard(addSubtopic,'cmAddSubtopic','cmAddSubtopicTop');
    const saveButton=$('cmSaveSubtopic');if(saveButton)saveButton.onclick=guard(saveSubtopic,'cmSaveSubtopic','cmEditSelectedTop');
    const deleteButton=$('cmDeleteSubtopic');if(deleteButton)deleteButton.onclick=guard(deleteSubtopic,'cmDeleteSubtopic','cmDeleteSubtopicTop');
  }

  function readSubtopicForm(c){
    const title=$('cmSubTitle').value.trim(),rawOrder=$('cmSubOrder').value,parentValue=$('cmSubParent').value;
    return {title,slug:SoftmarcContent.slug(title),dur:$('cmSubDur').value.trim()||'15 min',description:$('cmSubDesc').value.trim(),display_order:rawOrder===''?(c.subtopics||[]).length:Math.max(0,Number(rawOrder)||0),parent_subtopic_id:parentValue?Number(parentValue):null};
  }
  async function addSubtopic(){
    const c=selectedCourse(),fields=c?readSubtopicForm(c):null;if(!fields||!fields.title){note('A subtopic page needs a title before it can be added.','err');$('cmSubTitle')&&$('cmSubTitle').focus();return;}
    if(!c){note('Choose a main topic at the top of this panel first.','err');return;}
    try{showStatus('Adding subtopic page...');if(!c._database_id)throw new Error('Save the course first.');const made=await dbCreateSubtopic(c._database_id,fields);selectedSubtopicId=made.slug||SoftmarcContent.slug(fields.title);subtopicEditorMode='edit';subtopicParentDraftDatabaseId=null;await renderAll();showStatus('✅ Subtopic page added. You can now edit it, add an inner page, or attach final-page materials when it has no children.','ok');}catch(err){showError('Failed: '+err.message);}
  }
  async function saveSubtopic(){
    const c=selectedCourse(),st=selectedSubtopic(),fields=c?readSubtopicForm(c):null;
    if(!st||!st._database_id){note('Select a saved subtopic page to edit.','err');return;}
    if(!fields||!fields.title){note('A subtopic page needs a title before it can be saved.','err');$('cmSubTitle')&&$('cmSubTitle').focus();return;}
    try{showStatus('Saving subtopic page changes...');const updated=await dbUpdateSubtopic(st._database_id,fields);selectedSubtopicId=updated.slug||SoftmarcContent.slug(fields.title);subtopicEditorMode='edit';subtopicParentDraftDatabaseId=null;await renderAll();showStatus('✅ Subtopic page changes saved to the database.','ok');}catch(err){showError('Failed: '+err.message);}
  }
  async function deleteSubtopic(){
    const c=selectedCourse(); const st=selectedSubtopic();
    if(!c||!st){ note('Select the subtopic page you want to remove from the outline first.','err'); return; }
    if(!confirm('Delete this subtopic page and every inner subtopic below it? Its attached videos, PDFs/PPTX, MCQ and exercises will also be removed.')) return;
    try {showStatus('Deleting page and its inner subtopics...');if(st._database_id) await dbDeleteSubtopic(st._database_id);selectedSubtopicId=null; selectedSubtopicDatabaseId=null;selectedResourceSubtopicId=null;subtopicParentDraftDatabaseId=null;subtopicEditorMode='add';await renderAll();showStatus('Subtopic page deleted.');}catch(err){showError('Delete failed: '+err.message);}
  }

  function resourceLabel(kind){return kind==='video'?'Video':'PDF / PPTX';}
  function resourceIcon(kind){return kind==='video'?ICO.video:ICO.doc;}
  function resourceRow(item){
    return '<div class="cm-resource-box set"><b>'+resourceIcon(item.kind)+esc(resourceLabel(item.kind))+'</b><span><strong>'+esc(item.title||fileOf(item.url))+'</strong><small>'+esc(fileOf(item.url))+(item.legacy?' · legacy material':' · position '+(item.order+1))+'</small></span>'+(item.legacy?'<button class="cm-btn danger cm-resource-delete" type="button" data-clear-legacy="'+item.kind+'">Remove</button>':'<button class="cm-btn danger cm-resource-delete" type="button" data-resource-delete="'+esc(item.id)+'">Remove</button>')+'</div>';
  }
  async function addPlaylistMaterial(kind, fileOverride){
    const st=selectedResourceSubtopic(selectedCourse());
    if(!st||!st._database_id){note('Choose and save a subtopic first, then add its learning materials.','err');return;}
    const file=String(fileOverride!==undefined?fileOverride:($('cmMaterialUrl')&&$('cmMaterialUrl').value)||'').trim();
    const title=String(($('cmMaterialTitle')&&$('cmMaterialTitle').value)||'').trim();
    const order=Math.max(0,Number(($('cmMaterialOrder')&&$('cmMaterialOrder').value)||playlistItems(st).length)||0);
    if(!file){note('Paste a file path or upload a file before adding the '+resourceLabel(kind).toLowerCase()+'.','err');return;}
    if(kind==='document'&&!/\.(pdf|pptx)(?:[?#].*)?$/i.test(file)){note('Use a PDF or PPTX for document material. Old .ppt files are not supported.','err');return;}
    await dbAddPlaylistResource(st._database_id,{resource_type:kind,file_url:file,title:title||fileOf(file),display_order:order});
    await renderAll();setStatus('✅ '+resourceLabel(kind)+' added to “'+st.title+'”.','ok');
  }
  function startPlaylistUpload(kind){
    return async event=>{
      const file=event.target.files&&event.target.files[0];if(!file)return;
      const st=selectedResourceSubtopic(selectedCourse());if(!st||!st._database_id){note('Choose and save a final subtopic page before uploading.','err');event.target.value='';return;}
      const mb=Math.round(file.size/104857.6)/10;
      try{setStatus('Uploading '+resourceLabel(kind)+' ('+mb+' MB)… keep this page open.','info');const path=await uploadFile(kind==='video'?'video':'pdf',file);const title=$('cmMaterialTitle');if(title&&!title.value.trim())title.value=file.name;await addPlaylistMaterial(kind,path);}
      catch(err){showError('Upload failed: '+err.message);}finally{event.target.value='';}
    };
  }
  async function removePlaylistMaterial(id){
    if(!confirm('Remove this material from the selected subtopic? The uploaded file is kept on the server, but students will no longer see it.'))return;
    await dbDeletePlaylistResource(id);await renderAll();setStatus('✅ Material removed from this subtopic.','ok');
  }
  async function clearLegacyMaterial(kind){
    const st=selectedResourceSubtopic(selectedCourse());if(!st||!st._database_id)return;
    if(!confirm('Remove this legacy '+resourceLabel(kind).toLowerCase()+' from the selected subtopic?'))return;
    await dbUpdateSubtopic(st._database_id,kind==='video'?{video_url:''}:{pdf_url:''});
    await renderAll();setStatus('✅ Legacy '+resourceLabel(kind).toLowerCase()+' removed from this subtopic.','ok');
  }
  function renderResources(){ 
    const el=$('cmPanelResources');if(!el)return;const c=selectedCourse();const st=selectedResourceSubtopic(c);const items=st?playlistItems(st):[];
    const videoCount=items.filter(x=>x.kind==='video').length,docCount=items.filter(x=>x.kind==='document').length;
    el.innerHTML='<div class="cm-quickbar"><button class="cm-btn primary" id="cmAddVideoTop">'+ICO.video+'Add video</button><button class="cm-btn primary" id="cmAddDocumentTop">'+ICO.doc+'Add PDF / PPTX</button><span class="cm-note" style="margin-left:auto">Each item is added separately and appears in the student playlist</span></div><div class="cm-card"><h3>Final-page Materials</h3><div class="cm-two"><div class="cm-field"><label>Main topic</label><select id="cmResCourseSelect">'+courseOptions()+'</select></div><div class="cm-field"><label>Final subtopic page</label><select id="cmResSubSelect">'+subtopicOptions(c,selectedResourceSubtopicId)+'</select></div></div>'+(st?'<div class="cm-resource-preview"><div class="cm-resource-box '+(videoCount?'set':'missing')+'"><b>'+ICO.video+'Videos</b><span>'+videoCount+' video'+(videoCount===1?'':'s')+' in this subtopic</span></div><div class="cm-resource-box '+(docCount?'set':'missing')+'"><b>'+ICO.doc+'PDF / PPTX</b><span>'+docCount+' document'+(docCount===1?'':'s')+' in this subtopic</span></div><div class="cm-resource-box '+(st.exercise?'set':'missing')+'"><b>'+ICO.ex+'Exercise</b><span>'+esc(st.exercise?'Exercise attached':'No exercise text')+'</span></div></div><div class="cm-field"><label>Material title</label><input id="cmMaterialTitle" placeholder="Example: Line tool demonstration"></div><div class="cm-two"><div class="cm-field"><label>File URL / path</label><input id="cmMaterialUrl" placeholder="videos/line-demo.mp4 or pdfs/line-notes.pdf"></div><div class="cm-field"><label>Playlist position</label><input id="cmMaterialOrder" type="number" min="0" value="'+items.length+'"><p class="cm-note">0 is first</p></div></div><div class="cm-two"><div class="cm-field"><label>Upload video</label><input id="cmPlaylistVideoFile" type="file" accept="video/*,.mp4,.webm,.m4v,.mov"></div><div class="cm-field"><label>Upload PDF or PowerPoint</label><input id="cmPlaylistDocumentFile" type="file" accept="application/pdf,.pdf,.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"><p class="cm-note">Use saved <b>.pptx</b> for presentations with animations/video. Students open one selected deck at a time in the lesson screen.</p></div></div><div class="cm-actions"><button class="cm-btn primary" id="cmAddVideo">'+ICO.video+'Add video</button><button class="cm-btn primary" id="cmAddDocument">'+ICO.doc+'Add PDF / PPTX</button></div><div class="cm-field"><label>Current subtopic playlist</label><div class="cm-resource-preview cm-playlist">'+(items.length?items.map(resourceRow).join(''):'<p class="cm-help">No materials yet. Add as many videos and PDF/PPTX files as this subtopic needs.</p>')+'</div></div><div class="cm-field"><label>Exercise</label><textarea id="cmExercise">'+esc(st.exercise||'')+'</textarea></div><div class="cm-actions"><button class="cm-btn" id="cmSaveExercise">'+ICO.ex+'Save Exercise</button></div>':'<p class="cm-help">Create subtopic pages until you reach a final page. Select that final page here to add its videos, PDF/PPTX, MCQ and exercises.</p>')+'</div>';
    $('cmResCourseSelect').onchange=e=>{creatingNewCourse=false;selectedCourseId=e.target.value;selectedSubtopicId=null;selectedResourceSubtopicId=null;subtopicEditorMode='add';renderAll();};
    const subSel=$('cmResSubSelect');if(subSel)subSel.onchange=e=>{selectedResourceSubtopicId=e.target.value;renderResources();};
    const addVideo=()=>addPlaylistMaterial('video');const addDocument=()=>addPlaylistMaterial('document');
    ['cmAddVideo','cmAddVideoTop'].forEach(id=>{const b=$(id);if(b)b.onclick=guard(addVideo,'cmAddVideo','cmAddVideoTop');});
    ['cmAddDocument','cmAddDocumentTop'].forEach(id=>{const b=$(id);if(b)b.onclick=guard(addDocument,'cmAddDocument','cmAddDocumentTop');});
    const vf=$('cmPlaylistVideoFile');if(vf)vf.onchange=startPlaylistUpload('video');const df=$('cmPlaylistDocumentFile');if(df)df.onchange=startPlaylistUpload('document');
    el.querySelectorAll('[data-resource-delete]').forEach(b=>b.onclick=()=>removePlaylistMaterial(b.dataset.resourceDelete).catch(err=>showError('Could not remove material: '+err.message)));
    el.querySelectorAll('[data-clear-legacy]').forEach(b=>b.onclick=()=>clearLegacyMaterial(b.dataset.clearLegacy).catch(err=>showError('Could not remove material: '+err.message)));
    const ex=$('cmSaveExercise');if(ex)ex.onclick=guard(()=>saveResources('exercise'),'cmSaveExercise');
  }

  async function saveResources(type, forcedVal, target){
    const st=target || selectedResourceSubtopic(selectedCourse());
    if(!st){ note('Choose the subtopic this ' + type + ' belongs to \u2014 top of this panel, or the Subtopics tab.','err'); return; }
    // An ordinary click while an upload is in flight waits; the upload-complete call carries a
    // forced value and is the one allowed to commit that value.
    if(type!=='exercise' && uploading[type] && forcedVal===undefined){ showStatus('The '+type+' upload is still running \u2014 it saves itself the moment it finishes, so there is nothing to press.'); return; }
    const fields = {};
    const readVal = id => { const el=$(id); return el ? el.value.trim() : ''; };
    if(type==='video') fields.video_url = (forcedVal !== undefined ? forcedVal : readVal('cmVideoUrl'));
    if(type==='pdf') {
      fields.pdf_url = (forcedVal !== undefined ? forcedVal : readVal('cmPdfUrl'));
      if(fields.pdf_url && !/\.(pdf|pptx)(?:[?#].*)?$/i.test(fields.pdf_url)){
        note('Use a .pdf or .pptx file here. Old .ppt files cannot safely play in the lesson screen.','err');
        const input=$('cmPdfUrl'); if(input) input.focus(); return;
      }
    }
    if(type==='exercise') fields.exercise = readVal('cmExercise');
    try {
      showStatus('Saving\u2026');
      if(!st._database_id) throw new Error('Save the subtopic first (Subtopics tab \u2192 Add to Database).');
      await dbUpdateSubtopic(st._database_id, fields);
      await renderAll();
      await verifyResourceOnServer(type, fields, st);
    } catch(err) {
      showError('Failed: '+err.message);
    }
  }
  // never trust the request: read the row back and compare. This is the check that turns
  // "I pressed Save and nothing appeared on the lesson page" into a message that says why.
  async function verifyResourceOnServer(type, fields, st){
    const key = type==='video' ? 'video_url' : type==='pdf' ? 'pdf_url' : 'exercise';
    const want = String(fields[key]||'').trim();
    const label = type==='video' ? 'Video' : type==='pdf' ? 'PDF / PPTX' : 'Exercise';
    let got = String((type==='video'?st.videoUrl:type==='pdf'?st.pdfUrl:st.exercise)||'').trim();
    if(got !== want){
      try{
        const res = await fetch(`${API_HOST}/courses`, { cache:'no-store' });
        if(res.ok){
          const rows = await res.json();
          let row=null;
          (rows||[]).some(course=>{ row=((course&&course.subtopics)||[]).find(x=>Number(x.id)===Number(st._database_id)); return !!row; });
          if(row) got = String(row[key]||'').trim();
        }
      }catch(e){}
    }
    if(got !== want){
      setStatus('Sent, but the database still holds something different for this '+label.toLowerCase()+' \u2014 Refresh from Database, then save once more.','err');
      return;
    }
    if(!want){ setStatus('\u2705 '+label+' cleared on the server \u2014 the lesson page will not show it.','ok'); return; }
    if(type==='exercise'){ setStatus('\u2705 Exercise verified on the server.','ok'); return; }
    setStatus('\u2705 '+label+' verified on the server.','ok');
    checkDocReach(want);   // and prove the file itself can be fetched, not just the row
  }

  build();

  const original=window.switchAdminTab;
  window.switchAdminTab=async function(tab){
    if(tab==='content'){
      document.querySelectorAll('.section-wrapper').forEach(s=>s.classList.remove('active'));
      document.querySelectorAll('.tabs .tab').forEach(t=>t.classList.remove('on'));
      $('secContent').classList.add('active'); $('tabBtnContent').classList.add('on');
      const title=$('adminHeaderTitle'); if(title) title.textContent='Course Manager';
      const sub=$('adminHeaderSub'); if(sub) sub.textContent='Create unlimited subtopic pages, then attach playlists to each final page.';
      const add=$('openAddModal'); if(add) add.style.display='none';
      await renderAll(); return;
    }
    return original?original(tab):undefined;
  };
})();
