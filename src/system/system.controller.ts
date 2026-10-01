import { Controller, Get } from '@nestjs/common';
import { SystemService } from './system.service';
import { SYSTEM_ROUTES } from './system-routes';

@Controller()
export class SystemController {
  constructor(private readonly systemService: SystemService) {}

  @Get(SYSTEM_ROUTES.health)
  getHealth() {
    return this.systemService.getHealth();
  }

  @Get(SYSTEM_ROUTES.ready)
  getReadiness() {
    return this.systemService.getReadiness();
  }

  @Get('system/info')
  getSystemInfo() {
    return this.systemService.getSystemInfo();
  }
}
