#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const { mkdir, rename, writeFile } = require('node:fs/promises');
const { dirname, isAbsolute, resolve } = require('node:path');
const {
  createPendingEvidence,
  verifyLocalSdk,
} = require('./sdk-validation.cjs');

const DEFAULT_EVIDENCE_PATH = resolve(
  __dirname,
  '../../docs/deployment/season-nft-sdk-evidence.json',
);

function usage() {
  return [
    'Usage: node scripts/season-nft/verify-devnet.cjs [--execute] [--json] [--evidence <absolute-path>]',
    '',
    'Without --execute, runs local SDK checks and records external checks as NOT_RUN.',
    'With --execute, requires SOLANA_NETWORK=devnet plus isolated Devnet validation inputs.',
  ].join('\n');
}

function parseArguments(argv) {
  const options = { execute: false, json: false, evidencePath: DEFAULT_EVIDENCE_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--execute') options.execute = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--evidence') {
      const value = argv[index + 1];
      if (!value) throw new Error('--evidence requires a path.');
      options.evidencePath = isAbsolute(value) ? value : resolve(process.cwd(), value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: resolve(__dirname, '../..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Writes one complete evidence document so readers never observe a partially written JSON file. */
async function writeEvidence(evidencePath, evidence) {
  await mkdir(dirname(evidencePath), { recursive: true });
  const temporaryPath = `${evidencePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporaryPath, evidencePath);
}

function configurationError(code, message) {
  return {
    status: 'CONFIGURATION_ERROR',
    checks: [{ id: 'configuration', status: 'FAIL', code, message }],
  };
}

function printResult(result, json) {
  process.stdout.write(`${JSON.stringify(result, null, json ? 0 : 2)}\n`);
}

/** Runs local verification first, then executes external mutation only when isolated Devnet inputs are present. */
async function main(argv = process.argv.slice(2), environment = process.env) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    printResult(configurationError('INVALID_ARGUMENT', error.message), argv.includes('--json'));
    return 2;
  }

  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (environment.SOLANA_NETWORK !== 'devnet') {
    printResult(
      configurationError('DEVNET_REQUIRED', 'SOLANA_NETWORK must be devnet for this command.'),
      options.json,
    );
    return 2;
  }

  const local = await verifyLocalSdk();
  if (!options.execute) {
    const reason = 'External mutation was not requested. Re-run with --execute and isolated Devnet inputs.';
    const evidence = createPendingEvidence(local, reason, { gitCommit: gitCommit() });
    await writeEvidence(options.evidencePath, evidence);
    printResult(
      {
        status: evidence.overallStatus,
        gates: evidence.gates,
        checks: evidence.tests,
        evidencePath: options.evidencePath,
      },
      options.json,
    );
    return 3;
  }

  const missing = [
    'SOLANA_RPC_URL',
    'NFT_PREPARATION_KEY_DIR',
    'NFT_UPLOAD_WORK_DIR',
  ].filter((name) => !environment[name]);
  if (missing.length > 0) {
    const reason = `Missing external validation inputs: ${missing.join(', ')}.`;
    const evidence = createPendingEvidence(local, reason, { gitCommit: gitCommit() });
    await writeEvidence(options.evidencePath, evidence);
    printResult(
      {
        status: evidence.overallStatus,
        gates: evidence.gates,
        checks: evidence.tests,
        evidencePath: options.evidencePath,
      },
      options.json,
    );
    return 3;
  }
  const relativeRoots = ['NFT_PREPARATION_KEY_DIR', 'NFT_UPLOAD_WORK_DIR']
    .filter((name) => !isAbsolute(environment[name]));
  if (relativeRoots.length > 0) {
    printResult(
      configurationError(
        'ABSOLUTE_ROOT_REQUIRED',
        `${relativeRoots.join(', ')} must use absolute persistent paths.`,
      ),
      options.json,
    );
    return 2;
  }

  const { executeDevnetValidation } = require('./sdk-devnet.cjs');
  const evidence = await executeDevnetValidation({
    environment,
    local,
    gitCommit: gitCommit(),
  });
  await writeEvidence(options.evidencePath, evidence);
  printResult(
    {
      status: evidence.overallStatus,
      gates: evidence.gates,
      checks: evidence.tests,
      evidencePath: options.evidencePath,
    },
    options.json,
  );
  return evidence.overallStatus === 'EXTERNAL_VERIFIED' ? 0 : 1;
}

if (require.main === module) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      const { redactDiagnostic } = require('./sdk-devnet.cjs');
      const message = redactDiagnostic(error.message, process.env.SOLANA_RPC_URL);
      process.stderr.write(`season NFT SDK validation failed: ${message}\n`);
      printResult(
        {
          status: 'VALIDATION_FAILED',
          checks: [
            {
              id: 'validation',
              status: 'FAIL',
              code: 'VALIDATION_FAILED',
              message,
            },
          ],
        },
        process.argv.includes('--json'),
      );
      process.exitCode = 1;
    });
}

module.exports = { main, parseArguments, writeEvidence };
