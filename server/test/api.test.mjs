/**
 * 통합 테스트 — 로컬 wrangler dev(http://127.0.0.1:8787)에 대고 돈다.
 *
 *   터미널 1:  npm run dev
 *   터미널 2:  npm test
 *
 * 검증 대상은 "막으려던 것이 실제로 막히는가"다.
 * 성공 경로보다 거부 경로에 무게를 뒀다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE || 'http://127.0.0.1:8787';

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 본문이 JSON 이 아닐 수 있다 */ }
  return { status: res.status, body: json, text };
}

const newAccount = async (nick) =>
  (await api('POST', '/v1/accounts', { body: { nick } })).body;

/**
 * 경과시간 검증을 통과하려면 판이 과거에 시작돼 있어야 한다.
 * 테스트에서 몇 분씩 기다릴 수는 없으니 로컬 D1 을 직접 손대 시작 시각을 앞당긴다.
 * (로컬 개발 DB 한정. 서버 코드에는 시간을 조작할 경로가 없다.)
 */
async function backdateRun(runId, seconds) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const started = Date.now() - seconds * 1000;
  await promisify(execFile)('npx', [
    'wrangler', 'd1', 'execute', 'tycoon-b', '--local',
    '--command', `UPDATE run SET started_at = ${started} WHERE id = '${runId}'`,
  ], { cwd: new URL('..', import.meta.url).pathname });
}

test('0단계 · 계정 발급 — 토큰과 복구 코드가 나온다', async () => {
  const account = await newAccount('사장님');
  assert.match(account.account_id, /^acc_[0-9a-f]{32}$/);
  assert.match(account.token, /^tok_[0-9a-f]{32}$/);
  assert.match(account.recovery_code, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
  assert.equal(account.nick, '사장님');
});

test('0단계 · 토큰 없이 보호된 경로에 접근하면 401', async () => {
  assert.equal((await api('POST', '/v1/runs')).status, 401);
  assert.equal((await api('GET', '/v1/me')).status, 401);
  assert.equal((await api('POST', '/v1/runs', { token: 'tok_deadbeef' })).status, 401);
});

test('0단계 · 복구 코드로 기기를 옮기면 이전 토큰이 무효화된다', async () => {
  const account = await newAccount('이사갈사람');
  const recovered = await api('POST', '/v1/accounts/recover', {
    body: { recovery_code: account.recovery_code },
  });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.account_id, account.account_id);
  assert.notEqual(recovered.body.token, account.token);

  // 새 토큰은 되고, 옛 토큰은 안 된다 (토큰 회전)
  assert.equal((await api('GET', '/v1/me', { token: recovered.body.token })).status, 200);
  assert.equal((await api('GET', '/v1/me', { token: account.token })).status, 401);
});

test('0단계 · 틀린 복구 코드는 404', async () => {
  const res = await api('POST', '/v1/accounts/recover', {
    body: { recovery_code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' },
  });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'bad_code');
});

