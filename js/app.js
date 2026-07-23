/* ==========================================================================
   app.js — application controller: data loading, tab wiring, rendering.
   ========================================================================== */
(function (AO) {
  'use strict';

  var App = AO.App = {
    prices: Object.create(null),
    fetchedAt: null,
    partial: false,
    tables: Object.create(null),
    // Shared row-expansion maps so an expanded detail survives a re-render
    // (e.g. after editing a manual price inside it).
    expandedState: { crafting: {}, refining: {}, cooking: {}, transport: {}, focus: {} },
    recipes: { crafting: [], refining: [], cooking: [] },
    results: { crafting: [], refining: [], cooking: [], transport: [], focus: [], journals: [] },
    loading: false,
    lastError: null
  };

  /* ------------------------------------------------- derived runtime settings */

  /**
   * Settings.data is the persisted shape; the calculators want a flattened
   * object with the active city list and a couple of helpers resolved.
   */
  AO.runtimeSettings = function () {
    var s = AO.Settings.data;
    var rt = Object.assign({}, s);
    rt.activeCities = AO.Settings.activeCities();
    rt.setupFee = s.premium
      ? Math.min(s.setupFee, AO.DEFAULT_TAXES.setupFeePremium)
      : Math.max(s.setupFee, AO.DEFAULT_TAXES.setupFeeNormal);
    rt.salesFee = s.salesFee;
    // Only crafted equipment rolls quality; refined resources and food do not.
    rt.qualityAppliesTo = function (recipe) { return recipe.kind === 'crafting'; };
    return rt;
  };

  /* ------------------------------------------------------------ data loading */

  App.buildRecipes = function () {
    var overrides = AO.Settings.data.recipeOverrides;
    var R = AO.Recipes;
    this.recipes.crafting = R.applyOverrides(R.buildCrafting(), overrides);
    this.recipes.refining = R.applyOverrides(R.buildRefining(), overrides);

    // Fish sauce is modelled as a real ingredient producing the `_FISH` product
    // variant, so its cost and the higher sale price both come from the market.
    this.recipes.cooking = R.applyOverrides(
      R.buildCooking(AO.Settings.data.fishSauce), overrides);
  };

  App.allItemIds = function () {
    var R = AO.Recipes;
    var all = R.itemIdsFor(this.recipes.crafting)
      .concat(R.itemIdsFor(this.recipes.refining))
      .concat(R.itemIdsFor(this.recipes.cooking));
    Object.keys(AO.Calc.JOURNAL).forEach(function (t) {
      all.push(AO.Calc.JOURNAL[t].buy, AO.Calc.JOURNAL[t].sell);
    });
    return all;
  };

  App.load = function (force) {
    var self = this;
    if (this.loading) return Promise.resolve();
    this.loading = true;
    this.lastError = null;
    this.buildRecipes();
    this.renderHeader();
    showLoadingInTabs();

    var ids = this.allItemIds();
    var locations = AO.Settings.queryLocations();

    return AO.Api.getItemNames().then(function (names) {
      AO.itemNames = names;
      return AO.Api.getPrices(ids, locations, {
        force: force,
        onProgress: function (done, total) {
          setProgress(done, total);
        }
      });
    }).then(function (res) {
      self.prices = res.prices;
      self.fetchedAt = res.fetchedAt;
      self.partial = res.partial;
      self.loading = false;
      AO.Calc.applyPriceOverrides(self.prices, AO.Settings.data.priceOverrides);
      self.recompute();
      self.renderHeader();
      self.renderAll();
      if (res.partial) {
        AO.UI.toast('Some price batches failed — showing partial data', 'warn');
      }
    }).catch(function (err) {
      self.loading = false;
      self.lastError = err.message || String(err);
      self.renderHeader();
      showErrorInTabs(self.lastError);
    });
  };

  function setProgress(done, total) {
    var el = document.getElementById('load-progress');
    if (!el) return;
    var pct = total ? Math.round((done / total) * 100) : 0;
    el.style.width = pct + '%';
    el.parentNode.setAttribute('aria-valuenow', String(pct));
    var lbl = document.getElementById('load-label');
    if (lbl) lbl.textContent = 'Fetching prices… batch ' + done + ' / ' + total;
  }

  /* ------------------------------------------------------------- computation */

  /**
   * Re-apply manual price overrides and re-render everything, without a new
   * network fetch. Called when the user edits a "My price" value.
   */
  App.reapplyPrices = function () {
    if (!this.fetchedAt) return;
    AO.Calc.applyPriceOverrides(this.prices, AO.Settings.data.priceOverrides);
    this.recompute();
    this.renderAll();
    this.renderHeader();
  };

  App.recompute = function () {
    var s = AO.runtimeSettings();
    var C = AO.Calc;

    // Results are stored unfiltered so the summary cards can report honest
    // totals ("42 of 214 profitable"). The minimum-profit threshold is a
    // display filter, applied when rows reach a table.
    this.results.crafting = C.evaluateAll(this.recipes.crafting, this.prices, s);

    var refining = C.evaluateAll(this.recipes.refining, this.prices, s);
    refining.forEach(function (row) {
      var raw = C.rawSellAlternative(row.recipe, this.prices, s);
      row.rawSellValue = raw;
      row.refineAdvantage = raw == null ? null : (row.profit + row.materialCost) - raw;
    }, this);
    this.results.refining = refining;

    this.results.cooking = C.evaluateAll(this.recipes.cooking, this.prices, s);

    this.results.transport = C.transportOpportunities(this.allItemIds(), this.prices, s);

    this.results.focus = C.focusRanking(
      this.results.crafting.concat(this.results.refining, this.results.cooking), s);

    this.results.journals = C.journalProfit(this.prices, s);
  };

  /* ----------------------------------------------------------------- header */

  App.renderHeader = function () {
    var stamp = document.getElementById('last-update');
    var banner = document.getElementById('stale-banner');
    if (!stamp) return;

    if (this.loading) {
      stamp.innerHTML = '<span class="age fresh-unknown">updating…</span>';
    } else if (!this.fetchedAt) {
      stamp.innerHTML = '<span class="age fresh-unknown">no data yet</span>';
    } else {
      var mins = (Date.now() - this.fetchedAt) / 60000;
      stamp.innerHTML = 'Last full update: ' + AO.UI.ageBadge(mins);
    }

    document.getElementById('loading-bar').hidden = !this.loading;

    // Stale banner is driven by the age of the underlying quotes, not by when
    // we happened to call the API.
    var worst = this.worstQuoteAge();
    if (banner) {
      if (worst != null && worst > 120) {
        banner.hidden = false;
        banner.innerHTML = '⚠ Market data is stale — the freshest quotes in view are ' +
          AO.UI.age(worst) + '. Albion prices come from player-run data clients, so ' +
          'thin markets can lag badly. Treat these numbers as indicative.';
      } else {
        banner.hidden = true;
      }
    }

    var stats = document.getElementById('api-stats');
    if (stats) {
      var st = AO.Api.stats;
      stats.textContent = st.requests + ' requests · ' + st.cacheHits + ' cache hits' +
        (st.rateLimited ? ' · ' + st.rateLimited + ' rate-limited' : '') +
        (st.errors ? ' · ' + st.errors + ' errors' : '');
    }
  };

  App.worstQuoteAge = function () {
    var rows = this.results.crafting.concat(this.results.refining, this.results.cooking);
    if (!rows.length) return null;
    var ages = rows.map(function (r) { return r.dataAge; })
      .filter(function (a) { return a != null; });
    if (!ages.length) return null;
    ages.sort(function (a, b) { return a - b; });
    // Median age is a fairer signal than the single worst outlier.
    return ages[Math.floor(ages.length / 2)];
  };

  /* ------------------------------------------------------------ shared bits */

  function detailPanel(row) {
    var s = AO.runtimeSettings();
    var mats = row.materials.map(function (m) {
      var diff = m.localPrice == null ? null : (m.localPrice - m.bestPrice) * m.qty;
      return '<tr><td class="mat-name">' + AO.UI.icon(m.id, 24) + ' ' +
        AO.UI.escape(AO.UI.itemName(m.id)) + '</td>' +
        '<td class="align-right">×' + m.qty + '</td>' +
        '<td class="align-right">' + AO.UI.exact(m.bestPrice) + '</td>' +
        '<td>' + AO.UI.escape(m.bestCity) + '</td>' +
        '<td class="align-right">' + (m.localPrice == null ? '—' : AO.UI.exact(m.localPrice)) + '</td>' +
        '<td class="align-right">' + (diff == null ? '—' : AO.UI.silver(diff)) + '</td>' +
        '<td>' + AO.UI.ageBadge(m.ageMinutes) + '</td></tr>';
    }).join('');

    var qd = row.qualityDistribution;
    var qualityHtml = '';
    if (row.qualityMultiplier !== 1) {
      var detailed = AO.Settings.data.qualityMode === 'detailed';
      qualityHtml = '<div class="detail-block"><h4>Quality procs ' +
        '<span class="tip" title="Average multiplier = Σ (quality chance × value multiplier), ' +
        'driven by your mastery level for this tree.">?</span></h4>' +
        '<div>Average multiplier: <strong>' + row.qualityMultiplier.toFixed(3) + '×</strong> ' +
        '(+' + AO.UI.silver(row.qualityBonusValue) + ' expected value)</div>';
      if (detailed) {
        qualityHtml += '<div class="quality-bars">' + AO.QUALITY_NAMES.map(function (q) {
          var p = qd[q] * 100;
          return '<div class="qbar"><span class="qlabel">' + q + '</span>' +
            '<span class="qtrack"><span class="qfill" style="width:' + Math.min(100, p) + '%"></span></span>' +
            '<span class="qval">' + p.toFixed(1) + '%</span></div>';
        }).join('') + '</div>';
      } else {
        qualityHtml += '<div class="muted">' + AO.QUALITY_NAMES.map(function (q) {
          return q + ' ' + (qd[q] * 100).toFixed(1) + '%';
        }).join(' · ') + '</div>';
      }
      qualityHtml += '</div>';
    }

    var returnedUnits = row.materials.reduce(function (sum, m) { return sum + m.qty; }, 0) * row.rrr;

    var alts = (row.alternatives || []).map(function (a) {
      return '<tr' + (a.craftCity === row.craftCity ? ' class="alt-current"' : '') + '>' +
        '<td>' + AO.UI.escape(a.craftCity) + (a.bonusCity ? ' <span class="pill">bonus</span>' : '') + '</td>' +
        '<td class="align-right">' + AO.UI.pct(a.rrr * 100) + '</td>' +
        '<td class="align-right">' + AO.UI.silver(a.craftFee) + '</td>' +
        '<td class="align-right">' + AO.UI.profitCell(a.profit) + '</td></tr>';
    }).join('');

    // --- "My prices": per-item overrides for stale market data
    var ov = AO.Settings.data.priceOverrides || {};
    var myPrices = '<div class="detail-block"><h4>My prices ' +
      '<span class="tip" title="Enter your own price to override stale or missing market data. ' +
      'It applies instantly to every calculation across all tabs. Leave blank to use the market.">?</span></h4>' +
      '<div class="mp-grid">' +
      mpInput(row.itemId, 'sell', AO.UI.itemName(row.itemId), 'sell') +
      row.materials.map(function (m) {
        return mpInput(m.id, 'buy', AO.UI.itemName(m.id), 'buy');
      }).join('') +
      '</div>' +
      '<button class="btn mp-clear" data-items="' +
      AO.UI.escape([row.itemId].concat(row.materials.map(function (m) { return m.id; })).join(',')) +
      '">Clear these overrides</button></div>';

    // --- traded volume (lazy: filled in after the panel is in the DOM)
    var volId = 'vol-' + AO.Api.hash(row.itemId);
    var volume = '<div class="detail-block"><h4>Traded volume ' +
      '<span class="tip" title="Average units traded per day and per week across the tracked ' +
      'royal cities, from the price-history charts. Low volume means an illiquid market — a high ' +
      'paper profit there may be hard to actually realise.">?</span></h4>' +
      '<div id="' + volId + '" class="muted">Loading volume…</div></div>';
    loadVolume(volId, row.itemId, s.activeCities);

    return '<div class="detail-grid">' +
      '<div class="detail-block detail-block-wide"><h4>Materials (optimal sourcing vs local)</h4>' +
      '<div class="mini-scroll"><table class="mini-table"><thead><tr><th>Material</th>' +
      '<th class="align-right">Qty</th>' +
      '<th class="align-right">Best</th><th>From</th><th class="align-right">Local</th>' +
      '<th class="align-right">Δ</th><th>Age</th></tr></thead><tbody>' + mats +
      '</tbody></table></div>' +
      '<div class="sourcing-note">Optimal sourcing saves <strong>' +
      AO.UI.silver(row.sourcingSaving) + '</strong> vs buying everything in ' +
      AO.UI.escape(row.craftCity) + '.</div></div>' +

      '<div class="detail-block"><h4>Profit breakdown</h4>' +
      '<div class="mini-scroll"><table class="mini-table"><tbody>' +
      line('Gross revenue (' + row.sellCity + (row.blackMarket ? ', NPC demand' : '') + ')', row.grossRevenue) +
      line('− Setup fee (' + AO.UI.pct(s.setupFee) + ')', -row.setupFee) +
      line('− Sales fee (' + AO.UI.pct(s.salesFee) + ')', -row.salesFee) +
      line('− Material cost', -row.materialCost) +
      line('− Crafting station fee', -row.craftFee) +
      line('+ Returned resources', row.returnedValue) +
      '<tr class="total-row"><td>= Profit per craft' +
      (row.yield > 1 ? ' <span class="muted">(yields ' + row.yield + ')</span>' : '') +
      '</td><td class="align-right">' + AO.UI.profitCell(row.profit) + '</td></tr>' +
      (row.yield > 1 ? '<tr><td>= Profit per unit</td><td class="align-right">' +
        AO.UI.profitCell(row.profitPerUnit) + '</td></tr>' : '') +
      '</tbody></table></div>' +
      '<div class="muted">Per 100 crafts: ' + AO.UI.silver(row.profitPer100) +
      ' · Per 1000: ' + AO.UI.silver(row.profitPer1000) +
      (row.focusCost ? ' · Per focus: ' + (row.profitPerFocus || 0).toFixed(1) : '') + '</div>' +
      '</div>' +

      volume +

      '<div class="detail-block"><h4>Resource return ' +
      '<span class="tip" title="RRR = base rate (city bonus × focus matrix) × (1 + premium bonus) + mastery bonus">?</span></h4>' +
      '<div>Return rate: <strong>' + AO.UI.pct(row.rrr * 100) + '</strong>' +
      (row.bonusCity ? ' <span class="pill">bonus city</span>' : '') +
      (row.useFocus ? ' <span class="pill">focus</span>' : '') + '</div>' +
      '<div>You get back <strong>' + returnedUnits.toFixed(2) + '</strong> resources worth ' +
      '<strong>' + AO.UI.silver(row.returnedValue) + '</strong> silver on average.</div>' +
      '</div>' +

      qualityHtml +

      '<div class="detail-block"><h4>Per-city comparison</h4>' +
      '<div class="mini-scroll"><table class="mini-table"><thead><tr><th>Craft city</th>' +
      '<th class="align-right">RRR</th>' +
      '<th class="align-right">Fee</th><th class="align-right">Profit</th></tr></thead>' +
      '<tbody>' + alts + '</tbody></table></div></div>' +

      myPrices +

      '<div class="detail-actions">' +
      '<button class="btn copy-btn" data-copy="' + AO.UI.escape(plainText(row)) + '">📋 Copy calculation</button>' +
      '</div></div>';

    function line(label, value) {
      return '<tr><td>' + AO.UI.escape(label) + '</td><td class="align-right">' +
        AO.UI.exact(value) + '</td></tr>';
    }
  }

  /** One labelled manual-price input for the detail panel. */
  function mpInput(id, kind, name, verb) {
    var ov = AO.Settings.data.priceOverrides[id];
    var cur = ov && ov[kind] ? ov[kind] : '';
    return '<label class="mp-row"><span class="mp-name">' + AO.UI.icon(id, 20) + ' ' +
      AO.UI.escape(name) + '<em>' + verb + '</em></span>' +
      '<input class="mp-input" type="number" min="0" step="1" placeholder="market" ' +
      'data-item="' + AO.UI.escape(id) + '" data-kind="' + kind + '" value="' + cur + '"></label>';
  }

  /** Lazily fill a volume placeholder once it is in the DOM. */
  function loadVolume(elId, itemId, cities) {
    setTimeout(function () {
      if (!document.getElementById(elId)) return;
      var royal = cities.filter(function (c) { return c !== AO.BLACK_MARKET; });
      AO.Api.itemVolume(itemId, royal, 7).then(function (v) {
        var el = document.getElementById(elId);
        if (!el) return;
        if (v.perDay == null || !v.days) {
          el.innerHTML = '<span class="muted">No recent trade history for this item.</span>';
          return;
        }
        var perDay = Math.round(v.perDay), perWeek = Math.round(v.perWeek);
        var liq = perDay < 20 ? ' <span class="pill pill-warn">thin market</span>' : '';
        el.innerHTML = '~<strong>' + AO.UI.exact(perDay) + '</strong> sold/day · ~<strong>' +
          AO.UI.exact(perWeek) + '</strong>/week' + liq +
          '<div class="muted small">market-wide average over the last ' + v.days + ' days</div>';
      });
    }, 0);
  }

  function plainText(row) {
    var L = [];
    L.push(row.name + ' (' + row.itemId + ')');
    L.push('Craft in: ' + row.craftCity + (row.bonusCity ? ' [bonus city]' : ''));
    L.push('Sell in: ' + row.sellCity + ' @ ' + AO.UI.exact(row.sellPrice));
    L.push('Materials: ' + row.materials.map(function (m) {
      return m.qty + '× ' + AO.UI.itemName(m.id) + ' @ ' + AO.UI.exact(m.bestPrice) + ' (' + m.bestCity + ')';
    }).join(', '));
    L.push('Material cost: ' + AO.UI.exact(row.materialCost));
    L.push('Crafting fee: ' + AO.UI.exact(row.craftFee));
    L.push('RRR: ' + AO.UI.pct(row.rrr * 100) + ' → returns ' + AO.UI.exact(row.returnedValue));
    L.push('Quality multiplier: ' + row.qualityMultiplier.toFixed(3) + 'x');
    L.push('Selling fees: ' + AO.UI.exact(row.sellingFees));
    L.push('PROFIT/item: ' + AO.UI.exact(row.profit) + '  ROI: ' + AO.UI.pct(row.roi));
    if (row.focusCost) L.push('Focus: ' + row.focusCost + ' → ' + (row.profitPerFocus || 0).toFixed(2) + ' silver/focus');
    return L.join('\n');
  }

  function nameCell(r) {
    return AO.UI.icon(r.itemId, 28) + '<span class="item-name">' +
      AO.UI.escape(r.name || AO.UI.itemName(r.itemId)) + '</span>' +
      (r.blackMarket ? ' <span class="pill pill-bm">BM</span>' : '');
  }

  /* Shared column set for the three craft-like tabs. */
  function craftColumns() {
    return [
      { key: 'name', label: 'Item', render: nameCell, sortValue: function (r) { return r.name; },
        csv: function (r) { return r.name; } },
      // sortValue keeps tiers ordered numerically; csv must not leak that key.
      { key: 'tier', label: 'T', align: 'right', tip: 'Tier / enchantment',
        render: function (r) { return 'T' + r.tier + (r.enchant ? '.' + r.enchant : ''); },
        sortValue: function (r) { return r.tier * 10 + r.enchant; },
        csv: function (r) { return 'T' + r.tier + (r.enchant ? '.' + r.enchant : ''); } },
      { key: 'craftCity', label: 'Craft in', tip: 'City with the best net profit for this recipe',
        render: function (r) {
          return AO.UI.escape(r.craftCity) + (r.bonusCity ? ' <span class="pill">bonus</span>' : '');
        } },
      { key: 'materialCost', label: 'Materials', align: 'right',
        tip: 'Total material cost using the cheapest city for each input',
        render: function (r) { return AO.UI.silver(r.materialCost); }, csv: round0('materialCost') },
      { key: 'sourcingSaving', label: 'Sourcing Δ', align: 'right',
        tip: 'Saving from optimal sourcing versus buying everything locally',
        render: function (r) { return AO.UI.silver(r.sourcingSaving); }, csv: round0('sourcingSaving') },
      { key: 'craftFee', label: 'Fee', align: 'right',
        tip: 'Crafting station usage fee: item value × station tax / 100',
        render: function (r) { return AO.UI.silver(r.craftFee); }, csv: round0('craftFee') },
      { key: 'rrr', label: 'RRR %', align: 'right', tip: 'Resource return rate',
        render: function (r) { return AO.UI.pct(r.rrr * 100); },
        csv: function (r) { return (r.rrr * 100).toFixed(2); } },
      { key: 'sellCity', label: 'Sell in',
        render: function (r) {
          return AO.UI.escape(r.sellCity) + (r.blackMarket ? ' <span class="pill pill-bm">BM</span>' : '');
        } },
      { key: 'sellPrice', label: 'Sell', align: 'right',
        render: function (r) { return AO.UI.silver(r.sellPrice); } },
      { key: 'profit', label: 'Profit', align: 'right',
        tip: '(Sell − selling fees) − (materials + crafting fee) + returned resources',
        render: function (r) { return AO.UI.profitCell(r.profit); }, csv: round0('profit') },
      { key: 'roi', label: 'ROI %', align: 'right', tip: 'Profit ÷ silver invested',
        render: function (r) {
          return '<span class="' + (r.roi > 0 ? 'profit-pos' : 'profit-neg') + '">' +
            AO.UI.pct(r.roi) + '</span>';
        },
        csv: function (r) { return r.roi.toFixed(2); } },
      { key: 'profitPerFocus', label: 'Silver/Focus', align: 'right',
        tip: 'Silver of profit per focus point spent',
        render: function (r) {
          return r.profitPerFocus == null ? '—' : r.profitPerFocus.toFixed(1);
        },
        csv: function (r) { return r.profitPerFocus == null ? '' : r.profitPerFocus.toFixed(2); } },
      { key: 'dataAge', label: 'Data age (min)', tip: 'Age of the oldest quote used in this row',
        render: function (r) { return AO.UI.ageBadge(r.dataAge); }, csv: round0('dataAge') }
    ];
  }

  /** CSV helper: emit a plain rounded integer rather than a float or a label. */
  function round0(key) {
    return function (r) { return r[key] == null ? '' : Math.round(r[key]); };
  }

  /* ------------------------------------------------------------------ tabs */

  App.renderAll = function () {
    this.renderCrafting();
    this.renderRefining();
    this.renderCooking();
    this.renderTransport();
    this.renderFocus();
  };

  /** Apply the user's minimum-profit threshold to a row set. */
  function threshold(rows) {
    var min = AO.Settings.data.minProfit || 0;
    if (!min) return rows;
    return rows.filter(function (r) { return r.profit >= min; });
  }

  function summaryCard(host, cards) {
    host.innerHTML = cards.map(function (c) {
      return '<div class="metric"><div class="metric-label">' + AO.UI.escape(c.label) + '</div>' +
        '<div class="metric-value ' + (c.cls || '') + '">' + c.value + '</div>' +
        (c.sub ? '<div class="metric-sub">' + c.sub + '</div>' : '') + '</div>';
    }).join('');
  }

  App.renderCrafting = function () {
    var rows = this.results.crafting;
    var host = document.getElementById('crafting-table');
    var shown = threshold(rows);
    var best = rows.slice().sort(function (a, b) { return b.profit - a.profit; })[0];
    var profitable = rows.filter(function (r) { return r.profit > 0; });

    summaryCard(document.getElementById('crafting-summary'), [
      { label: 'Recipes with prices', value: rows.length,
        sub: rows.length > shown.length ? (rows.length - shown.length) + ' hidden by threshold' : '' },
      { label: 'Profitable', value: profitable.length,
        cls: profitable.length ? 'profit-pos' : '', sub: rows.length ? AO.UI.pct(profitable.length / rows.length * 100) + ' of set' : '' },
      { label: 'Best profit / item', value: best ? AO.UI.profitCell(best.profit) : '—',
        sub: best ? AO.UI.escape(best.name) : '' },
      { label: 'Best ROI', value: bestBy(rows, 'roi', function (v) { return AO.UI.pct(v); }) },
      { label: 'Best silver / focus', value: bestBy(rows, 'profitPerFocus', function (v) { return v.toFixed(1); }) }
    ]);

    this.tables.crafting = new AO.UI.DataTable(host, {
      expanded: App.expandedState.crafting,
      columns: craftColumns(),
      rows: shown,
      defaultSort: 'profit',
      detail: detailPanel,
      emptyMessage: 'No craftable items cleared your filters. Lower the minimum profit threshold in Settings, or refresh prices.'
    });
    wireTableControls('crafting', this.tables.crafting, categoriesOf(rows));
  };

  App.renderRefining = function () {
    var rows = this.results.refining;
    var host = document.getElementById('refining-table');
    var cols = craftColumns();
    // Refining-specific: is refining actually better than flipping the raws?
    cols.splice(cols.length - 1, 0, {
      key: 'refineAdvantage', label: 'vs raw', align: 'right',
      tip: 'Net value of refining and selling versus just reselling the raw inputs',
      render: function (r) {
        return r.refineAdvantage == null ? '—' : AO.UI.profitCell(r.refineAdvantage);
      }
    });

    var byFocus = this.results.focus.filter(function (f) { return f.kind === 'refining'; });

    var shown = threshold(rows);
    summaryCard(document.getElementById('refining-summary'), [
      { label: 'Refining lines', value: rows.length,
        sub: rows.length > shown.length ? (rows.length - shown.length) + ' hidden by threshold' : '' },
      { label: 'Profitable', value: rows.filter(function (r) { return r.profit > 0; }).length,
        cls: 'profit-pos' },
      { label: 'Best profit / item', value: bestBy(rows, 'profit', function (v) { return AO.UI.silver(v); }) },
      { label: 'Top focus efficiency', value: byFocus.length ? byFocus[0].profitPerFocus.toFixed(1) + ' /focus' : '—',
        sub: byFocus.length ? AO.UI.escape(byFocus[0].name) : '' },
      { label: 'Beats selling raw', value: rows.filter(function (r) {
          return r.refineAdvantage != null && r.refineAdvantage > 0;
        }).length }
    ]);

    this.tables.refining = new AO.UI.DataTable(host, {
      expanded: App.expandedState.refining,
      columns: cols,
      rows: shown,
      defaultSort: 'profit',
      detail: detailPanel,
      emptyMessage: 'No refining lines cleared your filters.'
    });
    wireTableControls('refining', this.tables.refining, categoriesOf(rows));
  };

  App.renderCooking = function () {
    var rows = this.results.cooking;
    var host = document.getElementById('cooking-table');
    var shown = threshold(rows);
    summaryCard(document.getElementById('cooking-summary'), [
      { label: 'Recipes', value: rows.length,
        sub: rows.length > shown.length ? (rows.length - shown.length) + ' hidden by threshold' : '' },
      { label: 'Profitable', value: rows.filter(function (r) { return r.profit > 0; }).length, cls: 'profit-pos' },
      { label: 'Best profit / item', value: bestBy(rows, 'profit', function (v) { return AO.UI.silver(v); }) },
      { label: 'Fish sauce', value: AO.Settings.data.fishSauce ? 'ON' : 'off',
        sub: AO.Settings.data.fishSauce ? 'cooking the _FISH variants' : 'toggle in Settings' },
      { label: 'Cooking bonus city', value: AO.CRAFT_BONUS_CITY.FOOD }
    ]);

    this.tables.cooking = new AO.UI.DataTable(host, {
      expanded: App.expandedState.cooking,
      columns: craftColumns(),
      rows: shown,
      defaultSort: 'profit',
      detail: detailPanel,
      emptyMessage: 'No cooking recipes cleared your filters.'
    });
    wireTableControls('cooking', this.tables.cooking, categoriesOf(rows));
  };

  App.renderTransport = function () {
    var self = this;
    var mode = document.querySelector('input[name="transport-mode"]:checked');
    mode = mode ? mode.value : 'all';
    var rows = threshold(this.results.transport).filter(function (r) {
      if (mode === 'bulk') return r.bulk;
      if (mode === 'special') return !r.bulk;
      return true;
    });

    var top20 = rows.slice(0, 20);
    summaryCard(document.getElementById('transport-summary'), [
      { label: 'Flip opportunities', value: rows.length },
      { label: 'Best single flip', value: top20.length ? AO.UI.profitCell(top20[0].profit) : '—',
        sub: top20.length ? AO.UI.escape(AO.UI.itemName(top20[0].itemId)) : '' },
      { label: 'Top-20 combined', value: AO.UI.silver(top20.reduce(function (s, r) { return s + r.profit; }, 0)),
        sub: 'one unit of each' },
      { label: 'Best margin', value: bestBy(rows, 'margin', function (v) { return AO.UI.pct(v); }) },
      { label: 'Transport cost', value: AO.UI.silver(AO.Settings.data.transportCost) + ' / item' }
    ]);

    var cols = [
      { key: 'itemId', label: 'Item',
        render: function (r) {
          return AO.UI.icon(r.itemId, 28) + '<span class="item-name">' +
            AO.UI.escape(AO.UI.itemName(r.itemId)) + '</span>';
        },
        sortValue: function (r) { return AO.UI.itemName(r.itemId); },
        csv: function (r) { return AO.UI.itemName(r.itemId); } },
      { key: 'tier', label: 'T', align: 'right',
        render: function (r) { return 'T' + r.tier + (r.enchant ? '.' + r.enchant : ''); },
        sortValue: function (r) { return r.tier * 10 + r.enchant; } },
      { key: 'buyCity', label: 'Buy in' },
      { key: 'buyPrice', label: 'Buy', align: 'right',
        render: function (r) { return AO.UI.silver(r.buyPrice); } },
      { key: 'sellCity', label: 'Sell in',
        render: function (r) {
          return AO.UI.escape(r.sellCity) + (r.blackMarket ? ' <span class="pill pill-bm">BM</span>' : '');
        } },
      { key: 'sellPrice', label: 'Sell', align: 'right',
        render: function (r) { return AO.UI.silver(r.sellPrice); } },
      { key: 'fees', label: 'Fees', align: 'right',
        render: function (r) { return AO.UI.silver(r.fees); } },
      { key: 'transport', label: 'Transport', align: 'right',
        render: function (r) { return AO.UI.silver(r.transport); } },
      { key: 'profit', label: 'Profit', align: 'right',
        render: function (r) { return AO.UI.profitCell(r.profit); } },
      { key: 'margin', label: 'Margin', align: 'right', tip: 'Profit ÷ buy price',
        render: function (r) {
          return '<span class="' + (r.margin > 0 ? 'profit-pos' : 'profit-neg') + '">' +
            AO.UI.pct(r.margin) + '</span>';
        } },
      { key: 'bulk', label: 'Class', tip: 'Bulk = cheap, high-volume. Specialized = high value per slot.',
        render: function (r) {
          return r.bulk ? '<span class="pill">bulk</span>' : '<span class="pill pill-gold">specialized</span>';
        },
        sortValue: function (r) { return r.bulk ? 1 : 0; } },
      { key: 'dataAge', label: 'Data',
        render: function (r) { return AO.UI.ageBadge(r.dataAge); } }
    ];

    this.tables.transport = new AO.UI.DataTable(document.getElementById('transport-table'), {
      columns: cols,
      rows: rows,
      expanded: App.expandedState.transport,
      defaultSort: 'profit',
      detail: function (r) { return transportDetail(r, self); },
      emptyMessage: 'No profitable routes at the current transport cost. Try lowering it in Settings.'
    });
    wireTableControls('transport', this.tables.transport, []);
  };

  function transportDetail(r, app) {
    var id = 'bm-trend-' + AO.Api.hash(r.itemId);
    var html = '<div class="detail-grid"><div class="detail-block"><h4>Route</h4>' +
      '<div>Buy in <strong>' + AO.UI.escape(r.buyCity) + '</strong> at ' + AO.UI.exact(r.buyPrice) +
      ', sell in <strong>' + AO.UI.escape(r.sellCity) + '</strong> at ' + AO.UI.exact(r.sellPrice) + '.</div>' +
      '<div class="muted">Less ' + AO.UI.exact(r.fees) + ' in market fees and ' +
      AO.UI.exact(r.transport) + ' transport → <strong>' + AO.UI.exact(r.profit) + '</strong> per unit.</div>' +
      '<div class="muted">100 units: ' + AO.UI.silver(r.profit * 100) + ' · 1000 units: ' +
      AO.UI.silver(r.profit * 1000) + '</div></div>';

    if (r.blackMarket) {
      html += '<div class="detail-block"><h4>Black Market demand</h4>' +
        '<div id="' + id + '" class="muted">Loading demand trend…</div>' +
        '<div class="muted small">Black Market prices come from NPC demand, not player listings. ' +
        'They only buy — you can never source materials there — and the price decays as ' +
        'players dump items into it.</div></div>';
      // Fire and forget; the panel updates in place if it is still mounted.
      AO.Api.blackMarketTrend(r.itemId).then(function (t) {
        var el = document.getElementById(id);
        if (!el) return;
        var arrow = { rising: '▲', falling: '▼', stable: '▬', unknown: '?' }[t.trend];
        var cls = { rising: 'profit-pos', falling: 'profit-neg', stable: '', unknown: 'muted' }[t.trend];
        el.innerHTML = '<span class="' + cls + '">' + arrow + ' ' + t.trend + '</span>' +
          (t.changePct == null ? '' : ' <span class="muted">(' +
            (t.changePct > 0 ? '+' : '') + t.changePct.toFixed(1) + '% over the last week)</span>');
      });
    }

    html += '<div class="detail-actions"><button class="btn copy-btn" data-copy="' +
      AO.UI.escape(AO.UI.itemName(r.itemId) + ': buy ' + r.buyCity + ' @' + Math.round(r.buyPrice) +
        ' → sell ' + r.sellCity + ' @' + Math.round(r.sellPrice) +
        ' = ' + Math.round(r.profit) + ' profit (' + r.margin.toFixed(1) + '%)') +
      '">📋 Copy route</button></div></div>';
    return html;
  }

  App.renderFocus = function () {
    var ranked = this.results.focus;
    var daily = AO.Settings.data.dailyFocus;
    var top = ranked[0];

    summaryCard(document.getElementById('focus-summary'), [
      { label: 'Daily focus budget', value: AO.UI.exact(daily) },
      { label: 'Best use', value: top ? AO.UI.escape(top.name) : '—',
        sub: top ? top.craftCity : '' },
      { label: 'Silver per focus', value: top ? top.profitPerFocus.toFixed(2) : '—', cls: 'profit-pos' },
      { label: 'Projected silver / day', value: top ? AO.UI.silver(top.dailySilver) : '—', cls: 'profit-pos' },
      { label: 'Activities ranked', value: ranked.length }
    ]);

    var head = document.getElementById('focus-headline');
    if (head) {
      head.innerHTML = top
        ? 'Spending your <strong>' + AO.UI.exact(daily) + '</strong> daily focus on <strong>' +
          AO.UI.escape(top.name) + '</strong> in <strong>' + AO.UI.escape(top.craftCity) +
          '</strong> yields roughly <strong class="profit-pos">' + AO.UI.silver(top.dailySilver) +
          ' silver/day</strong> (' + Math.floor(top.craftsPerDay) + ' crafts).'
        : 'No focus activity is profitable with the current data and filters.';
    }

    var cols = [
      { key: 'name', label: 'Activity',
        render: function (r) {
          return AO.UI.icon(r.itemId, 28) + '<span class="item-name">' + AO.UI.escape(r.name) + '</span>';
        },
        sortValue: function (r) { return r.name; }, csv: function (r) { return r.name; } },
      { key: 'kind', label: 'Type',
        render: function (r) { return '<span class="pill">' + r.kind + '</span>'; } },
      { key: 'craftCity', label: 'City' },
      { key: 'focusCost', label: 'Focus / craft', align: 'right',
        render: function (r) { return AO.UI.exact(r.focusCost); } },
      { key: 'profit', label: 'Profit / craft', align: 'right',
        render: function (r) { return AO.UI.profitCell(r.profit); } },
      { key: 'profitPerFocus', label: 'Silver / focus', align: 'right',
        tip: 'The ranking metric — profit divided by focus spent',
        render: function (r) {
          return '<strong class="' + (r.profitPerFocus > 0 ? 'profit-pos' : 'profit-neg') + '">' +
            r.profitPerFocus.toFixed(2) + '</strong>';
        } },
      { key: 'craftsPerDay', label: 'Crafts / day', align: 'right',
        render: function (r) { return AO.UI.exact(r.craftsPerDay); } },
      { key: 'dailySilver', label: 'Silver / day', align: 'right',
        render: function (r) { return AO.UI.profitCell(r.dailySilver); } }
    ];

    this.tables.focus = new AO.UI.DataTable(document.getElementById('focus-table'), {
      columns: cols,
      rows: ranked,
      expanded: App.expandedState.focus,
      defaultSort: 'profitPerFocus',
      detail: function (r) { return detailPanel(r.row); },
      emptyMessage: 'No focus activities available. Enable focus usage in Settings.'
    });
    wireTableControls('focus', this.tables.focus, []);

    renderFarming();
    renderJournals(this.results.journals);
  };

  /* Watering is a focus sink too, but it has no market recipe — it is modelled
     from the user's own yield estimate. */
  function renderFarming() {
    var host = document.getElementById('farming-panel');
    if (!host) return;
    var s = AO.Settings.data;
    var focusPerWater = 25;
    var seedYieldSilver = s.wateringYield || 1500;
    var perFocus = seedYieldSilver / focusPerWater;
    host.innerHTML = '<h3>Watering crops / herbs</h3>' +
      '<div class="inline-field"><label>Extra silver gained per watered plot' +
      '<input type="number" id="watering-yield" value="' + seedYieldSilver + '" min="0" step="100"></label>' +
      '<span class="muted">at ' + focusPerWater + ' focus per water</span></div>' +
      '<div class="metric-row"><div class="metric"><div class="metric-label">Silver per focus</div>' +
      '<div class="metric-value ' + (perFocus > 0 ? 'profit-pos' : '') + '">' + perFocus.toFixed(2) + '</div></div>' +
      '<div class="metric"><div class="metric-label">Daily focus → silver</div>' +
      '<div class="metric-value">' + AO.UI.silver(perFocus * s.dailyFocus) + '</div></div></div>' +
      '<p class="muted small">Compare this against the table above: if watering beats your best ' +
      'craft on silver-per-focus, spend the focus in the garden instead.</p>';
    var input = document.getElementById('watering-yield');
    input.addEventListener('input', AO.UI.debounce(function () {
      AO.Settings.set('wateringYield', parseFloat(input.value) || 0);
      renderFarming();
    }, 400));
  }

  function renderJournals(rows) {
    var host = document.getElementById('journal-panel');
    if (!host) return;
    if (!rows.length) {
      host.innerHTML = '<h3>Laborer journals</h3><p class="muted">No journal prices available ' +
        'right now — these are thin markets and often have no recent quotes.</p>';
      return;
    }
    var body = rows.map(function (r) {
      return '<tr><td>T' + r.tier + ' Toolmaker journal</td>' +
        '<td class="align-right">' + AO.UI.exact(r.buyPrice) + '</td><td>' + AO.UI.escape(r.buyCity) + '</td>' +
        '<td class="align-right">' + AO.UI.exact(r.sellPrice) + '</td><td>' + AO.UI.escape(r.sellCity) + '</td>' +
        '<td class="align-right">' + AO.UI.exact(r.fees) + '</td>' +
        '<td class="align-right">' + AO.UI.profitCell(r.profit) + '</td>' +
        '<td class="align-right">' + AO.UI.exact(r.fame) + '</td>' +
        '<td class="align-right">' + r.silverPerFame.toFixed(3) + '</td></tr>';
    }).join('');
    host.innerHTML = '<h3>Laborer journals</h3>' +
      '<p class="muted small">Buying empty journals, filling them with crafting fame you were ' +
      'generating anyway, and selling them full. The last column is what each point of otherwise-wasted ' +
      'crafting fame is worth.</p>' +
      '<div class="table-scroll"><table class="data-table"><thead><tr><th>Journal</th>' +
      '<th class="align-right">Empty</th><th>From</th><th class="align-right">Full</th><th>To</th>' +
      '<th class="align-right">Fees</th><th class="align-right">Profit</th>' +
      '<th class="align-right">Fame</th><th class="align-right">Silver/fame</th></tr></thead>' +
      '<tbody>' + body + '</tbody></table></div>';
  }

  function bestBy(rows, key, fmt) {
    var best = null;
    rows.forEach(function (r) {
      var v = r[key];
      if (v == null || !isFinite(v)) return;
      if (best == null || v > best) best = v;
    });
    return best == null ? '—' : '<span class="profit-pos">' + fmt(best) + '</span>';
  }

  function categoriesOf(rows) {
    var seen = Object.create(null);
    rows.forEach(function (r) { if (r.category) seen[r.category] = true; });
    return Object.keys(seen).sort();
  }

  /* ------------------------------------------------- per-tab table controls */

  function wireTableControls(tab, table, categories) {
    var search = document.getElementById(tab + '-search');
    var cat = document.getElementById(tab + '-category');
    var csv = document.getElementById(tab + '-csv');
    var copy = document.getElementById(tab + '-copy');

    if (search && !search._wired) {
      search._wired = true;
      search.addEventListener('input', AO.UI.debounce(function () {
        App.tables[tab].setFilter(search.value);
      }, 200));
    }
    if (cat) {
      if (!categories.length) {
        cat.hidden = true;
      } else {
        cat.hidden = false;
        var current = cat.value;
        cat.innerHTML = '<option value="">All categories</option>' + categories.map(function (c) {
          return '<option value="' + AO.UI.escape(c) + '"' + (c === current ? ' selected' : '') + '>' +
            AO.UI.escape(prettyCategory(c)) + '</option>';
        }).join('');
        if (!cat._wired) {
          cat._wired = true;
          cat.addEventListener('change', function () { App.tables[tab].setCategory(cat.value); });
        }
        if (current) table.setCategory(current);
      }
    }
    if (csv && !csv._wired) {
      csv._wired = true;
      csv.addEventListener('click', function () {
        AO.UI.downloadCsv('albion-' + tab + '-' + new Date().toISOString().slice(0, 10) + '.csv',
          App.tables[tab].toCsv());
      });
    }
    if (copy && !copy._wired) {
      copy._wired = true;
      copy.addEventListener('click', function () {
        AO.UI.copy(App.tables[tab].toCsv().split('\n').slice(0, 51).join('\n'));
      });
    }
    if (search) search.value = table.filterText || '';
  }

  function prettyCategory(c) {
    return ({
      PLATE: 'Plate armor', LEATHER_ARMOR: 'Leather armor', CLOTH_ARMOR: 'Cloth armor',
      MELEE: 'Melee weapons', RANGED: 'Ranged weapons', MAGIC: 'Magic weapons',
      OFFHAND: 'Off-hands & accessories', TOOL: 'Tools', FOOD: 'Food', POTION: 'Potions',
      METALBAR: 'Ore → Bar', PLANKS: 'Logs → Planks', LEATHER: 'Hide → Leather',
      CLOTH: 'Fiber → Cloth', STONEBLOCK: 'Stone → Blocks'
    })[c] || c;
  }

  /* --------------------------------------------------------- loading states */

  var TAB_HOSTS = ['crafting-table', 'refining-table', 'cooking-table', 'transport-table', 'focus-table'];

  function showLoadingInTabs() {
    TAB_HOSTS.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) AO.UI.skeleton(el, 10);
    });
  }

  function showErrorInTabs(msg) {
    TAB_HOSTS.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) AO.UI.errorState(el, msg, function () { App.load(true); });
    });
  }

  /* ------------------------------------------------------------------ tabs */

  function initTabs() {
    var buttons = document.querySelectorAll('.tab-btn');
    Array.prototype.forEach.call(buttons, function (btn) {
      btn.addEventListener('click', function () {
        var target = btn.getAttribute('data-tab');
        Array.prototype.forEach.call(buttons, function (b) {
          var on = b === btn;
          b.classList.toggle('active', on);
          b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        Array.prototype.forEach.call(document.querySelectorAll('.tab-panel'), function (p) {
          p.hidden = p.id !== 'tab-' + target;
        });
        // Rebuild Settings on open so the "My prices" list reflects overrides
        // added from the calculator tabs since it was last rendered.
        if (target === 'settings') renderSettings();
        location.hash = target;
      });
    });
    var initial = (location.hash || '').replace('#', '') || 'crafting';
    var btn = document.querySelector('.tab-btn[data-tab="' + initial + '"]');
    if (btn) btn.click();
  }

  /* --------------------------------------------------------------- settings */

  function renderSettings() {
    var s = AO.Settings.data;
    var host = document.getElementById('settings-body');

    host.innerHTML =
      section('Account', [
        toggle('premium', 'Premium status', s.premium,
          'Premium reduces the market setup fee and speeds up focus regeneration.'),
        toggle('useFocusCrafting', 'Use focus when crafting', s.useFocusCrafting),
        toggle('useFocusRefining', 'Use focus when refining', s.useFocusRefining),
        number('dailyFocus', 'Daily focus points available', s.dailyFocus, 0, 1000000, 100)
      ]) +

      section('Market fees', [
        number('setupFee', 'Setup fee %', s.setupFee, 0, 20, 0.1,
          'Charged when you list an item. Premium: 2.5%, non-premium: 5%.'),
        number('salesFee', 'Sales fee %', s.salesFee, 0, 20, 0.1,
          'Charged when the item actually sells.'),
        number('transportCost', 'Transport cost per item (silver)', s.transportCost, 0, 1000000, 100),
        number('minProfit', 'Minimum profit threshold (silver)', s.minProfit, -1000000, 10000000, 100,
          'Rows below this profit are hidden everywhere.')
      ]) +

      section('Calculation scope', [
        toggle('includeBlackMarket', 'Include Black Market in sell comparison', s.includeBlackMarket),
        toggle('includeBrecilien', 'Include Brecilien in all calculations', s.includeBrecilien),
        toggle('useSellOrdersForMaterials', 'Buy materials instantly (sell orders)', s.useSellOrdersForMaterials,
          'Off = assume you fill buy orders, which is cheaper but slower.'),
        toggle('useBuyOrdersForSales', 'Sell products instantly (buy orders)', s.useBuyOrdersForSales,
          'Off = assume you list your own sell order at the current best price.'),
        number('maxDataAgeMinutes', 'Ignore quotes older than (minutes)', s.maxDataAgeMinutes, 0, 100000, 10),
        number('outlierFactor', 'Reject prices above N× median', s.outlierFactor, 0, 100, 0.5,
          'Guards against troll listings — a single 50m sell order on a 5k item would ' +
          'otherwise top every ranking. Set to 0 to trust the market unfiltered.'),
        number('cacheTtlMinutes', 'Cache lifetime (minutes)', s.cacheTtlMinutes, 1, 1440, 1),
        select('qualityMode', 'Quality display mode', s.qualityMode,
          [['average', 'Average'], ['detailed', 'Detailed distribution']])
      ]) +

      section('Cooking', [
        toggle('fishSauce', 'Use fish sauce on food recipes', s.fishSauce,
          'Switches food recipes to their higher-nutrition _FISH variants, adding a jar of ' +
          'fish sauce to the ingredient list. Both the extra cost and the higher sale price ' +
          'are taken from the live market.')
      ]) +

      section('Resource return rate', [
        number('rrr.base', 'Base return %', s.rrr.base, 0, 100, 0.1),
        number('rrr.bonusCity', 'Bonus-city return %', s.rrr.bonusCity, 0, 100, 0.1),
        number('rrr.focus', 'With focus %', s.rrr.focus, 0, 100, 0.1),
        number('rrr.focusBonusCity', 'Focus + bonus city %', s.rrr.focusBonusCity, 0, 100, 0.1),
        number('premiumRrrBonus', 'Premium bonus to return rate %', s.premiumRrrBonus, 0, 100, 1,
          'Live Albion gives no RRR bonus for premium; leave at 0 unless you are modelling a change.')
      ]) +

      section('Crafting station tax (silver per 100 item value)',
        AO.CITIES.map(function (c) {
          return number('stationTax.' + c, c, s.stationTax[c], 0, 2000, 1);
        })) +

      section('Crafting mastery', Object.keys(s.craftMastery).map(function (k) {
        return slider('craftMastery.' + k, prettyCategory(k), s.craftMastery[k]);
      })) +

      section('Refining mastery', Object.keys(s.refineMastery).map(function (k) {
        return slider('refineMastery.' + k, prettyCategory(k), s.refineMastery[k]);
      })) +

      myPricesSection(s.priceOverrides) +

      '<div class="settings-actions">' +
      '<button class="btn btn-primary" id="settings-apply">Apply &amp; recalculate</button>' +
      '<button class="btn" id="settings-clear-cache">Clear price cache</button>' +
      '<button class="btn btn-danger" id="settings-reset">Reset to defaults</button>' +
      '</div>';

    // --- wiring
    Array.prototype.forEach.call(host.querySelectorAll('[data-setting]'), function (el) {
      var path = el.getAttribute('data-setting');
      var handler = AO.UI.debounce(function () {
        var v;
        if (el.type === 'checkbox') v = el.checked;
        else if (el.type === 'number' || el.type === 'range') v = parseFloat(el.value);
        else v = el.value;
        if (typeof v === 'number' && !isFinite(v)) return;
        AO.Settings.set(path, v);
        var out = el.parentNode.querySelector('.range-value');
        if (out) out.textContent = el.value;
        scheduleRecompute();
      }, el.type === 'range' ? 150 : 400);
      el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', handler);
    });

    document.getElementById('settings-apply').addEventListener('click', function () {
      App.load(false);
      AO.UI.toast('Recalculated');
    });
    document.getElementById('settings-clear-cache').addEventListener('click', function () {
      AO.Cache.clear().then(function () {
        AO.UI.toast('Cache cleared — refetching');
        App.load(true);
      });
    });
    document.getElementById('settings-reset').addEventListener('click', function () {
      AO.Settings.reset();
      renderSettings();
      App.load(false);
      AO.UI.toast('Settings reset to defaults');
    });

    // My-prices management: remove one, or clear all.
    Array.prototype.forEach.call(host.querySelectorAll('.mp-del'), function (btn) {
      btn.addEventListener('click', function () {
        delete AO.Settings.data.priceOverrides[btn.getAttribute('data-item')];
        AO.Settings.save();
        App.reapplyPrices();
        renderSettings();
      });
    });
    var clearAll = document.getElementById('mp-clear-all');
    if (clearAll) clearAll.addEventListener('click', function () {
      AO.Settings.data.priceOverrides = {};
      AO.Settings.save();
      App.reapplyPrices();
      renderSettings();
      AO.UI.toast('All manual prices cleared');
    });
  }

  /** Settings section listing every manual price override with remove controls. */
  function myPricesSection(overrides) {
    var ids = Object.keys(overrides || {}).filter(function (id) {
      var o = overrides[id];
      return o && (o.buy || o.sell);
    });
    var body;
    if (!ids.length) {
      body = '<p class="muted small">No manual prices set. Expand any row in a calculator tab ' +
        'and use the <strong>My prices</strong> box to override stale or missing market data for ' +
        'an item — it then applies everywhere.</p>';
    } else {
      body = '<div class="mp-manage">' + ids.map(function (id) {
        var o = overrides[id];
        return '<div class="mp-manage-row"><span>' + AO.UI.icon(id, 20) + ' ' +
          AO.UI.escape(AO.UI.itemName(id)) + '</span>' +
          '<span class="muted">' + (o.buy ? 'buy ' + AO.UI.exact(o.buy) : '') + '</span>' +
          '<span class="muted">' + (o.sell ? 'sell ' + AO.UI.exact(o.sell) : '') + '</span>' +
          '<button class="mp-del" data-item="' + AO.UI.escape(id) + '" title="Remove">✕</button></div>';
      }).join('') + '</div>' +
        '<button class="btn btn-danger" id="mp-clear-all" style="margin-top:10px">Clear all ' +
        ids.length + ' overrides</button>';
    }
    return '<section class="settings-section"><h3>My prices' +
      (ids.length ? ' (' + ids.length + ')' : '') + ' ' +
      '<span class="tip" title="Prices you entered by hand. They override stale market data ' +
      'in every calculation. Fresh, never treated as stale.">?</span></h3>' + body + '</section>';
  }

  var scheduleRecompute = AO.UI.debounce(function () {
    if (!App.fetchedAt) return;
    // Toggling Brecilien / Black Market changes which locations we need.
    App.buildRecipes();
    App.recompute();
    App.renderAll();
    App.renderHeader();
  }, 300);

  function section(title, fields) {
    return '<section class="settings-section"><h3>' + AO.UI.escape(title) + '</h3>' +
      '<div class="settings-grid">' + fields.join('') + '</div></section>';
  }

  function toggle(path, label, value, tip) {
    return '<label class="setting setting-toggle">' +
      '<input type="checkbox" data-setting="' + path + '"' + (value ? ' checked' : '') + '>' +
      '<span>' + AO.UI.escape(label) + tipIcon(tip) + '</span></label>';
  }

  function number(path, label, value, min, max, step, tip) {
    return '<label class="setting"><span>' + AO.UI.escape(label) + tipIcon(tip) + '</span>' +
      '<input type="number" data-setting="' + path + '" value="' + value + '" min="' + min +
      '" max="' + max + '" step="' + step + '"></label>';
  }

  function slider(path, label, value) {
    return '<label class="setting setting-slider"><span>' + AO.UI.escape(label) + '</span>' +
      '<input type="range" data-setting="' + path + '" value="' + value + '" min="0" max="100" step="1">' +
      '<output class="range-value">' + value + '</output></label>';
  }

  function select(path, label, value, options) {
    return '<label class="setting"><span>' + AO.UI.escape(label) + '</span>' +
      '<select data-setting="' + path + '">' + options.map(function (o) {
        return '<option value="' + o[0] + '"' + (o[0] === value ? ' selected' : '') + '>' +
          AO.UI.escape(o[1]) + '</option>';
      }).join('') + '</select></label>';
  }

  function tipIcon(tip) {
    return tip ? ' <span class="tip" title="' + AO.UI.escape(tip) + '">?</span>' : '';
  }

  /* ------------------------------------------------------------------ boot */

  function init() {
    AO.Settings.load();
    initTabs();
    renderSettings();

    document.getElementById('refresh-btn').addEventListener('click', function () {
      App.load(true);
    });

    Array.prototype.forEach.call(document.querySelectorAll('input[name="transport-mode"]'), function (el) {
      el.addEventListener('change', function () { App.renderTransport(); });
    });

    // Delegated copy buttons inside expandable detail panels.
    document.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('.copy-btn');
      if (!btn) return;
      e.stopPropagation();
      AO.UI.copy(btn.getAttribute('data-copy') || '');
    });

    // Delegated "Clear these overrides" buttons.
    document.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('.mp-clear');
      if (!btn) return;
      e.stopPropagation();
      (btn.getAttribute('data-items') || '').split(',').forEach(function (id) {
        delete AO.Settings.data.priceOverrides[id];
      });
      AO.Settings.save();
      App.reapplyPrices();
      AO.UI.toast('Overrides cleared');
    });

    // Delegated manual-price inputs (debounced so typing does not thrash).
    var onMpInput = AO.UI.debounce(function (input) {
      var id = input.getAttribute('data-item');
      var kind = input.getAttribute('data-kind');
      var val = parseFloat(input.value);
      var store = AO.Settings.data.priceOverrides;
      if (!store[id]) store[id] = {};
      if (isFinite(val) && val > 0) store[id][kind] = val;
      else {
        delete store[id][kind];
        if (!store[id].buy && !store[id].sell) delete store[id];
      }
      AO.Settings.save();
      App.reapplyPrices();
    }, 500);
    document.addEventListener('input', function (e) {
      var input = e.target.closest && e.target.closest('.mp-input');
      if (input) onMpInput(input);
    });

    // Keep the "x minutes ago" badges honest without a full re-render.
    setInterval(function () { App.renderHeader(); }, 60000);

    App.load(false);

    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* optional */ });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

}(window.AO = window.AO || {}));
