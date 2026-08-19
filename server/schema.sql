-- 붕어빵 타이쿤 서버 · D1 스키마
--
-- 0단계(계정) + 1단계(랭킹)에 필요한 최소 구성.
-- 2단계(방 통신)에서 profile 테이블이 추가될 예정.

-- ── 계정 ─────────────────────────────────────────────────────
-- 클라이언트가 만들던 pid('p'+Math.random())를 대체하는 서버 발급 신원.
CREATE TABLE IF NOT EXISTS account (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,   -- 토큰 원문은 저장하지 않는다
  recovery_hash TEXT NOT NULL UNIQUE,   -- 복구 코드도 해시로만
  nick          TEXT,
  legacy_pid    TEXT,                   -- 기존 로컬 pid (친구 목록 승계용)
  -- 점수 검증 기준선: 이 값이 서버에 있어야 클라이언트가 증분을 위조할 수 없다
  max_earned    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_legacy ON account(legacy_pid);

-- ── 판(run) ──────────────────────────────────────────────────
-- 시작 시각을 서버가 소유해야 "즉시 999일 제출"을 막을 수 있다.
CREATE TABLE IF NOT EXISTS run (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  diff       TEXT NOT NULL,
  started_at INTEGER NOT NULL,          -- 서버 시각. 클라이언트 값은 신뢰하지 않는다
  last_day   INTEGER NOT NULL DEFAULT 0 -- 일수 단조성 검사용
);
CREATE INDEX IF NOT EXISTS idx_run_account ON run(account_id, started_at);

-- ── 주간 랭킹 ────────────────────────────────────────────────
-- UNIQUE 제약이 "1인 1기록"을 DB 차원에서 강제한다.
CREATE TABLE IF NOT EXISTS score (
  week         TEXT NOT NULL,           -- '2026-W34' (서버가 UTC 기준으로 계산)
  diff         TEXT NOT NULL,
  account_id   TEXT NOT NULL REFERENCES account(id),
  nick         TEXT NOT NULL,
  day          INTEGER NOT NULL,
  earned       INTEGER NOT NULL,
  lv           INTEGER NOT NULL DEFAULT 1,
  multi        INTEGER NOT NULL DEFAULT 0,
  run_id       TEXT NOT NULL REFERENCES run(id),
  verified     INTEGER NOT NULL DEFAULT 0,  -- 3단계 리플레이 검증용 자리
  submitted_at INTEGER NOT NULL,
  PRIMARY KEY (week, diff, account_id)
);
-- 랭킹 조회 정렬(일수 내림 → 점수 내림)을 인덱스로 받는다
CREATE INDEX IF NOT EXISTS idx_score_board ON score(week, diff, day DESC, earned DESC);

-- ── 제출 속도 제한 ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS submit_log (
  account_id TEXT NOT NULL,
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_submit_log ON submit_log(account_id, at);

-- ═══════════ 2단계: 플레이어 명부 ═══════════
-- 기존 bungeo-shop-v1/+ 전체 구독을 대체한다.
CREATE TABLE IF NOT EXISTS profile (
  account_id TEXT PRIMARY KEY REFERENCES account(id),
  nick       TEXT NOT NULL,
  avatar     TEXT,
  equip      TEXT,        -- JSON
  tags       TEXT,        -- JSON
  lv         INTEGER NOT NULL DEFAULT 1,
  sold       INTEGER NOT NULL DEFAULT 0,
  streak     INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profile_recent ON profile(updated_at DESC);

-- ═══════════ 2단계: 방 참가 시도 제한 ═══════════
-- 방 코드가 4자리(약 92만 조합)라 무차별 대입이 이론상 가능하다.
-- 계정당 시도 횟수를 제한해 탐색을 비현실적으로 만든다.
CREATE TABLE IF NOT EXISTS join_log (
  account_id TEXT NOT NULL,
  at         INTEGER NOT NULL,
  hit        INTEGER NOT NULL DEFAULT 0   -- 실제로 존재하는 방이었는지
);
CREATE INDEX IF NOT EXISTS idx_join_log ON join_log(account_id, at);
