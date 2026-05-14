# CLAUDE.md — KBO Samsung Lions 정밀 예매 시계

> 이 파일은 향후 세션이 이것만 읽고도 cold start 후 즉시 작업할 수 있도록 작성된 운영 지침서입니다.

---

## 1. 프로젝트 요약

삼성 라이온즈(KBO) 티켓링크 예매를 위한 1ms 정밀 카운트다운 대시보드.

핵심 목표: 미래 오픈 경기까지 포함해 `scheduleId`, `productId`, `reserveOpenDate` 를 확보하고, 사용자가 예매 오픈 시점에 빠르게 예매 페이지로 이동할 수 있게 한다.

예매 URL 패턴 (두 ID 모두 필요):

```txt
https://m.ticketlink.co.kr/reserve/product/{productId}?scheduleId={scheduleId}
```

- 배포: Vercel
- Node: 20 가정
- 사용자 디바이스: Windows + Chrome + PowerShell

이 프로젝트는 자동 구매, CAPTCHA/대기열/PerimeterX 챌린지 우회를 수행하지 않는다. 사용자의 정상 브라우징 중 생성된 공개 데이터를 정리하는 보조 도구이다.

---

## 2. 작업 브랜치 규칙

현재 작업 브랜치:

```txt
claude/fix-bot-detection-vuHxc
```

- 모든 개발/커밋/푸시는 이 브랜치에서만 수행
- `main` 에 직접 push 금지
- PR은 사용자가 명시적으로 요청할 때만 생성
- 네트워크 오류 시 push 재시도: 2초/4초/8초/16초 지수 백오프

```powershell
git push -u origin claude/fix-bot-detection-vuHxc
```

---

## 3. 사용자 환경 및 제약

- Windows + Chrome + PowerShell
- 로컬 경로 (기존 기록): `C:\Users\zetz1\Downloads\KBO-fresh`
- 사용자는 전문 개발자가 아님 → 안내는 한국어, PowerShell 명령은 복사해서 바로 실행 가능한 형태로

**중요 제약 — F12 / DevTools 사용 불가**:
- 사용자가 Chrome 탭에서 F12 를 누르면 티켓링크/PerimeterX 경고 팝업이 떠서 어떤 액션도 취할 수 없다
- DevTools, Console, Network 탭 사용을 안내하지 않는다
- 사용자가 할 수 있는 것: npm 스크립트, Chrome 일반 클릭/이동, `chrome://` 페이지, Chrome 디버깅 포트 실행, PowerShell 명령

---

## 4. 아키텍처 및 저장소 맵

| 파일 | 역할 |
|---|---|
| `index.html` | requestAnimationFrame 정밀 시계, `/api/time` 동기화, `booking-data.json` 기반 예매 버튼, WebAudio T-5분/T-1분/T-0 알림 |
| `api/time.js` | Vercel Function. 티켓링크 Date 헤더 + WorldTimeAPI 동시 폴링, `proxyRtt` 반환 |
| `vercel.json` | Vercel 라우팅 및 보안 헤더 |
| `booking-data.json` | 시계/버튼 UI 가 읽는 결과 파일 |
| `scripts/parse-netlog.js` | **현재 권장 경로.** `chrome://net-export/` 덤프 오프라인 파서 |
| `scripts/scraper.js` | Puppeteer local/ci/attach 모드. 폴백 |
| `scripts/parse-local-html.js` | 저장된 HTML 수동 파서. 최후 폴백 |
| `scripts/discover.js` | attach 모드 진단 도구 |
| `.github/workflows/daily-update.yml` | 매일 09:00 KST cron. 대부분 PerimeterX/IP 제한에 막힘 |

---

## 5. 핵심 사실 (재발견 금지)

### 5.1 `scheduleId` 는 렌더링된 DOM 에 없다
React props 또는 API 응답에만 존재. DOM selector, href 정규식, `data-*` 속성 탐색은 모두 무의미하다.

