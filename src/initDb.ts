import Database from 'better-sqlite3';

function initDb() {
    const db = new Database('redirects.db');
    db.pragma('journal_mode = WAL');

    db.exec(`
    CREATE TABLE IF NOT EXISTS redirects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE,
      regex_pattern TEXT,
      type TEXT
    );

    CREATE TABLE IF NOT EXISTS seen_urls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      redirect_id INTEGER,
      url TEXT,
      last_seen DATETIME,
      FOREIGN KEY (redirect_id) REFERENCES redirects(id)
    );

    CREATE TABLE IF NOT EXISTS most_recent_redirects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      redirect_id INTEGER,
      url TEXT,
      timestamp DATETIME,
      FOREIGN KEY (redirect_id) REFERENCES redirects(id)
    );
  `);

    db.close();
}

initDb();