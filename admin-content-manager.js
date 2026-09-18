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
      const mb = Math.round((f.size/1048576)*10)/10;
      const pr = (async()=>{
        try{
          showStatus('Uploading '+kind+' ('+mb+' MB)… keep this page open until it finishes…');
          const p = await uploadFile(kind, f);
          const inp = $(urlInputId); if(inp) inp.value = p;
          if(kind==='image'){ const pv=$('cmPreview'); if(pv) pv.style.backgroundImage='url("'+p+'")'; }
          if(kind==='video' || kind==='pdf'){
            await saveResources(kind, p); // pass path directly — survives re-renders
            showStatus('✅ '+kind.toUpperCase()+' uploaded & saved to this subtopic!');
          } else {
            showStatus('✅ Image uploaded — press "Save to Database" to apply it');
          }
        }catch(err){
          showError(kind[0].toUpperCase()+kind.slice(1)+' failed: '+err.message);
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
        title: s.title,
        dur: s.dur || '15 min',
        description: s.description || '',
        videoUrl: s.video_url || '',
        pdfUrl: s.pdf_url || '',
        exercise: s.exercise || ''
      })),
      assessments: []
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

  function showStatus(msg){ const el=$('cmStatus'); if(el) el.textContent=msg; }
  function showError(msg){ const el=$('cmStatus'); if(el) el.textContent=msg; }

  function injectStyle(){
    if($('cmStyle')) return;
    const st=document.createElement('style'); st.id='cmStyle';
    st.textContent='.content-manager{margin:0 28px 28px}.cm-shell{background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow-sm);overflow:hidden}.cm-top{padding:18px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}.cm-top h2{font-family:var(--font-display);font-size:18px;margin:0}.cm-top p{font-size:13px;color:var(--text-500);margin:4px 0 0}.cm-tabs{display:flex;gap:8px;padding:12px 20px;border-bottom:1px solid var(--border);background:var(--surface-hover);flex-wrap:wrap}.cm-tab{border:1px solid var(--border);background:var(--surface);color:var(--text-700);border-radius:999px;padding:9px 14px;font-size:13px;font-weight:800;cursor:pointer}.cm-tab.active{background:#0A1930;color:#fff;border-color:#0A1930}.cm-panel{display:none;padding:20px}.cm-panel.active{display:block}.cm-grid{display:grid;grid-template-columns:340px 1fr;gap:18px}.cm-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px}.cm-card h3{font-family:var(--font-display);font-size:16px;margin:0 0 12px}.cm-field{margin-bottom:12px}.cm-field label{display:block;font-size:12px;font-weight:800;color:var(--text-500);margin-bottom:6px}.cm-field input,.cm-field textarea,.cm-field select{width:100%;border:1px solid var(--border);background:var(--surface-hover);border-radius:8px;padding:10px 11px;color:var(--text-900);font:500 13px var(--font-body)}.cm-field textarea{min-height:78px;resize:vertical}.cm-two{display:grid;grid-template-columns:1fr 1fr;gap:10px}.cm-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.cm-btn{border:1px solid var(--border);background:var(--surface);border-radius:8px;padding:9px 12px;font-size:12.5px;font-weight:800;color:var(--text-700);cursor:pointer}.cm-btn.primary{background:#0A1930;color:#fff;border-color:#0A1930}.cm-btn.danger{color:#DC2626}.cm-list{display:flex;flex-direction:column;gap:8px;max-height:560px;overflow:auto}.cm-item{border:1px solid var(--border);border-radius:12px;padding:10px;background:var(--surface-hover);display:flex;gap:10px;align-items:center;cursor:pointer}.cm-item.active{border-color:#0A1930;box-shadow:0 0 0 1px #0A1930 inset}.cm-thumb{width:72px;height:50px;border-radius:9px;background-size:cover;background-position:center;flex:0 0 72px;background-color:var(--border)}.cm-item strong{display:block;font-size:13px}.cm-item span{display:block;font-size:11.5px;color:var(--text-500);margin-top:2px}.cm-preview{height:150px;border-radius:12px;background-size:cover;background-position:center;border:1px solid var(--border);margin-bottom:12px;background-color:var(--surface-hover)}.cm-help,.cm-status{font-size:12px;color:var(--text-500);line-height:1.5;margin-top:10px}.cm-quickbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:flex-start;margin:0 0 16px;padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--surface-hover)}.cm-quickbar .cm-btn{margin:0}.cm-upload-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}.cm-note{font-size:11.5px;color:var(--text-500);margin-top:4px;line-height:1.45}.cm-resource-preview{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px}.cm-resource-box{border:1px solid var(--border);border-radius:12px;background:var(--surface-hover);padding:12px}.cm-resource-box b{display:block;font-size:12px;margin-bottom:6px}.cm-resource-box span{font-size:11.5px;color:var(--text-500);word-break:break-word}.cm-db-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:6px;font-size:10.5px;font-weight:800;background:#DCFCE7;color:#166534;margin-left:8px}.cm-db-badge.error{background:#FEE2E2;color:#991B1B}html[data-theme="dark"] .cm-tab.active,body[data-theme="dark"] .cm-tab.active,html[data-theme="dark"] .cm-btn.primary,body[data-theme="dark"] .cm-btn.primary{background:#fff;color:#0A1930;border-color:#fff}@media(max-width:1000px){.cm-grid{grid-template-columns:1fr}.content-manager{margin:0 20px 20px}.cm-resource-preview{grid-template-columns:1fr}}';
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
    sec.innerHTML='<div class="cm-shell"><div class="cm-top"><div><h2>Course Manager <span class="cm-db-badge" id="cmDatabaseBadge">Database Sync</span></h2><p>Add topics, subtopics, videos, PDFs. Changes sync to Database so ALL students see them.</p></div><div class="cm-status" id="cmStatus"></div></div><div class="cm-tabs" role="tablist"><button class="cm-tab active" data-cm-tab="topics">Main Topics</button><button class="cm-tab" data-cm-tab="subtopics">Subtopics</button><button class="cm-tab" data-cm-tab="resources">Videos, PDF & Exercises</button></div><section class="cm-panel active" id="cmPanelTopics"></section><section class="cm-panel" id="cmPanelSubtopics"></section><section class="cm-panel" id="cmPanelResources"></section></div>';
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
  function subtopicOptions(c){
    return (c?.subtopics||[]).map(s=>'<option value="'+esc(s.id)+'" '+(s.id===selectedSubtopicId?'selected':'')+'>'+esc(s.title)+'</option>').join('');
  }

  function renderTopics(){
    const el=$('cmPanelTopics'); if(!el) return;
    const cs=getCoursesForAdmin(); const c=selectedCourse();
    el.innerHTML='<div class="cm-quickbar"><button class="cm-btn primary" id="cmNewCourseTop">+ Add Main Topic</button><button class="cm-btn" id="cmSaveCourseTop">Save Main Topic</button><button class="cm-btn" id="cmRefreshFromDb">Refresh from Database</button></div><div class="cm-grid"><div class="cm-card"><h3>Main Topics / Courses</h3><div class="cm-list">'+(cs.map(x=>'<div class="cm-item '+(x.id===selectedCourseId?'active':'')+'" data-course="'+esc(x.id)+'"><div class="cm-thumb" style="background-image:url(\''+esc(x.image)+'\')"></div><div><strong>'+esc(x.title)+'</strong><span>'+esc(x.tag)+' - '+(x.subtopics||[]).length+' subtopics - '+x.duration_hours+' hrs '+(x._database_id?'Synced':'Local')+'</span></div></div>').join('')||'<p class="cm-help">No courses yet. Click "+ Add Main Topic" to create one.</p>')+'</div></div><div class="cm-card"><h3>'+(c ? 'Edit' : 'Add New')+' Main Topic</h3><div class="cm-preview" id="cmPreview" style="background-image:url(\''+esc(c?.image||'')+'\')"></div><div class="cm-two"><div class="cm-field"><label>Topic title</label><input id="cmTitle" value="'+esc(c?.title||'')+'" placeholder="Enter topic title"></div><div class="cm-field"><label>Tag / category</label><input id="cmTag" value="'+esc(c?.tag||'')+'" placeholder="e.g. CATIA, CAD"></div></div><div class="cm-two"><div class="cm-field"><label>Duration hours</label><input id="cmHours" type="number" value="'+esc(c?.duration_hours||10)+'"></div><div class="cm-field"><label>Level</label><select id="cmLevel"><option '+(c?.level==='Beginner'?'selected':'')+'>Beginner</option><option '+(c?.level==='Intermediate'?'selected':'')+'>Intermediate</option><option '+(c?.level==='Advanced'?'selected':'')+'>Advanced</option></select></div></div><div class="cm-field"><label>Course description</label><textarea id="cmDesc" placeholder="Brief description">'+esc(c?.short_description||'')+'</textarea></div><div class="cm-field"><label>Preview image URL</label><input id="cmImage" value="'+esc(c?.image||'')+'" placeholder="Paste image URL"></div><div class="cm-field"><label>Upload preview image</label><input id="cmImageFile" type="file" accept="image/*"></div><div class="cm-actions"><button class="cm-btn primary" id="cmSaveCourse">Save to Database</button><button class="cm-btn danger" id="cmDeleteCourse">Delete from Database</button></div><p class="cm-help">This saves to Database so ALL students see it.</p></div></div>';
    el.querySelectorAll('[data-course]').forEach(i=>i.onclick=()=>{creatingNewCourse=false; selectedCourseId=i.dataset.course; selectedSubtopicId=null; renderAll();});
    const newCourse=()=>{creatingNewCourse=true; selectedCourseId=null; selectedCourseDatabaseId=null; selectedSubtopicId=null; renderAll(); setTimeout(()=>$('cmTitle')&&$('cmTitle').focus(),0);};
    $('cmNewCourseTop').onclick=newCourse;
    $('cmSaveCourseTop').onclick=saveCourse;
    $('cmRefreshFromDb').onclick=async()=>{showStatus('Refreshing...'); await loadDatabaseCourses(); await renderAll(); showStatus('Refreshed!');};
    $('cmImageFile').onchange=startUpload('image','cmImage');
    $('cmImage').oninput=e=>$('cmPreview').style.backgroundImage='url("'+e.target.value+'")';
    $('cmSaveCourse').onclick=saveCourse;
    $('cmDeleteCourse').onclick=deleteCourse;
  }

  async function saveCourse(){
    const title=$('cmTitle').value.trim(); if(!title) return alert('Topic title required');
    const fields = {
      title,
      slug: SoftmarcContent.slug(title),
      tag: $('cmTag').value.trim()||'Course',
      short_description: $('cmDesc').value.trim(),
      duration_hours: Number($('cmHours').value||10),
      level: $('cmLevel').value,
      image: $('cmImage').value.trim() || SoftmarcContent.defaultImage(title, $('cmTag').value.trim()),
      display_order: getCoursesForAdmin().length
    };
    try {
      if(uploading.image){ showStatus('⏳ Waiting for image upload to finish…'); try{ await uploading.image; }catch(e){} }
      showStatus('Saving to Database...');
      if(!creatingNewCourse && selectedCourseDatabaseId){
        await dbUpdateCourse(selectedCourseDatabaseId, fields);
        showStatus('Course updated in Database!');
      } else {
        const result = await dbCreateCourse(fields);
        creatingNewCourse = false;
        selectedCourseDatabaseId = result.id;
        selectedCourseId = result.slug || SoftmarcContent.slug(fields.title);
        showStatus('New course created in Database!');
      }
      await renderAll();
    } catch(err) {
      showError('Database save failed: '+err.message);
      let cs=getCourses(); let c=selectedCourseId?cs.find(x=>x.id===selectedCourseId):null;
      if(!c){c={id:SoftmarcContent.slug(title),subtopics:[],assessments:[],display_order:cs.length}; cs.push(c); selectedCourseId=c.id;}
      c.title=title; c.slug=SoftmarcContent.slug(title); c.tag=fields.tag; c.short_description=fields.short_description; c.duration_hours=fields.duration_hours; c.level=fields.level; c.image=fields.image;
      saveCourses(cs, 'Saved to localStorage only.');
    }
  }

  async function deleteCourse(){
    if(!selectedCourseId) return;
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

  function renderSubtopics(){
    const el=$('cmPanelSubtopics'); if(!el) return;
    const c=selectedCourse();
    el.innerHTML='<div class="cm-quickbar"><button class="cm-btn primary" id="cmAddSubtopicTop">+ Add Subtopic</button><button class="cm-btn danger" id="cmDeleteSubtopicTop">Delete Selected Subtopic</button></div><div class="cm-grid"><div class="cm-card"><h3>Select Main Topic</h3><div class="cm-field"><label>Course</label><select id="cmSubCourseSelect">'+courseOptions()+'</select></div><div class="cm-list">'+((c?.subtopics||[]).map((s,i)=>'<div class="cm-item '+(s.id===selectedSubtopicId?'active':'')+'" data-sub="'+esc(s.id)+'"><div style="width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--surface);border:1px solid var(--border);font-weight:900">'+(i+1)+'</div><div><strong>'+esc(s.title)+'</strong><span>'+esc(s.dur||'15 min')+' - '+esc(s.description||'No description')+' '+(s._database_id?'Synced':'Local')+'</span></div></div>').join('')||'<p class="cm-help">No subtopics yet.</p>')+'</div></div><div class="cm-card"><h3>Add Subtopic</h3><div class="cm-field"><label>Subtopic title</label><input id="cmSubTitle" placeholder="Enter subtopic title"></div><div class="cm-two"><div class="cm-field"><label>Duration</label><input id="cmSubDur" placeholder="20 min"></div><div class="cm-field"><label>Display order</label><input id="cmSubOrder" type="number" value="'+((c?.subtopics||[]).length+1)+'"></div></div><div class="cm-field"><label>Subtopic description</label><textarea id="cmSubDesc" placeholder="Brief description"></textarea></div><div class="cm-actions"><button class="cm-btn primary" id="cmAddSubtopic">Add to Database</button><button class="cm-btn danger" id="cmDeleteSubtopic">Delete from Database</button></div></div></div>';
    $('cmSubCourseSelect').onchange=e=>{creatingNewCourse=false; selectedCourseId=e.target.value;selectedSubtopicId=null;selectedSubtopicDatabaseId=null;renderAll();};
    el.querySelectorAll('[data-sub]').forEach(i=>i.onclick=()=>{selectedSubtopicId=i.dataset.sub; selectedSubtopicDatabaseId=null; renderAll();});
    $('cmAddSubtopicTop').onclick=()=>{ if($('cmSubTitle') && $('cmSubTitle').value.trim()) addSubtopic(); else $('cmSubTitle')&&$('cmSubTitle').focus(); };
    $('cmDeleteSubtopicTop').onclick=deleteSubtopic;
    $('cmAddSubtopic').onclick=addSubtopic;
    $('cmDeleteSubtopic').onclick=deleteSubtopic;
  }

  async function addSubtopic(){
    const title=$('cmSubTitle').value.trim(); if(!title) return alert('Subtopic title required');
    const c=selectedCourse(); if(!c) return alert('Select a course first');
    const fields = {
      title,
      slug: SoftmarcContent.slug(title),
      dur: $('cmSubDur').value.trim()||'15 min',
      description: $('cmSubDesc').value.trim(),
      display_order: Number($('cmSubOrder').value || (c.subtopics||[]).length + 1)
    };
    try {
      showStatus('Adding subtopic...');
      const courseId = c._database_id;
      if(!courseId) throw new Error('Save the course first.');
      await dbCreateSubtopic(courseId, fields);
      selectedSubtopicId = SoftmarcContent.slug(title);
      await renderAll();
      showStatus('Subtopic added!');
    } catch(err) {
      showError('Failed: '+err.message);
    }
  }

  async function deleteSubtopic(){
    const c=selectedCourse(); const st=selectedSubtopic();
    if(!c||!st) return;
    if(!confirm('Delete selected subtopic?')) return;
    try {
      showStatus('Deleting...');
      if(st._database_id) await dbDeleteSubtopic(st._database_id);
      selectedSubtopicId=null; selectedSubtopicDatabaseId=null;
      await renderAll();
      showStatus('Subtopic deleted.');
    } catch(err) {
      showError('Delete failed: '+err.message);
    }
  }

  function renderResources(){
    const el=$('cmPanelResources'); if(!el) return;
    const c=selectedCourse(); const st=selectedSubtopic();
    el.innerHTML='<div class="cm-quickbar"><button class="cm-btn primary" id="cmSaveVideoTop">Save Video</button><button class="cm-btn primary" id="cmSavePdfTop">Save PDF</button><button class="cm-btn primary" id="cmSaveExerciseTop">Save Exercise</button></div><div class="cm-card"><h3>Videos, PDF & Exercises</h3><div class="cm-two"><div class="cm-field"><label>Main topic</label><select id="cmResCourseSelect">'+courseOptions()+'</select></div><div class="cm-field"><label>Subtopic</label><select id="cmResSubSelect">'+subtopicOptions(c)+'</select></div></div>'+(st?'<div class="cm-resource-preview"><div class="cm-resource-box"><b>Video</b><span>'+esc(st.videoUrl||'Not added')+'</span></div><div class="cm-resource-box"><b>PDF</b><span>'+esc(st.pdfUrl||'Not added')+'</span></div><div class="cm-resource-box"><b>Exercise</b><span>'+(st.exercise?'Added':'Not added')+'</span></div></div><div class="cm-field"><label>Video URL / path</label><input id="cmVideoUrl" value="'+esc(st.videoUrl||'')+'" placeholder="Video URL or videos/lesson.mp4"><div class="cm-upload-row" style="margin-top:8px"><div><label style="display:block;font-size:12px;font-weight:800;color:var(--text-500);margin-bottom:4px">Or upload video file (up to 1 GB — needs a minute for big files, keep the page open)</label><input id="cmVideoFile" type="file" accept="video/*,.mp4,.webm,.ogg,.mov"></div></div></div><div class="cm-field"><label>PDF URL / path</label><input id="cmPdfUrl" value="'+esc(st.pdfUrl||'')+'" placeholder="pdfs/notes.pdf"><label style="display:block;font-size:12px;font-weight:800;color:var(--text-500);margin:8px 0 4px">Or upload PDF file (up to 1 GB)</label><input id="cmPdfFile" type="file" accept="application/pdf,.pdf"></div><div class="cm-field"><label>Exercise</label><textarea id="cmExercise">'+esc(st.exercise||'')+'</textarea></div><div class="cm-actions"><button class="cm-btn primary" id="cmSaveVideo">Save Video</button><button class="cm-btn primary" id="cmSavePdf">Save PDF</button><button class="cm-btn primary" id="cmSaveExercise">Save Exercise</button></div>':'<p class="cm-help">Add/select a subtopic first.</p>')+'</div>';
    $('cmResCourseSelect').onchange=e=>{creatingNewCourse=false; selectedCourseId=e.target.value;selectedSubtopicId=null;renderAll();};
    const vf=$('cmVideoFile'); if(vf) vf.onchange=startUpload('video','cmVideoUrl');
    const pf=$('cmPdfFile'); if(pf) pf.onchange=startUpload('pdf','cmPdfUrl');
    const subSel=$('cmResSubSelect'); if(subSel) subSel.onchange=e=>{selectedSubtopicId=e.target.value;renderAll();};
    ['cmSaveVideoTop','cmSaveVideo'].forEach(id=>{const b=$(id); if(b) b.onclick=()=>saveResources('video');});
    ['cmSavePdfTop','cmSavePdf'].forEach(id=>{const b=$(id); if(b) b.onclick=()=>saveResources('pdf');});
    ['cmSaveExerciseTop','cmSaveExercise'].forEach(id=>{const b=$(id); if(b) b.onclick=()=>saveResources('exercise');});
  }

  async function saveResources(type, forcedVal){
    const st=selectedSubtopic();
    if(!st) return alert('Select a subtopic first');
    if(type!=='exercise' && uploading[type]){ showStatus('⏳ '+type+' upload is still running — it will auto-save the moment it finishes. No need to press Save.'); return; }
    const fields = {};
    const readVal = id => { const el=$(id); return el ? el.value.trim() : ''; };
    if(type==='video') fields.video_url = (forcedVal !== undefined ? forcedVal : readVal('cmVideoUrl'));
    if(type==='pdf') fields.pdf_url = (forcedVal !== undefined ? forcedVal : readVal('cmPdfUrl'));
    if(type==='exercise') fields.exercise = readVal('cmExercise');
    try {
      showStatus('Saving...');
      if(st._database_id){
        await dbUpdateSubtopic(st._database_id, fields);
        showStatus('Resources saved!');
      } else {
        throw new Error('Save the subtopic first.');
      }
      await renderAll();
    } catch(err) {
      showError('Failed: '+err.message);
    }
  }

  build();

  const original=window.switchAdminTab;
  window.switchAdminTab=async function(tab){
    if(tab==='content'){
      document.querySelectorAll('.section-wrapper').forEach(s=>s.classList.remove('active'));
      document.querySelectorAll('.tabs .tab').forEach(t=>t.classList.remove('on'));
      $('secContent').classList.add('active'); $('tabBtnContent').classList.add('on');
      const title=$('adminHeaderTitle'); if(title) title.textContent='Course Manager';
      const sub=$('adminHeaderSub'); if(sub) sub.textContent='Add topics, subtopics, videos, PDFs';
      const add=$('openAddModal'); if(add) add.style.display='none';
      await renderAll(); return;
    }
    return original?original(tab):undefined;
  };
})();
