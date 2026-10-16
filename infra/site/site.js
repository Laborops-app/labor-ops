// The "Try the live demo" window: shows every demo sign-in, then opens demoapp.laborops.app (which spins the demo up).
(function () {
  var DEMO = 'https://demoapp.laborops.app/';
  var PASSWORD = 'LaborOps-Demo-1';
  var ACCOUNTS = [
    ['Admin', 'admin@demo.laborops.app', 'Everything: billing, payroll, settings'],
    ['HR', 'hr@demo.laborops.app', 'Invoicing, payroll and reports'],
    ['Labor Coordinator', 'manager@demo.laborops.app', 'Events, scheduling and timesheets'],
    ['Crew member', 'crew1@demo.laborops.app', 'Shifts, clock in/out and earnings (best on a phone)'],
  ];
  var dlg = document.createElement('dialog');
  dlg.setAttribute('aria-labelledby', 'demo-title');
  dlg.innerHTML =
    '<div class="modal">' +
    '<button class="x" aria-label="Close" data-close>×</button>' +
    '<h2 id="demo-title">Try the live demo</h2>' +
    '<p>A full sample company with 45 crew, a season of events, timesheets, payroll and invoices. Sign in as any of these:</p>' +
    '<table class="logins"><tbody>' +
    ACCOUNTS.map(function (a) {
      return '<tr><td>' + a[0] + '<div style="font-weight:400;color:var(--muted);font-size:.8rem">' + a[2] + '</div></td><td><code>' + a[1] + '</code> <button class="copy" data-copy="' + a[1] + '">Copy</button></td></tr>';
    }).join('') +
    '<tr><td>Password (all)</td><td><code>' + PASSWORD + '</code> <button class="copy" data-copy="' + PASSWORD + '">Copy</button></td></tr>' +
    '</tbody></table>' +
    '<p style="font-size:.86rem">The demo starts in about half a minute, is shared with other visitors and is wiped every 2 hours. No emails or texts are sent.</p>' +
    '<div class="modal-acts"><button class="btn" data-close>Not now</button><a class="btn accent" href="' + DEMO + '" target="_blank" rel="noopener" data-launch>Launch the demo →</a></div>' +
    '</div>';
  document.body.appendChild(dlg);
  var open = function (e) {
    if (e) e.preventDefault();
    if (dlg.showModal) dlg.showModal(); else window.open(DEMO, '_blank');
  };
  document.querySelectorAll('[data-demo]').forEach(function (b) { b.addEventListener('click', open); });
  dlg.addEventListener('click', function (e) {
    var t = e.target;
    if (t === dlg || (t.hasAttribute && t.hasAttribute('data-close'))) dlg.close();
    if (t.hasAttribute && t.hasAttribute('data-launch')) setTimeout(function () { dlg.close(); }, 200);
    if (t.hasAttribute && t.hasAttribute('data-copy')) {
      var v = t.getAttribute('data-copy');
      (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(function () {
        t.textContent = 'Copied'; setTimeout(function () { t.textContent = 'Copy'; }, 1400);
      }).catch(function () {});
    }
  });
  if (location.hash === '#demo') open();
  var y = document.getElementById('year');
  if (y) y.textContent = new Date().getFullYear();
})();
