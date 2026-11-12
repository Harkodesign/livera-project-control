/* Project Control backend.
   Gives the page the four small interfaces it expects (db, assets, user, downloads)
   through window.claude.use(name), built on Supabase. Also owns the sign-in screen,
   the member list, signed file links and the data-pack import (window.NPC). */
(function () {
'use strict';

var BUCKET = 'project-files';
var MAX_BYTES = 50 * 1048576;      // 50 MB per file, same as the bucket limit
var SIGN_TTL = 3600;               // signed links live for 60 minutes
var URL_CACHE_MS = 50 * 60 * 1000; // and are reused for 50
var POLL_MS = 60000;
var IMPORT_COLS = ['stages','tasks','files','drawings','approvals','logs','snags','checks','materials','people','budget','payments','meta'];

var cfg = window.NPC_CONFIG || {};
var sb = null, role = null, email = null, members = [];
var listeners = {}, cache = {}, sigs = {}, timers = {}, urls = {};
var readyResolve, ready = new Promise(function (r) { readyResolve = r; });

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function uid() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12); }
function fail(code, cause, message) { var e = new Error(message || code); e.code = code; e.cause = cause; return e; }

/* Turn a Supabase error into one of the codes the page already has messages for. */
function mapErr(e) {
  var msg = String((e && (e.message || e.error)) || ''), st = String((e && (e.status || e.statusCode)) || ''), c = e && e.code;
  if (st === '413' || /maximum allowed size|too large|exceeded/i.test(msg)) return fail('too_large', e);
  if (c === '42501' || st === '403' || /row-level security|not authorized|permission denied|unauthorized/i.test(msg)) return fail('invalid_argument', e);
  if (st === '401' || c === 'PGRST301' || /jwt/i.test(msg)) return fail('revoked', e);
  return fail('failed', e, msg || 'failed');
}
function check(res) { if (res && res.error) throw mapErr(res.error); return res ? res.data : null; }

/* ------------------------------------------------------------------ db */

function sigOf(rows) { return JSON.stringify(Object.keys(rows).sort().map(function (id) { return [id, rows[id]]; })); }
function emit(col) {
  var rows = cache[col] || {};
  var docs = Object.keys(rows).map(function (id) { var d = rows[id]; return { id: id, data: function () { return clone(d); } }; });
  (listeners[col] || []).forEach(function (l) { try { l.next({ docs: docs, metadata: { fromCache: false } }); } catch (e) { if (window.console) console.error(e); } });
}
function load(col) {
  return sb.from('records').select('id,data').eq('col', col).then(function (res) {
    if (res.error) {
      if (!cache[col]) { var e = mapErr(res.error); (listeners[col] || []).forEach(function (l) { if (l.error) l.error(e); }); }
      return;
    }
    var rows = {}; (res.data || []).forEach(function (r) { rows[r.id] = r.data || {}; });
    var sig = sigOf(rows), first = !cache[col];
    cache[col] = rows;
    if (first || sig !== sigs[col]) { sigs[col] = sig; emit(col); }
  }, function () {});
}
function queue(col) { clearTimeout(timers[col]); timers[col] = setTimeout(function () { load(col); }, 150); }
function reloadAll() { Object.keys(listeners).forEach(function (c) { load(c); }); }

function collection(col) {
  return {
    onSnapshot: function (next, error) {
      var l = { next: next, error: error };
      (listeners[col] = listeners[col] || []).push(l);
      if (cache[col]) setTimeout(function () { emit(col); }, 0); else load(col);
      return function () { listeners[col] = (listeners[col] || []).filter(function (x) { return x !== l; }); };
    },
    doc: function (id) {
      id = id || uid();
      return {
        id: id,
        set: function (data) {
          var d = clone(data);
          return sb.from('records').upsert({ col: col, id: id, data: d }, { onConflict: 'col,id' }).then(function (res) {
            check(res);
            (cache[col] = cache[col] || {})[id] = d; sigs[col] = sigOf(cache[col]); emit(col);
          });
        },
        delete: function () {
          return sb.from('records').delete().eq('col', col).eq('id', id).select('id').then(function (res) {
            var gone = check(res);
            if (!gone || !gone.length) throw fail('invalid_argument');
            if (cache[col]) { delete cache[col][id]; sigs[col] = sigOf(cache[col]); }
            emit(col);
          });
        }
      };
    }
  };
}

