const express = require('express');
const cors = require('cors');   
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');  
const dotenv = require('dotenv');    

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const mongoUri = process.env.MONGO_URI;
const clientOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!mongoUri) {
  console.error('Trūksta MONGO_URI aplinkos kintamojo (.env faile)');
  process.exit(1);
}

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  console.error('Trūksta JWT_SECRET aplinkos kintamojo (.env faile)');
  process.exit(1);
}

const TOKEN_TTL = '8h';
const BCRYPT_ROUNDS = 10;
const MAX_IMAGE_CHARS = 6 * 1024 * 1024; // ~4,5 MB nuotraukos (base64 tekstas)
const USERNAME_RE = /^[\p{L}\p{N}_.-]{3,30}$/u;
const CI = { locale: 'en', strength: 2 }; // vardų palyginimas be didžiųjų/mažųjų raidžių skirtumo

app.use(cors({ origin: clientOrigins }));
app.use(express.json({ limit: '8mb' }));

/* ------------------------------------------------------------------ */
/* Pagalbinės funkcijos                                                */
/* ------------------------------------------------------------------ */

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function parseId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripMongo(doc) {
  const { _id, __v, ...rest } = doc;
  return rest;
}

/* ------------------------------------------------------------------ */
/* Schemos                                                             */
/* ------------------------------------------------------------------ */

const counterSchema = new mongoose.Schema({
  _id: { type: String },
  seq: { type: Number, default: 0 }
});

const userSchema = new mongoose.Schema({
  vardas: { type: String, required: true, trim: true, minlength: 3, maxlength: 30 },
  slaptazodis: { type: String, required: true },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  uzblokuotas: { type: Boolean, default: false }
});
userSchema.index({ vardas: 1 }, { unique: true, name: 'vardas_ci_unique', collation: CI });

const categorySchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  pavadinimas: { type: String, required: true, trim: true, maxlength: 50 }
});

const adSchema = new mongoose.Schema(
  {
    id: { type: Number, required: true, unique: true },
    autorius: { type: String, required: true },
    pavadinimas: { type: String, required: true, maxlength: 120 },
    aprasymas: { type: String, required: true, maxlength: 5000 },
    kaina: { type: Number, required: true, min: 0 },
    categoryId: { type: Number, required: true },
    nuotrauka: { type: String, default: '' },
    uzblokuotas: { type: Boolean, default: false }
  },
  { timestamps: true }
);
adSchema.index({ categoryId: 1 });

const commentSchema = new mongoose.Schema(
  {
    id: { type: Number, required: true, unique: true },
    adId: { type: Number, required: true, index: true },
    autorius: { type: String, default: 'Svečias' },
    tekstas: { type: String, required: true, maxlength: 1000 }
  },
  { timestamps: true }
);

const favoriteSchema = new mongoose.Schema({
  vardas: { type: String, required: true },
  adId: { type: Number, required: true }
});
favoriteSchema.index({ vardas: 1, adId: 1 }, { unique: true });

const CounterModel = mongoose.model('Counter', counterSchema);
const UserModel = mongoose.model('User', userSchema);
const CategoryModel = mongoose.model('Category', categorySchema);
const AdModel = mongoose.model('Ad', adSchema);
const CommentModel = mongoose.model('Comment', commentSchema);
const FavoriteModel = mongoose.model('Favorite', favoriteSchema);

/* Atominis ID generavimas (be „max + 1“ lenktynių) */
async function nextId(name) {
  const counter = await CounterModel.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return counter.seq;
}

async function syncCounters() {
  const pairs = [
    ['categories', CategoryModel],
    ['ads', AdModel],
    ['comments', CommentModel]
  ];
  for (const [name, Model] of pairs) {
    const last = await Model.findOne().sort({ id: -1 }).lean();
    await CounterModel.updateOne(
      { _id: name },
      { $max: { seq: last ? last.id : 0 } },
      { upsert: true }
    );
  }
}

