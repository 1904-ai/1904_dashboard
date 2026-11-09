const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { parse } = require('yaml');
const { version, productName } = require('../package.json');
const config = require('./release.config.cjs');

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed`);
}

async function hash(file, algorithm, encoding) {
  const digest = createHash(algorithm);
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest(encoding);
}

function verifyWindowsSignature(path) {
  run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `
    $sig = Get-AuthenticodeSignature -LiteralPath $env:DESKTOP_VERIFY_PATH
    if ($sig.Status -ne 'Valid' -or !$sig.TimeStamperCertificate) { throw 'Expected a valid, timestamped signature' }
    $name = $sig.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    if ($name -cne $env:DESKTOP_WINDOWS_PUBLISHER) { throw 'Unexpected signing publisher' }
  `], { ...process.env, DESKTOP_VERIFY_PATH: path });
}

async function verify() {
  const windows = process.platform === 'win32';
  const platform = windows ? 'win' : 'mac';
  const arch = process.arch;
  const dist = resolve(config.directories.output);
  const name = `1904-Desktop-${version}-${platform}-${arch}.${windows ? 'exe' : 'zip'}`;
  const installer = join(dist, name);
  const manifestName = windows ? 'latest.yml' : 'latest-mac.yml';
  const manifestPath = join(dist, manifestName);
  assert.ok(lstatSync(installer).isFile(), 'The installer must contain real file data');

  const manifest = parse(readFileSync(manifestPath, 'utf8'));
  const sha512 = await hash(installer, 'sha512', 'base64');
  assert.equal(manifest.version, version);
  assert.equal(manifest.files?.length, 1);
  assert.equal(manifest.files[0].url, name);
  assert.equal(manifest.files[0].sha512, sha512);
  if (manifest.files[0].size !== undefined) assert.equal(manifest.files[0].size, lstatSync(installer).size);
  if (manifest.path !== undefined) assert.equal(manifest.path, name);
  if (manifest.sha512 !== undefined) assert.equal(manifest.sha512, sha512);

  const temp = mkdtempSync(join(tmpdir(), '1904-desktop-verify-'));
  try {
    let executable;
    let resources;
    if (windows) {
      const bundle = join(dist, 'win-unpacked');
      executable = join(bundle, `${productName}.exe`);
      resources = join(bundle, 'resources');
      verifyWindowsSignature(installer);
      verifyWindowsSignature(executable);
    } else {
      run('ditto', ['-x', '-k', installer, temp]);
      const bundle = join(temp, `${productName}.app`);
      executable = join(bundle, 'Contents', 'MacOS', productName);
      resources = join(bundle, 'Contents', 'Resources');
      run('codesign', ['--verify', '--deep', '--strict', bundle]);
      run('xcrun', ['stapler', 'validate', bundle]);
      run('spctl', ['--assess', '--type', 'execute', bundle]);
      const binary = spawnSync('lipo', ['-archs', executable], { encoding: 'utf8' });
      assert.equal(binary.status, 0);
      assert.equal(binary.stdout.trim(), arch === 'arm64' ? 'arm64' : 'x86_64');
    }

    const update = parse(readFileSync(join(resources, 'app-update.yml'), 'utf8'));
    assert.equal(update.provider, 'generic');
    assert.equal(update.url, config.publish.url);
    if (windows) assert.ok(update.publisherName?.includes(process.env.DESKTOP_WINDOWS_PUBLISHER));
    run(process.execPath, [join(__dirname, 'smoke-release.cjs'), executable]);
  } finally {
    rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
  }

  const staged = resolve('release-output', platform, arch);
  mkdirSync(staged, { recursive: true });
  const files = [name, manifestName];
  if (existsSync(join(dist, `${name}.blockmap`))) files.push(`${name}.blockmap`);
  const checksums = [];
  for (const file of files) {
    copyFileSync(join(dist, file), join(staged, file));
    checksums.push(`${await hash(join(staged, file), 'sha256', 'hex')}  ${file}`);
  }
  writeFileSync(join(staged, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`);
  console.log(`Verified and staged ${platform}/${arch} ${version}`);
}

verify().catch(error => { console.error(error); process.exitCode = 1; });
