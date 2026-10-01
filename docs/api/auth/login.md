# 지갑 로그인 가이드

필드 정의와 오류 코드는 [Swagger UI](http://localhost:5000/docs)의 Auth 항목에서 확인한다. 아래 예제는 기본 API 접두사 `/api`를 사용한다.

1. `POST /api/auth/challenges`로 서명 입력을 받는다. 서버가 설정한 연결 쿠키를 유지한다.
2. 응답의 `signInInput`을 지갑의 `solana:signIn`에 그대로 전달한다.
3. 지갑이 반환한 원본 메시지와 서명을 표준 Base64로 인코딩해 `POST /api/auth/login`에 제출한다.
4. 이후 `GET /api/auth/me`로 로그인 상태를 확인하고 `POST /api/auth/logout`으로 로그아웃한다.

브라우저 요청은 `credentials: 'include'`를 사용한다. 인증 POST는 요청 출처가 서버의 허용 목록에 등록되어 있어야 한다. 챌린지는 5분 동안 한 번만 사용할 수 있다.

## 브라우저 예제

`wallet`은 Wallet Standard로 선택한 `solana:signIn` 지원 지갑이다. API 서버 주소가 다르면 `apiBase`를 해당 주소로 변경한다.

```js
const apiBase = 'http://localhost:5000/api';

async function request(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    credentials: 'include',
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.code);
  return body.data;
}

const challenge = await request('/auth/challenges', { method: 'POST' });
const [output] = await wallet.features['solana:signIn'].signIn(
  challenge.signInInput,
);
const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));

const login = await request('/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    challengeId: challenge.challengeId,
    address: output.account.address,
    signedMessage: toBase64(output.signedMessage),
    signature: toBase64(output.signature),
  }),
});

const current = await request('/auth/me');
await request('/auth/logout', { method: 'POST' });
```

메시지를 직접 재구성하거나 쿠키 값을 읽어서 전달하지 않는다. 로그인 응답이 유실되면 `/auth/me`로 제출한 지갑의 로그인 여부를 확인한다. 다시 로그인할 때는 새 챌린지와 서명을 사용한다.

Swagger의 실행 기능에도 출처·쿠키 규칙이 적용된다. `Origin`과 `Cookie`는 브라우저가 관리하므로 입력창에서 임의 설정할 수 없다. 지갑 서명은 위 클라이언트 흐름에서 얻는다.
