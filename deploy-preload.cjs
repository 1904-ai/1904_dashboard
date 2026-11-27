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
let activeAction = '';
/** The host identity the person trusted for the host in the form, and what the last check showed. */
let trusted = [];
let seen = [];
/** Build commands the last dry run suggested for the selected app, until they are added or the app changes. */
let suggested;
/** A new setup starts with the one command every one of them needs. */
const FIRST_COMMAND = 'git pull --ff-only';
/** The last deploy key added on a host in this window session: `{ appId, publicKey, target }`. */
let installedKey;
let copyTimer;

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
const appFor = appId => state.apps.find(app => app.id === appId);
const keptFor = appId => state.kept?.[appId] ?? { password: false, publicKey: '', installCommand: '' };
const checked = name => document.querySelector(`input[name="${name}"]:checked`)?.value;
const logMode = () => checked('log') || 'output';
const where = () => checked('where') || 'host';
const pick = (name, value) => { for (const input of document.querySelectorAll(`input[name="${name}"]`)) input.checked = input.value === value; };

function say(text, kind = '') {
  $('status').textContent = text || '';
  $('status').dataset.kind = kind;
}

function hostTarget(host) {
  const who = `${host.user ? `${host.user}@` : ''}${host.name || ''}`;
  if (!who) return 'the host';
  return host.port && host.port !== 22 ? `${who}:${host.port}` : who;
}

function setFeedback(id, { kind = '', title = '', detail = '' } = {}) {
  const box = $(id);
  const titleEl = $(`${id}-title`);
  const detailEl = $(`${id}-detail`);
  if (!title) {
    box.hidden = true;
    box.dataset.kind = '';
    box.setAttribute('role', 'status');
    titleEl.textContent = '';
    detailEl.textContent = '';
    detailEl.hidden = true;
    return;
  }
  box.hidden = false;
  box.dataset.kind = kind;
  box.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  titleEl.textContent = title;
  detailEl.textContent = detail || '';
  detailEl.hidden = !detail;
}

function resetCopyNotice() {
  if (copyTimer) {
    clearTimeout(copyTimer);
    copyTimer = undefined;
  }
  const button = $('copy-install');
  button.textContent = 'Copy the command';
  delete button.dataset.copied;
}

