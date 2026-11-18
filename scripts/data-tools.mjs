import { backup, DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { loadRuntimeEnvironment, runtimeDirectory } from "./runtime-paths.mjs";

const names = ["barker.sqlite", "access-password.txt", "session-secret.txt"];
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** A portable snapshot has no WAL dependency or transient sidecars. */
function sealSnapshot(path) {
  const database = new DatabaseSync(path);
  try { database.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;"); }
  finally { database.close(); }
}

async function fileDigests(directory) {
  const files = {};
  for (const name of names) if (existsSync(join(directory, name))) files[name] = await digest(join(directory, name));
  return files;
}

function verifyDatabase(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = database.prepare("PRAGMA integrity_check").get();
    if (integrity.integrity_check !== "ok") throw new Error("Database integrity check failed");
    if (database.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Database foreign keys are invalid");
    const version = database.prepare("PRAGMA user_version").get().user_version;
    if (version > 3) throw new Error(`Unsupported schema version ${version}`);
    for (const table of ["tasks", "deliveries", "settings"]) database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
    return version;
  } finally { database.close(); }
}

function regularFile(path) {
  if (!lstatSync(path).isFile()) throw new Error(`Expected a regular file: ${path}`);
}

function isSameOrWithin(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function canonicalPath(path) {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return join(realpathSync(dirname(absolute)), basename(absolute));
  }
}

function createPrivateDirectory(path) {
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) {
    if (error?.code === "EEXIST") throw new Error("Target directory already exists; choose a new directory");
    throw error;
  }
}

export async function backupData(source, destination) {
  if (existsSync(destination)) throw new Error("Backup destination already exists; choose a new directory");
  const sourcePath = canonicalPath(source);
  const destinationPath = canonicalPath(destination);
  if (isSameOrWithin(sourcePath, destinationPath)) throw new Error("Backup destination must be outside the source data directory");
  createPrivateDirectory(destination);
  try {
    regularFile(join(source, "barker.sqlite"));
    const database = new DatabaseSync(join(source, "barker.sqlite"), { readOnly: true });
    try { await backup(database, join(destination, "barker.sqlite")); }
    finally { database.close(); }
    sealSnapshot(join(destination, "barker.sqlite"));
    chmodSync(join(destination, "barker.sqlite"), 0o600);
    for (const name of names.slice(1)) {
      if (!existsSync(join(source, name))) continue;
      regularFile(join(source, name));
      copyFileSync(join(source, name), join(destination, name));
      chmodSync(join(destination, name), 0o600);
    }
    const version = verifyDatabase(join(destination, "barker.sqlite"));
    const files = await fileDigests(destination);
    writeFileSync(join(destination, "manifest.json"), JSON.stringify({ format: 1, schemaVersion: version, createdAt: new Date().toISOString(), files }, null, 2), { mode: 0o600 });
    chmodSync(join(destination, "manifest.json"), 0o600);
    return { files: Object.keys(files), schemaVersion: version };
  } catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
}

export async function restoreData(source, destination) {
  if (existsSync(destination)) throw new Error("Restore target must be a new data directory; existing data is never overwritten");
  const sourcePath = canonicalPath(source);
  const destinationPath = canonicalPath(destination);
  if (isSameOrWithin(sourcePath, destinationPath)) throw new Error("Restore target must be outside the backup directory");
  regularFile(join(source, "manifest.json"));
  const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
  if (manifest.format !== 1 || !manifest.files || typeof manifest.files !== "object" || !("barker.sqlite" in manifest.files)) throw new Error("Invalid backup manifest");
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (!names.includes(name)) throw new Error(`Unexpected backup file ${name}`);
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`Invalid checksum in backup manifest: ${name}`);
    regularFile(join(source, name));
    if (await digest(join(source, name)) !== expected) throw new Error(`Backup checksum mismatch: ${name}`);
  }
  if (readdirSync(source).some((name) => ![...names, "manifest.json"].includes(name))) throw new Error("Backup contains unexpected files");
  createPrivateDirectory(destination);
  try {
    for (const name of Object.keys(manifest.files)) {
      copyFileSync(join(source, name), join(destination, name));
      chmodSync(join(destination, name), 0o600);
    }
    sealSnapshot(join(destination, "barker.sqlite"));
    const sourceVersion = verifyDatabase(join(destination, "barker.sqlite"));
    if (manifest.schemaVersion !== sourceVersion) throw new Error("Backup manifest schema version does not match the database");
    const database = new DatabaseSync(join(destination, "barker.sqlite"));
    try {
      for (const table of ["sessions", "api_tokens", "runtime_state"]) {
        if (database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) database.exec(`DELETE FROM ${table}`);
      }
    }
    finally { database.close(); }
    verifyDatabase(join(destination, "barker.sqlite"));
    const restoredFiles = await fileDigests(destination);
    writeFileSync(join(destination, "manifest.json"), JSON.stringify({
      format: 1,
      schemaVersion: sourceVersion,
      createdAt: new Date().toISOString(),
      restoredFrom: typeof manifest.createdAt === "string" ? manifest.createdAt : null,
      files: restoredFiles,
    }, null, 2), { mode: 0o600 });
    chmodSync(join(destination, "manifest.json"), 0o600);
    return { restored: true };
  } catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  loadRuntimeEnvironment();
  const [mode, target, sourceArgument] = process.argv.slice(2);
  if (!["backup", "restore"].includes(mode) || !target) throw new Error("Usage: node scripts/data-tools.mjs backup|restore NEW_TARGET_DIR [SOURCE_DIR]");
  const source = sourceArgument ? resolve(sourceArgument) : runtimeDirectory();
  const destination = resolve(target);
  if (!existsSync(dirname(destination))) throw new Error("Target parent directory does not exist");
  console.log(JSON.stringify(await (mode === "backup" ? backupData(source, destination) : restoreData(source, destination))));
}
