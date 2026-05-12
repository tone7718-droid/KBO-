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
