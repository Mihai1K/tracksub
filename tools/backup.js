'use strict';

/**
 * Резервная копия БД штатным механизмом SQLite (VACUUM INTO) — консистентно на живой базе.
 * Хранит последние 14 копий. Восстановление описано в docs/deployment.md.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : dflt;
}

function main() {
  const dbFile = arg('db', './data/app.sqlite');
  const outDir = arg('out', './backups');
  const keep = parseInt(arg('keep', '14'), 10);

  if (!fs.existsSync(dbFile)) {
    console.error('Файл базы не найден: ' + dbFile);
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = path.join(outDir, 'app-' + stamp + '.sqlite');

  const db = new DatabaseSync(dbFile);
  db.exec("VACUUM INTO '" + target.replace(/'/g, "''") + "'");
  db.close();

  const size = fs.statSync(target).size;
  const files = fs.readdirSync(outDir).filter((f) => f.startsWith('app-') && f.endsWith('.sqlite')).sort();
  for (const old of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(outDir, old));

  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'backup done', file: target, bytes: size, kept: Math.min(files.length, keep) }));
}

if (require.main === module) main();
module.exports = { main };
