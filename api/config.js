// Vercel function. Hands the page its Supabase address and public (anon) key
// from environment variables, so nothing is committed and no build step is needed.
// The anon key is safe to send to browsers: the database rules decide what each
// signed-in person can see.
module.exports = function (req, res) {
  var cfg = {
    url: process.env.SUPABASE_URL || '',
    key: process.env.SUPABASE_ANON_KEY || ''
  };
  var body = 'window.NPC_CONFIG=' + JSON.stringify(cfg).replace(/</g, '\\u003c') + ';';
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(body);
};
