import { Global, Module } from '@nestjs/common';
import { HttpErrorMapperRegistry } from './http-error-mapper.registry';

@Global()
@Module({
  providers: [HttpErrorMapperRegistry],
  exports: [HttpErrorMapperRegistry],
})
export class HttpErrorModule {}
