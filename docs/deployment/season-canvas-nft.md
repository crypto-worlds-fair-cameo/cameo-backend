# Season canvas NFT deployment and recovery

This runbook hands the built backend to the colleague who owns deployment. The code owner pushes the reviewed source. The deployer supplies the target, database, Solana RPC, service wallet, Turbo account, and persistent mounts. No repository command creates or funds an operational wallet.

## Deployment order

1. Install the lockfile dependencies with Node `>=24.21.0 <25`.

   ```sh
   npm ci
   npm run build
   ```

2. Stop every backend replica before applying the migrations. Apply these files with the deployment platform's existing PostgreSQL migration runner, in order:

   ```text
   db/migrations/2026-10-09-01-season-participation-wallets.sql
   db/migrations/2026-10-09-02-season-nft.sql
   ```

   The repository does not define a production migration runner or hosting target. Do not substitute the development reset command for migration.

3. Keep `SEASON_NFT_ENABLED=false`. Configure one backend replica, the snapshot worker, and the values shown in `.env.example`. Use separate service wallets, RPC endpoints, Turbo funding, preparation-key roots, and evidence for `devnet` and `mainnet-beta`.

4. Mount these paths on storage that survives a process and deployment replacement:

   - `CANVAS_SNAPSHOT_STORAGE_ROOT`: snapshot tree; owner writable, never group/world writable.
   - `NFT_UPLOAD_WORK_DIR`: private `0700` directory for immutable signed upload bytes.
   - `NFT_PREPARATION_KEY_DIR`: private `0700` directory for collection and machine keys.
   - `SOLANA_SERVICE_KEYPAIR_PATH`: regular non-symlink secret file with no group/other permissions (`0400` or `0600`).

   The upload and key roots must be separate from each other and from the public `snapshots` subtree.

5. Configure HTTPS storage upload, payment, and gateway endpoints. Fund the Turbo identity and Solana service wallet outside this application. Never place keys in Git, frontend configuration, command output, or acceptance documents.

6. Produce persistence evidence after a real redeployment. Create one non-secret probe in each configured root, record SHA-256 before replacement, redeploy with the same mounts, then record SHA-256 after replacement. The JSON contract is:

   ```json
   {
     "schemaVersion": 1,
     "network": "devnet",
     "backendCommit": "40-hex-current-commit",
     "checkedAt": "2026-10-10T00:00:00.000Z",
     "restartVerified": true,
     "paths": [
       {
         "purpose": "snapshot",
         "absolutePath": "/absolute/configured/root",
         "probeRelativePath": "redeploy-probe.txt",
         "sha256Before": "64-hex",
         "sha256After": "same-64-hex"
       },
       { "purpose": "upload", "absolutePath": "/absolute/upload/root", "probeRelativePath": "redeploy-probe.txt", "sha256Before": "64-hex", "sha256After": "same-64-hex" },
       { "purpose": "preparation-key", "absolutePath": "/absolute/key/root", "probeRelativePath": "redeploy-probe.txt", "sha256Before": "64-hex", "sha256After": "same-64-hex" }
     ]
   }
   ```

   Set `SEASON_NFT_PERSISTENCE_EVIDENCE_PATH` to the absolute evidence path. Preflight resolves all roots and probes, rejects traversal and symlinks, and compares the current bytes to both recorded hashes.

7. Point `SEASON_NFT_SDK_EVIDENCE_PATH` at **Devnet** evidence created by `npm run nft:verify:devnet`. This evidence stays labeled `network: "devnet"` for both deployment networks; preflight separately verifies the target RPC genesis through `NETWORK_IDENTITY`. The default checked-in evidence records local SDK PASS and the external gates as `NOT_RUN`; it does not authorize a chain deployment. External execution needs isolated Devnet credentials and the explicit `--execute` flow documented by that command.

8. Run preflight against the already built `dist`. It never builds, starts Nest, writes the database, uploads, sends a transaction, creates a wallet, or funds an account.

   ```sh
   npm run --silent nft:preflight -- --evidence /absolute/persistence-evidence.json --sdk-evidence /absolute/sdk-evidence.json --json
   ```

   Exit codes are `0` PASS, `1` FAIL, `2` invalid invocation/configuration or missing `dist`, and `3` PENDING.

   `SERVICE_BALANCE` is calculated from the actual five-operation runtime plan: collection creation, machine/guard creation, and three authority-lock transactions. Preflight compiles those messages with the installed pinned SDK, requires the service wallet as payer, reads all five fees with `getFeeForMessage`, quotes Candy Machine and Guard rent per account with `getMinimumBalanceForRentExemption`, and simulates collection creation to reconcile its rent and Core protocol debit. Runtime setup adds no priority-fee instruction, so that component is zero. If collection simulation cannot complete, the independently verified five fees plus machine/guard rent remain a lower bound: a balance below it is FAIL with the known shortage, while a balance above it stays PENDING until collection rent and protocol debit reconcile. A caller-supplied mint quote or numeric threshold is never accepted.

9. Resolve every FAIL and PENDING item with actual evidence. Only then set `SEASON_NFT_ENABLED=true` and start the single backend replica. Confirm the snapshot worker can publish a final READY snapshot before allowing a season to end.

## Recovery

Read endpoints, signed transaction submission, and receipt reconciliation must remain available while new claim creation is blocked. During an incident, keep `SEASON_NFT_ENABLED=true` and the worker running, and apply an ingress rule that blocks only `POST /api/seasons/:seasonId/nft/claim-attempts`. Keep the database and all three mounts attached and preserve every signed transaction and upload file. Do not block the signed-transaction submission route or disable the whole NFT feature; either action prevents in-flight recovery.

Inspect a BLOCKED release and repair its recorded cause. The retry command has no reset, root, URI, metadata, claim, key, or signed-byte override:

```sh
npm run --silent nft:retry-release -- --release-id 00000000-0000-4000-8000-000000000000 --network devnet --json
```

It locks season then release, changes only scheduling/error fields, and leaves READY/EMPTY unchanged. It clears BLOCKED only when the exact recorded cause is independently rechecked:

- missing signed item: safe private file plus valid ANS-104 signature, data-item ID, payload length, and SHA-256;
- missing preparation key: safe private file plus Ed25519 seed-derived public address;
- snapshot/media source: final READY row plus current head, safe file, byte length, and SHA-256;
- transient RPC cause: live genesis must still match the selected network.

All other causes remain BLOCKED for manual diagnosis. A failed retry never replaces frozen snapshot IDs, metadata, Merkle roots, claims, preparation identities, or signed bytes.

The guarded development reset is for an explicitly disposable development database only:

```sh
npm run --silent nft:reset-development -- --help
```

It requires its documented `--apply`, expected count, and absolute manifest controls. Never run it against the current development database as part of deployment and never run it in production.

## External acceptance

Real Devnet acceptance needs two funded user wallets plus the separately funded service/Turbo identities. Record season, asset, and transaction identifiers, observed fees, restart recovery, duplicate rejection, transfer, burn, immutable metadata, and authority-lock results in `season-nft-acceptance.md`. Stage 11 then reuses the accepted Devnet transfer, burn, and mutation-rejection evidence. Mainnet acceptance remains separate: it requires a normal capacity-two season, two user-approved mints, two real assets, payer/cost evidence, matching immutable metadata, locked authority readback, refresh persistence, and duplicate blocking. It does not repeat transfer or burn experiments on Mainnet.
