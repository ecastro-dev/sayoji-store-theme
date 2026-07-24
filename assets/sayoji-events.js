/*
  sayoji-events.js — A-061 event-readiness shim (R-11 payload shape, no destination).

  Builds the emission POINTS with the correct payload shape so R-11 is a wiring
  step, not a rebuild. It pushes to window.dataLayer AND dispatches a DOM
  CustomEvent (`sayoji:<event>`) that R-11's Shopify Customer-Events / Web-Pixel
  → GA4 forwarder can subscribe to.

  ⚠️ OUT OF SCOPE here (R-11 / R-12, gated on A-055): the GA4 destination and the
  consent gate. This shim fires locally only — it wires no analytics/ads endpoint,
  so it is not consent-gated by itself. Do NOT point it at a real pixel here.

  The two attach-attribution dims the whole read depends on — `source_module` and
  `is_second_item` — are computed here from the live cart.
*/
(function () {
  window.dataLayer = window.dataLayer || [];
  var S = (window.Sayoji = window.Sayoji || {});

  S.pushEvent = function (payload) {
    var evt = Object.assign({ _sayoji: true, ts: Date.now() }, payload);
    window.dataLayer.push(evt);
    try {
      document.dispatchEvent(new CustomEvent('sayoji:' + payload.event, { detail: evt }));
    } catch (e) {}
    return evt;
  };

  // add_to_cart carrying the attach dims (R-11). `is_second_item` = there was
  // already ≥1 item in the cart before this add; `cart_item_count_after` /
  // `cart_value_after` reflect the post-add state.
  S.trackAddToCart = function (opts) {
    opts = opts || {};
    var base = {
      event: 'add_to_cart',
      source_module: opts.source_module || null,
      design_id: opts.design_id || null,
      product_type: opts.product_type || null,
      variant_id: opts.variant_id || null
    };
    return fetch('/cart.js', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (cart) {
        var countBefore = (cart && cart.item_count) || 0;
        return S.pushEvent(
          Object.assign(base, {
            is_second_item: countBefore >= 1,
            cart_item_count_after: countBefore + 1,
            cart_value_after: ((cart && cart.total_price) || 0) + (opts.price || 0)
          })
        );
      })
      .catch(function () {
        return S.pushEvent(
          Object.assign(base, {
            is_second_item: null,
            cart_item_count_after: null,
            cart_value_after: null
          })
        );
      });
  };

  S.trackSpecExpand = function (opts) {
    opts = opts || {};
    return S.pushEvent({ event: 'spec_block_expand', design_id: opts.design_id || null });
  };

  S.trackSizeGuideOpen = function (opts) {
    opts = opts || {};
    return S.pushEvent({ event: 'size_guide_open', design_id: opts.design_id || null });
  };
})();
