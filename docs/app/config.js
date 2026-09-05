// Public runtime config for match.html's client-side calls to the football
// feed. This value is visible to anyone who opens the site (view-source,
// browser dev tools network tab) — it is NOT a secret once it lands here. See
// README "Live data (client-side)" before changing it. Use the same value as
// the RAPIDAPI_KEY repo secret (used server-side by refresh-fixtures.yml); if
// this public copy is ever abused, rotate it in the RapidAPI dashboard, here,
// and in the repo secret.
window.PM_CONFIG = {
  rapidApiKey: 'REPLACE_WITH_RAPIDAPI_KEY'
};
