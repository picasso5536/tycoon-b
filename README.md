# 붕어빵 타이쿤 🐟

포장마차 붕어빵 가게를 운영하는 모바일 게임. 웹 · iOS · Android 에서 같은 코드로 돌아갑니다.

| 플랫폼 | 실행 방법 |
| --- | --- |
| 웹 | [picasso5536.github.io/tycoon-b](https://picasso5536.github.io/tycoon-b) — `index.html` 단일 파일 |
| iOS | Xcode 로 `ios/App` 열어 빌드 |
| Android | Android Studio 로 `android/` 열어 빌드 |

---

## 구조

게임 본체는 예전과 똑같이 **`index.html` 단일 파일** 하나입니다.
앱은 이 파일을 [Capacitor](https://capacitorjs.com) 로 감싼 것이고, 게임 코드는 전혀 수정하지 않습니다.

```
index.html              ← 게임 본체 (웹 배포본, 유일한 원본)
scripts/build-www.mjs   ← index.html → www/ 로 굽는 빌드 (CDN 제거 + 네이티브 보정 주입)
scripts/make-assets.mjs ← 앱 아이콘 / 스플래시 원본 PNG 생성
src/native/             ← 네이티브 전용 CSS·JS (웹에는 들어가지 않음)
assets/                 ← 아이콘·스플래시 원본
www/                    ← 빌드 산출물 (git 에 커밋하지 않음)
android/ · ios/         ← 네이티브 프로젝트
```

빌드가 하는 일:

1. **CDN 의존성 제거** — Google Fonts(Jua, Gowun Dodum)와 mqtt.js 를 앱 안에 번들합니다.
   덕분에 앱이 **네트워크 없이도 즉시 뜨고**, 싱글플레이는 완전 오프라인으로 돌아갑니다.
   (멀티플레이는 당연히 인터넷이 필요합니다.)
2. **노치 대응** — `viewport-fit=cover` + `env(safe-area-inset-*)` 여백.
3. **네이티브 보정 주입** — 아래 "네이티브에서 달라지는 것" 참고.

빌드 스크립트는 `index.html` 안에서 바꿔야 할 부분을 **못 찾으면 그냥 넘어가지 않고 실패**합니다.
게임 파일을 크게 고쳐서 빌드가 깨지면, 어느 부분을 못 찾았는지 에러 메시지에 나옵니다.

---

## 개발 환경 준비

```bash
npm install
npm run build      # www/ 생성
```

`npm run sync` 는 `build` + `cap sync`(네이티브 프로젝트에 웹 자산 복사)를 한 번에 합니다.
**게임(`index.html`)을 고친 뒤에는 반드시 `npm run sync` 를 실행해야** 앱에 반영됩니다.

### Android

필요: Android Studio (또는 Android SDK + JDK 21)

```bash
npm run android        # 동기화 후 Android Studio 열기
npm run android:apk    # CLI 로 디버그 APK 빌드
                       # → android/app/build/outputs/apk/debug/app-debug.apk
```

스토어 출시용 AAB 는 `npm run android:bundle` 이며, 먼저 서명 키를 설정해야 합니다
([공식 문서](https://capacitorjs.com/docs/android/deploying-to-google-play)).

### iOS

필요: macOS + Xcode 15 이상 (Capacitor 8 은 CocoaPods 없이 Swift Package Manager 를 씁니다)

```bash
npm run ios            # 동기화 후 Xcode 열기
```

Xcode 에서 `App` 타깃 → *Signing & Capabilities* 에 본인 Apple 개발자 팀을 지정한 뒤
시뮬레이터나 실기기로 실행하면 됩니다.

### CI

`.github/workflows/build-apps.yml` 가 푸시할 때마다 Android 디버그 APK 와
iOS 시뮬레이터 빌드를 만들어 Actions 아티팩트로 올립니다.
맥이 없어도 Actions 에서 APK 를 받아 바로 설치해볼 수 있습니다.

---

## 네이티브에서 달라지는 것

`src/native/` 의 두 파일이 앱 빌드에만 주입됩니다. 웹 버전은 영향을 받지 않습니다.

| 항목 | 처리 |
| --- | --- |
| 안전영역 | 노치·다이나믹 아일랜드·제스처 바를 피해 `#app` 에 여백 |
| 바운스 스크롤 | iOS 웹뷰의 고무줄 스크롤 제거 |
| 뒤로가기 (Android) | 열린 시트가 있으면 닫고, 없으면 두 번 눌러야 종료 |
| 결과 카드 공유 | `<a download>` 대신 시스템 공유 시트로 이미지 전송 |
| 방 코드 복사 | 클립보드 API 가 막힌 웹뷰용 폴백 |
| 상태바 | 어두운 배경 + 밝은 글자로 게임 톤에 맞춤 |
| 화면 방향 | 세로 고정 (게임 UI 가 세로 전용 레이아웃) |
| 화면 꺼짐 | 플레이 중 화면이 꺼지지 않도록 유지 (Android) |

## 아이콘 · 스플래시

`assets/icon.svg`, `assets/splash.svg` 를 고친 뒤:

```bash
node scripts/make-assets.mjs                    # SVG → 원본 PNG
npx @capacitor/assets generate                  # 모든 해상도 생성
```

아이콘의 붕어빵은 게임 안에서 쓰는 `fishSVG()` 와 같은 도형을 씁니다.

## 앱 정보 바꾸기

| 항목 | 위치 |
| --- | --- |
| 앱 ID / 이름 | `capacitor.config.json` (`appId`, `appName`) |
| Android 버전 | `android/app/build.gradle` (`versionCode`, `versionName`) |
| iOS 버전 | Xcode → App 타깃 → General |

`appId` 는 스토어 등록 후에는 바꿀 수 없으니 출시 전에 확정하세요.

## 라이선스

번들된 폰트 Jua, Gowun Dodum 은 SIL Open Font License 1.1 을 따릅니다.
