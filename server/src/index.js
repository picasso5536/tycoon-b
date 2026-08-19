/**
 * 붕어빵 타이쿤 API — 0단계(계정) + 1단계(랭킹)
 *
 * 이 서버가 해결하는 것:
 *   - 신원을 서버가 발급한다. 클라이언트의 Math.random() pid 를 대체.
 *   - 랭킹을 서버만 쓴다. 남의 기록 덮어쓰기·보드 삭제·임의 점수가 사라진다.
 *   - 점수를 상한 검증한다. 게임 상수에서 유도한 물리적 천장을 넘으면 거부.
 *
 *   - 방을 Durable Object 로 격리한다. 와일드카드 구독이 존재하지 않는다.
 *   - 명부를 인증된 조회로 바꾼다. 전체 수집이 페이지네이션으로 좁혀진다.
 *   - 상위권 제출은 판매 로그 정합성을 검사한다.
 *
 * 여전히 못 막는 것:
 *   - 개조 클라이언트가 규칙에 맞게 지어낸 가짜 판. 문턱만 올라간다.
 */
import { Room } from './room.js';
import { validateReplay, MAX_LOG_EVENTS } from './replay.js';

export { Room };

/* ═══════════ 검증 상수 ═══════════
   index.html 의 게임 상수에서 유도한 값. 게임 밸런스가 바뀌면 함께 고쳐야 한다. */
const DAY_LEN = 120;          // 하루 길이(초)
const MAX_SPEED = 2;          // 배속 상한 → 하루 최소 실시간 = 120/2 = 60초
const MIN_SEC_PER_DAY = DAY_LEN / MAX_SPEED;
const CLOCK_GRACE_SEC = 15;   // 시계 오차·네트워크 지연 여유
const DAY_EARN_CEILING = 1440000; // 하루 최대 매출(손님 240명 × 4개 × 1,500원)
const MAX_DAY = 500;          // 비정상적으로 큰 일수 차단
const RATE_LIMIT = { windowMs: 60000, max: 20 };
const DIFFS = new Set(['easy', 'normal', 'hard', 'vhard']);

/* 2단계: 방 참가 시도 제한. 4자리 코드(약 92만 조합)를 훑는 것을 비현실적으로 만든다. */
const JOIN_LIMIT = { windowMs: 60000, max: 12 };
const ROOM_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

/* 3단계: 이 순위 안에 드는 제출은 판매 로그를 요구한다 */
const REPLAY_RANK_THRESHOLD = 10;

/* ═══════════ 유틸 ═══════════ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}
const fail = (status, code, message) => json({ error: code, message }, status);

/** 충돌 걱정 없는 무작위 ID (crypto.randomUUID 는 Workers 에서 사용 가능) */
const newId = (prefix) => prefix + crypto.randomUUID().replace(/-/g, '');

/** 사람이 옮겨 적을 수 있는 복구 코드. 헷갈리는 글자(0/O/1/I)는 뺀다. */
function newRecoveryCode() {
  const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]);
  return chars.join('').replace(/(.{4})(?=.)/g, '$1-'); // XXXX-XXXX-XXXX-XXXX
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * ISO 주차를 UTC 기준으로 계산한다.
 * 클라이언트가 로컬 시간으로 계산하던 것을 서버로 옮겨야
 * 주 경계에서 사람마다 다른 보드를 보는 일이 없다.
 */
