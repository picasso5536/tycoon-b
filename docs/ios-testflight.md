# Mac 없이 아이폰에서 테스트하기

Windows 에서 iOS 앱을 실기기에 올리는 절차. 빌드와 서명은 GitHub 의 macOS 러너가 대신한다.

## 전제

**유료 Apple Developer Program 멤버십**(연 $99)이 필요하다.
[developer.apple.com/account](https://developer.apple.com/account) 에서 활성 상태인지 먼저 확인할 것.

무료 Apple ID 로는 TestFlight 를 쓸 수 없고, 실기기 설치에 Mac + Xcode 가 필요하다.
이 경우 방법이 없으니 멤버십 가입이 사실상 유일한 길이다.

---

## 1. 인증서 만들기 (Windows 에서)

Mac 의 키체인 접근 대신 OpenSSL 로 같은 일을 한다.
Git for Windows 를 설치했다면 **Git Bash** 에 openssl 이 들어 있다.

```bash
# 개인키 생성 — 이 파일을 잃어버리면 인증서를 다시 만들어야 한다
openssl genrsa -out ios_distribution.key 2048

# 인증서 서명 요청(CSR) 생성. 이메일과 이름은 본인 것으로.
openssl req -new -key ios_distribution.key -out ios_distribution.csr \
  -subj "/emailAddress=본인@이메일.com/CN=본인 이름/C=KR"
```

[Certificates](https://developer.apple.com/account/resources/certificates/list) → **+** →
**Apple Distribution** 선택 → 방금 만든 `ios_distribution.csr` 업로드 → `distribution.cer` 다운로드.

이제 인증서와 개인키를 하나로 묶는다 (CI 가 쓰는 형식):

```bash
openssl x509 -in distribution.cer -inform DER -out distribution.pem -outform PEM
openssl pkcs12 -export -inkey ios_distribution.key -in distribution.pem \
  -out distribution.p12 -passout pass:직접정한비밀번호
```

## 2. 앱 등록과 프로파일

**App ID** — [Identifiers](https://developer.apple.com/account/resources/identifiers/list) → **+** →
App IDs → App → Bundle ID 에 `io.github.picasso5536.tycoonb` 입력 (Explicit).

**프로비저닝 프로파일** — [Profiles](https://developer.apple.com/account/resources/profiles/list) → **+** →
Distribution 의 **App Store Connect** → 위 App ID 선택 → 1번 인증서 선택 →
이름을 정하고(예: `TycoonB AppStore`) `.mobileprovision` 다운로드.

> 이 **프로파일 이름**을 그대로 `APPLE_PROFILE_NAME` Secret 에 넣는다.

**앱 레코드** — [App Store Connect](https://appstoreconnect.apple.com) → 앱 → **+** →
플랫폼 iOS, 번들 ID 는 위에서 만든 것 선택, SKU 는 아무 문자열(예: `tycoon-b`).

## 3. 업로드용 API 키

App Store Connect → 사용자 및 액세스 → **통합** → App Store Connect API → **+**

- 이름: 아무거나 (예: `github-actions`)
- 역할: **App Manager**

발급되면 `.p8` 파일을 받는다. **이 파일도 한 번만 받을 수 있다.**
같은 화면의 **키 ID** 와 **발급자 ID** 도 함께 적어 둔다.

## 4. GitHub Secrets 등록

저장소 Settings → Secrets and variables → Actions → New repository secret

| Secret | 값 |
| --- | --- |
| `APPLE_CERTIFICATE_P12` | `distribution.p12` 를 base64 로 변환한 문자열 |
| `APPLE_CERTIFICATE_PASSWORD` | 1번에서 정한 비밀번호 |
| `APPLE_PROVISIONING_PROFILE` | `.mobileprovision` 을 base64 로 변환한 문자열 |
| `APPLE_PROFILE_NAME` | 프로파일 이름 (예: `TycoonB AppStore`) |
| `APPLE_TEAM_ID` | 개발자 포털 우측 상단 또는 Membership 에 있는 10자리 |
| `APPSTORE_API_KEY_ID` | 3번의 키 ID |
| `APPSTORE_API_ISSUER_ID` | 3번의 발급자 ID |
| `APPSTORE_API_PRIVATE_KEY` | `.p8` 파일 **내용 전체** (`-----BEGIN PRIVATE KEY-----` 포함) |

base64 변환은 PowerShell 에서:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("distribution.p12")) | Set-Clipboard
[Convert]::ToBase64String([IO.File]::ReadAllBytes("TycoonB_AppStore.mobileprovision")) | Set-Clipboard
```

클립보드에 복사되니 Secret 입력란에 바로 붙여넣으면 된다.

> **`.key` · `.p12` · `.p8` 파일은 절대 커밋하지 말 것.** Secrets 에만 넣는다.

## 5. 배포

Actions 탭 → **TestFlight 배포** → **Run workflow**

또는 태그를 밀면 자동으로 돈다:

```powershell
git tag ios-v1.0.0
git push origin ios-v1.0.0
```

10~20분 뒤 App Store Connect → TestFlight 에 빌드가 올라온다.
처음 한 번은 Apple 의 처리에 시간이 더 걸리고, 수출 규정 관련 질문에 답해야 할 수 있다.

## 6. 아이폰에 설치

1. App Store 에서 **TestFlight** 앱 설치
2. App Store Connect → TestFlight → 내부 테스팅 → 본인 Apple ID 를 테스터로 추가
3. 초대 메일의 링크를 아이폰에서 열면 TestFlight 앱에 나타난다

내부 테스터는 심사 없이 바로 설치된다. 외부 테스터(최대 10,000명)는 Apple 의 간단한 심사를 거친다.

---

## 아직 검증되지 않은 부분

이 워크플로는 **한 번도 실행된 적이 없다.** Apple 계정과 macOS 러너가 필요해서
개발 중에는 테스트할 수 없었다. 첫 실행에서 서명 관련 오류가 날 가능성이 있고,
그때는 Actions 로그의 `xcodebuild` 출력을 보고 조정해야 한다.

흔한 실패와 원인:

| 증상 | 원인 |
| --- | --- |
| `No signing certificate "iOS Distribution" found` | `.p12` 에 개인키가 안 들어갔다. 1번의 pkcs12 단계를 다시 |
| `Provisioning profile ... doesn't match` | 프로파일의 App ID 나 인증서가 다르다. 2번을 다시 |
| `No profile for team ... matching ... found` | `APPLE_PROFILE_NAME` 이 포털의 이름과 다르다 |
| 업로드 시 `Invalid build number` | 같은 빌드 번호를 재사용했다. 워크플로가 run_number 로 올리므로 재실행하면 해결 |
