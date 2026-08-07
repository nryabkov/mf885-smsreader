// MF885_LOADER_STABLE_MARKER
// MF885 SMS Reader commit-pinned updater and launcher for Scriptable.

const LOADER_PROTOCOL = 2;
const DEFAULT_CONFIG = {
  repositoryOwner: "nryabkov",
  repositoryName: "mf885-smsreader",
  branch: "main",
  routerAddress: "192.168.21.1",
  storage: "local",
  pollSeconds: 30,
  debug: true,
  debugSensitivePayloads: false,
  skipSmsContentLog: true,
  translationEndpoint: "",
  translationTarget: "en",
  showExperimentalControls: true,
  locale: "en",
  compatibilityProfile: "2.5.96",
  compatibilityProfileOverride: "",
  xmlRequestPath: "/xml_action.cgi",
  telnetPortCheckTimeoutMs: 1000,
  telnetPortCheckRetries: 2
};
const MARKER = "MF885_LOADER_STABLE_MARKER";
const SHA_RE = /^[0-9a-f]{40}$/i;
const GITHUB_TIMEOUT_SECONDS = 30;

function commitApiUrl(config) {
  return `https://api.github.com/repos/${encodeURIComponent(config.repositoryOwner)}/${encodeURIComponent(config.repositoryName)}/commits/${encodeURIComponent(config.branch)}`;
}

function rawBaseUrl(config, sha) {
  assertSha(sha);
  return `https://raw.githubusercontent.com/${encodeURIComponent(config.repositoryOwner)}/${encodeURIComponent(config.repositoryName)}/${sha}/`;
}

function artifactUrls(config, sha, manifest) {
  const base = rawBaseUrl(config, sha);
  return {
    manifest: `${base}manifest.json`,
    loader: base + manifest.loader,
    files: manifest.files.map(path => base + path)
  };
}

function assertSha(value) {
  if (typeof value !== "string" || !SHA_RE.test(value)) throw new Error("GitHub returned a malformed commit SHA");
  return value.toLowerCase();
}

function safeRelativePath(path) {
  return typeof path === "string" && path.length > 0 && path.length < 300 &&
    /^[A-Za-z0-9_.\/-]+$/.test(path) && !path.startsWith("/") &&
    !path.split("/").some(part => part === ".." || part === "");
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new Error("Manifest is not an object");
  if (!safeRelativePath(manifest.loader)) throw new Error("Manifest loader path is unsafe or missing");
  if (!safeRelativePath(manifest.entry)) throw new Error("Manifest entry path is unsafe or missing");
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error("Manifest files must be a non-empty list");
  if (!manifest.files.every(safeRelativePath)) throw new Error("Manifest contains an unsafe application path");
  if (!manifest.files.includes(manifest.entry)) throw new Error("Manifest entry is not in files");
  if (manifest.files.includes(manifest.loader)) throw new Error("The loader must be separate from application files");
  for (const field of ["loaderProtocol", "minimumLoaderProtocol"]) {
    if (!Number.isInteger(manifest[field]) || manifest[field] < 1) throw new Error(`Manifest ${field} is invalid`);
  }
  if (manifest.minimumLoaderProtocol > manifest.loaderProtocol) throw new Error("Manifest protocol range is invalid");
  return manifest;
}

function validState(state) {
  if (!state || typeof state !== "object" || !["active", "pending-restart"].includes(state.status)) return false;
  if (state.activeSha !== null && !SHA_RE.test(state.activeSha || "")) return false;
  if (state.pendingSha !== null && !SHA_RE.test(state.pendingSha || "")) return false;
  return Number.isInteger(state.loaderProtocol) && state.loaderProtocol > 0;
}

function synchronizationNeeded(remoteSha, state, artifactsPresent) {
  assertSha(remoteSha);
  return !validState(state) || state.activeSha !== remoteSha || !artifactsPresent;
}

function abbreviate(sha) { return sha ? sha.slice(0, 7) : "unknown"; }

