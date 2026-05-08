const KEY_GAMES = 'kbo-ticket-helper.games.v2';
const OLD_KEY_GAMES = 'kbo-ticket-helper.games.v1';
const KEY_PREFS = 'kbo-ticket-helper.preferences.v2';
const REMINDERS = [['30분 전', 30], ['10분 전', 10], ['5분 전', 5], ['1분 전', 1]];
const SAMSUNG_CODE = 'SAMSUNG';
const SAMSUNG_TICKET_URL = 'https://m.ticketlink.co.kr/sports/137/57';

let rules;
let games = [];
let prefs = { seatMemo: '블루존 / 내야지정석 / 응원석 우선' };
let timers = [];
let renderTimer;

const app = document.querySelector('#app');
const esc = (value = '') => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');
const load = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
};
const save = () => {
  localStorage.setItem(KEY_GAMES, JSON.stringify(games));
  localStorage.setItem(KEY_PREFS, JSON.stringify(prefs));
};
const getJson = async (url) => {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${url} 파일을 불러오지 못했습니다.`);
  return response.json();
};
const team = (code) => rules?.teams?.[code] || { name: code, shortName: code, stadium: '', ticketUrl: '' };
const samsung = () => team(SAMSUNG_CODE);
const opponentOptions = (selected = 'KIA') => Object.entries(rules.teams)
  .filter(([code]) => code !== SAMSUNG_CODE)
  .map(([code, item]) => `<option value="${esc(code)}" ${code === selected ? 'selected' : ''}>${esc(item.shortName || item.name)}</option>`)
  .join('');
const safeUrl = (value) => {
  try {
    const url = new URL(String(value || '').trim(), window.location.origin);
    if (!['http:', 'https:'].includes(url.protocol)) return SAMSUNG_TICKET_URL;
    return url.href;
  } catch {
    return SAMSUNG_TICKET_URL;
  }
};
const urlFor = (game) => safeUrl(game.ticketUrlOverride || samsung().ticketUrl || SAMSUNG_TICKET_URL);
const fmtDateTime = (date) => date
  ? new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date)
  : '직접 확인 필요';
const openAt = (game) => {
  if (game.ticketOpenAt) {
    const explicitDate = new Date(game.ticketOpenAt);
    if (!Number.isNaN(explicitDate.getTime())) return explicitDate;
  }
  const date = new Date(`${game.date}T11:00:00+09:00`);
  date.setDate(date.getDate() - 9);
  return date;
};
const gameAt = (game) => new Date(`${game.date}T${game.time || '18:30'}:00+09:00`);
const isTicketOpen = (game) => Date.now() >= openAt(game).getTime();
const remainingText = (date) => {
  const diff = date.getTime() - Date.now();
  const abs = Math.abs(diff);
  const day = Math.floor(abs / 864e5);
  const hour = Math.floor((abs % 864e5) / 36e5);
  const min = Math.floor((abs % 36e5) / 6e4);
  const sec = Math.floor((abs % 6e4) / 1000);
  const text = `${day ? `${day}일 ` : ''}${hour ? `${hour}시간 ` : ''}${min}분 ${sec}초`;
  return diff <= 0 ? `오픈됨 · ${text} 경과` : `${text} 남음`;
};
const gameStatus = (game) => {
  if (isTicketOpen(game)) return ['예매 가능', 'live'];
  const diff = openAt(game).getTime() - Date.now();
  if (diff <= 30 * 6e4) return ['곧 오픈', 'soon'];
  return ['오픈 대기', 'wait'];
};
const sorted = () => [...games].sort((a, b) => gameAt(a).getTime() - gameAt(b).getTime());
const normalizeGame = (game) => ({
  id: game.id || crypto.randomUUID?.() || `game-${Date.now()}`,
  date: game.date,
  time: game.time || '17:00',
  home: SAMSUNG_CODE,
  away: game.away || 'KIA',
  stadium: game.stadium || samsung().stadium || '대구 삼성라이온즈파크',
  ticketOpenAt: game.ticketOpenAt || '',
  ticketUrlOverride: game.ticketUrlOverride || SAMSUNG_TICKET_URL,
  seatMemo: game.seatMemo || prefs.seatMemo
});

function render(shouldSchedule = false) {
  const list = sorted();
  const primary = list.find((game) => gameAt(game).getTime() >= Date.now() - 4 * 36e5) || list[0];
  app.innerHTML = `
    <header class="hero samsungHero">
      <div class="brandLine"><span class="mark">SL</span><span>Samsung Lions Ticket Helper</span></div>
      <h1>삼성 홈경기 예매만<br>깔끔하게 준비합니다.</h1>
      <p>대구 삼성라이온즈파크 홈경기 기준입니다. 인원 수는 티켓링크에 자동 입력하지 않으므로 제거했습니다. 핵심은 정확한 경기 시간, 예매 오픈 상태, 티켓링크 바로가기입니다.</p>
      ${primary ? focus(primary) : ''}
    </header>
    <main class="layout samsungLayout">
      <section class="panel compactPanel">
        <div class="sectionTitle">
          <p class="eyebrow">삼성 홈경기 추가</p>
          <h2>KIA @ 삼성처럼 간단히 등록</h2>
        </div>
        ${form()}
      </section>

      <section class="panel listPanel">
        <div class="row">
          <div>
            <p class="eyebrow">예매 현황</p>
            <h2>${list.length}개 삼성 홈경기</h2>
          </div>
          <div class="rowActions">
            <button class="ghost" data-action="permission">알림 권한</button>
            <button class="ghost dangerGhost" data-action="reset">데이터 초기화</button>
          </div>
        </div>
        <div class="notice"><b>수정:</b> 기존 잘못된 샘플 데이터는 제거했습니다. 2026.05.16 KIA @ 삼성은 17:00 시작, 현재 예매 가능 상태로 표시됩니다.</div>
        <div class="cards">${list.length ? list.map(card).join('') : '<p class="empty">등록된 삼성 홈경기가 없습니다.</p>'}</div>
      </section>
    </main>`;
  bind();
  if (shouldSchedule) scheduleAll();
}

function focus(game) {
  const away = team(game.away);
  const openDate = openAt(game);
  const status = gameStatus(game);
  const ticketButton = isTicketOpen(game)
    ? `<a class="heroButton" href="${esc(urlFor(game))}" target="_blank" rel="noreferrer">티켓링크 바로가기</a>`
    : `<button class="heroButton locked" data-action="locked" data-id="${esc(game.id)}">오픈 전 대기</button>`;
  return `
    <div class="focus samsungFocus">
      <div>
        <span class="badge ${status[1]}">${status[0]}</span>
        <h2>${esc(away.shortName)} @ 삼성</h2>
        <p>${esc(game.date)} ${esc(game.time)} · ${esc(game.stadium)}</p>
      </div>
      <div class="time cleanTime">
        <span>예매 오픈</span>
        <strong>${fmtDateTime(openDate)}</strong>
        <em>${remainingText(openDate)}</em>
        ${ticketButton}
      </div>
    </div>`;
}

function form() {
  return `
    <form id="game-form" class="game-form samsungForm">
      <label>경기일<input type="date" name="date" value="2026-05-16" required></label>
      <label>시작 시간<input type="time" name="time" value="17:00" required></label>
      <label>상대팀<select name="away">${opponentOptions('KIA')}</select></label>
      <label>예매 오픈 시각<input type="datetime-local" name="ticketOpenAt" value="2026-05-07T11:00"></label>
      <label class="wide">좌석 메모<input name="seatMemo" value="${esc(prefs.seatMemo)}"></label>
      <label class="wide">티켓링크 URL<input type="url" name="ticketUrlOverride" value="${SAMSUNG_TICKET_URL}"></label>
      <button class="primary wide">삼성 홈경기 추가</button>
    </form>`;
}

function card(game) {
  const away = team(game.away);
  const openDate = openAt(game);
  const status = gameStatus(game);
  const ticketButton = isTicketOpen(game)
    ? `<a class="primary liveLink" href="${esc(urlFor(game))}" target="_blank" rel="noreferrer">예매 바로가기</a>`
    : `<button class="primary disabled" type="button" data-action="locked" data-id="${esc(game.id)}">오픈 전 대기</button>`;
  return `
    <article class="card samsungCard">
      <div class="cardTop">
        <div>
          <span class="badge ${status[1]}">${status[0]}</span>
          <h3>${esc(away.shortName)} @ 삼성</h3>
          <p>${esc(game.date)} ${esc(game.time)} · ${esc(game.stadium)}</p>
        </div>
        <button class="x" data-action="delete" data-id="${esc(game.id)}">×</button>
      </div>
      <dl>
        <div><dt>예매 오픈</dt><dd>${fmtDateTime(openDate)}</dd></div>
        <div><dt>상태</dt><dd class="tick">${remainingText(openDate)}</dd></div>
        <div><dt>예매처</dt><dd>티켓링크 모바일</dd></div>
        <div><dt>좌석 메모</dt><dd>${esc(game.seatMemo || prefs.seatMemo)}</dd></div>
      </dl>
      <div class="buttons">
        ${ticketButton}
        <button class="secondary" data-action="ics" data-id="${esc(game.id)}">캘린더 추가</button>
        <button class="secondary" data-action="schedule" data-id="${esc(game.id)}">앱 알림</button>
        <button class="ghost" data-action="copy" data-id="${esc(game.id)}">메모 복사</button>
      </div>
    </article>`;
}

function bind() {
  document.querySelector('#game-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const formData = new FormData(event.target);
    const ticketOpenAt = formData.get('ticketOpenAt')
      ? `${formData.get('ticketOpenAt')}:00+09:00`
      : '';
    const game = normalizeGame({
      id: crypto.randomUUID?.() || `game-${Date.now()}`,
      date: formData.get('date'),
      time: formData.get('time'),
      away: formData.get('away'),
      stadium: samsung().stadium || '대구 삼성라이온즈파크',
      ticketOpenAt,
      ticketUrlOverride: formData.get('ticketUrlOverride') || SAMSUNG_TICKET_URL,
      seatMemo: formData.get('seatMemo') || prefs.seatMemo
    });
    prefs.seatMemo = game.seatMemo;
    games.push(game);
    save();
    render(true);
    toast('삼성 홈경기를 추가했습니다.');
  });

  document.querySelectorAll('[data-action]').forEach((element) => element.addEventListener('click', async (event) => {
    const action = event.currentTarget.dataset.action;
    const id = event.currentTarget.dataset.id;
    const game = games.find((item) => item.id === id);
    if (action === 'permission') await permission();
    if (action === 'locked' && game) toast(`${fmtDateTime(openAt(game))}부터 예매 버튼이 활성화됩니다.`);
    if (action === 'reset') {
      localStorage.removeItem(KEY_GAMES);
      localStorage.removeItem(OLD_KEY_GAMES);
      games = await getJson('/data/games.sample.json');
      games = games.map(normalizeGame);
      save();
      render(true);
      toast('잘못된 로컬 데이터를 초기화했습니다.');
    }
    if (action === 'delete' && game) {
      games = games.filter((item) => item.id !== id);
      save();
      render(true);
      toast('경기를 삭제했습니다.');
    }
    if (action === 'schedule' && game) {
      const ok = await permission();
      if (ok) schedule(game, true);
    }
    if (action === 'ics' && game) downloadIcs(game);
    if (action === 'copy' && game) copyMemo(game);
  }));
}

async function permission() {
  if (!('Notification' in window)) {
    toast('이 브라우저는 알림을 지원하지 않습니다. 캘린더 기능을 사용하세요.');
    return false;
  }
  if (Notification.permission === 'granted') {
    toast('알림 권한이 허용되어 있습니다.');
    return true;
  }
  if (Notification.permission === 'denied') {
    toast('브라우저 설정에서 알림 차단을 해제해야 합니다.');
    return false;
  }
  const result = await Notification.requestPermission();
  toast(result === 'granted' ? '알림 권한이 허용되었습니다.' : '알림 권한이 허용되지 않았습니다.');
  return result === 'granted';
}

function scheduleAll() {
  timers.forEach(clearTimeout);
  timers = [];
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  sorted().slice(0, 20).forEach((game) => schedule(game, false));
}

function schedule(game, show) {
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    if (show) toast('알림 권한이 필요합니다.');
    return;
  }
  const date = openAt(game);
  const away = team(game.away);
  const made = [];
  REMINDERS.forEach(([label, min]) => {
    const delay = date.getTime() - min * 6e4 - Date.now();
    if (delay <= 0 || delay > 21 * 864e5) return;
    timers.push(setTimeout(() => new Notification(`삼성 예매 ${label}: ${away.shortName}전`, {
      body: `${fmtDateTime(date)} 오픈 · ${game.seatMemo || prefs.seatMemo}`,
      icon: '/icons/icon.svg',
      tag: `samsung-${game.id}-${min}`
    }), delay));
    made.push(label);
  });
  if (show) toast(made.length ? `${made.join(', ')} 알림을 예약했습니다.` : '이미 예매가 열려 있어 예약할 미래 알림이 없습니다.');
}

const icsTime = (date) => `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}00`;
const icsEsc = (value) => String(value)
  .replaceAll('\\', '\\\\')
  .replaceAll(';', '\\;')
  .replaceAll(',', '\\,')
  .replaceAll('\n', '\\n');

function downloadIcs(game) {
  const date = openAt(game);
  const end = new Date(date.getTime() + 15 * 6e4);
  const away = team(game.away);
  const summary = `삼성 예매 시작: ${away.shortName}전`;
  const desc = [
    `예매처: ${urlFor(game)}`,
    `좌석 메모: ${game.seatMemo || prefs.seatMemo}`,
    '주의: 자동 예매가 아니라 정시 진입 보조 알림입니다.'
  ].join('\n');
  const alarms = REMINDERS.flatMap(([label, min]) => [
    'BEGIN:VALARM',
    `TRIGGER:-PT${min}M`,
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsEsc(`${summary} ${label}`)}`,
    'END:VALARM'
  ]);
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Samsung Lions Ticket Helper//KO',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${game.id}@samsung-lions-ticket-helper`,
    `DTSTAMP:${icsTime(new Date())}`,
    `DTSTART;TZID=Asia/Seoul:${icsTime(date)}`,
    `DTEND;TZID=Asia/Seoul:${icsTime(end)}`,
    `SUMMARY:${icsEsc(summary)}`,
    `LOCATION:${icsEsc(game.stadium)}`,
    `DESCRIPTION:${icsEsc(desc)}`,
    `URL:${icsEsc(urlFor(game))}`,
    ...alarms,
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `samsung-ticket-${game.date}-${away.shortName}.ics`;
  link.click();
  URL.revokeObjectURL(url);
  toast('캘린더 알림 파일을 만들었습니다.');
}

