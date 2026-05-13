/**
 * Chrome NetLog (chrome://net-export) 파일을 파싱해 booking-data.json을 생성.
 *
 * 가장 강력한 우회 전략: 자동화 도구가 페이지/네트워크에 일절 손대지 않습니다.
 * 사용자는 평범한 브라우저에서 ticketlink을 방문하기만 하고, Chrome이 내장
 * 네트워크 로거(chrome://net-export)로 모든 요청/응답을 디스크에 덤프합니다.
 * 우리는 그 JSON을 오프라인에서 읽어 schedules API 응답만 골라냅니다.
 *
 * 왜 이 방법이 통과하는가:
 *   - F12 차단을 우회: chrome://net-export 는 별도 페이지로 DevTools가 아닙니다
 *   - PerimeterX 가 감지할 자동화 시그니처가 0 (브라우저가 평범히 동작)
 *   - 사용자 탭에 attach 하지도 않고, navigate 하지도 않고, JS도 안 넣음
 *
 * 사용:
 *   1) Chrome 주소창에 입력: chrome://net-export/
 *   2) "Include raw bytes (...) 옵션"을 체크 (← 응답 본문이 들어가야 함)
 *   3) "Start Logging to Disk" → 저장 위치 선택 (예: C:\temp\ticketlink.json)
 *   4) 다른 탭에서 https://m.ticketlink.co.kr/sports/137/57 방문하고 페이지 로드 대기
 *      (이미 열린 탭이라면 F5 새로고침. 월/날짜 필터를 클릭해서 더 많은 데이터 수집해도 좋음)
 *   5) chrome://net-export 로 돌아가 "Stop Logging" 클릭
 *   6) 터미널에서: node scripts/parse-netlog.js "C:\temp\ticketlink.json"
 *      또는: npm run parse:netlog -- "C:\temp\ticketlink.json"
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');

const NETLOG_PATH = process.argv[2];
const OUTPUT_PATH = path.resolve(process.cwd(), 'booking-data.json');
const SOURCE_URL = process.env.TICKETLINK_SAMSUNG_URL || 'https://m.ticketlink.co.kr/sports/137/57';
const BOOKING_URL_PATTERN = process.env.TICKETLINK_BOOKING_URL_PATTERN
  || 'https://m.ticketlink.co.kr/reserve/product/{productId}?scheduleId={scheduleId}';
const KST_TIME_ZONE = 'Asia/Seoul';
const DEBUG = !!process.env.NETLOG_DEBUG;

if (!NETLOG_PATH) {
  console.error('사용: node scripts/parse-netlog.js <NetLogJSON경로>');
  console.error('');
  console.error('절차:');
  console.error('  1) Chrome 주소창에 입력: chrome://net-export/');
  console.error('  2) [중요] "Include raw bytes" 체크 (응답 본문 캡처)');
  console.error('  3) "Start Logging to Disk" → 저장 파일 선택');
  console.error('  4) 다른 탭에서 https://m.ticketlink.co.kr/sports/137/57 방문/새로고침');
  console.error('  5) chrome://net-export 에서 "Stop Logging"');
  console.error('  6) node scripts/parse-netlog.js "저장한_파일_경로.json"');
  process.exit(1);
}

function log(...args) {
  console.log('[netlog]', ...args);
}

function buildBookingUrl(productId, scheduleId) {
  return BOOKING_URL_PATTERN
    .replace('{productId}', encodeURIComponent(String(productId)))
    .replace('{scheduleId}', encodeURIComponent(String(scheduleId)));
}

function parseDateTime(str) {
  if (!str) return { date: null, time: null };
  const s = String(str);
  let m = s.match(/(\d{4})-?(\d{2})-?(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}:${m[6] || '00'}` };
  m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}:${m[6] || '00'}` };
  m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: null };
  return { date: null, time: null };
}

function mapApiSchedule(s) {
  const home = s.homeTeam?.teamName || '';
  const away = s.awayTeam?.teamName || '';
  const opponent = /삼성|라이온즈/.test(home) ? away : home;
  const { date, time } = parseDateTime(s.scheduleDate);
  const reserve = parseDateTime(s.reserveOpenDate);
  const targetTime = reserve.time ? `${reserve.time}.000` : '11:00:00.000';
  const isOpen = String(s.reserveButtonStatus || '').toUpperCase().includes('OPEN')
    && !String(s.reserveButtonStatus || '').toUpperCase().includes('NOT');
  return {
    id: String(s.scheduleId),
    team: '삼성 라이온즈',
    opponent,
    title: [date, time?.slice(0, 5), away && home ? `${away} vs ${home}` : '', s.venueName].filter(Boolean).join(' '),
    date,
    time,
    targetTime,
    scheduleId: String(s.scheduleId),
    productId: s.productId != null ? String(s.productId) : null,
    scheduleSource: 'netlog',
    bookingOpen: isOpen,
    reserveButtonStatus: s.reserveButtonStatus || null,
    reserveOpenDate: s.reserveOpenDate || null,
    reserveCloseDate: s.reserveCloseDate || null,
    venueName: s.venueName || null,
    captchaUse: !!s.captchaUse,
    authReinforceYn: s.authReinforceYn === 'Y',
    waitingAvailable: !!s.waitingReservation?.waitingReservationUse,
    bookingUrl: s.productId ? buildBookingUrl(s.productId, s.scheduleId) : null,
    sourceUrl: SOURCE_URL,
    preOpen: !isOpen,
  };
}

/**
 * NetLog 포맷 개요:
 *  - constants.logEventTypes : eventType 숫자 → 이름 매핑
 *  - constants.logSourceType : sourceType 숫자 → 이름 매핑 (URL_REQUEST 등)
 *  - events : { time, type, phase, source: { id, type }, params } 의 배열
 *
 *  같은 URL_REQUEST 소스 id로 묶이는 이벤트들:
 *    URL_REQUEST_START_JOB        : params.url, params.method
 *    URL_REQUEST_FAKE_RESPONSE_HEADERS_CREATED 또는 HTTP_TRANSACTION_READ_RESPONSE_HEADERS
 *                                  : params.headers (응답 헤더 목록), 상태 줄에서 status 추출
 *    URL_REQUEST_JOB_FILTERED_BYTES_READ : params.bytes (base64). 압축 해제 후의 본문(권장)
 *    URL_REQUEST_JOB_BYTES_READ          : params.bytes (base64). 압축 상태일 수도 있음
 *
 * Chrome 버전에 따라 이벤트 이름이 다소 다릅니다. 본 코드는 모두 시도합니다.
 */