function requestHeaders(token, githubApi) {
  const headers = {
    Accept: githubApi ? "application/vnd.github+json" : "application/octet-stream",
    "User-Agent": "MF885-SMS-Reader-Scriptable",
    "Cache-Control": "no-cache, no-store, must-revalidate"
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (githubApi) headers["X-GitHub-Api-Version"] = "2022-11-28";
  return headers;
}

async function main() {
  const local = FileManager.local();
  const configPath = local.joinPath(local.documentsDirectory(), "mf885-smsreader-config.json");
  const config = readConfig(local, configPath);
  const fm = config.storage === "icloud" ? FileManager.iCloud() : local;
  const root = fm.documentsDirectory();
  const appDir = fm.joinPath(root, "mf885-smsreader");
  const statePath = fm.joinPath(root, "mf885-smsreader-sync-state.json");
  const legacyPath = fm.joinPath(appDir, "installed-version.txt");
  const tokenKey = "mf885_github_token";
  const token = Keychain.contains(tokenKey) ? Keychain.get(tokenKey) : "";
  let state = readState(fm, statePath);

  const loader = discoverLoader();
  state = recoverInterruptedLoader(loader, fm, statePath, state);
  let manifest = null;
  let syncWarning = null;
  try {
    await showSyncProgress("Checking for dashboard updates…");
    console.log("[Sync] Looking up configured branch HEAD on GitHub...");
    const sha = await lookupHead(config, token);
    console.log(`[Sync] Loading manifest for ${abbreviate(sha)}...`);
    manifest = validateManifest(await loadJson(rawBaseUrl(config, sha) + "manifest.json", token));
    const complete = applicationExists(fm, appDir, manifest);
    const legacy = !state && fm.fileExists(legacyPath);
    if (legacy) console.log("[Sync] Legacy installed-version.txt found; installed commit is unknown and a full synchronization is required.");
    if (state && state.status === "pending-restart" && state.pendingSha === sha && LOADER_PROTOCOL >= manifest.minimumLoaderProtocol) {
      await installApplication(fm, appDir, statePath, state, sha, manifest, artifactUrls(config, sha, manifest), token);
      state = readState(fm, statePath);
      if (fm.fileExists(legacyPath)) fm.remove(legacyPath);
      console.log(`[Sync] Activated pending application ${abbreviate(sha)} after loader restart.`);
    } else if (synchronizationNeeded(sha, state, complete)) {
      const result = await synchronize({ fm, appDir, statePath, legacyPath, state, sha, manifest, config, token, loader });
      state = result.state;
      if (result.restart) await showMessage("Loader updated; restart required", `Loader ${abbreviate(sha)} is installed. Run this script again to activate the compatible application.`);
    } else {
      console.log(`[Sync] Exact commit ${abbreviate(sha)} is already installed (loader and application complete).`);
    }
  } catch (error) {
    syncWarning = String(error.message || error);
    console.log(`[Sync warning] ${syncWarning}. Using the last complete local application when available.`);
  }

  state = readState(fm, statePath);
  const entry = state && safeRelativePath(state.entry) ? state.entry : "scriptable.js";
  const entryFile = safeDestination(fm, appDir, entry);
  if (!fm.fileExists(entryFile)) throw new Error(`Fatal installation error: no valid local application is available${syncWarning ? ` (${syncWarning})` : ""}`);
  await downloadICloud(fm, entryFile);
  const passwordKey = `mf885_router_password_${config.routerAddress}`;
  if (!Keychain.contains(passwordKey)) Keychain.set(passwordKey, "zimifi");
  const application = importModule(entryFile);
  if (!application || typeof application.run !== "function") throw new Error("The installed application does not export run(options)");
  await application.run({ ...normalizeConfig(config), ip: config.routerAddress, password: Keychain.get(passwordKey), moduleDirectory: appDir });
}

async function synchronize(context) {
  await showSyncProgress("Downloading and installing dashboard update…");
  const { fm, appDir, statePath, legacyPath, state, sha, manifest, config, token, loader } = context;
  const urls = artifactUrls(config, sha, manifest);
  console.log(`[Sync] Loading loader artifact for ${abbreviate(sha)}...`);
  const loaderCode = await loadString(urls.loader, token);
  validateLoader(loaderCode);
  const loaderChanged = !loader || loader.content !== loaderCode;
  console.log(`[Sync] Remote ${abbreviate(sha)} differs from active ${abbreviate(state && state.activeSha)}; loader ${loaderChanged ? "changed" : "unchanged"}, application snapshot will be staged.`);
  if (manifest.minimumLoaderProtocol > LOADER_PROTOCOL) {
    if (!loader) {
      console.log("[Sync warning] Loader path could not be identified and verified; application requiring a newer loader was not activated.");
      throw new Error("Self-update skipped: open the Scriptable loader and reinstall loader.js manually");
    }
    const replaced = await replaceLoader(loader, loaderCode);
    if (!replaced) throw new Error("Self-update skipped: restore the .mf885-backup file or reinstall loader.js manually");
    const pending = { activeSha: state ? state.activeSha : null, pendingSha: sha, loaderProtocol: manifest.loaderProtocol, status: "pending-restart", loaderBackup: loader.backupPath, entry: state && state.entry ? state.entry : "scriptable.js" };
    writeStateAtomic(fm, statePath, pending);
    return { state: pending, restart: true };
  }
  if (loaderChanged) {
    if (loader) {
      const replaced = await replaceLoader(loader, loaderCode);
      if (!replaced) console.log("[Sync warning] Self-update failed; continuing with the compatible application update and leaving the current loader installed.");
    } else console.log("[Sync warning] Self-update skipped because the active Scriptable loader path was not verified; application remains safe.");
  }
  try {
    await installApplication(fm, appDir, statePath, state, sha, manifest, urls, token);
  } catch (error) {
    if (loaderChanged && loader && loader.fm.fileExists(loader.backupPath)) {
      loader.fm.writeString(loader.path, loader.fm.readString(loader.backupPath));
      console.log(`[Sync] Application activation failed; loader rolled back to the prior copy and active commit remains ${abbreviate(state && state.activeSha)}.`);
    }
    throw error;
  }
  if (fm.fileExists(legacyPath)) fm.remove(legacyPath);
  console.log(`[Sync] Successfully activated loader/application revision ${abbreviate(sha)}${loaderChanged ? "; replacement loader takes effect next invocation" : ""}.`);
  return { state: readState(fm, statePath), restart: false };
}

async function installApplication(fm, appDir, statePath, priorState, sha, manifest, suppliedUrls, token) {
  const parent = appDir.slice(0, appDir.lastIndexOf("/"));
  const stage = `${appDir}.staging-${sha}`;
  const backup = `${appDir}.backup`;
  removeIfExists(fm, stage); ensureDirectory(fm, stage);
  try {
    const urls = suppliedUrls || artifactUrls(DEFAULT_CONFIG, sha, manifest);
    for (let i = 0; i < manifest.files.length; i++) {
      const destination = safeDestination(fm, stage, manifest.files[i]);
      ensureDirectory(fm, destination.slice(0, destination.lastIndexOf("/")));
      await showSyncProgress(`Downloading update file ${i + 1}/${manifest.files.length}…`);
      console.log(`[Sync] Downloading application file ${i + 1}/${manifest.files.length}: ${manifest.files[i]}`);
      const data = await loadString(urls.files[i], token);
      if (!data.trim()) throw new Error(`Downloaded empty application file ${manifest.files[i]}`);
      fm.writeString(destination, data);
    }
    if (!applicationExists(fm, stage, manifest)) throw new Error("Staged application is incomplete");
    removeIfExists(fm, backup);
    if (fm.fileExists(appDir)) fm.move(appDir, backup);
    try { fm.move(stage, appDir); }
    catch (error) { if (fm.fileExists(backup) && !fm.fileExists(appDir)) fm.move(backup, appDir); throw error; }
    const active = { activeSha: sha, pendingSha: null, loaderProtocol: LOADER_PROTOCOL, status: "active", entry: manifest.entry };
    try { writeStateAtomic(fm, statePath, active); }
    catch (error) {
      removeIfExists(fm, appDir); if (fm.fileExists(backup)) fm.move(backup, appDir);
      if (priorState) writeStateAtomic(fm, statePath, priorState);
      throw new Error(`State persistence failed; application rolled back: ${error}`);
    }
    removeIfExists(fm, backup);
  } catch (error) { removeIfExists(fm, stage); throw new Error(`Staged update failed: ${error}`); }
}

function applyRequestOptions(request, token, githubApi) {
  request.headers = requestHeaders(token, githubApi);
  // Scriptable supports timeoutInterval in current releases; keep the guard for older versions.
  if ("timeoutInterval" in request) request.timeoutInterval = GITHUB_TIMEOUT_SECONDS;
}

function describeNetworkFailure(operation, request, error) {
  const status = request.response && request.response.statusCode;
  if (status === 403 || status === 429) return `${operation} failed: GitHub rate limit reached; configure mf885_github_token or retry later`;
  if (status && status >= 500) return `${operation} failed: GitHub is unavailable (HTTP ${status}); retry later`;
  if (status && (status < 200 || status >= 300)) return `${operation} failed: GitHub returned HTTP ${status}`;
  const detail = String(error && (error.message || error));
  if (/internet|network|offline|timed? ?out|could not connect|not connected|dns|host/i.test(detail)) return `${operation} failed: no internet connection, DNS failure, or GitHub is unreachable (${detail})`;
  return `${operation} failed: ${detail}`;
}

async function showSyncProgress(message) {
  console.log(`[Sync] ${message}`);
  if (typeof Timer !== "undefined" && Timer.schedule) {
    await new Promise(resolve => { const timer = Timer.schedule(0.05, false, () => { timer.invalidate(); resolve(); }); });
  } else await Promise.resolve();
}

async function requestString(url, token, githubApi, operation) {
  const request = new Request(url); applyRequestOptions(request, token, githubApi);
  try {
    const body = await request.loadString();
    const status = request.response && request.response.statusCode;
    if (status && (status < 200 || status >= 300)) throw new Error(describeNetworkFailure(operation, request, "HTTP failure"));
    return body;
  } catch (error) {
    const message = String(error && (error.message || error));
    if (message.startsWith(`${operation} failed:`)) throw error;
    throw new Error(describeNetworkFailure(operation, request, error));
  }
}

async function lookupHead(config, token) {
  const text = await requestString(commitApiUrl(config), token, true, "GitHub commit lookup");
  let body;
  try { body = JSON.parse(text); }
  catch (error) { throw new Error(`GitHub commit lookup failed: malformed response from GitHub API (${error})`); }
  return assertSha(body && body.sha);
}

async function loadJson(url, token) {
  const text = await requestString(url, token, false, "Manifest loading");
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`Manifest loading failed: malformed response (${error})`); }
}
async function loadString(url, token) { return requestString(url, token, false, "Artifact download"); }
function validateLoader(code) { if (typeof code !== "string" || code.trim().length < 100 || !code.includes(MARKER)) throw new Error("Downloaded loader is empty, invalid, or lacks the stable marker"); }

