const fs = require('node:fs/promises');
const path = require('node:path');
const puppeteer = require('puppeteer');

const SOURCE_URL = process.env.TICKETLINK_SAMSUNG_URL || 'https://m.ticketlink.co.kr/sports/137/57';
const OUTPUT_PATH = path.resolve(process.cwd(), 'booking-data.json');
const KST_TIME_ZONE = 'Asia/Seoul';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toKstDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: KST_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const part = (type) => parts.find((item) => item.type === type)?.value;
  return {
    year: Number(part('year')),
    month: Number(part('month')),
    day: Number(part('day')),
  };
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

async function scrape() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
    await page.goto(SOURCE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await wait(3500);

    for (let i = 0; i < 5; i += 1) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.8));
      await wait(900);
    }

    const games = await extractGames(page);
    const payload = {
      team: 'Samsung Lions',
      teamKo: '삼성 라이온즈',
      sourceUrl: SOURCE_URL,
      updatedAt: new Date().toISOString(),
      timeZone: KST_TIME_ZONE,
      count: games.length,
      games,
    };

    await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`Saved ${games.length} booking item(s) to ${OUTPUT_PATH}`);
  } finally {
    await browser.close();
  }
}

scrape().catch(async (error) => {
  console.error(error);

  const fallback = {
    team: 'Samsung Lions',
    teamKo: '삼성 라이온즈',
    sourceUrl: SOURCE_URL,
    updatedAt: new Date().toISOString(),
    timeZone: KST_TIME_ZONE,
    count: 0,
    games: [],
    error: error.message,
  };

  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(fallback, null, 2)}\n`, 'utf8');
  process.exitCode = 1;
});
