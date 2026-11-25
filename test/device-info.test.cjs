const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createDeviceInfoReader, friendlyOsName } = require('../device-info.cjs');

test('friendlyOsName normalizes desktop platforms', () => {
  assert.equal(friendlyOsName('darwin'), 'macOS');
  assert.equal(friendlyOsName('win32'), 'Windows');
  assert.equal(friendlyOsName('linux'), 'Linux');
});

test('createDeviceInfoReader returns cached hardware model and OS version without PII', async () => {
  let calls = 0;
  const reader = createDeviceInfoReader({
    platform: 'darwin',
    arch: 'arm64',
    release: '24.3.0',
    run: (cmd, args, _opts, cb) => {
      calls++;
      if (cmd.includes('sw_vers')) return cb(null, '15.3.1\n');
      if (cmd.includes('sysctl') && args.includes('hw.model')) return cb(null, 'Mac15,6\n');
      cb(new Error('unexpected'));
    },
  });

  const first = await reader();
  const second = await reader();
  assert.deepEqual(first, { osName: 'macOS', osVersion: '15.3.1', arch: 'arm64', deviceModel: 'Mac15,6' });
  assert.deepEqual(second, first);
  assert.equal(calls, 2, 'cached after first read');
  assert.equal('hostname' in first, false);
  assert.equal('username' in first, false);
});
