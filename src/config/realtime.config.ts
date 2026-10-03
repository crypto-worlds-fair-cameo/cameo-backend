import { registerAs } from '@nestjs/config';

export type RealtimeConfig = {
  maxConnections: number;
};

export default registerAs('realtime', () => {
  const maxConnections = Number(process.env.REALTIME_MAX_CONNECTIONS ?? 5000);
  if (!Number.isSafeInteger(maxConnections) || maxConnections <= 0) {
    throw new Error(
      'REALTIME_MAX_CONNECTIONS must be a positive safe integer.',
    );
  }

  return { maxConnections };
});
