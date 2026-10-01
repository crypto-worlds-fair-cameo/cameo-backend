import { applyDecorators, type Type } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import type { BusinessErrorDefinition } from '../business-error';
import { CommonErrorCodes } from '../errors/common.error-codes';

class HttpErrorResponse {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({ enum: [false] })
  success!: false;

  @ApiProperty({ example: 'BadRequestException' })
  code!: string;

  @ApiProperty({
    example: CommonErrorCodes.BadRequest.message,
    description: '오류에 대한 영어 메시지.',
  })
  message!: string;

  @ApiPropertyOptional({
    description: '응답의 x-request-id와 같은 요청 식별자.',
  })
  traceId?: string;
}

/** 컨트롤러 반환값을 감싸는 ResponseInterceptor의 최종 JSON 구조를 문서화한다. */
export function ApiSuccessResponse(
  model: Type<unknown>,
  options: { status?: number; isArray?: boolean; description?: string } = {},
) {
  const { status = 200, isArray = false, description = '요청 성공.' } = options;
  const data = { $ref: getSchemaPath(model) };
  return applyDecorators(
    ApiExtraModels(model),
    ApiResponse({
      status,
      description,
      schema: {
        type: 'object',
        required: ['statusCode', 'success', 'data'],
        properties: {
          statusCode: { type: 'integer', enum: [status] },
          success: { type: 'boolean', enum: [true] },
          data: isArray ? { type: 'array', items: data } : data,
        },
      },
    }),
  );
}

/** 오류 조건 설명과 실제 영어 응답 예시를 HTTP 상태별로 묶는다. 요청 제한이 없으면 429를 제외한다. */
export function ApiErrorResponses(
  errors: BusinessErrorDefinition[] = [],
  options: { rateLimited?: boolean } = {},
) {
  const definitions = [
    CommonErrorCodes.BadRequest,
    CommonErrorCodes.PayloadTooLarge,
    CommonErrorCodes.UnsupportedMediaType,
    ...(options.rateLimited === false
      ? []
      : [CommonErrorCodes.TooManyRequests]),
    CommonErrorCodes.InternalServerError,
    ...errors,
  ];
  const byStatus = new Map<number, BusinessErrorDefinition[]>();
  for (const definition of definitions) {
    const group = byStatus.get(definition.statusCode) ?? [];
    group.push(definition);
    byStatus.set(definition.statusCode, group);
  }

  // 문서 본문은 오류 조건 설명을, JSON 예시는 실제 응답에 쓰는 영어 메시지를 사용한다.
  return applyDecorators(
    ApiExtraModels(HttpErrorResponse),
    ...Array.from(byStatus, ([status, group]) =>
      ApiResponse({
        status,
        description: group
          .map(({ code, description }) => `${code}: ${description}`)
          .join('\n\n'),
        headers:
          status === 429
            ? {
                'Retry-After': {
                  description: '다시 요청하기까지 기다릴 초.',
                  schema: { type: 'integer' },
                },
              }
            : undefined,
        content: {
          'application/json': {
            schema: {
              allOf: [
                { $ref: getSchemaPath(HttpErrorResponse) },
                {
                  properties: {
                    statusCode: { type: 'integer', enum: [status] },
                    code: {
                      type: 'string',
                      enum: group.map(({ code }) => code),
                    },
                  },
                },
              ],
            },
            examples: Object.fromEntries(
              group.map(({ code, message }) => [
                code,
                {
                  value: { statusCode: status, success: false, code, message },
                },
              ]),
            ),
          },
        },
      }),
    ),
  );
}
