import { Injectable } from '@nestjs/common';
import type { BusinessError } from './business.error';

export type HttpErrorMapping = {
  statusCode: number;
  code: string;
  message: string;
  error: string;
};

export interface HttpErrorMapper {
  map(error: BusinessError): HttpErrorMapping | undefined;
}

@Injectable()
export class HttpErrorMapperRegistry {
  private readonly mappers = new Set<HttpErrorMapper>();

  register(mapper: HttpErrorMapper): void {
    this.mappers.add(mapper);
  }

  map(error: BusinessError): HttpErrorMapping | undefined {
    for (const mapper of this.mappers) {
      const mapped = mapper.map(error);
      if (mapped) return mapped;
    }
    return undefined;
  }
}
