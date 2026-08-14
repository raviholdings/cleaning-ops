/*
 * 청소 랜딩페이지 공용 스크립트.
 *
 * 예전에는 이 내용이 페이지마다 통째로 박혀 나갔다. 100만 페이지면 같은
 * 코드가 100만 번 복제된 셈이라, 디스크와 크롤링 대역폭을 그만큼 먹었다.
 * 홈과 하위 페이지가 쓰는 게 달라서 둘을 합쳤다. 대상 요소가 없으면
 * 각 블록이 바로 빠져나가므로 어느 쪽에 실려도 안전하다.
 */

// ── 갤러리 4칸 순환 (홈 전용) ──────────────────────────────────
      // 갤러리 4칸이 풀에서 순환한다. 칸마다 시차를 둬서 한꺼번에 안 바뀌게 한다.
      document.addEventListener('DOMContentLoaded', function () {
        const grid = document.querySelector('[data-gallery-rotate]');
        if (!grid) return;
        const pool = (grid.getAttribute('data-gallery-rotate') || '').split(',').filter(Boolean);
        const slots = Array.from(grid.querySelectorAll('img'));
        if (pool.length <= slots.length) return;

        let cursor = slots.length;
        slots.forEach(function (img, i) {
          setTimeout(function () {
            setInterval(function () {
              const next = pool[cursor % pool.length];
              cursor += 1;
              const swap = new Image();
              swap.onload = function () {
                img.style.opacity = '0';
                setTimeout(function () { img.src = next; img.style.opacity = '1'; }, 200);
              };
              swap.src = next;
            }, 4200);
          }, i * 900);
        });
      });

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
