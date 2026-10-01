import type { CookieOptions, RequestHandler } from 'express';

/** 공개 쿠키 읽기 기능. 같은 이름이 중복되면 값이 같더라도 하나를 임의로 선택하지 않는다. */
export function readAuthCookie(
  cookieHeader: string | undefined,
  cookieName: string,
): string | undefined {
  const prefix = `${cookieName}=`;
  const cookies = cookieHeader
    ?.split(';')
    .map((value) => value.trim())
    .filter((value) => value.startsWith(prefix));
  return cookies?.length === 1 ? cookies[0].slice(prefix.length) : undefined;
}

/** 공개 쿠키 설정 기능. 세션을 사용하는 모듈이 같은 환경별 이름과 보안 속성을 사용하게 한다. */
export function authCookies(nodeEnv: string): Readonly<{
  bindingName: string;
  sessionName: string;
  options: CookieOptions;
}> {
  const secure = nodeEnv === 'production';
  return {
    bindingName: secure ? '__Host-cameo_auth_binding' : 'cameo_auth_binding',
    sessionName: secure ? '__Host-cameo_session' : 'cameo_session',
    options: { httpOnly: true, secure, sameSite: 'lax', path: '/' },
  };
}

/** CORS·본문 파싱·요청 제한의 초기 오류에도 인증 응답을 캐시하지 않도록 한다. */
export function createAuthCacheControlMiddleware(
  apiPrefix: string,
): RequestHandler {
  const authPath = `/${apiPrefix ? `${apiPrefix}/` : ''}auth`.toLowerCase();
  return (request, response, next) => {
    const path = request.path.toLowerCase();
    if (path === authPath || path.startsWith(`${authPath}/`)) {
      response.setHeader('Cache-Control', 'no-store');
    }
    next();
  };
}