function live() {
  try {
    sb.channel('npc-records')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'records' }, function (p) {
        var c = (p && p.new && p.new.col) || (p && p.old && p.old.col);
        if (c) { if (listeners[c]) queue(c); } else Object.keys(listeners).forEach(queue);
      })
      .subscribe();
  } catch (e) { if (window.console) console.warn(e); }
  setInterval(function () { if (document.visibilityState === 'visible') reloadAll(); }, POLL_MS);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') reloadAll(); });
}

/* ---------------------------------------------------------------- user */

function memberBy(id) { id = String(id || '').toLowerCase(); return members.filter(function (m) { return m.email === id; })[0]; }
function myName() { var m = memberBy(email); return (m && m.name) || String(email || '').split('@')[0]; }
function isAdmin() { return role === 'owner' || role === 'editor'; }

var user = {
  me: function () { return Promise.resolve({ id: email, name: myName(), isOwner: role === 'owner', canEdit: isAdmin() }); },
  canEdit: function () { return Promise.resolve(isAdmin()); },
  can: function (what) { return Promise.resolve(what === 'data.write' ? role !== 'viewer' : true); },
  profiles: function (ids) {
    var out = {};
    (ids || []).forEach(function (i) {
      var m = memberBy(i);
      if (m) out[i] = { name: m.name || m.email };
      else if (/@/.test(i)) out[i] = { name: String(i).split('@')[0] };
    });
    return Promise.resolve(out);
  }
};

function listMembers() {
  return sb.from('members').select('email,role,name').order('email').then(function (res) { members = check(res) || []; return members.slice(); });
}

/* -------------------------------------------------------------- assets */

var assets = {
  upload: function (file, opt) {
    if (file.size > MAX_BYTES) return Promise.reject(fail('too_large'));
    var type = (opt && opt.type) || file.type || 'application/octet-stream';
    var m = /\.([A-Za-z0-9]{1,8})$/.exec(file.name || '');
    var path = new Date().toISOString().slice(0, 7) + '/' + uid() + (m ? '.' + m[1].toLowerCase() : '');
    return sb.storage.from(BUCKET).upload(path, file, { contentType: type, cacheControl: '3600', upsert: false }).then(function (res) {
      check(res);
      return { id: path, sizeBytes: file.size, contentType: type };
    });
  },
  delete: function (id) {
    delete urls[id];
    return sb.storage.from(BUCKET).remove([id]).then(function (res) { check(res); });
  },
  list: function () {
    return sb.rpc('npc_storage_bytes').then(function (res) {
      return { usage: res.error || res.data == null ? null : { bytes: Number(res.data) } };
    });
  }
};

/* A short-lived signed link for a stored file. Reused for 50 minutes. */
function signedUrl(id) {
  var hit = urls[id];
  if (hit && Date.now() - hit.at < URL_CACHE_MS) return hit.p;
  var p = sb.storage.from(BUCKET).createSignedUrl(id, SIGN_TTL).then(function (res) {
    var d = check(res);
    if (!d || !d.signedUrl) throw fail('missing');
    return d.signedUrl;
  });
  urls[id] = { at: Date.now(), p: p };
  p.catch(function () { if (urls[id] && urls[id].p === p) delete urls[id]; });
  return p;
}

/* ----------------------------------------------------------- downloads */

var downloads = {
  save: function (o) {
    var u = URL.createObjectURL(o.data), a = document.createElement('a');
    a.href = u; a.download = o.filename || 'download'; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(u); }, 4000);
    return Promise.resolve();
  }
};

/* ------------------------------------------------------ member admin */

