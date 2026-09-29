import { BusinessError } from '../../../../common/exceptions/business.error';
import { HttpErrorMapperRegistry } from '../../../../common/exceptions/http-error-mapper.registry';
import { SampleErrorCode } from '../../domain/sample-error-code';
import { SampleHttpErrorMapper } from './sample-http-error.mapper';

describe('Sample HTTP error mapping', () => {
  const registry = new HttpErrorMapperRegistry();
  registry.register(new SampleHttpErrorMapper());

  it('preserves the public missing-item contract without exposing internal descriptions', () => {
    expect(
      registry.map(
        new BusinessError(SampleErrorCode.NotFound, 'private detail'),
      ),
    ).toEqual({
      statusCode: 404,
      code: 'NotFoundException',
      message: '샘플 항목을 찾을 수 없습니다.',
      error: 'Not Found',
    });
  });

  it('preserves domain validation contract and refuses unknown business codes', () => {
    expect(
      registry.map(
        new BusinessError(SampleErrorCode.InvalidName, 'private detail'),
      ),
    ).toMatchObject({
      statusCode: 400,
      code: 'DOMAIN_VALIDATION_ERROR',
      error: 'DomainValidationError',
    });
    expect(
      registry.map(new BusinessError('UNKNOWN', 'secret')),
    ).toBeUndefined();
  });
});
