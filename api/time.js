/**
 * 서버 시간 프록시.
 *
 * 클라이언트는 이 응답의 serverIso/serverTime 을 기준으로
 * 로컬 시계의 offset을 계산합니다. proxyRtt(서버측 왕복시간)를
 * 함께 돌려주면 클라이언트가 자기 RTT에서 이를 빼고
 * 미드포인트를 보정할 수 있어 정확도가 올라갑니다.
 */

const DEFAULT_TICKETLINK_URL = 'https://m.ticketlink.co.kr/sports/137/57';
const DEFAULT_UTC_API_URL = 'https://worldtimeapi.org/api/timezone/Etc/UTC';

const UPSTREAM_TIMEOUT_MS = Number(process.env.TIME_UPSTREAM_TIMEOUT_MS || 1500);

const BROWSERY_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
};

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function parseJsonServerTime(data) {
  if (!data || typeof data !== 'object') return null;

  for (const key of ['utc_datetime', 'datetime', 'currentDateTime', 'dateTime', 'time', 'serverIso', 'iso']) {
    if (data[key]) {
      const parsed = Date.parse(data[key]);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  for (const key of ['unixtime', 'unixTime', 'unix']) {
    if (Number.isFinite(data[key])) return data[key] * 1000;
  }
  for (const key of ['serverTime', 'epoch', 'epochMs', 'timestamp', 'timeMs']) {
    if (Number.isFinite(data[key])) return data[key];
  }
  return null;
}

function normalizeUrl(rawUrl, fallback) {
  try {
    const url = new URL(rawUrl || fallback);
    if (!['http:', 'https:'].includes(url.protocol)) return fallback;
    return url.href;
  } catch {
    return fallback;
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)),
  ]);
}

async function fetchDateHeaderTime(url) {
  const startedAt = Date.now();
  let response;
  try {
    response = await withTimeout(fetch(url, {
      method: 'HEAD',
      cache: 'no-store',
      redirect: 'follow',
      headers: BROWSERY_HEADERS,
    }), UPSTREAM_TIMEOUT_MS, 'HEAD');
  } catch {
    response = null;
  }

  if (!response || !response.headers.get('date')) {
    response = await withTimeout(fetch(url, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
      headers: BROWSERY_HEADERS,
    }), UPSTREAM_TIMEOUT_MS, 'GET');
  }

  const endedAt = Date.now();
  const dateHeader = response.headers.get('date');
  const serverTime = Date.parse(dateHeader || '');

  if (!Number.isFinite(serverTime)) {
    throw new Error(`Date header not found or invalid from ${url}`);
  }

  return {
    serverTime,
    serverIso: new Date(serverTime).toISOString(),
    source: 'ticketlink-date-header',
    sourceUrl: url,
    status: response.status,
    proxyStartedAt: startedAt,
    proxyEndedAt: endedAt,
    proxyRtt: endedAt - startedAt,
    dateHeader,
  };
}

async function fetchWorldTimeApi(url) {
  const startedAt = Date.now();
  const response = await withTimeout(fetch(url, {
    method: 'GET',
    cache: 'no-store',
    redirect: 'follow',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': BROWSERY_HEADERS['User-Agent'],
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  }), UPSTREAM_TIMEOUT_MS, 'time-api');
  const endedAt = Date.now();

  let serverTime = null;
  let source = 'time-api-json';

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await response.json();
    serverTime = parseJsonServerTime(data);
  }

  if (!Number.isFinite(serverTime)) {
    const dateHeader = response.headers.get('date');
    serverTime = Date.parse(dateHeader || '');
    source = 'time-api-date-header';
  }

  if (!Number.isFinite(serverTime)) {
    throw new Error(`Server time not found from ${url}`);
  }

  return {
    serverTime,
    serverIso: new Date(serverTime).toISOString(),
    source,
    sourceUrl: url,
    status: response.status,
    proxyStartedAt: startedAt,
    proxyEndedAt: endedAt,
    proxyRtt: endedAt - startedAt,
  };
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, message: 'Method Not Allowed' });

  const ticketlinkUrl = normalizeUrl(
    req.query?.target || process.env.TICKETLINK_TIME_URL || process.env.TIME_TARGET_URL,
    DEFAULT_TICKETLINK_URL
  );
  const utcApiUrl = normalizeUrl(process.env.TIME_API_URL, DEFAULT_UTC_API_URL);

  // 티켓링크와 폴백 API를 동시에 시작하고, 티켓링크가 빠르면 그걸,
  // 실패하면 그 시점에 이미 진행 중인 폴백을 그대로 활용해 레이턴시를 최소화합니다.
  const ticketlinkPromise = fetchDateHeaderTime(ticketlinkUrl);
  const fallbackPromise = fetchWorldTimeApi(utcApiUrl).catch((err) => ({ __error: err }));

  try {
    const ticketlinkTime = await ticketlinkPromise;
    return res.status(200).json({ ok: true, preferred: 'ticketlink', ...ticketlinkTime });
  } catch (ticketlinkError) {
    const fallback = await fallbackPromise;
    if (fallback && !fallback.__error) {
      return res.status(200).json({
        ok: true,
        preferred: 'fallback-time-api',
        ...fallback,
        ticketlinkError: ticketlinkError.message,
      });
    }
    const now = Date.now();
    return res.status(200).json({
      ok: false,
      message: 'Failed to synchronize server time. Using Vercel local clock.',
      ticketlinkError: ticketlinkError.message,
      fallbackError: fallback?.__error?.message || 'unknown',
      serverTime: now,
      serverIso: new Date(now).toISOString(),
      // 클라이언트가 fallbackServerTime 키도 읽도록 호환성 유지
      fallbackServerTime: now,
      fallbackIso: new Date(now).toISOString(),
      source: 'vercel-local-fallback',
      sourceUrl: ticketlinkUrl,
      proxyRtt: 0,
    });
  }
}
