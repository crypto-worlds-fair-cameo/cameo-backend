import { createApp, startApp } from './app.factory';

async function bootstrap() {
  const app = await createApp();
  await startApp(app);
}

void bootstrap();
