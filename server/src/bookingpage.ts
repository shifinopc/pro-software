/**
 * The page a client actually sees.
 *
 * Served from the API as one self-contained document, not as a third entry point in the Vite app.
 * Three reasons, in order of how much they matter:
 *
 *   · It has to work when the console does not. This is the one surface a paying client meets
 *     unprompted, and "the booking page is down because we were deploying" is the worst possible
 *     time for this firm to look disorganised.
 *   · It needs no auth, no router, no design system and no bundle. Everything it does is a fetch
 *     and a form.
 *   · It cannot leak anything. There is no shared state with the console because there is no shared
 *     code with the console.
 *
 * Deliberately plain. A client booking a visa consultation wants to see when they can be seen, not
 * an animation. The only thing styled with any care is the slot grid, because that is the part
 * being read.
 */

/** Escaped once, on the way in. The slug is the only thing from the URL that reaches the markup. */
const esc = (s: string) =>
  String(s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));

export function bookingPage(slug: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Book a time</title>
<!-- No indexing: a booking link is given to somebody, not advertised. -->
<meta name="robots" content="noindex,nofollow">
<style>
  *{box-sizing:border-box}
  body{margin:0;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1A1523;background:#F7F5FB}
  .wrap{max-width:640px;margin:0 auto;padding:32px 20px 64px}
  .card{background:#fff;border:1px solid #EDEBF2;border-radius:18px;padding:26px 24px;box-shadow:0 1px 3px rgba(38,7,77,.05)}
  h1{margin:0;font-size:22px;letter-spacing:-.01em}
  .sub{color:#6F6C7A;font-size:13.5px;margin-top:6px}
  .zone{margin-top:14px;padding:9px 12px;background:#F5EEFF;border-radius:10px;font-size:12.5px;color:#5B21A8}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.07em;color:#8C8899;margin:26px 0 10px}
  .day{margin-bottom:18px}
  .dayname{font-weight:700;font-size:13.5px;margin-bottom:8px}
  .slots{display:flex;flex-wrap:wrap;gap:8px}
  button.slot{font:inherit;font-size:13.5px;padding:9px 14px;border:1px solid #DDD9E6;background:#fff;border-radius:10px;cursor:pointer;font-variant-numeric:tabular-nums}
  button.slot:hover{border-color:#7C00FF;color:#7C00FF}
  button.slot[aria-pressed="true"]{background:#7C00FF;border-color:#7C00FF;color:#fff}
  label{display:block;font-size:11.5px;font-weight:700;color:#8C8899;letter-spacing:.05em;margin:14px 0 5px;text-transform:uppercase}
  input,textarea{width:100%;font:inherit;font-size:14px;padding:10px 12px;border:1px solid #DDD9E6;border-radius:10px;background:#FCFBFE}
  input:focus,textarea:focus{outline:none;border-color:#7C00FF;box-shadow:0 0 0 3px rgba(124,0,255,.12)}
  .go{margin-top:20px;width:100%;font:inherit;font-size:15px;font-weight:600;padding:13px;border:none;border-radius:99px;background:#7C00FF;color:#fff;cursor:pointer}
  .go[disabled]{background:#C9C6D2;cursor:not-allowed}
  .err{margin-top:12px;color:#C0353A;font-size:13px;font-weight:600}
  .ok{text-align:center;padding:18px 0}
  .ok .tick{width:52px;height:52px;border-radius:99px;background:#E7F8EF;color:#0E9355;display:flex;align-items:center;justify-content:center;margin:0 auto 14px;font-size:26px}
  .muted{color:#8C8899;font-size:13px}
</style>
</head>
<body>
<div class="wrap"><div class="card" id="app"><p class="muted">Loading the available times…</p></div></div>
<script>
(function () {
  var slug = ${JSON.stringify(esc(slug))};
  var app = document.getElementById('app');
  var picked = null, data = null;

  function h(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // Day headings in the ORG's zone — the slot's own day string, formatted, never re-derived from a
  // Date in the visitor's zone. Reconstructing it locally is how a Sunday slot renders as Saturday.
  function dayLabel(day) {
    var p = day.split('-');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  }

  function render() {
    if (!data.slots.length) {
      app.innerHTML = '<h1>' + h(data.title) + '</h1>'
        + '<p class="sub">with ' + h(data['with']) + '</p>'
        + '<p class="muted" style="margin-top:22px">There are no free times in the next couple of weeks. '
        + 'Please reply to the message this link came from and we will find one.</p>';
      return;
    }
    var byDay = {}, order = [];
    data.slots.forEach(function (s) { if (!byDay[s.day]) { byDay[s.day] = []; order.push(s.day); } byDay[s.day].push(s.time); });

    var html = '<h1>' + h(data.title) + '</h1><p class="sub">'
      + data.minutes + ' minutes with ' + h(data['with']) + '</p>'
      + (data.blurb ? '<p class="sub">' + h(data.blurb) + '</p>' : '')
      + '<div class="zone">All times shown in ' + h(String(data.zone).replace(/_/g, ' ')) + '.</div>'
      + '<h2>Pick a time</h2>';
    order.forEach(function (day) {
      html += '<div class="day"><div class="dayname">' + h(dayLabel(day)) + '</div><div class="slots">'
        + byDay[day].map(function (t) {
            return '<button class="slot" type="button" aria-pressed="false" data-day="' + h(day) + '" data-time="' + h(t) + '">' + h(t) + '</button>';
          }).join('') + '</div></div>';
    });
    html += '<div id="form" hidden><h2>Your details</h2>'
      + '<label for="n">Your name</label><input id="n" autocomplete="name">'
      + '<label for="c">Company</label><input id="c" autocomplete="organization">'
      + '<label for="e">Email</label><input id="e" type="email" autocomplete="email">'
      + '<label for="p">Phone</label><input id="p" autocomplete="tel">'
      + '<label for="m">What would you like to talk about?</label><textarea id="m" rows="3"></textarea>'
      + '<button class="go" id="go" type="button">Confirm</button><div class="err" id="err"></div>'
      + '<p class="muted" style="margin-top:10px">Leave an email or a phone number so we can confirm.</p></div>';
    app.innerHTML = html;

    Array.prototype.forEach.call(app.querySelectorAll('.slot'), function (b) {
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(app.querySelectorAll('.slot'), function (o) { o.setAttribute('aria-pressed', 'false'); });
        b.setAttribute('aria-pressed', 'true');
        picked = { day: b.dataset.day, time: b.dataset.time };
        document.getElementById('form').hidden = false;
        document.getElementById('n').focus();
      });
    });
    document.getElementById('go').addEventListener('click', submit);
  }

  function submit() {
    var go = document.getElementById('go'), err = document.getElementById('err');
    err.textContent = '';
    if (!picked) { err.textContent = 'Please choose a time first.'; return; }
    go.disabled = true; go.textContent = 'Confirming…';
    fetch('/api/public/book/' + encodeURIComponent(slug), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: document.getElementById('n').value, company: document.getElementById('c').value,
        email: document.getElementById('e').value, phone: document.getElementById('p').value,
        note: document.getElementById('m').value, day: picked.day, time: picked.time
      })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (out) {
        if (!out.ok || !out.j.ok) {
          err.textContent = out.j.error || 'Something went wrong. Please try again.';
          go.disabled = false; go.textContent = 'Confirm';
          // A slot taken while the page was open is the one error worth reloading for: the list
          // on screen is now wrong, and letting them pick another stale time repeats the failure.
          if (/just been taken/i.test(out.j.error || '')) setTimeout(load, 1200);
          return;
        }
        app.innerHTML = '<div class="ok"><div class="tick">&#10003;</div>'
          + '<h1>You are booked in</h1>'
          + '<p class="sub">' + h(out.j.when) + '</p>'
          + '<p class="muted" style="margin-top:14px">We will be in touch to confirm. '
          + 'If you need to change it, reply to the message this link came from.</p></div>';
      })
      .catch(function () {
        err.textContent = 'Could not reach us just now. Please try again in a moment.';
        go.disabled = false; go.textContent = 'Confirm';
      });
  }

  function load() {
    fetch('/api/public/book/' + encodeURIComponent(slug))
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (out) {
        if (!out.ok) { app.innerHTML = '<h1>Link not available</h1><p class="sub">' + h(out.j.error || 'This booking link is no longer available.') + '</p>'; return; }
        data = out.j; picked = null; render();
      })
      .catch(function () { app.innerHTML = '<h1>Could not load</h1><p class="sub">Please refresh in a moment.</p>'; });
  }
  load();
})();
</script>
</body>
</html>`;
}