/* ------------------------------------------------------------------ */
/* Slaptažodžiai ir prieiga                                            */
/* ------------------------------------------------------------------ */

const findUserByName = (name) => UserModel.findOne({ vardas: name }).collation(CI);

const verifyPassword = (user, plain) => bcrypt.compare(plain, user.slaptazodis);

function signToken(user) {
  return jwt.sign({ sub: String(user._id) }, jwtSecret, { expiresIn: TOKEN_TTL });
}

async function loadUser(req) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  try {
    const payload = jwt.verify(token, jwtSecret);
    return await UserModel.findById(payload.sub);
  } catch {
    return null;
  }
}

// Prisijungimas neprivalomas (pvz., komentarai), bet užblokuotas vartotojas atmetamas.
const optionalAuth = wrap(async (req, res, next) => {
  const user = await loadUser(req);
  if (user && user.uzblokuotas) {
    return res.status(403).json({ message: 'Vartotojas užblokuotas', code: 'BLOCKED' });
  }
  req.user = user;
  next();
});

const requireAuth = wrap(async (req, res, next) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ message: 'Pirma prisijunkite' });
  if (user.uzblokuotas) {
    return res.status(403).json({ message: 'Vartotojas užblokuotas', code: 'BLOCKED' });
  }
  req.user = user;
  next();
});

const requireAdmin = [
  requireAuth,
  (req, res, next) => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Gali tik administratorius' });
    }
    next();
  }
];

/* ------------------------------------------------------------------ */
/* Skelbimų duomenų validavimas                                        */
/* ------------------------------------------------------------------ */

function validImage(value) {
  if (value === '') return true;
  if (value.length > MAX_IMAGE_CHARS) return false;
  return /^https?:\/\/\S+$/i.test(value) || /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value);
}

// partial = true redagavimui: tikrinami tik atsiųsti laukai
async function parseAdFields(body, partial) {
  const data = {};
  const has = (key) => body[key] !== undefined;

  if (!partial || has('pavadinimas')) {
    const v = typeof body.pavadinimas === 'string' ? body.pavadinimas.trim() : '';
    if (v.length < 3 || v.length > 120) return { error: 'Pavadinimas turi būti 3–120 simbolių' };
    data.pavadinimas = v;
  }

  if (!partial || has('aprasymas')) {
    const v = typeof body.aprasymas === 'string' ? body.aprasymas.trim() : '';
    if (v.length < 5 || v.length > 5000) return { error: 'Aprašymas turi būti 5–5000 simbolių' };
    data.aprasymas = v;
  }

  if (!partial || has('kaina')) {
    const raw = body.kaina;
    const n = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : NaN;
    if (!Number.isFinite(n) || n < 0 || n > 1000000000) {
      return { error: 'Kaina turi būti skaičius, ne mažesnis už 0' };
    }
    data.kaina = Math.round(n * 100) / 100;
  }

  if (!partial || has('categoryId')) {
    const c = parseId(body.categoryId);
    if (!c || !(await CategoryModel.exists({ id: c }))) {
      return { error: 'Pasirinkta kategorija neegzistuoja' };
    }
    data.categoryId = c;
  }

  if (has('nuotrauka')) {
    const v = typeof body.nuotrauka === 'string' ? body.nuotrauka.trim() : null;
    if (v === null || !validImage(v)) {
      return { error: 'Nuotrauka turi būti paveikslėlis (iki ~4 MB) arba http(s) nuoroda' };
    }
    data.nuotrauka = v;
  } else if (!partial) {
    data.nuotrauka = '';
  }

  return { data };
}

