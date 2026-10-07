# API 문서

HTTP API 경로, 요청·응답 필드, 인증 조건과 오류는 서버가 생성하는 Swagger 문서에서 확인한다.

- Swagger UI: `/docs` — 로컬 기본 주소는 <http://localhost:5000/docs>.
- OpenAPI JSON: `/docs-json` — 로컬 기본 주소는 <http://localhost:5000/docs-json>.
- 사용 가이드: [지갑 로그인](auth/login.md).
- 사용 가이드: [닉네임 설정](user/display-name.md).
- 사용 가이드: [메인 캔버스 실시간 연결](canvas/realtime-connection.md)과 [그림 동기화](canvas/drawing-sync.md).
- 사용 가이드: [시즌 생성·조회·참가·취소·종료](seasons/lifecycle.md).
- 프론트 인계: [시즌 참가·실시간 캔버스 2단계](../frontend/season-canvas-phase-two.md).

문서는 API 서버와 함께 제공한다. 배포 후 같은 서버 주소의 `/docs`에서 공개하며, `API_PREFIX` 설정과 관계없이 문서 경로는 유지된다. Swagger에 표시되는 API 경로에는 현재 접두사가 반영된다.

Markdown에는 사용 순서와 클라이언트 예제만 남긴다. 요청·응답 명세와 오류 목록은 중복 작성하지 않는다.