function parseNetLog(json) {
  const constants = json.constants || {};
  const eventTypes = constants.logEventTypes || {};
  const sourceTypes = constants.logSourceType || {};

  // 이름 ↔ 숫자 양방향 맵
  const typeNameOf = {};
  for (const [name, num] of Object.entries(eventTypes)) typeNameOf[num] = name;
  const sourceNameOf = {};
  for (const [name, num] of Object.entries(sourceTypes)) sourceNameOf[num] = name;

  const URL_REQUEST = Object.entries(sourceTypes).find(([k]) => k === 'URL_REQUEST')?.[1];

  // 관심 이벤트 타입 숫자
  const startJob = eventTypes.URL_REQUEST_START_JOB ?? eventTypes.URL_REQUEST_START;
  const respHeaders1 = eventTypes.HTTP_TRANSACTION_READ_RESPONSE_HEADERS;
  const respHeaders2 = eventTypes.URL_REQUEST_FAKE_RESPONSE_HEADERS_CREATED;
  const bytesFiltered = eventTypes.URL_REQUEST_JOB_FILTERED_BYTES_READ;
  const bytesRaw = eventTypes.URL_REQUEST_JOB_BYTES_READ;

  // URL_REQUEST source.id 별로 묶음
  const requests = new Map(); // id -> { url, method, status, headers, filteredBody[], rawBody[] }

  function get(id) {
    let r = requests.get(id);
    if (!r) {
      r = { id, url: null, method: null, status: null, headers: null, filtered: [], raw: [] };
      requests.set(id, r);
    }
    return r;
  }

  const events = json.events || [];
  log(`event count: ${events.length}`);

  for (const ev of events) {
    if (!ev || !ev.source) continue;
    if (URL_REQUEST != null && ev.source.type !== URL_REQUEST) continue;
    const id = ev.source.id;
    const r = get(id);
    const typeName = typeNameOf[ev.type] || String(ev.type);

    if (typeName === 'URL_REQUEST_START_JOB' || typeName === 'URL_REQUEST_START') {
      if (ev.params?.url) r.url = ev.params.url;
      if (ev.params?.method) r.method = ev.params.method;
    } else if (typeName === 'HTTP_TRANSACTION_READ_RESPONSE_HEADERS' || typeName === 'URL_REQUEST_FAKE_RESPONSE_HEADERS_CREATED') {
      const headers = ev.params?.headers;
      if (Array.isArray(headers) && headers.length) {
        r.headers = headers;
        // 첫 줄은 보통 "HTTP/1.1 200 OK"
        const statusLine = headers[0];
        const m = /^HTTP\/[\d.]+\s+(\d{3})/.exec(statusLine || '');
        if (m) r.status = Number(m[1]);
      }
    } else if (typeName === 'URL_REQUEST_JOB_FILTERED_BYTES_READ') {
      if (ev.params?.bytes) r.filtered.push(ev.params.bytes);
    } else if (typeName === 'URL_REQUEST_JOB_BYTES_READ') {
      if (ev.params?.bytes) r.raw.push(ev.params.bytes);
    }
  }

  return [...requests.values()];
}

