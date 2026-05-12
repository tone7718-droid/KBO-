/**
 * Samsung Lions Ticketlink scraper.
 *
 * 설계 원칙: "우회"가 아니라 "표준 브라우저 환경과 최대 호환".
 *  - 실제 데스크톱/모바일 Chrome과 동일한 헤더와 navigator 속성
 *  - waitForSelector + 텍스트 기반 필터링으로 동적 DOM 대응
 *  - 로컬 실행은 headful Chrome으로, CI 실행은 headless 'new'로 자동 분기
 *  - 실패 시 booking-data.json은 비워두지 않고 마지막 정상 데이터를 보존
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const puppeteer = require('puppeteer');

const SOURCE_URL = process.env.TICKETLINK_SAMSUNG_URL || 'https://m.ticketlink.co.kr/sports/137/57';
const OUTPUT_PATH = path.resolve(process.cwd(), 'booking-data.json');
const KST_TIME_ZONE = 'Asia/Seoul';

const IS_CI = !!process.env.CI || !!process.env.GITHUB_ACTIONS;
const MODE = (process.env.SCRAPER_MODE || (IS_CI ? 'ci' : 'local')).toLowerCase();
const HEADLESS = process.env.SCRAPER_HEADLESS
  ? !/^(0|false|no|off)$/i.test(process.env.SCRAPER_HEADLESS)
  : MODE !== 'local';
const DEBUG = !!process.env.SCRAPER_DEBUG;
const NAV_TIMEOUT_MS = Number(process.env.SCRAPER_NAV_TIMEOUT_MS || 60_000);
const KEEP_ON_FAILURE = !/^(0|false|no|off)$/i.test(process.env.SCRAPER_KEEP_ON_FAILURE || 'true');

const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(...args) {
  console.log('[scraper]', ...args);
}

function toKstDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: KST_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return { year: Number(part('year')), month: Number(part('month')), day: Number(part('day')) };
}

function toIsoDate(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeText(value = '') {
  return value.replace(/\s+/g, ' ').trim();
}

function resolveUrl(href) {
  try {
    return new URL(href, SOURCE_URL).href;
  } catch {
    return null;
  }
}

function parseDateFromText(text, nowParts = toKstDateParts()) {
  const normalized = normalizeText(text);

  const full = normalized.match(/(20\d{2})[.\-/년\s]+(\d{1,2})[.\-/월\s]+(\d{1,2})/);
  if (full) {
    return toIsoDate(Number(full[1]), Number(full[2]), Number(full[3]));
  }

  const short = normalized.match(/(?:^|\D)(\d{1,2})[.\-/월\s]+(\d{1,2})(?:\D|$)/);
  if (short) {
    let year = nowParts.year;
    const month = Number(short[1]);
    const day = Number(short[2]);
    if (month < nowParts.month - 6) year += 1;
    return toIsoDate(year, month, day);
  }
  return null;
}

function parseTimeFromText(text) {
  const normalized = normalizeText(text);
  const match = normalized.match(/(?:^|\D)([01]?\d|2[0-3])[:시]\s*([0-5]\d)(?:\D|$)/);
  if (!match) return null;
  return `${String(Number(match[1])).padStart(2, '0')}:${match[2]}:00`;
}

function inferBookingUrl(href, text) {
  const url = resolveUrl(href);
  if (!url) return null;
  const merged = `${url} ${text}`.toLowerCase();
  const looksLikeTicketLink = url.includes('ticketlink.co.kr');
  const looksLikeBooking = /reserve|booking|ticket|product|schedule|sports|예매|구매|좌석|경기/.test(merged);
  return looksLikeTicketLink && looksLikeBooking ? url : null;
}

function dedupeGames(games) {
  const map = new Map();
  for (const game of games) {
    const key = [game.date || '', game.time || '', game.bookingUrl || '', game.title || ''].join('|');
    if (!map.has(key)) map.set(key, game);
  }
  return [...map.values()].sort((a, b) => {
    const aKey = `${a.date || '9999-99-99'} ${a.time || '99:99:99'}`;
    const bKey = `${b.date || '9999-99-99'} ${b.time || '99:99:99'}`;
    return aKey.localeCompare(bKey);
  });
}

async function extractGames(page) {
  const rawItems = await page.evaluate(() => {
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const anchors = [...document.querySelectorAll('a[href], button, [role="button"]')];
    return anchors.map((node) => {
      const container = node.closest('li, article, section, div') || node;
      const href = node.getAttribute('href') || node.dataset?.href || node.dataset?.url || '';
      const nodeText = clean(node.innerText || node.textContent || '');
      const containerText = clean(container.innerText || container.textContent || nodeText);
      return {
        href,
        nodeText,
        containerText,
        ariaLabel: clean(node.getAttribute('aria-label') || ''),
        title: clean(node.getAttribute('title') || ''),
        data: JSON.stringify(node.dataset || {}),
      };
    });
  });

  const nowParts = toKstDateParts();
  const games = [];

  for (const item of rawItems) {
    const mergedText = normalizeText([
      item.containerText,
      item.nodeText,
      item.ariaLabel,
      item.title,
      item.data,
    ].filter(Boolean).join(' '));

    const bookingUrl = inferBookingUrl(item.href, mergedText);
    if (!bookingUrl) continue;

    const date = parseDateFromText(mergedText, nowParts);
    const time = parseTimeFromText(mergedText);
    const opponentMatch = mergedText.match(/(?:삼성\s*(?:vs|VS|대|-)\s*([가-힣A-Z]{2,10})|([가-힣A-Z]{2,10})\s*(?:vs|VS|대|-)\s*삼성)/);
    const opponent = opponentMatch ? (opponentMatch[1] || opponentMatch[2] || '').trim() : '';

    games.push({
      id: Buffer.from(`${date || ''}|${time || ''}|${bookingUrl}`).toString('base64url').slice(0, 16),
      team: '삼성 라이온즈',
      opponent,
      title: mergedText.slice(0, 140),
      date,
      time,
      targetTime: '11:00:00.000',
      bookingUrl,
      sourceUrl: SOURCE_URL,
    });
  }

  return dedupeGames(games);
}

/**
 * 실제 Chrome/Safari가 보내는 헤더 세트와 navigator 속성을 표준 그대로 흉내냅니다.
 * 우회 트릭(stealth plugin 등) 없이, "정상 사용자와 같은 환경"을 만드는 것이 목적입니다.
 */