### 5.2 실제 API
```txt
GET https://mapi.ticketlink.co.kr/mapi/sports/schedules
    ?categoryId=137  (KBO)
    &teamId=57       (삼성)
    &startDate=YYYYMMDD
    &endDate=YYYYMMDD
```

### 5.3 PerimeterX WAF
티켓링크는 PerimeterX 로 보호된다. 자동화 의심 시:
- `ErrorCode:200` HTML 차단 페이지
- 또는 JSON `{"success":false, "code":7200}`
- `_px*` 쿠키 관여

---

## 6. 데이터 수집 전략

### A. NetLog 캡처 — 현재 권장
사용자가 정상 Chrome 에서 티켓링크 방문 후 `chrome://net-export/` 로 저장한 NetLog 를 오프라인 파싱. 브라우저 자동화 없음.
파일: `scripts/parse-netlog.js`

### B. Attach 모드 — 폴백
Chrome 을 디버깅 포트(9222)로 띄우고 사용자가 직접 페이지 방문 → Puppeteer 가 기존 세션에 attach, 응답 수동적 관찰.
명령: `npm run scrape:attach`
주의: `page.evaluate(fetch)` 금지, 탭 강제 navigate 금지. 챌린지 중 비-200/타임아웃 빈번. 안정성 미검증.

### C. 저장 HTML 파싱 — 최후 폴백
사용자가 Ctrl+S 로 저장한 HTML 파싱. `__NEXT_DATA__` 의존.
명령: `npm run parse:html -- <html.html>`

---

## 7. 이미 실패한 방법

같은 실패 경로를 반복하지 않는다.

| # | 시도 | 결과 |
|---|---|---|
| 1 | 시스템 Chrome + Navigator 위장 | `ErrorCode:200` 차단 |
| 2 | Headless + stealth 라이브러리 | 즉시 차단 |
| 3 | Puppeteer 번들 Chromium | 식별 가능성 높아 부적합 |
| 4 | `page.evaluate(fetch)` in-page 호출 | 실행 컨텍스트 파괴 / 탭 강제 navigate |
| 5 | raw CDP `Network.getResponseBody` | 챌린지 응답 body 폐기, `No resource with given identifier` |
| 6 | Attach 모드 `page.on('response')` | 탭은 살아남지만 챌린지 중 비-200/타임아웃 빈번 |
| 7 | DOM 휴리스틱 | `scheduleId` 가 DOM 에 없어 무의미 |
| 8 | GitHub Actions CI | IP/자동화 환경으로 대부분 차단 |

---

## 8. 절대 금지 사항

- F12/DevTools/Console/Network 탭 사용 안내 금지
- DOM 에서 `scheduleId` 찾기 시도 금지
- `page.evaluate()` 내부 `fetch()` 금지
- Headless 또는 번들 Chromium 을 기본 전략으로 사용 금지
- GitHub Actions 에서 티켓링크 스크래핑 성공 기대 금지
- PerimeterX 쿠키 조작/챌린지 우회/CAPTCHA 우회/대기열 우회 코드 작성 금지
- 자동 구매/자동 결제/자동 좌석 선점 구현 금지
- 이미 실패한 전략을 이름만 바꿔 다시 제안 금지
- 사용자 안내는 항상 한국어

---

## 9. NPM Scripts

```powershell
npm run parse:netlog -- <netlog.json>   # 권장. chrome://net-export 덤프 파싱
npm run scrape:attach                   # 사용자 Chrome 디버깅 포트 9222 attach
npm run scrape                          # CI/headless. 대부분 차단
npm run scrape:headful                  # 로컬 headful 디버그
npm run parse:html -- <html.html>       # HTML 수동 저장본 파서
npm run discover                        # attach 모드 DOM/네트워크 검사
npm run serve                           # http://localhost:5173 로컬 프리뷰
```

---

## 10. NetLog 캡처 절차 (사용자 수행)

