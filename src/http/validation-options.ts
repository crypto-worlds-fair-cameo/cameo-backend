import { ValidationPipeOptions } from '@nestjs/common';

const validationOptions: ValidationPipeOptions = {
  transform: true, // 요청값을 자동으로 DTO 타입에 맞게 변환
  whitelist: true, // DTO에 정의되지 않은 속성 제거
  forbidNonWhitelisted: false, // 추가 필드는 거절하지 않고 제거한 뒤 허용 필드만 검증
  transformOptions: { enableImplicitConversion: false }, // 필요한 변환은 각 DTO에서 명시
};

export default validationOptions;
