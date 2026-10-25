# 공식 CI 적용 — 2026-10-26

- 기준: 309fc55. 사용자 승인: 공식 로고·심볼을 계산기에 사용하고 공개 페이지 반영.
- 대상: 공식 symbol-anubis.webp 원본을 헤더와 파비콘에 동일 적용. 제품명·라임 종결 블록 유지. 계산 엔진·시세·전략 코드 변경 없음.
- 원본 SHA256: 5aea92705efa787549a3ce2210b43f5577f52df57e985c8f08b9cb3881043bd8. 복사본 바이트 일치.
- 출처: 공식 앱 TFAwakeOrigin public/assets/symbol-anubis.webp와 Header.tsx의 30px lockup. 자산은 사용자 승인 범위로만 사용하며 오픈소스 재사용 허가를 별도로 부여하지 않음.
- 비공개 폰트 복사는 자동 승인 검토에서 거부되어 제외. 기존 폰트 유지; 공식 브랜드 서체까지 동일하다는 주장은 하지 않음.

## 역할과 수정 루프
- GPT: 구현·실화면·회귀·배포 검증.
- Claude Opus 5.5: 독립 브랜드 검토, PASS(실행 검증 제외), API 정가 환산 $0.5465888, CLI 기본 effort. 구형 파비콘과 헤더 심볼 불일치 지적을 반영하여 동일 공식 심볼로 통일.
- Gemini gemini-3.8-flash: 적대 검증 실행 시도. CLI가 서비스의 UNSUPPORTED_CLIENT / IneligibleTierError로 종료1. 리뷰 실행되지 않았으며 통과로 처리하지 않음.
- 독립 GPT 검증자: Gemini 실패 후 적대 검토 대체. 정적 변경에서 결함 없음, build.mjs 문법 검사 종료0. UI 실측은 주 작업자가 별도로 수행.

## 실제 검증
- `node --test tests/*.test.js`: 병렬 170 PASS / 1 FAIL. data.test.js:223의 모의 RPC 지문 검사(50ms 제한)가 PARTIAL을 반환. 이번 변경은 데이터 코드와 무관하며 원인을 확정하지 않음.
- `node --test --test-concurrency=1 tests/*.test.js`: 171 PASS / 0 FAIL. 제품·테스트 코드 변경 없이 직렬 검증.
- `node build.mjs`: 527620 bytes, SHA256 bafc43ae6e50c9ba232175f5c8fcfdef7207f54af65bb4afd929316563d9977d.
- 브라우저 320px: header44px, 심볼30×30px, 원본288px, complete=true, scrollWidth320. 어두운 배경 위 투명 심볼 확인.
- 브라우저 390px: scrollWidth390, 파비콘 URI와 헤더 심볼 URI 일치. 1440px 실화면 확인. 뷰포트 변경은 검증 후 해제.
- 이미지 data URI 포함으로 외부 호스트·GitHub Pages 상대경로 의존 없음. 계산 입력·결과 표시 기존 흐름 보존.

SUSPECT: Gemini 독립 검증 미실행, 병렬 모의 RPC 테스트의 시간 민감성. 금융 계산의 실거래 검증 경계는 VALIDATION.md 유지.