async function attachComments(adDocs) {
  if (adDocs.length === 0) return [];
  const adIds = adDocs.map((a) => a.id);
  const allComments = await CommentModel.find({ adId: { $in: adIds } })
    .sort({ id: 1 })
    .lean();

  const byAdId = new Map();
  for (const c of allComments) {
    const list = byAdId.get(c.adId) || [];
    list.push({ id: c.id, adId: c.adId, autorius: c.autorius, tekstas: c.tekstas });
    byAdId.set(c.adId, list);
  }

  return adDocs.map((a) => ({ ...stripMongo(a), comments: byAdId.get(a.id) || [] }));
}

/* ------------------------------------------------------------------ */
/* Paleidimo duomenys                                                  */
/* ------------------------------------------------------------------ */

async function seedIfEmpty() {
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

  if (!(await findUserByName('admin'))) {
    await UserModel.create({
      vardas: 'admin',
      slaptazodis: await bcrypt.hash(adminPassword, BCRYPT_ROUNDS),
      role: 'admin'
    });
  }

  if (!(await findUserByName('tomas'))) {
    await UserModel.create({
      vardas: 'tomas',
      slaptazodis: await bcrypt.hash('1234', BCRYPT_ROUNDS),
      role: 'user'
    });
  }

  if ((await CategoryModel.countDocuments()) === 0) {
    await CategoryModel.insertMany([
      { id: 1, pavadinimas: 'Transportas' },
      { id: 2, pavadinimas: 'Elektronika' },
      { id: 3, pavadinimas: 'Nekilnojamas turtas' }
    ]);
  }

  if ((await AdModel.countDocuments()) === 0) {
    await AdModel.create({
      id: 1,
      autorius: 'tomas',
      pavadinimas: 'Dviračio rėmas',
      aprasymas: 'Lengvas aliumininis rėmas, puikios būklės.',
      kaina: 85,
      categoryId: 1
    });

    await CommentModel.create({
      id: 1,
      adId: 1,
      autorius: 'admin',
      tekstas: 'Koks rėmo dydis?'
    });

    await FavoriteModel.updateOne(
      { vardas: 'tomas', adId: 1 },
      { $setOnInsert: { vardas: 'tomas', adId: 1 } },
      { upsert: true }
    );
  }
}

/* ------------------------------------------------------------------ */
/* Maršrutai: bendri, registracija, prisijungimas                      */
/* ------------------------------------------------------------------ */

app.get('/', (_req, res) => {
  res.send('Serveris veikia (MongoDB)');
});

app.post(
  ['/registr', '/register'],
  wrap(async (req, res) => {
    const { vardas, slaptazodis } = req.body || {};
    if (typeof vardas !== 'string' || typeof slaptazodis !== 'string' || !vardas.trim() || !slaptazodis) {
      return res.status(400).json({ message: 'Įveskite vardą ir slaptažodį' });
    }

    const cleanName = vardas.trim();
    if (!USERNAME_RE.test(cleanName)) {
      return res.status(400).json({
        message: 'Vardas turi būti 3–30 simbolių (raidės, skaičiai, _ . -)'
      });
    }
    if (slaptazodis.length < 6 || slaptazodis.length > 72) {
      return res.status(400).json({ message: 'Slaptažodis turi būti 6–72 simbolių' });
    }

    if (await findUserByName(cleanName)) {
      return res.status(409).json({ message: 'Toks vartotojas jau yra' });
    }

    const user = await UserModel.create({
      vardas: cleanName,
      slaptazodis: await bcrypt.hash(slaptazodis, BCRYPT_ROUNDS),
      role: 'user'
    });

    res.status(201).json({ token: signToken(user), vardas: user.vardas, role: user.role });
  })
);

app.post(
  '/login',
  wrap(async (req, res) => {
    const { vardas, slaptazodis } = req.body || {};
    if (typeof vardas !== 'string' || typeof slaptazodis !== 'string' || !vardas.trim() || !slaptazodis) {
      return res.status(400).json({ message: 'Įveskite vardą ir slaptažodį' });
    }

    const user = await findUserByName(vardas.trim());
    // Ta pati žinutė abiem atvejais, kad nebūtų galima išsiaiškinti, kurie vardai egzistuoja
    if (!user || !(await verifyPassword(user, slaptazodis))) {
      return res.status(401).json({ message: 'Neteisingas vardas arba slaptažodis' });
    }
    if (user.uzblokuotas) {
      return res.status(403).json({ message: 'Vartotojas užblokuotas' });
    }

    res.json({ token: signToken(user), vardas: user.vardas, role: user.role });
  })
);