function decodeBytesChunks(chunks) {
  if (!chunks || !chunks.length) return null;
  // 각 chunk는 base64 문자열
  const buffers = chunks.map((c) => Buffer.from(c, 'base64'));
  return Buffer.concat(buffers);
}

function tryDecompress(buf, headers) {
  if (!buf || buf.length === 0) return buf;
  // 헤더 기반 인코딩 추정
  let encoding = '';
  if (Array.isArray(headers)) {
    for (const h of headers) {
      const m = /^content-encoding:\s*([a-z0-9, ]+)/i.exec(h || '');
      if (m) { encoding = m[1].trim().toLowerCase(); break; }
    }
  }
  try {
    if (encoding.includes('br')) return zlib.brotliDecompressSync(buf);
    if (encoding.includes('gzip')) return zlib.gunzipSync(buf);
    if (encoding.includes('deflate')) return zlib.inflateSync(buf);
  } catch (e) {
    if (DEBUG) log(`decompress(${encoding}) failed: ${e.message}`);
  }
  // 압축이 아니거나 이미 풀린 상태
  return buf;
}

function bodyToString(req) {
  // 1) filtered bytes (압축 해제 + 디코딩이 끝난 상태)
  if (req.filtered.length) {
    const buf = decodeBytesChunks(req.filtered);
    if (buf && buf.length) return buf.toString('utf8');
  }
  // 2) raw bytes (압축 상태일 가능성) — Content-Encoding 헤더 기반 복구
  if (req.raw.length) {
    const buf = decodeBytesChunks(req.raw);
    if (buf && buf.length) {
      const decoded = tryDecompress(buf, req.headers);
      return decoded.toString('utf8');
    }
  }
  return '';
}

async function main() {
  const absPath = path.resolve(NETLOG_PATH);
  let stat;
  try { stat = await fsp.stat(absPath); } catch {
    console.error(`파일을 찾지 못했습니다: ${absPath}`);
    process.exit(1);
  }
  log(`reading ${absPath} (${(stat.size / 1024 / 1024).toFixed(2)} MiB)`);

  // NetLog 파일은 보통 평범한 JSON이지만 매우 큽니다.
  // 매우 큰 파일도 안전하게 처리하기 위해 일단 전체 읽기를 사용 (Node는 GB급 문자열도 OK).
  // streaming JSON parser는 추후 도입 가능.
  let raw;
  try {
    raw = await fsp.readFile(absPath, 'utf8');
  } catch (e) {
    console.error(`파일 읽기 실패: ${e.message}`);
    process.exit(1);
  }

  // chrome://net-export 가 "Stop Logging" 전에 비정상 종료되면 JSON 꼬리가 잘려 있을 수 있음.
  // 그 경우 events 배열 직전까지 valid한 부분을 복구해 파싱.
  let netlog;
  try {
    netlog = JSON.parse(raw);
  } catch (e) {
    log(`JSON parse 실패 (꼬리 잘린 NetLog일 가능성): ${e.message}`);
    netlog = tryRecoverTruncatedNetLog(raw);
    if (!netlog) {
      console.error('NetLog 복구 실패. chrome://net-export 에서 "Stop Logging"을 클릭한 뒤 다시 시도하세요.');
      process.exit(1);
    }
    log(`복구 성공: events ${netlog.events?.length || 0}건`);
  }

  const requests = parseNetLog(netlog);
  log(`url-requests: ${requests.length}`);

  // schedules API URL 필터
  const apiPattern = /\/mapi\/sports\/schedules/;
  const apiRequests = requests.filter((r) => r.url && apiPattern.test(r.url));
  log(`schedules API requests: ${apiRequests.length}`);

  if (apiRequests.length === 0) {
    console.error('');
    console.error('schedules API 호출이 NetLog에 없습니다. 가능성:');
    console.error('  - 캡처 중 ticketlink 페이지를 방문/새로고침하지 않음');
    console.error('  - 캡처 중 PerimeterX 챌린지가 통과되지 않아 API 호출이 안 일어남');
    console.error('    → Chrome 주소창에서 https://m.ticketlink.co.kr/sports/137/57 정상 로드 확인 후 캡처를 다시 시도');
    console.error('  - URL 패턴이 변경됨 → 아래 진단을 보고 패치하세요');
    console.error('');
    diagnose(requests);
    process.exit(2);
  }

  // 200 + JSON + success:true 인 응답만 채택
  let schedules = null;
  let pickedReq = null;
  let pickedRaw = null;
  for (const req of apiRequests) {
    const text = bodyToString(req);
    if (!text) {
      if (DEBUG) log(`req ${req.id}: status=${req.status} url=${req.url} (body empty in netlog — "Include raw bytes" 옵션 미체크?)`);
      continue;
    }
    let data;
    try { data = JSON.parse(text); } catch {
      if (DEBUG) log(`req ${req.id}: status=${req.status} body not JSON (length=${text.length}): ${text.slice(0, 120)}`);
      continue;
    }
    if (!data.success) {
      if (DEBUG) log(`req ${req.id}: status=${req.status} success=false (code=${data.result?.code}) ${data.result?.message || ''}`);
      continue;
    }
    const arr = data.data?.schedules;
    if (!Array.isArray(arr)) continue;
    if (!schedules || arr.length > schedules.length) {
      schedules = arr;
      pickedReq = req;
      pickedRaw = data;
    }
  }

  if (!schedules) {
    console.error('');
    console.error('schedules API 응답을 찾았으나 본문이 비어있거나 success:false 입니다.');
    console.error('가장 흔한 원인: chrome://net-export 에서 "Include raw bytes" 옵션을 체크하지 않음.');
    console.error('해당 옵션을 체크한 뒤 다시 캡처하세요.');
    if (DEBUG) diagnose(apiRequests);
    process.exit(3);
  }

  log(`picked ${apiRequests.indexOf(pickedReq) + 1}/${apiRequests.length} schedules API call: ${pickedReq.url}`);
  log(`  status=${pickedReq.status} schedules=${schedules.length}`);

  const games = schedules.map(mapApiSchedule);
  const payload = {
    team: 'Samsung Lions',
    teamKo: '삼성 라이온즈',
    sourceUrl: SOURCE_URL,
    bookingUrlPattern: BOOKING_URL_PATTERN,
    updatedAt: new Date().toISOString(),
    timeZone: KST_TIME_ZONE,
    mode: 'netlog',
    strategy: 'chrome-net-export-offline-parse',
    netlogPath: absPath,
    endpoint: 'mapi.ticketlink.co.kr/mapi/sports/schedules',
    count: games.length,
    games,
  };

  await fsp.writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  log(`saved ${games.length} item(s) -> ${OUTPUT_PATH}`);
  log(`open=${games.filter((g) => g.bookingOpen).length} preOpen=${games.filter((g) => g.preOpen).length}`);
}

