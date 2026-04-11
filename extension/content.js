/**
 * Content script — injected into every page.
 * Handles dom_query (return interactive elements) and dom_execute (perform action).
 */

/** Returns a unique CSS selector for an element. */
function getSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;

  const parts = [];
  let current = el;
  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      selector = `#${CSS.escape(current.id)}`;
      parts.unshift(selector);
      break;
    }
    const siblings = Array.from(current.parentNode?.children ?? []).filter(
      (s) => s.tagName === current.tagName,
    );
    if (siblings.length > 1) {
      selector += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    }
    parts.unshift(selector);
    current = current.parentNode;
    if (current === document.body || !current) break;
  }
  return parts.join(' > ') || el.tagName.toLowerCase();
}

/** Returns a cleaned text label for an element. */
function getLabel(el) {
  // 1. Resolve aria-labelledby — references text in another element (e.g. Amazon size swatches)
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const resolved = labelledBy.trim().split(/\s+/)
      .map(id => document.getElementById(id)?.textContent?.trim())
      .filter(Boolean)
      .join(' ');
    if (resolved) return resolved.slice(0, 200);
  }

  // 2. For <a> links: prefer aria-label, then first child img[alt], then title, then textContent
  if (el.tagName.toLowerCase() === 'a') {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();
    const imgAlt = el.querySelector('img[alt]')?.getAttribute('alt')?.trim();
    if (imgAlt) return imgAlt.slice(0, 200);
    const title = el.getAttribute('title');
    if (title) return title.trim();
    return (el.textContent?.trim().slice(0, 200) || '').trim();
  }

  // 3. For radio/checkbox: resolve associated <label for="id"> to get the visible option text
  const elId = el.id;
  if (elId && (el.tagName.toLowerCase() === 'input')) {
    const inputType = (el.getAttribute('type') ?? '').toLowerCase();
    if (inputType === 'radio' || inputType === 'checkbox') {
      const associatedLabel = document.querySelector('label[for="' + elId + '"]');
      if (associatedLabel) {
        const labelText = associatedLabel.textContent?.trim().replace(/\s+/g, ' ') ?? '';
        if (labelText) return labelText.slice(0, 120);
      }
    }
  }

  // 4. Standard: aria-label, placeholder, title, textContent, value
  return (
    el.getAttribute('aria-label') ||
    el.getAttribute('placeholder') ||
    el.getAttribute('title') ||
    el.textContent?.trim().slice(0, 120) ||
    el.getAttribute('value') ||
    ''
  ).trim();
}

/** Collects interactive elements visible in the viewport, search/form inputs first. */
function collectElements() {
  const TAGS = ['button', 'a', 'input', 'select', 'textarea', 'label', '[role="button"]', '[role="radio"]', '[role="option"]', '[role="listbox"]', '[role="combobox"]', '[tabindex]'];
  const seen = new WeakSet();
  const results = [];

  for (const tag of TAGS) {
    for (const el of document.querySelectorAll(tag)) {
      if (seen.has(el)) continue;
      seen.add(el);

      const inputType = el.tagName.toLowerCase() === 'input' ? (el.getAttribute('type') ?? '').toLowerCase() : '';
      // Radio/checkbox use custom CSS overlays — native input is often opacity:0 or 0x0
      // or display:none. Treat them as form inputs and never skip based on visibility.
      const isFormInput = inputType === 'radio' || inputType === 'checkbox';

      // Skip hidden elements — but allow radio/checkbox through (custom-styled forms hide
      // the native input with display:none and render a <span> overlay instead).
      const style = window.getComputedStyle(el);
      if (!isFormInput && (style.display === 'none' || style.visibility === 'hidden')) continue;

      if (!isFormInput && style.opacity === '0') continue;

      const rect = el.getBoundingClientRect();
      if (!isFormInput && (rect.width === 0 || rect.height === 0)) continue;
      // Swatches (role=radio/option) are collected even when off-viewport (Amazon size/color swatches)
      const isSwatchLike = isFormInput ||
        el.getAttribute('role') === 'radio' || el.getAttribute('role') === 'option' ||
        el.tagName.toLowerCase() === 'input' && (inputType === 'submit');
      if (!isSwatchLike && (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth)) continue;

      const label = getLabel(el);
      const selector = getSelector(el);

      const rawHref = el.getAttribute('href');
      const info = {
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') ?? undefined,
        role: el.getAttribute('role') ?? undefined,
        text: label,
        ariaLabel: el.getAttribute('aria-label') ?? undefined,
        placeholder: el.getAttribute('placeholder') ?? undefined,
        id: el.id || undefined,
        name: el.getAttribute('name') ?? undefined,
        href: rawHref ? rawHref.slice(0, 120) : undefined,
        selector,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      };

      // Collect options for <select>
      if (el.tagName.toLowerCase() === 'select') {
        info.options = Array.from(el.options).map((o) => o.text.trim());
      }

      results.push(info);
    }
  }

  // Sort: text/search/email inputs first, then textareas, then submit/search buttons, then the rest
  const priority = (el) => {
    const tag = el.tag;
    const type = (el.type ?? '').toLowerCase();
    if (tag === 'input' && (type === 'text' || type === 'search' || type === 'email' || type === '')) return 0;
    if (tag === 'textarea') return 1;
    if (tag === 'input' && (type === 'submit' || type === 'button')) return 2;
    if (tag === 'button') return 3;
    if (tag === 'select') return 4;
    return 5;
  };

  results.sort((a, b) => priority(a) - priority(b));

  return results;
}

