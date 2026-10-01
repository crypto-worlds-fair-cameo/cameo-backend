import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../../../database/pg.constants';
import { getPgExecutor } from '../../../../database/transaction/pg-executor';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';

/** 계정 식별은 검증을 마친 체인·주소 키로만 하며 지갑 앱 이름은 사용하지 않는다. */
type WalletIdentity = Readonly<{
  chainNamespace: string;
  address: string;
  addressKey: string;
}>;

export type WalletAccount = Readonly<{
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
  status: string;
  walletId: string;
}>;

@Injectable()
export class WalletAccountRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** 아직 지갑 행이 없어도 동일 식별자의 가입을 직렬화한다. 충돌은 대기만 늘린다. */
  async lockIdentity(
    identity: WalletIdentity,
    transaction: TransactionContext,
  ): Promise<void> {
    const key = createHash('sha256')
      .update(JSON.stringify([identity.chainNamespace, identity.addressKey]))
      .digest()
      .readBigInt64BE();
    await getPgExecutor(this.pool, transaction).query(
      'SELECT pg_advisory_xact_lock($1::bigint)',
      [key.toString()],
    );
  }

  /** 지갑 잠금 획득 후 재조회하며, 상태 변경을 기다린 뒤 사용자 행을 잠근다. */
  async findAndLock(
    identity: WalletIdentity,
    transaction: TransactionContext,
  ): Promise<WalletAccount | undefined> {
    const executor = getPgExecutor(this.pool, transaction);
    const wallet = await executor.query<{ id: string; user_id: string }>(
      'SELECT id, user_id FROM user_wallets WHERE chain_namespace = $1 AND address_key = $2 FOR UPDATE',
      [identity.chainNamespace, identity.addressKey],
    );
    if (!wallet.rows[0]) return undefined;
    const user = await executor.query<Omit<WalletAccount, 'walletId'>>(
      'SELECT id, display_name AS "displayName", avatar_url AS "avatarUrl", status FROM users WHERE id = $1 FOR UPDATE',
      [wallet.rows[0].user_id],
    );
    if (!user.rows[0]) throw new Error('Wallet account is missing');
    return { ...user.rows[0], walletId: wallet.rows[0].id };
  }

  /** 세션의 사용자를 잠그고, 대기 중 완료된 계정 상태 변경을 다시 읽는다. */
  async lockUserById(
    userId: string,
    transaction: TransactionContext,
  ): Promise<Omit<WalletAccount, 'walletId'> | undefined> {
    const result = await getPgExecutor(this.pool, transaction).query<
      Omit<WalletAccount, 'walletId'>
    >(
      'SELECT id, display_name AS "displayName", avatar_url AS "avatarUrl", status FROM users WHERE id = $1 FOR UPDATE',
      [userId],
    );
    return result.rows[0];
  }

  /** 새 사용자와 최초 지갑을 같은 트랜잭션에 생성한다. 이름 중복은 허용한다. */
  async create(
    identity: WalletIdentity,
    time: Date,
    transaction: TransactionContext,
  ): Promise<WalletAccount> {
    const executor = getPgExecutor(this.pool, transaction);
    const user = await executor.query<Omit<WalletAccount, 'walletId'>>(
      `INSERT INTO users (display_name, avatar_url, status, created_at, updated_at)
       VALUES ($1, NULL, 'active', $2, $2)
       RETURNING id, display_name AS "displayName", avatar_url AS "avatarUrl", status`,
      [`사용자-${randomBytes(4).toString('hex')}`, time],
    );
    const wallet = await executor.query<{ id: string }>(
      `INSERT INTO user_wallets (user_id, chain_namespace, address, address_key, created_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        user.rows[0].id,
        identity.chainNamespace,
        identity.address,
        identity.addressKey,
        time,
      ],
    );
    return { ...user.rows[0], walletId: wallet.rows[0].id };
  }

  /** 계정 로그인 시각과 이번에 증명한 지갑의 사용 시각만 갱신한다. */
  async recordLogin(
    account: WalletAccount,
    time: Date,
    transaction: TransactionContext,
  ): Promise<void> {
    const executor = getPgExecutor(this.pool, transaction);
    await executor.query(
      'UPDATE users SET updated_at = $2, last_login_at = $2 WHERE id = $1',
      [account.id, time],
    );
    await executor.query(
      'UPDATE user_wallets SET last_used_at = $2 WHERE id = $1',
      [account.walletId, time],
    );
  }

  /** 공개 지갑 목록은 저장 순서가 같도록 생성 시각·ID로 정렬하고 필요한 필드만 읽는다. */
  async listWallets(
    userId: string,
    transaction: TransactionContext,
  ): Promise<
    ReadonlyArray<Readonly<{ chainNamespace: string; address: string }>>
  > {
    const result = await getPgExecutor(this.pool, transaction).query<{
      chainNamespace: string;
      address: string;
    }>(
      `SELECT chain_namespace AS "chainNamespace", address FROM user_wallets
       WHERE user_id = $1 ORDER BY created_at, id`,
      [userId],
    );
    return result.rows;
  }
}
