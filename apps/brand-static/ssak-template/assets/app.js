/* 싹쓰리배관 스크립트 — 시도/시군구 연동 · 접수 폼 · 동의 전문 */

/* 시/도 -> 시/군/구.
   표는 빌드 때 data/hub/regions.json 에서 심는다. 페이지에 적힌 지역명과
   폼의 선택지가 서로 다르면 접수 주소가 어긋나므로 출처를 하나로 둔다. */
var REGION_MAP = /*@REGION_MAP@*/ {};

(function(){
  function fill(select, items, selected){
    if(!select) return;
    select.textContent="";
    var ph=document.createElement("option");
    ph.value=""; ph.textContent=select.dataset.regionPlaceholder||"시/군/구 선택";
    select.appendChild(ph);
    for(var i=0;i<items.length;i++){
      var o=document.createElement("option");
      o.value=items[i]; o.textContent=items[i];
      if(items[i]===selected) o.selected=true;
      select.appendChild(o);
    }
  }
  function fillSido(select, selected){
    if(!select) return;
    select.textContent="";
    var ph=document.createElement("option");
    ph.value=""; ph.textContent="시/도 선택";
    select.appendChild(ph);
    var keys=Object.keys(REGION_MAP);
    for(var i=0;i<keys.length;i++){
      var o=document.createElement("option");
      o.value=keys[i]; o.textContent=keys[i];
      if(keys[i]===selected) o.selected=true;
      select.appendChild(o);
    }
  }
  var forms=document.querySelectorAll("[data-lead-form]");
  for(var f=0;f<forms.length;f++){
    var sido=forms[f].querySelector("[data-region-sido]");
    var sgg=forms[f].querySelector("[data-region-sigungu]");
    if(!sido||!sgg) continue;
    // 지역 페이지는 그 지역이 이미 골라진 채로 열린다.
    var preSido=sido.dataset.selectedSido||"";
    var preSgg=sgg.dataset.selectedSigungu||"";
    fillSido(sido, preSido);
    fill(sgg, REGION_MAP[preSido]||[], preSgg);
  }
  document.addEventListener("change",function(e){
    var t=e.target;
    if(!t||!t.matches||!t.matches("[data-region-sido]")) return;
    var form=t.closest("[data-lead-form]");
    if(!form) return;
    fill(form.querySelector("[data-region-sigungu]"), REGION_MAP[t.value]||[], "");
  });
})();

/* 접수 폼 제출. 실패해도 전화번호는 화면에 그대로 있다. */
(function(){
  function area(form,d){
    var parts=[];
    var a=String(d.get("sido")||"").trim();
    var b=String(d.get("sigungu")||"").trim();
    var c=String(d.get("address")||"").replace(/\s+/g," ").trim();
    if(a) parts.push(a);
    if(b && b!==a) parts.push(b);
    if(c) parts.push(c);
    return parts.length?parts.join(" "):(form.dataset.area||"");
  }
  document.addEventListener("submit",async function(e){
    var form=e.target instanceof HTMLFormElement?e.target:null;
    if(!form||!form.matches("[data-lead-form]")) return;
    e.preventDefault();
    var status=form.querySelector("[data-lead-status]");
    var send=form.querySelector("[data-lead-submit]");
    var d=new FormData(form);
    var payload={
      project:form.dataset.project||"",
      area:area(form,d),
      name:String(d.get("name")||"").trim(),
      phone:String(d.get("phone")||"").replace(/\D+/g,""),
      message:String(d.get("message")||"").trim(),
      consent:d.get("consent")==="true",
      company:String(d.get("company")||""),
      pageUrl:window.location.href,
      referrer:document.referrer,
      sourceDomain:window.location.hostname
    };
    function say(m,kind){ if(status){status.textContent=m;status.dataset.kind=kind||"";} }
    function stop(m,sel){ say(m,"error"); var el=form.querySelector(sel); if(el) el.focus(); }

    if(payload.name.length<2) return stop("성함을 적어주세요.","[name='name']");
    if(payload.phone.length<9||payload.phone.length>11) return stop("연락처를 다시 확인해 주세요.","[name='phone']");
    if(!payload.message) return stop("어디가 어떻게 막혔는지 적어주세요.","[name='message']");
    if(!payload.consent) return stop("개인정보 수집·이용에 동의해 주세요.","[name='consent']");

    say("접수하고 있습니다.","loading");
    if(send) send.disabled=true;
    try{
      var res=await fetch(form.dataset.leadApi||"/api/lead",{
        method:"POST",mode:"cors",
        headers:{"content-type":"application/json"},
        body:JSON.stringify(payload)
      });
      var body=await res.json().catch(function(){return {};});
      if(!res.ok||body.ok===false) throw new Error(body.error||"접수 처리 중 문제가 생겼습니다.");
      form.reset();
      say("접수됐습니다. 확인하는 대로 연락드리겠습니다.","success");
    }catch(err){
      var m=err instanceof Error?err.message:"";
      if(/failed to fetch|networkerror|load failed/i.test(m)){
        m="연결에 실패했습니다. 새로고침 후 다시 시도하시거나 전화 주세요.";
      }
      say(m||"접수 처리 중 문제가 생겼습니다.","error");
    }finally{
      if(send) send.disabled=false;
    }
  });
})();

