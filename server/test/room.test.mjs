/**
 * 방(Durable Object) 통합 테스트 — 실제 WebSocket 두 개를 붙여 확인한다.
 *
 * MQTT 대비 무엇이 달라졌는지를 검증한다:
 *   - 자리를 서버가 배정하고, 같은 자리에 남이 못 들어온다
 *   - meta 는 호스트만 발행할 수 있다 (MQTT 에서는 누구나 가능했다)
 *   - retain 대체: 늦게 들어온 쪽이 현재 상태를 즉시 받는다
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'undici';

/** 열린 소켓을 모두 추적해 테스트 끝에 정리한다 (안 그러면 프로세스가 안 끝난다) */
const openSockets = new Set();
after(() => {
  for (const ws of openSockets) {
    try { ws.close(); } catch { /* 이미 닫힘 */ }
  }
  openSockets.clear();
});

const BASE = process.env.API_BASE || 'http://127.0.0.1:8787';
const WS_BASE = BASE.replace(/^http/, 'ws');

/**
 * 방(Durable Object) 상태는 wrangler dev 세션 동안 유지된다.
 * 코드를 고정하면 이전 실행이 남긴 상태에 걸리므로 매번 새 코드를 쓴다.
 */
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const randomCode = () =>
  Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

async function newAccount(nick) {
  const res = await fetch(`${BASE}/v1/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nick }),
  });
  return res.json();
}

/** 방에 붙고, 받은 메시지를 순서대로 쌓아 두는 헬퍼 */
function connect(code, token, role) {
  const ws = new WebSocket(`${WS_BASE}/v1/rooms/${code}/${role === 'host' ? 'host' : 'ws'}?token=${token}`);
  openSockets.add(ws);
  const inbox = [];
  const waiters = [];

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    inbox.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(msg)) {
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });

  return {
    ws,
    inbox,
    open: () => new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve('open'), { once: true });
      ws.addEventListener('error', () => reject(new Error('연결 거부됨')), { once: true });
    }),
    /** 열렸는지 거부됐는지만 알려 준다 (실패를 기대하는 테스트용) */
    tryOpen: () => new Promise((resolve) => {
      ws.addEventListener('open', () => resolve('open'), { once: true });
      ws.addEventListener('error', () => resolve('rejected'), { once: true });
      ws.addEventListener('close', () => resolve('rejected'), { once: true });
      setTimeout(() => resolve('timeout'), 3000);
    }),
    send: (obj) => ws.send(JSON.stringify(obj)),
    /** 조건에 맞는 메시지를 기다린다 (이미 와 있으면 즉시) */
    expect: (match, ms = 3000) => new Promise((resolve, reject) => {
      const hit = inbox.find(match);
      if (hit) return resolve(hit);
      const timer = setTimeout(
        () => reject(new Error(`대기 시간 초과. 받은 것: ${JSON.stringify(inbox)}`)), ms);
      waiters.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    }),
    close: () => { openSockets.delete(ws); try { ws.close(); } catch { /* 이미 닫힘 */ } },
  };
}

test('2단계 · 호스트와 게스트가 상태를 주고받는다', async () => {
  const host = await newAccount('호스트');
  const guest = await newAccount('게스트');
  const code = randomCode();

  const h = connect(code, host.token, 'host');
  await h.open();

  const g = connect(code, guest.token, 'guest');
  await g.open();

  // 호스트가 meta 를 발행하면 게스트가 받는다
  h.send({ t: 'meta', day: 1, state: 'playing', startedAt: 1000 });
  const meta = await g.expect((m) => m.t === 'meta');
  assert.equal(meta.day, 1);
  assert.equal(meta.state, 'playing');

  // 게스트의 state 는 호스트에게 간다. role 은 서버가 붙인다.
  g.send({ t: 'state', earned: 500, served: 3 });
  const state = await h.expect((m) => m.t === 'state');
  assert.equal(state.earned, 500);
  assert.equal(state.role, 'guest', '서버가 자리를 붙여야 한다');

  h.close();
  g.close();
});

test('2단계 · 게스트는 meta 를 발행할 수 없다', async () => {
  const host = await newAccount('진짜호스트');
  const guest = await newAccount('참견꾼');
  const code = randomCode();

  const h = connect(code, host.token, 'host');
  await h.open();
  const g = connect(code, guest.token, 'guest');
  await g.open();

  // MQTT 에서는 아무나 meta 토픽에 쓸 수 있었다. 이제는 거부된다.
  g.send({ t: 'meta', day: 999, state: 'ended' });
  const err = await g.expect((m) => m.t === 'error');
  assert.match(err.message, /only host/);

  // 호스트에게 위조 meta 가 전달되지 않았는지 확인
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!h.inbox.some((m) => m.t === 'meta' && m.day === 999),
    '게스트가 보낸 meta 가 호스트에게 새어 나갔다');

  h.close();
  g.close();
});

test('2단계 · 늦게 들어와도 현재 상태를 즉시 받는다 (retain 대체)', async () => {
  const host = await newAccount('선입장');
  const late = await newAccount('후입장');
  const code = randomCode();

  const h = connect(code, host.token, 'host');
  await h.open();
  h.send({ t: 'meta', day: 5, state: 'playing', startedAt: 42 });
  h.send({ t: 'state', earned: 12345 });
  await new Promise((r) => setTimeout(r, 300)); // 저장될 시간

  // 이제 들어온 게스트는 지난 meta 와 호스트 state 를 바로 받아야 한다
  const g = connect(code, late.token, 'guest');
  await g.open();

  const meta = await g.expect((m) => m.t === 'meta');
  assert.equal(meta.day, 5);
  const hostState = await g.expect((m) => m.t === 'state' && m.role === 'host');
  assert.equal(hostState.earned, 12345);

  h.close();
  g.close();
});

test('2단계 · 세 번째 사람은 방에 못 들어온다', async () => {
  const a = await newAccount('첫째');
  const b = await newAccount('둘째');
  const c = await newAccount('셋째');
  const code = randomCode();

  const h = connect(code, a.token, 'host');
  await h.open();
  const g = connect(code, b.token, 'guest');
  await g.open();

  // 자리가 다 찼으므로 참가 자체가 거부된다
  const res = await fetch(`${BASE}/v1/rooms/${code}/ws?token=${c.token}`);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'room_full');

  h.close();
  g.close();
});

test('2단계 · 남의 자리를 뺏을 수 없다', async () => {
  const host = await newAccount('자리주인');
  const thief = await newAccount('자리도둑');
  const code = randomCode();

  const h = connect(code, host.token, 'host');
  await h.open();

  // 업그레이드 없는 평범한 요청은 방까지 가지도 못한다
  const plain = await fetch(`${BASE}/v1/rooms/${code}/host?token=${thief.token}`);
  assert.equal(plain.status, 426);

  // 실제 WebSocket 으로 host 자리를 요구해도 이미 주인이 있으므로 열리지 않는다
  const t = connect(code, thief.token, 'host');
  assert.equal(await t.tryOpen(), 'rejected', '남의 자리에 연결이 열렸다');
  t.close();

  // 주인의 연결은 멀쩡히 살아 있어야 한다
  h.send({ t: 'meta', day: 1, state: 'playing' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(h.ws.readyState, 1, '도둑의 시도가 주인 연결을 끊었다');

  h.close();
});

test('2단계 · 방마다 완전히 분리된다 (와일드카드 구독 불가)', async () => {
  const a = await newAccount('A방');
  const b = await newAccount('B방');

  const roomA = connect(randomCode(), a.token, 'host');
  await roomA.open();
  const roomB = connect(randomCode(), b.token, 'host');
  await roomB.open();

  roomA.send({ t: 'meta', day: 1, secret: 'A방의비밀' });
  await new Promise((r) => setTimeout(r, 400));

  // B 방에는 A 방의 어떤 것도 도달하지 않아야 한다
  assert.equal(roomB.inbox.filter((m) => m.t === 'meta').length, 0,
    'A 방의 meta 가 B 방으로 샜다');

  roomA.close();
  roomB.close();
});