function clearBoxFeedback() {
  setFeedback('identity-feedback');
  setFeedback('key-feedback');
  setFeedback('run-feedback');
  resetCopyNotice();
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
    connect: place === 'custom' ? $('connect').value : '', folder: place === 'local' ? '' : $('folder').value, commands: $('commands').value,
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
  // A host has a folder to name. On this computer the commands start in the app's own folder, set in Computer Activity.
  $('folder-fields').hidden = place === 'local';
  const repo = recipeFor(selected)?.repo || state.apps.find(app => app.id === selected)?.repo;
  $('folder-hint').textContent = `Where this app’s code is on the host: a git checkout of ${repo ? `its repository (${repo})` : 'its repository'}. The commands start there. `
    + 'Dry run checks that the folder is that checkout and that the host can pull without typing a password.';
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
  const cloneUrl = appFor(selected)?.cloneUrl || '';
  $('repo-url-box').hidden = !cloneUrl;
  $('repo-clone-url').textContent = cloneUrl;
  const host = typedHost();
  const target = hostTarget(host);
  $('identity-text').textContent = trusted.length
    ? 'You trusted this host. A deploy stops if the host ever shows a different identity.'
    : seen.length ? 'This is what the host shows. Compare it with what its owner gave you, or with the host itself, before you trust it.'
      : 'Check the host to see its identity. A deploy only connects to a host that shows exactly the identity you trusted.';
  $('identity-keys').replaceChildren(...(trusted.length ? trusted : seen).map(key => node('li', '', key.fingerprint)));
  $('trust-host').hidden = trusted.length > 0 || seen.length === 0;
  $('check-host-label').textContent = activeAction === 'check-host' ? 'Checking host…' : trusted.length ? 'Check again' : 'Check host';
  $('key-text').textContent = kept.publicKey
    ? `This app has a deploy key (${kept.publicKey.split(' ').slice(0, 2).join(' ').slice(0, 44)}…). Add it on the host once.`
    : 'No key yet. Create one, then add it on the host.';
  $('make-key-label').textContent = activeAction === 'make-key'
    ? (kept.publicKey ? 'Replacing key…' : 'Creating key…')
    : (kept.publicKey ? 'Replace key' : 'Create deploy key');
  const addedHere = Boolean(kept.publicKey && installedKey && installedKey.appId === selected && installedKey.publicKey === kept.publicKey && installedKey.target === target);
  $('key-added-badge').hidden = !addedHere;
  $('key-install').hidden = !kept.publicKey;
  $('key-manual').hidden = !kept.publicKey;
  $('install-command').textContent = kept.installCommand || '';
  const trustNote = $('key-trust-note');
  if (kept.publicKey && !trusted.length) {
    trustNote.textContent = 'Check and trust the host identity above before using Add key.';
    trustNote.hidden = false;
  } else if (kept.publicKey && !host.user) {
    trustNote.textContent = 'Enter a user name above before using Add key.';
    trustNote.hidden = false;
  } else {
    trustNote.textContent = '';
    trustNote.hidden = true;
  }
  $('install-password').placeholder = !trusted.length
    ? 'Trust the host identity above first'
    : !host.user ? 'Enter a user name above first' : 'Password for the host';
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
  $('folder').value = recipe?.folder ?? '';
  $('commands').value = recipe?.commands ?? FIRST_COMMAND;
  suggested = undefined;
  $('suggest-box').hidden = true;
  pick('log', recipe?.log?.mode ?? 'output');
  $('log-path').value = recipe?.log?.path ?? '';
  $('auto').checked = recipe ? recipe.auto : true;
  $('no-approval').checked = Boolean(recipe?.noApproval);
  $('position').value = String(recipe?.position ?? 10);
  $('stop-on-failure').checked = Boolean(recipe?.stopOnFailure);
  $('dry-output').hidden = true;
  clearBoxFeedback();
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
  return form.connect.trim() !== recipe.connect || form.folder.trim().replace(/(.)\/+$/, '$1') !== (recipe.folder ?? '') || lines(form.commands) !== recipe.commands || form.log.mode !== recipe.log.mode ||
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
  renderSteps();
  const host = typedHost();
  const canInstallTarget = trusted.length > 0 && Boolean(host.user);
  $('check-host').disabled = !usable || !host.name || !host.user;
  $('check-host').setAttribute('aria-busy', String(activeAction === 'check-host'));
  $('make-key').disabled = !usable;
  $('make-key').setAttribute('aria-busy', String(activeAction === 'make-key'));
  $('install-password').disabled = !usable || !canInstallTarget;
  $('install-key').disabled = !usable || !canInstallTarget || !$('install-password').value;
  $('install-key').setAttribute('aria-busy', String(activeAction === 'install-key'));
  $('install-key-label').textContent = activeAction === 'install-key' ? 'Adding key…' : 'Add key';
  $('save').textContent = activeAction === 'save' ? 'Saving…' : 'Save';
  $('dry-run').textContent = activeAction === 'dry-run' ? 'Checking…' : 'Dry run';
  $('run').textContent = activeAction === 'run' ? 'Starting…' : 'Run now';
  $('remove').textContent = activeAction === 'remove' ? 'Removing…' : 'Remove';
}

const when = at => new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/**
 * What is left before a merged change can deploy by itself, for the selected app: saved, checked on the host, and
 * run once for real. Each line says what to do next or what was found, so nobody has to guess whether it will work.
 */
