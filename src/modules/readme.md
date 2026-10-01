# Sample module

현재 샘플은 독립 HTTP 기능과 공유 `sample-item` 책임을 다음처럼 배치합니다.

```text
sample/
├── sample.module.ts
├── list-samples/
│   ├── list-samples.controller.ts
│   └── list-samples.use-case.ts
├── get-sample-by-id/
│   ├── get-sample-by-id.controller.ts
│   └── get-sample-by-id.use-case.ts
├── update-sample-name/
│   ├── update-sample-name.controller.ts
│   └── update-sample-name.use-case.ts
└── sample-item/
    ├── sample-item.ts
    ├── sample.repository.ts
    └── sample-http.ts
```

각 Controller는 같은 폴더의 UseCase를 호출합니다. 작은 요청 DTO는 Controller 파일에 둡니다. `sample-item`은 여러 기능이 함께 바꿔야 하는 샘플 상태, 메모리 저장소, 응답 필드 선택과 업무 오류 정의를 소유합니다.

`SampleRepository`는 구체 provider 하나로 등록됩니다. 조회 결과와 저장 입력을 복사하고 인스턴스마다 seed를 새로 만들어 외부 변경이나 다른 인스턴스가 내부 상태를 공유하지 않게 합니다. 세 UseCase는 이 provider를 직접 주입받습니다. `SampleModule`은 외부 소비자가 없는 UseCase를 export하지 않습니다.

업무 실패는 루트 `business-error.ts`의 `BusinessError({ code, kind, message })`로 전달합니다. `sample-item.ts`의 `SampleErrors`가 공개 업무 코드, 실패 종류와 공개 가능한 메시지를 정의합니다. UseCase는 `new BusinessError(SampleErrors.NotFound)`처럼 발생 지점에서 오류를 생성합니다. 전역 `HttpExceptionFilter`가 실패 종류를 HTTP 상태로 변환하고 업무 코드와 메시지를 응답에 사용하므로, 기능별 mapper나 모듈 등록은 필요하지 않습니다. `sample-http.ts`는 응답 타입과 필드 선택만 담당합니다.

`./scripts/create-module orders`는 업무 모듈만 생성합니다. `--feature cancel-order`는 한 UseCase를, `--feature get-order --http GET 'orders/:id'`는 UseCase와 Controller를 생성합니다. 기존 module 파일은 자동 수정하지 않으며 CLI가 필요한 등록 코드를 출력합니다.

scaffold는 미구현 `Error`만 포함합니다. 실제 API를 열기 전에 입력, 인증·권한, 응답, 공개 오류를 요구사항으로 구현하고 API 문서와 실행 동작을 확인합니다. 구조 판단은 로컬에 설치된 `nestjs-feature-first-architecture` 스킬을 따릅니다.
