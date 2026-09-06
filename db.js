
import Database from "better-sqlite3";

const db = new Database("./data/altitude.sqlite");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS groups (
  jid TEXT PRIMARY KEY,
  settings TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS warnings (
  group_jid TEXT NOT NULL,
  user_jid TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (group_jid, user_jid)
);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_jid TEXT,
  user_jid TEXT,
  action TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL
);
`);

export function getGroupSettings(jid, defaults) {
  const row = db.prepare("SELECT settings FROM groups WHERE jid=?").get(jid);
  if (!row) {
    db.prepare("INSERT INTO groups(jid,settings) VALUES(?,?)").run(jid, JSON.stringify(defaults));
    return structuredClone(defaults);
  }
  try { return {...defaults, ...JSON.parse(row.settings)}; }
  catch { return structuredClone(defaults); }
}

export function setGroupSettings(jid, settings) {
  db.prepare(`
    INSERT INTO groups(jid,settings) VALUES(?,?)
    ON CONFLICT(jid) DO UPDATE SET settings=excluded.settings
  `).run(jid, JSON.stringify(settings));
}

export function addWarning(groupJid, userJid) {
  const row = db.prepare("SELECT count FROM warnings WHERE group_jid=? AND user_jid=?")
    .get(groupJid, userJid);
  const count = (row?.count || 0) + 1;
  db.prepare(`
    INSERT INTO warnings(group_jid,user_jid,count,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(group_jid,user_jid)
    DO UPDATE SET count=excluded.count, updated_at=excluded.updated_at
  `).run(groupJid, userJid, count, Date.now());
  return count;
}

export function clearWarnings(groupJid, userJid) {
  db.prepare("DELETE FROM warnings WHERE group_jid=? AND user_jid=?").run(groupJid, userJid);
}

export function logAction(groupJid, userJid, action, reason="") {
  db.prepare(
    "INSERT INTO logs(group_jid,user_jid,action,reason,created_at) VALUES(?,?,?,?,?)"
  ).run(groupJid, userJid, action, reason, Date.now());
}
