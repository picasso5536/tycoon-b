/**
 * 방 하나 = Durable Object 하나 (2단계)
 *
 * MQTT 를 대체한다. 바뀌는 것:
 *   - 와일드카드 구독이 존재하지 않는다. 남의 방을 훔쳐볼 방법이 구조적으로 없다.
 *   - meta 발행은 호스트만 가능하다. MQTT 에서는 누구나 방 상태를 조작할 수 있었다.
 *   - 자리(host/guest)를 서버가 배정한다. 상대 슬롯에 위조 상태를 주입할 수 없다.
 *
 * 프로토콜은 기존 MQTT 토픽 구조를 그대로 옮겼다.
 *   {t:'meta',  ...}  ← 방 상태 (호스트만 발행)
 *   {t:'state', ...}  ← 내 게임 블롭 (각자 자기 자리에만)
 *   {t:'ping',  ...}  ← 상대에게 보내는 한마디
 *
 * MQTT 의 retain 과 같은 동작이 필요하다. 나중에 들어온 쪽이 현재 상태를
 * 즉시 봐야 하므로 마지막 meta 와 각 자리의 마지막 state 를 들고 있다가
 * 접속 직후 보내 준다.
 */

const MAX_MEMBERS = 2;
const MAX_MESSAGE_BYTES = 64 * 1024;
/** 아무도 없는 방을 정리하기까지의 유예 (재접속 여유) */
const EMPTY_ROOM_TTL_MS = 5 * 60 * 1000;

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    /** 마지막 meta 와 자리별 마지막 state — retain 대체 */
    this.retained = { meta: null, host: null, guest: null };
    this.state.blockConcurrencyWhile(async () => {
      const saved = await this.state.storage.get('retained');
      if (saved) this.retained = saved;
    });
  }

  /** 현재 접속자들의 자리 목록 */
  occupiedRoles() {
    return this.state.getWebSockets()
      .map((ws) => this.meta(ws)?.role)
      .filter(Boolean);
  }

  meta(ws) {
    try {
      return ws.deserializeAttachment();
    } catch {
      return null;
    }
  }

  async fetch(req) {
    const url = new URL(req.url);

    // 방 상태 조회 (참가 전에 자리가 있는지 확인)
    if (url.pathname.endsWith('/peek')) {
      const roles = this.occupiedRoles();
      return Response.json({
        exists: !!this.retained.meta || roles.length > 0,
        members: roles.length,
        full: roles.length >= MAX_MEMBERS,
        roles,
      });
    }

    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const accountId = url.searchParams.get('account');
    const wantRole = url.searchParams.get('role') === 'host' ? 'host' : 'guest';
    if (!accountId) return new Response('missing account', { status: 400 });

    const roles = this.occupiedRoles();
    if (roles.includes(wantRole)) {
      // 같은 자리에 이미 누가 있다. 같은 계정이면 재접속으로 보고 이전 연결을 끊는다.
      const previous = this.state.getWebSockets()
        .find((ws) => this.meta(ws)?.role === wantRole);
      if (previous && this.meta(previous)?.accountId === accountId) {
        try { previous.close(4000, 'replaced'); } catch { /* 이미 닫힘 */ }
      } else {
        return new Response('role taken', { status: 409 });
      }
    } else if (roles.length >= MAX_MEMBERS) {
      return new Response('room full', { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernation API — 유휴 방은 메모리에서 내려가고 비용이 들지 않는다
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ role: wantRole, accountId, joinedAt: Date.now() });

    // retain 재생: 지금까지의 상태를 새 접속자에게 즉시 보낸다
    if (this.retained.meta) server.send(JSON.stringify(this.retained.meta));
    const otherRole = wantRole === 'host' ? 'guest' : 'host';
    if (this.retained[otherRole]) server.send(JSON.stringify(this.retained[otherRole]));

    this.broadcast(JSON.stringify({ t: 'presence', role: wantRole, joined: true }), server);
    await this.state.storage.setAlarm(Date.now() + EMPTY_ROOM_TTL_MS);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) {
      ws.send(JSON.stringify({ t: 'error', message: 'message too large' }));
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ t: 'error', message: 'bad json' }));
      return;
    }

    const self = this.meta(ws);
    if (!self) return;

    // ── 권한 검사 ──
    // 자리는 서버가 배정한 값으로 덮어쓴다. 클라이언트가 role 을 주장해도 무시된다.
    if (msg.t === 'meta') {
      if (self.role !== 'host') {
        ws.send(JSON.stringify({ t: 'error', message: 'only host can publish meta' }));
        return;
      }
      this.retained.meta = { ...msg, t: 'meta' };
    } else if (msg.t === 'state') {
      msg = { ...msg, t: 'state', role: self.role };
      this.retained[self.role] = msg;
    } else if (msg.t === 'ping') {
      msg = { ...msg, t: 'ping', role: self.role };
    } else {
      ws.send(JSON.stringify({ t: 'error', message: 'unknown type' }));
      return;
    }

    await this.state.storage.put('retained', this.retained);
    this.broadcast(JSON.stringify(msg), ws);
  }

  webSocketClose(ws) {
    const self = this.meta(ws);
    if (self) this.broadcast(JSON.stringify({ t: 'presence', role: self.role, joined: false }), ws);
  }

  webSocketError(ws) {
    this.webSocketClose(ws);
  }

  /** 보낸 사람을 뺀 나머지에게 전달 */
  broadcast(text, except) {
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(text); } catch { /* 끊긴 소켓은 무시 */ }
    }
  }

  /** 빈 방 정리 — 남아 있는 retain 데이터를 지운다 */
  async alarm() {
    if (this.state.getWebSockets().length > 0) {
      await this.state.storage.setAlarm(Date.now() + EMPTY_ROOM_TTL_MS);
      return;
    }
    await this.state.storage.deleteAll();
    this.retained = { meta: null, host: null, guest: null };
  }
}
