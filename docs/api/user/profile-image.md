# 프로필 사진 변경 가이드

필드 정의와 오류 코드는 [Swagger UI](http://localhost:5000/docs)의 Users 항목에서 확인한다. 아래 예제는 기본 API 접두사 `/api`를 사용한다.

서버에 `PROFILE_IMAGE_STORAGE_ROOT`와 `PROFILE_IMAGE_PUBLIC_BASE_URL`이 모두 설정되어 있어야 사용할 수 있다. 사용자가 고른 PNG·JPEG 파일을 변환하지 않고 본문으로 보내며, `Content-Type`은 파일 형식과 같아야 한다.

```js
const response = await fetch('http://localhost:5000/api/users/me/profile-image', {
  method: 'PUT',
  credentials: 'include',
  headers: { 'Content-Type': file.type },
  body: file,
});
const body = await response.json();
if (!response.ok) throw new Error(body.code);
const profile = body.data;
```

성공하면 프론트의 현재 사용자 사진을 `profile.avatarUrl`로 갱신한다. 사진을 바꿀 때마다 주소가 새로 바뀌므로 이전 주소는 더 이상 사용하지 않는다. 응답이 유실되면 `/api/auth/me`로 저장된 사진 주소를 확인한다. 요청 출처는 서버 허용 목록에 등록되어 있어야 한다.