async function copyMemo(game) {
  const away = team(game.away);
  const memo = [
    `[삼성 예매 준비] ${away.name} @ 삼성 라이온즈`,
    `경기: ${game.date} ${game.time} / ${game.stadium}`,
    `예매 오픈: ${fmtDateTime(openAt(game))}`,
    `예매처: ${urlFor(game)}`,
    `좌석 메모: ${game.seatMemo || prefs.seatMemo}`
  ].join('\n');
  try {
    await navigator.clipboard.writeText(memo);
    toast('준비 메모를 복사했습니다.');
  } catch {
    toast('복사에 실패했습니다.');
  }
}

function toast(message) {
  document.querySelector('.toast')?.remove();
  const element = document.createElement('div');
  element.className = 'toast';
  element.textContent = message;
  document.body.appendChild(element);
  setTimeout(() => element.remove(), 3200);
}

async function init() {
  try {
    rules = await getJson('/data/ticket_rules.json');
    prefs = { ...prefs, ...load(KEY_PREFS, {}) };
    const oldGames = load(OLD_KEY_GAMES, []);
    const newGames = load(KEY_GAMES, []);
    games = newGames.length ? newGames : oldGames.filter((game) => game.id !== 'sample-samsung-kia');
    if (!games.length) games = await getJson('/data/games.sample.json');
    games = games.map(normalizeGame);
    save();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    render(true);
    renderTimer = setInterval(() => render(false), 1000);
  } catch (error) {
    app.innerHTML = `<div class="fatal"><h1>앱을 불러오지 못했습니다</h1><p>${esc(error.message)}</p></div>`;
  }
}

window.addEventListener('beforeunload', () => clearInterval(renderTimer));
init();