/* 동의 전문 모달. <dialog> 를 못 쓰는 브라우저에서는 열리지 않을 뿐,
   동의 자체는 체크박스로 이뤄지므로 접수는 막히지 않는다. */
(function(){
  var modal=document.querySelector("[data-terms-modal]");
  if(!modal) return;
  document.addEventListener("click",function(e){
    if(!e.target.closest) return;
    if(e.target.closest("[data-terms-open]")){
      e.preventDefault(); e.stopPropagation();
      if(modal.showModal) modal.showModal();
      return;
    }
    if(e.target.closest("[data-terms-close]")) modal.close();
  });
  modal.addEventListener("click",function(e){ if(e.target===modal) modal.close(); });
})();

/* 순차 노출(스태거).
   구역이 화면에 들어오면 그 안의 항목이 차례로 올라온다. 하나하나에 흩뿌린
   마이크로인터랙션보다 이쪽이 훨씬 눈에 들어온다.
   - 모션을 줄인 설정이면 아무것도 하지 않는다(원래 보이는 상태로 둔다).
   - IntersectionObserver 가 없는 브라우저에서도 그냥 보인다. */
(function(){
  if(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if(!("IntersectionObserver" in window)) return;

  var SEL=".flyer,.rflyer,.boxes>div,.head,.sub,.box,.tab>div,.qs>div,"+
          ".hoodz,.shots figure,.grp,.memo,.lead-form,.last";
  var nodes=document.querySelectorAll(SEL);
  if(!nodes.length) return;

  // 같은 부모 안에서 몇 번째인지로 지연을 준다. 길게 늘어지지 않게 8개에서 끊는다.
  var seen=new Map();
  for(var i=0;i<nodes.length;i++){
    var el=nodes[i], p=el.parentNode;
    var n=seen.get(p)||0; seen.set(p,n+1);
    el.style.setProperty("--i", Math.min(n,8));
    el.classList.add("rv");
  }
  var io=new IntersectionObserver(function(entries){
    for(var j=0;j<entries.length;j++){
      if(!entries[j].isIntersecting) continue;
      entries[j].target.classList.add("in");
      io.unobserve(entries[j].target);
    }
  },{rootMargin:"0px 0px -12% 0px",threshold:.08});
  for(var k=0;k<nodes.length;k++) io.observe(nodes[k]);
})();

/* 브랜드 사이트 공통 인터랙션 — apex(apps/apex-static) 와 같은 방식.

   1) 스태거드 리빌 — 형제 순번만큼 지연을 줘 한 덩어리가 차례로 올라온다.
      흩뿌린 마이크로인터랙션보다 이쪽이 눈에 들어온다.
   2) 떠 있는 전화 버튼(FAB) — 데스크톱에서만. 모바일은 하단 고정 바가 있다.
   3) 헤더 축소 — 스크롤하면 헤더가 얇아진다.

   전부 자바스크립트가 없어도 화면이 멀쩡해야 한다. 그래서 숨기는 일은
   .js 클래스가 붙은 뒤에만 한다(스크립트가 돌았다는 뜻).
   prefers-reduced-motion 이면 아무것도 움직이지 않는다. */
(function () {
  var root = document.documentElement;
  var reduce = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── 1. 스태거드 리빌 ── */
  var SEL = 'section > .wrap > *, .hero, .flyer, .rflyer, .herobox, .sign, .rsign,'
    + ' .stats > div, .boxes > div, .notes > div, .plaques > div';
  var items = [];
  try { items = Array.prototype.slice.call(document.querySelectorAll(SEL)); } catch (e) { items = []; }

  if (items.length && !reduce && 'IntersectionObserver' in window) {
    root.classList.add('js');
    for (var i = 0; i < items.length; i++) items[i].setAttribute('data-reveal', '');
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var el = e.target;
        var sibs = el.parentNode
          ? el.parentNode.querySelectorAll(':scope > [data-reveal]') : [];
        var idx = Array.prototype.indexOf.call(sibs, el);
        el.style.setProperty('--d', (idx > 0 ? Math.min(idx, 8) * 0.07 : 0) + 's');
        el.classList.add('in');
        io.unobserve(el);
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });
    for (var j = 0; j < items.length; j++) io.observe(items[j]);
  }

  /* ── 2. 떠 있는 전화 버튼 ── */
  var tel = document.querySelector('a.call[href^="tel:"]');
  if (tel && !document.querySelector('.fab')) {
    var fab = document.createElement('a');
    fab.className = 'fab';
    fab.href = tel.getAttribute('href');
    fab.setAttribute('aria-label', '전화 상담');
    fab.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" '
      + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.4-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>'
      + '</svg><span class="fab-t">' + (tel.textContent || '').trim() + '</span>';
    document.body.appendChild(fab);
  }

  /* ── 3. 헤더 축소 ── */
  var header = document.querySelector('header');
  if (header) {
    var last = -1;
    var onScroll = function () {
      var y = window.pageYOffset > 40 ? 1 : 0;
      if (y === last) return;
      last = y;
      header.classList.toggle('shrunk', !!y);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
})();
