const KEY_GAMES = 'kbo-ticket-helper.games.v1';
const KEY_PREFS = 'kbo-ticket-helper.preferences.v1';
const REMINDERS = [['30분 전', 30], ['10분 전', 10], ['5분 전', 5], ['1분 전', 1]];

let rules;
let games = [];
let prefs = {
  favoriteTeam: 'SAMSUNG',
  defaultPartySize: 2,
  defaultSeatMemo: '1순위: 1루 내야 / 2순위: 중앙 / 3순위: 외야'
};
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
const inputDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const today = (offset = 0) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return inputDate(date);
};
const team = (code) => rules?.teams?.[code] || { name: code, shortName: code, stadium: '', ticketUrl: '' };
const rule = (home) => {
  const teamRule = team(home);
  const defaultRule = rules.defaultRule;
  return {
    ...defaultRule,
    ...teamRule,
    openOffsetDays: Number(teamRule.openOffsetDays ?? defaultRule.openOffsetDays),
    openTime: teamRule.openTime || defaultRule.openTime,
    certainty: teamRule.certainty || defaultRule.certainty || 'estimated'
  };
};
const openAt = (game) => {
  const gameRule = rule(game.home);
  if (!game.date || !gameRule.openTime) return null;
  const date = new Date(`${game.date}T${gameRule.openTime}:00+09:00`);
  date.setDate(date.getDate() - Number(gameRule.openOffsetDays || 0));
  return date;
};
const isOpen = (game) => {
  const date = openAt(game);
  return Boolean(date && Date.now() >= date.getTime());
};
const fmt = (date) => date
  ? new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date)
  : '계산 불가';
const left = (date) => {
  if (!date) return '예매 시각 계산 불가';
  const diff = date.getTime() - Date.now();
  const abs = Math.abs(diff);
  const day = Math.floor(abs / 864e5);
  const hour = Math.floor((abs % 864e5) / 36e5);
  const min = Math.floor((abs % 36e5) / 6e4);
  const sec = Math.floor((abs % 6e4) / 1000);
  const text = `${day ? `${day}일 ` : ''}${hour ? `${hour}시간 ` : ''}${min}분 ${sec}초`;
  if (diff <= 0) return abs < 18e5 ? '지금 예매 진입 시간' : `오픈 후 ${text} 지남`;
  return `${text} 남음`;
};
const status = (date) => {
  if (!date) return ['확인 필요', 'muted'];
  const diff = date.getTime() - Date.now();
  if (diff <= 0 && Math.abs(diff) < 18e5) return ['예매 진입', 'live'];
  if (diff <= 0) return ['오픈 완료', 'done'];
  if (diff <= 30 * 6e4) return ['30분 이내', 'soon'];
  if (diff <= 864e5) return ['오늘/내일', 'soon'];
  return ['대기 중', 'wait'];
};
const options = (selected) => Object.entries(rules.teams)
  .map(([code, item]) => `<option value="${esc(code)}" ${code === selected ? 'selected' : ''}>${esc(item.shortName || item.name)}</option>`)
  .join('');
const safeUrl = (value) => {
  const fallback = 'https://www.koreabaseball.com/';
  try {
    const url = new URL(String(value || '').trim(), window.location.origin);
    if (!['http:', 'https:'].includes(url.protocol)) return fallback;
    return url.href;
  } catch {
    return fallback;
  }
};
const urlFor = (game) => safeUrl((game.ticketUrlOverride || '').trim() || rule(game.home).ticketUrl || 'https://www.koreabaseball.com/');
const sorted = () => [...games].sort((a, b) => (openAt(a)?.getTime() ?? 9e15) - (openAt(b)?.getTime() ?? 9e15));

function render(shouldSchedule = false) {
  const list = sorted();
  const next = list.find((game) => openAt(game) && openAt(game).getTime() > Date.now() - 18e5);
  app.innerHTML = `
    <header class="hero">
      <p class="eyebrow">KBO 자동 예매가 아닌 정시 진입 보조</p>
      <h1>11시 정각에<br>예매 버튼이 자동 활성화됩니다.</h1>
      <p>홈팀 기준 예매처, 오픈 예상 시각, 인원, 좌석 선호, 캘린더 알림을 관리합니다. 앱 화면은 1초마다 갱신되며, 예매처에는 사용자가 직접 진입합니다.</p>
      ${next ? focus(next) : ''}
    </header>
    <main class="layout">
      <section class="panel">
        <p class="eyebrow">관심 경기 추가</p>
        <h2>홈팀 기준으로 예매 시각 계산</h2>
        ${form()}
      </section>
      <section class="panel">
        <div class="row">
          <div>
            <p class="eyebrow">예매 카드</p>
            <h2>${list.length}개 경기</h2>
          </div>
          <button class="ghost" data-action="permission">알림 권한</button>
        </div>
        <div class="notice"><b>중요:</b> 삼성 홈경기 기본 예매 링크는 티켓링크 모바일 주소로 설정했습니다. 실제 경기별 상세 URL을 알고 있으면 직접 입력하세요.</div>
        <div class="cards">${list.length ? list.map(card).join('') : '<p class="empty">아직 등록한 경기가 없습니다.</p>'}</div>
      </section>
      <section class="panel dark">
        <p class="eyebrow">운영 원칙</p>
        <h2>이 앱이 하지 않는 것</h2>
        <div class="safety">
          <span>CAPTCHA 우회 없음</span>
          <span>좌석 자동 클릭 없음</span>
          <span>자동 결제 없음</span>
          <span>대기열 우회 없음</span>
          <span>티켓링크 반복 요청 없음</span>
          <span>계정 공유 없음</span>
        </div>
      </section>
    </main>`;
  bind();
  if (shouldSchedule) scheduleAll();
}

