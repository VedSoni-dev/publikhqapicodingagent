import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { childEnvironment, runtimeConfig, TIERS } from '../src/runtime.js';

test('Publik config exposes only tier models and asks permission before writes or execution', () => {
  const config = runtimeConfig('http://127.0.0.1:1234/v1', 'local-gateway-token', 'publik-smart');
  assert.equal(config.model, 'publik/publik-smart');
  assert.equal(config.small_model, 'publik/publik-fast');
  assert.deepEqual(config.enabled_providers, ['publik']);
  assert.deepEqual(Object.keys(config.provider), ['publik']);
  assert.deepEqual(Object.keys(config.provider.publik.models), [...TIERS]);
  assert.deepEqual(config.provider.publik.options, { baseURL: 'http://127.0.0.1:1234/v1', apiKey: 'local-gateway-token' });
  assert.deepEqual(config.permission, { '*': 'ask', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow' });
  assert.equal(config.share, 'disabled');
  assert.equal(config.autoupdate, false);
  for (const model of Object.values(config.provider.publik.models)) {
    assert.equal(model.tool_call, true);
    assert.ok(model.limit.output > 0 && model.limit.output < model.limit.context);
  }
  assert.throws(() => runtimeConfig('http://127.0.0.1:1234/v1', 'token', 'vendor/model'), /Invalid Publik tier/);
});

test('own API configuration enables only the explicitly configured provider/model', () => {
  const config = runtimeConfig('http://127.0.0.1:1234/v1', 'local-token', 'unused', 'vendor/model');
  assert.equal(config.model, 'own/vendor/model');
  assert.equal(config.small_model, 'own/vendor/model');
  assert.deepEqual(config.enabled_providers, ['own']);
  assert.deepEqual(Object.keys(config.provider), ['own']);
  assert.deepEqual(Object.keys(config.provider.own.models), ['vendor/model']);
  assert.equal(config.provider.own.options.apiKey, 'local-token');
});

test('child environment strips model credentials and inherited OpenCode controls while preserving developer paths', () => {
  // Replace the environment with synthetic values: never inspect any real credentials.
  const original = process.env;
  const blocked = [
    'PUBLIK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AZURE_OPENAI_API_KEY', 'OPENROUTER_API_KEY',
    'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME', 'OPENCODE_TEST_HOME',
    'ELECTRON_RUN_AS_NODE', 'openai_api_key',
  ];
  try {
    process.env = {
      PATH: '/synthetic/bin', HOME: '/synthetic/home', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8',
      XDG_CONFIG_HOME: '/old/config', XDG_DATA_HOME: '/old/data', XDG_CACHE_HOME: '/old/cache', XDG_STATE_HOME: '/old/state',
      ...Object.fromEntries(blocked.map(key => [key, 'synthetic-parent-secret'])),
    };
    const config = runtimeConfig('http://127.0.0.1:1234/v1', 'synthetic-local-token', 'publik-fast');
    const env = childEnvironment('/synthetic/session', config, 'synthetic-child-password');
    assert.equal(env.PATH, '/synthetic/bin');
    assert.equal(env.HOME, '/synthetic/home');
    assert.equal(env.OPENCODE_TEST_HOME, join('/synthetic/session', 'home'));
    assert.equal(env.SHELL, '/bin/zsh');
    assert.equal(env.LANG, 'en_US.UTF-8');
    for (const key of blocked) assert.notEqual(env[key], 'synthetic-parent-secret', key);
    assert.equal(JSON.stringify(env).includes('synthetic-parent-secret'), false);
    for (const [key, directory] of [['XDG_CONFIG_HOME', 'config'], ['XDG_DATA_HOME', 'data'], ['XDG_CACHE_HOME', 'cache'], ['XDG_STATE_HOME', 'state']]) {
      assert.equal(env[key], join('/synthetic/session', directory));
    }
    assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT), config);
    assert.equal(env.OPENCODE_SERVER_PASSWORD, 'synthetic-child-password');
    assert.equal(env.OPENCODE_SERVER_USERNAME, 'publik-code');
    for (const key of ['OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_PURE', 'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_MODELS_FETCH']) {
      assert.equal(env[key], '1');
    }
    assert.equal(process.env.OPENCODE_SERVER_PASSWORD, 'synthetic-parent-secret', 'parent environment is not mutated');
  } finally {
    process.env = original;
  }
});
