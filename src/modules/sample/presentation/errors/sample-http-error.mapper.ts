import { Injectable } from '@nestjs/common';
import type { BusinessError } from '../../../../common/exceptions/business.error';
import type {
  HttpErrorMapper,
  HttpErrorMapping,
} from '../../../../common/exceptions/http-error-mapper.registry';
import { SampleErrorCode } from '../../domain/sample-error-code';

@Injectable()
export class SampleHttpErrorMapper implements HttpErrorMapper {
  map(error: BusinessError): HttpErrorMapping | undefined {
    switch (error.code) {
      case SampleErrorCode.NotFound:
        return {
          statusCode: 404,
          code: 'NotFoundException',
          message: '샘플 항목을 찾을 수 없습니다.',
          error: 'Not Found',
        };
      case SampleErrorCode.InvalidName:
        return {
          statusCode: 400,
          code: 'DOMAIN_VALIDATION_ERROR',
          message: '이름은 공백을 제외하고 2자 이상이어야 합니다.',
          error: 'DomainValidationError',
        };
      default:
        return undefined;
    }
  }
}
