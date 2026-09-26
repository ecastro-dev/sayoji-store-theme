/*
  sayoji-events.js — R-11 storefront event emission (POD-001, A-011).

  Supersedes the A-061 shim, which emitted 3 of the 8 §3.5 events to window.dataLayer and a DOM
  CustomEvent only, with no destination and no common dimensions.

  ── The bridge (R-11.1) ──────────────────────────────────────────────────────────────────────
  A Shopify web pixel runs in a SANDBOXED frame and cannot see this page's `document`. So the DOM
  CustomEvent the A-061 shim dispatched could never have reached the pixel. The supported bridge is
  `Shopify.analytics.publish(name, data)` from the main frame → `analytics.subscribe(name, cb)` inside
  the pixel. That is what emit() uses. The dataLayer push and the DOM CustomEvent are kept as-is:
  they are what the local acceptance harnesses assert against, and they cost nothing.

  ── Division of labour ───────────────────────────────────────────────────────────────────────
  This file owns every event that needs storefront knowledge the pixel does not have — design_id,
  product_type, the attach dims, page_type. The pixel owns `begin_checkout` and `purchase`, which
  happen on Shopify-hosted checkout pages where no theme code runs.

  ── Common dimensions (R-11.3) ───────────────────────────────────────────────────────────────
  `design_id`, `product_type`, `cohort`, `entry_url` ride EVERY event. cohort + entry_url are captured
  once at session entry and persisted in sessionStorage AND a first-party cookie — the cookie is how
  the pixel reads them during checkout, via its `browser.cookie` API.

  ⚠️ No analytics endpoint is contacted from this file. It publishes into Shopify's event bus; the
  consent gate (R-12) lives in the pixel, which is the only thing that talks to GA4.
*/
(function () {
  var CTX_KEY = 'sayoji_ctx';
  var COOKIE_MAX_AGE = 60 * 60 * 24; // 1 day — a session context, not a durable identifier.

  window.dataLayer = window.dataLayer || [];
  var S = (window.Sayoji = window.Sayoji || {});

  // ---------------------------------------------------------------- session context (cohort/entry)

  function readCookie(name) {
    var m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
    return m ? decodeURIComponent(m.pop()) : null;
  }

  function writeCookie(name, value) {
    document.cookie =
      name + '=' + encodeURIComponent(value) + ';path=/;max-age=' + COOKIE_MAX_AGE + ';SameSite=Lax';
  }

  // cohort is derived from the landing UTM and pinned for the session (§3.5). An explicit
  // `?cohort=` wins, so A-013's ad URLs can name the cohort outright rather than rely on inference.
  function deriveCohort(qs) {
    var explicit = qs.get('cohort');
    if (explicit) return explicit.toLowerCase();
    var medium = (qs.get('utm_medium') || '').toLowerCase();
    var source = (qs.get('utm_source') || '').toLowerCase();
    if (/cpc|ppc|paid|paidsocial|paid_social|display|retargeting/.test(medium)) return 'paid';
    if (/facebook|meta|instagram|^fb$|^ig$/.test(source)) return 'paid';
    if (medium) return medium; // e.g. email, referral — carried verbatim rather than guessed at
    if (source) return source;
    if (!document.referrer) return 'direct';
    try {
      if (new URL(document.referrer).host === window.location.host) return 'direct';
    } catch (e) {}
    return 'organic';
  }

  function initContext() {
    var stored = null;
    try {
      stored = sessionStorage.getItem(CTX_KEY);
    } catch (e) {}
    if (!stored) stored = readCookie(CTX_KEY);

    if (stored) {
      try {
        var parsed = JSON.parse(stored);
        if (parsed && parsed.cohort) {
          // Re-assert the cookie so it survives into checkout even if it was near expiry.
          writeCookie(CTX_KEY, stored);
          return parsed;
        }
      } catch (e) {}
    }

    var qs = new URLSearchParams(window.location.search);
    var ctx = {
      cohort: deriveCohort(qs),
      // entry_url is the URL the session landed on, query string included — it is what ties a
      // session back to the ad that bought it. Trimmed: GA4 truncates params at 100 chars.
      entry_url: (window.location.pathname + window.location.search).slice(0, 100),
    };
    var json = JSON.stringify(ctx);
    try {
      sessionStorage.setItem(CTX_KEY, json);
    } catch (e) {}
    writeCookie(CTX_KEY, json);
    return ctx;
  }

  var CTX = initContext();
  S.context = CTX;

  // ---------------------------------------------------------------------------------- page facts

  // Set by theme.liquid from Liquid — the only place design_id / product_type / page_type are known.
  function page() {
    return window.SayojiPage || {};
  }

  function common(overrides) {
    var p = page();
    var out = {
      design_id: (overrides && overrides.design_id) || p.design_id || null,
      product_type: (overrides && overrides.product_type) || p.product_type || null,
      cohort: CTX.cohort,
      entry_url: CTX.entry_url,
    };
    return out;
  }
  S.common = common;

  // --------------------------------------------------------------------------------------- emit

  S.emit = function (name, params, overrides) {
    var payload = Object.assign({ event: name, _sayoji: true, ts: Date.now() }, common(overrides), params || {});
    window.dataLayer.push(payload);
    try {
      document.dispatchEvent(new CustomEvent('sayoji:' + name, { detail: payload }));
    } catch (e) {}
    // The bridge to the pixel. Custom events must be namespaced (Shopify reserves bare standard names).
    try {
      if (window.Shopify && Shopify.analytics && typeof Shopify.analytics.publish === 'function') {
        Shopify.analytics.publish('sayoji:' + name, payload);
      }
    } catch (e) {}
    return payload;
  };

  // Kept for source compatibility with the A-061 call sites.
  S.pushEvent = function (payload) {
    var name = payload.event;
    var rest = Object.assign({}, payload);
    delete rest.event;
    return S.emit(name, rest);
  };

  // ------------------------------------------------------------------------------ cart helpers

  function getCart() {
    return fetch('/cart.js', { headers: { Accept: 'application/json' } }).then(function (r) {
      return r.json();
    });
  }

  /*
    Cached pre-add cart state.

    `is_second_item` must describe the cart as it was BEFORE the add. Reading /cart.js at add time
    looks obvious and is wrong: the add request (Dawn's <product-form>, or the attach module) is in
    flight concurrently, so the read can land after the write and report the item as already there —
    turning the session's first add into is_second_item:true. Instead the count is cached on load and
    advanced locally on each add, so the before-state is never a race. It is re-synced from /cart.js
    after every add and whenever the cart surface is opened.
  */
  var CART = { item_count: 0, total_price: 0, ready: false };

  function syncCart() {
    return getCart()
      .then(function (cart) {
        CART = { item_count: cart.item_count || 0, total_price: cart.total_price || 0, ready: true };
        return cart;
      })
      .catch(function () {
        return null;
      });
  }

  // cart_composition is the ordered list of design_ids in the cart (§3.5). R2-10: the design comes from
  // custom.design_id via SayojiPage.designs (theme.liquid). A product without one falls back to its handle so
  // the field is never silently empty; R2-03's G5 checklist keeps that from happening on a live product.
  function composition(cart) {
    var designs = page().designs || {};
    return (cart.items || [])
      .map(function (i) {
        return designs[i.product_id] || (i.properties && i.properties._design_id) || i.handle || String(i.product_id);
      })
      .join('|');
  }

  // --------------------------------------------------------------------------------- §3.5 events

  S.trackPageView = function () {
    return S.emit('page_view', { page_type: page().page_type || null });
  };

  S.trackViewItem = function (opts) {
    opts = opts || {};
    return S.emit('view_item', {
      variant_size: opts.variant_size || null,
      price: typeof opts.price === 'number' ? opts.price / 100 : null,
    });
  };

  /*
    add_to_cart — the load-bearing one (§3.5, G4/G5).

    `is_second_item` = the cart already held ≥1 item before this add. `cart_*_after` reflect the
    post-add state. Both are read from the live cart rather than inferred, and the event is published
    BEFORE the caller navigates (see pdp-attach-module.liquid, which now adds via AJAX for exactly
    this reason — a form POST used to race the event to /cart and could lose it).
  */
  S.trackAddToCart = function (opts) {
    opts = opts || {};
    var base = {
      source_module: opts.source_module || null,
      variant_id: opts.variant_id || null,
      variant_size: opts.variant_size || null,
    };
    var overrides = { design_id: opts.design_id || null, product_type: opts.product_type || null };

    var qty = opts.quantity || 1;
    var countBefore = CART.item_count;
    var valueBefore = CART.total_price;

    // Emitted SYNCHRONOUSLY — no await between the click and the publish, so a navigation that
    // follows the add cannot outrun the event.
    var payload = S.emit(
      'add_to_cart',
      Object.assign(base, {
        is_second_item: countBefore >= 1,
        cart_item_count_after: countBefore + qty,
        cart_value_after: (valueBefore + (opts.price || 0) * qty) / 100,
      }),
      overrides
    );

    // Advance the local cache immediately (a second add in the same page view must see the first),
    // then re-sync against the server once the add has settled.
    CART = { item_count: countBefore + qty, total_price: valueBefore + (opts.price || 0) * qty, ready: true };
    setTimeout(syncCart, 1200);

    return payload;
  };

  S.trackViewCart = function () {
    return getCart()
      .then(function (cart) {
        return S.emit('view_cart', {
          cart_item_count: cart.item_count,
          cart_value: (cart.total_price || 0) / 100,
          cart_composition: composition(cart),
        });
      })
      .catch(function () {
        return S.emit('view_cart', { cart_item_count: null, cart_value: null, cart_composition: null });
      });
  };

  S.trackSpecExpand = function (opts) {
    opts = opts || {};
    return S.emit('spec_block_expand', {}, { design_id: opts.design_id || null });
  };

  S.trackSizeGuideOpen = function (opts) {
    opts = opts || {};
    return S.emit('size_guide_open', {}, { design_id: opts.design_id || null });
  };

  // ------------------------------------------------------------------------------- auto-wiring

  function boot() {
    var p = page();

    syncCart();
    S.trackPageView();

    if (p.page_type === 'product') {
      S.trackViewItem({ price: p.price, variant_size: p.variant_size });
    }

    if (p.page_type === 'cart') {
      S.trackViewCart();
    }

    // The cart DRAWER is the store's cart surface (settings.cart_type = drawer), so `view_cart`
    // must also fire when the drawer opens — otherwise the funnel loses its cart step entirely
    // for every visitor who never walks to /cart.
    document.addEventListener('click', function (e) {
      var t = e.target.closest && e.target.closest('[id="cart-icon-bubble"], .cart-drawer__opener');
      if (t) {
        setOrigin('shopper'); // R2-09: a drawer the shopper opens is surface (3), cart_crosssell
        setTimeout(S.trackViewCart, 300);
      }
    });

    /*
      R2-09 attach adds (every surface). Delegated at the document, capture phase, because the drawer
      re-renders by innerHTML and inline <script> in re-rendered markup never runs: a per-module binding
      left drawer attach rows posting natively with NO add_to_cart event. Emit first (trackAddToCart is
      synchronous and reads the count cached before this add), add via AJAX, then go to /cart.
      source_module: in a drawer that opened automatically after a PDP add (data-open-origin="pdp_add")
      the row is the post-ATC state -> pdp_crosssell; a drawer the shopper opened, or the cart page ->
      the module's own value (cart_crosssell); on the PDP -> pdp_crosssell.
    */
    document.addEventListener(
      'submit',
      function (e) {
        var form = e.target;
        if (!form || !form.matches || !form.matches('[data-sayoji-attach-form]')) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (form.dataset.sayojiBusy) return;
        form.dataset.sayojiBusy = '1';
        var root = form.closest('[data-sayoji-attach]');
        var row = form.closest('[data-sayoji-attach-row]');
        var drawer = form.closest('cart-drawer');
        var sourceModule = root && root.dataset.sourceModule;
        if (drawer) sourceModule = drawer.dataset.openOrigin === 'pdp_add' ? 'pdp_crosssell' : 'cart_crosssell';
        var idEl = form.querySelector('[name="id"]');
        var button = form.querySelector('[type="submit"]');
        if (button) button.setAttribute('aria-disabled', 'true');
        S.trackAddToCart({
          source_module: sourceModule || null,
          design_id: (row && row.dataset.designId) || null,
          product_type: (row && row.dataset.productType) || null,
          variant_id: idEl ? idEl.value : null,
          price: (row && parseInt(row.dataset.price, 10)) || 0,
        });
        fetch('/cart/add.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ items: [{ id: idEl ? idEl.value : null, quantity: 1 }] }),
        }).finally(function () {
          window.location.href = '/cart';
        });
      },
      true
    );

    // Main PDP add-to-cart. Dawn's <product-form> submits via AJAX (cart drawer), so there is no
    // navigation to race. Only the ATTACH adds were instrumented before this — which meant the
    // FIRST add of every session, the one that sets is_second_item:false, was never emitted.
    document.addEventListener(
      'submit',
      function (e) {
        var form = e.target;
        if (!form || !form.action || form.action.indexOf('/cart/add') === -1) return;
        if (form.closest('[data-sayoji-attach]')) return; // attach module emits its own, with its source_module
        setOrigin('pdp_add'); // R2-09: the drawer this add opens is the post-ATC state
        var idEl = form.querySelector('[name="id"]');
        var qtyEl = form.querySelector('[name="quantity"]');
        S.trackAddToCart({
          source_module: 'pdp_main',
          design_id: p.design_id,
          product_type: p.product_type,
          variant_id: idEl ? idEl.value : null,
          quantity: qtyEl ? parseInt(qtyEl.value, 10) || 1 : 1,
          price: p.price || 0,
          variant_size: p.variant_size || null,
        });
      },
      true
    );
  }

  // R2-09: record how the cart drawer was opened, on the drawer itself.
  function setOrigin(origin) {
    var d = document.querySelector('cart-drawer');
    if (d) d.dataset.openOrigin = origin;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
