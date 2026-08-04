// MF885 SMS Reader updater and launcher for Scriptable.
// This loader has one remote endpoint. The manifest expands into every file
// needed by the application.

const MANIFEST_URL =
  "https://raw.githubusercontent.com/nryabkov/mf885-smsreader/main/manifest.json";
const ROUTER_IP = "192.168.21.1";
const DEFAULT_ROUTER_PASSWORD = "zimifi";
const USE_ICLOUD = false;

await main();

async function main() {
  const fm = USE_ICLOUD ? FileManager.iCloud() : FileManager.local();
  const documents = fm.documentsDirectory();
  const installDirectory = fm.joinPath(documents, "mf885-smsreader");
  const versionFile = fm.joinPath(installDirectory, "installed-version.txt");
  ensureDirectory(fm, installDirectory);

  await downloadFromICloudIfNeeded(fm, versionFile);
  const installedVersion = fm.fileExists(versionFile)
    ? fm.readString(versionFile).trim()
    : "";

  let manifest = null;
  try {
    manifest = await loadJson(MANIFEST_URL);
    validateManifest(manifest);
    if (manifest.version !== installedVersion || !installationExists(fm, installDirectory, manifest)) {
      await installManifest(fm, installDirectory, manifest);
      fm.writeString(versionFile, manifest.version);
      await showUpdate(manifest.version, installedVersion);
    } else {
      console.log("[Sync] The latest version is already installed.");
    }
  } catch (error) {
    console.log(`[Sync warning] Update check failed: ${error}.`);
  }

  if (!manifest) {
    if (!fm.fileExists(versionFile)) {
      throw new Error("The application is not installed and its manifest is unavailable.");
    }
    manifest = { entry: "scriptable.js" };
  }

  const entryFile = fm.joinPath(installDirectory, manifest.entry);
  await downloadFromICloudIfNeeded(fm, entryFile);

  const keychainKey = `zmifi_pass_${ROUTER_IP}`;
  if (!Keychain.contains(keychainKey)) {
    Keychain.set(keychainKey, DEFAULT_ROUTER_PASSWORD);
  }

  const application = importModule(entryFile);
  if (!application || typeof application.run !== "function") {
    throw new Error("The installed application does not export run(options).");
  }
  await application.run({
    ip: ROUTER_IP,
    password: Keychain.get(keychainKey),
    moduleDirectory: installDirectory
  });
}

async function installManifest(fm, installDirectory, manifest) {
  const baseUrl = MANIFEST_URL.slice(0, MANIFEST_URL.lastIndexOf("/") + 1);
  for (const relativePath of manifest.files) {
    const destination = safeDestination(fm, installDirectory, relativePath);
    ensureDirectory(fm, destination.slice(0, destination.lastIndexOf("/")));
    const source = baseUrl + relativePath;
    const code = await loadString(source);
    if (!code.trim()) throw new Error(`Downloaded an empty file: ${relativePath}`);
    fm.writeString(destination, code);
  }
}

function installationExists(fm, installDirectory, manifest) {
  return manifest.files.every(path =>
    fm.fileExists(safeDestination(fm, installDirectory, path))
  );
}

function safeDestination(fm, root, relativePath) {
  if (!/^[A-Za-z0-9_./-]+$/.test(relativePath) || relativePath.includes("..")) {
    throw new Error(`Unsafe manifest path: ${relativePath}`);
  }
  return fm.joinPath(root, relativePath);
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest.version !== "string") {
    throw new Error("Manifest version is missing");
  }
  if (!Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error("Manifest file list is missing");
  }
  if (!manifest.files.includes(manifest.entry)) {
    throw new Error("Manifest entry is not included in its file list");
  }
}

async function loadJson(url) {
  const request = requestFor(url);
  return await request.loadJSON();
}

async function loadString(url) {
  const request = requestFor(url);
  return await request.loadString();
}

function requestFor(url) {
  const request = new Request(url);
  request.headers = {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "User-Agent": "Scriptable-MF885-SMS-Reader"
  };
  return request;
}

function ensureDirectory(fm, path) {
  if (path && !fm.fileExists(path)) fm.createDirectory(path, true);
}

async function showUpdate(version, previousVersion) {
  const alert = new Alert();
  alert.title = previousVersion ? "mf885-smsreader updated" : "mf885-smsreader installed";
  alert.message = previousVersion
    ? `Updated from ${previousVersion} to ${version}.`
    : `Installed version ${version}.`;
  alert.addAction("Run");
  await alert.presentAlert();
}

async function downloadFromICloudIfNeeded(fm, path) {
  if (USE_ICLOUD && fm.fileExists(path) && !fm.isFileDownloaded(path)) {
    await fm.downloadFileFromiCloud(path);
  }
}