app.get('/me', requireAuth, (req, res) => {
  res.json({ vardas: req.user.vardas, role: req.user.role });
});

/* ------------------------------------------------------------------ */
/* Administravimas: vartotojai, kategorijos, blokavimas                */
/* ------------------------------------------------------------------ */

app.get(
  '/users',
  requireAdmin,
  wrap(async (_req, res) => {
    const usersList = await UserModel.find({}, '-slaptazodis').sort({ _id: 1 });
    res.json(
      usersList.map((u) => ({
        id: String(u._id),
        vardas: u.vardas,
        role: u.role,
        uzblokuotas: Boolean(u.uzblokuotas)
      }))
    );
  })
);

app.patch(
  '/users/:id/block',
  requireAdmin,
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Neteisingas vartotojo ID' });
    }
    const target = await UserModel.findById(req.params.id);
    if (!target) return res.status(404).json({ message: 'Vartotojas nerastas' });
    if (target.role === 'admin') {
      return res.status(400).json({ message: 'Administratoriaus blokuoti negalima' });
    }

    target.uzblokuotas = !target.uzblokuotas;
    await target.save();
    res.json({
      uzblokuotas: target.uzblokuotas,
      message: target.uzblokuotas ? `${target.vardas} užblokuotas` : `${target.vardas} atblokuotas`
    });
  })
);

app.get(
  '/categories',
  wrap(async (_req, res) => {
    const cats = await CategoryModel.find().sort({ id: 1 }).lean();
    res.json(cats.map(stripMongo));
  })
);

app.post(
  '/categories',
  requireAdmin,
  wrap(async (req, res) => {
    const pavadinimas = typeof req.body?.pavadinimas === 'string' ? req.body.pavadinimas.trim() : '';
    if (pavadinimas.length < 2 || pavadinimas.length > 50) {
      return res.status(400).json({ message: 'Kategorijos pavadinimas turi būti 2–50 simbolių' });
    }
    if (await CategoryModel.findOne({ pavadinimas }).collation(CI)) {
      return res.status(409).json({ message: 'Tokia kategorija jau yra' });
    }

    const nauja = await CategoryModel.create({ id: await nextId('categories'), pavadinimas });
    res.status(201).json(stripMongo(nauja.toObject()));
  })
);

app.patch(
  '/ads/:id/block',
  requireAdmin,
  wrap(async (req, res) => {
    const idNum = parseId(req.params.id);
    if (!idNum) return res.status(400).json({ message: 'Neteisingas skelbimo ID' });

    const ad = await AdModel.findOne({ id: idNum });
    if (!ad) return res.status(404).json({ message: 'Skelbimas nerastas' });

    ad.uzblokuotas = !ad.uzblokuotas;
    await ad.save();
    res.json({
      uzblokuotas: ad.uzblokuotas,
      message: ad.uzblokuotas ? 'Skelbimas užblokuotas' : 'Skelbimas atblokuotas'
    });
  })
);

/* ------------------------------------------------------------------ */
/* Skelbimai                                                           */
/* ------------------------------------------------------------------ */

