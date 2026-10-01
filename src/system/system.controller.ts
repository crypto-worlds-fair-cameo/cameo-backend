import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { CommonErrorCodes } from '../errors/common.error-codes';
import {
  ApiErrorResponses,
  ApiSuccessResponse,
} from '../http/swagger-response';
import { SystemService } from './system.service';
import { SYSTEM_ROUTES } from './system-routes';

class HealthResponse {
  @ApiProperty({ enum: ['ok'] })
  status!: string;

  @ApiProperty({ format: 'date-time' })
  timestamp!: string;
}

class ReadinessResponse {
  @ApiProperty({ enum: ['ok'] })
  status!: string;

  @ApiProperty({ enum: ['up', 'disabled'] })
  database!: string;
}

class SystemInfoResponse {
  @ApiProperty({ example: 'Cameo' })
  name!: string;

  @ApiProperty({ example: '0.0.1' })
  version!: string;

  @ApiProperty({ example: 'development' })
  environment!: string;
}

@ApiTags('System')
@Controller()
export class SystemController {
  constructor(private readonly systemService: SystemService) {}

  @Get(SYSTEM_ROUTES.health)
  @ApiOperation({ summary: '서버 실행 상태 조회' })
  @ApiSuccessResponse(HealthResponse)
  @ApiErrorResponses([], { rateLimited: false })
  getHealth() {
    return this.systemService.getHealth();
  }

  @Get(SYSTEM_ROUTES.ready)
  @ApiOperation({ summary: 'DB 연결 상태 조회' })
  @ApiSuccessResponse(ReadinessResponse)
  @ApiErrorResponses(
    [{ ...CommonErrorCodes.InternalServerError, statusCode: 503 }],
    { rateLimited: false },
  )
  getReadiness() {
    return this.systemService.getReadiness();
  }

  @Get('system/info')
  @ApiOperation({ summary: '서버 정보 조회' })
  @ApiSuccessResponse(SystemInfoResponse)
  @ApiErrorResponses()
  getSystemInfo() {
    return this.systemService.getSystemInfo();
  }
}