function setupSteps(recipe, changed) {
  if (!recipe) {
    return [
      { state: 'todo', name: 'Save the setup', text: 'Fill in where the commands run, the app folder and the commands, then choose Save.' },
      { state: 'todo', name: 'Check it on the host', text: 'Dry run looks at the folder, git, the repository and your tools. It runs none of your commands.' },
      { state: 'todo', name: 'Test a deploy', text: 'Run now pulls and builds once, so you know it works before a merge relies on it.' },
    ];
  }
  if (recipe.stale) return [{ state: 'problem', name: 'Save it again', text: 'This was saved while the computer was connected differently, so it cannot run until you save it again.' }];
  const remote = Boolean(recipe.host || recipe.connect);
  const steps = [{
    state: changed ? 'todo' : 'ok', name: changed ? 'Save your changes' : 'Saved on this computer',
    text: changed ? 'The checks below are for the setup as it was last saved.'
      : remote && !recipe.folder ? 'No app folder is set, so the commands start in the host user’s home folder and Dry run cannot check git there.' : '',
  }];
  const check = recipe.ready?.checked ?? 'todo';
  steps.push(!remote && state.platform === 'windows'
    ? { state: 'todo', name: 'Check it', text: 'A dry run needs a host or a Mac. On this computer, Run now is the test.' }
    : check === 'ok' ? { state: 'ok', name: 'Checked on the host', text: `Dry run found nothing that would stop a deploy, ${when(recipe.lastCheck.at)}.` }
      : check === 'problem' ? { state: 'problem', name: 'The host needs fixing', text: `Dry run found something that would stop a deploy, ${when(recipe.lastCheck.at)}. Fix it, then choose Dry run again.` }
        : { state: 'todo', name: 'Check it on the host', text: 'Choose Dry run: it looks at the folder, git, the repository and your tools, and runs none of your commands.' });
  const test = recipe.ready?.tested ?? 'todo';
  steps.push(test === 'ok' ? { state: 'ok', name: 'Deploy tested', text: `These commands ran to the end, ${when(recipe.lastRun.at)}.` }
    : test === 'problem' ? { state: 'problem', name: 'The last deploy did not finish', text: `${lastRunResult(recipe)}${recipe.lastRun?.message ? ` — ${recipe.lastRun.message}` : ''}. Computer Activity keeps the full output. Fix it, then choose Run now.` }
      : { state: 'todo', name: 'Test a deploy', text: 'Choose Run now once: it pulls and builds for real, so you know it works before a merge relies on it.' });
  steps.push({
    state: recipe.auto ? (check === 'ok' && test === 'ok' ? 'ok' : 'todo') : 'todo',
    name: recipe.auto ? 'Deploys when your change merges' : 'Deploys only when you start it',
    text: !recipe.auto ? 'Turn on “Deploy when a change of mine merges” to deploy after each merge.'
      : check === 'ok' && test === 'ok' ? (recipe.noApproval ? 'Runs without asking on this computer.' : 'This computer asks you first, then runs the commands.')
        : 'It will be asked to, but the steps above are not done yet, so the first merge is also the first test.',
  });
  return steps;
}

function renderSteps() {
  const recipe = recipeFor(selected);
  const marks = { ok: '✓', problem: '!', todo: '○' };
  const said = { ok: 'Done', problem: 'Needs attention', todo: 'To do' };
  $('steps').hidden = !selected;
  $('steps').replaceChildren(...setupSteps(recipe, Boolean(recipe) && edited()).map(step => {
    const item = node('li');
    item.dataset.state = step.state;
    const mark = node('span', 'mark', marks[step.state]);
    mark.setAttribute('aria-label', said[step.state]);
    item.append(mark, node('span', 'step-name', step.name));
    if (step.text) item.append(node('span', 'step-text', step.text));
    return item;
  }));
}

function showSuggestion() {
  const shown = Boolean(suggested?.lines?.length);
  $('suggest-box').hidden = !shown;
  if (!shown) return;
  $('suggest-text').textContent = `From what is in the app folder (${suggested.from.join(', ')}). Read them, change what does not fit, then Save.`
    + (suggested.restart ? ' Then add the command that restarts your app, such as sudo systemctl restart my-app or pm2 reload my-app, if nothing here does that.' : '');
  $('suggest-lines').textContent = suggested.lines.join('\n');
}

function lastRunLine(recipe) {
  if (recipe.stale) return 'Saved while this computer was connected differently. Save it again to use it.';
  const place = recipe.host ? `${recipe.host.user ? `${recipe.host.user}@` : ''}${recipe.host.name}` : recipe.connect ? 'a connect command' : 'this computer';
  return [place, `order ${recipe.position}`, recipe.noApproval ? 'runs without approval' : 'asks before it runs', recipe.auto ? 'deploys when your change merges' : 'only when you start it'].join(' · ');
}

