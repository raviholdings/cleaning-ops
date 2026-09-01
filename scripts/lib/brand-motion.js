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