function focus(game) {
  const home = team(game.home);
  const away = team(game.away);
  const date = openAt(game);
  const currentStatus = status(date);
  return `
    <div class="focus">
      <div>
        <span class="badge ${currentStatus[1]}">${currentStatus[0]}</span>
        <h2>${esc(home.shortName)} vs ${esc(away.shortName)}</h2>
        <p>${esc(game.stadium || home.stadium)} · ${esc(game.date)} ${esc(game.time || '')}</p>
      </div>
      <div class="time">
        <span>${fmt(date)}</span>
        <strong>${left(date)}</strong>
      </div>
    </div>`;
}

function form() {
  return `
    <form id="game-form" class="game-form">
      <label>경기일<input type="date" name="date" value="${today(8)}" required></label>
      <label>경기 시간<input type="time" name="time" value="18:30" required></label>
      <label>홈팀<select name="home">${options(prefs.favoriteTeam)}</select></label>
      <label>원정팀<select name="away">${options('KIA')}</select></label>
      <label>경기장<input name="stadium" placeholder="홈팀 기본 경기장 사용"></label>
      <label>인원<input type="number" name="partySize" min="1" max="10" value="${prefs.defaultPartySize}"></label>
      <label class="wide">좌석 선호 메모<input name="seatMemo" value="${esc(prefs.defaultSeatMemo)}"></label>
      <label class="wide">경기별 예매 URL 직접 입력<input type="url" name="ticketUrlOverride" placeholder="정확한 링크를 알고 있으면 붙여넣기"></label>
      <button class="primary wide">관심 경기 추가</button>
    </form>`;
}

function card(game) {
  const home = team(game.home);
  const away = team(game.away);
  const gameRule = rule(game.home);
  const date = openAt(game);
  const currentStatus = status(date);
  const opened = isOpen(game);
  const ticketButton = opened
    ? `<a class="primary liveLink" href="${esc(urlFor(game))}" target="_blank" rel="noreferrer">예매 바로가기</a>`
    : `<button class="primary disabled" type="button" data-action="locked" data-id="${esc(game.id)}">${esc(gameRule.openTime)} 자동 활성화 대기</button>`;
  const certaintyText = gameRule.certainty === 'confirmed' || gameRule.certainty === 'confirmed-link' ? '링크 확인' : '추정';
  return `
    <article class="card">
      <div class="cardTop">
        <div>
          <span class="badge ${currentStatus[1]}">${currentStatus[0]}</span>
          <h3>${esc(home.shortName)} vs ${esc(away.shortName)}</h3>
          <p>${esc(game.stadium || home.stadium)} · ${esc(game.date)} ${esc(game.time || '')}</p>
        </div>
        <button class="x" data-action="delete" data-id="${esc(game.id)}">×</button>
      </div>
      <dl>
        <div><dt>예매 오픈</dt><dd>${fmt(date)}</dd></div>
        <div><dt>남은 시간</dt><dd class="tick">${left(date)}</dd></div>
        <div><dt>예매처</dt><dd>${esc(gameRule.platform || '확인 필요')} · ${certaintyText}</dd></div>
        <div><dt>인원/좌석</dt><dd>${esc(game.partySize || prefs.defaultPartySize)}명 · ${esc(game.seatMemo || prefs.defaultSeatMemo)}</dd></div>
      </dl>
      <div class="buttons">
        ${ticketButton}
        <button class="secondary" data-action="ics" data-id="${esc(game.id)}">캘린더 추가</button>
        <button class="secondary" data-action="schedule" data-id="${esc(game.id)}">앱 알림 예약</button>
        <button class="ghost" data-action="copy" data-id="${esc(game.id)}">메모 복사</button>
      </div>
    </article>`;
}

