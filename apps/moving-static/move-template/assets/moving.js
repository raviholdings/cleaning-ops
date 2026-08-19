/*
 * 청소 랜딩페이지 공용 스크립트.
 *
 * 예전에는 이 내용이 페이지마다 통째로 박혀 나갔다. 100만 페이지면 같은
 * 코드가 100만 번 복제된 셈이라, 디스크와 크롤링 대역폭을 그만큼 먹었다.
 * 홈과 하위 페이지가 쓰는 게 달라서 둘을 합쳤다. 대상 요소가 없으면
 * 각 블록이 바로 빠져나가므로 어느 쪽에 실려도 안전하다.
 */

/*
 * 갤러리 4칸 순환을 뺐다.
 *
 * 4.2초마다 칸마다 시차를 두고 사진이 페이드로 바뀌었다. 화면이 계속
 * 깜빡이는 것처럼 보여서 운영자 지시로 걷어냈다. 이제 골라 놓은 사진이
 * 그대로 붙어 있는다.
 *
 * 렌더러의 showcase / showcasePool 데이터는 그대로 둔다. 마크업은 첫 4장을
 * 그리는 데 여전히 showcase 를 쓰고, 풀은 안 쓸 뿐이다.
 */

// ── 이미지 캐러셀 (홈 · 하위 공통) ────────────────────────────
      document.addEventListener('DOMContentLoaded', function () {
        const box = document.querySelector('.image-carousel-box');
        if (!box) return;

        const mainImg = box.querySelector('.image-carousel-current-image');
        const titleEl = box.querySelector('.image-carousel-title');
        const indexEl = box.querySelector('.image-carousel-index');
        const thumbs = Array.from(box.querySelectorAll('.image-carousel-thumb'));
        const prevBtn = box.querySelector('.image-carousel-btn.prev');
        const nextBtn = box.querySelector('.image-carousel-btn.next');

        let currentIndex = 0;

        function updateCarousel(index) {
          if (index < 0) index = thumbs.length - 1;
          if (index >= thumbs.length) index = 0;
          currentIndex = index;

          const activeThumb = thumbs[currentIndex];
          const thumbImg = activeThumb.querySelector('img');
          const src = thumbImg ? thumbImg.getAttribute('src') : '';
          const label = activeThumb.getAttribute('aria-label') || '';

          if (mainImg) {
            mainImg.src = src;
            mainImg.alt = label;
          }
          if (titleEl) {
            titleEl.textContent = label.replace(/\s*\d+$/, '');
          }
          if (indexEl) {
            indexEl.textContent = (currentIndex + 1) + ' / ' + thumbs.length;
          }

          thumbs.forEach(function (t, i) {
            if (i === currentIndex) {
              t.classList.add('active');
            } else {
              t.classList.remove('active');
            }
          });
        }

        thumbs.forEach(function (t, i) {
          t.addEventListener('click', function () {
            updateCarousel(i);
          });
        });

        if (prevBtn) {
          prevBtn.addEventListener('click', function () {
            updateCarousel(currentIndex - 1);
          });
        }
        if (nextBtn) {
          nextBtn.addEventListener('click', function () {
            updateCarousel(currentIndex + 1);
          });
        }
      });

/*
 * 견적 폼 접수 기록.
 *
 * 폼은 제휴사(replyalba) 페이지를 iframe 으로 끼운 것이라, 방문자가 넣은
 * 이름·전화번호는 그쪽 서버로만 간다. 다른 도메인이라 우리 스크립트는 그
 * 안을 읽을 수 없다. 그래서 "무엇을 냈는지" 는 못 잡고 "냈다는 사실" 만 잡는다.
 *
 * 어떻게 아는가:
 *   iFrameResize 가 쓰는 [iFrameSizer] 메시지에는 iframe 안에서 새 문서가
 *   뜰 때마다 :init 이 실려 온다. 처음 한 번은 폼이 열린 것이고, 그 뒤에
 *   또 오면 iframe 이 다른 문서로 넘어갔다는 뜻이다. 폼은 자기 자신에게
 *   post 하므로 제출이 곧 새 문서다.
 *
 * 정확도의 한계를 분명히 해둔다. 입력값 검증에 걸려 오류 화면이 떠도 :init 이
 * 온다. 그래서 이름은 submit 이 아니라 advance(다음 화면으로 넘어감) 다.
 * 실제 접수 건수의 상한으로 읽어야 한다.
 *
 * 보내는 곳은 자기 도메인의 /_e 다. nginx 가 204 로 받고 로그만 남긴다.
 * 정적 사이트라 백엔드가 없어서, 로그를 나중에 DB 로 옮긴다.
 */
document.addEventListener('DOMContentLoaded', function () {
  const frame = document.getElementById('ifrCCAl');
  if (!frame) return;

  let inits = 0;

  const send = function (event) {
    const params = 't=' + event + '&p=' + encodeURIComponent(location.pathname);
    // sendBeacon 은 페이지를 떠나도 전송을 보장한다. 없으면 이미지로 대신한다.
    if (navigator.sendBeacon) navigator.sendBeacon('/_e?' + params);
    else new Image().src = '/_e?' + params;
  };

  window.addEventListener('message', function (e) {
    if (e.origin !== 'https://replyalba.com') return;
    if (typeof e.data !== 'string' || e.data.indexOf('[iFrameSizer]') !== 0) return;
    if (e.data.indexOf(':init') === -1) return;

    inits += 1;
    // 첫 init 은 폼이 그려진 것. 그 뒤부터가 화면 전환이다.
    send(inits === 1 ? 'view' : 'advance');
  });
});
