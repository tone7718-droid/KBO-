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
const fsSync = require('node:fs');
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

// /reserve/product/{productId}?scheduleId={scheduleId} 직접 deep-link 는 NetFunnel
// 대기열 key 가 없으면 차단된다 (error.netfunnel.invalid.key). 일정 목록 페이지의
// 정식 "예매하기" 버튼만 NetFunnel 을 정상 트리거하므로 그곳을 기본 진입점으로
// 사용. scheduleId/productId 는 데이터에 보존하여 향후 동작하는 패턴이 발견되면
// 재활용 가능. 환경변수로 오버라이드 가능.
const BOOKING_URL_PATTERN = process.env.TICKETLINK_BOOKING_URL_PATTERN
  || 'https://m.ticketlink.co.kr/sports/137/57';

// API 조회 기간 (YYYYMMDD). 오늘부터 N일 후까지.
const API_DAYS_AHEAD = Number(process.env.TICKETLINK_API_DAYS_AHEAD || 90);

function buildBookingUrl(productId, scheduleId) {
  return BOOKING_URL_PATTERN
    .replace(/\{productId\}/g, encodeURIComponent(String(productId)))
    .replace(/\{scheduleId\}/g, encodeURIComponent(String(scheduleId)));
}

// 시스템에 설치된 실제 Chrome 경로를 자동 탐지. Puppeteer 번들 Chromium보다 식별이 어렵습니다.
// 명시적 오버라이드: CHROME_PATH 환경변수 또는 PUPPETEER_EXECUTABLE_PATH
function detectChromePath() {
  const explicit = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (explicit && fsSync.existsSync(explicit)) return explicit;

  const candidates = process.platform === 'win32' ? [
    `${process.env['ProgramFiles']}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['ProgramFiles']}\\Google\\Chrome Beta\\Application\\chrome.exe`,
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ] : [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];

  for (const p of candidates) {
    try { if (p && fsSync.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

// 사용자가 미리 띄워둔 Chrome에 CDP로 연결합니다. 가장 강력한 우회 방지:
// Chrome은 평범하게 시작되었고 우리는 한 탭만 빌려 쓰는 모양새입니다.
// 사용법: chrome.exe --remote-debugging-port=9222 --user-data-dir="C:\temp\kbo-chrome"
// 그 다음: $env:SCRAPER_ATTACH_URL="http://localhost:9222"; npm run scrape:attach
const ATTACH_URL = process.env.SCRAPER_ATTACH_URL || '';

// 티켓링크가 차단 페이지를 띄울 때 노출되는 시그니처 문구
const BLOCK_PAGE_SIGNATURES = [
  '비정상적인 활동',
  'ErrorCode:200',
  '계정이 차단',
  'Access Denied',
  'Bot detected',
];

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

function extractIdFromUrl(url) {
  if (!url) return null;
  const s = String(url);
  // 1) 경로 꼬리 숫자: /sports/137/57/12345 또는 /product/123456
  let m = s.match(/\/(\d{5,})(?:[/?#]|$)/);
  if (m) return { id: m[1], src: 'url-path' };
  // 2) 쿼리스트링의 ID 키: ?scheduleId=12345 / &productId=... / &gameId=... / &p=... / &no=...
  m = s.match(/[?&](?:scheduleId|gameId|matchId|productId|productNo|scheduleNo|game|schedule|id|p|no)=(\d{4,})/i);
  if (m) return { id: m[1], src: 'url-query' };
  // 3) URL 어디든 6자리 이상 숫자 (마지막 보루)
  m = s.match(/(\d{6,})/);
  if (m) return { id: m[1], src: 'url-digits' };
  return null;
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

    // 카드 후보:
    //  1) li/article/[role=listitem] — 일반적인 SPA 패턴
    //  2) div / section — data-*-id 속성이 있을 때만 (그 외 div는 너무 많음)
    const candidateNodes = new Set();
    for (const el of document.querySelectorAll('li, article, [role="listitem"]')) candidateNodes.add(el);
    for (const el of document.querySelectorAll('[data-schedule-id], [data-scheduleid], [data-game-id], [data-gameid], [data-product-id], [data-productid], [data-match-id], [data-matchid], [data-id]')) {
      // data-id가 있는 노드 자체 + 조상 div/section 한 단계
      candidateNodes.add(el);
      const ancestor = el.closest('li, article, [role="listitem"], section, div');
      if (ancestor) candidateNodes.add(ancestor);
    }
    const cards = [...candidateNodes].filter((el) => {
      const t = el.innerText || '';
      if (!/삼성|라이온즈|Samsung|Lions/i.test(t)) return false;
      return el.children.length > 0 && el.children.length < 60 && t.length < 1200;
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
    // bookingUrl에서 직접 scheduleId 추출 (path / query / digits 순서로 시도)
    if (!game.scheduleId && game.bookingUrl) {
      const found = extractIdFromUrl(game.bookingUrl);
      if (found) { game.scheduleId = found.id; game.scheduleSource = `bookingUrl-${found.src}`; }
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

  // 표준 Chrome이 가진 속성을 그대로 갖춥니다. Puppeteer가 기본으로 노출하는 자동화 흔적만 정상화:
  //  - navigator.webdriver: 기본 true → 일반 Chrome은 undefined
  //  - window.chrome.runtime: 기본 누락 → 일반 Chrome은 객체 존재
  //  - navigator.plugins: 기본 빈 배열 → 일반 Chrome은 PDF Viewer 포함
  //  - navigator.permissions.query: notifications가 'denied'로 강제 응답되는 결함 보정
  //  - WebGL UNMASKED_VENDOR/RENDERER: SwiftShader 노출이면 봇 시그니처
  //  - Battery/Connection: 일반 Chrome에는 존재
  await page.evaluateOnNewDocument(() => {
    // prototype에서 webdriver를 제거 (configurable이면 통과, 아니면 무시)
    try { delete Object.getPrototypeOf(navigator).webdriver; } catch { /* ignore */ }
    Object.defineProperty(navigator, 'webdriver', { configurable: true, get: () => undefined });
    Object.defineProperty(navigator, 'language', { get: () => 'ko-KR' });
    Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

    if (!window.chrome) Object.defineProperty(window, 'chrome', { value: {}, writable: true, configurable: true });
    if (!window.chrome.runtime) window.chrome.runtime = { id: undefined, connect: () => ({}), sendMessage: () => {} };
    if (!window.chrome.csi) window.chrome.csi = () => ({});
    if (!window.chrome.loadTimes) window.chrome.loadTimes = () => ({});
    if (!window.chrome.app) window.chrome.app = { isInstalled: false, InstallState: {}, RunningState: {} };

    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = [
          { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: '' },
          { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: '' },
          { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: '' },
          { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: '' },
        ];
        arr.refresh = () => {};
        arr.namedItem = (n) => arr.find((p) => p.name === n) || null;
        arr.item = (i) => arr[i] || null;
        return arr;
      },
    });

    Object.defineProperty(navigator, 'mimeTypes', {
      get: () => {
        const arr = [{ type: 'application/pdf', description: '', suffixes: 'pdf' }];
        arr.namedItem = (n) => arr.find((m) => m.type === n) || null;
        arr.item = (i) => arr[i] || null;
        return arr;
      },
    });

    const originalQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
    if (originalQuery) {
      window.navigator.permissions.query = (params) => {
        if (params && params.name === 'notifications') {
          return Promise.resolve({ state: typeof Notification !== 'undefined' ? Notification.permission : 'prompt', onchange: null });
        }
        return originalQuery(params);
      };
    }

    // WebGL UNMASKED 정보: 빈 문자열 또는 SwiftShader면 봇으로 식별됨
    try {
      const getParam = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function (p) {
        if (p === 37445) return 'Intel Inc.';
        if (p === 37446) return 'Intel(R) UHD Graphics 630';
        return getParam.call(this, p);
      };
      if (window.WebGL2RenderingContext) {
        const getParam2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function (p) {
          if (p === 37445) return 'Intel Inc.';
          if (p === 37446) return 'Intel(R) UHD Graphics 630';
          return getParam2.call(this, p);
        };
      }
    } catch { /* ignore */ }

    // Battery API (일반 Chrome에 존재)
    if (typeof navigator.getBattery !== 'function') {
      navigator.getBattery = () => Promise.resolve({
        charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1,
        addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
      });
    }

    // Network Information API
    if (!('connection' in navigator)) {
      Object.defineProperty(navigator, 'connection', {
        get: () => ({
          effectiveType: '4g', rtt: 50, downlink: 10, saveData: false,
          addEventListener: () => {}, removeEventListener: () => {},
        }),
      });
    }
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
    let stats;
    try {
      stats = await page.evaluate((signatures) => {
        const text = document.body?.innerText || '';
        const anchors = [...document.querySelectorAll('a[href]')];
        const bookingLikely = anchors.filter((a) => {
          const href = a.getAttribute('href') || '';
          const blob = `${href} ${a.innerText || ''}`.toLowerCase();
          return /ticketlink\.co\.kr/.test(new URL(href, location.href).href || '')
            && /reserve|booking|product|schedule|예매|구매|좌석/.test(blob);
        });
        const blocked = signatures.find((s) => text.includes(s));
        return {
          hasSamsung: /삼성|라이온즈|Samsung|Lions/i.test(text),
          anchorCount: bookingLikely.length,
          bodyLen: text.length,
          blocked: blocked || null,
        };
      }, BLOCK_PAGE_SIGNATURES);
    } catch (err) {
      // 차단 페이지가 탭을 닫는 등 페이지 컨텍스트가 사라진 경우
      throw new Error(`page-context-lost: ${err.message}`);
    }

    if (DEBUG) log('waitForBookingContent', stats);

    if (stats.blocked) {
      throw new Error(`BLOCKED: 티켓링크 봇 탐지 페이지 감지 ("${stats.blocked}"). 현재 탭에 차단 페이지가 떠 있습니다. 새 탭/새 창에서 다시 방문하거나 10~30분 대기 후 재시도하세요.`);
    }
    if (stats.hasSamsung && stats.anchorCount > 0) return stats;
    if (stats.anchorCount > 4 && stats.anchorCount === lastCount) return stats;
    lastCount = stats.anchorCount;
    await wait(intervalMs);
  }
  return null;
}

/**
 * 사용자 탭이 자기 라이프사이클에서 호출하는 schedules API 응답을 수동 가로채기.
 * 우리가 직접 fetch를 걸면 PerimeterX가 탭을 강제 navigate시켜 차단합니다.
 * 우리는 트래픽을 만들지 않고 듣기만 합니다.
 *
 * PerimeterX 챌린지 동안 여러 번의 short response(short body가 곧 폐기됨)가 발생하므로
 * Puppeteer의 page.on('response') 핸들러를 쓰고 200 + JSON 응답만 채택합니다.
 */
async function captureSchedulesViaCdp(page) {
  const TIMEOUT_MS = Number(process.env.TICKETLINK_API_TIMEOUT_MS || 90_000);

  return new Promise((resolve, reject) => {
    let resolved = false;
    let seen = 0;
    let lastNon200 = null;

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      page.off('response', handler);
      reject(new Error(
        `${TIMEOUT_MS / 1000}초 안에 schedules API의 200 응답을 받지 못했습니다.\n` +
        `(이 시간 안에 ${seen}개의 schedules 요청을 보았지만 200 JSON은 없었습니다. 마지막 비-200 응답: ${lastNon200 || 'n/a'})\n` +
        '가능한 원인:\n' +
        '  - 새로고침을 안 했거나 너무 일찍 함\n' +
        '  - PerimeterX 챌린지가 통과되지 않아 페이지가 데이터를 못 받음 (탭에서 정상 페이지가 떴는지 확인)\n' +
        '  - TICKETLINK_API_TIMEOUT_MS 환경변수로 타임아웃을 늘려 재시도 가능'
      ));
    }, TIMEOUT_MS);

    const handler = async (response) => {
      const url = response.url();
      if (!url.includes('/mapi/sports/schedules')) return;
      const status = response.status();
      seen += 1;
      if (status !== 200) {
        lastNon200 = `HTTP ${status}`;
        log(`schedules response: status=${status} (challenge in progress, ignoring)`);
        return;
      }
      // 200이면 본문 시도
      let text;
      try {
        text = await response.text();
      } catch (e) {
        log(`200 response body unavailable: ${e.message}`);
        return;
      }
      let data;
      try { data = JSON.parse(text); } catch {
        log(`200 response not JSON (length=${text.length}): ${text.slice(0, 120)}`);
        return;
      }
      if (!data.success) {
        const code = data.result?.code;
        log(`200 JSON but success=false (code=${code}): ${(data.result?.message || '').slice(0, 100)}`);
        if (code === 7200) lastNon200 = 'PerimeterX challenge (code 7200)';
        return;
      }
      const schedules = data.data?.schedules;
      if (!Array.isArray(schedules)) {
        log(`200 JSON but no schedules array. Top-level keys: ${Object.keys(data.data || {}).join(', ')}`);
        return;
      }
      resolved = true;
      clearTimeout(timer);
      page.off('response', handler);
      log(`captured ${schedules.length} schedules from API response (length=${text.length})`);
      resolve(schedules);
    };

    page.on('response', handler);

    log('---');
    log(`네트워크 모니터링 시작 (최대 ${TIMEOUT_MS / 1000}초) — Chrome 창의 ticketlink 탭에서 F5로 새로고침하세요.`);
    log('PerimeterX 챌린지 동안 여러 응답이 무시될 수 있습니다. 마지막에 status=200이 들어오면 성공.');
    log('---');
  });
}

async function fetchSchedulesFromApi(page) {
  const schedules = await captureSchedulesViaCdp(page);
  log(`mapping ${schedules.length} schedule(s)`);
  return schedules.map((s) => mapApiSchedule(s));
}

function parseDateTime(input) {
  if (input == null || input === '') return { date: null, time: null };

  // 1) Unix 타임스탬프(숫자 또는 10~13자리 숫자 문자열) → KST 변환
  if (typeof input === 'number' || /^\d{10,13}$/.test(String(input))) {
    let ms = Number(input);
    if (!Number.isFinite(ms)) return { date: null, time: null };
    if (ms < 1e12) ms *= 1000;
    const d = new Date(ms);
    if (!Number.isFinite(d.getTime())) return { date: null, time: null };
    const kst = new Date(d.getTime() + 9 * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return {
      date: `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}`,
      time: `${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}:${pad(kst.getUTCSeconds())}`,
    };
  }

  const s = String(input);
  // ISO with T or space: 2026-05-13T18:30:00 / 2026-05-13 18:30:00
  let m = s.match(/(\d{4})-?(\d{2})-?(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}:${m[6] || '00'}` };
  // Fully packed: 20260513183000
  m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}:${m[6] || '00'}` };
  // Date only: 2026-05-13 or 20260513
  m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: null };
  return { date: null, time: null };
}

// 티켓링크 API 의 경기 일시 필드명은 응답에 따라 다양함.
const API_SCHEDULE_DATE_KEYS = [
  'scheduleDate', 'scheduleDateTime', 'scheduleStartDate', 'scheduleStartDateTime',
  'gameDate', 'gameDateTime', 'gameStartDate', 'gameStartDateTime',
  'startDate', 'startDateTime', 'playDate', 'playDateTime', 'displayDate',
];

function pickApiScheduleDate(s) {
  for (const k of API_SCHEDULE_DATE_KEYS) {
    if (s[k] != null && s[k] !== '') return s[k];
  }
  return null;
}

function mapApiSchedule(s) {
  const home = s.homeTeam?.teamName || '';
  const away = s.awayTeam?.teamName || '';
  const opponent = /삼성|라이온즈/.test(home) ? away : home;

  const { date, time } = parseDateTime(pickApiScheduleDate(s));
  const reserve = parseDateTime(s.reserveOpenDate);
  const targetTime = reserve.time ? `${reserve.time}.000` : '11:00:00.000';

  // ON_SALE / RESERVE_OPEN / OPENED = 실제 오픈. BEFORE_OPEN / NOT_OPEN = 오픈 전.
  const reserveStatus = String(s.reserveButtonStatus || '').toUpperCase();
  const PRE_OPEN_STATUSES = ['BEFORE_OPEN', 'NOT_OPEN', 'OPEN_BEFORE', 'PRE_OPEN'];
  const isPreOpen = PRE_OPEN_STATUSES.includes(reserveStatus);
  const isOpen = !isPreOpen && (
    reserveStatus === 'ON_SALE'
    || reserveStatus === 'OPENED'
    || reserveStatus === 'RESERVE_OPEN'
    || reserveStatus === 'OPEN'
  );

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
    scheduleSource: 'api',
    bookingOpen: isOpen,
    reserveButtonStatus: s.reserveButtonStatus || null,
    reserveOpenDate: s.reserveOpenDate || null,
    reserveCloseDate: s.reserveCloseDate || null,
    venueName: s.venueName || null,
    captchaUse: !!s.captchaUse,                          // 클린예매(CAPTCHA)
    authReinforceYn: s.authReinforceYn === 'Y',           // 기기 인증 필요
    waitingAvailable: !!s.waitingReservation?.waitingReservationUse,
    bookingUrl: s.productId ? buildBookingUrl(s.productId, s.scheduleId) : null,
    sourceUrl: SOURCE_URL,
    preOpen: isPreOpen,
  };
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
  // 시스템 Chrome을 우선 사용. Puppeteer 번들 Chromium은 식별이 더 쉬워서 차단되기 쉽습니다.
  const systemChrome = detectChromePath();
  log(`mode=${MODE} headless=${HEADLESS} ci=${IS_CI} chrome=${systemChrome || 'bundled'} attach=${ATTACH_URL || 'no'} url=${SOURCE_URL}`);

  let browser;
  const attached = !!ATTACH_URL;

  if (attached) {
    // 사용자가 이미 실행해둔 Chrome에 CDP로 연결만 합니다.
    // Chrome 자체가 평범하게 시작되어 자동화 흔적이 없으므로 가장 안정적입니다.
    browser = await puppeteer.connect({
      browserURL: ATTACH_URL,
      defaultViewport: null,
    });
    log('attached to existing Chrome');
  } else {
    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--lang=ko-KR,ko',
      '--window-size=1440,900',
      '--disable-features=IsolateOrigins,site-per-process,SitePerProcess',
    ];
    if (INSECURE) launchArgs.push('--ignore-certificate-errors');

    // 사용자가 본인 Chrome 프로필을 재사용하면 쿠키/방문이력으로 평판을 만든 상태가 되어
    // 봇 탐지를 거의 트리거하지 않습니다. CHROME_USER_DATA_DIR로 명시 지정.
    // 주의: 동일 디렉터리로 Chrome이 이미 떠 있으면 launch가 실패하므로 새 프로필 폴더 권장.
    const userDataDir = process.env.CHROME_USER_DATA_DIR || undefined;
    if (userDataDir) log(`using userDataDir=${userDataDir}`);

    browser = await puppeteer.launch({
      headless: HEADLESS ? 'new' : false,
      executablePath: systemChrome || undefined,
      userDataDir,
      ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features=IdleDetection'],
      defaultViewport: null,
      acceptInsecureCerts: INSECURE,
      args: launchArgs,
    });
  }

  let page;
  let userOwnedPage = false; // true이면 사용자 탭이므로 절대 닫지 말 것
  try {
    let games;
    let scrapeMeta = {};

    if (attached) {
      // attach 모드: 사용자가 이미 PerimeterX를 통과한 탭에서 schedules API를 직접 호출.
      // scheduleId는 DOM에 없고 React props로만 존재하므로 API가 유일한 정확한 출처.
      const pages = await browser.pages();
      const ticketlinkTab = pages.find((p) => /ticketlink\.co\.kr/.test(p.url()));
      if (!ticketlinkTab) {
        throw new Error(
          'attach 모드에서 ticketlink.co.kr 탭을 찾지 못했습니다. ' +
          '먼저 Chrome 창에서 https://m.ticketlink.co.kr/sports/137/57 를 직접 방문해 페이지가 정상 로드된 상태에서 다시 실행하세요.'
        );
      }
      page = ticketlinkTab;
      userOwnedPage = true;
      log(`reusing user tab: ${page.url()}`);

      games = await fetchSchedulesFromApi(page);
      scrapeMeta = { strategy: 'api-via-user-tab', endpoint: 'mapi.ticketlink.co.kr/mapi/sports/schedules' };
    } else {
      // launch 모드: DOM 휴리스틱 fallback. 봇 차단이 심해 거의 동작 안 함.
      page = await browser.newPage();
      await configurePage(page);
      page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

      if (DEBUG) {
        page.on('console', (msg) => log('page', msg.type(), msg.text()));
        page.on('requestfailed', (req) => log('reqfail', req.url(), req.failure()?.errorText));
      }

      const response = await page.goto(SOURCE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      const status = response?.status() ?? 0;
      log(`initial response status=${status}`);
      if (status >= 400) throw new Error(`HTTP ${status} from ${SOURCE_URL}`);

      await waitForBookingContent(page, { totalMs: 18_000 });
      await autoScroll(page, { steps: 6 });
      await waitForBookingContent(page, { totalMs: 6_000 });

      const rawGames = await extractGames(page);
      const harvest = await harvestScheduleIds(page);
      log(`launch-mode harvest: anchors=${rawGames.length} cards=${harvest.cards.length} nextData=${harvest.nextData.length}`);
      const merged = mergeSchedules(rawGames, harvest, BOOKING_URL_PATTERN);
      games = dedupeGames(merged.games);
      scrapeMeta = { strategy: 'dom-fallback' };
    }

    log(`final games=${games.length} (pre-open=${games.filter((g) => g.preOpen).length}, with scheduleId=${games.filter((g) => g.scheduleId).length})`);

    const payload = {
      team: 'Samsung Lions',
      teamKo: '삼성 라이온즈',
      sourceUrl: SOURCE_URL,
      bookingUrlPattern: BOOKING_URL_PATTERN,
      updatedAt: new Date().toISOString(),
      timeZone: KST_TIME_ZONE,
      mode: MODE,
      ...scrapeMeta,
      count: games.length,
      games,
    };

    await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    log(`saved ${games.length} item(s) -> ${OUTPUT_PATH}`);
  } finally {
    if (attached) {
      // 사용자가 직접 띄운 탭은 절대 닫지 말 것. 그냥 disconnect만.
      if (!userOwnedPage && page) {
        try { if (!page.isClosed()) await page.close(); } catch { /* ignore */ }
      }
      try { await browser.disconnect(); } catch { /* ignore */ }
    } else {
      await browser.close();
    }
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
  const msg = String(error?.message || error);
  const isBlocked = /^BLOCKED:/.test(msg);
  const isTargetClose = /TargetCloseError|Target closed|page-context-lost/.test(msg);

  if (isBlocked || isTargetClose) {
    if (isBlocked) console.error('\n[scraper] 티켓링크 봇 탐지에 걸렸습니다.\n', msg);
    else console.error('\n[scraper] 브라우저 세션이 끊겼습니다 (TargetCloseError). 대부분 봇 탐지 페이지가 탭을 강제로 닫은 결과입니다.\n', msg);
    console.error('\n해결 방법 (가장 확실한 순서):');
    console.error('  방법 A — 사용자가 직접 띄운 Chrome 탭에 attach (가장 안전):');
    console.error('    1) Chrome을 모두 종료한 뒤 PowerShell에서:');
    console.error('       & "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\\temp\\kbo-chrome"');
    console.error('    2) [필수] 열린 Chrome 창의 주소창에 직접 입력하여 방문:');
    console.error('       https://m.ticketlink.co.kr/sports/137/57');
    console.error('       페이지가 정상 로드되고 경기 목록이 보일 때까지 기다리세요');
    console.error('    3) 다른 PowerShell 창에서: npm run scrape:attach');
    console.error('       → 스크래퍼는 새 탭을 만들지 않고 사용자가 연 탭만 읽습니다');
    console.error('');
    console.error('  방법 B — 본인 Chrome 프로필 디렉터리 재사용 (Chrome 완전 종료 필요):');
    console.error('    $env:CHROME_USER_DATA_DIR="$env:LOCALAPPDATA\\Google\\Chrome\\User Data"');
    console.error('    npm run scrape:local');
    console.error('');
    console.error('  방법 C — 10~30분 기다린 뒤 재시도 (IP 평판 회복)');
  } else {
    console.error('[scraper] failed:', error);
  }

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
