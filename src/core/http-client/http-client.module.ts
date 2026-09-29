import { Module } from '@nestjs/common';
import { HttpModule as AxiosModule } from '@nestjs/axios';
import { HttpClientService } from './http-client.service';

@Module({
  imports: [
    AxiosModule.registerAsync({
      useFactory: () => ({
        timeout: 5000,
        maxRedirects: 5,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    }),
  ],
  providers: [HttpClientService],
  exports: [AxiosModule, HttpClientService],
})
export class HttpClientModule {}
