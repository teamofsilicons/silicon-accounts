/**
 * The ux-audit suite's in-page kit: plain JavaScript installed in every document of an audited browser context
 * (context.addInitScript, which no page CSP can refuse) as `window.__uxa`. It is a string on purpose: tsx compiles
 * TypeScript functions with `__name(...)` helpers that do not exist in the page, so code passed to page.evaluate as a
 * function could not declare inner functions. Node calls it with `page.evaluate("window.__uxa.<fn>(<json>)")`.
 *
 *   describe(el)          a short description of an element for reports (tag#id.class[role][aria-label] "text")
 *   calm()                true when no finite animation is running (the page has settled)
 *   overflow()            can the page scroll sideways, and which elements stick out of the viewport
 *   squircles()           every painted rounded surface, and whether it is a squircle ([data-sq], [data-sq-native])
 *   truncation()          text cut off (ellipsis, clipped, line clamp) or spilling out of its box
 *   textOverlaps()        visible text boxes that overlap each other (outside fixed layers)
 *   brokenImages()        images that failed to load
 *   words()               every visible word the page shows (text, labels, titles, placeholders, alt, title)
 *   hiddenContent()       headings, buttons and fields left invisible (opacity) after the page settled
 *   poweredBy()           where "Powered by Silicon Accounts" is, whether it is in view, covered, or overlapping
 *   dockClearance()       at the bottom of the page: does any content sit under the floating dock
 *   snapshotLooks()       remembers how every focusable element looks unfocused
 *   activeFocus()         the focused element: where it is, whether it is covered, and what changed in its look
 *   motionStart(opts) / motionStop()   samples every frame (animations and geometry) and summarises the motion
 *   axe(opts)             axe-core over the document (axe is installed next to the kit), violations summarised
 */