test('1단계 · 남의 판에는 점수를 얹을 수 없다', async () => {
  const alice = await newAccount('앨리스');
  const mallory = await newAccount('맬러리');
  const run = await api('POST', '/v1/runs', { token: alice.token, body: { diff: 'normal' } });

  const res = await api('POST', `/v1/runs/${run.body.run_id}/submit`, {
    token: mallory.token,
    body: { day: 1, earned: 1000 },
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'not_owner');
});

test('1단계 · 경과시간을 넘는 일수는 거부된다 (즉시 999일 제출 차단)', async () => {
  const account = await newAccount('빨리감기');
  const run = await api('POST', '/v1/runs', { token: account.token, body: { diff: 'normal' } });

  // MAX_DAY(500) 안쪽이라 형식 검사는 통과하고 경과시간 검사에 걸려야 한다
  const res = await api('POST', `/v1/runs/${run.body.run_id}/submit`, {
    token: account.token,
    body: { day: 400, earned: 5000 },
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'too_fast');
});

test('1단계 · 형식이 잘못된 일수·점수는 거부된다', async () => {
  const account = await newAccount('이상한값');
  const run = await api('POST', '/v1/runs', { token: account.token, body: {} });
  const id = run.body.run_id;

  for (const [body, code] of [
    [{ day: 0, earned: 100 }, 'bad_day'],
    [{ day: -5, earned: 100 }, 'bad_day'],
    [{ day: 1.5, earned: 100 }, 'bad_day'],
    [{ day: 99999, earned: 100 }, 'bad_day'],
    [{ day: 1, earned: -1 }, 'bad_earned'],
    [{ day: 1, earned: 1.5 }, 'bad_earned'],
    [{ day: 1, earned: 'abc' }, 'bad_earned'],
  ]) {
    const res = await api('POST', `/v1/runs/${id}/submit`, { token: account.token, body });
    assert.equal(res.body.error, code, `${JSON.stringify(body)} → ${res.body.error}`);
  }
});

test('1단계 · 없는 판에 제출하면 404', async () => {
  const account = await newAccount('유령판');
  const res = await api('POST', '/v1/runs/run_없는판/submit', {
    token: account.token,
    body: { day: 1, earned: 100 },
  });
  assert.equal(res.status, 404);
});

test('1단계 · 랭킹 조회는 인증 없이 되고, 주차를 서버가 정한다', async () => {
  const res = await api('GET', '/v1/leaderboard?diff=normal');
  assert.equal(res.status, 200);
  assert.match(res.body.week, /^\d{4}-W\d{2}$/);
  assert.equal(res.body.diff, 'normal');
  assert.ok(Array.isArray(res.body.rows));
});

test('1단계 · 알 수 없는 난이도는 normal 로 떨어진다', async () => {
  const res = await api('GET', '/v1/leaderboard?diff=치트모드');
  assert.equal(res.body.diff, 'normal');
});

test('2단계 · 명부는 본인만 쓸 수 있고, 조회는 건수가 제한된다', async () => {
  const account = await newAccount('가게주인');
  const put = await api('PUT', '/v1/profiles/me', {
    token: account.token,
    body: { nick: '가게주인', avatar: 'av_bear', lv: 7, sold: 123, streak: 4 },
  });
  assert.equal(put.status, 200);

  // 토큰 없이는 못 쓴다
  assert.equal((await api('PUT', '/v1/profiles/me', { body: { nick: '위조' } })).status, 401);

  const mine = await api('GET', `/v1/profiles/${account.account_id}`);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.n, '가게주인');
  assert.equal(mine.body.lv, 7);

  // limit 을 크게 불러도 서버가 잘라낸다 (전체 명부 긁기 차단)
  const all = await api('GET', '/v1/profiles?limit=9999');
  assert.ok(all.body.rows.length <= 30, `limit 무시됨: ${all.body.rows.length}`);
});

test('2단계 · 방 코드 형식이 틀리면 거부된다', async () => {
  const account = await newAccount('방찾기');
  // 혼동 문자(I, O, 0, 1)는 코드 문자셋에 없다
  const res = await fetch(`${BASE}/v1/rooms/IOOI/ws?token=${account.token}`);
  assert.equal(res.status, 400);
});

test('2단계 · 없는 방에 들어가려 하면 404', async () => {
  const account = await newAccount('허탕');
  const res = await fetch(`${BASE}/v1/rooms/ZZZZ/ws?token=${account.token}`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'no_room');
});

test('2단계 · 토큰 없이는 방에 접근할 수 없다', async () => {
  const res = await fetch(`${BASE}/v1/rooms/ABCD/ws`);
  assert.equal(res.status, 401);
});

test('2단계 · 방 참가 시도가 잦으면 제한된다 (코드 무차별 대입 차단)', async () => {
  const account = await newAccount('브루트포서');
  let limited = false;
  // 존재하지 않는 코드를 연달아 두드린다
  for (let i = 0; i < 20 && !limited; i++) {
    const code = 'AAA' + 'BCDEFGHJKMNPQRSTUVWX'[i];
    const res = await fetch(`${BASE}/v1/rooms/${code}/ws?token=${account.token}`);
    if (res.status === 429) limited = true;
  }
  assert.ok(limited, '20회 시도 안에 429 가 나오지 않았다');
});

test('3단계 · 리플레이 검증 규칙', async () => {
  const { validateReplay } = await import('../src/replay.js');

  // 정상 로그
  assert.equal(validateReplay([[100, 2, 1400], [5000, 1, 700]], 2100).ok, true);

  // 합계 불일치 — 총액만 부풀린 제출
  const mismatch = validateReplay([[100, 2, 1400]], 999999);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'sum_mismatch');

  // 시간 역행
  assert.equal(validateReplay([[5000, 1, 700], [100, 1, 700]], 1400).code, 'time_not_monotonic');

  // 하루 길이를 벗어난 시각
  assert.equal(validateReplay([[999999, 1, 700]], 700).code, 'time_out_of_range');

  // 한 건에 나올 수 없는 금액
  assert.equal(validateReplay([[100, 1, 99999999]], 99999999).code, 'pay_too_high');

  // 주문 개수 상한 초과
  assert.equal(validateReplay([[100, 99, 700]], 700).code, 'bad_count');

  // 하루 판매 건수 상한 초과
  const tooMany = Array.from({ length: 500 }, (_, i) => [i * 10, 1, 700]);
  assert.equal(validateReplay(tooMany, 350000).code, 'log_too_long');

  // 배열이 아닌 로그
  assert.equal(validateReplay('로그아님', 0).code, 'log_not_array');
});

