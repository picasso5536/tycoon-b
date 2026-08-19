# 붕어빵 타이쿤 API

공개 MQTT 브로커를 대체하는 자체 서버. Cloudflare Workers + Durable Objects + D1.

## 무엇을 고쳤나

| 이전 (공개 MQTT) | 지금 |
| --- | --- |
| `pid = 'p' + Math.random()` — 누구나 사칭 | 서버가 발급한 계정 + 토큰 |
| 아무나 랭킹에 임의 점수 발행 · 남의 기록 덮어쓰기 · 보드 삭제 | 서버만 쓴다. `UNIQUE(week, diff, account_id)` 로 1인 1기록 |
| `bungeo-tycoon-v4/#` 구독으로 모든 방 실시간 관전 | 방 하나 = Durable Object 하나. 와일드카드라는 개념이 없다 |
| 아무나 방 `meta` 조작 | `meta` 는 호스트만. 자리는 서버가 배정 |
| `bungeo-shop-v1/+` 로 전체 플레이어 명부 수집 | 건수 제한이 걸린 조회 (최대 30건) |
| 검증 없음 | 경과시간·매출 상한·일수 단조성·제출 빈도 + 상위권 리플레이 정합성 |

## 배포

```bash
cd server
npm install

# 1) D1 만들고 출력된 database_id 를 wrangler.toml 에 붙여넣는다
npx wrangler d1 create tycoon-b

# 2) 스키마 적용
npm run db:init:remote

# 3) 배포
npm run deploy
```

배포하면 `https://tycoon-b-api.<계정>.workers.dev` 주소가 나옵니다.
그 값을 루트 `index.html` 의 `API_BASE` 에 넣으면 클라이언트가 붙습니다.

```js
const API_BASE = 'https://tycoon-b-api.your-account.workers.dev';
```

`API_BASE` 를 비워 두면 온라인 기능만 꺼지고 혼자 하기는 정상 동작합니다.

## 로컬 개발

```bash
npm run db:init    # 로컬 D1 초기화 (최초 1회)
npm run dev        # http://127.0.0.1:8787
npm test           # 통합 테스트 (dev 가 떠 있어야 한다)
```

## API

| 엔드포인트 | 하는 일 | 인증 |
| --- | --- | --- |
| `POST /v1/accounts` | 계정 발급 → 토큰 + 복구 코드 | 없음 |
| `POST /v1/accounts/recover` | 복구 코드로 기기 이전 (토큰 회전) | 없음 |
| `GET /v1/me` | 내 계정 요약 | 토큰 |
| `POST /v1/runs` | 판 시작 → `run_id` | 토큰 |
| `POST /v1/runs/{id}/submit` | 점수 제출 → 검증 후 갱신 | 토큰 · 소유자만 |
| `GET /v1/leaderboard` | 주차·난이도별 상위 기록 | 없음 |
| `GET /v1/profiles` | 명부 조회 (`?ids=` 지목 / `?limit=` 둘러보기) | 없음 |
| `GET /v1/profiles/{id}` | 가게 카드 하나 | 없음 |
| `PUT /v1/profiles/me` | 내 카드 갱신 | 토큰 · 소유자만 |
| `GET /v1/rooms/{code}/host` | 방 개설 + WebSocket | 쿼리 토큰 |
| `GET /v1/rooms/{code}/ws` | 방 참가 + WebSocket | 쿼리 토큰 |

## 점수 검증

게임 상수(`index.html`)에서 유도한 값입니다. **밸런스를 바꾸면 `src/index.js` 의 상수도 함께 고쳐야 합니다.**

| 검사 | 규칙 |
| --- | --- |
| 경과시간 | `now - run.started_at ≥ day × 60초` (하루 120초 ÷ 배속 2배) |
| 매출 상한 | `earned - max_earned ≤ day × 1,440,000` |
| 일수 단조성 | 같은 판에서 day 는 앞으로만 |
| 제출 빈도 | 계정당 분당 20회 |
| 리플레이 | 상위 10위 후보만. 로그 합계·시간 순서·건당 금액 정합성 |

`max_earned` 를 **서버가** 들고 있는 게 핵심입니다. `runEarned` 는 이전 판에서 이어받는
누적값이라 절대값으로 검증할 수 없고, 기준선이 클라이언트에 있으면 증분을 부풀릴 수 있습니다.

상한은 이론상 천장이라 실제 상위권과 격차가 큽니다. **느슨하게 시작해서 실기록 분포를 본 뒤 조이세요.**

## 남는 위험

- **개조 클라이언트** — 게임은 여전히 클라이언트에서 시뮬레이션됩니다. 규칙에 맞는 가짜 판을
  만들어 제출하는 것은 리플레이 검증을 거쳐도 가능합니다. 문턱만 올라갑니다.
  완전 차단은 서버가 게임을 직접 시뮬레이션해야 하고, 그건 게임 재작성입니다.
- **방 코드 4자리** — 약 92만 조합이라 이론상 훑을 수 있습니다. 계정당 분당 12회 제한과
  짧은 방 수명으로 비현실적으로 만들어 두었습니다. 코드를 늘리면 더 안전하지만 UX 가 나빠집니다.
- **협동방 호스트** — 손님 생성 권한이 호스트에 있어 마음먹으면 파트너를 방해할 수 있습니다.
  친구끼리 하는 협동에서는 받아들일 만한 신뢰 모델이지만, 모르는 사람과 매칭하는 기능을
  넣는다면 재검토가 필요합니다.
- **로컬 진행도** — 보석·업적·꾸미기는 여전히 브라우저에서 고칠 수 있습니다. 랭킹과 분리돼
  있어 남에게 피해는 없습니다.
