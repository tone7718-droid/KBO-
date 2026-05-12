/**
 * 로컬에 저장된 티켓링크 HTML 파일을 파싱해 booking-data.json 생성.
 *
 * 사용:
 *   1) 본인 Chrome에서 https://m.ticketlink.co.kr/sports/137/57 정상 방문
 *   2) Ctrl+S 로 페이지 저장 (Webpage, Complete - HTML이 렌더된 상태로 저장됨)
 *   3) node scripts/parse-local-html.js "C:\path\to\saved.html"
 *
 * 자동화 흔적이 0이므로 티켓링크가 절대 감지할 수 없습니다.
 * JavaScript는 실행하지 않고 정적 DOM만 읽습니다.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const puppeteer = require('puppeteer');

const HTML_PATH = process.argv[2];
const OUTPUT_PATH = path.resolve(process.cwd(), 'booking-data.json');
const BOOKING_URL_PATTERN = process.env.TICKETLINK_BOOKING_URL_PATTERN
  || 'https://m.ticketlink.co.kr/sports/137/57/{scheduleId}';

if (!HTML_PATH) {
  console.error('사용: node scripts/parse-local-html.js <저장한HTML경로>');
  console.error('예시:');
  console.error('  Windows: node scripts/parse-local-html.js "C:\\Users\\zetz1\\Desktop\\samsung.html"');
  console.error('  macOS:   node scripts/parse-local-html.js ~/Desktop/samsung.html');
  process.exit(1);
}

async function main() {
  const absPath = path.resolve(HTML_PATH);
  try { await fs.access(absPath); } catch {
    console.error(`파일을 찾지 못했습니다: ${absPath}`);
    process.exit(1);
  }
  console.log(`[parse] reading ${absPath}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    // JavaScript 비활성화 — 저장된 HTML의 정적 DOM만 읽음, 추가 fetch 없음
    await page.setJavaScriptEnabled(false);
    await page.goto(`file://${absPath.replace(/\\/g, '/')}`, { waitUntil: 'domcontentloaded' });

    // anchor / button / [role=button] / data-*-id 가진 모든 노드를 훑음
    const harvest = await page.evaluate((urlPattern) => {
      const NUMERIC_ID = /^\d{4,}$/;
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

      function extractIdFromString(s) {
        if (!s) return null;
        let m = s.match(/\/(\d{5,})(?:[/?#]|$)/);
        if (m) return { id: m[1], src: 'path' };
        m = s.match(/[?&](?:scheduleId|gameId|matchId|productId|productNo|scheduleNo|game|schedule|id|p|no)=(\d{4,})/i);
        if (m) return { id: m[1], src: 'query' };
        m = s.match(/(?:scheduleId|productId|gameId|matchId)\s*[:=]\s*["']?(\d{4,})/i);
        if (m) return { id: m[1], src: 'code' };
        return null;
      }

      const cardSelector = 'li, article, [role="listitem"], div';
      const samsung = /삼성|라이온즈|Samsung|Lions/i;
      const timePattern = /\b([01]?\d|2[0-3]):[0-5]\d\b/;
      const datePattern = /\d{1,2}[.\-/월]\s*\d{1,2}/;
      const oppPattern = /(?:삼성\s*(?:vs|VS|대|-)\s*([가-힣A-Z]{2,10})|([가-힣A-Z]{2,10})\s*(?:vs|VS|대|-)\s*삼성)/;

      const all = document.querySelectorAll(cardSelector);
      const candidates = [];
      for (const el of all) {
        const t = el.innerText || '';
        if (!samsung.test(t)) continue;
        if (el.children.length === 0 || el.children.length > 60) continue;
        if (t.length > 1200) continue;
        if (!(timePattern.test(t) || datePattern.test(t))) continue;
        candidates.push(el);
      }
      // 가장 안쪽 카드만
      const inner = candidates.filter((el) => !candidates.some((other) => other !== el && other.contains(el)));

      const games = [];
      for (const card of inner) {
        const text = clean(card.innerText).slice(0, 240);
        // 1) 카드 전체에서 data-* 속성과 href 둘 다 훑어 scheduleId 찾기
        let found = null;
        for (const node of [card, ...card.querySelectorAll('*')]) {
          for (const attr of node.attributes || []) {
            const name = attr.name.toLowerCase();
            const val = String(attr.value || '');
            if (!val) continue;
            if (name.startsWith('data-') && /id|schedule|game|product|match/.test(name) && NUMERIC_ID.test(val)) {
              found = { id: val, src: `attr:${name}` };
              break;
            }
            if (name === 'href' || name === 'onclick' || name.startsWith('on')) {
              const r = extractIdFromString(val);
              if (r) { found = { id: r.id, src: `${name}:${r.src}` }; break; }
            }
          }
          if (found) break;
        }

        // 2) 날짜/시간/상대팀 파싱
        const dateMatch = text.match(/(\d{1,2})[.\-/월]\s*(\d{1,2})/);
        const timeMatch = text.match(timePattern);
        const oppMatch = text.match(oppPattern);

        games.push({
          text,
          scheduleId: found?.id || null,
          scheduleSource: found?.src || null,
          dateRaw: dateMatch ? `${dateMatch[1]}.${dateMatch[2]}` : null,
          time: timeMatch ? `${timeMatch[0]}:00` : null,
          opponent: oppMatch ? (oppMatch[1] || oppMatch[2] || '').trim() : '',
        });
      }

      // __NEXT_DATA__ 도 시도
      const nextDataNodes = document.querySelectorAll('script#__NEXT_DATA__, script[type="application/json"]');
      const nextSchedules = [];
      for (const n of nextDataNodes) {
        try {
          const obj = JSON.parse(n.textContent || '');
          const stack = [obj];
          while (stack.length) {
            const v = stack.pop();
            if (!v) continue;
            if (Array.isArray(v)) { stack.push(...v); continue; }
            if (typeof v !== 'object') continue;
            const idKey = Object.keys(v).find((k) => /^(scheduleId|gameId|matchId|productId)$/i.test(k));
            if (idKey && NUMERIC_ID.test(String(v[idKey]))) {
              const hasShape = ['gameDate', 'startDate', 'startTime', 'awayTeam', 'homeTeam', 'awayTeamName', 'homeTeamName'].some((k) => k in v);
              if (hasShape) nextSchedules.push({ scheduleId: String(v[idKey]), idKey, raw: v });
            }
            for (const child of Object.values(v)) stack.push(child);
          }
        } catch { /* not json */ }
      }

      return { cards: games, nextData: nextSchedules, urlPattern };
    }, BOOKING_URL_PATTERN);

    console.log(`[parse] cards=${harvest.cards.length} nextData=${harvest.nextData.length}`);

    const today = new Date();
    const buildUrl = (id) => BOOKING_URL_PATTERN.replace('{scheduleId}', encodeURIComponent(id));

    const games = [];
    const seen = new Set();
    for (const c of harvest.cards) {
      if (!c.scheduleId) continue;
      if (seen.has(c.scheduleId)) continue;
      seen.add(c.scheduleId);
      // dateRaw → ISO (연도는 현재 연도로 가정. 과거 월이면 +1년)
      let date = null;
      if (c.dateRaw) {
        const [mm, dd] = c.dateRaw.split('.').map(Number);
        const nowMonth = today.getMonth() + 1;
        const year = (mm < nowMonth - 6) ? today.getFullYear() + 1 : today.getFullYear();
        date = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
      }
      games.push({
        id: `local-${c.scheduleId}`.slice(0, 16),
        team: '삼성 라이온즈',
        opponent: c.opponent,
        title: c.text,
        date,
        time: c.time,
        targetTime: '11:00:00.000',
        scheduleId: c.scheduleId,
        scheduleSource: c.scheduleSource,
        bookingUrl: buildUrl(c.scheduleId),
        sourceUrl: `file://${absPath}`,
        preOpen: false,
      });
    }
    for (const n of harvest.nextData) {
      if (seen.has(n.scheduleId)) continue;
      seen.add(n.scheduleId);
      const raw = n.raw || {};
      const away = raw.awayTeam || raw.awayTeamName || '';
      const home = raw.homeTeam || raw.homeTeamName || '';
      const opponent = /삼성|라이온즈/.test(home) ? away : home;
      const rawDate = raw.gameDate || raw.startDate || raw.gameStartDate;
      const date = rawDate ? String(rawDate).slice(0, 10).replace(/[./]/g, '-') : null;
      games.push({
        id: `local-${n.scheduleId}`.slice(0, 16),
        team: '삼성 라이온즈',
        opponent,
        title: `${date || ''} ${raw.startTime || ''} ${away} vs ${home}`.trim(),
        date,
        time: raw.startTime ? `${raw.startTime}:00` : null,
        targetTime: '11:00:00.000',
        scheduleId: n.scheduleId,
        scheduleSource: 'next-data',
        bookingUrl: buildUrl(n.scheduleId),
        sourceUrl: `file://${absPath}`,
        preOpen: false,
      });
    }

    const payload = {
      team: 'Samsung Lions',
      teamKo: '삼성 라이온즈',
      sourceUrl: `file://${absPath}`,
      bookingUrlPattern: BOOKING_URL_PATTERN,
      updatedAt: new Date().toISOString(),
      timeZone: 'Asia/Seoul',
      mode: 'local-html',
      count: games.length,
      games,
    };

    await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`[parse] saved ${games.length} game(s) -> ${OUTPUT_PATH}`);
    if (games.length === 0) {
      console.log('\n[parse] 0건 추출. 가능성:');
      console.log('  - 저장된 HTML이 정적 렌더 전(JS로만 채워지는) 상태로 저장됨');
      console.log('  - 페이지 구조가 예상과 다름 → discover/page.html 와 비슷한 분석 필요');
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error('[parse] failed:', e); process.exit(1); });
