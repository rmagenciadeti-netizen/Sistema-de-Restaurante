import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

test('API environment loads the root file without overriding existing values', () => {
  const root = mkdtempSync(join(tmpdir(), 'rm-api-env-'));
  try {
    const cwd = join(root, 'apps/api');
    const lib = join(cwd, 'src/lib');
    mkdirSync(lib, { recursive: true });
    copyFileSync(join(__dirname, 'env.ts'), join(lib, 'env.ts'));
    symlinkSync(resolve(dirname(require.resolve('dotenv')), '../..'), join(root, 'node_modules'), 'dir');
    writeFileSync(join(root, '.env'), 'RM_ENV_LOADER_TEST=root\n');
    const env = { ...process.env };
    delete env.RM_ENV_LOADER_TEST;

    const run = (extraEnv: NodeJS.ProcessEnv = {}) => spawnSync(
      process.execPath,
      [require.resolve('tsx/cli'), '-e', "require('./src/lib/env'); console.log(process.env.RM_ENV_LOADER_TEST || 'unset')"],
      { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8' },
    );

    let result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'root');

    writeFileSync(join(cwd, '.env'), 'RM_ENV_LOADER_TEST=cwd\n');
    result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'cwd');

    result = run({ RM_ENV_LOADER_TEST: 'process' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'process');

    rmSync(join(cwd, '.env'));
    rmSync(join(root, '.env'));
    result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'unset');

    mkdirSync(join(root, '.env'));
    result = run();
    assert.notEqual(result.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
