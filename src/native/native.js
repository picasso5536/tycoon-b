/* ─────────────────────────────────────────────────────────────
   붕어빵 타이쿤 — 네이티브(iOS/Android) 브리지
   Capacitor 네이티브 브리지가 주입한 window.Capacitor 를 통해
   플러그인을 직접 호출합니다(번들러 불필요).
   게임 코드(index.html)는 손대지 않고 동작만 보정합니다.
   ───────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var Cap = window.Capacitor;
  if (!Cap || !Cap.isNativePlatform || !Cap.isNativePlatform()) return;

  var P = Cap.Plugins || {};
  var platform = Cap.getPlatform ? Cap.getPlatform() : 'web';
  document.documentElement.classList.add('native', 'native-' + platform);

  /* ── 1. 상태바 ────────────────────────────────────────────── */
  function setupStatusBar() {
    if (!P.StatusBar) return;
    // 어두운 배경 + 밝은 글자
    P.StatusBar.setStyle({ style: 'DARK' }).catch(function () {});
    if (platform === 'android') {
      // 안드로이드는 웹뷰가 상태바 아래에서 시작하도록(겹치지 않게)
      P.StatusBar.setOverlaysWebView({ overlay: false }).catch(function () {});
      P.StatusBar.setBackgroundColor({ color: '#0d1322' }).catch(function () {});
    }
  }

  /* ── 2. 스플래시 숨기기 ───────────────────────────────────── */
  function hideSplash() {
    if (P.SplashScreen) P.SplashScreen.hide().catch(function () {});
  }

  /* ── 3. 안드로이드 뒤로가기 버튼 ──────────────────────────── */
  //  열려 있는 시트(.modal.open)가 있으면 닫고,
  //  없으면 한 번 더 눌러야 앱이 종료되도록 함.
  function setupBackButton() {
    if (platform !== 'android' || !P.App) return;
    var armed = 0;

    P.App.addListener('backButton', function () {
      var open = document.querySelectorAll('.modal.open');
      if (open.length) {
        var top = open[open.length - 1];
        var closeBtn = top.querySelector('.close');
        // 게임이 붙여둔 닫기 핸들러를 그대로 사용(일시정지 해제 등 처리 포함)
        if (closeBtn) closeBtn.click();
        else top.classList.remove('open');
        return;
      }

      var now = Date.now();
      if (now - armed < 2000) {
        P.App.exitApp();
        return;
      }
      armed = now;
      nativeToast('한 번 더 누르면 종료됩니다');
    });
  }

  // 게임이 정의한 전역 toast() 를 그대로 사용
  function nativeToast(msg) {
    if (typeof window.toast === 'function') window.toast(msg);
  }

  /* ── 4. 결과 카드 공유 (navigator.share 폴리필) ───────────── */
  //  웹에서는 Web Share API / <a download> 로 처리하지만
  //  네이티브 웹뷰에서는 둘 다 동작하지 않으므로
  //  Filesystem 에 저장 후 Share 플러그인으로 시스템 공유 시트를 띄운다.
  function setupShare() {
    if (!P.Share || !P.Filesystem) return;

    function blobToBase64(blob) {
      return new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onerror = reject;
        r.onload = function () {
          var s = String(r.result);
          resolve(s.slice(s.indexOf(',') + 1));
        };
        r.readAsDataURL(blob);
      });
    }

    navigator.canShare = function (data) {
      return !!(data && (data.files || data.text || data.url || data.title));
    };

    // 사용자가 공유 시트를 그냥 닫은 것은 실패가 아니다.
    // 여기서 reject 하면 게임이 <a download> 폴백으로 넘어가 엉뚱한 토스트를 띄운다.
    function isCancel(err) {
      return /cancel/i.test((err && (err.message || err.errorMessage)) || '');
    }

    async function callShare(options) {
      try {
        await P.Share.share(options);
      } catch (err) {
        if (!isCancel(err)) throw err;
      }
    }

    navigator.share = async function (data) {
      data = data || {};
      var files = data.files || [];

      if (files.length) {
        var file = files[0];
        var name = file.name || ('tycoon-' + Date.now() + '.png');
        var base64 = await blobToBase64(file);
        var written = await P.Filesystem.writeFile({
          path: name,
          data: base64,
          directory: 'CACHE'
        });
        await callShare({
          title: data.title || '붕어빵 타이쿤',
          files: [written.uri],
          dialogTitle: '결과 카드 공유'
        });
        return;
      }

      await callShare({
        title: data.title,
        text: data.text,
        url: data.url,
        dialogTitle: '공유'
      });
    };
  }

  /* ── 5. 클립보드 폴백 ─────────────────────────────────────── */
  //  방 코드 복사. navigator.clipboard 가 막힌 웹뷰를 대비한 폴백.
  function setupClipboard() {
    if (navigator.clipboard && navigator.clipboard.writeText) return;
    navigator.clipboard = {
      writeText: function (text) {
        return new Promise(function (resolve, reject) {
          try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;opacity:0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            resolve();
          } catch (e) { reject(e); }
        });
      }
    };
  }

  /* ── 초기화 ───────────────────────────────────────────────── */
  setupShare();
  setupClipboard();

  document.addEventListener('DOMContentLoaded', function () {
    setupStatusBar();
    setupBackButton();
    // 첫 프레임이 그려진 뒤 스플래시 제거
    requestAnimationFrame(function () { setTimeout(hideSplash, 120); });
  });
})();