app.get(
  '/ads',
  optionalAuth,
  wrap(async (req, res) => {
    const filter = {};

    if (req.query.includeBlocked === 'true') {
      if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Gali tik administratorius' });
      }
    } else {
      filter.uzblokuotas = false;
    }

    if (typeof req.query.categoryId === 'string' && req.query.categoryId !== '') {
      const c = parseId(req.query.categoryId);
      if (!c) return res.status(400).json({ message: 'Neteisingas kategorijos ID' });
      filter.categoryId = c;
    }

    if (typeof req.query.search === 'string' && req.query.search.trim()) {
      const rx = new RegExp(escapeRegex(req.query.search.trim().slice(0, 100)), 'i');
      filter.$or = [{ pavadinimas: rx }, { aprasymas: rx }];
    }

    const ads = await AdModel.find(filter).sort({ id: -1 }).lean();
    res.json(await attachComments(ads));
  })
);

app.post(
  '/ads',
  requireAuth,
  wrap(async (req, res) => {
    const { error, data } = await parseAdFields(req.body || {}, false);
    if (error) return res.status(400).json({ message: error });

    const ad = await AdModel.create({
      ...data,
      id: await nextId('ads'),
      autorius: req.user.vardas,
      uzblokuotas: false
    });

    res.status(201).json({ ...stripMongo(ad.toObject()), comments: [] });
  })
);

app.put(
  '/ads/:id',
  requireAuth,
  wrap(async (req, res) => {
    const idNum = parseId(req.params.id);
    if (!idNum) return res.status(400).json({ message: 'Neteisingas skelbimo ID' });

    const ad = await AdModel.findOne({ id: idNum });
    if (!ad) return res.status(404).json({ message: 'Skelbimas nerastas' });

    const isAdmin = req.user.role === 'admin';
    if (ad.autorius !== req.user.vardas && !isAdmin) {
      return res.status(403).json({ message: 'Galima redaguoti tik savo skelbimą' });
    }
    if (ad.uzblokuotas && !isAdmin) {
      return res.status(403).json({ message: 'Skelbimas užblokuotas' });
    }

    const { error, data } = await parseAdFields(req.body || {}, true);
    if (error) return res.status(400).json({ message: error });

    Object.assign(ad, data);
    await ad.save();

    const [enriched] = await attachComments([ad.toObject()]);
    res.json(enriched);
  })
);

app.delete(
  '/ads/:id',
  requireAuth,
  wrap(async (req, res) => {
    const idNum = parseId(req.params.id);
    if (!idNum) return res.status(400).json({ message: 'Neteisingas skelbimo ID' });

    const ad = await AdModel.findOne({ id: idNum });
    if (!ad) return res.status(404).json({ message: 'Skelbimas nerastas' });
    if (ad.autorius !== req.user.vardas && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Galima trinti tik savo skelbimą' });
    }

    await CommentModel.deleteMany({ adId: idNum });
    await FavoriteModel.deleteMany({ adId: idNum });
    await AdModel.deleteOne({ id: idNum });
    res.json({ message: 'Skelbimas ištrintas' });
  })
);

/* ------------------------------------------------------------------ */
/* Komentarai                                                          */
/* ------------------------------------------------------------------ */

app.post(
  '/ads/:id/comments',
  optionalAuth,
  wrap(async (req, res) => {
    const idNum = parseId(req.params.id);
    if (!idNum) return res.status(400).json({ message: 'Neteisingas skelbimo ID' });

    const ad = await AdModel.findOne({ id: idNum, uzblokuotas: false });
    if (!ad) return res.status(404).json({ message: 'Skelbimas nerastas' });

    const tekstas = typeof req.body?.tekstas === 'string' ? req.body.tekstas.trim() : '';
    if (!tekstas) return res.status(400).json({ message: 'Įrašykite komentarą' });
    if (tekstas.length > 1000) {
      return res.status(400).json({ message: 'Komentaras per ilgas (iki 1000 simbolių)' });
    }

    // Autorius imamas iš prisijungimo, o ne iš užklausos – negalima apsimesti kitu vartotoju
    const comment = await CommentModel.create({
      id: await nextId('comments'),
      adId: ad.id,
      autorius: req.user ? req.user.vardas : 'Svečias',
      tekstas
    });

    res.status(201).json({
      id: comment.id,
      adId: comment.adId,
      autorius: comment.autorius,
      tekstas: comment.tekstas
    });
  })
);