var memberAdmin = {
  list: listMembers,
  save: function (m) {
    var em = String(m.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return Promise.reject(fail('bad_email', null, 'Enter a full email address.'));
    if (em === email) return Promise.reject(fail('self', null, 'You can’t change your own access.'));
    if (['owner', 'editor', 'contributor', 'viewer'].indexOf(m.role) < 0) return Promise.reject(fail('bad_role', null, 'Choose a role.'));
    return sb.from('members').upsert({ email: em, role: m.role, name: String(m.name || '').trim() || null }, { onConflict: 'email' })
      .then(function (res) { check(res); return listMembers(); });
  },
  remove: function (em) {
    em = String(em || '').toLowerCase();
    if (em === email) return Promise.reject(fail('self', null, 'You can’t remove yourself.'));
    return sb.from('members').delete().eq('email', em).select('email').then(function (res) {
      var gone = check(res); if (!gone || !gone.length) throw fail('invalid_argument');
      return listMembers();
    });
  }
};

/* -------------------------------------------------- data-pack import */
/* files: everything the owner picked. One of them is data.json = { col: { id: doc } }.
   A file version (or a photo entry) that names a picked file by "src" is uploaded and
   re-pointed at the stored copy. */

function baseName(s) { return String(s || '').split(/[\\/]/).pop().toLowerCase(); }

function importPack(fileList, onProgress) {
  var files = Array.prototype.slice.call(fileList || []);
  var say = function (m) { if (onProgress) try { onProgress(m); } catch (e) {} };
  var packFile = files.filter(function (f) { return baseName(f.name) === 'data.json'; })[0];
  if (!packFile) return Promise.reject(fail('no_pack', null, 'Include data.json in your selection.'));
  var byName = {}; files.forEach(function (f) { if (f !== packFile) byName[baseName(f.name)] = f; });
  var out = { records: 0, uploaded: 0, missing: [], skipped: [] };

  return packFile.text().then(function (txt) {
    var pack;
    try { pack = JSON.parse(txt); } catch (e) { throw fail('bad_pack', e, 'data.json isn’t valid JSON.'); }
    if (!pack || typeof pack !== 'object' || Array.isArray(pack)) throw fail('bad_pack', null, 'data.json doesn’t look like a data pack.');

    // 1. Collect every upload the pack asks for.
    var jobs = [];
    Object.keys(pack).forEach(function (col) {
      if (IMPORT_COLS.indexOf(col) < 0) { out.skipped.push(col); return; }
      var docs = pack[col] || {};
      Object.keys(docs).forEach(function (id) {
        var d = docs[id];
        if (col === 'files' && Array.isArray(d.versions)) d.versions.forEach(function (v) {
          if (v && v.src) jobs.push({ name: v.src, done: function (r, f) { v.asset = r.id; v.size = r.sizeBytes; v.type = r.contentType; if (!v.fname) v.fname = f.name; delete v.src; }, miss: function () { delete v.src; } });
        });
        if (Array.isArray(d.photos)) d.photos.forEach(function (ph, i) {
          var src = ph && typeof ph === 'object' ? ph.src : null;
          if (src) jobs.push({ name: src, done: function (r) { d.photos[i] = r.id; }, miss: function () { d.photos[i] = null; } });
        });
      });
    });

    // 2. Upload them one at a time.
    var chain = Promise.resolve();
    jobs.forEach(function (j, n) {
      chain = chain.then(function () {
        var f = byName[baseName(j.name)];
        if (!f) { out.missing.push(String(j.name)); j.miss(); return; }
        say('Uploading file ' + (n + 1) + ' of ' + jobs.length + ': ' + f.name);
        return assets.upload(f).then(function (r) { out.uploaded++; j.done(r, f); }, function (e) {
          out.missing.push(String(j.name) + (e && e.code === 'too_large' ? ' (over 50 MB)' : ' (upload failed)')); j.miss();
        });
      });
    });

    // 3. Write the records, a batch at a time.
    return chain.then(function () {
      var rows = [];
      Object.keys(pack).forEach(function (col) {
        if (IMPORT_COLS.indexOf(col) < 0) return;
        var docs = pack[col] || {};
        Object.keys(docs).forEach(function (id) {
          var d = docs[id]; if (!d || typeof d !== 'object') return;
          if (Array.isArray(d.photos)) d.photos = d.photos.filter(function (x) { return typeof x === 'string' && x; });
          rows.push({ col: col, id: String(id), data: d });
        });
      });
      var w = Promise.resolve();
      for (var i = 0; i < rows.length; i += 100) (function (batch, from) {
        w = w.then(function () {
          say('Saving records ' + (from + 1) + ' to ' + (from + batch.length) + ' of ' + rows.length);
          return sb.from('records').upsert(batch, { onConflict: 'col,id' }).then(function (res) { check(res); out.records += batch.length; });
        });
      })(rows.slice(i, i + 100), i);
      return w;
    }).then(function () { reloadAll(); return out; });
  });
}

/* -------------------------------------------------------- sign-in gate */

var LOGO = '<svg viewBox="0 0 1837 198" role="img" aria-label="LIVERA" style="width:128px;height:auto;display:block;margin:0 0 22px"><path fill="currentColor" d="M0 0H44V155H219V198H0Z M333 0H377V198H333Z M492 0H542L629.5 137L717 0H767L644.5 198H614.5Z M884 0H1101V43H928V78H1101V121H928V155H1101V198H884Z M1230 0H1383A72 72 0 0 1 1418 135L1461 198H1410L1373 144H1274V198H1230Z M1274 44V101H1383A28.5 28.5 0 0 0 1383 44Z M1685 0H1714L1837 198H1787L1699.5 61L1612 198H1562Z"/></svg>';
var gateEl = null;

function gate(html) {
  if (!gateEl) {
    gateEl = document.createElement('div');
    gateEl.id = 'npc-gate';
    gateEl.setAttribute('style', 'position:fixed;inset:0;z-index:100;background:var(--bg,#f7f5f1);color:var(--ink,#221e1b);display:flex;align-items:center;justify-content:center;padding:24px 16px;overflow:auto');
    document.body.appendChild(gateEl);
  }
  gateEl.hidden = false;
  gateEl.innerHTML = '<div style="width:min(400px,100%);background:var(--surface,#fff);border:1px solid var(--line,#e2dbd0);border-radius:12px;padding:28px 26px;box-shadow:var(--shadow,none)">' + LOGO +
    '<div class="eyebrow">Project control</div>' + html + '</div>';
}
function gateOff() { if (gateEl) { gateEl.hidden = true; gateEl.innerHTML = ''; } }
function gateMsg(title, body) { gate('<h1 style="font-size:22px;margin:4px 0 10px">' + esc(title) + '</h1><p style="margin:0;color:var(--muted,#6e6862)">' + body + '</p>'); }

function gateSignIn(note) {
  gate('<h1 style="font-size:22px;margin:4px 0 6px">Sign in</h1>' +
    '<p style="margin:0 0 16px;color:var(--muted,#6e6862)">Enter your email and we’ll send you a sign-in link. No password needed.</p>' +
    '<form id="npc-si" novalidate><label for="npc-email" style="display:block;font-size:12px;font-weight:600;color:var(--muted,#6e6862);margin-bottom:4px">Email</label>' +
    '<input id="npc-email" type="email" autocomplete="email" inputmode="email" required style="width:100%;background:var(--surface,#fff);border:1px solid var(--line,#e2dbd0);border-radius:7px;padding:9px 10px;font:inherit;color:inherit">' +
    '<button class="btn" id="npc-go" style="margin-top:12px;width:100%;justify-content:center;padding:9px 13px">Email me a sign-in link</button></form>' +
    '<p id="npc-note" class="ferr"' + (note ? '' : ' hidden') + '>' + esc(note || '') + '</p>');
  var form = document.getElementById('npc-si'), input = document.getElementById('npc-email'), btn = document.getElementById('npc-go'), nt = document.getElementById('npc-note');
  input.focus();
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var em = input.value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { nt.textContent = 'Enter your full email address.'; nt.hidden = false; return; }
    btn.disabled = true; btn.textContent = 'Sending…'; nt.hidden = true;
    sb.auth.signInWithOtp({ email: em, options: { emailRedirectTo: location.origin + location.pathname } }).then(function (res) {
      if (res.error) {
        btn.disabled = false; btn.textContent = 'Email me a sign-in link';
        nt.textContent = /rate|too many|seconds/i.test(res.error.message || '') ? 'Too many sign-in emails just now. Wait a few minutes and try again.' : 'The link couldn’t be sent. Check the address and try again.';
        nt.hidden = false; return;
      }
      if (!signedIn) gateMsg('Check your email', 'A sign-in link is on its way to <b>' + esc(em) + '</b>. Open it on this device, in this browser. You can close this tab.');
    });
  });
}

