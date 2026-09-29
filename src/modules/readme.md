```
sample/
├── sample.module.ts
├── application/
│   ├── get-sample-by-id.use-case.ts
│   ├── list-samples.use-case.ts
│   └── update-sample-name.use-case.ts
├── domain/
│   ├── sample-error-code.ts
│   ├── entities/
│   │   └── sample-item.entity.ts
│   └── repositories/
│       ├── sample-command.repository.ts
│       └── sample-read.repository.ts
├── infrastructure/
│   └── persistence/
│       └── sample.repository.in-memory.ts
└── presentation/
    ├── controllers/
    │   └── sample.controller.ts
    ├── errors/
    │   └── sample-http-error.mapper.ts
    └── dto/
        ├── update-sample-name.dto.ts
        └── sample-response.dto.ts
```

# Domain

- 시스템이 다루는 핵심 모델과 규칙을 담는다.
- DB, HTTP, 외부 API 같은 기술 세부사항과 분리한다.

예시:

```ts
import { BusinessError } from '@/common/exceptions/business.error';
import { SampleErrorCode } from './sample-error-code';

class SampleItem {
  changeName(newName: string) {
    const normalizedName = newName.trim();

    if (normalizedName.length < 2) {
      throw new BusinessError(
        SampleErrorCode.InvalidName,
        '이름은 공백을 제외하고 2자 이상이어야 합니다.',
      );
    }

    this.name = normalizedName;
  }
}
```

# Application

- 유저 관점의 기능 흐름을 표현한다.
- 권한 확인, 도메인 메서드 호출, 저장 순서를 조합한다.

예시:

```ts
async execute(id: string, newName: string) {
  const sample = await this.sampleReadRepository.findById(id);
  if (!sample) {
    throw new BusinessError(SampleErrorCode.NotFound, '샘플 항목을 찾을 수 없습니다.');
  }

  sample.changeName(newName);
  return this.sampleCommandRepository.save(sample);
}
```

# Infrastructure

- 도메인 인터페이스를 실제 기술로 구현한다.
- 지금 샘플은 메모리 저장소를 사용하지만, 필요하면 PostgreSQL, Redis, Elasticsearch 구현을 여기서 교체한다.

# Presentation

- HTTP 요청을 받고 DTO 검증을 수행한 뒤 적절한 use case를 호출한다.
- 비즈니스 규칙은 직접 담지 않는다.

예시:

```ts
@Patch(':id/name')
async updateName(@Param('id') id: string, @Body() body: UpdateSampleNameDto) {
  const sample = await this.updateSampleNameUseCase.execute(id, body.name);
  return SampleResponseDto.from(sample);
}
```


업무 오류는 `BusinessError`로 전달하고, `presentation/errors`의 mapper가 허용된 코드만 HTTP 상태·공개 메시지로 변환합니다. 내부 설명은 공개 응답에 자동으로 노출하지 않습니다. `SampleModule`은 `HttpErrorModule`을 import하고 `SampleHttpErrorMapper`를 provider로 등록한 뒤, 생성자에서 `HttpErrorMapperRegistry.register()`로 연결합니다. 공통 filter는 등록되지 않은 업무 오류를 일반적인 500 응답으로 처리합니다.

`./scripts/create-module order orders`는 동일한 오류 코드·mapper·등록 구조와 strict TypeScript DTO를 생성합니다. 생성한 모듈을 `AppModule`에 추가하고 실제 업무 코드·메시지를 정한 뒤 API 문서와 테스트를 작성합니다. 새 모듈은 `ORDER_NOT_FOUND`처럼 기능 이름을 포함한 오류 코드를 사용합니다.
