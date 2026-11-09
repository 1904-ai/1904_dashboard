const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, dirname, join } = require('node:path');
const { test } = require('node:test');
const { parse, stringify } = require('yaml');
const { version } = require('../package.json');
const { assembleRelease } = require('../scripts/release-assets.cjs');

function releaseFixture(t) {
  const tempParent = realpathSync(tmpdir());
  const root = mkdtempSync(join(tempParent, '1904-release-assets-test-'));
  t.after(() => {
    const target = realpathSync(root);
    assert.equal(dirname(target), tempParent);
    assert.match(basename(target), /^1904-release-assets-test-/);
    rmSync(target, { recursive: true });
  });
  const output = join(root, 'release');
  const targets = [
    ['win', 'x64', 'exe', 'latest.yml'],
    ['mac', 'x64', 'zip', 'latest-mac.yml'],
    ['mac', 'arm64', 'zip', 'latest-mac.yml'],
  ];
  const builds = targets.map(([platform, arch, extension, manifestName]) => {
    const directory = join(root, `1904-desktop-${platform}-${arch}`);
    const name = `1904-Desktop-${version}-${platform}-${arch}.${extension}`;
    const bytes = Buffer.from(`test package for ${platform}/${arch}`);
    const sha512 = createHash('sha512').update(bytes).digest('base64');
    const entry = { url: name, sha512, size: bytes.length };
    const manifest = { version, files: [entry], path: name, sha512 };
    mkdirSync(directory);
    writeFileSync(join(directory, name), bytes);
    writeFileSync(join(directory, `${name}.blockmap`), `test blockmap for ${platform}/${arch}`);
    writeFileSync(join(directory, manifestName), stringify(manifest));
    return { directory, name, bytes, entry, manifest };
  });
  return { root, output, builds };
}

test('the release contains both Mac architectures and a separate Windows manifest', async t => {
  const { root, output, builds } = releaseFixture(t);
  const [windows, intel, appleSilicon] = builds;
  await assembleRelease(root, output);

  const mac = parse(readFileSync(join(output, 'latest-mac.yml'), 'utf8'));
  assert.deepEqual(mac, { ...intel.manifest, files: [intel.entry, appleSilicon.entry] });
  assert.deepEqual(parse(readFileSync(join(output, 'latest.yml'), 'utf8')), windows.manifest);
  for (const { name, bytes } of builds) {
    assert.deepEqual(readFileSync(join(output, name)), bytes);
    assert.ok(existsSync(join(output, `${name}.blockmap`)));
  }
  const sums = readFileSync(join(output, 'SHA256SUMS.txt'), 'utf8');
  const manifestDigest = createHash('sha256').update(readFileSync(join(output, 'latest-mac.yml'))).digest('hex');
  assert.ok(sums.includes(`${manifestDigest}  latest-mac.yml\n`));
});

test('a mismatched Apple Silicon payload prevents assembly', async t => {
  const { root, output, builds } = releaseFixture(t);
  const [, , appleSilicon] = builds;
  writeFileSync(join(appleSilicon.directory, appleSilicon.name), 'corrupted package');

  await assert.rejects(assembleRelease(root, output), /Checksum mismatch/);
  assert.equal(existsSync(output), false);
});