app.delete(
  '/ads/:adId/comments/:commentId',
  requireAuth,
  wrap(async (req, res) => {
    const adId = parseId(req.params.adId);
    const commentId = parseId(req.params.commentId);
    if (!adId || !commentId) return res.status(400).json({ message: 'Neteisingas ID' });

    const comment = await CommentModel.findOne({ id: commentId, adId });
    if (!comment) return res.status(404).json({ message: 'Komentaras nerastas' });

    const ad = await AdModel.findOne({ id: adId });
    const isAdAuthor = ad && ad.autorius === req.user.vardas;
    const isCommentAuthor = comment.autorius === req.user.vardas;

    if (!isAdAuthor && !isCommentAuthor && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Galima šalinti tik po savo skelbimu' });
    }

    await CommentModel.deleteOne({ id: commentId });
    res.json({ message: 'Komentaras pašalintas' });
  })
);

/* ------------------------------------------------------------------ */
/* Patikę skelbimai                                                    */
/* ------------------------------------------------------------------ */

// Grąžina patikusių (ir egzistuojančių, neužblokuotų) skelbimų ID sąrašą
app.get(
  '/favorites',
  requireAuth,
  wrap(async (req, res) => {
    const favs = await FavoriteModel.find({ vardas: req.user.vardas }).lean();
    const ads = await AdModel.find(
      { id: { $in: favs.map((f) => f.adId) }, uzblokuotas: false },
      { id: 1, _id: 0 }
    ).lean();
    res.json(ads.map((a) => a.id));
  })
);

app.post(
  '/favorites/:adId',
  requireAuth,
  wrap(async (req, res) => {
    const adId = parseId(req.params.adId);
    if (!adId) return res.status(400).json({ message: 'Neteisingas skelbimo ID' });

    const ad = await AdModel.findOne({ id: adId, uzblokuotas: false });
    if (!ad) return res.status(404).json({ message: 'Skelbimas nerastas' });

    const vardas = req.user.vardas;
    const removed = await FavoriteModel.deleteOne({ vardas, adId });
    if (removed.deletedCount > 0) {
      return res.json({ saved: false, message: 'Pašalinta iš patikusių' });
    }

    try {
      await FavoriteModel.create({ vardas, adId });
    } catch (err) {
      if (err.code !== 11000) throw err; // jau įrašyta lygiagrečia užklausa
    }
    res.json({ saved: true, message: 'Pridėta į patikusius' });
  })
);

/* ------------------------------------------------------------------ */
/* Klaidų apdorojimas                                                  */
/* ------------------------------------------------------------------ */

app.use((_req, res) => {
  res.status(404).json({ message: 'Maršrutas nerastas' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ message: 'Per didelė užklausa (nuotrauka per didelė)' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Neteisingas JSON formatas' });
  }
  if (err.code === 11000) {
    return res.status(409).json({ message: 'Toks įrašas jau egzistuoja' });
  }
  console.error(err);
  res.status(500).json({ message: 'Vidinė serverio klaida' });
});

/* ------------------------------------------------------------------ */
/* Paleidimas                                                          */
/* ------------------------------------------------------------------ */

mongoose
  .connect(mongoUri)
  .then(async () => {
    console.log('Prisijungta prie MongoDB');
    const models = [CounterModel, UserModel, CategoryModel, AdModel, CommentModel, FavoriteModel];
    await Promise.all(
      models.map((m) => m.init().catch((e) => console.warn(`Indekso įspėjimas (${m.modelName}):`, e.message)))
    );
    await seedIfEmpty();
    await syncCounters();
    app.listen(port, () => {
      console.log(`Serveris veikia ant http://localhost:${port}`);
    });
  })
  .catch((err) => {
    console.error('MongoDB klaida:', err.message);
    process.exit(1);
  });