function lastRunResult(recipe) {
  if (!recipe.lastRun) return 'Not run yet';
  const how = { done: 'Deployed', failed: 'Failed', timeout: 'Timed out', cancelled: 'Stopped', declined: 'Declined' }[recipe.lastRun.status] || 'Ended';
  return `${how} ${when(recipe.lastRun.at)}${Number.isInteger(recipe.lastRun.exitCode) && recipe.lastRun.exitCode !== 0 ? ` · exit code ${recipe.lastRun.exitCode}` : ''}`;
}

function render() {
  $('connection').textContent = state.connection.text || '';
  $('notice').textContent = state.message || '';
  $('notice').hidden = !state.message;
  // Every app 1904 lists, plus any app that still has a deploy saved here.
  const apps = new Map(state.apps.map(app => [app.id, app.name]));
  for (const recipe of state.recipes) if (!apps.has(recipe.appId)) apps.set(recipe.appId, recipe.appName);
  const select = $('app');
  const requested = state.selectedAppId && apps.has(state.selectedAppId) ? state.selectedAppId : undefined;
  if (state.selectedAppId) delete state.selectedAppId;
  const previous = selected && apps.has(selected) ? selected : undefined;
  select.replaceChildren(...[...apps].map(([id, name]) => {
    const option = node('option', '', recipeFor(id) ? `${name} (saved)` : name);
    option.value = id;
    return option;
  }));
  $('apps-empty').hidden = apps.size > 0;
  const next = requested ?? previous ?? state.recipes[0]?.appId ?? [...apps.keys()][0];
  if (next) select.value = next;
  if (next !== selected || !previous || requested) fill(next);
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

async function act(action, channel, ...args) {
  if (busy) return undefined;
  busy = true;
  activeAction = action;
  showParts();
  enable();
  try {
    const answer = await ipcRenderer.invoke(channel, ...args);
    if (answer?.state) state = answer.state;
    return answer;
  } catch {
    return { ok: false, error: 'Something went wrong. Try again.' };
  } finally {
    busy = false;
    activeAction = '';
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
  if (installedKey?.appId === selected) installedKey = undefined;
  setFeedback('identity-feedback');
  setFeedback('key-feedback');
  showParts();
  enable();
}

function userEdited() {
  if (installedKey?.appId === selected && installedKey.target !== hostTarget(typedHost())) installedKey = undefined;
  setFeedback('key-feedback');
  showParts();
  enable();
}

async function installKey() {
  if ($('install-key').disabled) return;
  const password = $('install-password').value;
  const host = typedHost();
  const target = hostTarget(host);
  $('install-password').value = '';
  say('');
  setFeedback('key-feedback', {
    kind: 'pending',
    title: `Connecting to ${target}…`,
    detail: 'Adding the deploy key on the host. Your password will not be saved.',
  });
  const answer = await act('install-key', '1904:deploy-install-key', selected, { ...host, keys: trusted.map(key => key.line) }, password);
  if (!answer) return;
  if (answer.ok) {
    installedKey = { appId: selected, publicKey: keptFor(selected).publicKey, target };
    showParts();
    setFeedback('key-feedback', {
      kind: 'ok',
      title: `Deploy key added to ${target}`,
      detail: 'Your password was not kept. Save below, then try Dry run to confirm the connection.',
    });
  } else {
    setFeedback('key-feedback', {
      kind: 'error',
      title: 'Could not add the deploy key',
      detail: answer.error || 'Could not add the key on the host.',
    });
    if (!$('install-password').disabled) $('install-password').focus();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  $('form').addEventListener('submit', event => event.preventDefault());
  $('app').addEventListener('change', () => { say(''); fill($('app').value); });
  for (const id of ['host-name', 'host-port']) $(id).addEventListener('input', hostEdited);
  $('host-user').addEventListener('input', userEdited);
  $('auth').addEventListener('change', () => { showParts(); enable(); });
  for (const name of ['where', 'log']) for (const input of document.querySelectorAll(`input[name="${name}"]`)) input.addEventListener('change', showParts);
  // Any edit takes Run now and Dry run away until it is saved.
  $('form').addEventListener('input', enable);
  $('form').addEventListener('change', enable);
  $('install-password').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void installKey();
    }
  });

  $('check-host').addEventListener('click', async () => {
    const host = typedHost();
    say('');
    setFeedback('identity-feedback', {
      kind: 'pending',
      title: `Checking ${hostTarget(host)}…`,
      detail: 'Reading the host identity without signing in.',
    });
    const answer = await act('check-host', '1904:deploy-check-host', host);
    if (!answer) return;
    if (!answer.ok) {
      setFeedback('identity-feedback', {
        kind: 'error',
        title: 'Could not check the host',
        detail: answer.error || 'Could not check the host.',
      });
      return;
    }
    trusted = [];
    seen = answer.keys;
    setFeedback('identity-feedback');
    showParts();
    enable();
  });
  $('trust-host').addEventListener('click', () => {
    trusted = seen;
    seen = [];
    showParts();
    enable();
    setFeedback('identity-feedback', {
      kind: 'ok',
      title: 'Host identity trusted',
      detail: 'Save below to keep it.',
    });
  });
  $('make-key').addEventListener('click', async () => {
    const hadKey = Boolean(keptFor(selected).publicKey);
    say('');
    setFeedback('key-feedback', {
      kind: 'pending',
      title: hadKey ? 'Replacing deploy key…' : 'Creating deploy key…',
      detail: 'Generating an ed25519 key pair in this computer’s secure storage.',
    });
    const answer = await act('make-key', '1904:deploy-make-key', selected);
    if (!answer) return;
    if (answer.ok) {
      if (installedKey?.appId === selected) installedKey = undefined;
      showParts();
      setFeedback('key-feedback', {
        kind: 'ok',
        title: hadKey ? 'New deploy key created' : 'Deploy key created',
        detail: 'Add it on the host with your password below, or run the command on the host.',
      });
    } else {
      setFeedback('key-feedback', {
        kind: 'error',
        title: hadKey ? 'Could not replace the deploy key' : 'Could not create the deploy key',
        detail: answer.error || 'Could not make a key.',
      });
    }
  });
  $('install-key').addEventListener('click', () => { void installKey(); });
  $('copy-install').addEventListener('click', () => {
    ipcRenderer.send('1904:deploy-copy-install', selected);
    resetCopyNotice();
    const button = $('copy-install');
    button.textContent = 'Copied to clipboard';
    button.dataset.copied = 'true';
    copyTimer = setTimeout(resetCopyNotice, 2500);
  });
  $('copy-clone-url').addEventListener('click', () => {
    ipcRenderer.send('1904:deploy-copy-clone-url', selected);
    say('Copied the repository URL.', 'ok');
  });
  $('save').addEventListener('click', async () => {
    say('Saving…');
    const input = formInput();
    $('host-password').value = '';
    const answer = await act('save', '1904:deploy-save', selected, input);
    if (!answer) return;
    if (answer.ok) { fill(selected); say(answer.warning || 'Saved on this computer.', answer.warning ? 'error' : 'ok'); }
    else say(answer.cancelled ? 'Not saved.' : answer.error || 'Could not save.', answer.cancelled ? '' : 'error');
  });
  $('suggest-use').addEventListener('click', () => {
    if (!suggested?.lines?.length) return;
    const current = $('commands').value.replace(/\s+$/, '');
    $('commands').value = `${current}${current ? '\n' : ''}${suggested.lines.join('\n')}`;
    suggested = undefined;
    showSuggestion();
    enable();
    $('commands').focus();
    say('Added. Read them, then Save.');
  });
  $('dry-run').addEventListener('click', async () => {
    $('dry-output').hidden = true;
    $('dry-output').textContent = '';
    suggested = undefined;
    showSuggestion();
    say('');
    setFeedback('run-feedback', {
      kind: 'pending',
      title: 'Running dry run…',
      detail: 'Checking the connection, folder, git, and commands on the host without running your commands.',
    });
    const answer = await act('dry-run', '1904:deploy-dry-run', selected);
    if (!answer) return;
    if (!answer.ok) {
      setFeedback('run-feedback', {
        kind: 'error',
        title: 'Dry run could not start',
        detail: answer.error || 'Could not start.',
      });
      say(answer.error || 'Could not start.', 'error');
    } else {
      say('Checking on the host. Nothing is being run…');
    }
  });
  $('run').addEventListener('click', async () => {
    $('dry-output').hidden = true;
    $('dry-output').textContent = '';
    suggested = undefined;
    showSuggestion();
    say('');
    setFeedback('run-feedback', {
      kind: 'pending',
      title: 'Running deploy…',
      detail: 'Output and any error messages will appear here when it finishes. Computer Activity also shows live output.',
    });
    const answer = await act('run', '1904:deploy-run', selected);
    if (!answer) return;
    if (!answer.ok) {
      setFeedback('run-feedback', {
        kind: 'error',
        title: 'Deploy could not start',
        detail: answer.error || 'Could not start.',
      });
      say(answer.error || 'Could not start.', 'error');
    } else {
      say('Started. Computer Activity shows it running.', 'ok');
    }
  });
  $('remove').addEventListener('click', async () => {
    const answer = await act('remove', '1904:deploy-remove', selected);
    if (!answer) return;
    if (answer.ok) {
      if (installedKey?.appId === selected) installedKey = undefined;
      fill(selected);
      say('Removed from this computer.', 'ok');
    } else if (!answer.cancelled) say(answer.error || 'Could not remove.', 'error');
  });
  void load();
});