function discoverLoader() {
  if (typeof Script === "undefined" || typeof Script.name !== "function") return null;
  const name = Script.name();
  for (const fm of [FileManager.local(), FileManager.iCloud()]) {
    const path = fm.joinPath(fm.documentsDirectory(), `${name}.js`);
    try {
      if (fm.fileExists(path)) {
        const content = fm.readString(path);
        if (content.includes(MARKER)) return { fm, path, content, backupPath: `${path}.mf885-backup` };
      }
    } catch (_) { /* try the other Scriptable storage provider */ }
  }
  return null;
}

async function replaceLoader(loader, code) {
  const { fm, path, backupPath } = loader;
  validateLoader(code);
  try {
    removeIfExists(fm, backupPath); fm.copy(path, backupPath);
    if (!fm.fileExists(backupPath)) throw new Error("loader backup was not created");
    // Never remove the active Scriptable file while it is running: transient absence can make
    // Scriptable drop the script from its list. Overwrite in place and keep the backup next to it.
    fm.writeString(path, code); validateLoader(fm.readString(path));
    console.log(`[Sync] Loader overwritten in place; backup saved as ${backupPath}.`);
    return true;
  } catch (error) {
    try { if (fm.fileExists(backupPath)) fm.writeString(path, fm.readString(backupPath)); }
    catch (rollbackError) { console.log(`[Sync warning] Loader rollback from backup failed: ${rollbackError}`); }
    console.log(`[Sync warning] Loader replacement failed; current application was not removed: ${error}`);
    return false;
  }
}