async function configurePage(page) {
  const isLocal = MODE === 'local';
  const userAgent = isLocal ? DESKTOP_UA : MOBILE_UA;

  if (isLocal) {
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  } else {
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  }

  await page.setUserAgent(userAgent);
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-User': '?1',
    'Sec-Fetch-Dest': 'document',
  });

  await page.emulateTimezone(KST_TIME_ZONE);

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'ko-KR' });
    Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
  });
}

/**
 * Ticketlink 모바일 페이지는 SPA처럼 동작하므로,
 * "삼성/라이온즈" 텍스트가 등장하거나 예매 링크가 나타날 때까지 짧게 폴링합니다.
 */
async function waitForBookingContent(page, { totalMs = 20_000, intervalMs = 500 } = {}) {
  const started = Date.now();
  let lastCount = 0;

  while (Date.now() - started < totalMs) {
    const stats = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const anchors = [...document.querySelectorAll('a[href]')];
      const bookingLikely = anchors.filter((a) => {
        const href = a.getAttribute('href') || '';
        const blob = `${href} ${a.innerText || ''}`.toLowerCase();
        return /ticketlink\.co\.kr/.test(new URL(href, location.href).href || '')
          && /reserve|booking|product|schedule|예매|구매|좌석/.test(blob);
      });
      return {
        hasSamsung: /삼성|라이온즈|Samsung|Lions/i.test(text),
        anchorCount: bookingLikely.length,
        bodyLen: text.length,
      };
    });

    if (DEBUG) log('waitForBookingContent', stats);

    if (stats.hasSamsung && stats.anchorCount > 0) return stats;
    if (stats.anchorCount > 4 && stats.anchorCount === lastCount) return stats;
    lastCount = stats.anchorCount;
    await wait(intervalMs);
  }
  return null;
}

async function autoScroll(page, { steps = 6, delayMs = 700 } = {}) {
  for (let i = 0; i < steps; i += 1) {
    await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.85)));
    await wait(delayMs);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await wait(300);
}

async function scrape() {
  log(`mode=${MODE} headless=${HEADLESS} ci=${IS_CI} url=${SOURCE_URL}`);

  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--lang=ko-KR,ko',
    '--window-size=1440,900',
  ];

  const browser = await puppeteer.launch({
    headless: HEADLESS ? 'new' : false,
    defaultViewport: null,
    args: launchArgs,
  });

  try {
    const page = await browser.newPage();
    await configurePage(page);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

    if (DEBUG) {
      page.on('console', (msg) => log('page', msg.type(), msg.text()));
      page.on('requestfailed', (req) => log('reqfail', req.url(), req.failure()?.errorText));
    }

    const response = await page.goto(SOURCE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    const status = response?.status() ?? 0;
    log(`initial response status=${status}`);

    if (status >= 400) {
      throw new Error(`HTTP ${status} from ${SOURCE_URL}`);
    }

    await waitForBookingContent(page, { totalMs: 18_000 });
    await autoScroll(page, { steps: 6 });
    await waitForBookingContent(page, { totalMs: 6_000 });

    const games = await extractGames(page);
    log(`extracted ${games.length} candidate game(s)`);

    const payload = {
      team: 'Samsung Lions',
      teamKo: '삼성 라이온즈',
      sourceUrl: SOURCE_URL,
      updatedAt: new Date().toISOString(),
      timeZone: KST_TIME_ZONE,
      mode: MODE,
      count: games.length,
      games,
    };

    await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    log(`saved ${games.length} item(s) -> ${OUTPUT_PATH}`);
  } finally {
    await browser.close();
  }
}

async function readPrevious() {
  try {
    const raw = await fs.readFile(OUTPUT_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

scrape().catch(async (error) => {
  console.error('[scraper] failed:', error);

  const prev = KEEP_ON_FAILURE ? await readPrevious() : null;
  const hadGames = prev && Array.isArray(prev.games) && prev.games.length > 0;

  if (hadGames) {
    const payload = {
      ...prev,
      mode: MODE,
      lastError: error.message,
      lastErrorAt: new Date().toISOString(),
    };
    await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    log('kept previous booking-data.json (scraper failed but cache preserved)');
  } else {
    const fallback = {
      team: 'Samsung Lions',
      teamKo: '삼성 라이온즈',
      sourceUrl: SOURCE_URL,
      updatedAt: new Date().toISOString(),
      timeZone: KST_TIME_ZONE,
      mode: MODE,
      count: 0,
      games: [],
      error: error.message,
    };
    await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(fallback, null, 2)}\n`, 'utf8');
  }
  process.exitCode = 1;
});
