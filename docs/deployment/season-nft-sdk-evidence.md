# Season NFT SDK validation evidence

Checked on 2026-10-11. The machine-readable result is
[`season-nft-sdk-evidence.json`](./season-nft-sdk-evidence.json).

## Current result

| Gate | Status | Evidence |
| --- | --- | --- |
| `LOCAL_SDK` | `PASS` | Exact runtime imports, signed transaction serialization, a 100-wallet Merkle proof, and a local signed-item byte round trip passed. |
| `CHAIN_AUTHORITY` | `NOT_RUN` | The isolated authority suite was not executed in this local-only run. |
| `STORAGE_RECOVERY` | `NOT_RUN` | The isolated storage recovery suite was not executed in this local-only run. |

Overall status is `EXTERNAL_VALIDATION_PENDING`. This is not evidence that the
Devnet authority or permanent-storage contract passed. The separate two-wallet application run is recorded in [the acceptance record](./season-nft-acceptance.md).

The local signed proof transaction is 600 bytes with one valid Ed25519
signature. The signed guarded mint is 699 bytes with two valid Ed25519
signatures. Its serialized fee payer and encoded owner are the same generated
recipient. The 100-wallet proof has seven nodes. The 1,232-byte legacy/v0
transaction ceiling and 64-byte Ed25519 signature shape come from the
[Solana transaction specification](https://solana.com/docs/core/transactions).

## Pinned SDK contract

| Package | Exact version | Runtime operations verified |
| --- | --- | --- |
| `@metaplex-foundation/mpl-core-candy-machine` | `0.3.0` | `create`, `route`, `mintV1`, proof/root helpers, counter fetch, machine/Guard fetch and authority/update instructions, direct machine mint |
| `@metaplex-foundation/mpl-core` | `1.10.0` | collection creation/fetch/update, asset fetch/update/move, transfer, burn, `ImmutableMetadata` plugin input |
| `@metaplex-foundation/umi` | `0.8.10` | key generation, signer identity, option values, transaction build/sign/serialize |
| `@metaplex-foundation/umi-bundle-defaults` | `0.8.10` | `createUmi` Web3.js RPC/transaction bundle |
| `@ardrive/turbo-sdk` | `2.1.0` | `TurboFactory`, real Solana data-item signing, `uploadSignedDataItem` |

Umi `1.x` was rejected because Candy Machine `0.3.0` pins a Token Metadata
dependency whose peer range is Umi `^0.8.2`, and its toolbox dependency requires
Umi below `1.0`. Umi/bundle `0.8.10` is the highest stable complete peer
intersection; `npm ls` reports a valid tree.

Installed constants must equal these official Core deployments before any
external work starts:

- Core: `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d`
- Core Candy Machine: `CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J`
- Core Candy Guard: `CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ`

The configured RPC must return the full Devnet genesis hash
`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`, and all three program accounts
must be executable. Metaplex documents guarded Core minting with `mintV1`, the
Allow List proof route, and the separate direct-machine mint path in its
[Core Candy Machine mint guide](https://developers.metaplex.com/smart-contracts/core-candy-machine/mint).

## Configured Devnet scenario

Run:

```bash
SOLANA_NETWORK=devnet \
SOLANA_RPC_URL='<isolated devnet RPC>' \
NFT_PREPARATION_KEY_DIR='<absolute persistent preparation root>' \
NFT_UPLOAD_WORK_DIR='<absolute persistent upload root>' \
npm run nft:verify:devnet -- --execute --json
```

The command creates or reloads test-only service, allowed-A, allowed-B, and
outsider-C signers under `NFT_PREPARATION_KEY_DIR/devnet-validation`. The
directory is `0700`; key files are no-clobber, fsynced `0600` files. It records
public addresses for funding and never records a secret, signed bytes, or the
full RPC URL. Insufficient SOL or Turbo credits produce gate-specific
`NOT_RUN`, not `PASS`.

Every signed mutation is persisted before submission under the fixed fixture
directory. If an RPC response is lost, the validator queries the persisted
signature and resends only the identical signed bytes while the signature is
still unresolved. A restarted validator reloads and deserializes that file,
checks its signature against the file name, searches transaction history, and
reconciles or resends it before building the step again. Exhausted or
non-final status evidence remains `NOT_RUN`; each unrelated test keeps an empty
`signatures` array while `details.pendingTransaction` records the blocking
step's persisted signature and label. Only an explicit on-chain error or
deterministic validation failure becomes
`FAIL`. Append-only `0600` checkpoints retain prior assertion results, Asset
observations, mint signatures, and the first mint's pre-exposure cost quote.
After transfer or burn, a restarted process resumes from that stage instead of
rerunning assertions against state that those later mutations invalidated.
Read-only RPC and permanent-gateway calls use bounded retry.

The implemented call sequence is:

1. `createCollection` creates the validation collection with
   `plugins: [{ type: 'ImmutableMetadata' }]`; a separate collection is created
   only for the move-rejection assertion. Machine creation installs its exact
   authority PDA as the single collection update delegate.
2. `create` creates a two-item, immutable, hidden-settings Core machine with an
   Allow List root, Mint Limit `{ id: 0, limit: 1 }`, no groups, and a future
   Start Date.
3. While Start Date still blocks claims, `setCandyMachineAuthority` and
   an atomic `removeCollectionPlugin(ImmutableMetadata)` plus `updateCollectionV1`
   assign collection management to the off-curve system-program PDA derived
   from seed `cameo-nft-lock-v1`. The temporary plugin otherwise rejects
   authority transfer. The locked authority protects collection metadata.
4. One final transaction executes `updateCandyGuard` without Start Date and
   `setCandyGuardAuthority` to the same lock PDA. Solana transaction atomicity
   makes opening and Guard lock indivisible.
5. Each allowed wallet submits a separate `route` proof transaction and
   `mintV1` transaction, with that recipient as payer, minter, and owner.
   Rejection simulations run while one supply slot remains, validate the
   rejecting program ID plus the scenario-specific custom error code, and
   never treat sold-out, missing-account, timeout, 429, or transport errors as
   the intended program rejection.
6. The Mint Limit counter must remain `1` after transfer and burn before the
   corresponding remint rejection can pass. Burn must leave the documented
   Core-owned, one-byte uninitialized tombstone. Collection/asset metadata,
   collection move, root, supply, mint authority, and direct-machine bypass
   mutations are each simulated against the locked state.
   `remintAfterBurnRejected.signatures` remains empty because it is a
   simulation; its successful supporting burn signature is recorded as
   `details.burnSignature`.
7. Before mint, `feeEstimateMatchesInstructions` simulates the exact signed
   message, derives Asset and Mint Counter rent from their simulated data
   lengths, and separates every remaining named-account credit as protocol
   cost. The quote requires nonzero rent and protocol components, then
   reconciles each component to the confirmed named balances and payer delta.
8. Turbo signs one ANS-104 item, publishes it locally without replacement,
   reloads the exact bytes, uploads and replays them with
   `uploadSignedDataItem`, requires both receipt IDs to equal the locally
   derived ID, then verifies public Arweave length and SHA-256. The official
   [Turbo SDK reference](https://github.com/ardriveapp/turbo-sdk#uploadsigneddataitem-dataitemstreamfactory-dataitemsizefactory-signal-events-)
   documents that the stream factory must provide a fresh stream for each
   upload invocation.

An externally verified JSON also contains `observedLockState`: the exact lock
program, seed, bump and PDA; expected and observed machine, mint, Guard and
collection authorities; collection metadata protection by locked authority;
the exact machine PDA collection update delegate; and empty delegate plugin
lists for both assets. Missing or inconsistent
readback blocks `EXTERNAL_VERIFIED`. Rejection results store the rejecting
program, custom error and bounded simulation log tail in each result's
`reason`.

## Dependency advisory review

`npm audit --omit=dev --json` reports 39 production-tree findings: 8 low, 20
moderate, 7 high, and 4 critical. This count includes pre-existing server
dependencies. The SDK-related direct paths are:

| Path | Audit severity | Reachability in this validation path |
| --- | --- | --- |
| `umi-bundle-defaults -> @solana/web3.js -> jayson -> stream-json/uuid` | moderate | RPC parsing is runtime reachable. The endpoint is operator-configured and genesis-checked, but its responses remain external input. |
| `mpl-core-candy-machine -> merkletreejs -> web3-utils -> bn.js` | moderate | Merkle construction is runtime reachable with 2..100 validated Base58 wallet addresses supplied by the service, not arbitrary nested JSON or numeric strings. |
| `turbo-sdk -> @dha-team/arbundles -> ethers/elliptic/secp256k1` | critical/high | The planned flow selects Turbo's Solana Ed25519 signer. EVM/ECDSA and ECDH code paths are installed but are not invoked by this adapter. |
| `turbo-sdk -> @solana/spl-token -> bigint-buffer` | high | The adapter uploads a pre-signed item and does not invoke SPL token layout or `toBigIntLE` APIs. |

There is no verified in-range remediation for Candy Machine or the Umi bundle.
Audit proposes changing Turbo to `1.41.3`; that is outside the selected `2.1.0`
API contract, is marked a major change by npm, and would discard the stable
version whose exports were verified. No blind `npm audit fix` or override was
applied. These advisories must be rechecked before moving the SDKs into a
long-lived production provider; meanwhile inputs stay bounded, the RPC is
explicitly trusted and genesis-checked, and only the Solana signer path is used.

The `@nestjs/platform-express -> multer` finding and other unrelated server
paths are outside this stage's package additions and should be remediated in
their owning dependency update.
