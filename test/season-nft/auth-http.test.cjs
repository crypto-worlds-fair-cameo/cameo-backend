require('reflect-metadata');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Global, Module } = require('@nestjs/common');
const { ConfigService } = require('@nestjs/config');
const { NestFactory } = require('@nestjs/core');
const { createSignInMessage } = require('@solana/wallet-standard-util');
const { ed25519 } = require('@noble/curves/ed25519');
const bs58 = require('bs58').default;
const { configureApp } = require('../../dist/app.factory');
const { LoggerModule } = require('../../dist/logging/logger.module');
const { AuthModule } = require('../../dist/modules/auth/auth.module');
const { testDatabaseModule } = require('../canvas/database-fixture.cjs');

const origin = 'http://localhost:5173';

/** 운영 HTTP 미들웨어와 실제 인증 모듈을 격리 DB에 연결한다. */
async function startServer(apiPrefix, network) {
  const database = await testDatabaseModule();
  class TestConfigModule {}
  Global()(TestConfigModule);
  Module({
    providers: [
      {
        provide: ConfigService,
        useValue: new ConfigService({
          app: {
            apiPrefix,
            nodeEnv: 'test',
            trustProxyHops: 0,
            version: 'test',
          },
          cors: {
            originList: [origin],
            credentials: true,
            methods: ['GET', 'POST'],
            allowedHeaders: ['Content-Type'],
          },
          realtime: { maxConnections: 20 },
          canvasSnapshot: { enabled: false },
          seasonNft: { enabled: false, network },
        }),
      },
    ],
    exports: [ConfigService],
  })(TestConfigModule);
  class TestAppModule {}
  Module({
    imports: [TestConfigModule, database.module, LoggerModule, AuthModule],
  })(TestAppModule);
  const app = configureApp(
    await NestFactory.create(TestAppModule, { logger: false }),
  );
  app.useLogger(false);
  await app.listen(0, '127.0.0.1');
  return {
    app,
    url: `${await app.getUrl()}${apiPrefix ? `/${apiPrefix}` : ''}`,
  };
}

/** 브라우저처럼 쿠키 값만 다음 요청에 전달한다. */
function cookies(response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

// NFT 전용 본문 제한이 전역 JSON 파싱을 제거하면 두 배포 경로 모두 로그인에 실패한다.
for (const { apiPrefix, network, chainId } of [
  { apiPrefix: '', network: 'devnet', chainId: 'devnet' },
  { apiPrefix: 'api', network: 'mainnet-beta', chainId: 'mainnet' },
  { apiPrefix: '', network: undefined, chainId: 'mainnet' },
]) {
  test(`HTTP wallet login uses configured chain and parses JSON (network=${network ?? 'unset'}, prefix=${apiPrefix || 'none'})`, async () => {
    const { app, url } = await startServer(apiPrefix, network);
    try {
      const headers = { Origin: origin, 'Content-Type': 'application/json' };
      const challengeResponse = await fetch(`${url}/auth/challenges`, {
        method: 'POST',
        headers,
      });
      assert.equal(challengeResponse.status, 201);
      const { data: challenge } = await challengeResponse.json();
      assert.equal(challenge.signInInput.chainId, chainId);
      const privateKey = ed25519.utils.randomPrivateKey();
      const address = bs58.encode(ed25519.getPublicKey(privateKey));
      const signedMessage = createSignInMessage({
        ...challenge.signInInput,
        address,
      });
      const proof = {
        challengeId: challenge.challengeId,
        address,
        signedMessage: Buffer.from(signedMessage).toString('base64'),
        signature: Buffer.from(
          ed25519.sign(signedMessage, privateKey),
        ).toString('base64'),
      };
      const loginHeaders = { ...headers, Cookie: cookies(challengeResponse) };
      // 유효한 지갑 서명이어도 서버가 발급한 네트워크를 바꿔 서명하면 거절한다.
      const wrongChainMessage = createSignInMessage({
        ...challenge.signInInput,
        address,
        chainId: chainId === 'devnet' ? 'mainnet' : 'devnet',
      });
      const wrongChain = await fetch(`${url}/auth/login`, {
        method: 'POST',
        headers: loginHeaders,
        body: JSON.stringify({
          ...proof,
          signedMessage: Buffer.from(wrongChainMessage).toString('base64'),
          signature: Buffer.from(
            ed25519.sign(wrongChainMessage, privateKey),
          ).toString('base64'),
        }),
      });
      assert.equal(wrongChain.status, 401);
      assert.equal((await wrongChain.json()).code, 'AUTH_SIGNATURE_INVALID');
      const login = await fetch(`${url}/auth/login`, {
        method: 'POST',
        headers: loginHeaders,
        body: JSON.stringify(proof),
      });
      assert.equal(
        login.status,
        200,
        JSON.stringify(await login.clone().json()),
      );
      assert.equal((await login.json()).data.activeWallet.address, address);

      // 발급된 세션이 실제 인증에 사용되고 소모한 챌린지는 재사용되지 않아야 한다.
      const me = await fetch(`${url}/auth/me`, {
        headers: { Cookie: cookies(login) },
      });
      assert.equal(me.status, 200);
      assert.equal((await me.json()).data.activeWallet.address, address);
      const replay = await fetch(`${url}/auth/login`, {
        method: 'POST',
        headers: loginHeaders,
        body: JSON.stringify(proof),
      });
      assert.equal(replay.status, 401);
      assert.equal((await replay.json()).code, 'AUTH_CHALLENGE_INVALID');
    } finally {
      await app.close();
    }
  });
}
