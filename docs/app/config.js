// The Match Center makes no client-side API calls any more. The data pipeline
// moved to API-Football, which is used server-side only (in the GitHub Actions)
// so no key is exposed in the page. This file is kept as a harmless empty stub
// so match.html's <script src="app/config.js"> tag doesn't 404.
window.PM_CONFIG = {
  // Collaboration is optional. Create a free Supabase project, run the SQL in
  // docs/supabase.sql, then set these two public browser values. The anon key
  // is designed to be public; access is constrained by the SQL RLS policies.
  supabaseUrl: 'https://jcanxrqtlaemyklxnoit.supabase.co',
  supabaseAnonKey: 'sb_publishable_owqPyzyfHHfMZiAuTFkV4w_cNJi7Z8r'
};
