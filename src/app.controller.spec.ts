import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: (key: string) => {
              const values: Record<string, string> = {
                'app.name': 'Nest React Boilerplate',
                'app.nodeEnv': 'test',
                'app.version': '0.0.1',
              };

              return values[key];
            },
          },
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('health', () => {
    it('should return a health object', () => {
      expect(appController.getHealth().status).toBe('ok');
    });
  });

  describe('system info', () => {
    it('should expose project metadata', () => {
      expect(appController.getSystemInfo()).toEqual({
        name: 'Nest React Boilerplate',
        environment: 'test',
        version: '0.0.1',
      });
    });
  });
});
