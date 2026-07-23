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

  // Focus cost roughly doubles per tier and per enchant level.
  function focusForRefine(tier, ench) {
    return Math.round(4 * Math.pow(2, tier - 2) * Math.pow(2, ench));
  }
  function focusForCraft(tier, ench, unitMats) {
    return Math.round(unitMats * 0.6 * Math.pow(2, tier - 2) * Math.pow(2, ench));
  }

  /* ------------------------------------------------------------- equipment */

  // Each template: base id fragment -> material mix (family -> qty) + category.
  // Quantities are for a single craft of one item.
  var EQUIP_TEMPLATES = [
    // --- plate armor
    { base: 'HEAD_PLATE_SET1', name: 'Soldier Helmet', cat: 'PLATE', mats: { METALBAR: 8 } },
    { base: 'ARMOR_PLATE_SET1', name: 'Soldier Armor', cat: 'PLATE', mats: { METALBAR: 16 } },
    { base: 'SHOES_PLATE_SET1', name: 'Soldier Boots', cat: 'PLATE', mats: { METALBAR: 8 } },
    { base: 'HEAD_PLATE_SET2', name: 'Knight Helmet', cat: 'PLATE', mats: { METALBAR: 4, LEATHER: 4 } },
    { base: 'ARMOR_PLATE_SET2', name: 'Knight Armor', cat: 'PLATE', mats: { METALBAR: 8, LEATHER: 8 } },
    { base: 'SHOES_PLATE_SET2', name: 'Knight Boots', cat: 'PLATE', mats: { METALBAR: 4, LEATHER: 4 } },
    { base: 'HEAD_PLATE_SET3', name: 'Guardian Helmet', cat: 'PLATE', mats: { METALBAR: 4, CLOTH: 4 } },
    { base: 'ARMOR_PLATE_SET3', name: 'Guardian Armor', cat: 'PLATE', mats: { METALBAR: 8, CLOTH: 8 } },
    { base: 'SHOES_PLATE_SET3', name: 'Guardian Boots', cat: 'PLATE', mats: { METALBAR: 4, CLOTH: 4 } },
    // --- leather armor
    { base: 'HEAD_LEATHER_SET1', name: 'Mercenary Hood', cat: 'LEATHER_ARMOR', mats: { LEATHER: 8 } },
    { base: 'ARMOR_LEATHER_SET1', name: 'Mercenary Jacket', cat: 'LEATHER_ARMOR', mats: { LEATHER: 16 } },
    { base: 'SHOES_LEATHER_SET1', name: 'Mercenary Shoes', cat: 'LEATHER_ARMOR', mats: { LEATHER: 8 } },
    { base: 'HEAD_LEATHER_SET2', name: 'Hunter Hood', cat: 'LEATHER_ARMOR', mats: { LEATHER: 4, CLOTH: 4 } },
    { base: 'ARMOR_LEATHER_SET2', name: 'Hunter Jacket', cat: 'LEATHER_ARMOR', mats: { LEATHER: 8, CLOTH: 8 } },
    { base: 'SHOES_LEATHER_SET2', name: 'Hunter Shoes', cat: 'LEATHER_ARMOR', mats: { LEATHER: 4, CLOTH: 4 } },
    { base: 'HEAD_LEATHER_SET3', name: 'Assassin Hood', cat: 'LEATHER_ARMOR', mats: { LEATHER: 4, METALBAR: 4 } },
    { base: 'ARMOR_LEATHER_SET3', name: 'Assassin Jacket', cat: 'LEATHER_ARMOR', mats: { LEATHER: 8, METALBAR: 8 } },
    { base: 'SHOES_LEATHER_SET3', name: 'Assassin Shoes', cat: 'LEATHER_ARMOR', mats: { LEATHER: 4, METALBAR: 4 } },
    // --- cloth armor
    { base: 'HEAD_CLOTH_SET1', name: 'Scholar Cowl', cat: 'CLOTH_ARMOR', mats: { CLOTH: 8 } },
    { base: 'ARMOR_CLOTH_SET1', name: 'Scholar Robe', cat: 'CLOTH_ARMOR', mats: { CLOTH: 16 } },
    { base: 'SHOES_CLOTH_SET1', name: 'Scholar Sandals', cat: 'CLOTH_ARMOR', mats: { CLOTH: 8 } },
    { base: 'HEAD_CLOTH_SET2', name: 'Cleric Cowl', cat: 'CLOTH_ARMOR', mats: { CLOTH: 4, LEATHER: 4 } },
    { base: 'ARMOR_CLOTH_SET2', name: 'Cleric Robe', cat: 'CLOTH_ARMOR', mats: { CLOTH: 8, LEATHER: 8 } },
    { base: 'SHOES_CLOTH_SET2', name: 'Cleric Sandals', cat: 'CLOTH_ARMOR', mats: { CLOTH: 4, LEATHER: 4 } },
    { base: 'HEAD_CLOTH_SET3', name: 'Mage Cowl', cat: 'CLOTH_ARMOR', mats: { CLOTH: 4, METALBAR: 4 } },
    { base: 'ARMOR_CLOTH_SET3', name: 'Mage Robe', cat: 'CLOTH_ARMOR', mats: { CLOTH: 8, METALBAR: 8 } },
    { base: 'SHOES_CLOTH_SET3', name: 'Mage Sandals', cat: 'CLOTH_ARMOR', mats: { CLOTH: 4, METALBAR: 4 } },
    // --- melee weapons
    { base: 'MAIN_SWORD', name: 'Broadsword', cat: 'MELEE', mats: { METALBAR: 16, LEATHER: 8 } },
    { base: '2H_CLAYMORE', name: 'Claymore', cat: 'MELEE', mats: { METALBAR: 20, LEATHER: 12 } },
    { base: 'MAIN_AXE', name: 'Battleaxe', cat: 'MELEE', mats: { METALBAR: 16, PLANKS: 8 } },
    { base: '2H_AXE', name: 'Greataxe', cat: 'MELEE', mats: { METALBAR: 20, PLANKS: 12 } },
    { base: 'MAIN_MACE', name: 'Mace', cat: 'MELEE', mats: { METALBAR: 16, LEATHER: 8 } },
    { base: '2H_MACE', name: 'Heavy Mace', cat: 'MELEE', mats: { METALBAR: 20, LEATHER: 12 } },
    { base: 'MAIN_HAMMER', name: 'Hammer', cat: 'MELEE', mats: { METALBAR: 16, PLANKS: 8 } },
    { base: '2H_POLEHAMMER', name: 'Polehammer', cat: 'MELEE', mats: { METALBAR: 20, PLANKS: 12 } },
    { base: 'MAIN_SPEAR', name: 'Spear', cat: 'MELEE', mats: { METALBAR: 16, PLANKS: 8 } },
    { base: '2H_SPEAR', name: 'Pike', cat: 'MELEE', mats: { METALBAR: 20, PLANKS: 12 } },
    { base: 'MAIN_DAGGER', name: 'Dagger', cat: 'MELEE', mats: { METALBAR: 16, LEATHER: 8 } },
    { base: '2H_DAGGERPAIR', name: 'Dagger Pair', cat: 'MELEE', mats: { METALBAR: 20, LEATHER: 12 } },
    { base: '2H_QUARTERSTAFF', name: 'Quarterstaff', cat: 'MELEE', mats: { PLANKS: 20, METALBAR: 12 } },
    // --- ranged
    { base: '2H_BOW', name: 'Bow', cat: 'RANGED', mats: { PLANKS: 20, LEATHER: 12 } },
    { base: '2H_WARBOW', name: 'Warbow', cat: 'RANGED', mats: { PLANKS: 20, LEATHER: 12 } },
    { base: '2H_LONGBOW', name: 'Longbow', cat: 'RANGED', mats: { PLANKS: 20, LEATHER: 12 } },
    { base: '2H_CROSSBOW', name: 'Crossbow', cat: 'RANGED', mats: { PLANKS: 20, METALBAR: 12 } },
    { base: 'MAIN_1HCROSSBOW', name: 'Light Crossbow', cat: 'RANGED', mats: { PLANKS: 16, METALBAR: 8 } },
    // --- magic
    { base: 'MAIN_FIRESTAFF', name: 'Fire Staff', cat: 'MAGIC', mats: { PLANKS: 16, CLOTH: 8 } },
    { base: '2H_FIRESTAFF', name: 'Great Fire Staff', cat: 'MAGIC', mats: { PLANKS: 20, CLOTH: 12 } },
    { base: 'MAIN_HOLYSTAFF', name: 'Holy Staff', cat: 'MAGIC', mats: { PLANKS: 16, CLOTH: 8 } },
    { base: '2H_HOLYSTAFF', name: 'Great Holy Staff', cat: 'MAGIC', mats: { PLANKS: 20, CLOTH: 12 } },
    { base: 'MAIN_ARCANESTAFF', name: 'Arcane Staff', cat: 'MAGIC', mats: { PLANKS: 16, CLOTH: 8 } },
    { base: '2H_ARCANESTAFF', name: 'Great Arcane Staff', cat: 'MAGIC', mats: { PLANKS: 20, CLOTH: 12 } },
    { base: 'MAIN_FROSTSTAFF', name: 'Frost Staff', cat: 'MAGIC', mats: { PLANKS: 16, CLOTH: 8 } },
    { base: '2H_FROSTSTAFF', name: 'Great Frost Staff', cat: 'MAGIC', mats: { PLANKS: 20, CLOTH: 12 } },
    { base: 'MAIN_CURSEDSTAFF', name: 'Cursed Staff', cat: 'MAGIC', mats: { PLANKS: 16, CLOTH: 8 } },
    { base: '2H_CURSEDSTAFF', name: 'Great Cursed Staff', cat: 'MAGIC', mats: { PLANKS: 20, CLOTH: 12 } },
    { base: 'MAIN_NATURESTAFF', name: 'Nature Staff', cat: 'MAGIC', mats: { PLANKS: 16, CLOTH: 8 } },
    { base: '2H_NATURESTAFF', name: 'Great Nature Staff', cat: 'MAGIC', mats: { PLANKS: 20, CLOTH: 12 } },
    // --- off-hands & accessories
    { base: 'OFF_SHIELD', name: 'Shield', cat: 'OFFHAND', mats: { METALBAR: 8, PLANKS: 8 } },
    { base: 'OFF_TOWERSHIELD', name: 'Tower Shield', cat: 'OFFHAND', mats: { METALBAR: 12, PLANKS: 4 } },
    { base: 'OFF_BOOK', name: 'Tome of Spells', cat: 'OFFHAND', mats: { CLOTH: 8, LEATHER: 8 } },
    { base: 'OFF_TORCH', name: 'Torch', cat: 'OFFHAND', mats: { PLANKS: 8, CLOTH: 8 } },
    { base: 'OFF_HORN', name: 'Horn', cat: 'OFFHAND', mats: { METALBAR: 8, LEATHER: 8 } },
    { base: 'BAG', name: 'Bag', cat: 'OFFHAND', mats: { LEATHER: 8, CLOTH: 8 } },
    { base: 'CAPE', name: 'Cape', cat: 'OFFHAND', mats: { CLOTH: 8, LEATHER: 8 } },
    // --- tools (no enchant line in practice, generated at enchant 0 only)
    { base: '2H_TOOL_PICK', name: 'Pickaxe', cat: 'TOOL', mats: { METALBAR: 12, PLANKS: 8 }, noEnchant: true },
    { base: '2H_TOOL_AXE', name: 'Axe', cat: 'TOOL', mats: { METALBAR: 12, PLANKS: 8 }, noEnchant: true },
    { base: '2H_TOOL_SICKLE', name: 'Sickle', cat: 'TOOL', mats: { METALBAR: 12, PLANKS: 8 }, noEnchant: true },
    { base: '2H_TOOL_HAMMER', name: 'Stone Hammer', cat: 'TOOL', mats: { METALBAR: 12, PLANKS: 8 }, noEnchant: true },
    { base: '2H_TOOL_SKINNINGKNIFE', name: 'Skinning Knife', cat: 'TOOL', mats: { METALBAR: 12, PLANKS: 8 }, noEnchant: true }
  ];
  Recipes.EQUIP_TEMPLATES = EQUIP_TEMPLATES;

  Recipes.buildCrafting = function () {
    var out = [];
    EQUIP_TEMPLATES.forEach(function (tpl) {
      AO.TIERS.forEach(function (tier) {
        if (tier < 4) return; // enchant lines and most gear only matter from T4
        AO.ENCHANTS.forEach(function (ench) {
          if (ench > 0 && tpl.noEnchant) return;
          var mats = [];
          var unitCount = 0;
          Object.keys(tpl.mats).forEach(function (fam) {
            mats.push({ id: itemId(tier, fam, ench), qty: tpl.mats[fam] });
            unitCount += tpl.mats[fam];
          });
          out.push({
            kind: 'crafting',
            category: tpl.cat,
            tier: tier,
            enchant: ench,
            name: 'T' + tier + (ench ? '.' + ench : '') + ' ' + tpl.name,
            resultId: itemId(tier, tpl.base, ench),
            resultQty: 1,
            materials: mats,
            bonusCity: AO.CRAFT_BONUS_CITY[tpl.cat],
            focusCost: focusForCraft(tier, ench, unitCount)
          });
        });
      });
    });
    return out;
  };

  /* --------------------------------------------------------------- cooking */

  // Cooking / alchemy inputs. Unlike ore or hide, farm produce does not exist
  // at every tier — each crop, herb and animal product occupies one fixed tier,
  // so recipes are expressed against these ladders rather than a tier suffix.
  var CROPS = { 1: 'T1_CARROT', 2: 'T2_BEAN', 3: 'T3_WHEAT', 4: 'T4_TURNIP', 5: 'T5_CABBAGE', 6: 'T6_POTATO' };
  var HERBS = { 2: 'T2_AGARIC', 3: 'T3_COMFREY', 4: 'T4_BURDOCK', 5: 'T5_TEASEL', 6: 'T6_FOXGLOVE', 7: 'T7_MULLEIN' };
  var EGGS = { 3: 'T3_EGG', 5: 'T5_EGG' };
  var MILK = { 4: 'T4_MILK', 6: 'T6_MILK', 8: 'T8_MILK' };
  var BUTTER = { 4: 'T4_BUTTER', 6: 'T6_BUTTER', 8: 'T8_BUTTER' };
  Recipes.CROPS = CROPS;
  Recipes.HERBS = HERBS;

  function nearest(ladder, tier) {
    var keys = Object.keys(ladder).map(Number).sort(function (a, b) { return a - b; });
    var pick = keys[0];
    keys.forEach(function (k) { if (k <= tier) pick = k; });
    return ladder[pick];
  }

  // Meals and potions only exist at specific tiers — these are the real ones.
  // Ingredient mixes are editable defaults (see recipeOverrides).
  var COOK_TEMPLATES = [
    { base: 'MEAL_SOUP', name: 'Soup', kind: 'FOOD', tiers: [1, 3, 5], fish: true,
      mats: function (t) { return [{ id: nearest(CROPS, t), qty: 4 }]; } },
    { base: 'MEAL_SALAD', name: 'Salad', kind: 'FOOD', tiers: [2, 4, 6], fish: true,
      mats: function (t) {
        return [{ id: nearest(CROPS, t), qty: 4 }, { id: nearest(CROPS, t - 1), qty: 1 }];
      } },
    { base: 'MEAL_PIE', name: 'Pie', kind: 'FOOD', tiers: [3, 5, 7], fish: true,
      mats: function (t) {
        return [{ id: nearest(CROPS, t), qty: 3 }, { id: 'T3_FLOUR', qty: 1 }];
      } },
    { base: 'MEAL_OMELETTE', name: 'Omelette', kind: 'FOOD', tiers: [3, 5, 7], fish: true,
      mats: function (t) {
        return [{ id: nearest(EGGS, t), qty: 4 }, { id: nearest(CROPS, t), qty: 1 }];
      } },
    { base: 'MEAL_STEW', name: 'Stew', kind: 'FOOD', tiers: [4, 6, 8], fish: true,
      mats: function (t) {
        return [{ id: nearest(MILK, t), qty: 4 }, { id: nearest(CROPS, t), qty: 2 }];
      } },
    { base: 'MEAL_SANDWICH', name: 'Sandwich', kind: 'FOOD', tiers: [4, 6, 8], fish: false,
      mats: function (t) {
        return [{ id: nearest(BUTTER, t), qty: 3 }, { id: nearest(CROPS, t), qty: 2 }];
      } },
    { base: 'POTION_HEAL', name: 'Healing Potion', kind: 'POTION', tiers: [2, 4, 6],
      mats: function (t) { return [{ id: nearest(HERBS, t), qty: 4 }]; } },
    { base: 'POTION_ENERGY', name: 'Energy Potion', kind: 'POTION', tiers: [2, 4, 6],
      mats: function (t) { return [{ id: nearest(HERBS, t), qty: 4 }]; } },
    { base: 'POTION_REVIVE', name: 'Resistance Potion', kind: 'POTION', tiers: [3, 5, 7],
      mats: function (t) { return [{ id: nearest(HERBS, t), qty: 4 }]; } },
    { base: 'POTION_STONESKIN', name: 'Gigantify Potion', kind: 'POTION', tiers: [3, 5, 7],
      mats: function (t) { return [{ id: nearest(HERBS, t), qty: 4 }]; } },
    { base: 'POTION_SLOWFIELD', name: 'Sticky Potion', kind: 'POTION', tiers: [3, 5, 7],
      mats: function (t) { return [{ id: nearest(HERBS, t), qty: 4 }]; } },
    { base: 'POTION_COOLDOWN', name: 'Cleric Potion', kind: 'POTION', tiers: [4, 6, 8],
      mats: function (t) { return [{ id: nearest(HERBS, t), qty: 4 }]; } }
  ];
  Recipes.COOK_TEMPLATES = COOK_TEMPLATES;

  /**
   * @param {boolean} fishSauce  When on, food recipes switch to their `_FISH`
   *   product variant and consume a jar of fish sauce. Fish sauce is a real
   *   item (T1_FISHSAUCE_LEVEL1-3), not a flat silver surcharge.
   */
  Recipes.buildCooking = function (fishSauce) {
    var out = [];
    COOK_TEMPLATES.forEach(function (tpl) {
      tpl.tiers.forEach(function (tier) {
        var useFish = !!fishSauce && tpl.fish;
        var mats = tpl.mats(tier);
        if (useFish) mats = mats.concat([{ id: 'T1_FISHSAUCE_LEVEL1', qty: 1 }]);
        out.push({
          kind: 'cooking',
          category: tpl.kind,
          tier: tier,
          enchant: 0,
          name: 'T' + tier + ' ' + tpl.name + (useFish ? ' (fish sauce)' : ''),
          resultId: 'T' + tier + '_' + tpl.base + (useFish ? '_FISH' : ''),
          resultQty: 1,
          materials: mats,
          bonusCity: AO.CRAFT_BONUS_CITY[tpl.kind],
          focusCost: focusForCraft(tier, 0, 6)
        });
      });
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
