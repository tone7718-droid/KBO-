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
// 사내 MITM 프록시/방화벽이 인증서를 재서명하는 환경에서만 사용. CI에서는 절대 활성화하지 마세요.
const INSECURE = /^(1|true|yes|on)$/i.test(process.env.SCRAPER_INSECURE || '');

const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

// 예매 오픈 전 disabled 상태에서도 scheduleId가 노출되면 이 패턴으로 URL을 미리 조립합니다.
// 환경변수로 오버라이드 가능: TICKETLINK_BOOKING_URL_PATTERN="https://m.ticketlink.co.kr/sports/137/57/{scheduleId}"
const BOOKING_URL_PATTERN = process.env.TICKETLINK_BOOKING_URL_PATTERN
  || 'https://m.ticketlink.co.kr/sports/137/57/{scheduleId}';

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

/**
 * disabled 상태인 예매 버튼을 포함한 모든 게임 카드를 훑어 scheduleId를 수확합니다.
 *
 * 4계층 폴백:
 *   1) <script id="__NEXT_DATA__"> JSON 트리에서 schedule[Id]:N 패턴
 *   2) data-* 속성 (data-schedule-id / data-scheduleid / data-game-id / data-product-id ...)
 *   3) anchor href 꼬리 숫자 (/sports/137/57/12345 또는 /12345?from=...)
 *   4) onclick/href 등 코드 영역 안의 scheduleId=12345 정규식
 *
 * 각 카드에서 발견된 후보 중 가장 schedule 같은 키(schedule > game > match > product > id)로
 * 가중치 기반 선택합니다.
 */