export const KIT_SOURCE = String.raw`
(function () {
  if (window.__uxa) return;
  var MOTION = /^(transform|translate|scale|rotate|left|top|right|bottom|inset|width|height|marginTop|marginLeft|marginRight|marginBottom|margin|clipPath|offsetDistance|backgroundPosition|x|y)$/;

  function short(text, n) { return String(text || "").replace(/\s+/g, " ").trim().slice(0, n || 60); }
  function describe(el) {
    if (!el || !el.tagName) return String(el);
    var tag = el.tagName.toLowerCase();
    var id = el.id ? "#" + el.id : "";
    var cls = "";
    var raw = typeof el.className === "string" ? el.className : (el.getAttribute && el.getAttribute("class")) || "";
    if (raw && raw.trim()) cls = "." + raw.trim().split(/\s+/).slice(0, 2).join(".");
    var role = el.getAttribute && el.getAttribute("role") ? "[role=" + el.getAttribute("role") + "]" : "";
    var label = el.getAttribute && el.getAttribute("aria-label") ? '[aria-label="' + short(el.getAttribute("aria-label"), 50) + '"]' : "";
    var sq = el.getAttribute && el.getAttribute("data-sq") !== null ? "[data-sq=" + el.getAttribute("data-sq") + "]" : "";
    var text = short(el.textContent, 40);
    return tag + id + cls + role + label + sq + (text ? ' "' + text + '"' : "");
  }
  function visible(el) {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === "function" && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function transparent(c) {
    if (!c || c === "transparent") return true;
    var m = /rgba?\(([^)]*)\)/.exec(c);
    if (m) { var parts = m[1].split(/[\s,\/]+/).filter(Boolean); if (parts.length === 4 && parseFloat(parts[3]) === 0) return true; }
    return false;
  }
  function inFixed(el) {
    for (var p = el; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      var pos = getComputedStyle(p).position;
      if (pos === "fixed" || pos === "sticky") return p;
    }
    return null;
  }
  /** The element or an ancestor is position: fixed (placed against the viewport, not the page). */
  function fixedLayer(el) {
    for (var p = el; p && p !== document.body && p !== document.documentElement; p = p.parentElement) if (getComputedStyle(p).position === "fixed") return true;
    return false;
  }
  function rect(r) { return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; }
  /** The part of an element its scrolling or clipping ancestors let show (null when nothing shows). */
  function shownRect(el) {
    var r = el.getBoundingClientRect();
    var left = r.left, top = r.top, right = r.right, bottom = r.bottom;
    for (var p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      var s = getComputedStyle(p);
      if (s.overflowX !== "visible" || s.overflowY !== "visible") {
        var pr = p.getBoundingClientRect();
        if (s.overflowX !== "visible") { left = Math.max(left, pr.left); right = Math.min(right, pr.right); }
        if (s.overflowY !== "visible") { top = Math.max(top, pr.top); bottom = Math.min(bottom, pr.bottom); }
      }
      if (s.position === "fixed") break;
    }
    if (right - left < 1 || bottom - top < 1) return null;
    return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
  }
  function directText(el) {
    for (var i = 0; i < el.childNodes.length; i++) { var n = el.childNodes[i]; if (n.nodeType === 3 && n.textContent.trim()) return true; }
    return false;
  }

  function calm() {
    var list = document.getAnimations ? document.getAnimations() : [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (a.playState !== "running") continue;
      var t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
      if (t && t.iterations === Infinity) continue;
      return false;
    }
    return true;
  }

  function overflow() {
    var root = document.scrollingElement || document.documentElement;
    var vw = document.documentElement.clientWidth;
    var x0 = window.scrollX, y0 = window.scrollY;
    window.scrollTo({ left: 100000, top: y0, behavior: "instant" });
    var scrolledX = window.scrollX;
    window.scrollTo({ left: x0, top: y0, behavior: "instant" });
    var offenders = [];
    var nodes = [];
    var all = document.body ? document.body.querySelectorAll("*") : [];
    for (var i = 0; i < all.length && offenders.length < 15; i++) {
      var el = all[i];
      var r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right <= vw + 0.5 && r.left >= -0.5) continue;
      var skip = false;
      for (var p = el; p && p !== document.body; p = p.parentElement) {
        var s = getComputedStyle(p);
        if (s.position === "fixed") { skip = true; break; }
        if (p !== el && s.overflowX !== "visible") { var pr = p.getBoundingClientRect(); if (pr.right <= vw + 0.5 && pr.left >= -0.5) { skip = true; break; } }
      }
      if (skip) continue;
      var nested = false;
      for (var k = 0; k < nodes.length; k++) if (nodes[k].contains(el)) { nested = true; break; }
      if (nested) continue;
      nodes.push(el);
      offenders.push({ el: describe(el), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) });
    }
    return { scrollWidth: root.scrollWidth, clientWidth: vw, scrolledX: scrolledX, offenders: offenders };
  }

  function squircles() {
    var native = !!(window.CSS && CSS.supports && CSS.supports("corner-shape", "squircle"));
    var fallbackRoot = document.documentElement.hasAttribute("data-squircle-fallback");
    var out = { native: native && !fallbackRoot, checked: 0, marked: 0, violations: [], exempt: 0, nativeMismatch: [] };
    var all = document.body ? document.body.querySelectorAll("*") : [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!visible(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) continue;
      // Parked off the page (a skip link above the top, a closed panel beside it): judged when it shows. A fixed layer
      // is placed against the viewport, so it is parked when it is outside the viewport whatever the scroll.
      if (fixedLayer(el) ? r.bottom <= 0 || r.right <= 0 || r.top >= window.innerHeight || r.left >= document.documentElement.clientWidth
        : r.bottom + window.scrollY <= 0 || r.right + window.scrollX <= 0 || r.left >= document.documentElement.scrollWidth) continue;
      var cs = getComputedStyle(el);
      var radii = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(function (v) { return parseFloat(v) || 0; });
      var maxR = Math.max.apply(null, radii);
      var marked = el.matches("[data-sq],[data-sq-native]");
      if (marked) out.marked++;
      if (maxR < 2) continue;
      var paints = !transparent(cs.backgroundColor) || cs.backgroundImage !== "none"
        || ["Top", "Right", "Bottom", "Left"].some(function (side) { return parseFloat(cs["border" + side + "Width"]) > 0 && !transparent(cs["border" + side + "Color"]); })
        || (cs.boxShadow && cs.boxShadow !== "none") || el.matches("img,video,canvas,iframe") || el.getAttribute("data-sq-fb") !== null;
      if (!paints) continue;
      out.checked++;
      var optedOut = !!el.closest('[data-corner="rounded"],[data-corner="sharp"]');
      var small = r.width <= 26 && r.height <= 26;
      var circle = Math.abs(r.width - r.height) < 2 && maxR >= Math.min(r.width, r.height) / 2 - 1;
      var shape = out.native ? (cs.getPropertyValue("corner-top-left-shape") || cs.getPropertyValue("corner-shape") || "").trim() : "";
      var drawnSquircle = /squircle|superellipse\(2\)/.test(shape);
      if (marked) {
        if (out.native && !optedOut && !drawnSquircle) out.nativeMismatch.push({ el: describe(el), shape: shape });
        continue;
      }
      // Unmarked but drawn as a squircle (corner-shape: inherit inside a squircle, as Arc's avatar photo does), or
      // clipped by a squircle parent in the fallback: a squircle all the same.
      if (drawnSquircle) { out.inherited = (out.inherited || 0) + 1; continue; }
      if (!out.native && el.parentElement && el.parentElement.closest('[data-sq="clip"]')) { out.inherited = (out.inherited || 0) + 1; continue; }
      if (optedOut || (small && circle) || el.matches("input[type=checkbox],input[type=radio],input[type=range]")) { out.exempt++; continue; }
      // A circle (a ring, a dot, a round mark) is a circle by design, not a rounded rectangle: noted, not judged.
      if (circle) { (out.circles = out.circles || []).push(describe(el) + " " + Math.round(r.width) + "px"); continue; }
      var interactive = el.matches("button,a[href],input,select,textarea,summary,[role=button],[role=tab],[role=switch],[role=combobox],[role=menuitem],[role=option],[role=dialog],[role=menu],[role=listbox],[role=tooltip],dialog,main,nav");
      var primary = interactive || (r.width >= 40 && r.height >= 40);
      out.violations.push({ el: describe(el), w: Math.round(r.width), h: Math.round(r.height), radius: cs.borderTopLeftRadius, pill: maxR >= Math.min(r.width, r.height) / 2 - 1, primary: primary });
    }
    return out;
  }

  function truncation() {
    var out = [];
    var all = document.body ? document.body.querySelectorAll("*") : [];
    for (var i = 0; i < all.length && out.length < 40; i++) {
      var el = all[i];
      if (!directText(el) || !visible(el)) continue;
      var box = el.getBoundingClientRect();
      if (box.width <= 2 || box.height <= 2) continue; // visually hidden on purpose (sr-only)
      var cs = getComputedStyle(el);
      if (cs.display === "inline" || cs.display === "contents") continue;
      var clipsX = cs.overflowX === "hidden" || cs.overflowX === "clip" || cs.textOverflow === "ellipsis";
      var clamp = cs.webkitLineClamp && cs.webkitLineClamp !== "none";
      var overX = el.scrollWidth > el.clientWidth + 1;
      var overY = el.scrollHeight > el.clientHeight + 1;
      var kind = "";
      if (clipsX && overX) kind = cs.textOverflow === "ellipsis" ? "ellipsis" : "clipped";
      else if (clamp && overY) kind = "line-clamp";
      else if (cs.overflowX === "visible" && overX && el.clientWidth > 0) kind = "spills";
      if (!kind) continue;
      var titled = !!(el.getAttribute("title") || el.closest("[title]") || el.getAttribute("aria-label") || el.closest("[aria-label]"));
      out.push({ el: describe(el), kind: kind, text: short(el.textContent, 140), titled: titled, box: el.clientWidth, content: el.scrollWidth, fixed: !!inFixed(el) });
    }
    return out;
  }

  /**
   * Controls a container cuts off: a button, link, field or option partly hidden by an ancestor's overflow (hidden or
   * clip) that a Carbon cannot scroll. Wholly hidden ones (a closed panel) are left out, and so are tab strips (they
   * scroll their selected tab into view; ux-audit-developer checks that).
   */
  function clippedControls() {
    var out = [];
    var all = document.body ? document.body.querySelectorAll("button,a[href],input:not([type=hidden]),select,textarea,[role=tab],[role=radio],[role=option],[role=checkbox],[role=switch],[role=menuitem]") : [];
    for (var i = 0; i < all.length && out.length < 12; i++) {
      var el = all[i];
      if (!visible(el) || el.closest("[inert],[aria-hidden=true],.sr-only,[role=tablist]")) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      for (var p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
        var s = getComputedStyle(p);
        if (s.position === "fixed") break;
        var pr = p.getBoundingClientRect();
        var cutX = 0, cutY = 0;
        var userScrollsX = (s.overflowX === "auto" || s.overflowX === "scroll") && p.scrollWidth > p.clientWidth + 1;
        var userScrollsY = (s.overflowY === "auto" || s.overflowY === "scroll") && p.scrollHeight > p.clientHeight + 1;
        if ((s.overflowX === "hidden" || s.overflowX === "clip") && !userScrollsX) cutX = Math.max(0, pr.left - r.left) + Math.max(0, r.right - pr.right);
        if ((s.overflowY === "hidden" || s.overflowY === "clip") && !userScrollsY) cutY = Math.max(0, pr.top - r.top) + Math.max(0, r.bottom - pr.bottom);
        var shownW = r.width - cutX, shownH = r.height - cutY;
        if ((cutX > 2 || cutY > 2) && shownW > 2 && shownH > 2) {
          out.push({ el: describe(el), by: describe(p).slice(0, 90), cutX: Math.round(cutX), cutY: Math.round(cutY), w: Math.round(r.width), h: Math.round(r.height) });
          break;
        }
        if ((cutX > 2 || cutY > 2) && (shownW <= 2 || shownH <= 2)) break; // wholly hidden: a closed panel
      }
    }
    return out;
  }

  /** The box an element's own and its ancestors' overflow let show, or null. */
  function clipBox(el) {
    var left = -Infinity, top = -Infinity, right = Infinity, bottom = Infinity;
    for (var p = el; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      var s = getComputedStyle(p);
      if (s.overflowX !== "visible" || s.overflowY !== "visible") {
        var pr = p.getBoundingClientRect();
        if (s.overflowX !== "visible") { left = Math.max(left, pr.left); right = Math.min(right, pr.right); }
        if (s.overflowY !== "visible") { top = Math.max(top, pr.top); bottom = Math.min(bottom, pr.bottom); }
      }
      if (s.position === "fixed") break;
    }
    return { left: left, top: top, right: right, bottom: bottom };
  }
  /** Each line of an element's own text (not its children's), clipped to what shows. */
  function textLines(el) {
    var out = [];
    var clip = clipBox(el);
    var range = document.createRange();
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType !== 3 || !n.textContent.trim()) continue;
      range.selectNodeContents(n);
      var list = range.getClientRects();
      for (var j = 0; j < list.length; j++) {
        var r = list[j];
        var l = Math.max(r.left, clip.left), t = Math.max(r.top, clip.top), rr = Math.min(r.right, clip.right), b = Math.min(r.bottom, clip.bottom);
        if (rr - l >= 2 && b - t >= 2) out.push({ left: l, top: t, right: rr, bottom: b });
      }
    }
    return out;
  }
  function textBoxes(includeFixed) {
    var boxes = [];
    var all = document.body ? document.body.querySelectorAll("*") : [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!directText(el) || !visible(el)) continue;
      if (!includeFixed && inFixed(el)) continue;
      if (el.closest("[aria-hidden=true],.sr-only")) continue;
      var box = el.getBoundingClientRect();
      if (box.width <= 2 || box.height <= 2) continue;
      var lines = textLines(el);
      if (lines.length) boxes.push({ node: el, lines: lines });
    }
    return boxes;
  }
  function textOverlaps() {
    var boxes = textBoxes(false);
    var out = [];
    for (var i = 0; i < boxes.length && out.length < 20; i++) {
      for (var j = i + 1; j < boxes.length; j++) {
        var a = boxes[i], b = boxes[j];
        if (a.node.contains(b.node) || b.node.contains(a.node)) continue;
        var worst = 0;
        for (var x = 0; x < a.lines.length; x++) for (var y = 0; y < b.lines.length; y++) {
          var p = a.lines[x], q = b.lines[y];
          var w = Math.min(p.right, q.right) - Math.max(p.left, q.left);
          var h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
          if (w <= 0 || h <= 0) continue;
          var smaller = Math.min((p.right - p.left) * (p.bottom - p.top), (q.right - q.left) * (q.bottom - q.top));
          if (smaller > 0) worst = Math.max(worst, (w * h) / smaller);
        }
        if (worst > 0.25) out.push({ a: describe(a.node), b: describe(b.node), overlap: Math.round(worst * 100) + "%" });
      }
    }
    return out;
  }

  function brokenImages() {
    var out = [];
    var imgs = document.images;
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      if (!visible(img)) continue;
      if (img.complete && img.naturalWidth === 0) out.push({ el: describe(img), src: String(img.currentSrc || img.src).slice(0, 120) });
    }
    return out;
  }

  function words() {
    var parts = [document.title, document.body ? document.body.innerText : ""];
    var all = document.body ? document.body.querySelectorAll("[aria-label],[title],[placeholder],img[alt],[aria-description]") : [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      ["aria-label", "title", "placeholder", "alt", "aria-description"].forEach(function (name) { var v = el.getAttribute(name); if (v) parts.push(v); });
    }
    return parts.join("\n");
  }

  function hiddenContent() {
    var out = [];
    var all = document.body ? document.body.querySelectorAll("h1,h2,h3,[role=heading],button,input,textarea,select,a[href],label,p") : [];
    for (var i = 0; i < all.length && out.length < 15; i++) {
      var el = all[i];
      if (el.closest("[aria-hidden=true],[inert],.sr-only,[hidden]")) continue;
      // Icon-only controls that show on hover or focus (a row's copy buttons, a heading's "#" link) are hidden by design.
      if (el.matches("button,a[href]") && !/[A-Za-z0-9]/.test(short(el.textContent, 20))) continue;
      // A native checkbox or radio kept transparent over the box a component draws for it (Arc's table row selects):
      // still focusable and clickable, shown by its drawn box.
      if (el.matches("input[type=checkbox],input[type=radio]") && parseFloat(getComputedStyle(el).opacity) === 0) continue;
      var r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      var cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      var opacity = 1;
      for (var p = el; p && p.nodeType === 1; p = p.parentElement) opacity *= parseFloat(getComputedStyle(p).opacity || "1");
      if (opacity < 0.98 && !el.matches(":disabled,[aria-disabled=true]") && !el.closest("[aria-busy=true]")) out.push({ el: describe(el), opacity: Math.round(opacity * 100) / 100 });
    }
    return out;
  }

  function poweredBy() {
    var holder = document.querySelector("[data-powered-by]");
    var link = null;
    if (holder) link = holder.matches("a") ? holder : holder.querySelector("a");
    if (!link) {
      var links = document.querySelectorAll("a");
      for (var i = 0; i < links.length; i++) if (/Silicon Accounts/.test(links[i].textContent || "") && /Powered by/.test((links[i].parentElement || links[i]).textContent || "")) link = links[i];
    }
    if (!link) return { found: false };
    var box = (holder && visible(holder) ? holder : link).getBoundingClientRect();
    var lr = link.getBoundingClientRect();
    var cx = lr.left + lr.width / 2, cy = lr.top + lr.height / 2;
    var inView = lr.top >= 0 && lr.left >= 0 && lr.bottom <= window.innerHeight && lr.right <= document.documentElement.clientWidth;
    var hit = inView ? document.elementFromPoint(cx, cy) : null;
    var covered = inView && hit && !(hit === link || link.contains(hit) || hit.contains(link) || (holder && holder.contains(hit))) ? describe(hit) : null;
    var overlaps = [];
    var others = document.body.querySelectorAll("a[href],button,input,textarea,select,h1,h2,h3,p,label,[role=button]");
    for (var j = 0; j < others.length && overlaps.length < 8; j++) {
      var o = others[j];
      if (o === link || link.contains(o) || o.contains(link) || (holder && (holder.contains(o) || o.contains(holder)))) continue;
      if (!visible(o)) continue;
      var orr = o.getBoundingClientRect();
      var x = Math.min(box.right, orr.right) - Math.max(box.left, orr.left);
      var y = Math.min(box.bottom, orr.bottom) - Math.max(box.top, orr.top);
      if (x > 1 && y > 1) overlaps.push(describe(o));
    }
    var line = short((holder || link.parentElement || link).textContent, 80);
    var cs = getComputedStyle(link);
    return { found: true, href: link.getAttribute("href"), text: line, rect: rect(lr), inView: inView, covered: covered, overlaps: overlaps, visible: visible(link), color: cs.color, scrollHeight: document.documentElement.scrollHeight, viewport: window.innerHeight };
  }

  function dockLayers() {
    var out = [];
    var all = document.body ? document.body.querySelectorAll("nav,div,aside,footer,header,section") : [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var cs = getComputedStyle(el);
      if (cs.position !== "fixed") continue;
      if (!visible(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 120 || r.height < 30 || r.height > 160) continue;
      if (window.innerHeight - r.bottom > 48) continue;
      if (el.closest("[role=dialog],[data-sonner-toaster],[role=status],[role=alert],[aria-live]")) continue;
      out.push({ node: el, r: r });
    }
    return out;
  }
  function dockClearance() {
    var root = document.scrollingElement || document.documentElement;
    window.scrollTo({ left: 0, top: root.scrollHeight, behavior: "instant" });
    var layers = dockLayers();
    if (!layers.length) return { dock: null, scrolledTo: window.scrollY };
    var dock = layers[0];
    for (var d = 1; d < layers.length; d++) if (layers[d].r.width > dock.r.width) dock = layers[d];
    var dr = dock.r;
    var lowest = null, lowestEl = null;
    var overlapping = [];
    var all = document.body.querySelectorAll("*");
    var docH = root.scrollHeight;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (dock.node.contains(el) || el.contains(dock.node)) continue;
      if (inFixed(el)) continue;
      if (!visible(el)) continue;
      var r = shownRect(el);
      if (!r || r.height >= docH * 0.8) continue;
      var cs = getComputedStyle(el);
      var paints = directText(el) || el.matches("img,svg,input,button,textarea,select,a[href],video,canvas")
        || !transparent(cs.backgroundColor) || ["Top", "Bottom"].some(function (s) { return parseFloat(cs["border" + s + "Width"]) > 0 && !transparent(cs["border" + s + "Color"]); });
      if (!paints) continue;
      if (lowest === null || r.bottom > lowest) { lowest = r.bottom; lowestEl = el; }
      var x = Math.min(dr.right, r.right) - Math.max(dr.left, r.left);
      var y = Math.min(dr.bottom, r.bottom) - Math.max(dr.top, r.top);
      if (x > 1 && y > 1 && overlapping.length < 8) overlapping.push({ el: describe(el), rect: rect(r) });
    }
    return { dock: rect(dr), dockEl: describe(dock.node), lowestContent: lowest === null ? null : Math.round(lowest), lowestEl: lowestEl ? describe(lowestEl) : null, gap: lowest === null ? null : Math.round(dr.top - lowest), overlapping: overlapping, scrolledTo: Math.round(window.scrollY), viewport: window.innerHeight, scrollHeight: root.scrollHeight };
  }

  var FOCUSABLE = 'a[href],area[href],button,input:not([type=hidden]),select,textarea,iframe,summary,[tabindex],[contenteditable=""],[contenteditable=true]';
  var LOOK = ["outline-style", "outline-width", "outline-color", "box-shadow", "background-color", "background-image", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "border-top-width", "border-bottom-width", "color", "text-decoration-line", "--sq-fill", "--sq-stroke", "opacity", "transform", "filter"];
  var looks = new WeakMap();
  var uids = new WeakMap();
  var nextUid = 1;
  function look(el) {
    var out = {};
    function add(prefix, cs) { for (var i = 0; i < LOOK.length; i++) out[prefix + LOOK[i]] = cs.getPropertyValue(LOOK[i]).trim(); }
    add("", getComputedStyle(el));
    add("::before ", getComputedStyle(el, "::before"));
    add("::after ", getComputedStyle(el, "::after"));
    var p = el.parentElement;
    for (var i = 0; i < 3 && p; i++, p = p.parentElement) add("parent" + i + " ", getComputedStyle(p));
    var kids = el.querySelectorAll("*");
    for (var k = 0; k < kids.length && k < 6; k++) add("child" + k + " ", getComputedStyle(kids[k]));
    // Indicators drawn by a neighbour (an inline editor's frame, a ring that moves between code cells).
    var prev = el.previousElementSibling, next = el.nextElementSibling;
    for (var s = 0; s < 2; s++) {
      if (prev) { add("prev" + s + " ", getComputedStyle(prev)); prev = prev.previousElementSibling; }
      if (next) { add("next" + s + " ", getComputedStyle(next)); next = next.nextElementSibling; }
    }
    return out;
  }
  function snapshotLooks() {
    if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) document.activeElement.blur();
    var all = document.querySelectorAll(FOCUSABLE);
    for (var i = 0; i < all.length; i++) looks.set(all[i], look(all[i]));
    return all.length;
  }
  /** An element's text without its aria-hidden parts (a label drawn twice, once for the eyes and once for the name). */
  function spokenText(el) {
    var out = "";
    (function walk(node) {
      for (var i = 0; i < node.childNodes.length; i++) {
        var c = node.childNodes[i];
        if (c.nodeType === 3) out += c.textContent;
        else if (c.nodeType === 1 && c.getAttribute("aria-hidden") !== "true") walk(c);
      }
    })(el);
    return out;
  }
  function nameOf(el) {
    // aria-labelledby wins over aria-label (accname 1.2, step 2B before 2C).
    var by = el.getAttribute("aria-labelledby");
    if (by) {
      var named = short(by.split(/\s+/).map(function (id) { var n = document.getElementById(id); return n ? spokenText(n) : ""; }).join(" "), 80);
      if (named) return named;
    }
    var label = el.getAttribute("aria-label");
    if (label) return short(label, 80);
    if (el.id) { var l = document.querySelector('label[for="' + el.id + '"]'); if (l) return short(spokenText(l), 80); }
    var wrap = el.closest("label");
    if (wrap) return short(spokenText(wrap), 80);
    return short(spokenText(el) || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("value"), 80);
  }
  function activeFocus() {
    var el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    if (!el || el === document.body || el === document.documentElement) return { none: true };
    var r = el.getBoundingClientRect();
    var before = looks.get(el);
    var now = look(el);
    var changed = null;
    if (before) { changed = []; for (var key in now) if (now[key] !== before[key]) changed.push(key); }
    // A link that wraps onto a second line: its box spans both lines (and whatever sits beside it), so the point that
    // must be the link's own, and the position that orders it, are its first line's.
    var lines = el.getClientRects();
    var first = lines.length > 1 ? lines[0] : r;
    // Started above the viewport (taller than it, a long table): the middle of the part on screen, not its hidden top.
    var cx = first.left + first.width / 2, cy = first.top < 0 ? Math.min(first.bottom, window.innerHeight) / 2 : first.top + Math.min(first.height / 2, 20);
    var inView = r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < document.documentElement.clientWidth;
    var fully = r.top >= -1 && r.left >= -1 && r.bottom <= window.innerHeight + 1 && r.right <= document.documentElement.clientWidth + 1;
    // Inside a shadow root (the SDK's buttons) the document answers with the host: ask the shadow root instead.
    var scope = el.getRootNode && el.getRootNode() !== document && el.getRootNode().elementFromPoint ? el.getRootNode() : document;
    var hit = inView ? scope.elementFromPoint(Math.max(0, Math.min(cx, document.documentElement.clientWidth - 1)), Math.max(0, Math.min(cy, window.innerHeight - 1))) : null;
    var obscuredBy = hit && !(hit === el || el.contains(hit) || hit.contains(el) || (el.labels && Array.prototype.some.call(el.labels, function (l) { return l.contains(hit); }))) ? describe(hit) : null;
    var uid = uids.get(el);
    if (!uid) { uid = nextUid++; uids.set(el, uid); }
    // A native checkbox or radio kept transparent over the box a component draws for it is seen through that box.
    var toggle = el.matches("input[type=checkbox],input[type=radio]") && parseFloat(getComputedStyle(el).opacity) === 0;
    var seen = toggle ? (typeof el.checkVisibility !== "function" || el.checkVisibility({ checkVisibilityCSS: true })) && r.width > 0 && r.height > 0 : visible(el);
    return {
      uid: uid, none: false, el: describe(el), tag: el.tagName.toLowerCase(), type: el.getAttribute("type") || "", role: el.getAttribute("role") || "", name: nameOf(el),
      rect: rect(r), line: rect(first), inView: inView, fully: fully, obscuredBy: obscuredBy, changed: changed, inert: !!el.closest("[inert]"), ariaHidden: !!el.closest("[aria-hidden=true]"),
      visible: seen, focusVisible: el.matches(":focus-visible"), scrollY: Math.round(window.scrollY),
    };
  }

  var blurred = null;
  function blurActive() {
    var el = document.activeElement;
    if (!el || el === document.body) return false;
    blurred = el;
    el.blur();
    return true;
  }
  function refocus() {
    if (!blurred) return false;
    try { blurred.focus({ preventScroll: true, focusVisible: true }); } catch (e) { blurred.focus({ preventScroll: true }); }
    blurred = null;
    return true;
  }

  var motion = null;
  function motionStart(opts) {
    opts = opts || {};
    var state = { running: true, frames: [], ids: new WeakMap(), next: 0, descs: [], selector: opts.selector || "body *", started: performance.now() };
    motion = state;
    function sample() {
      if (!state.running) return;
      var frame = { t: Math.round(performance.now() - state.started), sy: Math.round(window.scrollY), anims: [], geo: [] };
      var list = document.getAnimations ? document.getAnimations() : [];
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        if (a.playState !== "running") continue;
        var effect = a.effect;
        var props = [];
        try {
          var kf = effect && effect.getKeyframes ? effect.getKeyframes() : [];
          var set = {};
          for (var k = 0; k < kf.length; k++) for (var p in kf[k]) if (["offset", "easing", "composite", "computedOffset"].indexOf(p) < 0) set[p] = true;
          props = Object.keys(set);
        } catch (e) { props = []; }
        var timing = effect && effect.getComputedTiming ? effect.getComputedTiming() : {};
        frame.anims.push({
          name: a.animationName || a.transitionProperty || a.id || (a.constructor && a.constructor.name) || "animation",
          target: effect && effect.target ? describe(effect.target) : "", pseudo: (effect && effect.pseudoElement) || null, props: props,
          duration: typeof timing.duration === "number" ? Math.round(timing.duration) : 0, infinite: timing.iterations === Infinity,
        });
      }
      var nodes = document.querySelectorAll(state.selector);
      for (var n = 0; n < nodes.length && n < 2500; n++) {
        var el = nodes[n];
        var r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        var id = state.ids.get(el);
        if (id === undefined) { id = state.next++; state.ids.set(el, id); state.descs[id] = describe(el); }
        var cs = getComputedStyle(el);
        frame.geo.push([id, Math.round(r.left * 2) / 2, Math.round(r.top * 2) / 2, Math.round(r.width * 2) / 2, Math.round(r.height * 2) / 2, cs.transform === "none" ? "" : cs.transform, cs.opacity, cs.clipPath === "none" ? "" : cs.clipPath]);
      }
      state.frames.push(frame);
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
    return true;
  }
  function motionStop() {
    var state = motion;
    if (!state) return null;
    state.running = false;
    var anims = {};
    for (var f = 0; f < state.frames.length; f++) {
      var list = state.frames[f].anims;
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        var key = a.name + "|" + a.target + "|" + a.pseudo;
        if (!anims[key]) anims[key] = { name: a.name, target: a.target, pseudo: a.pseudo, props: a.props, duration: a.duration, infinite: a.infinite, frames: 0, moving: a.props.some(function (p) { return MOTION.test(p); }) };
        anims[key].frames++;
      }
    }
    var tracks = {};
    for (var g = 0; g < state.frames.length; g++) {
      var frame = state.frames[g];
      for (var j = 0; j < frame.geo.length; j++) {
        var e = frame.geo[j];
        (tracks[e[0]] = tracks[e[0]] || []).push({ f: g, sy: frame.sy, x: e[1], y: e[2], w: e[3], h: e[4], t: e[5], o: e[6], c: e[7] });
      }
    }
    var moving = [], fading = [];
    for (var id in tracks) {
      var tr = tracks[id];
      var run = 0, best = 0, dist = 0, fadeRun = 0, bestFade = 0;
      for (var s = 1; s < tr.length; s++) {
        var p = tr[s - 1], q = tr[s];
        if (q.f !== p.f + 1 || q.sy !== p.sy) { run = 0; fadeRun = 0; continue; }
        var moved = Math.abs(q.x - p.x) > 0.5 || Math.abs(q.y - p.y) > 0.5 || Math.abs(q.w - p.w) > 0.5 || Math.abs(q.h - p.h) > 0.5 || q.t !== p.t || q.c !== p.c;
        if (moved) { run++; dist = Math.max(dist, Math.abs(q.x - tr[0].x) + Math.abs(q.y - tr[0].y), Math.abs(q.h - tr[0].h), Math.abs(q.w - tr[0].w)); if (run > best) best = run; } else run = 0;
        if (q.o !== p.o) { fadeRun++; if (fadeRun > bestFade) bestFade = fadeRun; } else fadeRun = 0;
      }
      if (best >= 3 && dist >= 2) moving.push({ el: state.descs[id], frames: best, px: Math.round(dist) });
      if (bestFade >= 3) fading.push({ el: state.descs[id], frames: bestFade });
    }
    var all = Object.keys(anims).map(function (k) { return anims[k]; });
    moving.sort(function (a, b) { return b.px - a.px; });
    return {
      frames: state.frames.length, ms: state.frames.length ? state.frames[state.frames.length - 1].t : 0,
      motionAnimations: all.filter(function (a) { return a.moving && a.duration > 30; }),
      fadeAnimations: all.filter(function (a) { return !a.moving && a.duration > 30 && a.props.indexOf("opacity") >= 0; }).length,
      infinite: all.filter(function (a) { return a.infinite; }),
      viewTransitions: all.filter(function (a) { return a.pseudo && /view-transition/.test(a.pseudo); }).length,
      moving: moving.slice(0, 15), movingCount: moving.length, fading: fading.length,
    };
  }

  function axeRun(opts) {
    if (!window.axe) return Promise.resolve({ error: "axe-core is not loaded in this page" });
    var options = { resultTypes: ["violations"], iframes: false };
    options.runOnly = { type: "tag", values: (opts && opts.tags) || ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] };
    if (opts && opts.disable && opts.disable.length) { options.rules = {}; opts.disable.forEach(function (id) { options.rules[id] = { enabled: false }; }); }
    return window.axe.run(document, options).then(function (res) {
      return {
        violations: res.violations.map(function (v) {
          return { id: v.id, impact: v.impact, help: v.help, tags: v.tags.filter(function (t) { return /^wcag|best/.test(t); }), count: v.nodes.length,
            nodes: v.nodes.slice(0, 6).map(function (n) { return { target: n.target.join(" "), html: short(n.html, 220), summary: short(n.failureSummary, 300) }; }) };
        }),
      };
    }, function (err) { return { error: String(err && err.message || err) }; });
  }

  window.__uxa = {
    describe: describe, visible: visible, calm: calm, overflow: overflow, squircles: squircles, truncation: truncation, textOverlaps: textOverlaps, clippedControls: clippedControls,
    brokenImages: brokenImages, words: words, hiddenContent: hiddenContent, poweredBy: poweredBy, dockClearance: dockClearance,
    snapshotLooks: snapshotLooks, activeFocus: activeFocus, blurActive: blurActive, refocus: refocus, motionStart: motionStart, motionStop: motionStop, axe: axeRun,
  };
})();
`;
