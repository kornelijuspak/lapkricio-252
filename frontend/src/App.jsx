import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserRouter, Routes, Route, Link, NavLink, Navigate, useNavigate } from 'react-router-dom';
import './App.css';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const REFRESH_MS = 30000;
const SESSION_KEY = 'skelbimai_session';

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function apiFetch(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new ApiError('Nepavyko susisiekti su serveriu', 0);
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const message = (data && data.message) || (typeof data === 'string' && data) || 'Įvyko klaida';
    throw new ApiError(message, res.status, data && data.code);
  }
  return data;
}

function loadStoredSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && parsed.token && parsed.vardas ? parsed : null;
  } catch {
    return null;
  }
}

function readImageFile(file, callback, notify) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    notify('Pasirinkite paveikslėlio failą');
    return;
  }
  const reader = new FileReader();
  reader.onerror = () => notify('Nepavyko perskaityti failo');
  reader.onload = () => {
    const img = new Image();
    img.onerror = () => notify('Nepavyko apdoroti nuotraukos');
    img.onload = () => {
      const MAX = 1024;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      callback(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function validateAdForm({ pavadinimas, aprasymas, kaina, categoryId }) {
  if (pavadinimas.trim().length < 3) return 'Pavadinimas turi būti bent 3 simbolių';
  if (aprasymas.trim().length < 5) return 'Aprašymas turi būti bent 5 simbolių';
  if (String(kaina).trim() === '' || !Number.isFinite(Number(kaina)) || Number(kaina) < 0) {
    return 'Kaina turi būti skaičius, ne mažesnis už 0';
  }
  if (!categoryId) return 'Pasirinkite kategoriją';
  return null;
}

function imageInputValue(value) {
  return value.startsWith('data:') ? '' : value;
}

async function runAction(action, okMessage, notify, refresh) {
  try {
    await action();
    if (okMessage) notify(okMessage);
    if (refresh) refresh(false);
  } catch (err) {
    notify(err.message);
  }
}

function Skelbimai({
  categories,
  ads,
  connError,
  favIds,
  refreshAll,
  currentUser,
  api,
  notify,
  search,
  setSearch,
  selectedCategory,
  setSelectedCategory
}) {
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [onlyMine, setOnlyMine] = useState(false);

  const [pavadinimas, setPavadinimas] = useState('');
  const [aprasymas, setAprasymas] = useState('');
  const [kaina, setKaina] = useState('');
  const [nuotrauka, setNuotrauka] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [saving, setSaving] = useState(false);

  const [editingId, setEditingId] = useState(null);
  const [editPavadinimas, setEditPavadinimas] = useState('');
  const [editAprasymas, setEditAprasymas] = useState('');
  const [editKaina, setEditKaina] = useState('');
  const [editNuotrauka, setEditNuotrauka] = useState('');
  const [editCategoryId, setEditCategoryId] = useState('');

  const [komentaruTekstai, setKomentaruTekstai] = useState({});

  useEffect(() => {
    if (categories.length > 0 && !categoryId) {
      setCategoryId(String(categories[0].id));
    }
  }, [categories, categoryId]);

  useEffect(() => {
    if (!currentUser) {
      setOnlyFavorites(false);
      setOnlyMine(false);
    }
  }, [currentUser]);

  async function handleKurtiSkelbima(e) {
    e.preventDefault();
    if (!currentUser) {
      notify('Pirma prisijunkite');
      return;
    }
    const klaida = validateAdForm({ pavadinimas, aprasymas, kaina, categoryId });
    if (klaida) {
      notify(klaida);
      return;
    }

    setSaving(true);
    try {
      await api('/ads', {
        method: 'POST',
        body: {
          pavadinimas: pavadinimas.trim(),
          aprasymas: aprasymas.trim(),
          kaina: Number(kaina),
          nuotrauka,
          categoryId: Number(categoryId)
        }
      });
      setPavadinimas('');
      setAprasymas('');
      setKaina('');
      setNuotrauka('');
      notify('Skelbimas paskelbtas');
      refreshAll(false);
    } catch (err) {
      notify(err.message);
    } finally {
      setSaving(false);
    }
  }

  function pradetiRedaguoti(ad) {
    setEditingId(ad.id);
    setEditPavadinimas(ad.pavadinimas);
    setEditAprasymas(ad.aprasymas);
    setEditKaina(String(ad.kaina));
    setEditNuotrauka(ad.nuotrauka || '');
    setEditCategoryId(String(ad.categoryId));
  }

  async function issaugotiRedagavima(adId) {
    const klaida = validateAdForm({
      pavadinimas: editPavadinimas,
      aprasymas: editAprasymas,
      kaina: editKaina,
      categoryId: editCategoryId
    });
    if (klaida) {
      notify(klaida);
      return;
    }
    await runAction(
      async () => {
        await api(`/ads/${adId}`, {
          method: 'PUT',
          body: {
            pavadinimas: editPavadinimas.trim(),
            aprasymas: editAprasymas.trim(),
            kaina: Number(editKaina),
            nuotrauka: editNuotrauka,
            categoryId: Number(editCategoryId)
          }
        });
        setEditingId(null);
      },
      'Skelbimas atnaujintas',
      notify,
      refreshAll
    );
  }

  async function istrintiSkelbima(adId) {
    if (!window.confirm('Ar tikrai norite ištrinti šį skelbimą?')) return;
    await runAction(
      () => api(`/ads/${adId}`, { method: 'DELETE' }),
      'Skelbimas ištrintas',
      notify,
      refreshAll
    );
  }

  async function toggleZvaigzdute(adId) {
    if (!currentUser) {
      notify('Pirma prisijunkite');
      return;
    }
    await runAction(
      async () => {
        const data = await api(`/favorites/${adId}`, { method: 'POST' });
        notify(data.saved ? 'Įtraukta į patikusius ★' : 'Pašalinta iš patikusių');
      },
      null,
      notify,
      refreshAll
    );
  }

  async function pridetiKomentara(adId) {
    const tekstas = (komentaruTekstai[adId] || '').trim();
    if (!tekstas) return;
    await runAction(
      async () => {
        await api(`/ads/${adId}/comments`, { method: 'POST', body: { tekstas } });
        setKomentaruTekstai((prev) => ({ ...prev, [adId]: '' }));
      },
      'Komentaras pridėtas',
      notify,
      refreshAll
    );
  }

  async function pasalintiKomentara(adId, commentId) {
    await runAction(
      () => api(`/ads/${adId}/comments/${commentId}`, { method: 'DELETE' }),
      'Komentaras pašalintas',
      notify,
      refreshAll
    );
  }

  const rodomiSkelbimai = (ads || []).filter((a) => {
    if (onlyFavorites && !favIds.includes(a.id)) return false;
    if (onlyMine && (!currentUser || a.autorius !== currentUser.vardas)) return false;
    return true;
  });

  function gautiKategorijosPavadinima(catId) {
    return categories.find((c) => String(c.id) === String(catId))?.pavadinimas || 'Kategorija';
  }

  function renderCategoryOptions() {
    return categories.map((c) => (
      <option key={c.id} value={c.id}>
        {c.pavadinimas}
      </option>
    ));
  }

  return (
    <div>
      <h2>Skelbimai</h2>

      <div className="toolbar">
        <input
          type="search"
          placeholder="Paieška pagal žodį ar frazę..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Paieška"
        />
        <select
          value={selectedCategory}
          onChange={(e) => setSelectedCategory(e.target.value)}
          aria-label="Kategorija"
        >
          <option value="">Visos kategorijos</option>
          {renderCategoryOptions()}
        </select>

        {currentUser && (
          <>
            <button
              type="button"
              className={onlyFavorites ? 'active' : ''}
              onClick={() => setOnlyFavorites((prev) => !prev)}
            >
              {onlyFavorites ? '★ Rodyti visus' : `★ Patikę (${favIds.length})`}
            </button>
            <button
              type="button"
              className={onlyMine ? 'active' : ''}
              onClick={() => setOnlyMine((prev) => !prev)}
            >
              {onlyMine ? 'Rodyti visus' : 'Mano skelbimai'}
            </button>
          </>
        )}
      </div>

      <div className="card form-box">
        <h3>Įdėti skelbimą</h3>
        {!currentUser ? (
          <p>
            Norėdami sukurti skelbimą, <Link to="/login">prisijunkite</Link>.
          </p>
        ) : (
          <form onSubmit={handleKurtiSkelbima} className="stack-form">
            <input
              placeholder="Pavadinimas"
              value={pavadinimas}
              maxLength={120}
              onChange={(e) => setPavadinimas(e.target.value)}
            />
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              {renderCategoryOptions()}
            </select>
            <textarea
              placeholder="Aprašymas"
              value={aprasymas}
              maxLength={5000}
              onChange={(e) => setAprasymas(e.target.value)}
              rows={3}
            />
            <input
              type="number"
              step="0.01"
              min="0"
              placeholder="Kaina (€)"
              value={kaina}
              onChange={(e) => setKaina(e.target.value)}
            />
            <label className="file-label">
              Pasirinkti nuotrauką iš įrenginio:
              <input
                type="file"
                accept="image/*"
                onChange={(e) => {
                  readImageFile(e.target.files?.[0], setNuotrauka, notify);
                  e.target.value = '';
                }}
              />
            </label>
            <input
              placeholder="Arba įklijuoti nuotraukos URL..."
              value={imageInputValue(nuotrauka)}
              onChange={(e) => setNuotrauka(e.target.value)}
            />
            {nuotrauka && (
              <div className="preview-wrap">
                <img src={nuotrauka} alt="Peržiūra" className="preview-img" />
                <button type="button" className="small-btn" onClick={() => setNuotrauka('')}>
                  Pašalinti nuotrauką
                </button>
              </div>
            )}
            <button type="submit" className="primary" disabled={saving}>
              {saving ? 'Skelbiama...' : 'Skelbti'}
            </button>
          </form>
        )}
      </div>

      {connError && (
        <p className="error-text">Nepavyko užkrauti duomenų – serveris nepasiekiamas. Bandoma iš naujo...</p>
      )}

      {ads === null && !connError ? (
        <p>Kraunama...</p>
      ) : rodomiSkelbimai.length === 0 ? (
        <p className="muted">Skelbimų nerasta.</p>
      ) : (
        rodomiSkelbimai.map((ad) => {
          const isFav = favIds.includes(ad.id);
          const isOwner = currentUser && ad.autorius === currentUser.vardas;
          const isAdmin = currentUser?.role === 'admin';
          const canManage = isOwner || isAdmin;

          return (
            <div key={ad.id} className="card ad-card">
              <div className="ad-header">
                <div>
                  <h3>{ad.pavadinimas}</h3>
                  <small className="muted">
                    {gautiKategorijosPavadinima(ad.categoryId)} · {ad.autorius}
                  </small>
                </div>
                <div className="ad-side">
                  <span className="price">{ad.kaina} €</span>
                  <button
                    type="button"
                    className="star-btn"
                    onClick={() => toggleZvaigzdute(ad.id)}
                    title={isFav ? 'Pašalinti iš patikusių' : 'Įtraukti į patikusius'}
                    aria-label={isFav ? 'Pašalinti iš patikusių' : 'Įtraukti į patikusius'}
                    aria-pressed={isFav}
                  >
                    {isFav ? '★' : '☆'}
                  </button>
                </div>
              </div>

              {ad.nuotrauka && <img src={ad.nuotrauka} alt={ad.pavadinimas} className="ad-img" loading="lazy" />}

              <p className="ad-text">{ad.aprasymas}</p>

              {canManage && editingId !== ad.id && (
                <div className="row-gap">
                  <button type="button" onClick={() => pradetiRedaguoti(ad)}>
                    Redaguoti
                  </button>
                  <button type="button" className="danger" onClick={() => istrintiSkelbima(ad.id)}>
                    Ištrinti
                  </button>
                </div>
              )}

              {editingId === ad.id && (
                <div className="edit-box stack-form">
                  <strong>Redaguoti skelbimą</strong>
                  <input
                    value={editPavadinimas}
                    maxLength={120}
                    onChange={(e) => setEditPavadinimas(e.target.value)}
                  />
                  <select value={editCategoryId} onChange={(e) => setEditCategoryId(e.target.value)}>
                    {renderCategoryOptions()}
                  </select>
                  <textarea
                    value={editAprasymas}
                    maxLength={5000}
                    onChange={(e) => setEditAprasymas(e.target.value)}
                    rows={3}
                  />
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={editKaina}
                    onChange={(e) => setEditKaina(e.target.value)}
                  />
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => {
                      readImageFile(e.target.files?.[0], setEditNuotrauka, notify);
                      e.target.value = '';
                    }}
                  />
                  <input
                    value={imageInputValue(editNuotrauka)}
                    onChange={(e) => setEditNuotrauka(e.target.value)}
                    placeholder="Nuotraukos URL"
                  />
                  {editNuotrauka && (
                    <div className="preview-wrap">
                      <img src={editNuotrauka} alt="Peržiūra" className="preview-img" />
                      <button type="button" className="small-btn" onClick={() => setEditNuotrauka('')}>
                        Pašalinti nuotrauką
                      </button>
                    </div>
                  )}
                  <div className="row-gap">
                    <button type="button" className="primary" onClick={() => issaugotiRedagavima(ad.id)}>
                      Išsaugoti
                    </button>
                    <button type="button" onClick={() => setEditingId(null)}>
                      Atšaukti
                    </button>
                  </div>
                </div>
              )}

              <div className="comments-box">
                <strong>Komentarai ({(ad.comments || []).length})</strong>
                {(ad.comments || []).map((c) => {
                  const canDeleteComment =
                    currentUser && (isAdmin || isOwner || c.autorius === currentUser.vardas);
                  return (
                    <div key={c.id} className="comment-item">
                      <span>
                        <strong>{c.autorius}:</strong> {c.tekstas}
                      </span>
                      {canDeleteComment && (
                        <button
                          type="button"
                          className="small-btn"
                          onClick={() => pasalintiKomentara(ad.id, c.id)}
                        >
                          Šalinti
                        </button>
                      )}
                    </div>
                  );
                })}

                <div className="row-gap comment-form">
                  <input
                    placeholder={currentUser ? 'Parašyti komentarą...' : 'Parašyti komentarą (kaip svečias)...'}
                    value={komentaruTekstai[ad.id] || ''}
                    maxLength={1000}
                    onChange={(e) => setKomentaruTekstai((prev) => ({ ...prev, [ad.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') pridetiKomentara(ad.id);
                    }}
                  />
                  <button type="button" onClick={() => pridetiKomentara(ad.id)}>
                    Komentuoti
                  </button>
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

function AdminPanel({ categories, usersList, allAds, refreshAll, currentUser, api, notify }) {
  const [newCategory, setNewCategory] = useState('');

  if (!currentUser) {
    // NAUJA: nukreipiama į atskirą administratoriaus prisijungimą
    return <Navigate to="/admin-login" replace />;
  }

  if (currentUser.role !== 'admin') {
    return (
      <div className="card">
        <h2>Administracinė sritis</h2>
        <p>Ši sritis skirta tik administratoriui.</p>
      </div>
    );
  }

  async function sukurtiKategorija(e) {
    e.preventDefault();
    const pavadinimas = newCategory.trim();
    if (pavadinimas.length < 2) {
      notify('Kategorijos pavadinimas turi būti bent 2 simbolių');
      return;
    }
    await runAction(
      async () => {
        await api('/categories', { method: 'POST', body: { pavadinimas } });
        setNewCategory('');
      },
      'Kategorija sukurta',
      notify,
      refreshAll
    );
  }

  const blokuotiVartotoja = (userId) =>
    runAction(
      async () => {
        const data = await api(`/users/${userId}/block`, { method: 'PATCH' });
        notify(data.message);
      },
      null,
      notify,
      refreshAll
    );

  const blokuotiSkelbima = (adId) =>
    runAction(
      async () => {
        const data = await api(`/ads/${adId}/block`, { method: 'PATCH' });
        notify(data.message);
      },
      null,
      notify,
      refreshAll
    );

  const salintiKomentaraAdmin = (adId, commentId) =>
    runAction(
      () => api(`/ads/${adId}/comments/${commentId}`, { method: 'DELETE' }),
      'Komentaras pašalintas',
      notify,
      refreshAll
    );

  return (
    <div>
      <h2>Administracinė sritis</h2>

      <div className="card">
        <h3>Nauja kategorija</h3>
        <form onSubmit={sukurtiKategorija} className="row-gap">
          <input
            placeholder="Kategorijos pavadinimas"
            value={newCategory}
            maxLength={50}
            onChange={(e) => setNewCategory(e.target.value)}
          />
          <button type="submit" className="primary">
            Pridėti
          </button>
        </form>
        <p className="mt-10 muted">Kategorijos: {categories.map((c) => c.pavadinimas).join(', ') || 'nėra'}</p>
      </div>

      <div className="card">
        <h3>Vartotojų valdymas</h3>
        {usersList.map((u) => (
          <div key={u.id} className="admin-row">
            <span>
              <strong>{u.vardas}</strong> ({u.role}) —{' '}
              <span className={u.uzblokuotas ? 'tag tag-blocked' : 'tag'}>
                {u.uzblokuotas ? 'Užblokuotas' : 'Aktyvus'}
              </span>
            </span>
            {u.role !== 'admin' && (
              <button type="button" onClick={() => blokuotiVartotoja(u.id)}>
                {u.uzblokuotas ? 'Atblokuoti' : 'Blokuoti'}
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="card">
        <h3>Skelbimų ir komentarų moderavimas</h3>
        {allAds.length === 0 && <p className="muted">Skelbimų nėra.</p>}
        {allAds.map((a) => (
          <div key={a.id} className="mod-block">
            <div className="admin-row">
              <span>
                <strong>{a.pavadinimas}</strong> ({a.autorius}) —{' '}
                <span className={a.uzblokuotas ? 'tag tag-blocked' : 'tag'}>
                  {a.uzblokuotas ? 'Užblokuotas' : 'Aktyvus'}
                </span>
              </span>
              <button type="button" onClick={() => blokuotiSkelbima(a.id)}>
                {a.uzblokuotas ? 'Atblokuoti' : 'Blokuoti'}
              </button>
            </div>
            {(a.comments || []).map((c) => (
              <div key={c.id} className="comment-item">
                <span>
                  Komentaras ({c.autorius}): {c.tekstas}
                </span>
                <button type="button" className="small-btn" onClick={() => salintiKomentaraAdmin(a.id, c.id)}>
                  Šalinti komentarą
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function Prisijungti({ currentUser, onLogin, logout, notify }) {
  const [vardas, setVardas] = useState('');
  const [slaptazodis, setSlaptazodis] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function issiusti(kelias) {
    const cleanName = vardas.trim();
    if (!cleanName || !slaptazodis) {
      notify('Įveskite vardą ir slaptažodį');
      return;
    }
    if (kelias === '/registr') {
      if (cleanName.length < 3) {
        notify('Vardas turi būti bent 3 simbolių');
        return;
      }
      if (slaptazodis.length < 6) {
        notify('Slaptažodis turi būti bent 6 simbolių');
        return;
      }
    }

    setBusy(true);
    try {
      const userData = await apiFetch(kelias, {
        method: 'POST',
        body: { vardas: cleanName, slaptazodis }
      });
      // NAUJA: administratorius jungiasi per atskirą formą
      if (userData.role === 'admin') {
        notify('Administratorius jungiasi per /admin-login');
        return;
      }
      onLogin(userData);
      notify(
        kelias === '/registr'
          ? `Sveiki, ${userData.vardas}! Registracija sėkminga`
          : `Prisijungta kaip ${userData.vardas} (${userData.role})`
      );
      setSlaptazodis('');
      navigate(userData.role === 'admin' ? '/admin' : '/');
    } catch (err) {
      notify(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (currentUser) {
    return (
      <div className="card form-box">
        <h2>Paskyra</h2>
        <p>
          Prisijungta kaip <strong>{currentUser.vardas}</strong> ({currentUser.role}).
        </p>
        <div className="row-gap">
          <button type="button" onClick={() => navigate('/')}>
            Į skelbimus
          </button>
          <button type="button" onClick={() => logout('Atsijungta')}>
            Atsijungti
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card form-box">
      <h2>Prisijungimas / Registracija</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          issiusti('/login');
        }}
        className="stack-form"
      >
        <input
          placeholder="Vardas"
          value={vardas}
          onChange={(e) => setVardas(e.target.value)}
          autoComplete="username"
        />
        <input
          type="password"
          placeholder="Slaptažodis (registracijai bent 6 simboliai)"
          value={slaptazodis}
          onChange={(e) => setSlaptazodis(e.target.value)}
          autoComplete="current-password"
        />
        <div className="row-gap">
          <button type="submit" className="primary" disabled={busy}>
            Prisijungti
          </button>
          <button type="button" disabled={busy} onClick={() => issiusti('/registr')}>
            Registruotis
          </button>
        </div>
      </form>
    </div>
  );
}

function AdminPrisijungimas({ currentUser, onLogin, logout, notify }) {
  const [vardas, setVardas] = useState('');
  const [slaptazodis, setSlaptazodis] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  if (currentUser?.role === 'admin') {
    return <Navigate to="/admin" replace />;
  }

  if (currentUser) {
    return (
      <div className="card form-box">
        <h2>Administratoriaus prisijungimas</h2>
        <p>
          Šiuo metu prisijungta kaip <strong>{currentUser.vardas}</strong>. Norėdami prisijungti kaip
          administratorius, pirmiausia atsijunkite.
        </p>
        <button type="button" onClick={() => logout('Atsijungta')}>
          Atsijungti
        </button>
      </div>
    );
  }

  async function issiusti(e) {
    e.preventDefault();
    const cleanName = vardas.trim();
    if (!cleanName || !slaptazodis) {
      notify('Įveskite vardą ir slaptažodį');
      return;
    }
    setBusy(true);
    try {
      const userData = await apiFetch('/login', {
        method: 'POST',
        body: { vardas: cleanName, slaptazodis }
      });
      if (userData.role !== 'admin') {
        notify('Ši prisijungimo forma skirta tik administratoriui');
        return;
      }
      onLogin(userData);
      notify(`Prisijungta kaip administratorius ${userData.vardas}`);
      setSlaptazodis('');
      navigate('/admin');
    } catch (err) {
      notify(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card form-box">
      <h2>Administratoriaus prisijungimas</h2>
      <form onSubmit={issiusti} className="stack-form">
        <input
          placeholder="Administratoriaus vardas"
          value={vardas}
          onChange={(e) => setVardas(e.target.value)}
          autoComplete="username"
        />
        <input
          type="password"
          placeholder="Slaptažodis"
          value={slaptazodis}
          onChange={(e) => setSlaptazodis(e.target.value)}
          autoComplete="current-password"
        />
        <button type="submit" className="primary" disabled={busy}>
          Prisijungti
        </button>
      </form>
    </div>
  );
}

function AppContent() {
  const [session, setSession] = useState(loadStoredSession);
  const [categories, setCategories] = useState([]);
  const [ads, setAds] = useState(null);
  const [allAds, setAllAds] = useState([]);
  const [usersList, setUsersList] = useState([]);
  const [favIds, setFavIds] = useState([]);
  const [connError, setConnError] = useState(false);
  const [notice, setNotice] = useState(null);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');

  const requestCounter = useRef(0);

  const currentUser = session ? { vardas: session.vardas, role: session.role } : null;
  const token = session?.token;

  const notify = useCallback((text) => setNotice(text ? { text, key: Date.now() } : null), []);

  const logout = useCallback(
    (message) => {
      setSession(null);
      setFavIds([]);
      setUsersList([]);
      setAllAds([]);
      if (message) notify(message);
    },
    [notify]
  );

  useEffect(() => {
    try {
      if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else localStorage.removeItem(SESSION_KEY);
    } catch {
      // saugykla gali būti nepasiekiama
    }
  }, [session]);

  // Pranešimas išnyksta savaime
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Paieškos frazė siunčiama į serverį su nedideliu vėlinimu
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const api = useCallback(
    async (path, options = {}) => {
      try {
        return await apiFetch(path, { ...options, token });
      } catch (err) {
        if (token && err.status === 401) logout('Sesija pasibaigė, prisijunkite iš naujo');
        if (token && err.code === 'BLOCKED') logout('Jūsų paskyra užblokuota');
        throw err;
      }
    },
    [token, logout]
  );

  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    apiFetch('/me', { token })
      .then((u) => {
        if (cancelled) return;
        setSession((s) => (s && (s.vardas !== u.vardas || s.role !== u.role) ? { ...s, ...u } : s));
      })
      .catch((err) => {
        if (!cancelled && (err.status === 401 || err.code === 'BLOCKED')) {
          logout('Sesija nebegalioja, prisijunkite iš naujo');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshAll = useCallback(
    async (showNotice = false) => {
      const myRequest = ++requestCounter.current;
      const params = new URLSearchParams();
      if (selectedCategory) params.set('categoryId', selectedCategory);
      if (debouncedSearch) params.set('search', debouncedSearch);
      const qs = params.toString();

      try {
        const [cats, adsList] = await Promise.all([api('/categories'), api(`/ads${qs ? `?${qs}` : ''}`)]);
        if (myRequest !== requestCounter.current) return; // atkeliavo pasenęs atsakymas
        setCategories(cats);
        setAds(adsList);
        setConnError(false);

        if (token) {
          try {
            setFavIds(await api('/favorites'));
          } catch {
            // patikusių klaida nesustabdo likusių duomenų
          }
        } else {
          setFavIds([]);
        }

        if (session?.role === 'admin') {
          const [usrList, everyAd] = await Promise.all([api('/users'), api('/ads?includeBlocked=true')]);
          setUsersList(usrList);
          setAllAds(everyAd);
        }

        if (showNotice) notify('Duomenys atnaujinti');
      } catch (err) {
        if (myRequest === requestCounter.current && err.status === 0) setConnError(true);
      }
    },
    [api, token, session?.role, selectedCategory, debouncedSearch, notify]
  );

  useEffect(() => {
    refreshAll(false);
    const timer = setInterval(() => {
      if (!document.hidden) refreshAll(false);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshAll]);

  function handleLogin(userData) {
    setSession({ token: userData.token, vardas: userData.vardas, role: userData.role });
  }

  return (
    <div className="app-container">
      <header className="top-header">
        <h1>Skelbimų platforma</h1>
        <nav className="nav-bar">
          <NavLink to="/" end>
            Skelbimai
          </NavLink>
          {currentUser?.role === 'admin' && <NavLink to="/admin">Administravimas</NavLink>}
          <NavLink to="/login">
            {currentUser ? `${currentUser.vardas} (${currentUser.role})` : 'Prisijungti'}
          </NavLink>
          {/* NAUJA: administratoriaus prisijungimo nuoroda */}
          {!currentUser && <NavLink to="/admin-login">Admin prisijungimas</NavLink>}
          {currentUser && (
            <button type="button" className="small-btn" onClick={() => logout('Atsijungta')}>
              Atsijungti
            </button>
          )}
        </nav>
      </header>

      {notice && (
        <div className="notice-box" role="status" onClick={() => setNotice(null)}>
          {notice.text}
        </div>
      )}

      <main>
        <Routes>
          <Route
            path="/"
            element={
              <Skelbimai
                categories={categories}
                ads={ads}
                connError={connError}
                favIds={favIds}
                refreshAll={refreshAll}
                currentUser={currentUser}
                api={api}
                notify={notify}
                search={search}
                setSearch={setSearch}
                selectedCategory={selectedCategory}
                setSelectedCategory={setSelectedCategory}
              />
            }
          />
          <Route
            path="/admin"
            element={
              <AdminPanel
                categories={categories}
                usersList={usersList}
                allAds={allAds}
                refreshAll={refreshAll}
                currentUser={currentUser}
                api={api}
                notify={notify}
              />
            }
          />
          <Route
            path="/login"
            element={<Prisijungti currentUser={currentUser} onLogin={handleLogin} logout={logout} notify={notify} />}
          />
          {/* NAUJA: atskiras administratoriaus prisijungimas */}
          <Route
            path="/admin-login"
            element={
              <AdminPrisijungimas currentUser={currentUser} onLogin={handleLogin} logout={logout} notify={notify} />
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}

export default App;