// chrome://net-export 파일이 "Stop Logging" 없이 끝났을 때 꼬리 복구.
// 보통 events 배열이 열린 채 끝나므로 마지막 완전한 ',' 다음에 ']' 붙여 마감 시도.
function tryRecoverTruncatedNetLog(raw) {
  const idx = raw.indexOf('"events":');
  if (idx === -1) return null;
  // events 배열의 시작 [ 를 찾음
  const bracketStart = raw.indexOf('[', idx);
  if (bracketStart === -1) return null;
  // 마지막 } 위치까지 자르고 ]} 로 닫기
  const lastBrace = raw.lastIndexOf('}');
  if (lastBrace <= bracketStart) return null;
  const truncated = `${raw.slice(0, lastBrace + 1)}]}`;
  try { return JSON.parse(truncated); } catch { /* fall through */ }
  // 한 단계 더: 마지막 }, 직전 element까지 잘라보기
  for (let i = lastBrace; i > bracketStart; i -= 1) {
    if (raw[i] === '}' && raw[i + 1] === ',') {
      const t2 = `${raw.slice(0, i + 1)}]}`;
      try { return JSON.parse(t2); } catch { /* keep searching */ }
    }
  }
  return null;
}

function diagnose(requests) {
  // ticketlink.co.kr 도메인 호출 URL 샘플 20개
  const sample = requests
    .filter((r) => r.url && /ticketlink\.co\.kr/.test(r.url))
    .slice(0, 20);
  console.error(`[netlog 진단] ticketlink.co.kr URL 호출 ${sample.length}건 샘플:`);
  for (const r of sample) {
    console.error(`  status=${r.status || '?'}  bodyChunks=filt:${r.filtered.length}/raw:${r.raw.length}  ${r.url}`);
  }
  // 본문이 들어있는 응답이 하나도 없으면 결정적 단서
  const anyBody = requests.some((r) => r.filtered.length || r.raw.length);
  if (!anyBody) {
    console.error('');
    console.error('[netlog 진단] NetLog 어디에도 응답 본문이 포함되어있지 않습니다.');
    console.error('  → chrome://net-export 의 "Include raw bytes (includes cookies and credentials, and may include personal info)" 옵션이 꺼져 있던 것입니다.');
    console.error('  → 이 옵션을 켜고 다시 캡처하세요.');
  }
}

main().catch((e) => { console.error('[netlog] failed:', e); process.exit(1); });
