import type { Response } from 'express';

// The context belongs to this response, not to client-controlled request headers.
export function getRequestId(response: Response): string | undefined {
  const value: unknown = response.locals.requestId;
  return typeof value === 'string' ? value : undefined;
}
