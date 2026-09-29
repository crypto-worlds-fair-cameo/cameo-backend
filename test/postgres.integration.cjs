// Run against a dedicated disposable database after npm run build.
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { PgTransactionRunner } = require('../dist/infra/database/postgres/pg-transaction.runner');
const { getPgExecutor } = require('../dist/infra/database/postgres/pg-executor');
const { PgReadinessService } = require('../dist/infra/database/postgres/pg-readiness.service');

async function main() {
  assert(process.env.TEST_DATABASE_URL, 'Set TEST_DATABASE_URL to a disposable database');
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1, connectionTimeoutMillis: 2000, statement_timeout: 1000 });
  try {
    await pool.query('create temporary table boiler_transaction_test (id integer primary key)');
    const runner = new PgTransactionRunner(pool);
    let expired;
    await runner.run(async context => {
      expired = context;
      await getPgExecutor(pool, context).query('insert into boiler_transaction_test values (1)');
      assert.equal((await getPgExecutor(pool, context).query('select count(*)::int as count from boiler_transaction_test')).rows[0].count, 1);
    });
    assert.throws(() => getPgExecutor(pool, expired), /transaction/i);
    assert.equal((await pool.query('select count(*)::int as count from boiler_transaction_test')).rows[0].count, 1);
    await assert.rejects(runner.run(async context => {
      await getPgExecutor(pool, context).query('insert into boiler_transaction_test values (2)');
      throw new Error('rollback requested');
    }), /rollback requested/);
    assert.equal((await pool.query('select count(*)::int as count from boiler_transaction_test')).rows[0].count, 1);
    await assert.rejects(runner.run(async context => {
      await getPgExecutor(pool, context).query('select pg_sleep(2)');
    }), /statement timeout/);
    await new PgReadinessService(pool).check();
    assert.equal(pool.waitingCount, 0);
    const { Test } = require('@nestjs/testing');
    const { AppModule } = require('../dist/app.module');
    const { DatabaseModule } = require('../dist/infra/database/database.module');
    const { PG_POOL } = require('../dist/infra/database/postgres/pg.constants');
    const { AppService } = require('../dist/app.service');
    const { configureApp } = require('../dist/app.factory');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, DatabaseModule] }).overrideProvider(PG_POOL).useValue(pool).compile();
    const app = configureApp(moduleRef.createNestApplication());
    await app.init();
    assert.deepEqual(await app.get(AppService).getReadiness(), {status:'ok', database:'up'});
    await app.close();
    assert.equal(pool.ended, true);
    console.log('PostgreSQL integration passed: commit, rollback, timeout recovery, expired context, readiness, released connection.');
  } finally {
    if (!pool.ended) await pool.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