test('3단계 · 상위권 제출은 판매 로그를 요구하고, 정합하면 통과한다', async () => {
  const account = await newAccount('상위권');
  const run = await api('POST', '/v1/runs', { token: account.token, body: { diff: 'vhard' } });
  const id = run.body.run_id;
  // day 2 를 제출하려면 120초가 필요하다. 넉넉히 앞당긴다.
  await backdateRun(id, 600);

  // (a) 로그 없이 상위권 제출 → 거부
  const noLog = await api('POST', `/v1/runs/${id}/submit`, {
    token: account.token,
    body: { day: 2, earned: 5000, day_sales: 5000 },
  });
  assert.equal(noLog.status, 422);
  assert.equal(noLog.body.error, 'replay_required');

  // (b) 합계가 안 맞는 로그 → 거부
  const badLog = await api('POST', `/v1/runs/${id}/submit`, {
    token: account.token,
    body: { day: 2, earned: 5000, day_sales: 5000, log: [[100, 1, 700]] },
  });
  assert.equal(badLog.status, 422);
  assert.equal(badLog.body.error, 'sum_mismatch');

  // (c) 정합한 로그 → 통과하고 보드에 오른다
  const good = await api('POST', `/v1/runs/${id}/submit`, {
    token: account.token,
    body: {
      day: 2, earned: 5000, day_sales: 2100,
      log: [[100, 2, 1400], [5000, 1, 700]],
    },
  });
  assert.equal(good.status, 200, good.text);
  assert.equal(good.body.accepted, true);

  const board = await api('GET', '/v1/leaderboard?diff=vhard');
  assert.ok(board.body.rows.some((r) => r.account_id === account.account_id),
    '검증을 통과한 기록이 보드에 없다');
});

test('1단계 · 같은 일수를 다시 제출하면 거부된다 (일수 단조성)', async () => {
  const account = await newAccount('되감기');
  const run = await api('POST', '/v1/runs', { token: account.token, body: { diff: 'easy' } });
  const id = run.body.run_id;
  await backdateRun(id, 600);

  const first = await api('POST', `/v1/runs/${id}/submit`, {
    token: account.token,
    body: { day: 3, earned: 9000, day_sales: 2100, log: [[100, 2, 1400], [5000, 1, 700]] },
  });
  assert.equal(first.status, 200, first.text);

  const again = await api('POST', `/v1/runs/${id}/submit`, {
    token: account.token,
    body: { day: 3, earned: 99000, day_sales: 2100, log: [[100, 2, 1400], [5000, 1, 700]] },
  });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'day_not_advanced');
});

test('1단계 · 매출 증분이 물리적 상한을 넘으면 거부된다', async () => {
  const account = await newAccount('돈복사');
  const run = await api('POST', '/v1/runs', { token: account.token, body: { diff: 'hard' } });
  const id = run.body.run_id;
  await backdateRun(id, 600);

  // day 2 → 상한은 2 × 144만 = 288만. 그 위를 시도한다.
  const res = await api('POST', `/v1/runs/${id}/submit`, {
    token: account.token,
    body: { day: 2, earned: 999999999, day_sales: 0, log: [] },
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'earned_too_high');
});

test('보안 · 랭킹에 토큰이나 해시가 새지 않는다', async () => {
  const res = await api('GET', '/v1/leaderboard');
  assert.doesNotMatch(res.text, /tok_|token_hash|recovery/, '민감 필드가 응답에 포함됨');
});
