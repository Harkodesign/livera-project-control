/* Local stand-in for supabase-js, for trying the site without a Supabase project.
   Loaded only by dev/server.js. It copies the access rules in supabase/schema.sql
   so the roles behave the same, but it is NOT a test of the real SQL.
   Data lives in this browser's localStorage; uploaded files live in memory until reload.
   Sign in as owner@example.com, editor@example.com, contributor@example.com,
   viewer@example.com, or any other address (which gets "No access yet"). */
(function () {
'use strict';
var KEY = 'npc-mock-db', SKEY = 'npc-mock-session', LIMIT = 50 * 1048576;
var blobs = {}, authCbs = [], rtCbs = [];
var bc = window.BroadcastChannel ? new BroadcastChannel('npc-mock') : null;

function read() {
  try { var d = JSON.parse(localStorage.getItem(KEY)); if (d && d.members && d.records) return d; } catch (e) {}
  return { members: [
    { email: 'owner@example.com', role: 'owner', name: 'Test Owner' },
    { email: 'editor@example.com', role: 'editor', name: 'Test Editor' },
    { email: 'contributor@example.com', role: 'contributor', name: 'Test Contributor' },
    { email: 'viewer@example.com', role: 'viewer', name: 'Test Viewer' }
  ], records: [] };
}
function write(d) { localStorage.setItem(KEY, JSON.stringify(d)); }
function session() { try { return JSON.parse(localStorage.getItem(SKEY)); } catch (e) { return null; } }
function me() { var s = session(); return s ? s.user.email : null; }
function role() { var e = me(); var m = read().members.filter(function (x) { return x.email === e; })[0]; return m ? m.role : null; }
function denied() { return { data: null, error: { code: '42501', status: 403, message: 'new row violates row-level security policy' } }; }
function canRead(col) { var r = role(); return /^(budget|payments)$/.test(col) ? (r === 'owner' || r === 'editor') : !!r; }
function canWrite(col) { var r = role(); return /^(budget|payments|meta)$/.test(col) ? (r === 'owner' || r === 'editor') : (r === 'owner' || r === 'editor' || r === 'contributor'); }
function changed(col) { rtCbs.forEach(function (cb) { setTimeout(function () { cb({ new: { col: col } }); }, 20); }); if (bc) bc.postMessage({ col: col }); }
if (bc) bc.onmessage = function (ev) { rtCbs.forEach(function (cb) { cb({ new: { col: ev.data.col } }); }); };

function Q(table) { this.t = table; this.op = 'select'; this.f = {}; this.ret = false; }
Q.prototype.select = function () { this.ret = true; return this; };
Q.prototype.eq = function (k, v) { this.f[k] = v; return this; };
Q.prototype.order = function () { return this; };
Q.prototype.upsert = function (rows) { this.op = 'upsert'; this.rows = [].concat(rows); return this; };
Q.prototype.delete = function () { this.op = 'delete'; return this; };
Q.prototype.then = function (a, b) { var self = this; return new Promise(function (r) { setTimeout(function () { r(self.run()); }, 30); }).then(a, b); };
Q.prototype.match = function (row) { var f = this.f; return Object.keys(f).every(function (k) { return row[k] === f[k]; }); };
Q.prototype.run = function () {
  var d = read(), self = this, t = this.t;
  if (!me()) return denied();
  if (t === 'records') {
    if (this.op === 'select') return { data: d.records.filter(function (r) { return self.match(r) && canRead(r.col); }).map(function (r) { return { id: r.id, data: r.data }; }), error: null };
    if (this.op === 'upsert') {
      if (!this.rows.every(function (r) { return canWrite(r.col); })) return denied();
      var cols = {};
      this.rows.forEach(function (r) {
        d.records = d.records.filter(function (x) { return !(x.col === r.col && x.id === r.id); });
        d.records.push({ col: r.col, id: r.id, data: JSON.parse(JSON.stringify(r.data)), updated_at: new Date().toISOString(), updated_by: me() }); cols[r.col] = 1;
      });
      write(d); Object.keys(cols).forEach(changed); return { data: null, error: null };
    }
    var gone = d.records.filter(function (r) { return self.match(r) && canWrite(r.col); });
    d.records = d.records.filter(function (r) { return gone.indexOf(r) < 0; }); write(d);
    gone.forEach(function (r) { changed(r.col); });
    return { data: gone.map(function (r) { return { id: r.id }; }), error: null };
  }
  if (t === 'members') {
    if (this.op === 'select') return { data: role() ? d.members.slice().sort(function (a, b) { return a.email < b.email ? -1 : 1; }) : [], error: null };
    if (role() !== 'owner') return this.op === 'upsert' ? denied() : { data: [], error: null };
    if (this.op === 'upsert') { this.rows.forEach(function (r) { d.members = d.members.filter(function (x) { return x.email !== r.email; }); d.members.push(r); }); write(d); return { data: null, error: null }; }
    var out = d.members.filter(function (m) { return self.match(m); });
    d.members = d.members.filter(function (m) { return out.indexOf(m) < 0; }); write(d);
    return { data: out.map(function (m) { return { email: m.email }; }), error: null };
  }
  return { data: null, error: { message: 'unknown table' } };
};

function later(v) { return new Promise(function (r) { setTimeout(function () { r(v); }, 30); }); }
function fire(ev) { var s = session(); authCbs.forEach(function (cb) { setTimeout(function () { cb(ev, s); }, 0); }); }

window.supabase = { createClient: function () {
  return {
    auth: {
      onAuthStateChange: function (cb) { authCbs.push(cb); setTimeout(function () { cb('INITIAL_SESSION', session()); }, 40); return { data: { subscription: { unsubscribe: function () {} } } }; },
      signInWithOtp: function (o) { localStorage.setItem(SKEY, JSON.stringify({ user: { email: String(o.email).toLowerCase() } })); fire('SIGNED_IN'); return later({ data: {}, error: null }); },
      signOut: function () { localStorage.removeItem(SKEY); fire('SIGNED_OUT'); return later({ error: null }); }
    },
    from: function (t) { return new Q(t); },
    rpc: function (fn) {
      if (fn === 'npc_role') return later({ data: role(), error: null });
      if (fn === 'npc_storage_bytes') { var r = role(); return later({ data: r === 'owner' || r === 'editor' ? Object.keys(blobs).reduce(function (a, k) { return a + blobs[k].size; }, 0) : null, error: null }); }
      return later({ data: null, error: { message: 'unknown function' } });
    },
    storage: { from: function () { return {
      upload: function (path, file) {
        var r = role();
        if (!(r === 'owner' || r === 'editor' || r === 'contributor')) return later(denied());
        if (file.size > LIMIT) return later({ data: null, error: { statusCode: '413', message: 'The object exceeded the maximum allowed size' } });
        blobs[path] = file; return later({ data: { path: path }, error: null });
      },
      createSignedUrl: function (path) { return later(blobs[path] && role() ? { data: { signedUrl: URL.createObjectURL(blobs[path]) }, error: null } : { data: null, error: { statusCode: '404', message: 'Object not found' } }); },
      remove: function (paths) { var r = role(); if (r === 'owner' || r === 'editor') paths.forEach(function (p) { delete blobs[p]; }); return later({ data: [], error: null }); }
    }; } },
    channel: function () { return { on: function (a, b, cb) { rtCbs.push(cb); return this; }, subscribe: function () { return this; } }; }
  };
} };
})();
