(function(){
  // =============================================================
  // SoftmarcContent — Course Content Manager
  // NOW WITH DATABASE SUPPORT
  // Priority: Database API → localStorage fallback → hardcoded
  // This ensures admin-added content is visible to ALL students.
  // =============================================================

  // v2 key: an older, poisoned cache must never be able to hide a file the trainer just added
  const KEY='softmarc_courses_v6';
  const MAX_CACHE_AGE=10*60*1000;   // localStorage is a stop-gap, not the source of truth
  const API_HOST='/api'; // Same origin on Vercel
  const API={};

  function slug(s){return String(s||'course').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')||('course-'+Date.now());}
  function uid(prefix){return prefix+'_'+Date.now()+'_'+Math.random().toString(36).slice(2,7);}

  function svgImage(title,tag){
    const safe=String(title||'Automotive Learning').replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
    const sub=String(tag||'CAD Learning').replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="520" viewBox="0 0 900 520"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#071A2F"/><stop offset=".55" stop-color="#0EA5E9"/><stop offset="1" stop-color="#14B8A6"/></linearGradient><linearGradient id="glass" x1="0" x2="1"><stop stop-color="#E0F2FE"/><stop offset="1" stop-color="#7DD3FC"/></linearGradient></defs><rect width="900" height="520" rx="38" fill="#0A1930"/><path d="M0 365C170 295 260 432 452 352C625 280 694 180 900 228V520H0Z" fill="url(#g)" opacity=".88"/><g transform="translate(158 158)"><ellipse cx="292" cy="202" rx="286" ry="34" fill="#020617" opacity=".23"/><path d="M82 166c19-49 68-70 145-77l62-43c24-16 51-24 82-24h82c43 0 79 18 107 51l54 61c49 5 84 30 97 69H36c8-19 24-31 46-37Z" fill="url(#g)"/><path d="M256 82l40-29c17-12 39-17 64-17h65c36 0 63 16 83 46H256Z" fill="#061B33" opacity=".9"/><path d="M302 51h70v72H226l30-41 46-31Z" fill="url(#glass)" opacity=".9"/><path d="M390 51h34c30 0 56 16 74 42l22 30H390Z" fill="#BAE6FD" opacity=".9"/><path d="M92 155c88-24 390-24 496 0" stroke="#fff" stroke-width="10" opacity=".32" stroke-linecap="round"/><circle cx="215" cy="200" r="45" fill="#020617"/><circle cx="215" cy="200" r="25" fill="#334155"/><circle cx="215" cy="200" r="10" fill="#E2E8F0"/><circle cx="520" cy="200" r="45" fill="#020617"/><circle cx="520" cy="200" r="25" fill="#334155"/><circle cx="520" cy="200" r="10" fill="#E2E8F0"/></g><text x="46" y="66" font-family="Inter,Arial" font-size="22" font-weight="800" fill="#fff">SOFTMARC LEARNING</text><text x="46" y="100" font-family="Inter,Arial" font-size="42" font-weight="900" fill="#fff">${safe}</text><text x="50" y="137" font-family="Inter,Arial" font-size="20" font-weight="700" fill="#BAE6FD">${sub} • Automotive design training</text></svg>`;
    return 'data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(svg)));
  }

  // There is deliberately NO hardcoded course list: if the database has no content yet,
  // the pages say so instead of showing demo videos and PDFs that a learner cannot watch.

  // Every course uses one self-referencing subtopic table. A topic can therefore have
  // as many child pages as it needs, at any depth. Only terminal pages are lessons.
  function topicDatabaseId(row){
    const value=row&&((row._database_id!==undefined&&row._database_id!==null)?row._database_id:((row.database_id!==undefined&&row.database_id!==null)?row.database_id:row.id));
    return (typeof value==='number'||(/^\d+$/.test(String(value||'')))) ? Number(value) : null;
  }
  function topicKey(row,index){
    const db=topicDatabaseId(row);
    return db!==null?'db:'+db:'key:'+(row&&row.id?String(row.id):slug((row&&row.title)||('subtopic-'+index))+'-'+index);
  }
  function parentTopicKey(row,all){
    const parent=row&&((row.parentSubtopicId!==undefined&&row.parentSubtopicId!==null&&row.parentSubtopicId!=='')?row.parentSubtopicId:row.parent_subtopic_id);
    if(parent===undefined||parent===null||parent==='') return null;
    const match=(all||[]).find(x=>Number(topicDatabaseId(x))===Number(parent));
    return match ? topicKey(match,all.indexOf(match)) : null;
  }
  function normaliseSubtopic(m,idx){
    const db=topicDatabaseId(m);
    const parent=(m&&((m.parentSubtopicId!==undefined&&m.parentSubtopicId!==null&&m.parentSubtopicId!=='')?m.parentSubtopicId:m.parent_subtopic_id));
    return {
      id:String((m&&m.id)!==undefined?(m.id):(db!==null?db:slug((m&&m.title)||('subtopic-'+idx)))),
      _database_id:db,
      parentSubtopicId:(parent===undefined||parent===null||parent==='')?null:Number(parent),
      mainTopic:(m&&((m.mainTopic!==undefined)?m.mainTopic:m.main_topic))||'',
      title:(m&&m.title)||('Subtopic '+(idx+1)),
      dur:(m&&(m.dur||m.duration))||'15 min',
      description:(m&&m.description)||'',
      videoUrl:(m&&(m.videoUrl||m.video_url))||'',
      pdfUrl:(m&&(m.pdfUrl||m.pdf_url))||'',
      resources:Array.isArray(m&&m.resources)?m.resources.map(r=>({id:r.id,title:r.title||'',resource_type:r.resource_type||r.type||'',file_url:r.file_url||r.url||'',display_order:r.display_order||0})):[],
      exercise:(m&&(m.exercise||m.exercise_instructions))||''
    };
  }
  function buildTopicStructure(rows){
    const all=(rows||[]).map((row,index)=>Object.assign({},row,{_topicKey:topicKey(row,index)}));
    const byKey=new Map(all.map(row=>[row._topicKey,row]));
    const children=new Map();
    all.forEach(row=>{
      const parent=parentTopicKey(row,all);
      if(parent&&parent!==row._topicKey&&byKey.has(parent)){
        if(!children.has(parent)) children.set(parent,[]);
        children.get(parent).push(row);
      }
    });
    const roots=all.filter(row=>{
      const parent=parentTopicKey(row,all);
      return !parent||parent===row._topicKey||!byKey.has(parent);
    });
    const leaves=all.filter(row=>!(children.get(row._topicKey)||[]).length);
    const leafIndex=new Map(leaves.map((row,index)=>[row._topicKey,index]));
    function nodeFor(row){
      const node=Object.assign({},row);
      const nested=(children.get(row._topicKey)||[]).map(nodeFor);
      delete node._topicKey;
      node.nodeKey=row._topicKey;
      node.children=nested;
      if(!nested.length) node.moduleIndex=leafIndex.get(row._topicKey);
      return node;
    }
    return { roots:roots.map(nodeFor), leaves:leaves.map((row,index)=>Object.assign({},row,{moduleIndex:index,nodeKey:row._topicKey})) };
  }

  function normaliseCourse(c,i){
    const title=c.title||c.name||'Untitled Course';
    const id=c.id||slug(title);
    const tag=c.tag||c.category||'Course';
    const source=c.subtopics||c.modulesList||c.modules||[];
    const structure=buildTopicStructure(source.map(normaliseSubtopic));
    return {
      id,title,slug:c.slug||slug(title),tag,
      short_description:c.short_description||c.description||`${title} automotive learning path`,
      description:c.description||c.short_description||'',
      duration_hours:Number(c.duration_hours||c.hours||18),
      level:c.level||'Beginner',
      image:c.image||c.preview_image||c.banner_image||svgImage(title,tag),
      status:c.status||'active',
      display_order:c.display_order??i,
      // Flat terminal lessons power existing lesson/progress URLs. topicTree powers unlimited navigation pages.
      subtopics:structure.leaves,
      topicTree:structure.roots,
      mainSubtopics:structure.roots,
      assessments:c.assessments||[]
    };
  }

  // Convert Database row format to the common unlimited-depth tree format.
  function databaseToInternal(courseRow){
    const structure=buildTopicStructure((courseRow.subtopics||[]).map(normaliseSubtopic));
    return {
      id: courseRow.slug || slug(courseRow.title), _database_id: courseRow.id, title: courseRow.title, slug: courseRow.slug,
      tag: courseRow.tag || 'Course', short_description: courseRow.short_description || '', description: courseRow.description || courseRow.short_description || '',
      duration_hours: courseRow.duration_hours || 10, level: courseRow.level || 'Beginner', image: courseRow.image || svgImage(courseRow.title, courseRow.tag),
      status: courseRow.status || 'active', display_order: courseRow.display_order || 0,
      subtopics:structure.leaves, topicTree:structure.roots, mainSubtopics:structure.roots, assessments: []
    };
  }

  function fallbackToCourses(courseData,defs){
    // only ever used for the legacy demo pages that still pass their own literal list
    if(courseData && typeof courseData==='object'){
      return Object.keys(courseData).map((name,i)=>{
        const def=(defs||[]).find(d=>d.name===name)||{};
        return normaliseCourse({id:slug(name),title:name,tag:def.tag,duration_hours:def.hours,subtopics:(courseData[name]||[])},i);
      });
    }
    return [];
  }

  // =============================================================
  // MAIN: getCourses — NOW TRIES DATABASE FIRST
  // =============================================================
  let _coursesCache = null;
  let _fetchPromise = null;
  let _fromDatabase = false;      // true once the rows came from the server, not from this device
  let _settled = null;            // resolve() of the promise ready() hands out
  const settled = new Promise(res => { _settled = res; });

  API.getCourses = function(courseData, defs){
    // Once the database has answered, including with an empty catalogue, that answer wins.
    if(_fromDatabase && Array.isArray(_coursesCache)) return _coursesCache;
    if(_coursesCache && _coursesCache.length) return _coursesCache;

    // Try localStorage as immediate fallback (so page renders fast)
    try{
      const saved=JSON.parse(localStorage.getItem(KEY)||'null');
      const rows=Array.isArray(saved)?saved:(saved&&Array.isArray(saved.courses)?saved.courses:null);
      const fresh=!saved||!saved.at||(Date.now()-saved.at)<MAX_CACHE_AGE;
      if(Array.isArray(rows) && rows.length && fresh){
        // paint from the device copy now, but it is provisional — ready() waits for the server
        _coursesCache = rows.map(normaliseCourse).sort((a,b)=>(a.display_order||0)-(b.display_order||0));
        API._fetchFromDatabase(courseData, defs);
        return _coursesCache;
      }
      if(Array.isArray(rows) && rows.length && !fresh) console.warn('[SoftmarcContent] local copy is older than 10 min — waiting for the server');
    }catch(e){}

    // Use hardcoded fallback
    _coursesCache = fallbackToCourses(courseData, defs);
    // Fetch from Database in background
    API._fetchFromDatabase(courseData, defs);
    return _coursesCache;
  };

  // Background fetch from Database — updates cache and localStorage
  API._fetchFromDatabase = function(courseData, defs){
    if(_fetchPromise) return _fetchPromise;

    _fetchPromise = fetch(`${API_HOST}/courses.php`)
      .then(res => {
        if(!res.ok) throw new Error('API failed');
        return res.json();
      })
      .then(courses => {
        if(Array.isArray(courses) && courses.length > 0){
          // Convert Database format to internal format
          _coursesCache = courses.map(databaseToInternal).sort((a,b)=>(a.display_order||0)-(b.display_order||0));
          _fromDatabase = true;
          // Update localStorage cache (with the time it was taken)
          try{ localStorage.setItem(KEY, JSON.stringify({at:Date.now(), courses:_coursesCache})); }catch(e){}
          console.log(`[SoftmarcContent] Loaded ${_coursesCache.length} courses from Database`);

          // Dispatch event so pages can re-render
          window.dispatchEvent(new CustomEvent('softmarc-courses-uploaded', { detail: _coursesCache }));
        } else {
          // An empty database is an authoritative answer, never a reason to keep rendering an
          // old localStorage or hardcoded catalogue from a previous session.
          _coursesCache = [];
          _fromDatabase = true;
          try{ localStorage.setItem(KEY, JSON.stringify({at:Date.now(), courses:[]})); }catch(e){}
          window.dispatchEvent(new CustomEvent('softmarc-courses-uploaded', { detail: [] }));
          console.log('[SoftmarcContent] Database has no courses yet');
        }
      })
      .catch(err => {
        console.warn('[SoftmarcContent] Database fetch failed, using cached/fallback:', err.message);
      })
      .finally(() => {
        _fetchPromise = null;
        if(_settled){ _settled(); _settled = null; }
      });
  };

  // Force refresh from Database (call after admin saves)
  API.refreshFromDatabase = function(){
    _fetchPromise = null;
    _coursesCache = null;
    _fromDatabase = false;
    return API._fetchFromDatabase();
  };

  // Pages await this before they lock anything in: it resolves once the server answer
  // has arrived (or failed), so a trainer's new video is never hidden by this device's copy.
  API.ready = function(timeoutMs){
    if(_fromDatabase) return Promise.resolve(_coursesCache||[]);
    API._fetchFromDatabase();
    const t=Math.max(500,timeoutMs||4000);
    return Promise.race([
      settled.then(()=>_coursesCache||[]),
      new Promise(res=>setTimeout(()=>res(_coursesCache||[]),t))
    ]);
  };
  API.fromDatabase = function(){ return _fromDatabase; };

  // a course by title, case/space insensitive, or by slug
  API.findCourse = function(nameOrSlug){
    const want=String(nameOrSlug||'').trim().toLowerCase().replace(/\s+/g,' ');
    const list=API.getCourses()||[];
    return list.find(c=>String(c.title||'').trim().toLowerCase().replace(/\s+/g,' ')===want)
        || list.find(c=>slug(c.title)===slug(nameOrSlug))
        || list.find(c=>String(c.id||'').toLowerCase()===want)
        || null;
  };

  API.saveCourses = function(courses){
    const out=(courses||[]).map(normaliseCourse);
    _coursesCache = out;
    localStorage.setItem(KEY,JSON.stringify(out));
    return out;
  };

  API.newId=uid; API.slug=slug; API.defaultImage=svgImage; API.storageKey=KEY;

  API.getCourseDataObject=function(fallbackCourseData){
    const obj={};
    API.getCourses(fallbackCourseData).forEach(c=>{
      const rows=c.subtopics.map(st=>({
        title:st.title,mainTopic:st.mainTopic||'',parentSubtopicId:st.parentSubtopicId||null,dur:st.dur,videoUrl:st.videoUrl,pdfUrl:st.pdfUrl,resources:st.resources||[],exercise:st.exercise,description:st.description,
        _sub_id:st._database_id||null
      }));
      obj[c.title]=rows;
      const k=slug(c.title);
      if(!(k in obj)) obj[k]=rows;   // links built from the slug work too
    });
    return obj;
  };

  API.getCourseDefs=function(fallbackDefs,fallbackCourseData){
    return API.getCourses(fallbackCourseData,fallbackDefs).map((c,i)=>({
      name:c.title,tag:c.tag,modules:c.subtopics.length,hours:c.duration_hours,
      banner:['🏆','🌟','🏅','🎖','⭐','📏'][i%6],
      code:(c.tag||c.title).replace(/[^A-Z0-9]/gi,'').slice(0,3).toUpperCase()||'SMC',
      image:c.image,description:c.short_description,level:c.level,id:c.id
    }));
  };

  API.getAssessments=function(fallback){
    const local=[];
    API.getCourses().forEach(c=>(c.assessments||[]).forEach((a,idx)=>local.push({
      id:a.id||(`${c.id}-assessment-${idx}`),title:a.title||`${c.title} Assessment`,
      course_name:c.title,local:true,questions:a.questions||[]
    })));
    return local.length ? local : (fallback||[]);
  };

  window.SoftmarcContent=API;
})();