function bind() {
  document.querySelector('#game-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const formData = new FormData(event.target);
    const home = formData.get('home');
    const away = formData.get('away');
    if (home === away) return toast('홈팀과 원정팀이 같습니다.');
    const homeTeam = team(home);
    const game = {
      id: crypto.randomUUID?.() || `game-${Date.now()}`,
      date: formData.get('date'),
      time: formData.get('time'),
      home,
      away,
      stadium: formData.get('stadium') || homeTeam.stadium,
      partySize: Number(formData.get('partySize') || 2),
      seatMemo: formData.get('seatMemo') || prefs.defaultSeatMemo,
      ticketUrlOverride: formData.get('ticketUrlOverride') || ''
    };
    prefs.favoriteTeam = home;
    prefs.defaultPartySize = game.partySize;
    prefs.defaultSeatMemo = game.seatMemo;
    games.push(game);
    save();
    render(true);
    toast('관심 경기를 추가했습니다.');
  });

  document.querySelectorAll('[data-action]').forEach((element) => element.addEventListener('click', async (event) => {
    const action = event.currentTarget.dataset.action;
    const id = event.currentTarget.dataset.id;
    const game = games.find((item) => item.id === id);
    if (action === 'permission') await permission();
    if (action === 'locked' && game) toast(`${fmt(openAt(game))}부터 예매 바로가기 버튼이 자동 활성화됩니다.`);
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
  const permissionResult = await Notification.requestPermission();
  toast(permissionResult === 'granted' ? '알림 권한이 허용되었습니다.' : '알림 권한이 허용되지 않았습니다.');
  return permissionResult === 'granted';
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
  if (!date) {
    if (show) toast('예매 오픈 시각을 계산할 수 없습니다.');
    return;
  }
  const home = team(game.home);
  const away = team(game.away);
  const made = [];
  REMINDERS.forEach(([label, min]) => {
    const delay = date.getTime() - min * 6e4 - Date.now();
    if (delay <= 0 || delay > 21 * 864e5) return;
    timers.push(setTimeout(() => new Notification(`KBO 예매 ${label}: ${home.shortName} vs ${away.shortName}`, {
      body: `${fmt(date)} 오픈 예상 · ${game.partySize || prefs.defaultPartySize}명 · ${game.seatMemo || prefs.defaultSeatMemo}`,
      icon: '/icons/icon.svg',
      tag: `kbo-${game.id}-${min}`
    }), delay));
    made.push(label);
  });
  if (show) toast(made.length ? `${made.join(', ')} 알림을 예약했습니다. 앱이 열려 있어야 작동합니다.` : '예약 가능한 미래 알림이 없습니다. 캘린더 추가를 권장합니다.');
}

const icsTime = (date) => `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}00`;
const icsEsc = (value) => String(value)
  .replaceAll('\\', '\\\\')
  .replaceAll(';', '\\;')
  .replaceAll(',', '\\,')
  .replaceAll('\n', '\\n');

function downloadIcs(game) {
  const date = openAt(game);
  if (!date) return toast('예매 오픈 시각을 계산할 수 없습니다.');
  const end = new Date(date.getTime() + 15 * 6e4);
  const home = team(game.home);
  const away = team(game.away);
  const summary = `KBO 예매 시작: ${home.shortName} vs ${away.shortName}`;
  const desc = [
    `예매처: ${urlFor(game)}`,
    `인원: ${game.partySize || prefs.defaultPartySize}명`,
    `좌석 선호: ${game.seatMemo || prefs.defaultSeatMemo}`,
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
    'PRODID:-//KBO Ticket Helper//KO',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${game.id}@kbo-ticket-helper`,
    `DTSTAMP:${icsTime(new Date())}`,
    `DTSTART;TZID=Asia/Seoul:${icsTime(date)}`,
    `DTEND;TZID=Asia/Seoul:${icsTime(end)}`,
    `SUMMARY:${icsEsc(summary)}`,
    `LOCATION:${icsEsc(game.stadium || home.stadium)}`,
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
  link.download = `kbo-ticket-${game.date}-${home.shortName}-vs-${away.shortName}.ics`;
  link.click();
  URL.revokeObjectURL(url);
  toast('30/10/5/1분 캘린더 알림 파일을 만들었습니다.');
}

async function copyMemo(game) {
  const home = team(game.home);
  const away = team(game.away);
  const memo = [
    `[KBO 예매 준비] ${home.name} vs ${away.name}`,
    `경기: ${game.date} ${game.time} / ${game.stadium || home.stadium}`,
    `예매 오픈 예상: ${fmt(openAt(game))}`,
    `예매처: ${urlFor(game)}`,
    `인원: ${game.partySize || prefs.defaultPartySize}명`,
    `좌석 선호: ${game.seatMemo || prefs.defaultSeatMemo}`,
    '주의: 좌석 자동 선점/결제 없이 직접 예매'
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
    games = load(KEY_GAMES, []);
    if (!games.length) {
      games = (await getJson('/data/games.sample.json')).map((game) => ({
        ...game,
        id: game.id || `sample-${Date.now()}`,
        date: today(8)
      }));
      save();
    }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    render(true);
    renderTimer = setInterval(() => render(false), 1000);
  } catch (error) {
    app.innerHTML = `<div class="fatal"><h1>앱을 불러오지 못했습니다</h1><p>${esc(error.message)}</p></div>`;
  }
}

window.addEventListener('beforeunload', () => clearInterval(renderTimer));
init();
