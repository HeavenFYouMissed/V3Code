/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * The self-contained Visual Edit panel that runs INSIDE the page. Injected via the browser's
 * isolated-world exec path (model.executeScript — shared DOM, separate JS context). Renders a
 * frosted, draggable control panel that floats over the page like the design mockup
 * (docs/mockups/visual-edit.html).
 *
 * FLOW (staging model): arm -> click any element -> restyle it by hand (color/size/weight/padding/
 * radius/text), seeing it change LIVE. Every tweak is STAGED into a running list (across multiple
 * elements). When you're done, ONE "Send to agent" button hands the WHOLE batch to the chat as a
 * readable text instruction (not an invisible attachment) so the agent reliably reads every change
 * and writes them into the real source. An optional note rides along for anything freeform.
 *
 * ROBUSTNESS: lives in a SHADOW ROOT + constructable stylesheet (isolated from page CSS and the
 * page's style-src CSP). Output is a QUEUE (never drops a Send). All listeners removed in teardown.
 * Selectors are positional (:nth-of-type) so the agent edits the RIGHT element.
 *
 * Kept as a plain-JS string (String.raw, no ${} interpolation); the editor never imports it as code.
 */

/** Drains the panel's outgoing message QUEUE (array of JSON strings). Polled by the editor. */
export const VISUAL_EDIT_DRAIN_SCRIPT = `(function(){var q=window.__v3veOut||[];window.__v3veOut=[];return q.length?JSON.stringify(q):null;})()`;

export const VISUAL_EDIT_INJECT_SCRIPT = String.raw`(function () {
  if (window.__v3ve) { window.__v3ve.show(); return 'v3ve-armed'; }
  if (!document.body) { return 'v3ve-no-body'; }

  window.__v3veOut = window.__v3veOut || [];
  var send = function (obj) { try { window.__v3veOut.push(JSON.stringify(obj)); } catch (e) {} };

  var TT = null;
  try { if (window.trustedTypes && window.trustedTypes.createPolicy) { TT = window.trustedTypes.createPolicy('v3ve', { createHTML: function (s) { return s; } }); } } catch (e) { TT = null; }
  function setHTML(node, html) { try { node.innerHTML = TT ? TT.createHTML(html) : html; } catch (e) { node.textContent = ''; } }
  var cssEsc = (window.CSS && window.CSS.escape) ? window.CSS.escape : function (s) { return String(s); };

  var CSS_TEXT = [
    ':host{all:initial;}',
    '#v3ve-panel{position:fixed;top:80px;right:24px;width:316px;max-height:calc(100vh - 110px);z-index:20;',
      'display:flex;flex-direction:column;background:rgba(18,18,20,.94);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);',
      'border:1px solid rgba(255,255,255,.14);border-radius:13px;box-shadow:0 24px 70px rgba(0,0,0,.6),0 0 0 1px rgba(0,0,0,.45);',
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#ededed;overflow:hidden;box-sizing:border-box;}",
    '#v3ve-panel *{box-sizing:border-box;}',
    '#v3ve-head{display:flex;align-items:center;gap:8px;padding:13px 14px 11px;border-bottom:1px solid rgba(255,255,255,.08);cursor:grab;}',
    '#v3ve-head.drag{cursor:grabbing;}',
    '#v3ve-title{flex:1;min-width:0;}',
    '#v3ve-title b{font-size:14px;font-weight:600;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '#v3ve-title small{display:block;max-width:206px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:#8a8a90;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '#v3ve-badge{font-family:ui-monospace,monospace;font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:#cfcfd4;border:1px solid rgba(255,255,255,.16);padding:3px 8px;border-radius:5px;white-space:nowrap;flex:none;}',
    '#v3ve-close{flex:none;width:24px;height:24px;border:0;background:none;color:#8a8a90;font-size:17px;line-height:1;cursor:pointer;border-radius:6px;}',
    '#v3ve-close:hover{background:rgba(255,255,255,.08);color:#ededed;}',
    '#v3ve-body{overflow-y:auto;padding:4px 14px 8px;}',
    '#v3ve-body::-webkit-scrollbar{width:7px;}#v3ve-body::-webkit-scrollbar-thumb{background:#2a2a2e;border-radius:4px;}',
    '#v3ve-foot{border-top:1px solid rgba(255,255,255,.08);padding:12px 14px 14px;background:rgba(12,12,14,.5);}',
    '.v3ve-grp{font-family:ui-monospace,monospace;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:#8a8a90;padding:14px 0 4px;}',
    '.v3ve-field{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.06);}',
    '.v3ve-field>label{font-size:12.5px;color:#bdbdc2;flex:none;}',
    '.v3ve-ctrl{display:flex;align-items:center;gap:7px;flex-wrap:nowrap;justify-content:flex-end;}',
    '.v3ve-val{font-family:ui-monospace,monospace;font-size:11px;color:#ededed;min-width:26px;text-align:right;}',
    'textarea.v3ve-text,#v3ve-note{width:100%;resize:none;background:#0c0c0e;border:1px solid rgba(255,255,255,.14);border-radius:8px;color:#ededed;font-family:inherit;font-size:12.5px;line-height:1.4;padding:9px 10px;}',
    'textarea.v3ve-text{margin:8px 0 2px;}#v3ve-note{margin-top:8px;}',
    'textarea.v3ve-text:focus,#v3ve-note:focus{outline:none;border-color:#7c7cff;box-shadow:0 0 0 3px rgba(124,124,255,.25);}',
    '.v3ve-sw{display:flex;gap:5px;flex-wrap:nowrap;}.v3ve-sw i{width:22px;height:22px;border-radius:6px;border:1px solid rgba(255,255,255,.18);cursor:pointer;display:block;box-shadow:inset 0 0 0 1px rgba(0,0,0,.25);}',
    '.v3ve-sw i.on{box-shadow:0 0 0 2px #ededed;}',
    'input[type=color].v3ve-cc{-webkit-appearance:none;appearance:none;width:22px;height:22px;border:1px solid rgba(255,255,255,.22);border-radius:6px;padding:0;background:none;cursor:pointer;flex:none;box-shadow:inset 0 0 0 1px rgba(255,255,255,.12);}',
    'input[type=color].v3ve-cc::-webkit-color-swatch-wrapper{padding:0;}input[type=color].v3ve-cc::-webkit-color-swatch{border:none;border-radius:5px;}',
    "input[type=range].v3ve-r{-webkit-appearance:none;appearance:none;width:114px;height:3px;border-radius:2px;background:#2f2f34;}",
    'input[type=range].v3ve-r::-webkit-slider-thumb{-webkit-appearance:none;width:13px;height:13px;border-radius:50%;background:#ededed;border:2px solid #0a0a0b;cursor:pointer;}',
    '.v3ve-seg{display:flex;background:#0c0c0e;border:1px solid rgba(255,255,255,.14);border-radius:7px;overflow:hidden;}',
    '.v3ve-seg button{background:none;border:0;color:#8a8a90;font-family:ui-monospace,monospace;font-size:10.5px;padding:5px 8px;cursor:pointer;}',
    '.v3ve-seg button.on{background:#2a2a2e;color:#fff;}',
    '.v3ve-pbtn{width:100%;height:36px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid #7c7cff;background:#7c7cff;color:#0a0a0b;}',
    '.v3ve-pbtn:disabled{opacity:.4;cursor:default;}',
    '.v3ve-staged-h{display:flex;align-items:center;justify-content:space-between;}',
    '.v3ve-staged-h b{font-family:ui-monospace,monospace;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:#8a8a90;font-weight:600;}',
    '.v3ve-clear{background:none;border:0;color:#8a8a90;font-size:11px;cursor:pointer;padding:0;}.v3ve-clear:hover{color:#ededed;}',
    '.v3ve-list{display:flex;flex-direction:column;gap:6px;margin:8px 0 2px;max-height:120px;overflow-y:auto;}',
    '.v3ve-row{display:flex;align-items:center;gap:8px;font-size:12px;color:#cfcfd4;}',
    '.v3ve-row .dot{width:7px;height:7px;border-radius:50%;background:#7c7cff;flex:none;box-shadow:0 0 7px #7c7cff;}',
    '.v3ve-row code{font-family:ui-monospace,monospace;font-size:11px;color:#ededed;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.v3ve-row .n{margin-left:auto;color:#8a8a90;font-family:ui-monospace,monospace;font-size:10px;flex:none;}',
    '.v3ve-row .x{cursor:pointer;color:#6e6e73;flex:none;}.v3ve-row .x:hover{color:#ededed;}',
    '.v3ve-empty{padding:24px 14px;text-align:center;font-size:12.5px;color:#8a8a90;line-height:1.5;}',
    '.v3ve-hl{position:fixed;z-index:10;pointer-events:none;border-radius:5px;box-shadow:0 0 0 1px rgba(0,0,0,.55),0 0 0 3px rgba(124,124,255,.5);transition:left .08s ease-out,top .08s ease-out,width .08s ease-out,height .08s ease-out;}',
    '.v3ve-hl-name{position:absolute;top:-19px;left:-1px;background:#7c7cff;color:#0a0a0b;font-family:ui-monospace,monospace;font-size:10px;padding:1px 6px;border-radius:4px 4px 4px 0;white-space:nowrap;}'
  ].join('');

  var host = document.createElement('div');
  host.id = 'v3ve-host';
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
  document.body.appendChild(host);
  var root = host.attachShadow({ mode: 'open' });
  try { var sheet = new CSSStyleSheet(); sheet.replaceSync(CSS_TEXT); root.adoptedStyleSheets = [sheet]; }
  catch (e) { var st = document.createElement('style'); st.textContent = CSS_TEXT; root.appendChild(st); }

  var hl = document.createElement('div'); hl.className = 'v3ve-hl'; hl.style.display = 'none';
  var hlName = document.createElement('div'); hlName.className = 'v3ve-hl-name'; hl.appendChild(hlName);
  root.appendChild(hl);

  var panel = document.createElement('div'); panel.id = 'v3ve-panel';
  setHTML(panel, '<div id="v3ve-head"><div id="v3ve-title"><b>Visual Edit</b><small>click any element</small></div><span id="v3ve-badge">Armed</span><button id="v3ve-close" title="Close">&times;</button></div><div id="v3ve-body"></div><div id="v3ve-foot"></div>');
  root.appendChild(panel);
  var head = panel.querySelector('#v3ve-head');
  var title = panel.querySelector('#v3ve-title b');
  var sub = panel.querySelector('#v3ve-title small');
  var badge = panel.querySelector('#v3ve-badge');
  var body = panel.querySelector('#v3ve-body');
  var foot = panel.querySelector('#v3ve-foot');
  panel.querySelector('#v3ve-close').addEventListener('click', function () { teardown(); });

  var sel = null;
  var staged = {};      // selectorKey -> { el, name, selector, css:{prop:val}, text, orig:{prop:val}, origText }
  var noteText = '';

  function isSvg(el) { return el && el.namespaceURI === 'http://www.w3.org/2000/svg'; }
  function nameOf(el) { return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList && el.classList.length ? '.' + el.classList[0] : ''); }
  function pathOf(el) {
    var parts = [], n = el, depth = 0;
    while (n && n.nodeType === 1 && n !== document.documentElement && depth < 6) {
      var tag = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(tag + '#' + cssEsc(n.id)); break; }
      var seg = tag;
      if (n.classList && n.classList.length) { seg += '.' + Array.prototype.map.call(n.classList, cssEsc).join('.'); }
      var p = n.parentElement;
      if (p) {
        var same = Array.prototype.filter.call(p.children, function (c) { return c.tagName === n.tagName; });
        if (same.length > 1) { seg += ':nth-of-type(' + (Array.prototype.indexOf.call(same, n) + 1) + ')'; }
      }
      parts.unshift(seg); n = p; depth++;
    }
    return parts.join(' > ');
  }
  function moveHl(el) {
    if (!el) { hl.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    hl.style.display = 'block';
    hl.style.left = r.left + 'px'; hl.style.top = r.top + 'px';
    hl.style.width = r.width + 'px'; hl.style.height = r.height + 'px';
    hlName.textContent = nameOf(el);
  }
  var rafPending = false;
  function scheduleHl() { if (rafPending) { return; } rafPending = true; requestAnimationFrame(function () { rafPending = false; if (sel) { moveHl(sel); } }); }

  function hex2(n) { n = (+n).toString(16); return n.length < 2 ? '0' + n : n; }
  function rgbToHex(strv) {
    if (!strv) { return null; }
    var m = strv.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/);
    if (!m) { return null; }
    if (m[4] !== undefined && parseFloat(m[4]) === 0) { return null; }
    return '#' + hex2(m[1]) + hex2(m[2]) + hex2(m[3]);
  }
  var _cols = null;
  function pageColors() {
    if (_cols) { return _cols; }
    var cm = {}, bm = {}, ca = [], ba = [], all = document.body.getElementsByTagName('*');
    var lim = Math.min(all.length, 500);
    for (var i = 0; i < lim && (ca.length < 5 || ba.length < 5); i++) {
      var s = getComputedStyle(all[i]);
      var c = rgbToHex(s.color); if (c && !cm[c] && ca.length < 5) { cm[c] = 1; ca.push(c); }
      var b = rgbToHex(s.backgroundColor); if (b && !bm[b] && ba.length < 5) { bm[b] = 1; ba.push(b); }
    }
    _cols = { color: ca, background: ba };
    return _cols;
  }

  // -- staging: every hand edit goes into the staged map AND live onto the element --
  function entryFor(el) {
    var key = pathOf(el);
    var s = staged[key];
    if (!s) { s = staged[key] = { el: el, name: nameOf(el), selector: key, css: {}, text: undefined, orig: {}, origText: undefined }; }
    return s;
  }
  function stageCss(el, prop, val) {
    var s = entryFor(el);
    if (!(prop in s.orig)) { s.orig[prop] = el.style.getPropertyValue(prop); }
    el.style.setProperty(prop, val);
    s.css[prop] = val;
    renderStaged();
  }
  function stageText(el, val) {
    var s = entryFor(el);
    if (s.origText === undefined) { s.origText = el.textContent; }
    el.textContent = val;
    s.text = val;
    renderStaged();
  }
  function revertEntry(key) {
    var s = staged[key]; if (!s) { return; }
    for (var p in s.orig) { if (s.orig.hasOwnProperty(p)) { if (s.orig[p]) { s.el.style.setProperty(p, s.orig[p]); } else { s.el.style.removeProperty(p); } } }
    if (s.origText !== undefined) { s.el.textContent = s.origText; }
    delete staged[key];
    if (sel === s.el) { build(sel); } else { renderStaged(); moveHl(sel); }
  }
  function clearStaged() { Object.keys(staged).forEach(function (k) { revertEntry(k); }); }
  function stagedCount() { var n = 0; for (var k in staged) { if (staged.hasOwnProperty(k)) { n++; } } return n; }

  // -- control builders --
  function field(label, ctrl) { return '<div class="v3ve-field"><label>' + label + '</label><div class="v3ve-ctrl">' + ctrl + '</div></div>'; }
  function colorControl(kind, current, cols, withTransparent) {
    var well = '<input type="color" class="v3ve-cc" data-cc="' + kind + '" value="' + (current || '#000000') + '">';
    var sws = '<div class="v3ve-sw" data-sw="' + kind + '">';
    if (withTransparent) { sws += '<i data-v="transparent" title="transparent" style="background:repeating-linear-gradient(45deg,#1a1a1c,#1a1a1c 3px,#0c0c0e 3px,#0c0c0e 6px)"></i>'; }
    sws += cols.slice(0, withTransparent ? 2 : 3).map(function (c) { return '<i data-v="' + c + '" style="background:' + c + '"></i>'; }).join('') + '</div>';
    return well + sws;
  }
  function seg(kind, opts, active) {
    return '<div class="v3ve-seg" data-seg="' + kind + '">' + opts.map(function (o) {
      return '<button class="' + (active === o[0] ? 'on' : '') + '" data-k="' + o[0] + '">' + o[1] + '</button>';
    }).join('') + '</div>';
  }
  function px(v) { return Math.round(parseFloat(v)) || 0; }
  function normWeight(w) { if (w === 'normal') { return '400'; } if (w === 'bold') { return '700'; } return String(px(w) || w); }

  function build(el) {
    var cs = getComputedStyle(el);
    var svg = isSvg(el);
    title.textContent = nameOf(el);
    sub.textContent = pathOf(el);
    var cols = pageColors();
    var hasText = el.children.length === 0 && (el.textContent || '').trim().length > 0;
    var h = '';
    if (hasText) { h += '<textarea class="v3ve-text" id="v3ve-t" rows="2"></textarea>'; }
    h += '<div class="v3ve-grp">Style</div>';
    h += field(svg ? 'Fill' : 'Text', colorControl('color', rgbToHex(svg ? cs.fill : cs.color) || '#888888', cols.color, false));
    if (!svg) { h += field('Background', colorControl('background', rgbToHex(cs.backgroundColor) || '#1c1c1f', cols.background, true)); }
    h += field('Size', '<input type="range" class="v3ve-r" id="v3ve-size" min="8" max="120" value="' + px(cs.fontSize) + '"><span class="v3ve-val" id="v3ve-size-v">' + px(cs.fontSize) + '</span>');
    h += field('Weight', seg('weight', [['400', '400'], ['500', '500'], ['600', '600'], ['700', '700'], ['800', '800']], normWeight(cs.fontWeight)));
    if (!svg) {
      h += field('Padding', '<input type="range" class="v3ve-r" id="v3ve-pad" min="0" max="64" value="' + px(cs.paddingLeft) + '"><span class="v3ve-val" id="v3ve-pad-v">' + px(cs.paddingLeft) + '</span>');
      h += field('Radius', '<input type="range" class="v3ve-r" id="v3ve-rad" min="0" max="60" value="' + px(cs.borderTopLeftRadius) + '"><span class="v3ve-val" id="v3ve-rad-v">' + px(cs.borderTopLeftRadius) + '</span>');
    }
    setHTML(body, h);
    var t = body.querySelector('#v3ve-t');
    if (t) { t.value = (el.textContent || '').trim(); }
    wire(el);
    renderStaged();
  }

  // Footer (staged list + note + Send) is built ONCE; renderStaged only refreshes the dynamic
  // bits, so dragging a slider never recreates / blurs the note textarea.
  function initFoot() {
    setHTML(foot,
      '<div class="v3ve-staged-h"><b id="v3ve-staged-label">Staged edits</b><button class="v3ve-clear" id="v3ve-clear" style="display:none">Clear all</button></div>' +
      '<div class="v3ve-list" id="v3ve-list"></div>' +
      '<textarea id="v3ve-note" rows="2" placeholder="Optional note for the agent (e.g. make the hero pop)"></textarea>' +
      '<button class="v3ve-pbtn" id="v3ve-send" disabled>Send to agent</button>');
    var note = foot.querySelector('#v3ve-note');
    note.value = noteText;
    note.addEventListener('input', function () { noteText = note.value; updateSend(); });
    foot.querySelector('#v3ve-clear').addEventListener('click', function () { clearStaged(); });
    foot.querySelector('#v3ve-send').addEventListener('click', doSend);
    renderStaged();
  }
  function updateSend() {
    var b = foot.querySelector('#v3ve-send'); if (!b) { return; }
    var n = stagedCount();
    b.disabled = !(n > 0 || noteText.trim().length > 0);
    b.textContent = n ? ('Send ' + n + ' edit' + (n === 1 ? '' : 's') + ' to agent') : 'Send to agent';
  }
  function renderStaged() {
    var listEl = foot.querySelector('#v3ve-list'); if (!listEl) { return; }
    var n = stagedCount(), rows = '';
    for (var k in staged) {
      if (!staged.hasOwnProperty(k)) { continue; }
      var s = staged[k], c = 0; for (var p in s.css) { if (s.css.hasOwnProperty(p)) { c++; } } if (s.text !== undefined) { c++; }
      rows += '<div class="v3ve-row" data-key="' + encodeURIComponent(k) + '"><span class="dot"></span><code>' + s.name + '</code><span class="n">' + c + '</span><span class="x" title="Remove">&times;</span></div>';
    }
    setHTML(listEl, n ? rows : '<div style="font-size:12px;color:#8a8a90;">Tweak any element above. Changes collect here, then send them all at once.</div>');
    Array.prototype.forEach.call(listEl.querySelectorAll('.v3ve-row .x'), function (x) {
      x.addEventListener('click', function (e) { revertEntry(decodeURIComponent(e.target.closest('.v3ve-row').getAttribute('data-key'))); });
    });
    foot.querySelector('#v3ve-staged-label').textContent = n ? ('Staged edits · ' + n) : 'Staged edits';
    foot.querySelector('#v3ve-clear').style.display = n ? '' : 'none';
    updateSend();
  }

  function doSend() {
    var edits = [];
    for (var k in staged) {
      if (!staged.hasOwnProperty(k)) { continue; }
      var s = staged[k];
      edits.push({ elementName: s.name, selector: s.selector, outerHTML: (s.el.outerHTML || '').slice(0, 900), changes: s.css, text: s.text, hasBgImage: (getComputedStyle(s.el).backgroundImage || 'none') !== 'none' });
    }
    if (!edits.length && !noteText.trim()) { return; }
    send({ type: 'send', edits: edits, note: noteText.trim() });
    staged = {}; noteText = '';
    if (sel) { build(sel); } else { renderEmpty(); }
    flash('Sent to agent');
  }

  function wire(el) {
    var t = body.querySelector('#v3ve-t');
    if (t) { t.addEventListener('input', function () { stageText(el, t.value); moveHl(el); }); }
    Array.prototype.forEach.call(body.querySelectorAll('input.v3ve-cc'), function (cc) {
      cc.addEventListener('input', function () { applyColor(el, cc.getAttribute('data-cc'), cc.value); });
    });
    Array.prototype.forEach.call(body.querySelectorAll('[data-sw]'), function (box) {
      box.addEventListener('click', function (e) {
        var sw = e.target.closest('i'); if (!sw) { return; }
        Array.prototype.forEach.call(box.querySelectorAll('i'), function (x) { x.classList.remove('on'); });
        sw.classList.add('on');
        applyColor(el, box.getAttribute('data-sw'), sw.getAttribute('data-v'));
      });
    });
    bindRange('v3ve-size', 'v3ve-size-v', function (v) { stageCss(el, 'font-size', v + 'px'); moveHl(el); });
    bindRange('v3ve-pad', 'v3ve-pad-v', function (v) { stageCss(el, 'padding', v + 'px'); moveHl(el); });
    bindRange('v3ve-rad', 'v3ve-rad-v', function (v) { stageCss(el, 'border-radius', v + 'px'); });
    var wseg = body.querySelector('[data-seg="weight"]');
    if (wseg) {
      wseg.addEventListener('click', function (e) {
        var b = e.target.closest('button'); if (!b) { return; }
        Array.prototype.forEach.call(wseg.querySelectorAll('button'), function (x) { x.classList.remove('on'); });
        b.classList.add('on'); stageCss(el, 'font-weight', b.getAttribute('data-k'));
      });
    }
  }
  function applyColor(el, kind, v) {
    if (kind === 'background') { if (!isSvg(el)) { stageCss(el, 'background-color', v); } }
    else { stageCss(el, isSvg(el) ? 'fill' : 'color', v); }
  }

  var flashT;
  function flash(msg) { badge.textContent = msg; clearTimeout(flashT); flashT = setTimeout(function () { badge.textContent = 'Armed'; }, 2200); }
  function bindRange(rid, vid, fn) {
    var r = body.querySelector('#' + rid); if (!r) { return; }
    var v = body.querySelector('#' + vid);
    r.addEventListener('input', function () { v.textContent = r.value; fn(+r.value); });
  }

  function select(el) { sel = el; moveHl(el); build(el); }
  function renderEmpty() {
    title.textContent = 'Visual Edit'; sub.textContent = 'click any element';
    setHTML(body, '<div class="v3ve-empty">Click any element on the page to start editing it. Your changes collect below — send them all to the agent at once.</div>');
    renderStaged();
  }
  initFoot();
  renderEmpty();

  // drag (handlers hoisted so teardown can remove them)
  var dx = 0, dy = 0, dragging = false;
  function onDragDown(e) { dragging = true; head.classList.add('drag'); var r = panel.getBoundingClientRect(); dx = e.clientX - r.left; dy = e.clientY - r.top; panel.style.right = 'auto'; }
  function onDragMove(e) { if (!dragging) { return; } panel.style.left = Math.max(8, e.clientX - dx) + 'px'; panel.style.top = Math.max(8, e.clientY - dy) + 'px'; }
  function onDragUp() { dragging = false; head.classList.remove('drag'); }
  head.addEventListener('pointerdown', onDragDown);
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragUp);

  function onMove(e) { if (host.contains(e.target) || e.target === sel) { return; } moveHl(e.target); }
  function onClick(e) { if (host.contains(e.target)) { return; } e.preventDefault(); e.stopPropagation(); select(e.target); }
  function onScroll() { scheduleHl(); }
  function onResize() { scheduleHl(); }
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize, true);

  function teardown() {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize, true);
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragUp);
    if (host.parentNode) { host.parentNode.removeChild(host); }
    window.__v3ve = null; window.__v3veTeardown = null;
  }
  window.__v3veTeardown = teardown;
  window.__v3ve = { show: function () { host.style.display = ''; if (!document.contains(host)) { document.body.appendChild(host); } } };
  return 'v3ve-armed';
})();`;

export const VISUAL_EDIT_TEARDOWN_SCRIPT = `(function(){ if (window.__v3veTeardown) { window.__v3veTeardown(); } })();`;