function recoverInterruptedLoader(loader, stateFm, statePath, state) {
  if (!state || state.status !== "pending-restart") return state;
  if (loader && loader.content.includes(MARKER)) return state;
  const backup = state.loaderBackup;
  if (backup && loader && loader.fm.fileExists(backup)) {
    loader.fm.writeString(loader.path, loader.fm.readString(backup));
    console.log("[Sync] Interrupted loader replacement rolled back from the last known-good backup.");
    return state;
  }
  console.log("[Sync warning] Pending loader replacement cannot be verified; restore the .mf885-backup file or reinstall loader.js manually.");
  return state;
}

function readConfig(fm, path) {
  if (!fm.fileExists(path)) { fm.writeString(path, JSON.stringify(DEFAULT_CONFIG, null, 2)); return { ...DEFAULT_CONFIG }; }
  try { return normalizeConfig({ ...DEFAULT_CONFIG, ...JSON.parse(fm.readString(path)) }); } catch (_) { console.log("[Sync warning] Configuration is corrupt; defaults are in memory only. Repair mf885-smsreader-config.json."); return { ...DEFAULT_CONFIG }; }
}
function normalizeConfig(value) {
  const config={...DEFAULT_CONFIG,...value};
  config.pollSeconds=Math.max(15,Math.min(300,Number(config.pollSeconds)||30));
  config.telnetPortCheckTimeoutMs=Math.max(250,Math.min(5000,Number(config.telnetPortCheckTimeoutMs)||1000));
  config.telnetPortCheckRetries=Math.max(1,Math.min(5,Math.trunc(Number(config.telnetPortCheckRetries)||2)));
  config.locale="en"; config.translationTarget=String(config.translationTarget||"en").replace(/[^A-Za-z-]/g,"")||"en";
  const endpoint=String(config.translationEndpoint||"").trim(); config.translationEndpoint=/^https?:\/\//i.test(endpoint)?endpoint:"";
  config.showExperimentalControls=config.showExperimentalControls===true;
  config.xmlRequestPath=["/cgi/xml_action.cgi","/xml_action.cgi"].includes(config.xmlRequestPath)?config.xmlRequestPath:"/xml_action.cgi";
  return config;
}
function readState(fm, path) { try { if (!fm.fileExists(path)) return null; const s = JSON.parse(fm.readString(path)); return validState(s) ? s : null; } catch (_) { return null; } }
function writeStateAtomic(fm, path, state) { if (!validState(state)) throw new Error("Refusing to persist invalid synchronization state"); const temp = `${path}.tmp`; fm.writeString(temp, JSON.stringify(state, null, 2)); if (fm.fileExists(path)) fm.remove(path); fm.move(temp, path); }
function applicationExists(fm, root, manifest) { try { return manifest.files.every(p => { const file = safeDestination(fm, root, p); return fm.fileExists(file) && fm.readString(file).trim().length > 0; }); } catch (_) { return false; } }
function safeDestination(fm, root, path) { if (!safeRelativePath(path)) throw new Error(`Unsafe manifest path: ${path}`); return fm.joinPath(root, path); }
function ensureDirectory(fm, path) { if (path && !fm.fileExists(path)) fm.createDirectory(path, true); }
function removeIfExists(fm, path) { if (fm.fileExists(path)) fm.remove(path); }
async function downloadICloud(fm, path) { if (fm.isFileDownloaded && !fm.isFileDownloaded(path)) await fm.downloadFileFromiCloud(path); }
async function showMessage(title, message) { const a = new Alert(); a.title = title; a.message = message; a.addAction("OK"); await a.presentAlert(); }

const exported = { SHA_RE, LOADER_PROTOCOL, DEFAULT_CONFIG, normalizeConfig, commitApiUrl, rawBaseUrl, artifactUrls, assertSha, safeRelativePath, validateManifest, validState, synchronizationNeeded, requestHeaders, abbreviate };
if (typeof module !== "undefined" && module.exports) module.exports = exported;
if (typeof Script !== "undefined" && typeof FileManager !== "undefined") main().catch(error => { console.log(`[Router/startup error] ${error}`); throw error; });
