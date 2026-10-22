/*!
 * Rastreio — script de captura para landing pages / presells / VSL.
 *
 * Instalação (antes do </head> ou no fim do <body>):
 *   <script src="https://SEU-SERVIDOR/tracker.js" async
 *           data-checkout="ggcheckout,pay.,checkout"></script>
 *
 * O que faz:
 *  1. Gera um ID de visitante (rv_...) e guarda por 365 dias.
 *  2. Guarda UTMs e IDs de clique (fbclid, gclid, ttclid...) e cookies dos pixels (_fbp, _fbc, _ttp, _ga).
 *  3. Registra a visita no servidor (com IP e navegador, usados no casamento de conversões).
 *  4. Repassa UTMs + ID do visitante em todo link que aponta para o checkout,
 *     para que a GG Checkout devolva esses dados no webhook da venda.
 *
 * Atributos opcionais da tag <script>:
 *   data-checkout   domínios/trechos de URL considerados checkout (separados por vírgula)
 *   data-vid-params nomes dos parâmetros que levam o ID do visitante (padrão: "src,sck")
 *   data-endpoint   URL do servidor (padrão: mesma origem do tracker.js)
 */
(function () {
  'use strict';
  if (window.Rastreio && window.Rastreio.loaded) return;

  var script = document.currentScript || (function () {
    var s = document.getElementsByTagName('script');
    for (var i = s.length - 1; i >= 0; i--) if (/tracker\.js/.test(s[i].src)) return s[i];
    return null;
  })();

  function attr(name, def) {
    var v = script && script.getAttribute(name);
    return v === null || v === undefined || v === '' ? def : v;
  }

  var endpoint = attr('data-endpoint', script ? new URL(script.src).origin : '');
  var checkoutMatchers = attr('data-checkout', 'ggcheckout,pay.,checkout')
    .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  var vidParams = attr('data-vid-params', 'src,sck')
    .split(',').map(function (s) { return s.trim(); }).filter(Boolean);

  var STORE_KEY = 'rastreio_ctx';
  var VID_KEY = 'rastreio_vid';
  var TRACK_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id',
    'fbclid', 'gclid', 'gbraid', 'wbraid', 'ttclid'];
  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id'];

  // ---------- cookies / storage ----------
  function rootDomain() {
    var parts = location.hostname.split('.');
    if (parts.length <= 2 || /^\d+\.\d+\.\d+\.\d+$/.test(location.hostname)) return location.hostname;
    var tail2 = parts.slice(-2).join('.');
    // domínios tipo .com.br, .net.br
    if (/^(com|net|org|gov|edu|art|blog|app)\.[a-z]{2}$/.test(tail2)) return parts.slice(-3).join('.');
    return tail2;
  }
  function getCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setCookie(name, value, days) {
    var exp = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = name + '=' + encodeURIComponent(value) + '; expires=' + exp +
      '; path=/; domain=.' + rootDomain() + '; SameSite=Lax';
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sem storage */ } }

  // ---------- ID do visitante ----------
  function newVid() {
    var a = new Uint8Array(12);
    (window.crypto || window.msCrypto).getRandomValues(a);
    var hex = '';
    for (var i = 0; i < a.length; i++) hex += ('0' + a[i].toString(16)).slice(-2);
    return 'rv_' + hex;
  }
  var params = new URLSearchParams(location.search);
  // Se o visitante chegou de outra página nossa com o ID na URL, reaproveita (ex.: presell -> página de vendas em outro domínio)
  var vidFromUrl = null;
  vidParams.forEach(function (p) {
    var v = params.get(p);
    if (!vidFromUrl && v && /^rv_[a-f0-9]{24}$/.test(v)) vidFromUrl = v;
  });
  var vid = vidFromUrl || getCookie(VID_KEY) || lsGet(VID_KEY) || newVid();
  setCookie(VID_KEY, vid, 365);
  lsSet(VID_KEY, vid);

  // ---------- parâmetros de campanha (último clique com UTM vence) ----------
  var saved = {};
  try { saved = JSON.parse(lsGet(STORE_KEY) || getCookie(STORE_KEY) || '{}') || {}; } catch (e) { saved = {}; }

  var incoming = {};
  TRACK_KEYS.forEach(function (k) { var v = params.get(k); if (v) incoming[k] = v; });
  var hasNewCampaign = Object.keys(incoming).length > 0;
  var ctx = hasNewCampaign ? incoming : saved;
  if (hasNewCampaign) ctx.ts = Date.now();

  // fbc: se veio fbclid e o pixel ainda não criou o _fbc, monta no formato da Meta
  var fbc = getCookie('_fbc');
  if (!fbc && ctx.fbclid) {
    fbc = 'fb.1.' + (ctx.ts || Date.now()) + '.' + ctx.fbclid;
    setCookie('_fbc', fbc, 90);
  }
  var json = JSON.stringify(ctx);
  lsSet(STORE_KEY, json);
  setCookie(STORE_KEY, json, 90);

  function gaClientId() {
    var ga = getCookie('_ga'); // GA1.1.123456789.1700000000
    if (!ga) return null;
    var p = ga.split('.');
    return p.length >= 4 ? p.slice(-2).join('.') : null;
  }

  // ---------- registra a visita ----------
  function sendVisit() {
    var body = {
      visitor_id: vid,
      page_url: location.href,
      referrer: document.referrer || null,
      fbp: getCookie('_fbp'),
      fbc: getCookie('_fbc') || fbc,
      ttp: getCookie('_ttp'),
      ga_client_id: gaClientId()
    };
    TRACK_KEYS.forEach(function (k) { body[k] = ctx[k] || null; });
    var data = JSON.stringify(body);
    var url = endpoint + '/t/visit';
    if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([data], { type: 'text/plain' }))) return;
    try {
      fetch(url, { method: 'POST', body: data, keepalive: true, headers: { 'Content-Type': 'text/plain' } });
    } catch (e) { /* ignora */ }
  }
  // espera um pouco para os pixels criarem _fbp/_ttp/_ga
  setTimeout(sendVisit, 1500);

  // ---------- repassa os dados para o checkout ----------
  function isCheckout(href) {
    if (!href) return false;
    var h = href.toLowerCase();
    if (h.indexOf('http') !== 0) return false;
    for (var i = 0; i < checkoutMatchers.length; i++) if (h.indexOf(checkoutMatchers[i]) !== -1) return true;
    return false;
  }
  function decorate(href) {
    try {
      var u = new URL(href, location.href);
      UTM_KEYS.forEach(function (k) { if (ctx[k] && !u.searchParams.get(k)) u.searchParams.set(k, ctx[k]); });
      ['fbclid', 'gclid', 'ttclid'].forEach(function (k) { if (ctx[k] && !u.searchParams.get(k)) u.searchParams.set(k, ctx[k]); });
      vidParams.forEach(function (p) { u.searchParams.set(p, vid); });
      return u.toString();
    } catch (e) { return href; }
  }
  function decorateAll(root) {
    var links = (root || document).querySelectorAll ? (root || document).querySelectorAll('a[href]') : [];
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (isCheckout(a.href)) a.href = decorate(a.href);
    }
  }
  // decora no clique também (cobre links criados depois e botões que mudam o href)
  document.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el.tagName !== 'A') el = el.parentElement;
    if (el && el.href && isCheckout(el.href)) el.href = decorate(el.href);
  }, true);
  // window.open usado por alguns botões
  var origOpen = window.open;
  window.open = function (url) {
    var args = Array.prototype.slice.call(arguments);
    if (typeof url === 'string' && isCheckout(new URL(url, location.href).href)) args[0] = decorate(url);
    return origOpen.apply(window, args);
  };

  function init() {
    decorateAll(document);
    if (window.MutationObserver) {
      new MutationObserver(function (muts) {
        muts.forEach(function (m) {
          m.addedNodes && m.addedNodes.forEach(function (n) {
            if (n.nodeType === 1) {
              if (n.tagName === 'A' && isCheckout(n.href)) n.href = decorate(n.href);
              else decorateAll(n);
            }
          });
        });
      }).observe(document.documentElement, { childList: true, subtree: true });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.Rastreio = {
    loaded: true,
    visitorId: vid,
    params: ctx,
    decorate: decorate // use em botões customizados: location.href = Rastreio.decorate(urlDoCheckout)
  };
})();
