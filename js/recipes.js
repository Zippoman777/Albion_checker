/* ==========================================================================
   recipes.js — recipe generation.

   Refining recipes are exact (they follow a fixed, published progression).
   Equipment recipes follow per-slot templates: these are sane defaults that
   match the shape of the real economy, and every one of them is editable /
   overridable from the Settings tab (see AO.Recipes.applyOverrides).
   ========================================================================== */
(function (AO) {
  'use strict';

  var Recipes = AO.Recipes = {};

  /* -------------------------------------------------------------- refining */

  // family -> { raw: rawItemPrefix, refined: refinedItemPrefix }
  var REFINE_FAMILIES = {
    METALBAR: { raw: 'ORE', refined: 'METALBAR', label: 'Ore → Bar' },
    PLANKS: { raw: 'WOOD', refined: 'PLANKS', label: 'Logs → Planks' },
    LEATHER: { raw: 'HIDE', refined: 'LEATHER', label: 'Hide → Leather' },
    CLOTH: { raw: 'FIBER', refined: 'CLOTH', label: 'Fiber → Cloth' },
    STONEBLOCK: { raw: 'ROCK', refined: 'STONEBLOCK', label: 'Stone → Blocks' }
  };
  Recipes.REFINE_FAMILIES = REFINE_FAMILIES;

  // tier -> { raw: n, lower: n }  (lower = units of previous-tier refined)
  var REFINE_STEPS = {
    2: { raw: 1, lower: 0 },
    3: { raw: 2, lower: 1 },
    4: { raw: 2, lower: 1 },
    5: { raw: 3, lower: 1 },
    6: { raw: 4, lower: 1 },
    7: { raw: 5, lower: 1 },
    8: { raw: 5, lower: 1 }
  };

  function itemId(tier, base, ench) {
    var id = 'T' + tier + '_' + base;
    return ench > 0 ? id + '_LEVEL' + ench + '@' + ench : id;
  }

  /** All refining recipes across tiers 2-8 and enchants 0-3. */
  Recipes.buildRefining = function () {
    var out = [];
    Object.keys(REFINE_FAMILIES).forEach(function (fam) {
      var f = REFINE_FAMILIES[fam];
      AO.TIERS.forEach(function (tier) {
        var step = REFINE_STEPS[tier];
        AO.ENCHANTS.forEach(function (ench) {
          if (ench > 0 && tier < 4) return; // enchanted resources start at T4
          var mats = [];
          mats.push({ id: itemId(tier, f.raw, ench), qty: step.raw });
          if (step.lower > 0) {
            mats.push({ id: itemId(tier - 1, f.refined, ench > 0 ? ench : 0), qty: step.lower });
          }
          out.push({
            kind: 'refining',
            family: fam,
            label: f.label,
            tier: tier,
            enchant: ench,
            resultId: itemId(tier, f.refined, ench),
            resultQty: 1,
            materials: mats,
            bonusCity: AO.REFINE_BONUS_CITY[fam],
            focusCost: focusForRefine(tier, ench)
          });
        });
      });
    });
    return out;
  };

  // Refining focus cost roughly doubles per tier and per enchant level.
  // (Crafting/cooking focus is exact, straight from AO.RECIPE_DATA.)
  function focusForRefine(tier, ench) {
    return Math.round(4 * Math.pow(2, tier - 2) * Math.pow(2, ench));
  }

  /* ---------------------------------------------- crafting & cooking data ---
     Equipment, tool, food and potion recipes come straight from the official
     ao-bin-dumps via js/recipes-data.js (AO.RECIPE_DATA). Each entry is a
     compact tuple: [category, tier, enchant, focus, yield, [[matId,count]...]].
     This is authoritative: exact materials, real focus cost, and the real
     amount produced per craft (potions yield 5, food yields 1, etc.).        */

  var CRAFT_CATS = {
    PLATE: 1, LEATHER_ARMOR: 1, CLOTH_ARMOR: 1, MELEE: 1,
    RANGED: 1, MAGIC: 1, OFFHAND: 1, TOOL: 1
  };

  function recipeFromData(kind, id, tuple) {
    return {
      kind: kind,
      category: tuple[0],
      tier: tuple[1],
      enchant: tuple[2],
      resultId: id,
      resultQty: tuple[4] || 1,
      materials: tuple[5].map(function (m) { return { id: m[0], qty: m[1] }; }),
      bonusCity: AO.CRAFT_BONUS_CITY[tuple[0]],
      focusCost: tuple[3] || 0,
      name: null // resolved from the localized name dump at render time
    };
  }

  /** Every craftable weapon / armour / off-hand / tool from the dump. */
  Recipes.buildCrafting = function () {
    var data = AO.RECIPE_DATA || {};
    var out = [];
    Object.keys(data).forEach(function (id) {
      if (CRAFT_CATS[data[id][0]]) out.push(recipeFromData("crafting", id, data[id]));
    });
    return out;
  };

  /**
   * All food and potion recipes.
   * @param {boolean} fishSauce  When on, each food that has a `_FISH` variant
   *   is swapped for it — the fish version is a distinct item that consumes a
   *   jar of fish sauce and sells higher. Both come from the live market.
   */
  Recipes.buildCooking = function (fishSauce) {
    var data = AO.RECIPE_DATA || {};
    var out = [];
    Object.keys(data).forEach(function (id) {
      var cat = data[id][0];
      if (cat !== "FOOD" && cat !== "POTION") return;
      if (/_FISH$/.test(id)) return; // reached via its base when fish sauce is on
      var useId = id;
      if (fishSauce && cat === "FOOD" && data[id + "_FISH"]) useId = id + "_FISH";
      out.push(recipeFromData("cooking", useId, data[useId]));
    });
    return out;
  };

  /* ------------------------------------------------------------ overrides */

  /**
   * Apply user recipe overrides. `overrides` maps resultId -> array of
   * { id, qty }. Recipes without an override are returned untouched.
   */
  Recipes.applyOverrides = function (recipes, overrides) {
    if (!overrides) return recipes;
    return recipes.map(function (r) {
      var o = overrides[r.resultId];
      if (!o || !o.length) return r;
      var copy = Object.assign({}, r);
      copy.materials = o.slice();
      copy.overridden = true;
      return copy;
    });
  };

  /** Every distinct item id referenced by a set of recipes (inputs + outputs). */
  Recipes.itemIdsFor = function (recipes) {
    var set = Object.create(null);
    recipes.forEach(function (r) {
      set[r.resultId] = true;
      r.materials.forEach(function (m) { set[m.id] = true; });
    });
    return Object.keys(set);
  };

  Recipes.itemId = itemId;

}(window.AO = window.AO || {}));
