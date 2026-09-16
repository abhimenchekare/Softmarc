(function(){
  // =============================================================
  // SoftmarcContent — Course Content Manager
  // NOW WITH SUPABASE SUPPORT
  // Priority: Supabase API → localStorage fallback → hardcoded
  // This ensures admin-added content is visible to ALL students.
  // =============================================================

  const KEY='softmarc_courses_v1';
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

  // Hardcoded fallback (only used if Supabase AND localStorage are empty)
  const builtIn=[
    {id:'catia-v5-part-design',title:'CATIA V5 Part Design',tag:'Part Design',short_description:'Automotive solid modelling, sketches, dress-up features and capstone.',duration_hours:18,level:'Beginner',image:null,subtopics:[{id:'sketcher',title:'Sketcher Workbench & Constraints',dur:'20 min',description:'2D profiles and constraints',videoUrl:'videos/Your_First_Design_Project (1) 1.mp4',pdfUrl:'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',exercise:'Create a fully constrained L-bracket sketch.'}],assessments:[]},
    {id:'catia-assembly-design',title:'CATIA Assembly Design',tag:'Assembly',short_description:'Product structure, constraints, clash checks and BOM workflow.',duration_hours:14,level:'Intermediate',image:null,subtopics:[{id:'assembly-overview',title:'Assembly Workbench Overview',dur:'15 min',description:'Assembly UI and product structure',videoUrl:'videos/Your_First_Design_Project (1) 1.mp4',pdfUrl:'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',exercise:'Create a new Product with three parts.'}],assessments:[]}
  ];

  function normaliseCourse(c,i){
    const title=c.title||c.name||'Untitled Course';
    const id=c.id||slug(title);
    const tag=c.tag||c.category||'Course';
    const subs=(c.subtopics||c.modulesList||c.modules||[]).map((m,idx)=>({
      id:m.id||slug(m.title||('subtopic-'+idx)),
      title:m.title||('Subtopic '+(idx+1)),
      dur:m.dur||m.duration||'15 min',
      description:m.description||'',
      videoUrl:m.videoUrl||m.video_url||'',
      pdfUrl:m.pdfUrl||m.pdf_url||'',
      exercise:m.exercise||m.exercise_instructions||''
    }));
    return {
      id,title,slug:c.slug||slug(title),tag,
      short_description:c.short_description||c.description||`${title} automotive learning path`,
      description:c.description||c.short_description||'',
      duration_hours:Number(c.duration_hours||c.hours||18),
      level:c.level||'Beginner',
      image:c.image||c.preview_image||c.banner_image||svgImage(title,tag),
      status:c.status||'active',
      display_order:c.display_order??i,
      subtopics:subs,
      assessments:c.assessments||[]
    };
  }

  // Convert Supabase row format to our internal format
  function supabaseToInternal(courseRow){
    const subs=(courseRow.subtopics||[]).map(s=>({
      id: s.slug || slug(s.title),
      title: s.title,
      dur: s.dur || '15 min',
      description: s.description || '',
      videoUrl: s.video_url || '',
      pdfUrl: s.pdf_url || '',
      exercise: s.exercise || '',
      // Keep Supabase IDs for updates
      _supabase_id: s.id
    }));
    return {
      id: courseRow.slug || slug(courseRow.title),
      _supabase_id: courseRow.id,
      title: courseRow.title,
      slug: courseRow.slug,
      tag: courseRow.tag || 'Course',
      short_description: courseRow.short_description || '',
      description: courseRow.description || '',
      duration_hours: courseRow.duration_hours || 10,
      level: courseRow.level || 'Beginner',
      image: courseRow.image || svgImage(courseRow.title, courseRow.tag),
      status: courseRow.status || 'active',
      display_order: courseRow.display_order || 0,
      subtopics: subs,
      assessments: []
    };
  }

  function fallbackToCourses(courseData,defs){
    if(courseData && typeof courseData==='object'){
      return Object.keys(courseData).map((name,i)=>{
        const def=(defs||[]).find(d=>d.name===name)||{};
        return normaliseCourse({id:slug(name),title:name,tag:def.tag,duration_hours:def.hours,subtopics:(courseData[name]||[])},i);
      });
    }
    return builtIn.map(normaliseCourse);
  }

  // =============================================================
  // MAIN: getCourses — NOW TRIES SUPABASE FIRST
  // =============================================================
  let _coursesCache = null;
  let _fetchPromise = null;

  API.getCourses = function(courseData, defs){
    // If we already have cached courses from Supabase, return them
    if(_coursesCache && _coursesCache.length) return _coursesCache;

    // Try localStorage as immediate fallback (so page renders fast)
    try{
      const saved=JSON.parse(localStorage.getItem(KEY)||'null');
      if(Array.isArray(saved) && saved.length){
        _coursesCache = saved.map(normaliseCourse).sort((a,b)=>(a.display_order||0)-(b.display_order||0));
        // Still fetch from Supabase in background to get latest
        API._fetchFromSupabase(courseData, defs);
        return _coursesCache;
      }
    }catch(e){}

    // Use hardcoded fallback
    _coursesCache = fallbackToCourses(courseData, defs);
    // Fetch from Supabase in background
    API._fetchFromSupabase(courseData, defs);
    return _coursesCache;
  };

  // Background fetch from Supabase — updates cache and localStorage
  API._fetchFromSupabase = function(courseData, defs){
    if(_fetchPromise) return _fetchPromise;

    _fetchPromise = fetch(`${API_HOST}/courses.php`)
      .then(res => {
        if(!res.ok) throw new Error('API failed');
        return res.json();
      })
      .then(courses => {
        if(Array.isArray(courses) && courses.length > 0){
          // Convert Supabase format to internal format
          _coursesCache = courses.map(supabaseToInternal).sort((a,b)=>(a.display_order||0)-(b.display_order||0));
          // Update localStorage cache
          try{ localStorage.setItem(KEY, JSON.stringify(_coursesCache)); }catch(e){}
          console.log(`[SoftmarcContent] Loaded ${_coursesCache.length} courses from Supabase`);

          // Dispatch event so pages can re-render
          window.dispatchEvent(new CustomEvent('softmarc-courses-uploaded', { detail: _coursesCache }));
        } else {
          console.log('[SoftmarcContent] Supabase returned 0 courses, using fallback');
        }
      })
      .catch(err => {
        console.warn('[SoftmarcContent] Supabase fetch failed, using cached/fallback:', err.message);
      })
      .finally(() => {
        _fetchPromise = null;
      });
  };

  // Force refresh from Supabase (call after admin saves)
  API.refreshFromSupabase = function(){
    _fetchPromise = null;
    _coursesCache = null;
    return API._fetchFromSupabase();
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
      obj[c.title]=c.subtopics.map(st=>({
        title:st.title,dur:st.dur,videoUrl:st.videoUrl,pdfUrl:st.pdfUrl,exercise:st.exercise,description:st.description
      }));
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