/**
 * Normalise a string for keyword matching: lowercase, strip apostrophes/accents.
 */
function normaliseText(s) {
  return s.toLowerCase().replace(/[''`]/g, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Try to find an interactive element whose text best matches the given verifyText.
 * Returns the DOM element or null.
 */
function findElementByText(verifyText) {
  if (!verifyText || verifyText.trim().length < 3) return null;
  const keywords = normaliseText(verifyText)
    .split(/\s+/)
    .filter(w => w.length >= 3)
    .slice(0, 6);
  if (keywords.length === 0) return null;
  const found = findByText(keywords);
  if (found.length === 0) return null;
  if (found.length === 1) return document.querySelector(found[0].selector);
  // Multiple matches — pick the one whose label overlaps most with verifyText
  const needle = normaliseText(verifyText);
  const scored = found.map(f => ({
    el: document.querySelector(f.selector),
    score: keywords.filter(w => normaliseText(f.text).includes(w)).length,
  })).filter(x => x.el);
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.el ?? null;
}

/** Executes an action on an element found by selector, with optional text/href verification. */
// Helper: simulate pointer/mouse events to better trigger custom handlers
function simulatePointerAndMouseClick(target) {
  try {
    const r = target.getBoundingClientRect();
    const clientX = Math.round(r.left + r.width / 2);
    const clientY = Math.round(r.top + r.height / 2);
    const opts = { bubbles: true, cancelable: true, view: window, clientX, clientY };
    target.dispatchEvent(new PointerEvent('pointerdown', opts));
    target.dispatchEvent(new PointerEvent('pointerup', opts));
    target.dispatchEvent(new MouseEvent('mousedown', opts));
    target.dispatchEvent(new MouseEvent('mouseup', opts));
    target.dispatchEvent(new MouseEvent('click', opts));
    return true;
  } catch (err) {
    console.warn('[dom-execute] simulatePointerAndMouseClick failed', err);
    try { target.click(); return true; } catch (e) { return false; }
  }
}

// Helper: find the most likely visual control for an input (label, wrapper, sibling)
function findVisualControlForInput(el) {
  if (!el) return null;
  const id = el.id;
  if (id) {
    const byFor = document.querySelector('label[for="' + CSS.escape(id) + '"]');
    if (byFor) return byFor;
  }
  const closestLabel = el.closest('label');
  if (closestLabel) return closestLabel;
  // look for nearby interactive element(s)
  const parent = el.parentElement;
  if (parent) {
    const candidate = parent.querySelector('[role="checkbox"], [role="switch"], .checkbox, .toggle, .switch, .custom-checkbox, [data-for]');
    if (candidate) return candidate;
    if (el.previousElementSibling) return el.previousElementSibling;
    if (el.nextElementSibling) return el.nextElementSibling;
  }
  return null;
}

function executeAction(selector, action, verifyText, verifyHref) {
  let el = null;
  let resolvedBy = 'selector';

  // For <a> clicks: href is the most stable and precise identifier (unique per link).
  // Try it FIRST before any fuzzy text search to avoid matching wrong elements.
  if (action.kind === 'click' && verifyHref) {
    const path = verifyHref.split('?')[0];
    el = document.querySelector('a[href="' + verifyHref + '"]') ||
         document.querySelector('a[href*="' + path + '"]');
    if (el) resolvedBy = 'href';
  }

  // Second try: fuzzy text search (fallback when no href available)
  if (!el && action.kind === 'click' && verifyText) {
    el = findElementByText(verifyText);
    if (el) resolvedBy = 'text';
  }

  // Final fallback to collected CSS selector
  if (!el) el = document.querySelector(selector);
  if (!el) throw new Error(`Elemento não encontrado: ${selector}`);

  // Log exactly what we're about to click for debugging
  const elText = (
    el.getAttribute('aria-label') ||
    el.textContent?.trim().slice(0, 120) ||
    el.getAttribute('title') ||
    el.getAttribute('value') || ''
  ).replace(/\s+/g, ' ').trim();
  const elHref = el.getAttribute('href') ?? '';
  const elRect = el.getBoundingClientRect();
  console.log(
    `[dom-execute] resolvedBy=${resolvedBy} tag=${el.tagName.toLowerCase()} ` +
    `text="${elText}" href="${elHref}" ` +
    `rect={x:${Math.round(elRect.x)},y:${Math.round(elRect.y)},w:${Math.round(elRect.width)},h:${Math.round(elRect.height)}} ` +
    `selector="${selector}" verifyText="${verifyText ?? ''}" verifyHref="${verifyHref ?? ''}"`
  );

  // Track before/after state for checkboxes and whether we used the label
  let labelUsed = false;
  const inputTypeForState = el.tagName.toLowerCase() === 'input' ? (el.getAttribute('type') ?? '').toLowerCase() : null;
  const wasChecked = inputTypeForState === 'checkbox' ? !!el.checked : undefined;

  el.scrollIntoView({ block: 'center', behavior: 'smooth' });

  switch (action.kind) {
    case 'click': {
      const inputType = el.tagName.toLowerCase() === 'input' ? (el.getAttribute('type') ?? '').toLowerCase() : null;
      if (inputType === 'radio') {
        const vis = findVisualControlForInput(el) || el;
        if (vis && vis.tagName && vis.tagName.toLowerCase() === 'label') {
          vis.click(); labelUsed = true;
        } else {
          simulatePointerAndMouseClick(vis);
        }
      } else if (inputType === 'checkbox') {
        if (!el.checked) {
          const vis = findVisualControlForInput(el) || el;
          if (vis && vis.tagName && vis.tagName.toLowerCase() === 'label') {
            vis.click(); labelUsed = true;
          } else {
            // try pointer/mouse sequence first — more likely to trigger custom handlers
            const ok = simulatePointerAndMouseClick(vis);
            if (!ok) try { vis.click(); } catch (e) { /* ignore */ }
          }
          // If the visual click didn't toggle the underlying input, force it and emit events after a short delay
          setTimeout(() => {
            try {
              if (!el.checked) {
                el.checked = true;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            } catch (e) {
              /* ignore */
            }
          }, 80);
        }
      } else {
        el.click();
      }
      break;
    }

    case 'select': {
      if (el.tagName.toLowerCase() !== 'select') throw new Error('Elemento não é um <select>');
      const opts = Array.from(el.options);
      // Match by text content (case-insensitive, partial)
      const target = action.value.toLowerCase();
      const match = opts.find(
        (o) => o.text.toLowerCase().includes(target) || o.value.toLowerCase().includes(target),
      );
      if (!match) throw new Error(`Opção "${action.value}" não encontrada em <select>`);
      el.value = match.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      break;
    }

    case 'type': {
      if (action.clearFirst) {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      el.value = action.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      break;
    }

    case 'submit': {
      const form = el.closest('form');
      if (form) form.submit();
      else el.click();
      break;
    }
  }

  // After performing the action, capture resulting state for debug (checkbox checked state)
  setTimeout(() => {
    try {
      const nowChecked = inputTypeForState === 'checkbox' ? !!(document.querySelector(selector)?.checked) : undefined;
      window.__lastClickDebug = { resolvedBy, tag: el.tagName.toLowerCase(), text: elText, href: elHref, selector, wasChecked, nowChecked, labelClicked: labelUsed, timestamp: Date.now() };
      console.log('[dom-execute] clickDebug:', window.__lastClickDebug);
    } catch (e) {
      console.warn('[dom-execute] failed to compute clickDebug', e);
    }
  }, 80);
}

/**
 * Search ALL interactive elements on the page (entire document, not just viewport)
 * for ones whose text/label/placeholder/aria-labelledby contain ALL the given keywords.
 * Returns an array of matching DomElement-like objects.
 */
function findByText(keywords) {
  const lower = keywords.map(k => normaliseText(k).trim()).filter(Boolean);
  if (lower.length === 0) return [];

  const INTERACTIVE = ['button', 'a', 'input', 'select', 'textarea',
    '[role="button"]', '[role="radio"]', '[role="option"]',
    '[role="checkbox"]', '[role="tab"]', '[role="menuitem"]', '[tabindex]'];

  const seen = new WeakSet();
  const results = [];

  for (const tag of INTERACTIVE) {
    for (const el of document.querySelectorAll(tag)) {
      if (seen.has(el)) continue;
      seen.add(el);

      // Skip disabled elements (don't call getComputedStyle — too slow on large pages)
      if (el.disabled) continue;

      // Resolve every possible text source
      const labelledBy = el.getAttribute('aria-labelledby');
      const labelledByText = labelledBy
        ? labelledBy.trim().split(/\s+/)
            .map(id => document.getElementById(id)?.textContent?.trim())
            .filter(Boolean)
            .join(' ')
        : '';

      const labelFor = el.id
        ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim()
        : '';

      const hay = [
        labelledByText,
        labelFor,
        el.getAttribute('aria-label'),
        el.getAttribute('placeholder'),
        el.getAttribute('title'),
        el.getAttribute('value'),
        el.textContent?.trim(),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      if (!hay) continue;
      // Fuzzy match with apostrophe normalisation ("its" matches "it's", etc.)
      // Also trims last char to handle 1-char vision AI hallucinations ("uwuu" → "uwu")
      const normHay = normaliseText(hay);
      const kwMatch = kw => {
        const nkw = normaliseText(kw);
        return normHay.includes(nkw) || (nkw.length > 3 && normHay.includes(nkw.slice(0, -1)));
      };
      if (!lower.every(kwMatch)) continue;

      const rect = el.getBoundingClientRect();
      const selector = getSelector(el);

      // Resolve the best human-readable label for this element
      const label = labelledByText || labelFor ||
        el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
        el.getAttribute('title') || el.textContent?.trim().slice(0, 200) ||
        el.getAttribute('value') || '';

      const rawHref = el.getAttribute('href');
      results.push({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') ?? undefined,
        role: el.getAttribute('role') ?? undefined,
        text: label.trim(),
        ariaLabel: el.getAttribute('aria-label') ?? undefined,
        placeholder: el.getAttribute('placeholder') ?? undefined,
        id: el.id || undefined,
        name: el.getAttribute('name') ?? undefined,
        href: rawHref ? rawHref.slice(0, 120) : undefined,
        selector,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      });
    }
  }

  return results;
}

// Remove any previously registered handler from a prior injection of this script.
// Chrome caches content scripts per-tab; re-injection would add a second listener
// on top of the stale one. This guard ensures only the latest version is active.
if (window.__aiAssistantMsgHandler) {
  chrome.runtime.onMessage.removeListener(window.__aiAssistantMsgHandler);
}

window.__aiAssistantMsgHandler = (msg, _sender, sendResponse) => {
  try {
    if (msg.type === 'dom_query') {
      const elements = collectElements();
      sendResponse({ type: 'dom_result', requestId: msg.requestId, elements });
    } else if (msg.type === 'dom_find') {
      const elements = findByText(msg.keywords ?? []);
      sendResponse({ type: 'dom_result', requestId: msg.requestId, elements });
    } else if (msg.type === 'dom_execute') {
      executeAction(msg.selector, msg.action, msg.verifyText, msg.verifyHref);
      // Wait a short moment for page JS to update checkbox/radio state, then return debug info
      setTimeout(() => {
        try {
          sendResponse({ type: 'dom_result', requestId: msg.requestId, elements: [], clickDebug: window.__lastClickDebug ?? null });
        } catch (e) {
          console.warn('[content] failed to send dom_execute response', e);
        }
      }, 120);
      return true; // indicate async response
    } else if (msg.type === 'dom_find_and_execute') {
      // Find AND act in a single synchronous operation — prevents TikTok/YouTube
      // virtual-scroll DOM recycling between the find and the execute round trips.
      const keywords = msg.keywords ?? [];
      const action = msg.action ?? { kind: 'click' };

      // ── Play/Pause: video API first ──────────────────────────────────────────────
      // The play/pause DOM button on YouTube/Shorts is stateful: it shows "Assistir (k)"
      // when paused and "Pausar (k)" when playing, and may be hidden by the overlay.
      // The most reliable approach is to call video.play()/pause() directly and skip DOM
      // entirely — no stale selector, no hidden button, no substring-match confusion.
      const PLAY_KWS  = ['play', 'assistir', 'reproduzir', 'iniciar', 'reprodução', 'tocar', 'resume'];
      const PAUSE_KWS = ['pause', 'pausar', 'parar', 'stop'];
      const allKws = msg.anyOf ? msg.anyOf.flat() : keywords;
      const isPlayIntent  = allKws.some(k => PLAY_KWS.includes(normaliseText(k)));
      const isPauseIntent = allKws.some(k => PAUSE_KWS.includes(normaliseText(k)));

      if (isPlayIntent || isPauseIntent) {
        const video = document.querySelector('video');
        if (video) {
          if (isPlayIntent) {
            video.play();
            window.__lastClickDebug = { resolvedBy: 'video_api', tag: 'video', text: 'play()', href: '', selector: 'video' };
            console.log('[dom-find-execute] video.play() via API');
            sendResponse({ type: 'dom_result', requestId: msg.requestId, elements: [{ tag: 'video', text: 'play()', selector: 'video' }], clickDebug: window.__lastClickDebug });
          } else {
            video.pause();
            window.__lastClickDebug = { resolvedBy: 'video_api', tag: 'video', text: 'pause()', href: '', selector: 'video' };
            console.log('[dom-find-execute] video.pause() via API');
            sendResponse({ type: 'dom_result', requestId: msg.requestId, elements: [{ tag: 'video', text: 'pause()', selector: 'video' }], clickDebug: window.__lastClickDebug });
          }
          return true;
        }
        // No <video> element — fall through to DOM button search below
      }

      // ── General DOM search ────────────────────────────────────────────────────────
      // Word-boundary-aware scoring: exact match=30, word-boundary=20, substring=5.
      const scoreKwMatch = (text, kw) => {
        if (!text) return 0;
        const t = normaliseText(text);
        if (t === kw) return 30;
        const idx = t.indexOf(kw);
        if (idx === -1) return 0;
        const before = idx === 0 || t[idx - 1] === ' ';
        const after = idx + kw.length === t.length || t[idx + kw.length] === ' ';
        if (before && after) return 20;
        return 5;
      };

      // Collect ALL candidates across every keyword group (OR semantics).
      // Accumulate the MAXIMUM score per unique selector so the highest-confidence
      // match always wins regardless of iteration order.
      const selectorBest = new Map(); // selector → { el, score }
      const collectCandidates = (el, kwGroup) => {
        const score = kwGroup.map(k => normaliseText(k)).reduce((acc, k) =>
          acc + Math.max(scoreKwMatch(el.text, k), scoreKwMatch(el.ariaLabel, k)), 0);
        const prev = selectorBest.get(el.selector);
        if (!prev || score > prev.score) {
          selectorBest.set(el.selector, { el, score });
        }
      };

      if (msg.anyOf && msg.anyOf.length > 0) {
        // AND-of-ORs: element must satisfy at least one keyword from EVERY group.
        // This prevents loose OR matches (e.g. a video with only 'craft' in its title
        // winning over a video that actually has 'mine' AND 'craft' AND '01').
        var groupResults = msg.anyOf.map(function(kwGroup) {
          var found = findByText(kwGroup);
          var selSet = new Set();
          for (var i = 0; i < found.length; i++) selSet.add(found[i].selector);
          return { kwGroup: kwGroup, found: found, selSet: selSet };
        });

        // Intersect selector sets across all groups
        var intersected = groupResults[0].selSet;
        for (var gi = 1; gi < groupResults.length; gi++) {
          var next = new Set();
          intersected.forEach(function(s) { if (groupResults[gi].selSet.has(s)) next.add(s); });
          intersected = next;
        }

        if (intersected.size > 0) {
          // Score elements in the intersection against ALL keywords combined
          var allGroupKws = msg.anyOf.flat().map(function(k) { return normaliseText(k); });
          var seenIntersect = new Set();
          for (var gi2 = 0; gi2 < groupResults.length; gi2++) {
            var gfound = groupResults[gi2].found;
            for (var ei = 0; ei < gfound.length; ei++) {
              var gel = gfound[ei];
              if (!intersected.has(gel.selector) || seenIntersect.has(gel.selector)) continue;
              seenIntersect.add(gel.selector);
              var gscore = allGroupKws.reduce(function(acc, k) {
                return acc + Math.max(scoreKwMatch(gel.text, k), scoreKwMatch(gel.ariaLabel, k));
              }, 0);
              var prev = selectorBest.get(gel.selector);
              if (!prev || gscore > prev.score) selectorBest.set(gel.selector, { el: gel, score: gscore });
            }
          }
        } else {
          // Fallback: no element satisfied all groups — revert to OR so something is still found
          for (var gi3 = 0; gi3 < groupResults.length; gi3++) {
            var gr = groupResults[gi3];
            for (var ei2 = 0; ei2 < gr.found.length; ei2++) collectCandidates(gr.found[ei2], gr.kwGroup);
          }
        }
      } else {
        for (const el of findByText(keywords)) collectCandidates(el, keywords);
      }

      if (selectorBest.size === 0) {
        sendResponse({ type: 'dom_error', requestId: msg.requestId, message: `dom_find_and_execute: nenhum elemento encontrado para [${keywords.join(', ')}]` });
        return true;
      }

      const sorted = Array.from(selectorBest.values()).sort((a, b) => b.score - a.score);
      const best = sorted[0].el;

      // Resolve the element robustly — positional CSS selectors become stale on virtual-scroll
      // pages (YouTube, TikTok) the moment the DOM is touched. Prefer stable identifiers.
      let el = null;
      if (best.href && best.tag === 'a') {
        // Exact href match is the most reliable anchor for <a> elements on YouTube/Google
        el = document.querySelector(`a[href="${CSS.escape(best.href)}"]`)
          || document.querySelector(`a[href*="${best.href.split('?')[0]}"]`);
      }
      if (!el && best.id) {
        el = document.getElementById(best.id);
      }
      if (!el) {
        el = document.querySelector(best.selector);
      }
      if (!el) {
        sendResponse({ type: 'dom_error', requestId: msg.requestId, message: `dom_find_and_execute: elemento não encontrado para [${keywords.join(', ')}]` });
        return true;
      }
      // Debug info before acting
      const elText = (el.getAttribute('aria-label') || el.textContent?.trim() || '').replace(/\s+/g, ' ').slice(0, 120);
      const elHref = el.getAttribute('href') ?? '';
      const inputTypeForState = el.tagName.toLowerCase() === 'input' ? (el.getAttribute('type') ?? '').toLowerCase() : null;
      const wasChecked = inputTypeForState === 'checkbox' ? !!el.checked : undefined;

      console.log(`[dom-find-execute] tag=${el.tagName.toLowerCase()} text="${elText}" href="${elHref}"`);

      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (action.kind === 'click') {
        const vis = findVisualControlForInput(el) || el;
        if (vis && vis.tagName && vis.tagName.toLowerCase() === 'label') {
          vis.click();
        } else {
          simulatePointerAndMouseClick(vis);
        }
      } else {
        executeAction(best.selector, action);
      }

      // allow page JS to run and update state, then send debug info back
      setTimeout(() => {
        try {
          const nowChecked = inputTypeForState === 'checkbox' ? !!(document.querySelector(best.selector)?.checked) : undefined;
          window.__lastClickDebug = { resolvedBy: 'dom_find_and_execute', tag: el.tagName.toLowerCase(), text: elText, href: elHref, selector: best.selector, wasChecked, nowChecked, labelClicked: false, timestamp: Date.now() };
          sendResponse({ type: 'dom_result', requestId: msg.requestId, elements: [best], clickDebug: window.__lastClickDebug });
        } catch (e) {
          sendResponse({ type: 'dom_result', requestId: msg.requestId, elements: [best], clickDebug: window.__lastClickDebug ?? null });
        }
      }, 120);
    }
  } catch (err) {
    sendResponse({ type: 'dom_error', requestId: msg.requestId, message: err.message });
  }
  return true; // keep channel open for async
};

chrome.runtime.onMessage.addListener(window.__aiAssistantMsgHandler);
