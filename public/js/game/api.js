// public/js/game/api.js — thin fetch wrapper with JWT injection
export const api = {
  _token: null,
  setToken(t) { this._token = t; },

  async _req(method, path, body) {
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this._token ? { Authorization: `Bearer ${this._token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    };
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },

  get:  (path)        => api._req('GET',  path),
  post: (path, body)  => api._req('POST', path, body),

  // Auth
  register: (u, p)   => api.post('/api/auth/register', { username: u, password: p }),
  login:    (u, p)   => api.post('/api/auth/login',    { username: u, password: p }),

  // Game
  getState:         ()          => api.get('/api/game/state'),
  processQueue:     ()          => api.post('/api/game/process-queue'),
  buildPlanet:      (idx, type) => api.post('/api/game/build-planet',     { orbit_index: idx, type }),
  upgradePlanet:    (id)        => api.post('/api/game/upgrade-planet',   { planet_id: id }),
  deletePlanet:     (id)        => api._req('DELETE', `/api/game/planet/${id}`),
  upgradeStar:      ()          => api.post('/api/game/upgrade-star'),
  getGalaxy:        ()          => api.get('/api/game/galaxy'),
  battle:           (uid)       => api.post('/api/game/battle',           { defender_user_id: uid }),
  getBattleLog:     ()          => api.get('/api/game/battle-log'),
  renameSystem:     (name)      => api._req('PATCH', '/api/game/rename-system', { name }),
  renamePlanet:     (id, name)  => api._req('PATCH', '/api/game/rename-planet', { planet_id: id, name }),

  buildBuilding:    (pId, type)    => api.post('/api/game/build-building',    { planet_id: pId, type }),
  tradeShipVisit:   ()             => api.post('/api/game/trade-ship-visit'),

  // Admin
  adminGetLogs:        (p)              => api.get(`/api/admin/logs?${new URLSearchParams(p)}`),
  adminClearLogs:      ()               => api._req('DELETE', '/api/admin/logs'),
  adminGetUsers:       ()               => api.get('/api/admin/users'),
  adminGetStats:       ()               => api.get('/api/admin/stats'),
  adminResetSelf:      ()               => api.post('/api/admin/reset-self'),
  adminResetUser:      (uid)            => api.post('/api/admin/reset-user',      { user_id: uid }),
  adminDeleteUser:     (uid)            => api._req('DELETE', `/api/admin/user/${uid}`),
  adminGrantResources: (uid, e, m, c)   => api.post('/api/admin/grant-resources', { user_id: uid, energy: e, matter: m, credits: c }),
  adminSetResources:   (uid, e, m, c)   => api.post('/api/admin/set-resources',   { user_id: uid, energy: e, matter: m, credits: c }),
  adminCompleteQueue:  (uid)            => api.post('/api/admin/complete-queue',   uid ? { user_id: uid } : {}),
  adminAddPlanet:      (uid, t, o, l)   => api.post('/api/admin/add-planet',       { user_id: uid, type: t, orbit_index: o, level: l }),
  adminRemovePlanet:   (pid)            => api.post('/api/admin/remove-planet',    { planet_id: pid }),
};
