import type { RequestHandler } from 'express';

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
