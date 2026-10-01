import type { RequestHandler } from 'express';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';

/** 로그인 본문 파싱 전에 매체 타입·charset 실패를 공개 400 계약으로 통일한다. */
export function createLoginMediaTypeMiddleware(
  apiPrefix: string,
): RequestHandler {
  const path = `/${apiPrefix ? `${apiPrefix}/` : ''}auth/login`.toLowerCase();
  return (request, _response, next) => {
    if (
      request.method !== 'POST' ||
      request.path.toLowerCase().replace(/\/$/, '') !== path
    ) {
      next();
      return;
    }

    const [mediaType, ...parameters] =
      request.get('Content-Type')?.split(';') ?? [];
    let valid = mediaType?.trim().toLowerCase() === 'application/json';
    for (const parameter of parameters) {
      const match =
        /^\s*([\w!#$%&'*+.^`|~-]+)\s*=\s*(?:([\w!#$%&'*+.^`|~-]+)|"([^"\\]*)")\s*$/.exec(
          parameter,
        );
      if (!match) valid = false;
      else if (match[1].toLowerCase() === 'charset') {
        valid &&= (match[2] ?? match[3]).toLowerCase() === 'utf-8';
      }
    }
    next(valid ? undefined : new BusinessError(ErrorCodes.BadRequest));
  };
}
