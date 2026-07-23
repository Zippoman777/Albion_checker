/* ==========================================================================
   api.js — Albion Online Data Project client.

   Responsibilities:
     * batch item ids into URL-length-safe chunks
     * throttle + retry with backoff so we stay inside the public rate limit
     * cache every response through AO.Cache
     * normalise quotes into a lookup: prices[itemId][city] = quote
   ========================================================================== */
(function (AO) {
  'use strict';

  var Api = AO.Api = {};

  // The public API allows ~180 req/min and 300 req/5min. We stay well under.
  var MIN_INTERVAL_MS = 400;
  var MAX_URL_LENGTH = 3500;
  var MAX_RETRIES = 3;

  var queue = Promise.resolve();
  var lastCallAt = 0;

  Api.stats = { requests: 0, cacheHits: 0, errors: 0, rateLimited: 0 };

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /** Serialises every network call and enforces a minimum spacing. */
  function throttled(fn) {
    var run = queue.then(function () {
      var wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastCallAt));
      return sleep(wait).then(function () {
        lastCallAt = Date.now();
        return fn();
      });
    });
    // Keep the chain alive even if this call rejects.
    queue = run.catch(function () {});
    return run;
  }

  function fetchJson(url, attempt) {
    attempt = attempt || 0;
    return throttled(function () {
      Api.stats.requests++;
      return fetch(url, { headers: { 'Accept': 'application/json' } });
    }).then(function (res) {
      if (res.status === 429 || res.status === 503) {
        Api.stats.rateLimited++;
        if (attempt < MAX_RETRIES) {
          var backoff = Math.pow(2, attempt) * 1500;
          return sleep(backoff).then(function () { return fetchJson(url, attempt + 1); });
        }
        throw new Error('Rate limited by the Albion Data API. Try again in a minute.');
      }
      if (!res.ok) throw new Error('API returned HTTP ' + res.status);
      return res.json();
    }).catch(function (err) {
      if (attempt < MAX_RETRIES && /NetworkError|Failed to fetch/i.test(err.message || '')) {
        return sleep(1000 * (attempt + 1)).then(function () { return fetchJson(url, attempt + 1); });
      }
      Api.stats.errors++;
      throw err;
    });
  }

  /** Split ids so each generated URL stays comfortably short. */
  function chunkIds(ids, baseLength) {
    var chunks = [];
    var current = [];
    var len = baseLength;
    ids.forEach(function (id) {
      var add = encodeURIComponent(id).length + 1;
      if (current.length && len + add > MAX_URL_LENGTH) {
        chunks.push(current);
        current = [];
        len = baseLength;
      }
      current.push(id);
      len += add;
    });
    if (current.length) chunks.push(current);
    return chunks;
  }

  /**
   * Fetch current prices.
   * @param {string[]} itemIds
   * @param {string[]} locations
   * @param {object}   opts { onProgress(done,total), force }
   * @returns {Promise<{prices:Object, fetchedAt:number, partial:boolean}>}
   */
  Api.getPrices = function (itemIds, locations, opts) {
    opts = opts || {};
    var ttl = (AO.Settings.get('cacheTtlMinutes', 15)) * 60 * 1000;
    var locParam = locations.map(function (l) { return AO.LOCATION_QUERY[l] || l; }).join(',');
    var base = AO.API_BASE + '/api/v2/stats/prices/';
    var suffix = '.json?locations=' + encodeURIComponent(locParam) + '&qualities=1';
    var baseLen = base.length + suffix.length;

    var unique = dedupe(itemIds);
    var chunks = chunkIds(unique, baseLen);
    var prices = Object.create(null);
    var done = 0;
    var partial = false;

    return chunks.reduce(function (chain, chunk) {
      return chain.then(function () {
        var url = base + chunk.map(encodeURIComponent).join(',') + suffix;
        var cacheKey = 'prices:' + hash(url);

        var source = opts.force
          ? Promise.resolve(null)
          : AO.Cache.get(cacheKey, ttl);

        return source.then(function (cached) {
          if (cached) {
            Api.stats.cacheHits++;
            return cached.value;
          }
          return fetchJson(url).then(function (data) {
            AO.Cache.put(cacheKey, data);
            return data;
          });
        }).then(function (rows) {
          ingest(prices, rows);
        }).catch(function (err) {
          partial = true;
          console.warn('Price chunk failed:', err.message);
          // Fall back to whatever stale copy we still have on disk.
          return AO.Cache.get('prices:' + hash(url), null).then(function (stale) {
            if (stale) ingest(prices, stale.value);
          });
        }).then(function () {
          done++;
          if (opts.onProgress) opts.onProgress(done, chunks.length);
        });
      });
    }, Promise.resolve()).then(function () {
      return { prices: prices, fetchedAt: Date.now(), partial: partial, chunks: chunks.length };
    });
  };

  function ingest(prices, rows) {
    if (!Array.isArray(rows)) return;
    rows.forEach(function (row) {
      var id = row.item_id;
      if (!id) return;
      if (!prices[id]) prices[id] = Object.create(null);
      var city = row.city;
      var existing = prices[id][city];
      var quote = {
        city: city,
        sellMin: row.sell_price_min || 0,
        sellMax: row.sell_price_max || 0,
        buyMax: row.buy_price_max || 0,
        buyMin: row.buy_price_min || 0,
        sellAt: row.sell_price_min_date,
        buyAt: row.buy_price_max_date,
        quality: row.quality
      };
      // Keep the freshest/most-populated quote when several qualities come back.
      if (!existing || (!existing.sellMin && quote.sellMin)) prices[id][city] = quote;
    });
  }

  /**
   * Price history for one item. Used by the Black Market demand trend.
   * @returns {Promise<Array>} raw chart rows
   */
  Api.getHistory = function (itemId, locations, daysBack) {
    daysBack = daysBack || 7;
    var since = new Date(Date.now() - daysBack * 86400000);
    var date = (since.getUTCMonth() + 1) + '-' + since.getUTCDate() + '-' + since.getUTCFullYear();
    var locParam = locations.map(function (l) { return AO.LOCATION_QUERY[l] || l; }).join(',');
    var url = AO.API_BASE + '/api/v2/stats/charts/' + encodeURIComponent(itemId) +
      '.json?date=' + date + '&locations=' + encodeURIComponent(locParam) +
      '&qualities=1&time-scale=24';
    var cacheKey = 'chart:' + hash(url);
    return AO.Cache.get(cacheKey, 60 * 60 * 1000).then(function (cached) {
      if (cached) { Api.stats.cacheHits++; return cached.value; }
      return fetchJson(url).then(function (data) {
        AO.Cache.put(cacheKey, data);
        return data;
      });
    });
  };

  /** The item name dump, cached for a week. */
  Api.getItemNames = function () {
    return AO.Cache.get('itemnames', 7 * 86400000).then(function (cached) {
      if (cached) return cached.value;
      return tryUrls(AO.ITEM_DUMP_URLS.slice()).then(function (list) {
        var map = Object.create(null);
        (list || []).forEach(function (it) {
          var id = it.UniqueName || it.uniquename;
          if (!id) return;
          var loc = it.LocalizedNames || it.localizedNames;
          map[id] = (loc && (loc['EN-US'] || loc['en-US'])) || id;
        });
        AO.Cache.put('itemnames', map);
        return map;
      }).catch(function (err) {
        console.warn('Item name dump unavailable:', err.message);
        return Object.create(null);
      });
    });
  };

  function tryUrls(urls) {
    if (!urls.length) return Promise.reject(new Error('no item dump reachable'));
    return fetch(urls[0]).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).catch(function () {
      return tryUrls(urls.slice(1));
    });
  }

  /* ----------------------------------------------------------- black market */

  /**
   * Estimate Black Market demand direction from the last week of chart data.
   * Returns { trend: 'rising'|'falling'|'stable', changePct }.
   */
  Api.blackMarketTrend = function (itemId) {
    return Api.getHistory(itemId, [AO.BLACK_MARKET], 7).then(function (rows) {
      var series = null;
      (rows || []).forEach(function (r) {
        if (r.data && r.data.prices_avg && r.data.prices_avg.length >= 2) series = r.data.prices_avg;
      });
      if (!series) return { trend: 'unknown', changePct: null };
      var half = Math.floor(series.length / 2);
      var older = avg(series.slice(0, half));
      var newer = avg(series.slice(half));
      if (!older) return { trend: 'unknown', changePct: null };
      var pct = ((newer - older) / older) * 100;
      var trend = pct > 3 ? 'rising' : (pct < -3 ? 'falling' : 'stable');
      return { trend: trend, changePct: pct };
    }).catch(function () {
      return { trend: 'unknown', changePct: null };
    });
  };

  function avg(a) {
    if (!a.length) return 0;
    return a.reduce(function (s, v) { return s + v; }, 0) / a.length;
  }

  /* ----------------------------------------------------------------- utils */

  function dedupe(arr) {
    var seen = Object.create(null);
    var out = [];
    arr.forEach(function (v) { if (!seen[v]) { seen[v] = 1; out.push(v); } });
    return out;
  }

  function hash(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  Api.hash = hash;

}(window.AO = window.AO || {}));
