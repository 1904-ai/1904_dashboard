const { ipcRenderer } = require('electron');

// Deploy From This Computer: the one place an app's deploy is set up. The person names the host and
// how to sign in (or types a connect command, or runs on this computer), and the commands. The page
// itself runs no script; this preload fills it with textContent and form values only, so an app's
// name from 1904 is never parsed as HTML. Everything goes to the main process, which checks it
// again, keeps any secret in the system's key store, and asks before commands may run without
// approval. A password typed here is sent once and cleared from the field.

const $ = id => document.getElementById(id);
let state = { connection: { connected: false, text: '' }, apps: [], recipes: [], kept: {} };
let selected;
let busy = false;
/** The host identity the person trusted for the host in the form, and what the last check showed. */
let trusted = [];
let seen = [];

const AUTH_HINT = {
  key: '1904 Desktop makes a key for this app and keeps it encrypted on this computer. You add it on the host once; after that no password is needed.',
  ssh: 'Uses whatever your own ssh uses for this host: your keys, your agent and your SSH settings, including a jump host. The user name and port can be left to those settings. It must work without typing anything.',
  'password-saved': 'The password is kept encrypted with this computer’s secure storage. A deploy key is safer: many hosts turn password sign-in off.',
  'password-ask': 'Nothing is saved. 1904 Desktop asks you for the password every time this app deploys, so a deploy waits until you are at this computer.',
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const recipeFor = appId => state.recipes.find(recipe => recipe.appId === appId);
const keptFor = appId => state.kept?.[appId] ?? { password: false, publicKey: '', installCommand: '' };
const checked = name => document.querySelector(`input[name="${name}"]:checked`)?.value;
const logMode = () => checked('log') || 'output';
const where = () => checked('where') || 'host';
const pick = (name, value) => { for (const input of document.querySelectorAll(`input[name="${name}"]`)) input.checked = input.value === value; };

function say(text, kind = '') {
  $('status').textContent = text || '';
  $('status').dataset.kind = kind;
}

/** The host as typed. The port is empty when it is left to the default (or, with the person's own SSH setup, to their settings). */
function typedHost() {
  const port = $('host-port').value.trim();
  return { name: $('host-name').value.trim(), user: $('host-user').value.trim(), ...(port ? { port: Number.parseInt(port, 10) } : {}), auth: $('auth').value };
}

function formInput() {
  const place = where();
  return {
    ...(place === 'host' ? { host: { ...typedHost(), keys: trusted.map(key => key.line) }, password: $('host-password').value } : {}),
    connect: place === 'custom' ? $('connect').value : '', commands: $('commands').value,
    log: { mode: logMode(), path: $('log-path').value },
    auto: $('auto').checked, noApproval: $('no-approval').checked,
    position: Number.parseInt($('position').value, 10), stopOnFailure: $('stop-on-failure').checked,
  };
}

/** Shows the parts of the form that go with where the commands run and how to sign in. */
function showParts() {
  const place = where();
  const auth = $('auth').value;
  $('host-fields').hidden = place !== 'host';
  $('custom-fields').hidden = place !== 'custom';
  $('auth-hint').textContent = AUTH_HINT[auth] || '';
  $('identity-box').hidden = auth === 'ssh';
  $('key-box').hidden = auth !== 'key';
  $('password-box').hidden = auth !== 'password-saved';
  // A log file needs somewhere to keep one: a host, or a Mac.
  const canLog = place !== 'local' || state.platform !== 'windows';
  for (const input of document.querySelectorAll('input[name="log"]')) if (input.value !== 'output') input.disabled = !canLog;
  if (!canLog && logMode() !== 'output') pick('log', 'output');
  $('log-path-row').hidden = logMode() === 'output';
  $('local-note').hidden = !(place === 'local' && state.platform === 'windows');

  const kept = keptFor(selected);
  $('identity-text').textContent = trusted.length
    ? 'You trusted this host. A deploy stops if the host ever shows a different identity.'
    : seen.length ? 'This is what the host shows. Compare it with what its owner gave you, or with the host itself, before you trust it.'
      : 'Check the host to see its identity. A deploy only connects to a host that shows exactly the identity you trusted.';
  $('identity-keys').replaceChildren(...(trusted.length ? trusted : seen).map(key => node('li', '', key.fingerprint)));
  $('trust-host').hidden = trusted.length > 0 || seen.length === 0;
  $('check-host').textContent = trusted.length ? 'Check again' : 'Check host';
  $('key-text').textContent = kept.publicKey
    ? `This app has a deploy key (${kept.publicKey.split(' ').slice(0, 2).join(' ').slice(0, 44)}…). Add it on the host once.`
    : 'No key yet. Create one, then add it on the host.';
  $('make-key').textContent = kept.publicKey ? 'Replace key' : 'Create deploy key';
  $('key-install').hidden = !kept.publicKey;
  $('install-command').textContent = kept.installCommand || '';
  $('host-password').placeholder = kept.password ? 'Saved. Type a new one to replace it.' : 'Password for the host';
}

function fill(appId) {
  selected = appId;
  const recipe = recipeFor(appId);
  pick('where', recipe?.host ? 'host' : recipe?.connect ? 'custom' : recipe ? 'local' : 'host');
  $('host-name').value = recipe?.host?.name ?? '';
  $('host-user').value = recipe?.host?.user ?? '';
  $('host-port').value = recipe?.host?.port && recipe.host.port !== 22 ? String(recipe.host.port) : '';
  $('auth').value = recipe?.host?.auth ?? 'key';
  trusted = (recipe?.host?.keys ?? []).map(line => ({ line, fingerprint: fingerprintOf(recipe, line) }));
  seen = [];
  $('host-password').value = '';
  $('install-password').value = '';
  $('connect').value = recipe?.connect ?? '';
  $('commands').value = recipe?.commands ?? '';
  pick('log', recipe?.log?.mode ?? 'output');
  $('log-path').value = recipe?.log?.path ?? '';
  $('auto').checked = recipe ? recipe.auto : true;
  $('no-approval').checked = Boolean(recipe?.noApproval);
  $('position').value = String(recipe?.position ?? 10);
  $('stop-on-failure').checked = Boolean(recipe?.stopOnFailure);
  $('dry-output').hidden = true;
  showParts();
  enable();
}

/** The fingerprints of a saved recipe's host keys come with the state; a key without one is shown as its type. */
function fingerprintOf(recipe, line) {
  return recipe?.fingerprints?.[line] || line.split(' ')[1] || 'Host key';
}

/** Whether the form shows anything other than what is saved for the selected app. */
function edited() {
  const recipe = recipeFor(selected);
  if (!recipe) return true;
  const form = formInput();
  const lines = text => String(text ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '');
  const place = recipe.host ? 'host' : recipe.connect ? 'custom' : 'local';
  if (where() !== place) return true;
  if (recipe.host) {
    const host = form.host;
    const port = host.port ?? (host.auth === 'ssh' ? undefined : 22);
    if (host.name !== recipe.host.name || host.user !== recipe.host.user || port !== recipe.host.port || host.auth !== recipe.host.auth ||
        host.keys.join('\n') !== recipe.host.keys.join('\n') || form.password !== '') return true;
  }
  return form.connect.trim() !== recipe.connect || lines(form.commands) !== recipe.commands || form.log.mode !== recipe.log.mode ||
    (form.log.mode !== 'output' && form.log.path.trim() !== recipe.log.path) || form.auto !== recipe.auto || form.noApproval !== recipe.noApproval ||
    form.position !== recipe.position || form.stopOnFailure !== recipe.stopOnFailure;
}

function enable() {
  const usable = state.connection.connected && Boolean(selected) && !busy;
  $('fields').disabled = !state.connection.connected || busy;
  $('save').disabled = !usable;
  const recipe = recipeFor(selected);
  // Run now and Dry run use what is saved, so they are offered only while the form shows exactly that.
  const changed = Boolean(recipe) && edited();
  for (const id of ['run', 'dry-run']) {
    $(id).disabled = !usable || !recipe || recipe.stale || changed;
    $(id).title = changed ? 'Save your changes first: this uses the saved setup.' : '';
  }
  $('remove').disabled = !usable || !recipe;
  const host = typedHost();
  $('check-host').disabled = !usable || !host.name || !host.user;
  $('make-key').disabled = !usable;
  $('install-key').disabled = !usable || !trusted.length || !$('install-password').value;
}

function lastRunLine(recipe) {
  if (recipe.stale) return 'Saved while this computer was connected differently. Save it again to use it.';
  const place = recipe.host ? `${recipe.host.user ? `${recipe.host.user}@` : ''}${recipe.host.name}` : recipe.connect ? 'a connect command' : 'this computer';
  return [place, `order ${recipe.position}`, recipe.noApproval ? 'runs without approval' : 'asks before it runs', recipe.auto ? 'deploys when your change merges' : 'only when you start it'].join(' · ');
}

function lastRunResult(recipe) {
  if (!recipe.lastRun) return 'Not run yet';
  const when = new Date(recipe.lastRun.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const how = { done: 'Deployed', failed: 'Failed', timeout: 'Timed out', cancelled: 'Stopped', declined: 'Declined' }[recipe.lastRun.status] || 'Ended';
  return `${how} ${when}${Number.isInteger(recipe.lastRun.exitCode) && recipe.lastRun.exitCode !== 0 ? ` · exit code ${recipe.lastRun.exitCode}` : ''}`;
}

function render() {
  $('connection').textContent = state.connection.text || '';
  $('notice').textContent = state.message || '';
  $('notice').hidden = !state.message;
  // Every app 1904 lists, plus any app that still has a deploy saved here.
  const apps = new Map(state.apps.map(app => [app.id, app.name]));
  for (const recipe of state.recipes) if (!apps.has(recipe.appId)) apps.set(recipe.appId, recipe.appName);
  const select = $('app');
  const previous = selected && apps.has(selected) ? selected : undefined;
  select.replaceChildren(...[...apps].map(([id, name]) => {
    const option = node('option', '', recipeFor(id) ? `${name} (saved)` : name);
    option.value = id;
    return option;
  }));
  $('apps-empty').hidden = apps.size > 0;
  const next = previous ?? state.recipes[0]?.appId ?? [...apps.keys()][0];
  if (next) select.value = next;
  if (next !== selected || !previous) fill(next);
  else showParts();
  const ordered = [...state.recipes].sort((a, b) => a.position - b.position || a.appName.localeCompare(b.appName));
  $('saved-empty').hidden = ordered.length > 0;
  $('saved').replaceChildren(...ordered.map(recipe => {
    const item = node('li', 'saved');
    item.dataset.last = recipe.lastRun?.status || '';
    const edit = node('button', '', 'Edit');
    edit.type = 'button';
    edit.addEventListener('click', () => { $('app').value = recipe.appId; fill(recipe.appId); $('commands').focus(); });
    item.append(node('span', 'saved-name', recipe.appName), node('span', 'saved-detail', lastRunLine(recipe)), node('span', 'saved-last', lastRunResult(recipe)), edit);
    return item;
  }));
  enable();
}

async function act(channel, ...args) {
  if (busy) return undefined;
  busy = true;
  enable();
  try {
    const answer = await ipcRenderer.invoke(channel, ...args);
    if (answer?.state) state = answer.state;
    return answer;
  } catch {
    return { ok: false, error: 'Something went wrong. Try again.' };
  } finally {
    busy = false;
    render();
  }
}

async function load() {
  try {
    const next = await ipcRenderer.invoke('1904:deploy-state');
    if (next) state = next;
  } catch { /* the connection line says what is known */ }
  render();
}

/** The host in the form changed: an identity trusted for another host or port no longer applies. */
function hostEdited() {
  trusted = [];
  seen = [];
  showParts();
  enable();
}

window.addEventListener('DOMContentLoaded', () => {
  $('app').addEventListener('change', () => { say(''); fill($('app').value); });
  for (const id of ['host-name', 'host-port']) $(id).addEventListener('input', hostEdited);
  $('auth').addEventListener('change', () => { showParts(); enable(); });
  for (const name of ['where', 'log']) for (const input of document.querySelectorAll(`input[name="${name}"]`)) input.addEventListener('change', showParts);
  // Any edit takes Run now and Dry run away until it is saved.
  $('form').addEventListener('input', enable);
  $('form').addEventListener('change', enable);

  $('check-host').addEventListener('click', async () => {
    say('Asking the host who it is…');
    const answer = await act('1904:deploy-check-host', typedHost());
    if (!answer) return;
    if (!answer.ok) return say(answer.error || 'Could not check the host.', 'error');
    trusted = [];
    seen = answer.keys;
    showParts();
    enable();
    say('Compare the identity below, then choose Trust this host.');
  });
  $('trust-host').addEventListener('click', () => {
    trusted = seen;
    seen = [];
    showParts();
    enable();
    say('Trusted. Save to keep it.');
  });
  $('make-key').addEventListener('click', async () => {
    say('Making a key…');
    const answer = await act('1904:deploy-make-key', selected);
    if (answer) say(answer.ok ? 'Key created. Add it on the host: with your password below, or with the command.' : answer.error || 'Could not make a key.', answer.ok ? 'ok' : 'error');
  });
  $('install-key').addEventListener('click', async () => {
    const password = $('install-password').value;
    $('install-password').value = '';
    say('Adding the key on the host…');
    const answer = await act('1904:deploy-install-key', selected, { ...typedHost(), keys: trusted.map(key => key.line) }, password);
    if (answer) say(answer.ok ? 'The key is on the host. Your password was not kept. Save, then try a dry run.' : answer.error || 'Could not add the key.', answer.ok ? 'ok' : 'error');
  });
  $('copy-install').addEventListener('click', () => {
    ipcRenderer.send('1904:deploy-copy-install', selected);
    say('Copied. Run it on the host as that user.', 'ok');
  });
  $('save').addEventListener('click', async () => {
    say('Saving…');
    const input = formInput();
    $('host-password').value = '';
    const answer = await act('1904:deploy-save', selected, input);
    if (!answer) return;
    if (answer.ok) { fill(selected); say(answer.warning || 'Saved on this computer.', answer.warning ? 'error' : 'ok'); }
    else say(answer.cancelled ? 'Not saved.' : answer.error || 'Could not save.', answer.cancelled ? '' : 'error');
  });
  $('dry-run').addEventListener('click', async () => {
    $('dry-output').hidden = true;
    const answer = await act('1904:deploy-dry-run', selected);
    if (answer) say(answer.ok ? 'Checking on the host. Nothing is being run…' : answer.error || 'Could not start.', answer.ok ? '' : 'error');
  });
  $('run').addEventListener('click', async () => {
    const answer = await act('1904:deploy-run', selected);
    if (!answer) return;
    say(answer.ok ? 'Started. Computer Activity shows it running.' : answer.error || 'Could not start.', answer.ok ? 'ok' : 'error');
  });
  $('remove').addEventListener('click', async () => {
    const answer = await act('1904:deploy-remove', selected);
    if (!answer) return;
    if (answer.ok) { fill(selected); say('Removed from this computer.', 'ok'); }
    else if (!answer.cancelled) say(answer.error || 'Could not remove.', 'error');
  });
  void load();
});

ipcRenderer.on('1904:deploy-state', (_event, next) => {
  if (!next || busy) return;
  state = next;
  render();
});
ipcRenderer.on('1904:deploy-dry-run-result', (_event, result) => {
  if (!result || result.appId !== selected) return;
  $('dry-output').textContent = result.output || 'The host said nothing.';
  $('dry-output').hidden = false;
  say(result.ok ? 'Dry run: nothing found that would stop a deploy.' : 'Dry run: something would stop a deploy. See below.', result.ok ? 'ok' : 'error');
});
ipcRenderer.on('1904:deploy-theme', (_event, theme) => {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
});