1. Chrome 주소창: `chrome://net-export/`
2. **`Include raw bytes (...)` 체크 필수** — 응답 본문이 필요
3. `Start Logging to Disk` → 예: `C:\temp\ticketlink.json`
4. 새 탭에서 `https://m.ticketlink.co.kr/sports/137/57` 방문, 경기 카드가 보일 때까지 대기 (필요 시 F5)
5. `chrome://net-export/` 탭으로 돌아가 `Stop Logging`
6. PowerShell:
   ```powershell
   cd C:\Users\zetz1\Downloads\KBO-fresh
   npm run parse:netlog -- "C:\temp\ticketlink.json"
   ```

---

## 11. NetLog Parser Exit Code

| Exit Code | 의미 | 다음 행동 |
|---|---|---|
| `0` | 성공. `booking-data.json` 생성 (`mode: "netlog"`) | 프리뷰 또는 배포 확인 |
| `2` | schedules API 호출이 NetLog 에 없음 | 페이지 방문 여부, 카드 로딩 여부 확인 |
| `3` | 응답 본문 없음 또는 모두 `success:false` | raw bytes 체크 여부, PerimeterX `7200` 진단 확인 |
| `4` | events 배열 없음 | 잘못된 파일 또는 NetLog 포맷 차이 가능성 |

진단 메시지는 한국어로 출력하고, 다음 행동을 명시한다.

---

## 12. booking-data.json 스키마

`games[]` 각 항목:

| 필드 | 의미 |
|---|---|
| `scheduleId` | 경기 일정 ID. 예매 URL 조립에 필요 |
| `productId` | 상품 ID. 예매 URL 조립에 필요 |
| `date` / `time` | 경기 날짜 / 시간 |
| `targetTime` | 예매 오픈 기준 시각. 카운트다운 기준 |
| `bookingOpen` / `preOpen` | 오픈 상태 / 오픈 전 상태 |
| `reserveButtonStatus` | 원본 API 의 예매 버튼 상태 |
| `bookingUrl` | 조립된 예매 URL |
| `venueName` | 경기장 |
| `captchaUse` / `authReinforceYn` / `waitingAvailable` | CAPTCHA / 인증강화 / 대기 가능 |

UI 작업 시: `booking-data.json` 이 비었거나 일부 필드가 없을 때의 폴백 화면을 항상 고려한다.

---

## 13. 현재 최우선 과제

```txt
scripts/parse-netlog.js 가 실제 Chrome NetLog 파일에서 동작하는지 검증
```

현재 합성 fixture 기준 단위 검증만 완료. 실제 사용자 NetLog 포맷에서는 미검증. Chrome 버전별 이벤트 이름, base64 필드 위치, HTTP/2 헤더 형식, body 저장 방식 차이가 있을 수 있다.

이 검증이 끝나야 후속 작업(테스트 정식화, UX 개선, 헬스 체크 등)이 의미가 있다.

---

## 14. 작업 전 체크리스트

```powershell
git status
git branch
git log --oneline -5
node -v
```

현재 브랜치가 `claude/fix-bot-detection-vuHxc` 인지 확인. 변경 중인 파일이 있으면 덮어쓰지 않고 먼저 처리한다.

---

## 15. 사용자가 NetLog 결과를 공유했을 때

1. exit code 확인
2. 한국어 진단 메시지 확인
3. schedules API 요청 존재 여부
4. raw bytes 포함 여부
5. 응답 본문 존재 여부
6. `success:false code:7200` 여부
7. NetLog 포맷 차이 여부
8. 필요 시 `scripts/parse-netlog.js` 수정 + 테스트 추가
9. `booking-data.json` 생성 확인

사용자에게는 전문 용어 던지지 말고 다음 행동을 명확히 안내한다. 예:

```txt
이번 파일에는 schedules API 응답 본문이 없습니다.
가장 가능성 높은 원인은 NetLog 저장 시 Include raw bytes 가 꺼져 있었던 것입니다.
2단계 체크박스를 켠 뒤 다시 캡처해 주세요.
```