function gateNoAccess() {
  gate('<h1 style="font-size:22px;margin:4px 0 10px">No access yet</h1>' +
    '<p style="margin:0 0 16px;color:var(--muted,#6e6862)">You’re signed in as <b>' + esc(email) + '</b>, but this address isn’t on the project’s list. Ask the project owner to add you, then reload this page.</p>' +
    '<button class="btn ghost" id="npc-out">Sign out</button>');
  document.getElementById('npc-out').addEventListener('click', signOut);
}

function signOut() {
  var done = function () { location.reload(); };
  if (!sb) return done();
  sb.auth.signOut().then(done, done);
}

var signedIn = false;

function enter(session) {
  email = String((session.user && session.user.email) || '').toLowerCase();
  // Drop the one-time ?code= from the address bar; keep the #section.
  try {
    var q = new URLSearchParams(location.search);
    if (q.has('code') || q.has('error') || q.has('error_description')) history.replaceState(null, '', location.pathname + location.hash);
  } catch (e) {}
  gateMsg('Signing you in…', 'One moment.');
  sb.rpc('npc_role').then(function (res) {
    if (res.error) { gate('<h1 style="font-size:22px;margin:4px 0 10px">Can’t reach the project</h1><p style="margin:0 0 16px;color:var(--muted,#6e6862)">The database didn’t answer. Reload to try again.</p><button class="btn ghost" id="npc-out">Sign out</button>'); document.getElementById('npc-out').addEventListener('click', signOut); return; }
    role = res.data || null;
    if (!role) { gateNoAccess(); return; }
    return listMembers().catch(function () { members = []; }).then(function () {
      gateOff(); live(); readyResolve();
    });
  });
}

