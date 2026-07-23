/* ==========================================================================
   config.js — static game data, constants and default tuning values.
   Everything here is a *default*; the Settings tab can override most of it.
   ========================================================================== */
(function (AO) {
  'use strict';

  AO.API_BASE = 'https://europe.albion-online-data.com';

  AO.ITEM_DUMP_URLS = [
    'https://raw.githubusercontent.com/broderickhyman/ao-bin-dumps/master/formatted/items.json',
    'https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/formatted/items.json'
  ];

  AO.ICON_BASE = 'https://render.albiononline.com/v1/item/';

  /* ---------------------------------------------------------------- cities */

  AO.CITIES = [
    'Thetford',
    'Fort Sterling',
    'Lymhurst',
    'Bridgewatch',
    'Martlock',
    'Caerleon',
    'Brecilien'
  ];

  AO.BLACK_MARKET = 'Black Market';

  // Pseudo-cities used to inject user-entered prices into the price index.
  // Kept separate so a manual buy price never contaminates a manual sell price.
  AO.MANUAL_BUY = 'My buy';
  AO.MANUAL_SELL = 'My sell';

  // The API wants these exact strings in ?locations=
  AO.LOCATION_QUERY = {
    'Thetford': 'Thetford',
    'Fort Sterling': 'Fort Sterling',
    'Lymhurst': 'Lymhurst',
    'Bridgewatch': 'Bridgewatch',
    'Martlock': 'Martlock',
    'Caerleon': 'Caerleon',
    'Brecilien': 'Brecilien',
    'Black Market': 'Black Market'
  };

  /* ------------------------------------------------------- refining bonuses */

  // City that gives the refining bonus for each refined material family.
  AO.REFINE_BONUS_CITY = {
    METALBAR: 'Thetford',
    PLANKS: 'Fort Sterling',
    CLOTH: 'Lymhurst',
    STONEBLOCK: 'Bridgewatch',
    LEATHER: 'Martlock'
  };

  // Crafting bonus city per broad item family. Brecilien has no craft bonus but
  // has the best RRR-adjacent perks; treated as a plain city here.
  AO.CRAFT_BONUS_CITY = {
    PLATE: 'Bridgewatch',
    LEATHER_ARMOR: 'Martlock',
    CLOTH_ARMOR: 'Lymhurst',
    MELEE: 'Thetford',
    RANGED: 'Fort Sterling',
    MAGIC: 'Lymhurst',
    OFFHAND: 'Martlock',
    TOOL: 'Fort Sterling',
    FOOD: 'Caerleon',
    POTION: 'Brecilien'
  };

  /* ------------------------------------------------ resource return rate ---
     Values are the community-standard post-rebalance return rates. They are
     editable in Settings because Sandbox tweaks them from time to time.       */

  AO.DEFAULT_RRR = {
    base: 15.2,          // no focus, no city bonus
    bonusCity: 24.8,     // no focus, crafting/refining in the bonus city
    focus: 43.5,         // focus, no city bonus
    focusBonusCity: 47.9 // focus + bonus city
  };

  // Premium does not change RRR in the live game, but the spec asks for a
  // configurable multiplier so it stays here as an explicit, defaulted knob.
  AO.DEFAULT_PREMIUM_RRR_BONUS = 0;

  /* --------------------------------------------------------- market taxes */

  AO.DEFAULT_TAXES = {
    setupFeePremium: 2.5,   // % of listed value, charged up-front
    setupFeeNormal: 5.0,
    salesFeePremium: 4.0,   // % of sale value
    salesFeeNormal: 8.0
  };

  // Default crafting-station usage fee, expressed as silver per 100 item value
  // (this is how the in-game station tax actually works). Tunable per city.
  AO.DEFAULT_STATION_TAX = {
    'Thetford': 10,
    'Fort Sterling': 10,
    'Lymhurst': 10,
    'Bridgewatch': 10,
    'Martlock': 10,
    'Caerleon': 25,
    'Brecilien': 25
  };

  /* -------------------------------------------------------------- quality */

  AO.QUALITY_NAMES = ['Normal', 'Good', 'Outstanding', 'Excellent', 'Masterpiece'];

  AO.QUALITY_VALUE_MULT = {
    Normal: 1.0,
    Good: 1.1,
    Outstanding: 1.2,
    Excellent: 1.5,
    Masterpiece: 2.0
  };

  /**
   * Quality proc distribution as a function of mastery (0-100).
   * At mastery 0 nearly everything is Normal; at 100 the tail fattens.
   * Returns an object keyed by quality name, values summing to 1.
   */
  AO.qualityDistribution = function (mastery) {
    var m = Math.max(0, Math.min(100, mastery || 0)) / 100;
    var good = 0.12 + 0.18 * m;
    var outstanding = 0.03 + 0.09 * m;
    var excellent = 0.008 + 0.032 * m;
    var masterpiece = 0.002 + 0.010 * m;
    var normal = 1 - (good + outstanding + excellent + masterpiece);
    return {
      Normal: normal,
      Good: good,
      Outstanding: outstanding,
      Excellent: excellent,
      Masterpiece: masterpiece
    };
  };

  AO.averageQualityMultiplier = function (mastery) {
    var d = AO.qualityDistribution(mastery);
    var total = 0;
    AO.QUALITY_NAMES.forEach(function (q) {
      total += d[q] * AO.QUALITY_VALUE_MULT[q];
    });
    return total;
  };

  /* ------------------------------------------------------- data freshness */

  AO.freshnessClass = function (minutes) {
    if (minutes == null || !isFinite(minutes)) return 'fresh-unknown';
    if (minutes < 30) return 'fresh-green';
    if (minutes < 60) return 'fresh-yellow';
    if (minutes < 120) return 'fresh-orange';
    return 'fresh-red';
  };

  AO.TIERS = [2, 3, 4, 5, 6, 7, 8];
  AO.ENCHANTS = [0, 1, 2, 3];

  /**
   * Human-readable name for an item id, resolved from the localized name dump.
   * Handles the `@n` enchant suffix (the dump only keys the base item), so
   * "T5_2H_FROSTSTAFF@2" becomes "Adept's Frost Staff .2".
   */
  AO.displayName = function (id) {
    var m = /@(\d)$/.exec(id);
    var base = m ? id.slice(0, -2) : id;
    var name = (AO.itemNames && AO.itemNames[base]) || base;
    return m ? name + ' .' + m[1] : name;
  };

}(window.AO = window.AO || {}));
