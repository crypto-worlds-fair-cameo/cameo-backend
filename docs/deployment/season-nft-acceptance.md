# Season NFT acceptance record

Backend base commit: `ca0554bc1cd4644144bb07617b3c7fff588d941f`

Frontend base commit: `bd58acaa087a4060d32b2d942fd7135025330af0`
Latest application verification: 2026-10-11, local frontend/backend with real Devnet and two Phantom wallets. The base commits above identify the starting point; the final implementation is the Git revision containing this record. Earlier dirty-tree hashes are omitted because subsequent fixes superseded them.

## Devnet application evidence (2026-10-11)

Season `8be2eada-dd88-4ecc-8a84-15de69a12e78`, release `d632c21f-bf7b-4635-be6c-9c224a5af7a7`: two eligible participants, READY/LOCKED release, both claims CLAIMED/VERIFIED, and each on-chain MintCounter equals 1. Both proof and mint transactions finalized; completion persisted after browser refresh.

- Account 1 asset: [EXBuBvkLqjFe73Jt8V9egwj43AiBy3dKSN51bT5G6y1S](https://explorer.solana.com/address/EXBuBvkLqjFe73Jt8V9egwj43AiBy3dKSN51bT5G6y1S?cluster=devnet).
- Account 2 asset: [7S2bHRrhB5Fbj1X1QR3UuxBN9v9hGXsoYHZboVtfv3Am](https://explorer.solana.com/address/7S2bHRrhB5Fbj1X1QR3UuxBN9v9hGXsoYHZboVtfv3Am?cluster=devnet).
- Shared collection: `BzEMgG3CKnHfW8SfMcKzcLn5nF3AMmojmxiGkGtP5eWq`.
- Shared [metadata](https://arweave.net/dCHNd_hw9h44q65g3-1lKHDeQpHvpDeiVOGwbfgycT0) and [final image](https://arweave.net/_peMxKQdKRE-t_j9P6W5caVK1w7BgvvBFh2yUHSb4nM) were publicly retrievable.

The local season timestamps were advanced after drawing to exercise the normal expiry worker without waiting an hour. This does not prove behavior at a real one-hour cutoff. Seven read-only Devnet simulations rejected owner/service Asset URI changes and service collection changes (Core errors 26 and 9). They used `sigVerify:false`, sent no transactions, and prove program authorization checks only. Assets have no ImmutableMetadata plugin; metadata protection comes from the locked collection authority and restricted machine PDA delegate.

The isolated SDK outsider, transfer, burn, and storage-replay gates remain NOT_RUN. Application mint success does not replace them or deployment persistence evidence.

## Local evidence

| Check | Result | Command/evidence |
| --- | --- | --- |
| Stage 10 operator and local E2E | PASS | `node --test --test-concurrency=1 test/season-nft/end-to-end.test.cjs test/season-nft/operator-tools.test.cjs` — 18/18 |
| Existing dist build | PASS | `npm run build`; also run by both full suites. |
| Full NFT suite (2026-10-11) | PASS | 212/212 in the combined NFT/realtime run below. |
| Realtime regression suite (2026-10-11) | PASS | 63/63 in the combined NFT/realtime run below. |
| Static checks | PASS | `npm run typecheck`; `npm run lint`; `npm run format:check`; `git diff --check` |
| Frontend final regression (2026-10-11) | PASS | 54 files / 343 tests; lint, format check, and build. Chrome layout checks covered 1440/1024/768/390/375px, NFT cards, profile thumbnails, sticky modal close, and the main canvas. |

Final pre-push run: `node --test --test-concurrency=1 test/canvas/*.test.cjs test/season-nft/*.test.cjs` passed 275/275 with no skips. `PG_TEST_ADMIN_URL` selected the local PostgreSQL server; each fixture created and removed its own isolated database. An initial default `initdb` run failed because macOS exhausted shared-memory IDs, before application assertions could execute. Build, lint, typecheck, format, and staged diff checks also passed. The frontend build retains the existing approximately 523 kB main-chunk warning.

The local E2E uses a disposable PostgreSQL database, production freeze/media and release validation logic, claim create/get/submit use cases, `SeasonClaimChain`, dispatcher, reconciliation, receipt verification, and fresh runtime objects at an in-flight proof boundary. Only storage responses, Solana RPC account/transaction responses, and the two browser-wallet signatures are fixtures. Both users reach VERIFIED/CLAIMED, persisted mint signatures match the verified receipt transactions, and replay creates no extra attempt or asset. The release fixture supplies already-finalized locked chain account readback to the real release provider; it does not claim local execution of the five setup sends.

## External gates

| Verification | Result | Command/transaction | Evidence or missing input |
| --- | --- | --- | --- |
| `LOCAL_SDK` | PASS | Checked-in Devnet SDK evidence | Exact packages, program IDs, exports, proof/mint size and signed-item round trip. This Devnet proof is reused by Mainnet preflight; target genesis is checked separately. |
| `CHAIN_AUTHORITY` | NOT_RUN | `npm run nft:verify:devnet -- --execute ...` | Requires isolated funded Devnet identities and explicit authorization. |
| `STORAGE_RECOVERY` | NOT_RUN | Same explicit Devnet execution | Requires funded Turbo identity and public permanent-upload checks. |
| Persistence after deployment replacement | NOT_RUN | Deployment-platform replacement and preflight evidence | No deployment target or persistent-volume access is available locally. |
| Preflight with real service wallet/RPC/storage | NOT_RUN | `npm run --silent nft:preflight -- --evidence ... --sdk-evidence ... --json` | No external deployment credentials were supplied. |
| Two users mint on Devnet | PASS | See the two finalized assets above. | Two real Phantom wallets approved proof and mint; ownership, counters, DB receipts, and refresh persistence were verified. |
| Duplicate and outsider rejection | NOT_RUN | Record program errors and signatures. | Requires the same isolated Devnet fixture. |
| Restart recovery with real signature/asset | NOT_RUN | Record signature and asset before/after restart. | Local mocked restart PASS does not replace chain evidence. |
| Transfer and remint rejection | NOT_RUN | Record transfer and rejected remint. | Requires real Devnet assets. |
| Burn and remint rejection | NOT_RUN | Dedicated test asset only. | Requires real Devnet asset and irreversible burn authorization. |
| Immutable metadata and locked authority | PARTIAL | Locked account readback and seven mutation rejection simulations described above. | Full isolated authority/bypass suite remains NOT_RUN. |
| Mainnet acceptance | NOT_RUN | Stage 11 only | Must create two real Mainnet assets and verify payer/cost separation, matching immutable metadata, locked authority, refresh persistence, and duplicate blocking. Transfer/burn evidence comes from accepted Devnet checks and is not repeated on Mainnet. |

Do not replace `NOT_RUN` with PASS from local mocks, a user mint quote, a fixture balance, a machine-rent-only calculation, or a Devnet signature submitted as Mainnet evidence.

## Stage 11 readiness and evidence template

Stage 11 status: `NOT_RUN`. The base commits at the top identify the implementation starting point. Record the actual deployed frontend/backend revisions separately; local Devnet evidence does not establish deployed Mainnet revisions.

### Readiness gaps

No additional local code work is currently identified. The remaining gates require externally supplied deployment access, funded identities, wallet approvals, or direct read-only evidence from the deployed environment. A defect found during execution returns to its owning implementation stage and must pass that stage's tests again.

The deployment colleague must supply the following inputs before Mainnet execution. Record only public identifiers, redacted endpoint labels, and evidence file locations. Never record private keys, database passwords, authorization cookies, full secret-bearing URLs, or signed transaction bytes.

| Required external input | Current status | Exact evidence required |
| --- | --- | --- |
| Deployed source identities | `NOT_RUN` | Exact 40-hex backend and frontend commits running in the target environments, plus deployment IDs and deployment times. |
| Devnet/Mainnet isolation | `NOT_RUN` | Separate database instance identifiers, RPC endpoint labels, service-wallet public addresses, Turbo identity public identifiers, and persistent mount identifiers. The values must prove that Mainnet does not reuse Devnet state or keys. |
| Devnet external gates | `NOT_RUN` | An accepted `nft:verify:devnet -- --execute --json` result with `CHAIN_AUTHORITY=PASS` and `STORAGE_RECOVERY=PASS`, plus the two-wallet application acceptance evidence listed below. |
| Deployment configuration | `NOT_RUN` | Presence and deployment-scoped configuration of `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` (presence only), `DB_NAME`, `DB_SSL`, `CANVAS_SNAPSHOT_ENABLED`, `CANVAS_SNAPSHOT_STORAGE_ROOT`, `CANVAS_SNAPSHOT_PUBLIC_BASE_URL`, `SEASON_NFT_ENABLED`, `SOLANA_NETWORK`, `SOLANA_RPC_URL`, `SOLANA_SERVICE_KEYPAIR_PATH`, `NFT_STORAGE_UPLOAD_URL`, `NFT_STORAGE_PAYMENT_URL`, `NFT_STORAGE_GATEWAY_URL`, `NFT_UPLOAD_WORK_DIR`, `NFT_PREPARATION_KEY_DIR`, `SEASON_NFT_PERSISTENCE_EVIDENCE_PATH`, `SEASON_NFT_SDK_EVIDENCE_PATH`, `NFT_RPC_READ_RPS`, `NFT_RPC_SEND_INTERVAL_MS`, and `NFT_PRIORITY_FEE_MAX_LAMPORTS`. Supply values through the deployment platform; do not copy secret values here. |
| Persistent deployment storage | `NOT_RUN` | Before/after/current SHA-256 evidence for the snapshot, upload, and preparation-key roots across an actual deployment replacement. |
| Funded Mainnet identities | `NOT_RUN` | Service-wallet and Turbo funding readiness, two participant wallet public addresses with sufficient SOL, and explicit approval from each participant to sign through the UI. Do not record balances as a substitute for transaction payer evidence. |
| Acceptance season | `NOT_RUN` | A new capacity-2 season with a normal duration of at least 1 hour, two fixed participant wallets, and at least one valid stroke from each wallet. Do not force-close the season. |
| Runtime observation access | `NOT_RUN` | Read-only access or exported evidence for preflight output, deployment logs, database records, RPC transactions/accounts, public storage retrieval, and the season/profile UI. |

Stage 11 must not start until the Devnet external gates and two-wallet Devnet application checks are accepted. Set `SEASON_NFT_ENABLED=true` only after all ten target-environment preflight checks pass.

### Deployment and preflight evidence

Fill every field from the deployed environment. Keep unresolved fields as `NOT_RUN`.

```text
Backend deployed commit (40 hex): NOT_RUN
Backend deployment ID/time: NOT_RUN
Frontend deployed commit (40 hex): NOT_RUN
Frontend deployment ID/time: NOT_RUN
Frontend public origin: NOT_RUN
Frontend configured backend API base URL: NOT_RUN
Backend public API origin: NOT_RUN
Backend CORS allowed origin for the frontend: NOT_RUN
Environment: mainnet-beta
Observed genesis hash: NOT_RUN
RPC endpoint label (redacted): NOT_RUN
Mainnet database instance ID: NOT_RUN
Service wallet public address: NOT_RUN
Turbo identity public identifier: NOT_RUN
Persistence evidence file SHA-256: NOT_RUN
SDK evidence file SHA-256: NOT_RUN
Preflight command time/operator: NOT_RUN
Preflight overall status: NOT_RUN
```

| Preflight check | Result | Evidence |
| --- | --- | --- |
| `CONFIG` | `NOT_RUN` | Redacted JSON result and deployment configuration revision. |
| `DB_SCHEMA` | `NOT_RUN` | Read-only schema check from the Mainnet database. |
| `NETWORK_IDENTITY` | `NOT_RUN` | RPC `getGenesisHash` result for `mainnet-beta`; an endpoint name alone is insufficient. |
| `SERVICE_WALLET` | `NOT_RUN` | Public address and private-file permission check; never attach key bytes. |
| `SERVICE_BALANCE` | `NOT_RUN` | Preflight's five-operation fee/rent/protocol-debit calculation and result. |
| `SNAPSHOT_SETTINGS` | `NOT_RUN` | Configured final snapshot settings and writable persistent root check. |
| `STORAGE_ENDPOINTS` | `NOT_RUN` | HTTPS upload, payment, and gateway endpoint checks with redacted hosts where required. |
| `PRIVATE_PATHS` | `NOT_RUN` | Non-symlink, permission, separation, and containment results for all private roots. |
| `PERSISTENCE_EVIDENCE` | `NOT_RUN` | Matching before/after/current hashes for all three roots after deployment replacement. |
| `SDK_EVIDENCE` | `NOT_RUN` | Accepted Devnet evidence with `LOCAL_SDK`, `CHAIN_AUTHORITY`, and `STORAGE_RECOVERY` all `PASS`. |

### Reused Devnet evidence

Mainnet does not repeat transfer or burn. Reference accepted Devnet evidence here and verify that it belongs to the deployed SDK/program contract.

```text
Devnet evidence file SHA-256: NOT_RUN
Devnet genesis hash: NOT_RUN
Collection/machine/guard addresses: NOT_RUN
Two-wallet proof and mint signatures/assets: NOT_RUN
Duplicate and outsider rejection evidence: NOT_RUN
Restart recovery signature/asset before and after restart: NOT_RUN
Transfer signature and remint rejection evidence: NOT_RUN
Burn signature and remint rejection evidence: NOT_RUN
Immutable metadata and locked-authority readback: NOT_RUN
Permanent upload URI, byte length, and SHA-256 recovery evidence: NOT_RUN
Reviewer and acceptance time: NOT_RUN
```

### Mainnet release evidence

```text
Season ID: NOT_RUN
Release ID: NOT_RUN
Capacity (must equal 2): NOT_RUN
Started/ended time and duration (must be at least 1 hour): NOT_RUN
Participant A public wallet / valid stroke count: NOT_RUN
Participant B public wallet / valid stroke count: NOT_RUN
Final snapshot SHA-256: NOT_RUN
Permanent image URI / retrieved byte length / retrieved SHA-256: NOT_RUN
Permanent metadata URI / retrieved JSON SHA-256: NOT_RUN
Collection address: NOT_RUN
Machine address: NOT_RUN
Guard address: NOT_RUN
Observed collection/machine/guard authorities and lock PDA: NOT_RUN
Mint price absent: NOT_RUN
Royalty absent or zero: NOT_RUN
```

Record the service wallet as payer for each common setup transaction and the participant wallet as payer for that participant's proof and mint. A fee estimate, configured wallet, or local fixture does not prove payer separation.

| Operation | Signature | Finalized time | Observed payer | Result |
| --- | --- | --- | --- | --- |
| Collection creation | `NOT_RUN` | `NOT_RUN` | `NOT_RUN` | `NOT_RUN` |
| Machine/Guard creation | `NOT_RUN` | `NOT_RUN` | `NOT_RUN` | `NOT_RUN` |
| Machine authority lock | `NOT_RUN` | `NOT_RUN` | `NOT_RUN` | `NOT_RUN` |
| Collection authority lock | `NOT_RUN` | `NOT_RUN` | `NOT_RUN` | `NOT_RUN` |
| Atomic Guard open and authority lock | `NOT_RUN` | `NOT_RUN` | `NOT_RUN` | `NOT_RUN` |
| Participant A proof | `NOT_RUN` | `NOT_RUN` | `NOT_RUN` | `NOT_RUN` |
| Participant A mint | `NOT_RUN` | `NOT_RUN` | `NOT_RUN` | `NOT_RUN` |
| Participant B proof | `NOT_RUN` | `NOT_RUN` | `NOT_RUN` | `NOT_RUN` |
| Participant B mint | `NOT_RUN` | `NOT_RUN` | `NOT_RUN` | `NOT_RUN` |

| Claim evidence | Participant A | Participant B |
| --- | --- | --- |
| Asset address | `NOT_RUN` | `NOT_RUN` |
| Finalized mint signature | `NOT_RUN` | `NOT_RUN` |
| Finalized time | `NOT_RUN` | `NOT_RUN` |
| `meta.err` | `NOT_RUN` | `NOT_RUN` |
| Initial owner equals participant | `NOT_RUN` | `NOT_RUN` |
| Asset image URI equals release image URI | `NOT_RUN` | `NOT_RUN` |
| Asset metadata URI and retrieved JSON equal release metadata | `NOT_RUN` | `NOT_RUN` |
| Season UI shows `CLAIMED` | `NOT_RUN` | `NOT_RUN` |
| Profile UI shows the same asset | `NOT_RUN` | `NOT_RUN` |
| Browser refresh remains `CLAIMED` | `NOT_RUN` | `NOT_RUN` |
| Server read-only record matches signature and asset | `NOT_RUN` | `NOT_RUN` |

For each participant, issue one authenticated duplicate claim request only after the first claim is finalized. Record attempt and asset counts before and after. Do not send another wallet transaction to manufacture a duplicate failure.

| Duplicate check | Participant A | Participant B |
| --- | --- | --- |
| Claim-attempt count before/after | `NOT_RUN` | `NOT_RUN` |
| Successful asset count before/after | `NOT_RUN` | `NOT_RUN` |
| Returned status and existing asset | `NOT_RUN` | `NOT_RUN` |
| New transaction created | `NOT_RUN` | `NOT_RUN` |
| Result: no extra attempt or asset | `NOT_RUN` | `NOT_RUN` |

### Recovery and final decision

If acceptance fails after a partial rollout, block only `POST /api/seasons/:seasonId/nft/claim-attempts` at ingress. Keep read routes, signed-transaction submission, worker reconciliation, the database, and all persistent mounts available. Record the ingress change, health checks for preserved paths, unresolved signatures, and the reversal time. Do not delete release or claim records, disable the whole NFT worker, or describe an on-chain asset as rolled back.

```text
Partial-rollout incident occurred: NOT_RUN
New-claim ingress block evidence: NOT_RUN
Read/submit/reconciliation health evidence: NOT_RUN
Unresolved transaction reconciliation result: NOT_RUN
Ingress block reversal evidence: NOT_RUN
Stage 11 reviewer and time: NOT_RUN
Final decision: NOT_RUN
```

Stage 11 passes only when both Mainnet mint signatures are finalized with `meta.err=null`, both assets and metadata match, payer separation is observed, both UI surfaces survive refresh as `CLAIMED`, duplicate requests create no extra attempt or asset, and no secret appears in the evidence. Any missing or contradicted field keeps the final decision at `NOT_RUN` or `FAIL`.
