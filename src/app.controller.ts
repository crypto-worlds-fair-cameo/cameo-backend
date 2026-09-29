import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { SYSTEM_ROUTES } from './common/http/system-routes';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get(SYSTEM_ROUTES.health)
  getHealth() {
    return this.appService.getHealth();
  }

  @Get(SYSTEM_ROUTES.ready)
  getReadiness() {
    return this.appService.getReadiness();
  }

  @Get('system/info')
  getSystemInfo() {
    return this.appService.getSystemInfo();
  }
}
