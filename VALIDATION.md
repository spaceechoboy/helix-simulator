# 검증 기록 — 2026-10-26 KST

## 판정
조건부 시뮬레이터로 게시 가능. Claude Opus 5.5 최종 변경분 검토: Approved, no remaining blockers. 절대적 완전성 또는 실거래 수익 보장이 아니다.

## 수정
- 최소 운전자금 탐색에 기존 AiLGNS 원가와 FIXED Polygon 가스 포함; 모든 후보의 총 초기자본이 예산 이내인지 확인.
- Anubis LGNS 직접 소각은 진입 편입 지연 사용. 정산 후 소각의 0일 지연은 명시적으로 거부.
- 실시간 조회를 최초 계산 전 및 60초마다 자동 반영. 1초마다 만료 확인. 최신 조회 실패·5분 경과·필수값 누락 시 결과·추천·내보내기 차단. 저장 TWAP 대체 없음.
- 선택 정보의 정상 null은 유지. 실패한 코드 지문을 구현 변경으로 오인하지 않음. 프로토콜 조회 전체 제한 10초.
- 관측 코드 지문을 기준 블록 17,409,730으로 저장하여 재접속 시에도 대조. 동작·보안 인증이 아니다.
- KST 날짜 변경 반영, 과거 날짜의 현재 기준 계산 거부, 탭 복귀·만료 시 정책 보존.
- 실제 정산일 표기, 끊긴 근거 링크 제거, 지문 객체 표시 오류 수정.

## 실제 실행 및 출력
- `node --test tests/*.test.js`: tests 161 / pass 161 / fail 0 / exit 0.
- `node build.mjs`: dist/index.html 466318 bytes.
- `shasum -a 256 dist/index.html docs/index.html`: 두 파일 모두 `8785f44b696be8616f8f26fb459f62f79c7cf92a8d363ee7fe73c53fd39e1e3a`.
- `git diff --check`: 출력 없음 / exit 0.
- 최신 RPC/API 직접 실행: 2026-10-25T15:41:01.190Z UTC / 블록 17409821 / FINGERPRINT_MATCH / gate errors [] / calculation errors [] / completed true / invariantFails 0.
- 시장 6개 항목: AiLGNS, Anubis LGNS, Polygon LGNS, DAI/USDT, Upbit USDT/KRW, 파생 DAI/KRW 모두 OK.
- 추가 독립 스크립트: DAI·KRW·LGNS × 금액 10/1000/100000 × 6개월/1년/2년/3년 = 36개 장부. 음수 잔액 없음, W=인출 합계, net=W-I, 외부 추가입금0, 보존식 위반0 확인. 비교 스크립트는 별도 명시 조건이며 UI 기본값 수익률과 혼용하지 않음.
- 4개 기간의 단일 전환일 전수 탐색: 승자 전체 장부 재검산 일치, 기준 현금화 정책보다 ROI 낮지 않음.
- 브라우저: 최초 자동 LIVE 반영, 원화 쉼표/환산, LGNS 고정 원금, 6개월/1년 최적화, 음수 입력 차단·복구, 390px 가로 넘침 없음, 정상 페이지 콘솔 오류 없음.
- 별도 루프백 CSP(connect-src none) 실패 시험: 저장 결과·그래프·최적화 표시 차단, 계산 보류 확인.

## 교차 검토
Codex: 구현 일부, 실제 테스트·RPC/API·브라우저 검증. Claude Opus 5.5: 엔진 수정 및 독립 코드 검토, 재검토, 최종 변경분 승인. Claude는 Read/Grep/Glob 중심 검토이며 테스트 실행을 주장하지 않았다. 실효 모델: claude-opus-5-5. effort: CLI 기본값, 별도 override 없음. 이 수정 턴 Claude 호출의 도구 보고 API 정가 환산 합계 약 $3.7083; 실제 구독 청구액이 아니다. Codex 비용은 확인 불가.

## 남아 있는 검증 경계
- SUSPECT: unnamed annualRate getter의 일반 지갑에 대한 의미, 실제 터빈 산출·즉시/잠금 분배와 거래 순서, 개인별 편입·배출은 실거래 표본 대조 미완료.
- 미래 가격·배출률·수수료 유지, 풀 수수료 30bps, 가스 단가·자금 자동 보충·지연은 명시적 모형 가정. 현재 spot은 실제 체결 견적이 아니다.
- LGNS 원금 1DAI 고정과 소각 한도 제외는 사용자 지정 비교 가정. 현재 소각 가능이나 2DAI 현금 보장이 아니다.
- 최대 효율은 선택 기간의 단일 전환일 후보 중 최대 현금 ROI이며 모든 가능한 전략의 전역 최적을 증명하지 않는다.
- 최신값은 해당 조회 시각의 관측이다. 이후 체인·API 변경 및 장애는 새 조회와 신선도 검사로 처리하며 미래 수익을 확정하지 않는다.
