/* 배관 랜딩 스크립트 — 앵커 이동 · FAQ 토글 · 시도/시군구 연동 · 자체 DB폼 제출 · 이미지 캐러셀 */
/*
 * 페이지 안 앵커(#estimate 등)로 이동할 때 주소창에 해시를 남기지 않는다.
 * href 는 그대로 둬서 자바스크립트가 없는 환경에서도 이동은 된다.
 */
(function(){
  document.addEventListener('click', function(event){
    var link = event.target && event.target.closest ? event.target.closest('a[href^="#"]') : null;
    if(!link) return;
    var id = link.getAttribute('href').slice(1);
    if(!id) return;
    var target = document.getElementById(id);
    if(!target) return;
    event.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
})();
(function(){
  var btns=document.querySelectorAll("[data-faq-btn]");
  for(var i=0;i<btns.length;i++){
    btns[i].addEventListener("click",function(){
      var panel=this.nextElementSibling;
      if(!panel) return;
      if(panel.classList.contains("d-none")) panel.classList.remove("d-none");
      else panel.classList.add("d-none");
    });
  }
})();
(function(){
  var regionMap={"서울":["종로구","중구","용산구","성동구","광진구","동대문구","중랑구","성북구","강북구","도봉구","노원구","은평구","서대문구","마포구","양천구","강서구","구로구","금천구","영등포구","동작구","관악구","서초구","강남구","송파구","강동구"],"부산":["중구","서구","동구","영도구","부산진구","동래구","남구","북구","해운대구","사하구","금정구","강서구","연제구","수영구","사상구","기장군"],"대구":["중구","동구","서구","남구","북구","수성구","달서구","달성군","군위군"],"인천":["중구","동구","미추홀구","연수구","남동구","부평구","계양구","서구","강화군","옹진군"],"광주":["동구","서구","남구","북구","광산구"],"대전":["동구","중구","서구","유성구","대덕구"],"울산":["중구","남구","동구","북구","울주군"],"세종":["세종시"],"경기":["수원시","수원시 장안구","수원시 권선구","수원시 팔달구","수원시 영통구","성남시","성남시 수정구","성남시 중원구","성남시 분당구","의정부시","안양시","안양시 만안구","안양시 동안구","부천시","부천시 원미구","부천시 소사구","부천시 오정구","광명시","평택시","동두천시","안산시","안산시 상록구","안산시 단원구","고양시","고양시 덕양구","고양시 일산동구","고양시 일산서구","과천시","구리시","남양주시","오산시","시흥시","군포시","의왕시","하남시","용인시","용인시 처인구","용인시 기흥구","용인시 수지구","파주시","이천시","안성시","김포시","화성시","광주시","양주시","포천시","여주시","연천군","가평군","양평군"],"강원":["춘천시","원주시","강릉시","동해시","태백시","속초시","삼척시","홍천군","횡성군","영월군","평창군","정선군","철원군","화천군","양구군","인제군","고성군","양양군"],"충북":["청주시","청주시 상당구","청주시 서원구","청주시 흥덕구","청주시 청원구","충주시","제천시","보은군","옥천군","영동군","증평군","진천군","괴산군","음성군","단양군"],"충남":["천안시","천안시 동남구","천안시 서북구","공주시","보령시","아산시","서산시","논산시","계룡시","당진시","금산군","부여군","서천군","청양군","홍성군","예산군","태안군"],"전북":["전주시","전주시 완산구","전주시 덕진구","군산시","익산시","정읍시","남원시","김제시","완주군","진안군","무주군","장수군","임실군","순창군","고창군","부안군"],"전남":["목포시","여수시","순천시","나주시","광양시","담양군","곡성군","구례군","고흥군","보성군","화순군","장흥군","강진군","해남군","영암군","무안군","함평군","영광군","장성군","완도군","진도군","신안군"],"경북":["포항시","포항시 남구","포항시 북구","경주시","김천시","안동시","구미시","영주시","영천시","상주시","문경시","경산시","의성군","청송군","영양군","영덕군","청도군","고령군","성주군","칠곡군","예천군","봉화군","울진군","울릉군"],"경남":["창원시","창원시 의창구","창원시 성산구","창원시 마산합포구","창원시 마산회원구","창원시 진해구","진주시","통영시","사천시","김해시","밀양시","거제시","양산시","의령군","함안군","창녕군","고성군","남해군","하동군","산청군","함양군","거창군","합천군"],"제주":["제주시","서귀포시"]};
  function fillSigungu(select, items, selected){
    if(!select) return;
    var previous=selected || select.value || select.dataset.selectedSigungu || "";
    select.textContent="";
    var placeholder=document.createElement("option");
    placeholder.value="";
    placeholder.textContent=select.dataset.regionPlaceholder || "시/군/구 선택";
    select.appendChild(placeholder);
    for(var i=0;i<items.length;i++){
      var option=document.createElement("option");
      option.value=items[i];
      option.textContent=items[i];
      if(items[i]===previous) option.selected=true;
      select.appendChild(option);
    }
    if(previous && items.indexOf(previous)===-1) select.value="";
    select.dataset.selectedSigungu="";
  }
  function syncRegionForm(form){
    if(!form) return;
    var sido=form.querySelector("[data-region-sido]");
    var sigungu=form.querySelector("[data-region-sigungu]");
    if(!sido || !sigungu) return;
    fillSigungu(sigungu, regionMap[sido.value] || [], sigungu.value || sigungu.dataset.selectedSigungu || "");
  }
  var regionForms=document.querySelectorAll("[data-lead-form]");
  for(var r=0;r<regionForms.length;r++) syncRegionForm(regionForms[r]);
  document.addEventListener("change",function(event){
    var target=event.target;
    if(!target || !target.matches || !target.matches("[data-region-sido]")) return;
    var form=target.closest("[data-lead-form]");
    if(!form) return;
    var sigungu=form.querySelector("[data-region-sigungu]");
    fillSigungu(sigungu, regionMap[target.value] || [], "");
  });
})();
(function(){
  function buildSubmittedArea(form,data){
    var sido=String(data.get("sido") || "").trim();
    var sigungu=String(data.get("sigungu") || "").trim();
    var address=String(data.get("address") || "").replace(/\s+/g," ").trim();
    var areaInput=String(data.get("area") || "").replace(/\s+/g," ").trim();
    var parts=[];
    if(sido==="세종" && sigungu==="세종시") parts.push("세종특별자치시");
    else {
      if(sido) parts.push(sido);
      if(sigungu) parts.push(sigungu);
    }
    if(address) parts.push(address);
    if(parts.length) return parts.join(" ");
    return areaInput || form.dataset.area || "";
  }
  document.addEventListener("submit",async function(event){
    var form=event.target instanceof HTMLFormElement ? event.target : null;
    if(!form || !form.matches("[data-lead-form]")) return;
    event.preventDefault();
    var status=form.querySelector("[data-lead-status]");
    var submit=form.querySelector("[data-lead-submit]");
    var data=new FormData(form);
    var payload={
      project:form.dataset.project || "piping-ravi",
      area:buildSubmittedArea(form,data),
      name:String(data.get("name") || "").trim(),
      phone:String(data.get("phone") || "").replace(/\D+/g,""),
      message:String(data.get("message") || "").trim(),
      consent:data.get("consent")==="true",
      company:String(data.get("company") || ""),
      pageUrl:window.location.href,
      referrer:document.referrer,
      sourceDomain:window.location.hostname
    };
    function setStatus(message,kind){
      if(!status) return;
      status.textContent=message;
      status.dataset.kind=kind || "";
    }
    if(payload.name.length<2){
      setStatus("이름을 입력해 주세요.","error");
      form.querySelector("[name='name']")?.focus();
      return;
    }
    if(payload.phone.length<9 || payload.phone.length>11){
      setStatus("연락처를 정확히 입력해 주세요.","error");
      form.querySelector("[name='phone']")?.focus();
      return;
    }
    if(!payload.message){
      setStatus("문의내용을 입력해 주세요.","error");
      form.querySelector("[name='message']")?.focus();
      return;
    }
    if(!payload.consent){
      setStatus("개인정보 수집 및 이용에 동의해 주세요.","error");
      form.querySelector("[name='consent']")?.focus();
      return;
    }
    var endpoint=form.dataset.leadApi || "/api/lead";
    setStatus("상담 신청을 접수하고 있습니다.","loading");
    if(submit) submit.disabled=true;
    try{
      var response=await fetch(endpoint,{method:"POST",mode:"cors",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
      var body=await response.json().catch(function(){return {};});
      if(!response.ok || body.ok===false) throw new Error(body.error || "상담 신청 처리 중 문제가 발생했습니다.");
      form.reset();
      setStatus("상담 신청이 접수되었습니다. 순차적으로 연락드리겠습니다.","success");
    }catch(error){
      var message=error instanceof Error ? error.message : "";
      if(/failed to fetch|networkerror|load failed/i.test(message)){
        message="상담 신청 서버 연결에 실패했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.";
      }
      setStatus(message || "상담 신청 처리 중 문제가 발생했습니다.","error");
    }finally{
      if(submit) submit.disabled=false;
    }
  });
})();

/* 개인정보 동의 전문 모달. <dialog> 를 못 쓰는 브라우저에서는 그냥 열리지 않는다
   — 동의 자체는 체크박스로 이뤄지므로 접수는 막히지 않는다. */
(function(){
  var modal=document.querySelector("[data-terms-modal]");
  if(!modal) return;
  document.addEventListener("click",function(e){
    var open=e.target.closest?e.target.closest("[data-terms-open]"):null;
    if(open){
      e.preventDefault();
      e.stopPropagation();           // <label> 안에 있어 체크박스가 토글되지 않게
      if(modal.showModal) modal.showModal();
      return;
    }
    if(e.target.closest&&e.target.closest("[data-terms-close]")) modal.close();
  });
  // 배경(백드롭) 클릭으로 닫기
  modal.addEventListener("click",function(e){ if(e.target===modal) modal.close(); });
})();
