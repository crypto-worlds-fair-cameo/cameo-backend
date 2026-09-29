import { Global, Module } from '@nestjs/common';
import { PgModule } from './postgres/pg.module';

@Global()
@Module({
  imports: [
    PgModule,
    // 나중에 다른 DB 붙이면 여기만 추가하면 됨
    // MysqlModule,
    // MongoModule,
    // RedisModule,
  ],
  exports: [
    PgModule,
    // 다른 모듈도 export
  ],
})
export class DatabaseModule {}