function init() {
  if (!cfg.url || !cfg.key) { gateMsg('Not set up yet', 'This site is missing its database settings. The owner needs to add SUPABASE_URL and SUPABASE_ANON_KEY in Vercel and redeploy.'); return; }
  if (!window.supabase || !window.supabase.createClient) { gateMsg('Can’t load', 'Part of the page didn’t load. Check your connection and reload.'); return; }
  sb = window.supabase.createClient(cfg.url, cfg.key, { auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true } });
  gateMsg('Loading…', 'Checking your sign-in.');
  var q = new URLSearchParams(location.search);
  var hadCode = q.has('code'), urlErr = q.get('error_description');
  sb.auth.onAuthStateChange(function (ev, session) {
    if (ev === 'SIGNED_OUT') { if (signedIn) location.reload(); return; }
    if (session && !signedIn) { signedIn = true; setTimeout(function () { enter(session); }, 0); return; }
    if (!session && ev === 'INITIAL_SESSION') {
      gateSignIn(urlErr ? 'That sign-in link didn’t work: ' + urlErr + '. Ask for a new one.' : hadCode ? 'That sign-in link didn’t work. A link works once, and only in the browser that asked for it. Ask for a new one.' : '');
    }
  });
}

var apis = { db: { collection: collection }, user: user, assets: assets, downloads: downloads };
window.claude = { use: function (name) { return ready.then(function () { return apis[name] || null; }); } };
window.NPC = { url: signedUrl, members: memberAdmin, importPack: importPack, signOut: signOut, maxBytes: MAX_BYTES };

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
