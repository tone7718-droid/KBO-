/**
 * Discovery 도구 — attach 모드 전용.
 *
 * 사용자가 직접 띄운 Chrome의 ticketlink 탭에 붙어 다음을 덤프합니다:
 *  - discover/page.html        : 페이지 전체 HTML (DOM 구조 분석용)
 *  - discover/page.png         : 풀페이지 스크린샷 (실제 표시 상태 확인용)
 *  - discover/cards.json       : "삼성 + 시각" 패턴으로 추정한 실제 경기 카드 후보
 *  - discover/network.json     : 페이지가 호출하는 XHR/fetch URL과 응답 일부 (10초간)
 *  - discover/globals.json     : window의 schedule/game/booking 관련 전역값
 *  - 표준출력                  : 가장 유망한 카드 후보 outerHTML 1개 (사용자가 그대로 복붙)
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const puppeteer = require('puppeteer');

const ATTACH_URL = process.env.SCRAPER_ATTACH_URL || 'http://localhost:9222';
const OUT_DIR = path.resolve(process.cwd(), 'discover');
const NETWORK_CAPTURE_MS = Number(process.env.DISCOVER_NETWORK_MS || 10_000);

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const browser = await puppeteer.connect({ browserURL: ATTACH_URL, defaultViewport: null });
  const pages = await browser.pages();
  const page = pages.find((p) => /ticketlink\.co\.kr/.test(p.url()));
  if (!page) {
    console.error('[discover] ticketlink.co.kr 탭을 찾지 못했습니다. Chrome 창에서 먼저 페이지를 방문하세요.');
    await browser.disconnect();
    process.exit(1);
  }
  console.log(`[discover] attached: ${page.url()}`);

  // 1. 페이지 HTML 덤프
  const html = await page.content();
  await fs.writeFile(path.join(OUT_DIR, 'page.html'), html, 'utf8');
  console.log(`[discover] saved page.html (${html.length} bytes)`);

  // 2. 풀페이지 스크린샷
  try {
    await page.screenshot({ path: path.join(OUT_DIR, 'page.png'), fullPage: true });
    console.log('[discover] saved page.png');
  } catch (e) {
    console.warn('[discover] screenshot failed:', e.message);
  }

  // 3. 실제 경기 카드로 추정되는 노드 추출 (휴리스틱)
  const cards = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

    // "삼성/라이온즈"와 시각(HH:MM) 또는 날짜(MM.DD / MM월 DD일)를 모두 포함하는 작은 컨테이너
    const all = document.querySelectorAll('*');
    const candidates = [];
    for (const el of all) {
      if (el.children.length === 0 || el.children.length > 50) continue;
      const t = el.innerText || '';
      if (t.length > 600) continue;
      const hasTeam = /삼성|라이온즈/.test(t);
      const hasTime = /\b([01]?\d|2[0-3]):[0-5]\d\b/.test(t);
      const hasDate = /\d{1,2}[.\-/월]\s*\d{1,2}/.test(t);
      if (hasTeam && (hasTime || hasDate)) candidates.push(el);
    }
    // 다른 후보를 포함하는 외부 컨테이너는 제거 (가장 안쪽 카드만)
    const inner = candidates.filter((el) => !candidates.some((other) => other !== el && other.contains(el)));

    return inner.slice(0, 12).map((el) => {
      const attrs = {};
      for (const a of el.attributes || []) attrs[a.name] = a.value;
      const childTags = [...el.children].slice(0, 10).map((c) => ({
        tag: c.tagName.toLowerCase(),
        class: (c.className && c.className.toString) ? c.className.toString().slice(0, 60) : '',
        text: clean(c.innerText).slice(0, 80),
      }));
      // 자식 요소 중 모든 data-* 속성을 수집 (scheduleId 단서)
      const dataAttrs = {};
      for (const node of [el, ...el.querySelectorAll('*')]) {
        for (const a of node.attributes || []) {
          if (a.name.startsWith('data-')) {
            const k = `${node.tagName.toLowerCase()}.${a.name}`;
            if (!(k in dataAttrs)) dataAttrs[k] = a.value;
          }
        }
      }
      return {
        tag: el.tagName.toLowerCase(),
        class: (el.className && el.className.toString) ? el.className.toString() : '',
        id: el.id || '',
        attrs,
        text: clean(el.innerText).slice(0, 300),
        childTags,
        dataAttrs,
        outerHTMLSnippet: el.outerHTML.slice(0, 3000),
      };
    });
  });
  await fs.writeFile(path.join(OUT_DIR, 'cards.json'), JSON.stringify(cards, null, 2), 'utf8');
  console.log(`[discover] saved cards.json (${cards.length} card candidates)`);

  // 4. window의 schedule/game 관련 전역값
  const globals = await page.evaluate(() => {
    const out = {};
    for (const k of Object.keys(window)) {
      if (/schedule|game|booking|sports|product|match|ticket/i.test(k)) {
        try {
          const v = window[k];
          if (v == null) continue;
          if (typeof v === 'function') continue;
          if (typeof v === 'object') {
            const json = JSON.stringify(v);
            if (json && json.length > 5 && json !== '{}' && json !== '[]') out[k] = json.slice(0, 1500);
          } else if (typeof v !== 'symbol') {
            out[k] = String(v).slice(0, 300);
          }
        } catch { /* circular or restricted */ }
      }
    }
    return out;
  });
  await fs.writeFile(path.join(OUT_DIR, 'globals.json'), JSON.stringify(globals, null, 2), 'utf8');
  console.log(`[discover] saved globals.json (${Object.keys(globals).length} keys)`);

  // 5. 10초간 fetch/XHR 호출 캡처 (사용자가 페이지에서 월/날짜를 클릭하면 API가 보임)
  const network = [];
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.responseReceived', (e) => {
    const { type, response } = e;
    if (type !== 'XHR' && type !== 'Fetch') return;
    if (!response.mimeType || !/json/.test(response.mimeType)) return;
    network.push({
      url: response.url,
      status: response.status,
      mimeType: response.mimeType,
      method: e.requestId ? 'unknown' : 'unknown',
    });
  });
  console.log(`[discover] capturing XHR/fetch for ${NETWORK_CAPTURE_MS / 1000}s — interact with the page (스크롤/월 선택)...`);
  await new Promise((r) => setTimeout(r, NETWORK_CAPTURE_MS));
  await fs.writeFile(path.join(OUT_DIR, 'network.json'), JSON.stringify(network, null, 2), 'utf8');
  console.log(`[discover] saved network.json (${network.length} JSON responses)`);

  // 6. 가장 유망한 카드의 outerHTML을 표준출력으로
  if (cards.length > 0) {
    console.log('\n=== TOP CARD CANDIDATE (이것을 복사해서 공유해주세요) ===');
    console.log(cards[0].outerHTMLSnippet);
    console.log('=== END ===\n');
  }

  await browser.disconnect();
  console.log(`[discover] DONE — discover/ 폴더의 파일들을 확인하세요.`);
}

main().catch((e) => {
  console.error('[discover] failed:', e);
  process.exit(1);
});
