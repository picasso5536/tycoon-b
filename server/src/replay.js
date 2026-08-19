/**
 * 리플레이 정합성 검증 (3단계)
 *
 * 무엇을 하는가 — 그리고 무엇을 하지 않는가.
 *
 * 이건 "재시뮬레이션"이 아니라 "정합성 검사"다. 게임의 정확한 수익 공식
 * (팁·콤보·손님 종류·업그레이드·꾸미기 효과가 전부 얽힌다)을 서버에서
 * 그대로 재현하려면 게임 로직을 통째로 서버에 옮겨야 하는데, 그건 이 게임에
 * 치를 비용이 아니다. 대신 판매 로그가 **게임 규칙상 가능한 범위 안에**
 * 있는지를 본다.
 *
 * 걸러내는 것:
 *   - 합계와 로그가 안 맞는 제출 (총액만 부풀린 경우)
 *   - 물리적으로 불가능한 판매 속도 (하루에 손님 수 초과)
 *   - 한 건에 나올 수 없는 금액 (모든 배수를 곱해도 안 나오는 값)
 *   - 시간이 거꾸로 가거나 하루 길이를 벗어난 로그
 *
 * 못 걸러내는 것:
 *   - 규칙에 맞게 정교하게 지어낸 가짜 로그. 이건 개조 클라이언트로 가능하다.
 *     문턱을 크게 올릴 뿐 없애지는 못한다.
 */

/* ═══════════ 게임 상수에서 유도한 경계 ═══════════ */
const DAY_LEN_MS = 120 * 1000;
const MAX_PRICE = 1500;          // 피자 붕어빵
const MAX_ORDER_ITEMS = 4;       // orderMax 상한
/** 하루 최대 손님 수 — 러시아워에 생성 간격이 약 0.5초까지 좁혀진다 */
const MAX_SERVES_PER_DAY = 240;

/**
 * 한 건에 가능한 최대 배수.
 *   팁 1.5 (tip15 이벤트) × 단체 1.3 × 미스터리 3 × 콤보 2 × 업그레이드/꾸미기 여유 1.5
 * 실제로 이 모두가 동시에 걸리진 않지만, 상한은 넉넉해야 정상 플레이를 막지 않는다.
 */
const MAX_PAY_MULTIPLIER = 1.5 * 1.3 * 3 * 2 * 1.5;
const MAX_PAY_PER_SERVE = Math.ceil(MAX_PRICE * MAX_ORDER_ITEMS * MAX_PAY_MULTIPLIER);

/** 로그 크기 상한 — 서버를 압박하는 거대 페이로드 차단 */
export const MAX_LOG_EVENTS = MAX_SERVES_PER_DAY;

/**
 * @param {Array} log  판매 이벤트 [[경과ms, 개수, 금액], ...]
 * @param {number} daySales  클라이언트가 주장하는 그날 매출
 * @returns {{ok: true} | {ok: false, code: string, detail: string}}
 */
export function validateReplay(log, daySales) {
  if (!Array.isArray(log)) {
    return { ok: false, code: 'log_not_array', detail: '로그 형식이 올바르지 않습니다.' };
  }
  if (log.length > MAX_LOG_EVENTS) {
    return { ok: false, code: 'log_too_long', detail: `판매 건수가 하루 상한(${MAX_LOG_EVENTS})을 넘습니다.` };
  }

  let total = 0;
  let items = 0;
  let previousTime = -1;

  for (let i = 0; i < log.length; i++) {
    const event = log[i];
    if (!Array.isArray(event) || event.length !== 3) {
      return { ok: false, code: 'bad_event', detail: `${i}번째 이벤트 형식 오류` };
    }
    const [t, cnt, pay] = event.map(Number);

    if (!Number.isFinite(t) || t < 0 || t > DAY_LEN_MS) {
      return { ok: false, code: 'time_out_of_range', detail: `${i}번째 이벤트 시각이 하루 범위 밖` };
    }
    // 시간은 뒤로 갈 수 없다
    if (t < previousTime) {
      return { ok: false, code: 'time_not_monotonic', detail: `${i}번째 이벤트에서 시간이 역행` };
    }
    previousTime = t;

    if (!Number.isInteger(cnt) || cnt < 1 || cnt > MAX_ORDER_ITEMS) {
      return { ok: false, code: 'bad_count', detail: `${i}번째 이벤트 개수가 범위 밖` };
    }
    if (!Number.isInteger(pay) || pay < 0 || pay > MAX_PAY_PER_SERVE) {
      return { ok: false, code: 'pay_too_high', detail: `${i}번째 이벤트 금액이 상한 초과` };
    }
    total += pay;
    items += cnt;
  }

  // 총액이 로그와 맞아야 한다 — "로그는 짧은데 점수만 큰" 제출을 여기서 잡는다
  if (total !== Math.round(daySales)) {
    return {
      ok: false,
      code: 'sum_mismatch',
      detail: `로그 합계 ${total} 와 제출 매출 ${Math.round(daySales)} 가 다릅니다.`,
    };
  }

  return { ok: true, serves: log.length, items };
}

export const REPLAY_LIMITS = {
  DAY_LEN_MS,
  MAX_SERVES_PER_DAY,
  MAX_PAY_PER_SERVE,
  MAX_ORDER_ITEMS,
};
