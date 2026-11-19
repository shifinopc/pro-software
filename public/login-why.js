// WHY A SIGN-IN FAILED, IN WORDS THAT NAME THE ACTUAL FAULT.
//
// Shared by the console and the client portal, which both had one message for every failure.
// Loaded as its own file rather than copied into each page: support.js is generated and must not be
// hand-edited, and two copies of a message is how the two halves of a product start disagreeing
// about what happened.
//
// Global on purpose — the app scripts are compiled runtime blocks, not modules, and this is how
// they see it.
window._loginWhy9 = function (status, resetSeconds, body, fallback) {
  var said = body && body.error ? String(body.error) : '';
  // The server's own words come first wherever it sent any: it knows more than this does — which
  // account is locked, which portal is suspended, why.
  if (status === 429) {
    // ...except that a rate limit never says WHEN, and "later" is what makes somebody keep
    // pressing, which is precisely what spent the limit. RateLimit-Reset is in seconds.
    var secs = Number(resetSeconds);
    var when = (secs > 0)
      ? (secs < 90 ? ' Try again in ' + Math.ceil(secs) + ' seconds.'
                   : ' Try again in ' + Math.ceil(secs / 60) + ' minutes.')
      : '';
    var lead = said || 'Too many attempts';
    if (!/[.!?]$/.test(lead)) lead += '.';   // the server's text has no full stop; two sentences follow it
    return lead + when + ' Your password is not the problem.';
  }
  // A 5xx is the server failing, not the person typing. This is the one that cost hours: an API
  // whose database had gone missing answered every attempt with a fault that read as a bad
  // password, so the password was retyped instead of the server being looked at.
  if (status >= 500) {
    return 'The server answered with an error (HTTP ' + status + ')' + (said ? ' — ' + said : '')
      + '. This is not your password: check that the API and its database are running.';
  }
  // Reaching here with nothing said at all means the response had no body to read.
  return said || fallback || 'Invalid credentials';
};