ipcRenderer.on('1904:deploy-state', (_event, next) => {
  if (!next || busy) return;
  state = next;
  render();
});
ipcRenderer.on('1904:deploy-select', (_event, appId) => {
  if (typeof appId !== 'string' || !appId) return;
  const known = state.apps.some(app => app.id === appId) || state.recipes.some(recipe => recipe.appId === appId);
  if (!known) {
    state.selectedAppId = appId;
    return;
  }
  $('app').value = appId;
  say('');
  fill(appId);
});
ipcRenderer.on('1904:deploy-dry-run-result', (_event, result) => {
  if (!result || result.appId !== selected) return;
  const output = result.output || result.message || 'The host returned no output.';
  $('dry-output').setAttribute('aria-label', 'What the dry run found');
  $('dry-output').textContent = output;
  $('dry-output').hidden = false;
  // Only fixed lines the main process chose from what the folder holds: text, never markup, and never added without a click.
  suggested = result.suggested && Array.isArray(result.suggested.lines) ? result.suggested : undefined;
  showSuggestion();
  setFeedback('run-feedback', result.ok
    ? { kind: 'ok', title: 'Dry run passed', detail: 'Nothing found that would stop a deploy. No command was run.' }
    : {
      kind: 'error',
      title: Number.isInteger(result.exitCode) && result.exitCode !== 0 ? `Dry run failed (exit code ${result.exitCode})` : 'Dry run failed',
      detail: result.message || 'See the captured output and errors below.',
    });
  say(result.ok ? 'Dry run: nothing found that would stop a deploy.' : (result.message || 'Dry run: something would stop a deploy. See below.'), result.ok ? 'ok' : 'error');
});
ipcRenderer.on('1904:deploy-run-result', (_event, result) => {
  if (!result || result.appId !== selected) return;
  const output = result.output || result.message || '';
  $('dry-output').setAttribute('aria-label', 'Deploy output and errors');
  $('dry-output').textContent = output || (result.ok ? 'The commands finished with no output.' : 'No error output was returned.');
  $('dry-output').hidden = false;
  const statusLabel = { done: 'Deploy finished', failed: 'Deploy failed', timeout: 'Deploy timed out', cancelled: 'Deploy stopped', declined: 'Deploy declined' }[result.status] || (result.ok ? 'Deploy finished' : 'Deploy did not finish');
  const codeSuffix = !result.ok && Number.isInteger(result.exitCode) && result.exitCode !== 0 ? ` (exit code ${result.exitCode})` : '';
  setFeedback('run-feedback', result.ok
    ? { kind: 'ok', title: 'Deploy finished', detail: 'The deploy commands ran to the end.' }
    : {
      kind: 'error',
      title: `${statusLabel}${codeSuffix}`,
      detail: result.message || 'See the captured output and error messages below.',
    });
  say(result.ok ? 'Deploy finished.' : (result.message || `${statusLabel}${codeSuffix}. See output below.`), result.ok ? 'ok' : 'error');
});
ipcRenderer.on('1904:deploy-theme', (_event, theme) => {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
});
