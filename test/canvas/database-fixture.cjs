const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, readdirSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { after } = require('node:test');
const { randomUUID } = require('node:crypto');
const { Global, Module } = require('@nestjs/common');
const { Pool } = require('pg');
const { PG_POOL } = require('../../dist/database/pg.constants');
const {
  TransactionRunner,
} = require('../../dist/database/transaction/transaction-runner');
const {
  PgTransactionRunner,
} = require('../../dist/database/transaction/pg-transaction.runner');

let directory;
let binaries;
let pool;
let started = false;
let adminPool;
let temporaryDatabase;

/** 운영 DB와 분리한 임시 PostgreSQL에서 실제 세션 인증을 검증한다. */
async function testDatabaseModule(managed = false) {
  if (!pool) {
    // 명시한 로컬 서버에서는 별도 임시 DB만 생성해 개발 데이터를 건드리지 않는다.
    if (process.env.PG_TEST_ADMIN_URL) {
      adminPool = new Pool({ connectionString: process.env.PG_TEST_ADMIN_URL });
      temporaryDatabase = `cameo_test_${randomUUID().replaceAll('-', '')}`;
      await adminPool.query(`CREATE DATABASE "${temporaryDatabase}"`);
      const testUrl = new URL(process.env.PG_TEST_ADMIN_URL);
      testUrl.pathname = `/${temporaryDatabase}`;
      pool = new Pool({ connectionString: testUrl.toString(), max: 10 });
    } else {
      binaries =
        process.env.PG_TEST_BINDIR ||
        execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
      directory = mkdtempSync('/tmp/cameo-realtime-');
      execFileSync(
        join(binaries, 'initdb'),
        [
          '-D',
          join(directory, 'data'),
          '-A',
          'trust',
          '-U',
          'postgres',
          '--no-locale',
        ],
        { stdio: 'pipe' },
      );
      execFileSync(
        join(binaries, 'pg_ctl'),
        [
          '-D',
          join(directory, 'data'),
          '-l',
          join(directory, 'postgres.log'),
          '-o',
          `-k ${directory} -c listen_addresses=''`,
          '-w',
          'start',
        ],
        { stdio: 'pipe' },
      );
      started = true;
      pool = new Pool({
        host: directory,
        user: 'postgres',
        database: 'postgres',
        max: 10,
      });
    }
    const migrations = resolve(__dirname, '../../db/migrations');
    for (const name of readdirSync(migrations)
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      await pool.query(readFileSync(join(migrations, name), 'utf8'));
    }
  }
  // 실제 DatabaseModule의 종료 순서도 검증할 수 있게 별도 pool만 앱이 소유하게 한다.
  const applicationPool = managed ? new Pool({ ...pool.options }) : pool;
  const { DatabaseModule } = require('../../dist/database/database.module');
  class TestDatabaseModule {}
  Global()(TestDatabaseModule);
  Module({
    providers: [
      { provide: PG_POOL, useValue: applicationPool },
      ...(managed ? [DatabaseModule] : []),
      PgTransactionRunner,
      { provide: TransactionRunner, useExisting: PgTransactionRunner },
    ],
    exports: [PG_POOL, TransactionRunner],
  })(TestDatabaseModule);
  return { module: TestDatabaseModule, pool: applicationPool };
}

after(async () => {
  await pool?.end();
  if (adminPool) {
    try {
      if (temporaryDatabase)
        await adminPool.query(`DROP DATABASE "${temporaryDatabase}"`);
    } finally {
      await adminPool.end();
    }
  }
  if (directory) {
    try {
      if (started)
        execFileSync(
          join(binaries, 'pg_ctl'),
          ['-D', join(directory, 'data'), '-m', 'fast', '-w', 'stop'],
          { stdio: 'pipe' },
        );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

module.exports = { testDatabaseModule };
