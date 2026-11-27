# 너울 · 동아리연합회 통합 인프라

Vite + Firebase(Firestore · Auth · Storage · Hosting · Functions · FCM).

```
npm install
npm run dev       # 개발 서버
npm run build     # dist/ 로 빌드 (main 에 푸시하면 GitHub Actions 가 배포)
```

## 폴더

```
*.html                 페이지 (vite.config.js 의 input 에 등록해야 빌드됨)
public/                그대로 복사되는 파일 (로고, 배경, 아이콘, 서비스워커, manifest)
functions/             Cloud Functions — 푸시 알림 발송
docs/PUSH_SETUP.md     푸시 · 앱 설치 설정 방법
src/
  styles/
    site.css           모든 페이지가 먼저 불러옴 = legacy → neoul/core → neoul/components
    legacy.css         예전 스타일 (구조용). 새 모양은 여기 말고 neoul/ 에서 덮어쓴다
    legacy-calendar.css
    motion.css         페이지 전환(View Transitions) · 등장 · 버튼 반응 애니메이션
    neoul/             E안 디자인
      core.css         색 · 그림자 토큰, 위 메뉴 · 아래 탭, 페이지 머리
      components.css   카드 · 버튼 · 입력칸 · 대화상자 · 칩 공통
      home.css budget.css resources.css calendar.css notices.css
      board.css (동아리 활동 · 과제 · 글 상세 · 행사 상세)
      events.css (연합회 행사) account.css (로그인 · 회원가입) admin.css
  ui/shell.js          위 메뉴 · 아래 탭 · 알림 배지 (pageGuard 가 자동으로 붙임)
  pageGuard.js         로그인 확인 + 공통 틀 붙이기
  auth/ budget/ activity/ resources/ calendar/ eventPromo/ unionEvents/
  notices/ notifications/ push/ admin/   각 기능
```

## 예산 신청 종류

- **일반 신청**: 토요일 예산 소위원회 회의에서 심의. 금요일 18시까지 낸 신청이 그 주 토요일 안건.
- **긴급 신청**: 연합회장 · 예산 소위원장이 바로 승인. 규칙은 `src/budget/budgetPolicy.js`
  (총액 10만 원 이하 · 다음 회의 전에 필요한 경우만 · 사유 20자 이상 · 동아리당 한 달 1번 ·
  승인 사유 필수 · 자기 동아리는 반려만 가능 · 다음 회의 사후 보고).
  숫자를 바꾸면 `firestore.rules` 의 긴급 예산 부분도 같이 바꿀 것.
- **심사 비밀번호** (예산관리소위원회 공통): 승인 · 반려 전에 관리자 화면에서 넣고 '심사 시작' (12시간 유지).
  처음 비밀번호는 규칙에 해시로 들어 있고, 관리자 화면 '심사 비밀번호 변경'에서 바꿀 수 있다.

## 새 페이지 만들 때

1. `body class="nu"`, 머리는 `<header class="nu-pagehead">` (다른 페이지에서 복사)
2. 페이지 JS 맨 위: `import "../styles/site.css";` 다음에 전용 `neoul/xxx.css`
3. `main` 에 `class="nu-wrap nu-enter"` 를 주면 등장 애니메이션이 붙는다
4. `vite.config.js` input 에 추가

## 과제 첨부 · 자동승인 · 정렬

- **과제 수정 · 첨부**: 과제 작성자와 관리자만 수정한다 (`firestore.rules` 의 `clubAssignments` 수정 규칙).
  첨부는 과제당 최대 10개, 파일당 30MB. 개수는 `firestore.rules`, 용량은 `storage.rules`
  (`assignmentFiles/...`)가 막는다. 두 규칙 파일 모두 배포해야 한다.
- **자동승인**: 관리자 화면 → 자원 예약 관리 → '신청 항목별 자동승인'. `settings/reservationAutoApproval`
  문서에 켜진 항목만 담긴다. 문서가 없거나 꺼져 있으면 모든 신청은 승인 대기이고, 규칙이 같은 설정을
  다시 확인하므로 클라이언트가 `approved` 로 만들어 보낼 수 없다.
  자동승인 항목 신청은 '승인 대기 + `autoApproveScheduled`'로 저장되고 **접수 시각 + 5분**에 승인된다.
  (그 사이 소위원장이 직접 승인 · 반려 가능) 예약 · 관리자 화면을 연 브라우저와 Cloud Functions
  `autoApproveReservations`(1분마다)가 승인으로 바꾸며, 규칙이 서버 시각으로 5분 경과를 확인한다.
  함수는 `npx firebase-tools deploy --only functions` 로 따로 배포해야 한다.
- **부분 처리 완료**: 연합회장 확인을 마친 예산 신청에서 일부 품목만 구매했을 때 [부분 처리 완료]로
  그 품목에 `processed: true` 를 남긴다. 신청서 상태는 `confirmed` 그대로이고, 처리된 품목 금액은
  [처리 완료 예산]에 더해진다. 남은 품목까지 끝나면 [처리 완료]로 `completed` 가 된다.
- **제출글 수정**: 본인 제출글은 제출 기간 안에서 고칠 수 있다. 과제가 '마감 후 수정 허용'이면 마감 뒤에도 된다.
  (`/activity/submit/<과제 번호>?edit=1`, 규칙의 `canEditSubmissionNow`)
- **정렬**: `src/ui/listSort.js`. 과제 · 공지 · 제출 목록 모두 기본 최신순이고, 고른 방식은 브라우저에 저장된다.
- 저장소 규칙은 `firebase deploy --only storage --config firebase.firestore.json` 으로 배포한다.
  (GitHub Actions 의 `Deploy Firestore rules` 워크플로가 `main` 푸시 때 같이 배포한다.)
