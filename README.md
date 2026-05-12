# KBO Samsung Lions Precision Booking Clock

삼성 라이온즈 티켓링크 예매를 위한 1ms 단위 정밀 카운트다운 대시보드입니다.

- **Frontend (`index.html`)** – `requestAnimationFrame` 기반 정밀 시계, 서버 동기화, `booking-data.json` 자동 버튼 생성, 폴백 UI
- **Serverless API (`api/time.js`)** – Vercel Function. 티켓링크 `Date` 헤더 + WorldTimeAPI 동시 폴링으로 서버 시각 프록시
- **Scraper (`scripts/scraper.js`)** – Puppeteer로 삼성 라이온즈 경기/예매 URL 수집
- **CI (`.github/workflows/daily-update.yml`)** – 매일 09:00 KST 자동 갱신

---

## 로컬 실행 가이드

### 1. 의존성 설치

```bash
npm install
```

> Puppeteer가 Chromium을 자동 다운로드합니다. macOS / Linux / Windows 모두 동일.

### 2. 스크래퍼 실행

GitHub Actions의 IP는 티켓링크의 봇 차단(403/타임아웃)에 자주 막히므로, **로컬 머신에서 직접 실행**하는 것이 가장 안정적입니다.

| 명령 | 설명 |
| --- | --- |
| `npm run scrape:local` | 로컬용. headful Chrome으로 실제 데스크톱 UA + 한국어 로케일로 접속 (권장) |
| `npm run scrape:headful` | 위와 동일 + 디버그 로그(콘솔 출력, 실패 요청 표시) |
| `npm run scrape:ci` | CI 환경 흉내. headless 모바일 Safari UA |
| `npm run scrape:debug` | 모드는 자동 감지, 디버그 로그만 켭니다 |
| `npm run scrape` | 기본. `CI=true`면 ci 모드, 아니면 local 모드 |

실행 후 `booking-data.json`이 갱신됩니다. 결과를 커밋하면 GitHub Pages/Vercel에 즉시 반영됩니다.

```bash
npm run scrape:local
git add booking-data.json
git commit -m "chore: update booking data"
git push
```

### 3. 환경 변수 (선택)

| 변수 | 기본값 | 의미 |
| --- | --- | --- |
| `TICKETLINK_SAMSUNG_URL` | `https://m.ticketlink.co.kr/sports/137/57` | 스크래핑 대상 URL |
| `SCRAPER_MODE` | `local` 또는 `ci` (자동 감지) | 데스크톱/모바일 프로필 선택 |
| `SCRAPER_HEADLESS` | mode에 따라 자동 | `false`면 브라우저 창 표시 |
| `SCRAPER_DEBUG` | `0` | `1`이면 페이지 콘솔/네트워크 실패 로그 출력 |
| `SCRAPER_NAV_TIMEOUT_MS` | `60000` | 페이지 이동 타임아웃 |
| `SCRAPER_KEEP_ON_FAILURE` | `true` | 실패해도 기존 `booking-data.json`을 보존 |
| `SCRAPER_INSECURE` | `0` | 사내 MITM 프록시/방화벽이 TLS를 재서명할 때만 `1`로. CI에서는 절대 켜지 마세요 |
| `TICKETLINK_BOOKING_URL_PATTERN` | `https://m.ticketlink.co.kr/sports/137/57/{scheduleId}` | scheduleId 사전 수집 시 URL 조립 패턴. 사이트 구조가 바뀌면 여기만 갱신 |
| `CHROME_PATH` | (자동 탐지) | 시스템 Chrome 실행 파일 경로. 자동 탐지 실패 시 명시. |
| `CHROME_USER_DATA_DIR` | (없음) | 본인 Chrome 프로필 디렉터리. 쿠키/이력으로 봇 탐지 우회. 지정 전 Chrome 완전 종료 필요. |

### 봇 탐지(ErrorCode:200) 대응

티켓링크는 `navigator.webdriver`, 빠진 `window.chrome.runtime`, `--enable-automation` 같은 클라이언트 사이드 단서로 자동화를 탐지합니다. 이를 발견하면 "시스템에서 비정상적인 활동이 감지되었습니다. ... (ErrorCode:200)" 페이지를 띄우고 탭을 닫아 `TargetCloseError`가 발생합니다.

스크래퍼는 다음을 표준 Chrome 수준으로 정상화합니다:

