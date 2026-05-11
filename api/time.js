const DEFAULT_TICKETLINK_URL = 'https://m.ticketlink.co.kr/sports/137/57';
const DEFAULT_UTC_API_URL = 'https://worldtimeapi.org/api/timezone/Etc/UTC';

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

  const textFields = ['utc_datetime', 'datetime', 'currentDateTime', 'dateTime', 'time', 'serverIso', 'iso'];
  for (const key of textFields) {
    if (data[key]) {
      const parsed = Date.parse(data[key]);
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  const secondFields = ['unixtime', 'unixTime', 'unix'];
  for (const key of secondFields) {
    if (Number.isFinite(data[key])) return data[key] * 1000;
  }

  const millisecondFields = ['serverTime', 'epoch', 'epochMs', 'timestamp', 'timeMs'];
  for (const key of millisecondFields) {
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

async function fetchDateHeaderTime(url) {
  const startedAt = Date.now();
  let response;

  try {
    response = await fetch(url, {
      method: 'HEAD',
      cache: 'no-store',
      redirect: 'follow',
      headers: {
        'User-Agent': 'KBO-Precision-Clock/1.0',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
    });
  } catch {
    response = null;
  }

  if (!response || !response.headers.get('date')) {
    response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/json,text/plain,*/*',
        'User-Agent': 'KBO-Precision-Clock/1.0',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
    });
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
  const response = await fetch(url, {
    method: 'GET',
    cache: 'no-store',
    redirect: 'follow',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'KBO-Precision-Clock/1.0',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  });
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

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, message: 'Method Not Allowed' });
  }

  const ticketlinkUrl = normalizeUrl(
    req.query?.target || process.env.TICKETLINK_TIME_URL || process.env.TIME_TARGET_URL,
    DEFAULT_TICKETLINK_URL
  );
  const utcApiUrl = normalizeUrl(process.env.TIME_API_URL, DEFAULT_UTC_API_URL);

  try {
    const ticketlinkTime = await fetchDateHeaderTime(ticketlinkUrl);

    return res.status(200).json({
      ok: true,
      preferred: 'ticketlink',
      ...ticketlinkTime,
    });
  } catch (ticketlinkError) {
    try {
      const fallbackTime = await fetchWorldTimeApi(utcApiUrl);

      return res.status(200).json({
        ok: true,
        preferred: 'fallback-time-api',
        ...fallbackTime,
        ticketlinkError: ticketlinkError.message,
      });
    } catch (fallbackError) {
      const now = Date.now();

      return res.status(500).json({
        ok: false,
        message: 'Failed to synchronize server time',
        ticketlinkError: ticketlinkError.message,
        fallbackError: fallbackError.message,
        fallbackServerTime: now,
        fallbackIso: new Date(now).toISOString(),
        source: 'vercel-local-fallback',
      });
    }
  }
}
