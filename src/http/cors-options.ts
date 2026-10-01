import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '../config/config.type';
import { CorsConfig } from '../config/cors.config';

export const createCorsOptions = (
  configService: ConfigService<AllConfigType>,
): CorsOptions => {
  const corsConfig: CorsConfig = configService.getOrThrow('cors', {
    infer: true,
  });
  const allowAnyOrigin = corsConfig.originList.includes('*');

  return {
    origin: allowAnyOrigin ? '*' : corsConfig.originList,
    methods: corsConfig.methods,
    allowedHeaders: corsConfig.allowedHeaders,
    credentials: corsConfig.credentials,
  };
};