async function harvestScheduleIds(page) {
  return page.evaluate(() => {
    const NUMERIC_ID = /^\d{4,}$/;
    const KEY_WEIGHT = (key) => {
      const k = key.toLowerCase();
      if (k.includes('schedule')) return 5;
      if (k.includes('game')) return 4;
      if (k.includes('match')) return 3;
      if (k.includes('product')) return 2;
      if (/(^|[-_])id($|[-_])/.test(k)) return 1;
      return 0;
    };
    const clean = (v) => (v || '').replace(/\s+/g, ' ').trim();

    function walkJsonForSchedules(json, out, depth = 0) {
      if (!json || depth > 8) return;
      if (Array.isArray(json)) {
        for (const item of json) walkJsonForSchedules(item, out, depth + 1);
        return;
      }
      if (typeof json !== 'object') return;
      // 스케줄로 보이는 객체: scheduleId 또는 (id + gameDate/startTime/awayTeam) 패턴
      const idKey = Object.keys(json).find((k) => /^(scheduleId|gameId|matchId|productId|id)$/i.test(k));
      const hasGameShape = ['gameDate', 'startDate', 'startTime', 'gameStartDate', 'awayTeam', 'homeTeam', 'awayTeamName', 'homeTeamName'].some((k) => k in json);
      if (idKey && hasGameShape && NUMERIC_ID.test(String(json[idKey]))) {
        out.push({
          source: 'next-data',
          scheduleId: String(json[idKey]),
          idKey,
          raw: json,
        });
      }
      for (const v of Object.values(json)) walkJsonForSchedules(v, out, depth + 1);
    }

    function harvestFromNextData() {
      const out = [];
      const nodes = [...document.querySelectorAll('script#__NEXT_DATA__, script[type="application/json"], script[type="application/ld+json"]')];
      for (const node of nodes) {
        try {
          const json = JSON.parse(node.textContent || '');
          walkJsonForSchedules(json, out);
        } catch { /* not JSON */ }
      }
      return out;
    }

    function harvestFromCard(card) {
      const candidates = [];
      const all = [card, ...card.querySelectorAll('*')];
      for (const node of all) {
        for (const attr of node.attributes || []) {
          const name = attr.name.toLowerCase();
          const val = String(attr.value || '');
          if (!val) continue;
          // (2) data-* 속성에서 ID
          if (name.startsWith('data-') && /id|schedule|game|product|match/.test(name) && NUMERIC_ID.test(val)) {
            candidates.push({ source: `attr:${name}`, scheduleId: val, weight: KEY_WEIGHT(name) });
          }
          // (3) href 꼬리 숫자
          if (name === 'href') {
            const m = val.match(/\/(\d{5,})(?:[/?#]|$)/);
            if (m) candidates.push({ source: 'href-tail', scheduleId: m[1], weight: 3, href: val });
          }
          // (4) onclick / href javascript: 안의 scheduleId/productId
          const codeMatch = val.match(/(?:scheduleId|gameId|matchId|productId)\s*[:=]\s*["']?(\d{4,})/i);
          if (codeMatch) {
            const keyName = val.match(/(scheduleId|gameId|matchId|productId)/i)?.[1] || 'productId';
            candidates.push({ source: `code:${name}`, scheduleId: codeMatch[1], weight: KEY_WEIGHT(keyName) });
          }
        }
      }
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => b.weight - a.weight || b.scheduleId.length - a.scheduleId.length);
      return candidates[0];
    }

    // 카드 후보: 삼성/라이온즈 텍스트를 포함하면서 자식 수가 적당한(스케줄 한 건) 컨테이너
    const cardSelector = 'li, article, [role="listitem"]';
    const cards = [...document.querySelectorAll(cardSelector)].filter((el) => {
      const t = el.innerText || '';
      if (!/삼성|라이온즈|Samsung|Lions/i.test(t)) return false;
      return el.children.length > 0 && el.children.length < 40 && t.length < 800;
    });

    const fromCards = [];
    for (const card of cards) {
      const harvested = harvestFromCard(card);
      if (!harvested) continue;
      const disabledBtn = card.querySelector('button[disabled], [aria-disabled="true"], [disabled]');
      const enabledBookingBtn = card.querySelector('a[href*="ticketlink"], button:not([disabled])');
      const text = clean(card.innerText).slice(0, 240);
      fromCards.push({
        ...harvested,
        text,
        cardTag: card.tagName.toLowerCase(),
        isOpen: !disabledBtn,
        hasBookingAffordance: !!enabledBookingBtn,
      });
    }

    return {
      nextData: harvestFromNextData(),
      cards: fromCards,
    };
  });
}

function mergeSchedules(games, harvest, urlPattern) {
  const buildUrl = (id) => urlPattern.replace('{scheduleId}', encodeURIComponent(id));
  const nowParts = toKstDateParts();

  // 1) anchor 기반 game ↔ harvest card 텍스트 매칭으로 scheduleId 부착
  for (const game of games) {
    if (game.scheduleId) continue;
    for (const card of harvest.cards) {
      if (game.title && card.text && (game.title.includes(card.text.slice(0, 30)) || card.text.includes(game.title.slice(0, 30)))) {
        game.scheduleId = card.scheduleId;
        game.scheduleSource = card.source;
        game.bookingOpen = card.isOpen;
        if (!game.bookingUrl || /\/sports\/\d+\/\d+\/?$/.test(game.bookingUrl)) game.bookingUrl = buildUrl(card.scheduleId);
        break;
      }
    }
    // bookingUrl 꼬리 숫자에서 scheduleId 추출 (anchor에 이미 들어있던 경우)
    if (!game.scheduleId && game.bookingUrl) {
      const m = String(game.bookingUrl).match(/\/(\d{5,})(?:[/?#]|$)/);
      if (m) { game.scheduleId = m[1]; game.scheduleSource = 'bookingUrl-tail'; }
    }
  }

  // 2) anchor에서 못 찾은 scheduleId를 orphan으로 추가 (예매 오픈 전 사전 수집 대비)
  const knownIds = new Set(games.map((g) => g.scheduleId).filter(Boolean));
  const orphans = [];

  const pushOrphan = (entry) => {
    if (knownIds.has(entry.scheduleId)) return;
    orphans.push(entry);
    knownIds.add(entry.scheduleId);
  };

  // 2a) DOM 카드에서 발견된 ID
  for (const card of harvest.cards) {
    const text = card.text || '';
    const opponentMatch = text.match(/(?:삼성\s*(?:vs|VS|대|-)\s*([가-힣A-Z]{2,10})|([가-힣A-Z]{2,10})\s*(?:vs|VS|대|-)\s*삼성)/);
    pushOrphan({
      id: `pre-${card.scheduleId}`.slice(0, 16),
      team: '삼성 라이온즈',
      opponent: opponentMatch ? (opponentMatch[1] || opponentMatch[2] || '').trim() : '',
      title: text || '예매 오픈 전 사전 수집',
      date: parseDateFromText(text, nowParts),
      time: parseTimeFromText(text),
      targetTime: '11:00:00.000',
      scheduleId: card.scheduleId,
      scheduleSource: card.source,
      bookingOpen: card.isOpen,
      bookingUrl: buildUrl(card.scheduleId),
      sourceUrl: SOURCE_URL,
      preOpen: true,
    });
  }

  // 2b) __NEXT_DATA__ JSON에서 발견된 스케줄 (raw 필드로 풍부한 정보 보유)
  for (const item of harvest.nextData) {
    const raw = item.raw || {};
    const away = raw.awayTeam || raw.awayTeamName || '';
    const home = raw.homeTeam || raw.homeTeamName || '';
    const opponent = /삼성|라이온즈/.test(home) ? away : home;
    const date = raw.gameDate || raw.startDate || raw.gameStartDate
      ? String(raw.gameDate || raw.startDate || raw.gameStartDate).slice(0, 10).replace(/[./]/g, '-')
      : null;
    const time = raw.startTime
      ? `${String(raw.startTime).match(/(\d{1,2}):(\d{2})/)?.slice(1).map((x) => x.padStart(2, '0')).join(':') || raw.startTime}:00`.replace(/:00:00$/, ':00')
      : null;
    pushOrphan({
      id: `pre-${item.scheduleId}`.slice(0, 16),
      team: '삼성 라이온즈',
      opponent: opponent || '',
      title: [date, time, home && away ? `${away} vs ${home}` : ''].filter(Boolean).join(' ') || `scheduleId ${item.scheduleId}`,
      date,
      time: time && /^\d{2}:\d{2}/.test(time) ? (time.length === 5 ? `${time}:00` : time) : null,
      targetTime: '11:00:00.000',
      scheduleId: item.scheduleId,
      scheduleSource: item.source,
      bookingOpen: null,
      bookingUrl: buildUrl(item.scheduleId),
      sourceUrl: SOURCE_URL,
      preOpen: true,
    });
  }

  return { games: [...games, ...orphans], harvested: knownIds.size };
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
  if (INSECURE) launchArgs.push('--ignore-certificate-errors');

  const browser = await puppeteer.launch({
    headless: HEADLESS ? 'new' : false,
    defaultViewport: null,
    acceptInsecureCerts: INSECURE,
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

    const rawGames = await extractGames(page);
    log(`extracted ${rawGames.length} game(s) from anchors`);

    const harvest = await harvestScheduleIds(page);
    log(`harvested scheduleId — cards=${harvest.cards.length} nextData=${harvest.nextData.length}`);
    if (DEBUG) {
      const sample = [...harvest.cards.slice(0, 3), ...harvest.nextData.slice(0, 3)];
      log('harvest sample:', JSON.stringify(sample, null, 2).slice(0, 1200));
    }

    const merged = mergeSchedules(rawGames, harvest, BOOKING_URL_PATTERN);
    const games = dedupeGames(merged.games);
    log(`final games=${games.length} (pre-open=${games.filter((g) => g.preOpen).length}, with scheduleId=${games.filter((g) => g.scheduleId).length})`);

    const payload = {
      team: 'Samsung Lions',
      teamKo: '삼성 라이온즈',
      sourceUrl: SOURCE_URL,
      bookingUrlPattern: BOOKING_URL_PATTERN,
      updatedAt: new Date().toISOString(),
      timeZone: KST_TIME_ZONE,
      mode: MODE,
      count: games.length,
      scheduleIdHarvest: {
        fromCards: harvest.cards.length,
        fromNextData: harvest.nextData.length,
      },
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
