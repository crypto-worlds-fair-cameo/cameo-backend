# 닉네임 설정 가이드

필드 정의와 오류 코드는 [Swagger UI](http://localhost:5000/docs)의 Users 항목에서 확인한다. 아래 예제는 기본 API 접두사 `/api`를 사용한다.

최초 가입 시 닉네임은 자동 생성된다. 프론트에서 닉네임 변경 요청을 받으면 로그인 세션 쿠키를 유지한 채 아래 요청으로 저장한다.

```js
const response = await fetch('http://localhost:5000/api/users/me/display-name', {
  method: 'PATCH',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ displayName: '카메오' }),
});
const body = await response.json();
if (!response.ok) throw new Error(body.code);
const profile = body.data;
```

성공하면 프론트의 현재 사용자 닉네임을 `profile.displayName`으로 갱신한다. 응답이 유실되면 `/api/auth/me`로 저장된 닉네임을 확인한다. 요청 출처는 서버 허용 목록에 등록되어 있어야 한다.
