const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');

const db = new Database('./database.sqlite');

const vardas = 'admin';
const slaptazodis = 'Admin12345';
const hash = bcrypt.hashSync(slaptazodis, 10);

const existing = db.prepare('SELECT id FROM users WHERE vardas = ?').get(vardas);

if (existing) {
  db.prepare('UPDATE users SET slaptazodis = ?, role = ? WHERE vardas = ?').run(hash, 'admin', vardas);
  console.log('Admin atnaujintas');
} else {
  db.prepare('INSERT INTO users (vardas, slaptazodis, role) VALUES (?, ?, ?)').run(vardas, hash, 'admin');
  console.log('Admin sukurtas');
}