- `navigator.webdriver = undefined` (Puppeteer 기본 `true` 보정)
- `window.chrome.runtime / csi / loadTimes` 객체 복원
- `navigator.plugins`에 PDF Viewer 추가 (빈 배열은 봇 시그니처)
- `--enable-automation` 플래그 제거
- 시스템에 설치된 실제 Chrome 사용 (번들 Chromium보다 식별이 어려움)

그래도 차단되면(연속 시도로 IP 평판 하락 가능):
1. **10~30분 대기** 후 재시도
2. **본인 Chrome 프로필 사용** (가장 확실):
   ```powershell
   # Windows — Chrome을 먼저 모두 종료
   $env:CHROME_USER_DATA_DIR="$env:LOCALAPPDATA\Google\Chrome\User Data"
   npm run scrape:local
   ```
   ```bash
   # macOS
   CHROME_USER_DATA_DIR="$HOME/Library/Application Support/Google/Chrome" npm run scrape:local
   ```
3. 차단 페이지가 떠도 `booking-data.json`은 이전 정상 데이터로 보존됩니다 (`SCRAPER_KEEP_ON_FAILURE`)

### scheduleId 사전 수집

`booking-data.json`의 각 항목은 `scheduleId` 와 `scheduleSource` 를 함께 가집니다. 스크래퍼는 **예매 버튼이 disabled 상태여도** 다음 4계층을 순회하며 ID를 수확합니다:

1. `<script id="__NEXT_DATA__">` 인라인 JSON (가장 권위적, raw 객체로 팀/날짜까지 추출)
2. `data-schedule-id` / `data-game-id` / `data-product-id` 등 `data-*` 속성
3. anchor `href` 꼬리 숫자 (`/sports/137/57/12345`)
4. `onclick` / 인라인 핸들러 안의 정규식 (`productId: 12345`)

수집된 ID는 `TICKETLINK_BOOKING_URL_PATTERN`에 따라 사전 URL로 조립되며, `preOpen: true` 와 `bookingOpen: false` 로 표시됩니다. 프런트엔드는 이런 항목에 `PRE-OPEN` 뱃지를 표시합니다.

### 4. 프런트엔드 로컬 미리보기

```bash
npm run serve
# → http://localhost:5173 에서 index.html 확인
```

`/api/time` 은 Vercel 배포 시에만 동작합니다. 로컬에선 자동으로 LOCAL 보정으로 폴백합니다.

---

## Vercel 배포

`vercel.json`이 이미 포함되어 있습니다.

```bash
npx vercel --prod
```

`/api/time?target=...`로 서버 시각을 조회합니다.
응답 필드:

- `serverTime` / `serverIso` – 서버 시각 (티켓링크 우선, 실패 시 WorldTimeAPI)
- `proxyRtt` – Vercel ↔ 티켓링크 구간 RTT (클라이언트가 자신의 RTT에서 이 값을 빼서 미드포인트 보정)
- `source` – `ticketlink-date-header` / `time-api-json` / `vercel-local-fallback`

---

## 봇 차단 대응 설계

스크래퍼는 "우회"가 아니라 **표준 브라우저 환경과의 호환성 극대화**를 목표로 합니다.

- 실제 Chrome 131 데스크톱 UA(로컬) / iOS Safari 17.5 UA(CI)
- `Accept-Language: ko-KR`, 한국 타임존, 실제 브라우저가 보내는 sec-fetch 헤더
- `navigator.language`/`navigator.languages` 표준화
- `--disable-blink-features=AutomationControlled` 만 사용 (stealth plugin 등 회피 라이브러리 미사용)
- `waitForBookingContent`로 SPA 렌더 완료 후 추출
- `dom`/`anchor` 기반의 텍스트 휴리스틱 필터링 (셀렉터 변경에 강함)

GitHub Actions IP가 차단되면 워크플로는 실패 처리되지만 `SCRAPER_KEEP_ON_FAILURE=true`로 기존 데이터는 유지됩니다. 가장 권장되는 패턴은 **로컬에서 `npm run scrape:local`을 돌려 커밋**하는 것입니다.

---

## 파일 구조

```
.
├── api/time.js                 # Vercel Serverless: 서버 시각 프록시
├── index.html                  # 정밀 시계 대시보드 + 폴백 UI
├── scripts/scraper.js          # Puppeteer 스크래퍼
├── booking-data.json           # 스크래퍼 출력 (자동 생성)
├── .github/workflows/daily-update.yml
├── vercel.json
└── package.json
```
