const { createHash } = require('node:crypto');
const bs58 = require('bs58').default;

/** 테스트 사용자마다 유효한 Solana 지갑을 만들고 해당 지갑에 고정한 세션을 저장한다. */
async function insertWalletSession(pool, userId, token) {
  const address = bs58.encode(
    createHash('sha256').update(`wallet:${userId}`).digest(),
  );
  const wallet = await pool.query(
    `INSERT INTO user_wallets
       (user_id, chain_namespace, address, address_key)
     VALUES ($1, 'solana', $2, $2)
     RETURNING id`,
    [userId, address],
  );
  await pool.query(
    `INSERT INTO auth_sessions (user_id, wallet_account_id, token_hash)
     VALUES ($1, $2, $3)`,
    [
      userId,
      wallet.rows[0].id,
      createHash('sha256').update(token).digest('hex'),
    ],
  );
}

/** 대량 테스트 사용자의 지갑과 세션을 집합 쿼리로 생성한다. */
async function insertWalletSessions(pool, identities) {
  const userIds = identities.map(({ userId }) => userId);
  const addresses = identities.map(({ userId }) =>
    bs58.encode(createHash('sha256').update(`wallet:${userId}`).digest()),
  );
  await pool.query(
    `INSERT INTO user_wallets
       (user_id, chain_namespace, address, address_key)
     SELECT user_id, 'solana', address, address
     FROM unnest($1::uuid[], $2::text[]) AS wallet(user_id, address)`,
    [userIds, addresses],
  );
  await pool.query(
    `INSERT INTO auth_sessions (user_id, wallet_account_id, token_hash)
     SELECT identity.user_id, wallet.id, identity.token_hash
     FROM unnest($1::uuid[], $2::text[]) AS identity(user_id, token_hash)
     JOIN user_wallets wallet ON wallet.user_id = identity.user_id`,
    [
      userIds,
      identities.map(({ token }) =>
        createHash('sha256').update(token).digest('hex'),
      ),
    ],
  );
}

module.exports = { insertWalletSession, insertWalletSessions };
