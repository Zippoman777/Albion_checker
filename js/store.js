/* ==========================================================================
   store.js — user settings (localStorage) + price cache (IndexedDB, with a
   localStorage fallback so the app still works when IDB is unavailable).
   ========================================================================== */
(function (AO) {
  'use strict';

  var SETTINGS_KEY = 'ao-profit-settings-v1';
  var DB_NAME = 'ao-profit-cache';
  var DB_STORE = 'prices';
  var DB_VERSION = 1;

  /* -------------------------------------------------------------- settings */

  function defaultSettings() {
    var stationTax = Object.assign({}, AO.DEFAULT_STATION_TAX);
    var craftMastery = {};
    ['PLATE', 'LEATHER_ARMOR', 'CLOTH_ARMOR', 'MELEE', 'RANGED', 'MAGIC',
      'OFFHAND', 'TOOL', 'FOOD', 'POTION'].forEach(function (c) {
        craftMastery[c] = 50;
      });
    var refineMastery = {};
    Object.keys(AO.REFINE_BONUS_CITY).forEach(function (f) { refineMastery[f] = 50; });

    return {
      premium: true,
      useFocusCrafting: true,
      useFocusRefining: true,
      dailyFocus: 10000,
      craftMastery: craftMastery,
      refineMastery: refineMastery,
      stationTax: stationTax,
      rrr: Object.assign({}, AO.DEFAULT_RRR),
      premiumRrrBonus: AO.DEFAULT_PREMIUM_RRR_BONUS,
      setupFee: AO.DEFAULT_TAXES.setupFeePremium,
      salesFee: AO.DEFAULT_TAXES.salesFeePremium,
      minProfit: 0,
      includeBlackMarket: true,
      includeBrecilien: true,
      qualityMode: 'average',        // 'average' | 'detailed'
      transportCost: 500,            // silver per item moved
      maxDataAgeMinutes: 240,        // ignore quotes older than this
      outlierFactor: 5,              // reject prices > N× the cross-city median
      useSellOrdersForMaterials: true, // buy instantly off sell orders
      useBuyOrdersForSales: false,    // sell instantly into buy orders
      recipeOverrides: {},
      priceOverrides: {},           // itemId -> { buy, sell } manual prices
      fishSauce: false,
      fishSaucePrice: 2000,
      cacheTtlMinutes: 15
    };
  }

  var Settings = AO.Settings = {
    data: defaultSettings(),

    load: function () {
      try {
        var raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) {
          var parsed = JSON.parse(raw);
          this.data = deepMerge(defaultSettings(), parsed);
        }
      } catch (e) {
        console.warn('Settings load failed, using defaults', e);
        this.data = defaultSettings();
      }
      return this.data;
    },

    save: function () {
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.data));
      } catch (e) {
        console.warn('Settings save failed', e);
      }
    },

    reset: function () {
      this.data = defaultSettings();
      this.save();
      return this.data;
    },

    get: function (path, fallback) {
      var parts = path.split('.');
      var cur = this.data;
      for (var i = 0; i < parts.length; i++) {
        if (cur == null) return fallback;
        cur = cur[parts[i]];
      }
      return cur === undefined ? fallback : cur;
    },

    set: function (path, value) {
      var parts = path.split('.');
      var cur = this.data;
      for (var i = 0; i < parts.length - 1; i++) {
        if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = value;
      this.save();
    },

    /** Cities included in calculations given the Brecilien toggle. */
    activeCities: function () {
      return AO.CITIES.filter(function (c) {
        return c !== 'Brecilien' || Settings.data.includeBrecilien;
      });
    },

    /** Cities to request from the API, including Black Market when enabled. */
    queryLocations: function () {
      var list = this.activeCities().slice();
      if (this.data.includeBlackMarket) list.push(AO.BLACK_MARKET);
      return list;
    }
  };

  function deepMerge(base, patch) {
    Object.keys(patch || {}).forEach(function (k) {
      var v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v) &&
          base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
        deepMerge(base[k], v);
      } else if (v !== undefined) {
        base[k] = v;
      }
    });
    return base;
  }

  /* ----------------------------------------------------------- price cache */

  var Cache = AO.Cache = {
    _db: null,
    _memory: Object.create(null),

    open: function () {
      var self = this;
      if (this._dbPromise) return this._dbPromise;
      this._dbPromise = new Promise(function (resolve) {
        if (!window.indexedDB) return resolve(null);
        var req;
        try {
          req = indexedDB.open(DB_NAME, DB_VERSION);
        } catch (e) {
          return resolve(null);
        }
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(DB_STORE)) {
            db.createObjectStore(DB_STORE, { keyPath: 'key' });
          }
        };
        req.onsuccess = function () { self._db = req.result; resolve(req.result); };
        req.onerror = function () { resolve(null); };
      });
      return this._dbPromise;
    },

    /** Returns the cached record, or null when missing / expired. */
    get: function (key, ttlMs) {
      var self = this;
      return this.open().then(function (db) {
        var rec = self._memory[key];
        if (rec) return valid(rec) ? rec : null;
        if (!db) {
          try {
            var raw = localStorage.getItem('aocache:' + key);
            rec = raw ? JSON.parse(raw) : null;
          } catch (e) { rec = null; }
          return valid(rec) ? rec : null;
        }
        return new Promise(function (resolve) {
          var tx = db.transaction(DB_STORE, 'readonly');
          var req = tx.objectStore(DB_STORE).get(key);
          req.onsuccess = function () {
            var r = req.result;
            if (r) self._memory[key] = r;
            resolve(valid(r) ? r : null);
          };
          req.onerror = function () { resolve(null); };
        });
      });

      function valid(rec) {
        return rec && (ttlMs == null || (Date.now() - rec.storedAt) < ttlMs);
      }
    },

    put: function (key, value) {
      var self = this;
      var rec = { key: key, value: value, storedAt: Date.now() };
      this._memory[key] = rec;
      return this.open().then(function (db) {
        if (!db) {
          try { localStorage.setItem('aocache:' + key, JSON.stringify(rec)); } catch (e) { /* quota */ }
          return;
        }
        return new Promise(function (resolve) {
          var tx = db.transaction(DB_STORE, 'readwrite');
          tx.objectStore(DB_STORE).put(rec);
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { resolve(); };
        });
      });
    },

    clear: function () {
      var self = this;
      this._memory = Object.create(null);
      Object.keys(localStorage).forEach(function (k) {
        if (k.indexOf('aocache:') === 0) localStorage.removeItem(k);
      });
      return this.open().then(function (db) {
        if (!db) return;
        return new Promise(function (resolve) {
          var tx = db.transaction(DB_STORE, 'readwrite');
          tx.objectStore(DB_STORE).clear();
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { resolve(); };
        });
      });
    }
  };

}(window.AO = window.AO || {}));