function isoWeek(ms) {
  const d = new Date(ms);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const day = new Date(t).getUTCDay() || 7;       // 월=1 … 일=7
  const thursday = t + (4 - day) * 86400000;      // 그 주의 목요일이 연도를 결정
  const year = new Date(thursday).getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((thursday - jan1) / (7 * 86400000)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function readBody(req) {
  return req.json().catch(() => null);
}

/** 닉네임: 클라이언트가 무엇을 보내든 서버에서 자른다 */
function cleanNick(nick) {
  const s = String(nick ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s.slice(0, 10) || '무명 사장';
}

/* ═══════════ 인증 ═══════════ */

/** Authorization: Bearer <token> → account 행. 실패하면 null. */
async function authenticate(req, env) {
  const header = req.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const hash = await sha256(match[1].trim());
  return env.DB.prepare(
    'SELECT id, nick, max_earned FROM account WHERE token_hash = ?'
  ).bind(hash).first();
}

/* ═══════════ 핸들러 ═══════════ */

/** POST /v1/accounts — 최초 1회. 토큰과 복구 코드를 발급한다. */
async function createAccount(req, env) {
  const body = (await readBody(req)) || {};
  const id = newId('acc_');
  const token = newId('tok_');
  const recovery = newRecoveryCode();
  const nick = body.nick === undefined ? null : cleanNick(body.nick);
  // 기존 로컬 pid 를 받아 두면 친구 목록이 끊기지 않는다
  const legacyPid = typeof body.legacy_pid === 'string' ? body.legacy_pid.slice(0, 40) : null;

  await env.DB.prepare(
    `INSERT INTO account (id, token_hash, recovery_hash, nick, legacy_pid, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, await sha256(token), await sha256(recovery), nick, legacyPid, Date.now()).run();

  // 토큰과 복구 코드는 이 응답에서만 평문으로 나간다
  return json({ account_id: id, token, recovery_code: recovery, nick }, 201);
}

/** POST /v1/accounts/recover — 기기를 옮길 때. 새 토큰으로 교체한다. */
async function recoverAccount(req, env) {
  const body = (await readBody(req)) || {};
  const code = String(body.recovery_code || '').trim().toUpperCase();
  if (!code) return fail(400, 'missing_code', '복구 코드가 필요합니다.');

  const account = await env.DB.prepare(
    'SELECT id, nick FROM account WHERE recovery_hash = ?'
  ).bind(await sha256(code)).first();
  if (!account) return fail(404, 'bad_code', '복구 코드를 찾을 수 없습니다.');

  // 이전 기기의 토큰은 무효화된다 (토큰 회전)
  const token = newId('tok_');
  await env.DB.prepare('UPDATE account SET token_hash = ? WHERE id = ?')
    .bind(await sha256(token), account.id).run();

  return json({ account_id: account.id, token, nick: account.nick });
}

/** POST /v1/runs — 판 시작. 서버가 시작 시각을 기록한다. */
async function startRun(req, env, account) {
  const body = (await readBody(req)) || {};
  const diff = DIFFS.has(body.diff) ? body.diff : 'normal';
  const id = newId('run_');

  await env.DB.prepare(
    'INSERT INTO run (id, account_id, diff, started_at) VALUES (?, ?, ?, ?)'
  ).bind(id, account.id, diff, Date.now()).run();

  return json({ run_id: id, diff }, 201);
}

/** 제출 속도 제한. 통과하면 null, 걸리면 응답을 돌려준다. */
async function checkRateLimit(env, accountId) {
  const since = Date.now() - RATE_LIMIT.windowMs;
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM submit_log WHERE account_id = ? AND at > ?'
  ).bind(accountId, since).first();

  if (row && row.n >= RATE_LIMIT.max) {
    return fail(429, 'rate_limited', '제출이 너무 잦습니다. 잠시 후 다시 시도하세요.');
  }
  await env.DB.batch([
    env.DB.prepare('INSERT INTO submit_log (account_id, at) VALUES (?, ?)')
      .bind(accountId, Date.now()),
    // 로그가 무한히 쌓이지 않도록 창 밖은 정리
    env.DB.prepare('DELETE FROM submit_log WHERE account_id = ? AND at <= ?')
      .bind(accountId, since),
  ]);
  return null;
}

/**
 * POST /v1/runs/:id/submit — 점수 제출.
 *
 * 검증 순서가 중요하다. 소유권 → 형식 → 물리적 상한 순으로 좁혀 간다.
 */
async function submitScore(req, env, account, runId) {
  const limited = await checkRateLimit(env, account.id);
  if (limited) return limited;

  const body = (await readBody(req)) || {};
  const day = Number(body.day);
  const earned = Number(body.earned);
  const lv = Math.max(1, Math.min(999, Number(body.lv) || 1));
  const multi = body.multi ? 1 : 0;

  if (!Number.isInteger(day) || day < 1 || day > MAX_DAY) {
    return fail(400, 'bad_day', '일수가 올바르지 않습니다.');
  }
  if (!Number.isInteger(earned) || earned < 0) {
    return fail(400, 'bad_earned', '점수가 올바르지 않습니다.');
  }

  const run = await env.DB.prepare(
    'SELECT id, account_id, diff, started_at, last_day FROM run WHERE id = ?'
  ).bind(runId).first();
  if (!run) return fail(404, 'no_run', '판을 찾을 수 없습니다.');
  // 소유권 — 남의 판에 점수를 얹지 못하게
  if (run.account_id !== account.id) return fail(403, 'not_owner', '본인의 판이 아닙니다.');

  // ── 검증 1. 일수 단조성 ──
  if (day <= run.last_day) {
    return fail(409, 'day_not_advanced', '이미 제출된 일수입니다.');
  }

  // ── 검증 2. 경과시간 ──
  // 하루는 아무리 빨라도 실시간 60초가 필요하다. "즉시 999일 제출"을 여기서 막는다.
  const elapsedSec = (Date.now() - run.started_at) / 1000;
  if (elapsedSec + CLOCK_GRACE_SEC < day * MIN_SEC_PER_DAY) {
    return fail(422, 'too_fast', '경과 시간에 비해 진행 일수가 많습니다.');
  }

  // ── 검증 3. 매출 상한 ──
  // runEarned 는 이전 판에서 이어받는 누적값이라 절대값이 아니라 증분을 본다.
  // 기준선(max_earned)을 서버가 들고 있으므로 클라이언트가 증분을 부풀릴 수 없다.
  const gain = earned - account.max_earned;
  if (gain > day * DAY_EARN_CEILING) {
    return fail(422, 'earned_too_high', '매출이 물리적 상한을 넘습니다.');
  }

  const now = Date.now();
  const week = isoWeek(now);

  // ── 검증 4. 리플레이 정합성 (3단계) ──
  // 랭킹에 실제로 올라갈 기록만 검사한다. 전원을 검사할 이유가 없다.
  let verified = 0;
  if (await isPodiumWorthy(env, week, run.diff, day, earned, account.id)) {
    if (!Array.isArray(body.log)) {
      return fail(422, 'replay_required',
        '상위권 기록은 판매 로그가 필요합니다. 게임을 최신 버전으로 갱신하세요.');
    }
    const check = validateReplay(body.log, body.day_sales);
    if (!check.ok) return fail(422, check.code, check.detail);
    verified = 1;
  }
  const nick = cleanNick(body.nick ?? account.nick);

  const statements = [
    env.DB.prepare('UPDATE run SET last_day = ? WHERE id = ?').bind(day, run.id),
  ];
  if (earned > account.max_earned) {
    statements.push(
      env.DB.prepare('UPDATE account SET max_earned = ? WHERE id = ?').bind(earned, account.id)
    );
  }
  if (body.nick !== undefined) {
    statements.push(
      env.DB.prepare('UPDATE account SET nick = ? WHERE id = ?').bind(nick, account.id)
    );
  }
  // 주간 최고 기록만 남긴다. 정렬 기준(일수 우선, 그다음 점수)은 클라이언트 랭킹과 동일.
  statements.push(
    env.DB.prepare(
      `INSERT INTO score (week, diff, account_id, nick, day, earned, lv, multi, run_id, verified, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (week, diff, account_id) DO UPDATE SET
         nick = excluded.nick, day = excluded.day, earned = excluded.earned,
         lv = excluded.lv, multi = excluded.multi, run_id = excluded.run_id,
         verified = excluded.verified, submitted_at = excluded.submitted_at
       WHERE excluded.day > score.day
          OR (excluded.day = score.day AND excluded.earned > score.earned)`
    ).bind(week, run.diff, account.id, nick, day, earned, lv, multi, run.id, verified, now)
  );

  await env.DB.batch(statements);

  const stored = await env.DB.prepare(
    'SELECT day, earned FROM score WHERE week = ? AND diff = ? AND account_id = ?'
  ).bind(week, run.diff, account.id).first();

  return json({
    week,
    diff: run.diff,
    accepted: !!stored && stored.day === day && stored.earned === earned,
    best: stored ? { day: stored.day, earned: stored.earned } : null,
  });
}

/**
 * 이 기록이 상위권(REPLAY_RANK_THRESHOLD 위)에 들어가나?
 * 들어갈 때만 리플레이 로그를 요구해서 검증 비용을 상위권에 집중시킨다.
 */
async function isPodiumWorthy(env, week, diff, day, earned, accountId) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS better FROM score
     WHERE week = ? AND diff = ? AND account_id != ?
       AND (day > ? OR (day = ? AND earned > ?))`
  ).bind(week, diff, accountId, day, day, earned).first();
  return !row || row.better < REPLAY_RANK_THRESHOLD;
}

/* ═══════════ 2단계: 명부 ═══════════ */

/** PUT /v1/profiles/me — 내 가게 카드 갱신 (본인만) */
async function putProfile(req, env, account) {
  const body = (await readBody(req)) || {};
  const nick = cleanNick(body.nick ?? account.nick);
  const avatar = String(body.avatar || 'av_chef').slice(0, 32);
  // JSON 필드는 길이만 제한하고 내용은 클라이언트 표시용으로 그대로 둔다
  const equip = JSON.stringify(body.equip ?? {}).slice(0, 2000);
  const tags = JSON.stringify(body.tags ?? {}).slice(0, 2000);
  const lv = Math.max(1, Math.min(999, Number(body.lv) || 1));
  const sold = Math.max(0, Math.min(1e9, Number(body.sold) || 0));
  const streak = Math.max(0, Math.min(9999, Number(body.streak) || 0));

  await env.DB.prepare(
    `INSERT INTO profile (account_id, nick, avatar, equip, tags, lv, sold, streak, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_id) DO UPDATE SET
       nick = excluded.nick, avatar = excluded.avatar, equip = excluded.equip,
       tags = excluded.tags, lv = excluded.lv, sold = excluded.sold,
       streak = excluded.streak, updated_at = excluded.updated_at`
  ).bind(account.id, nick, avatar, equip, tags, lv, sold, streak, Date.now()).run();

  return json({ ok: true });
}

function rowToProfile(row) {
  const parse = (text, fallback) => {
    try { return JSON.parse(text); } catch { return fallback; }
  };
  return {
    account_id: row.account_id,
    n: row.nick,
    av: row.avatar,
    eq: parse(row.equip, {}),
    tg: parse(row.tags, {}),
    lv: row.lv,
    sold: row.sold,
    st: row.streak,
    ts: row.updated_at,
  };
}

/** GET /v1/profiles/:id — 한 명 조회 */
async function getProfile(env, id) {
  const row = await env.DB.prepare(
    'SELECT * FROM profile WHERE account_id = ?'
  ).bind(id).first();
  if (!row) return fail(404, 'no_profile', '가게를 찾을 수 없습니다.');
  return json(rowToProfile(row));
}

/**
 * GET /v1/profiles?ids=a,b,c 또는 ?limit=
 * 전체 명부를 한 번에 긁던 bungeo-shop-v1/+ 를 대체한다.
 * ids 지정 시 친구 목록 조회, 미지정 시 최근 갱신순 둘러보기.
 */
async function listProfiles(url, env) {
  const idsParam = url.searchParams.get('ids');
  const limit = Math.max(1, Math.min(30, Number(url.searchParams.get('limit')) || 20));

  if (idsParam) {
    const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 30);
    if (!ids.length) return json({ rows: [] });
    const marks = ids.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT * FROM profile WHERE account_id IN (${marks})`
    ).bind(...ids).all();
    return json({ rows: (results || []).map(rowToProfile) });
  }

  const { results } = await env.DB.prepare(
    'SELECT * FROM profile ORDER BY updated_at DESC LIMIT ?'
  ).bind(limit).all();
  return json({ rows: (results || []).map(rowToProfile) });
}

/* ═══════════ 2단계: 방 ═══════════ */

/** 방 참가 시도 제한. 코드 무차별 대입을 비현실적으로 만든다. */
async function checkJoinLimit(env, accountId) {
  const since = Date.now() - JOIN_LIMIT.windowMs;
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM join_log WHERE account_id = ? AND at > ?'
  ).bind(accountId, since).first();
  if (row && row.n >= JOIN_LIMIT.max) {
    return fail(429, 'join_rate_limited', '방 참가 시도가 너무 잦습니다. 잠시 후 다시 시도하세요.');
  }
  return null;
}

async function logJoin(env, accountId, hit) {
  const since = Date.now() - JOIN_LIMIT.windowMs;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO join_log (account_id, at, hit) VALUES (?, ?, ?)')
      .bind(accountId, Date.now(), hit ? 1 : 0),
    env.DB.prepare('DELETE FROM join_log WHERE account_id = ? AND at <= ?')
      .bind(accountId, since),
  ]);
}

const roomStub = (env, code) => env.ROOMS.get(env.ROOMS.idFromName(code));

/**
 * GET /v1/rooms/:code/ws — WebSocket 업그레이드.
 * 토큰은 쿼리로 받는다 (브라우저 WebSocket 은 헤더를 붙일 수 없다).
 */
async function joinRoom(req, env, url, code, role) {
  if (!ROOM_CODE_RE.test(code)) return fail(400, 'bad_code', '방 코드 형식이 올바르지 않습니다.');

  const token = url.searchParams.get('token');
  if (!token) return fail(401, 'unauthorized', '토큰이 필요합니다.');
  const account = await env.DB.prepare(
    'SELECT id FROM account WHERE token_hash = ?'
  ).bind(await sha256(token)).first();
  if (!account) return fail(401, 'unauthorized', '토큰이 올바르지 않습니다.');

  const limited = await checkJoinLimit(env, account.id);
  if (limited) return limited;

  const stub = roomStub(env, code);

  // 게스트는 존재하는 방에만 들어갈 수 있다. 없는 방을 두드린 시도는 기록해 둔다.
  if (role !== 'host') {
    const peek = await stub.fetch(new Request('https://room/peek'));
    const info = await peek.json();
    await logJoin(env, account.id, info.exists);
    if (!info.exists) return fail(404, 'no_room', '그런 방이 없어요.');
    if (info.full) return fail(409, 'room_full', '방이 가득 찼어요.');
  } else {
    await logJoin(env, account.id, true);
  }

  const target = new URL('https://room/connect');
  target.searchParams.set('account', account.id);
  target.searchParams.set('role', role);
  return stub.fetch(new Request(target, req));
}

/** GET /v1/leaderboard?diff=&week=&limit= — 읽기는 인증이 필요 없다. */
async function leaderboard(url, env) {
  const rawDiff = url.searchParams.get('diff');
  const diff = DIFFS.has(rawDiff) ? rawDiff : 'normal';
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 10));
  const offset = Number(url.searchParams.get('week_offset')) || 0;
  const week = url.searchParams.get('week') || isoWeek(Date.now() + offset * 7 * 86400000);

  const { results } = await env.DB.prepare(
    `SELECT account_id, nick, day, earned, lv, multi FROM score
     WHERE week = ? AND diff = ?
     ORDER BY day DESC, earned DESC LIMIT ?`
  ).bind(week, diff, limit).all();

  return json({ week, diff, rows: results || [] });
}

/** GET /v1/me — 내 계정 요약 (클라이언트가 토큰 유효성을 확인할 때 사용) */
async function me(account) {
  return json({ account_id: account.id, nick: account.nick, max_earned: account.max_earned });
}

/* ═══════════ 라우팅 ═══════════ */

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '/' || path === '/v1') return json({ ok: true, service: 'tycoon-b' });

      if (req.method === 'POST' && path === '/v1/accounts') return createAccount(req, env);
      if (req.method === 'POST' && path === '/v1/accounts/recover') return recoverAccount(req, env);
      if (req.method === 'GET' && path === '/v1/leaderboard') return leaderboard(url, env);

      // 명부 읽기는 공개. 다만 전체 구독이 아니라 건수 제한이 걸린 조회다.
      if (req.method === 'GET' && path === '/v1/profiles') return listProfiles(url, env);
      const profileGet = path.match(/^\/v1\/profiles\/([A-Za-z0-9_]+)$/);
      if (req.method === 'GET' && profileGet && profileGet[1] !== 'me') {
        return getProfile(env, profileGet[1]);
      }

      // WebSocket 은 헤더를 못 붙이므로 쿼리 토큰으로 인증한다 (joinRoom 내부에서 검사)
      const roomWs = path.match(/^\/v1\/rooms\/([A-Za-z0-9]{1,8})\/(ws|host)$/);
      if (roomWs) {
        return joinRoom(req, env, url, roomWs[1].toUpperCase(), roomWs[2] === 'host' ? 'host' : 'guest');
      }

      // ── 여기서부터는 토큰이 필요하다 ──
      const account = await authenticate(req, env);
      if (!account) return fail(401, 'unauthorized', '토큰이 필요합니다.');

      if (req.method === 'GET' && path === '/v1/me') return me(account);
      if (req.method === 'POST' && path === '/v1/runs') return startRun(req, env, account);
      if (req.method === 'PUT' && path === '/v1/profiles/me') return putProfile(req, env, account);

      const submit = path.match(/^\/v1\/runs\/([A-Za-z0-9_]+)\/submit$/);
      if (req.method === 'POST' && submit) return submitScore(req, env, account, submit[1]);

      return fail(404, 'not_found', '없는 경로입니다.');
    } catch (err) {
      console.error('unhandled', err && err.stack ? err.stack : err);
      return fail(500, 'internal', '서버 오류가 발생했습니다.');
    }
  },
};

// 테스트에서 직접 검증할 수 있도록 순수 함수만 내보낸다
export { isoWeek, newRecoveryCode, cleanNick };
