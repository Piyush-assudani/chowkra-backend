// SQLite WAL-safe hot backup manager using VACUUM INTO + automatic retention rotation.
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class BackupManager {
  constructor(db, dbPath, { maxBackups = 7, intervalMs = 6 * 3600_000 } = {}) {
    this.db = db;
    this.dbPath = dbPath;
    this.maxBackups = maxBackups;
    this.intervalMs = intervalMs;
    this.backupDir = dbPath && dbPath !== ':memory:' ? join(dirname(dbPath), 'backups') : null;
    this.lastBackupAt = null;
    this.timer = null;
  }

  startSchedule() {
    if (!this.backupDir || this.intervalMs <= 0) return;
    this.timer = setInterval(() => {
      try {
        this.runBackup();
      } catch (err) {
        console.error('[backup] scheduled snapshot failed:', err.message);
      }
    }, this.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Creates an atomic point-in-time SQLite snapshot and prunes backups beyond maxBackups. */
  runBackup(targetDir = this.backupDir) {
    if (!targetDir) return null;
    mkdirSync(targetDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(targetDir, `chowkra-${stamp}.db`);
    const escaped = file.replace(/'/g, "''");
    this.db.exec(`VACUUM INTO '${escaped}'`);
    this.lastBackupAt = Date.now();
    this._prune(targetDir);
    return file;
  }

  _prune(dir) {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith('chowkra-') && f.endsWith('.db'))
      .map((f) => {
        const full = join(dir, f);
        return { full, mtime: statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of files.slice(this.maxBackups)) {
      try {
        unlinkSync(old.full);
      } catch {
        // best-effort prune
      }
    }
  }

  /** Opens a backup snapshot read-only and runs SQLite integrity_check. */
  static verifyBackup(filePath) {
    const bdb = new DatabaseSync(filePath, { readOnly: true });
    try {
      const row = bdb.prepare('PRAGMA integrity_check').get();
      return row?.integrity_check === 'ok';
    } finally {
      bdb.close();
    }
  }
}
