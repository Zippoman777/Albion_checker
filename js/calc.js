/* ==========================================================================
   calc.js — all profit mathematics.

   Every function is pure: it takes a price index + settings and returns plain
   objects, so the UI layer can sort/filter/render without re-deriving anything.
   ========================================================================== */
(function (AO) {
  'use strict';

  var Calc = AO.Calc = {};

  /* ------------------------------------------------------------ item value */

  // Nominal "item value" per unit of a tier-N resource. Used for the crafting
  // station fee, which in game scales with item value rather than market price.
  var RESOURCE_VALUE = { 2: 2, 3: 4, 4: 8, 5: 16, 6: 32, 7: 64, 8: 128 };

  function tierOf(itemId) {
    var m = /^T(\d)/.exec(itemId);
    return m ? parseInt(m[1], 10) : 4;
  }
  function enchantOf(itemId) {
    var m = /@(\d)/.exec(itemId);
    return m ? parseInt(m[1], 10) : 0;
  }
  Calc.tierOf = tierOf;
  Calc.enchantOf = enchantOf;

  function nominalItemValue(recipe) {
    var total = 0;
    recipe.materials.forEach(function (m) {
      var t = tierOf(m.id);
      var e = enchantOf(m.id);
      total += (RESOURCE_VALUE[t] || 8) * Math.pow(2, e) * m.qty;
    });
    return total;
  }
  Calc.nominalItemValue = nominalItemValue;

  /* --------------------------------------------------------------- quotes */

  function ageMinutes(isoDate) {
    if (!isoDate) return null;
    var t = Date.parse(isoDate.endsWith('Z') ? isoDate : isoDate + 'Z');
    if (!isFinite(t)) return null;
    return (Date.now() - t) / 60000;
  }
  Calc.ageMinutes = ageMinutes;

  /**
   * Cheapest place to buy `itemId`.
   * Honours the "buy off sell orders vs place buy orders" setting and the
   * maximum acceptable data age.
   */
  Calc.bestBuy = function (prices, itemId, cities, settings) {
    var byItem = prices[itemId];
    if (!byItem) return null;
    var useSell = settings.useSellOrdersForMaterials;
    var maxAge = settings.maxDataAgeMinutes;
    var best = null;
    cities.forEach(function (city) {
      var q = byItem[city];
      if (!q) return;
      var price = useSell ? q.sellMin : q.buyMax;
      var age = ageMinutes(useSell ? q.sellAt : q.buyAt);
      if (!price) return;
      if (maxAge && age != null && age > maxAge) return;
      if (!best || price < best.price) {
        best = { city: city, price: price, ageMinutes: age };
      }
    });
    return best;
  };

  /** Price of `itemId` in one specific city (or null). */
  Calc.priceIn = function (prices, itemId, city, settings) {
    var q = prices[itemId] && prices[itemId][city];
    if (!q) return null;
    var useSell = settings.useSellOrdersForMaterials;
    var price = useSell ? q.sellMin : q.buyMax;
    if (!price) return null;
    var age = ageMinutes(useSell ? q.sellAt : q.buyAt);
    if (settings.maxDataAgeMinutes && age != null && age > settings.maxDataAgeMinutes) return null;
    return { city: city, price: price, ageMinutes: age };
  };

  /**
   * Highest price we are willing to believe for an item.
   *
   * Albion's market carries troll listings — a single 50m sell order on a 5k
   * item will otherwise dominate every ranking in the app. We take the median
   * of the quotes across all cities and refuse anything more than
   * `outlierFactor` times that. With fewer than three quotes there is no
   * median worth trusting, so no ceiling is applied.
   *
   * @returns {number|null} the ceiling, or null when unconstrained
   */
  Calc.plausibleCeiling = function (prices, itemId, settings) {
    var factor = settings.outlierFactor;
    if (!factor || factor <= 0) return null;
    var byItem = prices[itemId];
    if (!byItem) return null;

    var quotes = [];
    Object.keys(byItem).forEach(function (city) {
      var q = byItem[city];
      if (q.sellMin) quotes.push(q.sellMin);
      if (q.buyMax) quotes.push(q.buyMax);
    });
    if (quotes.length < 3) return null;

    quotes.sort(function (a, b) { return a - b; });
    var mid = Math.floor(quotes.length / 2);
    var median = quotes.length % 2 ? quotes[mid] : (quotes[mid - 1] + quotes[mid]) / 2;
    return median * factor;
  };

  /**
   * Best place to sell. Black Market only ever has buy orders, so it is scored
   * on buyMax regardless of the instant-sell setting.
   */
  Calc.bestSell = function (prices, itemId, cities, settings) {
    var byItem = prices[itemId];
    if (!byItem) return null;
    var candidates = cities.slice();
    if (settings.includeBlackMarket) candidates.push(AO.BLACK_MARKET);
    var ceiling = Calc.plausibleCeiling(prices, itemId, settings);
    var best = null;
    candidates.forEach(function (city) {
      var q = byItem[city];
      if (!q) return;
      var isBM = city === AO.BLACK_MARKET;
      var price = (isBM || settings.useBuyOrdersForSales) ? q.buyMax : q.sellMin;
      var instant = isBM || settings.useBuyOrdersForSales;
      var age = ageMinutes(instant ? q.buyAt : q.sellAt);
      if (!price) return;
      if (ceiling != null && price > ceiling) return;
      if (settings.maxDataAgeMinutes && age != null && age > settings.maxDataAgeMinutes) return;
      if (!best || price > best.price) {
        best = { city: city, price: price, ageMinutes: age, instant: instant, blackMarket: isBM };
      }
    });
    return best;
  };

  /* ----------------------------------------------------- resource return rate */

  /**
   * RRR for a recipe crafted in `city`.
   * Base rate comes from the (city-bonus × focus) matrix, then premium and
   * mastery bonuses are layered on per the documented formula.
   */
  Calc.resourceReturnRate = function (recipe, city, useFocus, settings) {
    var r = settings.rrr;
    var bonusCity = recipe.bonusCity === city;
    var base;
    if (useFocus && bonusCity) base = r.focusBonusCity;
    else if (useFocus) base = r.focus;
    else if (bonusCity) base = r.bonusCity;
    else base = r.base;

    var premiumBonus = settings.premium ? (settings.premiumRrrBonus || 0) / 100 : 0;
    var mastery = masteryFor(recipe, settings);
    // Mastery contributes up to +2 percentage points of return.
    var masteryBonus = (mastery / 100) * 2;

    var rate = base * (1 + premiumBonus) + masteryBonus;
    return Math.max(0, Math.min(95, rate)) / 100;
  };

  function masteryFor(recipe, settings) {
    if (recipe.kind === 'refining') return settings.refineMastery[recipe.family] || 0;
    return settings.craftMastery[recipe.category] || 0;
  }
  Calc.masteryFor = masteryFor;

  /* ------------------------------------------------------------- fees */

  Calc.craftingFee = function (recipe, city, settings) {
    var taxPer100 = settings.stationTax[city];
    if (taxPer100 == null) taxPer100 = 10;
    return (nominalItemValue(recipe) * taxPer100) / 100;
  };

  /**
   * Selling fees. Listing on the market costs setup + sales fee; selling
   * instantly into a buy order (or to the Black Market) only costs the sales fee.
   */
  Calc.sellingFees = function (grossValue, instant, settings) {
    var setup = instant ? 0 : (settings.setupFee / 100) * grossValue;
    var sales = (settings.salesFee / 100) * grossValue;
    return { setup: setup, sales: sales, total: setup + sales };
  };

  /* -------------------------------------------------------- main evaluation */

  /**
   * Evaluate a recipe in one crafting city.
   * @returns {object|null} a fully broken-down result row
   */
  Calc.evaluateInCity = function (recipe, prices, city, settings) {
    var cities = settings.activeCities;
    var useFocus = recipe.kind === 'refining'
      ? settings.useFocusRefining
      : settings.useFocusCrafting;

    // --- materials, sourced optimally and locally
    var optimalTotal = 0;
    var localTotal = 0;
    var missing = false;
    var breakdown = [];

    for (var i = 0; i < recipe.materials.length; i++) {
      var mat = recipe.materials[i];
      var opt = Calc.bestBuy(prices, mat.id, cities, settings);
      if (!opt) { missing = true; break; }
      var local = Calc.priceIn(prices, mat.id, city, settings);
      optimalTotal += opt.price * mat.qty;
      localTotal += (local ? local.price : opt.price) * mat.qty;
      breakdown.push({
        id: mat.id,
        qty: mat.qty,
        bestCity: opt.city,
        bestPrice: opt.price,
        localPrice: local ? local.price : null,
        ageMinutes: opt.ageMinutes
      });
    }
    if (missing) return null;

    // Flat per-craft surcharge (e.g. fish sauce on food recipes).
    var extraCost = recipe.extraCost || 0;
    optimalTotal += extraCost;
    localTotal += extraCost;

    // --- sell side
    var sell = Calc.bestSell(prices, recipe.resultId, cities, settings);
    if (!sell) return null;

    var qualityMult = settings.qualityAppliesTo(recipe)
      ? AO.averageQualityMultiplier(masteryFor(recipe, settings))
      : 1;
    var grossPerItem = sell.price * qualityMult * recipe.resultQty;
    var qualityBonusValue = sell.price * (qualityMult - 1) * recipe.resultQty;

    var fees = Calc.sellingFees(grossPerItem, sell.instant, settings);
    var craftFee = Calc.craftingFee(recipe, city, settings);
    var rrr = Calc.resourceReturnRate(recipe, city, useFocus, settings);

    var materialCost = optimalTotal;
    // Surcharges are consumed outright — they are never part of the return roll.
    var returnedValue = (materialCost - extraCost) * rrr;
    var netMaterialCost = materialCost - returnedValue;

    var profit = (grossPerItem - fees.total) - (materialCost + craftFee) + returnedValue;
    var invested = materialCost + craftFee;
    var roi = invested > 0 ? (profit / invested) * 100 : 0;
    var focusCost = useFocus ? recipe.focusCost : 0;
    var profitPerFocus = focusCost > 0 ? profit / focusCost : null;

    return {
      recipe: recipe,
      itemId: recipe.resultId,
      // Refining recipes carry no hand-written name; fall back to the
      // localized name dump before showing a bare item id.
      name: recipe.name || (AO.itemNames && AO.itemNames[recipe.resultId]) || recipe.resultId,
      tier: recipe.tier,
      enchant: recipe.enchant,
      category: recipe.category || recipe.family,
      craftCity: city,
      bonusCity: recipe.bonusCity === city,

      materialCost: materialCost,
      materialCostLocal: localTotal,
      sourcingSaving: localTotal - optimalTotal,
      materials: breakdown,

      craftFee: craftFee,
      rrr: rrr,
      returnedValue: returnedValue,
      netMaterialCost: netMaterialCost,

      sellCity: sell.city,
      sellPrice: sell.price,
      blackMarket: sell.blackMarket,
      qualityMultiplier: qualityMult,
      qualityBonusValue: qualityBonusValue,
      qualityDistribution: AO.qualityDistribution(masteryFor(recipe, settings)),
      grossRevenue: grossPerItem,
      setupFee: fees.setup,
      salesFee: fees.sales,
      sellingFees: fees.total,

      focusCost: focusCost,
      useFocus: useFocus,
      profit: profit,
      profitPer100: profit * 100,
      profitPer1000: profit * 1000,
      profitPerFocus: profitPerFocus,
      roi: roi,
      dataAge: worstAge(breakdown, sell)
    };
  };

  function worstAge(breakdown, sell) {
    var worst = null;
    breakdown.forEach(function (b) {
      if (b.ageMinutes != null && (worst == null || b.ageMinutes > worst)) worst = b.ageMinutes;
    });
    if (sell.ageMinutes != null && (worst == null || sell.ageMinutes > worst)) worst = sell.ageMinutes;
    return worst;
  }

  /**
   * Evaluate a recipe across every allowed crafting city and keep the best.
   * The full per-city list is attached as `alternatives` for expanded rows.
   */
  Calc.evaluateBest = function (recipe, prices, settings) {
    var rows = [];
    settings.activeCities.forEach(function (city) {
      var r = Calc.evaluateInCity(recipe, prices, city, settings);
      if (r) rows.push(r);
    });
    if (!rows.length) return null;
    rows.sort(function (a, b) { return b.profit - a.profit; });
    var best = rows[0];
    best.alternatives = rows;
    return best;
  };

  Calc.evaluateAll = function (recipes, prices, settings) {
    var out = [];
    recipes.forEach(function (r) {
      var row = Calc.evaluateBest(r, prices, settings);
      if (row) out.push(row);
    });
    return out;
  };

  /* ------------------------------------------------------ refining extras */

  /**
   * For a refining recipe, compare "refine then sell" against "sell the raw
   * materials untouched".
   */
  Calc.rawSellAlternative = function (recipe, prices, settings) {
    var total = 0;
    var ok = true;
    recipe.materials.forEach(function (m) {
      var s = Calc.bestSell(prices, m.id, settings.activeCities, settings);
      if (!s) { ok = false; return; }
      var fees = Calc.sellingFees(s.price * m.qty, s.instant, settings);
      total += s.price * m.qty - fees.total;
    });
    return ok ? total : null;
  };

  /* ------------------------------------------------------- transportation */

  /**
   * Flip opportunities: buy in city A, sell in city B.
   * @returns {Array} rows sorted by profit
   */
  Calc.transportOpportunities = function (itemIds, prices, settings) {
    var cities = settings.activeCities;
    var rows = [];
    var transport = settings.transportCost || 0;
    var seen = Object.create(null);

    itemIds.forEach(function (id) {
      if (seen[id]) return; // the same id is referenced by many recipes
      seen[id] = true;
      var byItem = prices[id];
      if (!byItem) return;
      var ceiling = Calc.plausibleCeiling(prices, id, settings);
      var cheapest = null;
      var dearest = null;

      cities.forEach(function (city) {
        var q = byItem[city];
        if (!q) return;
        if (q.sellMin) {
          var buyAge = ageMinutes(q.sellAt);
          if (!settings.maxDataAgeMinutes || buyAge == null || buyAge <= settings.maxDataAgeMinutes) {
            if (!cheapest || q.sellMin < cheapest.price) {
              cheapest = { city: city, price: q.sellMin, ageMinutes: buyAge };
            }
          }
        }
      });

      var sellCities = cities.slice();
      if (settings.includeBlackMarket) sellCities.push(AO.BLACK_MARKET);
      sellCities.forEach(function (city) {
        var q = byItem[city];
        if (!q) return;
        var isBM = city === AO.BLACK_MARKET;
        var price = (isBM || settings.useBuyOrdersForSales) ? q.buyMax : q.sellMin;
        var instant = isBM || settings.useBuyOrdersForSales;
        var age = ageMinutes(instant ? q.buyAt : q.sellAt);
        if (!price) return;
        if (ceiling != null && price > ceiling) return;
        if (settings.maxDataAgeMinutes && age != null && age > settings.maxDataAgeMinutes) return;
        if (!dearest || price > dearest.price) {
          dearest = { city: city, price: price, ageMinutes: age, instant: instant, blackMarket: isBM };
        }
      });

      if (!cheapest || !dearest) return;
      if (cheapest.city === dearest.city) return;

      var fees = Calc.sellingFees(dearest.price, dearest.instant, settings);
      var profit = dearest.price - fees.total - cheapest.price - transport;
      var margin = cheapest.price > 0 ? (profit / cheapest.price) * 100 : 0;

      rows.push({
        itemId: id,
        tier: tierOf(id),
        enchant: enchantOf(id),
        buyCity: cheapest.city,
        buyPrice: cheapest.price,
        sellCity: dearest.city,
        sellPrice: dearest.price,
        blackMarket: dearest.blackMarket,
        fees: fees.total,
        transport: transport,
        profit: profit,
        margin: margin,
        dataAge: Math.max(cheapest.ageMinutes || 0, dearest.ageMinutes || 0),
        // Cheap, high-margin goods move in bulk; expensive gear does not.
        bulk: cheapest.price < 20000
      });
    });

    rows.sort(function (a, b) { return b.profit - a.profit; });
    return rows;
  };

  /* ---------------------------------------------------------- focus optimizer */

  /**
   * Rank every focus-consuming activity by silver per focus point and project
   * a daily total from the user's focus budget.
   */
  Calc.focusRanking = function (rows, settings) {
    var ranked = rows.filter(function (r) {
      return r.focusCost > 0 && r.profitPerFocus != null && isFinite(r.profitPerFocus);
    }).map(function (r) {
      var craftsPerDay = settings.dailyFocus / r.focusCost;
      return {
        row: r,
        name: r.name,
        itemId: r.itemId,
        kind: r.recipe.kind,
        craftCity: r.craftCity,
        focusCost: r.focusCost,
        profit: r.profit,
        profitPerFocus: r.profitPerFocus,
        craftsPerDay: craftsPerDay,
        dailySilver: craftsPerDay * r.profit
      };
    });
    ranked.sort(function (a, b) { return b.profitPerFocus - a.profitPerFocus; });
    return ranked;
  };

  /* ------------------------------------------------------- laborer journals */

  // Journal capacity/value by tier — filling a journal converts crafting fame
  // that would otherwise be wasted into silver.
  var JOURNAL = {
    4: { fame: 3000, buy: 'T4_JOURNAL_TOOLMAKER_EMPTY', sell: 'T4_JOURNAL_TOOLMAKER_FULL' },
    5: { fame: 9000, buy: 'T5_JOURNAL_TOOLMAKER_EMPTY', sell: 'T5_JOURNAL_TOOLMAKER_FULL' },
    6: { fame: 27000, buy: 'T6_JOURNAL_TOOLMAKER_EMPTY', sell: 'T6_JOURNAL_TOOLMAKER_FULL' },
    7: { fame: 81000, buy: 'T7_JOURNAL_TOOLMAKER_EMPTY', sell: 'T7_JOURNAL_TOOLMAKER_FULL' },
    8: { fame: 243000, buy: 'T8_JOURNAL_TOOLMAKER_EMPTY', sell: 'T8_JOURNAL_TOOLMAKER_FULL' }
  };
  Calc.JOURNAL = JOURNAL;

  Calc.journalProfit = function (prices, settings) {
    var out = [];
    Object.keys(JOURNAL).forEach(function (tier) {
      var j = JOURNAL[tier];
      var buy = Calc.bestBuy(prices, j.buy, settings.activeCities, settings);
      var sell = Calc.bestSell(prices, j.sell, settings.activeCities, settings);
      if (!buy || !sell) return;
      var fees = Calc.sellingFees(sell.price, sell.instant, settings);
      var profit = sell.price - fees.total - buy.price;
      out.push({
        tier: parseInt(tier, 10),
        emptyId: j.buy,
        fullId: j.sell,
        fame: j.fame,
        buyCity: buy.city,
        buyPrice: buy.price,
        sellCity: sell.city,
        sellPrice: sell.price,
        fees: fees.total,
        profit: profit,
        silverPerFame: j.fame ? profit / j.fame : 0
      });
    });
    out.sort(function (a, b) { return b.silverPerFame - a.silverPerFame; });
    return out;
  };

}(window.AO = window.AO || {}));
