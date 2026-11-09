const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { copyFileSync, createReadStream, lstatSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { parse, stringify } = require('yaml');
const { version } = require('../package.json');

async function hash(file, algorithm, encoding) {
  const digest = createHash(algorithm);
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest(encoding);
}

async function verifyUpdateAssets(directory, platform, arch) {
  const windows = platform === 'win';
  const name = `1904-Desktop-${version}-${platform}-${arch}.${windows ? 'exe' : 'zip'}`;
  const manifestName = windows ? 'latest.yml' : 'latest-mac.yml';
  const installer = join(directory, name);
  const info = lstatSync(installer);
  assert.ok(info.isFile() && info.size > 0, `Expected a nonempty ${name}`);

  const manifest = parse(readFileSync(join(directory, manifestName), 'utf8'));
  assert.equal(manifest.version, version);
  assert.equal(manifest.files?.length, 1);
  const [entry] = manifest.files;
  const sha512 = await hash(installer, 'sha512', 'base64');
  assert.equal(entry.url, name);
  assert.equal(entry.sha512, sha512, `Checksum mismatch for ${name}`);
  if (entry.size !== undefined) assert.equal(entry.size, info.size);
  if (manifest.path !== undefined) assert.equal(manifest.path, name);
  if (manifest.sha512 !== undefined) assert.equal(manifest.sha512, sha512);

  const blockmap = `${name}.blockmap`;
  const mapInfo = lstatSync(join(directory, blockmap));
  assert.ok(mapInfo.isFile() && mapInfo.size > 0, `Expected a nonempty ${blockmap}`);
  return { name, manifestName, manifest, blockmap };
}

async function assembleRelease(input, output) {
  const targets = [
    { platform: 'win', arch: 'x64' },
    { platform: 'mac', arch: 'x64' },
    { platform: 'mac', arch: 'arm64' },
  ];
  const builds = await Promise.all(targets.map(async ({ platform, arch }) => {
    const directory = join(input, `1904-desktop-${platform}-${arch}`);
    return { directory, ...await verifyUpdateAssets(directory, platform, arch) };
  }));
  const [windows, intel, appleSilicon] = builds;
  const macManifest = { ...intel.manifest, files: [...intel.manifest.files, ...appleSilicon.manifest.files] };

  mkdirSync(output);
  const files = [];
  for (const { directory, name, blockmap } of builds) {
    for (const asset of [name, blockmap]) {
      copyFileSync(join(directory, asset), join(output, asset));
      files.push(asset);
    }
  }
  copyFileSync(join(windows.directory, windows.manifestName), join(output, windows.manifestName));
  writeFileSync(join(output, intel.manifestName), stringify(macManifest));
  files.push(windows.manifestName, intel.manifestName);

  const checksums = await Promise.all(files.map(async name => `${await hash(join(output, name), 'sha256', 'hex')}  ${name}`));
  writeFileSync(join(output, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`);
  console.log(`Assembled Windows x64 and both Mac update packages for v${version}`);
}

if (require.main === module) {
  assembleRelease(resolve('release-output/downloads'), resolve('release-output/github'))
    .catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { assembleRelease, hash, verifyUpdateAssets };
