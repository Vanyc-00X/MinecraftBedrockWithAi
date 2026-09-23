/**
 * Autonomous village/band life for Neiro AI Mobs.
 * Roles, golems, repairs, reactions, raids, gang leaders, quests, day schedule.
 */

import { system, world } from "@minecraft/server";
import { getSchematic } from "./schematics.js";

var settlements = [];
var playerQuests = {};
var lastRaidAt = 0;
var lastGangOrderAt = 0;
var lastSchedulePulse = 0;
var lastGolemCheck = 0;
var lastRepairAt = 0;
var reactionCooldown = {};
var simTick = 0;
var autoSeedDone = false;
var autoSeedInProgress = false;

var ROLE_ELDER = "elder";
var ROLE_GUARD = "guard";
var ROLE_BUILDER = "builder";
var ROLE_FRIEND = "friend_people";
var ROLE_LEADER = "leader";
var ROLE_RAIDER = "raider";

export function initAutonomy(api) {
  system.runInterval(function () {
    simTick += 1;
    var players = world.getAllPlayers();
    if (players.length === 0) {
      return;
    }

    if (!autoSeedDone && !autoSeedInProgress && simTick === 8) {
      tryAutoSeedWorld(api, players[0]);
    }

    pulseSchedule(api, players);
    if (simTick % 15 === 0) {
      pulseRepairsAndWalls(api, players);
    }
    if (simTick % 40 === 0) {
      pulseGolems(api, players);
    }
    if (simTick % 20 === 0) {
      pulseGangLeaders(api, players);
    }
    if (simTick % 30 === 0) {
      pulseNightRaids(api, players);
    }
    if (simTick % 50 === 0) {
      pulseQuestHints(api, players);
    }
  }, 10);
}

/**
 * Build default good village + evil monster town near first player and assign roles.
 */
export function tryAutoSeedWorld(api, player) {
  if (autoSeedDone || autoSeedInProgress || !player) {
    return false;
  }
  try {
    if (world.getDynamicProperty && world.getDynamicProperty("neiro_world_seeded") === true) {
      autoSeedDone = true;
      return false;
    }
  } catch (error) {
    // ignore
  }

  autoSeedInProgress = true;
  system.run(function () {
    try {
      seedSettlementAt(api, player, "good", 36, 28);
      seedSettlementAt(api, player, "evil", -42, 34);
      autoSeedDone = true;
      autoSeedInProgress = false;
      try {
        if (world.setDynamicProperty) {
          world.setDynamicProperty("neiro_world_seeded", true);
        }
      } catch (error2) {
        // ignore
      }
      world.sendMessage("§aNeiro: на карте появились добрая деревня и город монстров (роли выданы).");
      player.sendMessage("Добрая деревня ~ +36,+28 от спавна; город монстров ~ -42,+34. Команды: !neiro status / quest");
    } catch (error3) {
      autoSeedInProgress = false;
      player.sendMessage("Neiro auto-seed error: " + error3.message);
    }
  });
  return true;
}

function seedSettlementAt(api, player, side, ox, oz) {
  var base = findSurface(player.dimension, Math.floor(player.location.x) + ox, Math.floor(player.location.z) + oz, Math.floor(player.location.y));
  var schematicId = side === "good" ? "good_house" : "evil_house";
  var houseOffsets = [
    { x: 0, z: 0 },
    { x: 8, z: 0 },
    { x: 0, z: 8 }
  ];

  for (var i = 0; i < houseOffsets.length; i += 1) {
    placeSchematicWorld(api, player, schematicId, base.x + houseOffsets[i].x, base.y, base.z + houseOffsets[i].z);
  }
  // starter walls
  placeSchematicWorld(api, player, "wall", base.x + 6, base.y, base.z - 2);
  placeSchematicWorld(api, player, "wall", base.x - 2, base.y, base.z + 6);

  spawnSettlementMobs(api, player, side, base);
  assignSettlementRoles(api, player, side, base);
  var settlement = registerSettlement(side, base, player.dimension.id);
  settlement.wallBuilt = true;
  settlement.houses = 3;
}

function spawnSettlementMobs(api, player, side, center) {
  var dim = player.dimension;
  var spots = [
    { x: 2, z: 2 },
    { x: 5, z: 3 },
    { x: 3, z: 6 },
    { x: 7, z: 5 },
    { x: 4, z: 4 },
    { x: 6, z: 7 }
  ];

  if (side === "good") {
    var goodTypes = ["minecraft:villager", "minecraft:villager", "minecraft:villager", "minecraft:villager", "minecraft:cat", "minecraft:iron_golem"];
    for (var g = 0; g < goodTypes.length; g += 1) {
      spawnSafe(dim, goodTypes[g], center.x + spots[g].x, center.y + 1, center.z + spots[g].z);
    }
  } else {
    var evilTypes = ["minecraft:zombie", "minecraft:zombie", "minecraft:skeleton", "minecraft:spider", "minecraft:witch", "minecraft:pillager"];
    for (var e = 0; e < evilTypes.length; e += 1) {
      spawnSafe(dim, evilTypes[e], center.x + spots[e].x, center.y + 1, center.z + spots[e].z);
    }
  }
}

function spawnSafe(dimension, typeId, x, y, z) {
  try {
    return dimension.spawnEntity(typeId, { x: x + 0.5, y: y, z: z + 0.5 });
  } catch (error) {
    try {
      // Bedrock sometimes uses villager_v2
      if (typeId === "minecraft:villager") {
        return dimension.spawnEntity("minecraft:villager_v2", { x: x + 0.5, y: y, z: z + 0.5 });
      }
    } catch (error2) {
      // ignore
    }
  }
  return null;
}

function placeSchematicWorld(api, player, schematicId, x, y, z) {
  var schematic = getSchematic(schematicId);
  var anchor = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
  for (var i = 0; i < schematic.blocks.length; i += 1) {
    var b = schematic.blocks[i];
    api.placeBlockAt(player, {
      x: anchor.x + b.x,
      y: anchor.y + b.y,
      z: anchor.z + b.z
    }, b.blockType || schematic.blockType);
  }
}

function findSurface(dimension, x, z, guessY) {
  var y = guessY;
  try {
    for (var i = 0; i < 40; i += 1) {
      var feet = dimension.getBlock({ x: x, y: y, z: z });
      var below = dimension.getBlock({ x: x, y: y - 1, z: z });
      if (feet && isAirish(feet.typeId) && below && !isAirish(below.typeId) && below.typeId !== "minecraft:water" && below.typeId !== "minecraft:lava") {
        return { x: x, y: y, z: z };
      }
      y -= 1;
    }
  } catch (error) {
    // ignore
  }
  return { x: x, y: guessY, z: z };
}

export function registerSettlement(side, center, dimensionId) {
  var id = side + "_" + Math.floor(center.x) + "_" + Math.floor(center.z);
  for (var i = 0; i < settlements.length; i += 1) {
    if (settlements[i].id === id) {
      settlements[i].center = center;
      return settlements[i];
    }
  }
  var settlement = {
    id: id,
    side: side,
    center: { x: center.x, y: center.y, z: center.z },
    dimensionId: dimensionId,
    radius: 28,
    golemSpawned: false,
    wallBuilt: false,
    houses: 3
  };
  settlements.push(settlement);
  return settlement;
}

export function assignSettlementRoles(api, player, side, center) {
  var c = center || player.location;
  var settlement = registerSettlement(side, c, player.dimension.id);
  var entities = player.dimension.getEntities({
    location: c,
    maxDistance: settlement.radius
  });
  var members = [];

  for (var i = 0; i < entities.length; i += 1) {
    var mob = entities[i];
    if (mob.typeId === "minecraft:player") {
      continue;
    }
    if (!isSettlementMember(mob, side) && !willBelong(side, mob.typeId)) {
      continue;
    }
    members.push(mob);
  }

  members.sort(function (a, b) {
    return mindRank(api, b) - mindRank(api, a);
  });

  for (var m = 0; m < members.length; m += 1) {
    clearRoleTags(members[m]);
    if (m === 0) {
      setRole(members[m], side === "good" ? ROLE_ELDER : ROLE_LEADER);
      if (side === "good") {
        api.makeFriend(members[m], player);
      }
    } else if (m <= 2) {
      setRole(members[m], ROLE_GUARD);
      if (side === "good") {
        api.makeFriend(members[m], player);
      }
    } else if (m <= 4) {
      setRole(members[m], ROLE_BUILDER);
      if (side === "good") {
        api.makeFriend(members[m], player);
      }
    } else if (side === "good") {
      setRole(members[m], ROLE_FRIEND);
      api.makeFriend(members[m], player);
    } else {
      setRole(members[m], ROLE_RAIDER);
    }
    api.addTag(members[m], side === "good" ? "neiro_side_good" : "neiro_side_evil");
    api.addTag(members[m], "neiro_social_village");
    api.addTag(members[m], side === "good" ? "neiro_faction_good_village" : "neiro_faction_evil_village");
  }

  return { settlement: settlement, members: members.length };
}

function willBelong(side, typeId) {
  var t = String(typeId || "").replace("minecraft:", "");
  if (side === "good") {
    return t === "villager" || t === "villager_v2" || t === "iron_golem" || t === "cat";
  }
  return ["zombie", "husk", "skeleton", "stray", "creeper", "spider", "pillager", "vindicator", "witch", "evoker", "drowned"].indexOf(t) >= 0;
}

export function offerGeniusQuest(api, player) {
  var nearby = api.listNearbyMobs(player, 16);
  var genius = null;
  for (var i = 0; i < nearby.length; i += 1) {
    var mob = nearby[i].entity;
    var type = api.shortTypeId(mob.typeId);
    var mind = api.getMobMindLocal(mob);
    var isGenius = mind.intelligence === "genius" || type === "witch" || type === "villager" && hasRole(mob, ROLE_ELDER);
    if (isGenius) {
      genius = mob;
      break;
    }
  }
  if (!genius) {
    player.sendMessage("Рядом нет гения (ведьма/староста), кто мог бы дать квест.");
    return;
  }

  var quest = rollQuest(genius, api);
  playerQuests[player.id] = quest;
  var name = api.stripFriendPrefix(genius.nameTag || "") || api.shortTypeId(genius.typeId);
  player.sendMessage("<" + name + "/квест> " + quest.text);
  player.sendMessage("Цель: " + quest.objective + " | Награда: " + quest.rewardText);
}

export function checkQuestProgress(api, player) {
  var quest = playerQuests[player.id];
  if (!quest || quest.done) {
    return;
  }
  if (quest.type === "bring_item") {
    // completed via deposit/chat keywords
    return;
  }
  if (quest.type === "kill_type") {
    // progress updated when hostile dies near player during raid/combat hooks
    if (quest.progress >= quest.need) {
      completeQuest(api, player, quest);
    }
  }
  if (quest.type === "visit_settle") {
    var side = quest.side;
    for (var i = 0; i < settlements.length; i += 1) {
      var s = settlements[i];
      if (s.side === side && dist(player.location, s.center) <= s.radius) {
        completeQuest(api, player, quest);
        return;
      }
    }
  }
}

export function onMobHurtReaction(api, hurt, damaging, damageCause) {
  if (!hurt || hurt.typeId === "minecraft:player") {
    return;
  }
  var key = hurt.id + ":hurt";
  if (isCooling(key, 8000)) {
    return;
  }

  var cause = String(damageCause || "").toLowerCase();
  var onFire = cause.indexOf("fire") >= 0 || cause.indexOf("lava") >= 0 || cause.indexOf("magma") >= 0;

  if (onFire) {
    reactFire(api, hurt);
    return;
  }

  if (damaging && damaging.typeId === "minecraft:player") {
    // betrayal already handled elsewhere for friends
    return;
  }

  if (damaging && damaging.typeId !== "minecraft:player") {
    reactAttackedByMob(api, hurt, damaging);
  }
}

export function onNightOrFireAmbient(api, players) {
  // called optionally; main pulse handles night
}

function pulseSchedule(api, players) {
  var now = Date.now();
  if (now - lastSchedulePulse < 4000) {
    return;
  }
  lastSchedulePulse = now;

  var tod = getTimeOfDay();
  var phase = dayPhase(tod); // sleep | work | patrol | night

  for (var p = 0; p < players.length; p += 1) {
    var player = players[p];
    for (var s = 0; s < settlements.length; s += 1) {
      var settlement = settlements[s];
      if (settlement.dimensionId !== player.dimension.id) {
        continue;
      }
      if (dist(player.location, settlement.center) > 64) {
        continue;
      }
      applyScheduleToSettlement(api, player, settlement, phase);
    }
  }
}

function applyScheduleToSettlement(api, player, settlement, phase) {
  var mobs = player.dimension.getEntities({
    location: settlement.center,
    maxDistance: settlement.radius
  });

  for (var i = 0; i < mobs.length; i += 1) {
    var mob = mobs[i];
    if (mob.typeId === "minecraft:player") {
      continue;
    }
    if (!isSettlementMember(mob, settlement.side)) {
      continue;
    }
    if (api.mobTasks[mob.id]) {
      continue;
    }

    if (phase === "sleep") {
      // gather near house center
      if (dist(mob.location, settlement.center) > 6) {
        api.stepTowardWithAvoid(mob, settlement.center, 1.1);
      }
      continue;
    }

    if (phase === "work") {
      if (hasRole(mob, ROLE_BUILDER) || hasRole(mob, ROLE_FRIEND) || hasRole(mob, ROLE_ELDER)) {
        // wander / stay near center for work pulse
        if (Math.random() < 0.3) {
          api.stepTowardWithAvoid(mob, offset(settlement.center, rnd(-4, 4), 0, rnd(-4, 4)), 1.0);
        }
      }
      if (hasRole(mob, ROLE_GUARD)) {
        patrolAround(api, mob, settlement.center, 8);
      }
      continue;
    }

    if (phase === "patrol" || phase === "night") {
      if (hasRole(mob, ROLE_GUARD) || hasRole(mob, ROLE_LEADER) || hasRole(mob, ROLE_RAIDER)) {
        patrolAround(api, mob, settlement.center, phase === "night" ? 12 : 10);
      } else if (settlement.side === "good" && phase === "night") {
        // civilians seek center
        if (dist(mob.location, settlement.center) > 5) {
          api.stepTowardWithAvoid(mob, settlement.center, 1.2);
        }
      }
    }
  }
}

function pulseRepairsAndWalls(api, players) {
  var now = Date.now();
  if (now - lastRepairAt < 12000) {
    return;
  }
  lastRepairAt = now;

  for (var p = 0; p < players.length; p += 1) {
    var player = players[p];
    for (var s = 0; s < settlements.length; s += 1) {
      var settlement = settlements[s];
      if (settlement.dimensionId !== player.dimension.id) {
        continue;
      }
      if (dist(player.location, settlement.center) > 48) {
        continue;
      }

      var builders = findRoleNear(api, player, settlement, ROLE_BUILDER);
      if (!builders.length && settlement.side === "good") {
        builders = findRoleNear(api, player, settlement, ROLE_FRIEND);
      }
      if (!builders.length) {
        continue;
      }

      if (!settlement.wallBuilt) {
        var builder = builders[0];
        placeSchematicAt(api, player, settlement.side === "good" ? "wall" : "wall", settlement.center.x + 6, settlement.center.z - 2);
        placeSchematicAt(api, player, "wall", settlement.center.x - 2, settlement.center.z + 6);
        settlement.wallBuilt = true;
        player.sendMessage("Строители " + (settlement.side === "good" ? "деревни" : "города монстров") + " возводят стены.");
        continue;
      }

      // repair: replace air gaps near houses with planks/nether brick
      repairNear(api, player, settlement, builders[0]);
    }
  }
}

function pulseGolems(api, players) {
  var now = Date.now();
  if (now - lastGolemCheck < 20000) {
    return;
  }
  lastGolemCheck = now;

  for (var p = 0; p < players.length; p += 1) {
    var player = players[p];
    for (var s = 0; s < settlements.length; s += 1) {
      var settlement = settlements[s];
      if (settlement.side !== "good") {
        continue;
      }
      if (settlement.dimensionId !== player.dimension.id) {
        continue;
      }
      if (dist(player.location, settlement.center) > 48) {
        continue;
      }
      if (settlement.golemSpawned) {
        // refresh flag if golem gone
        var golems = player.dimension.getEntities({
          type: "minecraft:iron_golem",
          location: settlement.center,
          maxDistance: settlement.radius
        });
        if (golems.length > 0) {
          continue;
        }
        settlement.golemSpawned = false;
      }

      var elder = findRoleNear(api, player, settlement, ROLE_ELDER)[0];
      var villagers = countTypeNear(player, settlement, "minecraft:villager");
      if (villagers >= 2 && elder) {
        try {
          var loc = {
            x: settlement.center.x + 1.5,
            y: settlement.center.y,
            z: settlement.center.z + 1.5
          };
          var golem = player.dimension.spawnEntity("minecraft:iron_golem", loc);
          api.addTag(golem, "neiro_side_good");
          api.addTag(golem, "neiro_faction_good_village");
          api.addTag(golem, "neiro_role_guard");
          api.makeFriend(golem, player);
          settlement.golemSpawned = true;
          player.sendMessage("Жители деревни создали железного голема-стража!");
        } catch (error) {
          player.sendMessage("Не удалось создать голема: " + error.message);
        }
      }
    }
  }
}

function pulseGangLeaders(api, players) {
  var now = Date.now();
  if (now - lastGangOrderAt < 15000) {
    return;
  }
  lastGangOrderAt = now;

  for (var p = 0; p < players.length; p += 1) {
    var player = players[p];
    for (var s = 0; s < settlements.length; s += 1) {
      var settlement = settlements[s];
      if (settlement.side !== "evil") {
        continue;
      }
      if (settlement.dimensionId !== player.dimension.id) {
        continue;
      }
      if (dist(player.location, settlement.center) > 56) {
        continue;
      }

      var leader = findRoleNear(api, player, settlement, ROLE_LEADER)[0];
      if (!leader) {
        continue;
      }

      var raiders = findRoleNear(api, player, settlement, ROLE_RAIDER);
      if (!raiders.length) {
        raiders = findHostileMembers(api, player, settlement);
      }

      // Order: guard camp OR hunt nearest good villager/player friend
      var target = findNearestEnemyOfEvil(api, player, settlement);
      var order = target ? "attack" : "patrol";
      for (var r = 0; r < Math.min(raiders.length, 4); r += 1) {
        var mob = raiders[r];
        if (api.mobTasks[mob.id]) {
          continue;
        }
        if (order === "attack" && target) {
          api.assignMobTask(mob, player, {
            type: "attack_entity",
            targetType: target.typeId,
            targetEntityId: target.id,
            ownerId: player.id,
            ownerName: player.name,
            autonomous: true
          });
        } else {
          patrolAround(api, mob, settlement.center, 10);
        }
      }

      if (Math.random() < 0.35) {
        var lname = api.stripFriendPrefix(leader.nameTag || "") || api.shortTypeId(leader.typeId);
        player.sendMessage("<" + lname + "/лидер банды> " + (order === "attack" ? "В атаку по чужакам!" : "Патрулировать логово."));
      }
    }
  }
}

function pulseNightRaids(api, players) {
  var tod = getTimeOfDay();
  if (!(tod >= 13000 && tod <= 23000)) {
    return;
  }
  var now = Date.now();
  if (now - lastRaidAt < 45000) {
    return;
  }

  var good = null;
  var evil = null;
  for (var i = 0; i < settlements.length; i += 1) {
    if (settlements[i].side === "good") {
      good = settlements[i];
    }
    if (settlements[i].side === "evil") {
      evil = settlements[i];
    }
  }
  if (!good || !evil) {
    return;
  }

  // need a player near either settlement
  var witness = null;
  for (var p = 0; p < players.length; p += 1) {
    if (dist(players[p].location, good.center) < 70 || dist(players[p].location, evil.center) < 70) {
      witness = players[p];
      break;
    }
  }
  if (!witness) {
    return;
  }
  if (good.dimensionId !== witness.dimension.id || evil.dimensionId !== witness.dimension.id) {
    return;
  }

  lastRaidAt = now;
  var direction = Math.random() < 0.55 ? "evil_to_good" : "good_to_evil";
  if (direction === "evil_to_good") {
    launchRaid(api, witness, evil, good, "evil");
    witness.sendMessage("§cНочной рейд! Город монстров атакует добрую деревню!");
  } else {
    launchRaid(api, witness, good, evil, "good");
    witness.sendMessage("§aСтражи деревни выступают в ночной контрудар по городу монстров!");
  }
}

function launchRaid(api, player, fromSettle, toSettle, side) {
  var attackers = [];
  var entities = player.dimension.getEntities({
    location: fromSettle.center,
    maxDistance: fromSettle.radius
  });
  for (var i = 0; i < entities.length; i += 1) {
    var e = entities[i];
    if (e.typeId === "minecraft:player") {
      continue;
    }
    if (!isSettlementMember(e, side)) {
      continue;
    }
    if (side === "good" && !(hasRole(e, ROLE_GUARD) || e.typeId === "minecraft:iron_golem" || hasRole(e, ROLE_ELDER))) {
      continue;
    }
    attackers.push(e);
    if (attackers.length >= 5) {
      break;
    }
  }

  for (var a = 0; a < attackers.length; a += 1) {
    var mob = attackers[a];
    api.clearMobTask(mob);
    api.assignMobTask(mob, player, {
      type: "raid_move",
      target: { x: toSettle.center.x, y: toSettle.center.y, z: toSettle.center.z },
      side: side,
      ownerId: player.id,
      ownerName: player.name,
      autonomous: true,
      ticks: 0
    });
  }
}

export function tickRaidMoveTask(api, mob, task, owner) {
  task.ticks = (task.ticks || 0) + 1;
  var target = task.target;
  if (!target) {
    api.clearMobTask(mob);
    return;
  }
  var d = dist(mob.location, target);
  if (d > 3.5) {
    api.stepTowardWithAvoid(mob, target, 1.4);
    if (task.ticks > 200) {
      api.clearMobTask(mob);
    }
    return;
  }

  // arrived: attack nearest opposite
  var enemy = findRaidEnemy(api, mob, task.side);
  if (enemy) {
    api.assignMobTask(mob, owner || mob, {
      type: "attack_entity",
      targetType: enemy.typeId,
      targetEntityId: enemy.id,
      ownerId: task.ownerId,
      ownerName: task.ownerName,
      autonomous: true
    });
  } else {
    api.clearMobTask(mob);
  }
}

function pulseQuestHints(api, players) {
  for (var p = 0; p < players.length; p += 1) {
    checkQuestProgress(api, players[p]);
  }
}

function reactFire(api, mob) {
  var key = mob.id + ":fire";
  markCool(key);
  // run toward water or just flee randomly + message to nearby players
  var flee = offset(mob.location, rnd(-6, 6), 0, rnd(-6, 6));
  api.stepTowardWithAvoid(mob, flee, 1.5);
  notifyNear(mob, api.shortTypeId(mob.typeId) + " горит и паникует!");
  if (hasRole(mob, ROLE_GUARD) || hasRole(mob, ROLE_BUILDER)) {
    // try stomp / move
  }
}

function reactAttackedByMob(api, hurt, damaging) {
  var key = hurt.id + ":atk";
  markCool(key);

  if (hurt.hasTag("neiro_side_good") && damaging.hasTag("neiro_side_evil")) {
    // call guards
    callGuards(api, hurt, damaging, "good");
    notifyNear(hurt, "Деревня поднимает тревогу!");
  } else if (hurt.hasTag("neiro_side_evil") && damaging.hasTag("neiro_side_good")) {
    callGuards(api, hurt, damaging, "evil");
    notifyNear(hurt, "Банда отвечает ударом!");
  } else if (hurt.hasTag("neiro_friend") || hurt.hasTag("neiro_side_good")) {
    // defend ally logic if player friends nearby handled elsewhere
  }
}

function callGuards(api, victim, enemy, side) {
  var players = world.getAllPlayers();
  if (!players.length) {
    return;
  }
  var player = players[0];
  for (var i = 0; i < players.length; i += 1) {
    if (players[i].dimension.id === victim.dimension.id) {
      player = players[i];
      break;
    }
  }
  var guards = victim.dimension.getEntities({
    location: victim.location,
    maxDistance: 24
  });
  var count = 0;
  for (var g = 0; g < guards.length; g += 1) {
    var mob = guards[g];
    if (!isSettlementMember(mob, side)) {
      continue;
    }
    if (!(hasRole(mob, ROLE_GUARD) || hasRole(mob, ROLE_LEADER) || mob.typeId === "minecraft:iron_golem" || hasRole(mob, ROLE_RAIDER))) {
      continue;
    }
    api.assignMobTask(mob, player, {
      type: "attack_entity",
      targetType: enemy.typeId,
      targetEntityId: enemy.id,
      ownerId: player.id,
      ownerName: player.name,
      autonomous: true
    });
    count += 1;
    if (count >= 4) {
      break;
    }
  }
}

function rollQuest(genius, api) {
  var type = api.shortTypeId(genius.typeId);
  var roll = Math.floor(Math.random() * 3);
  if (type === "witch" || roll === 0) {
    return {
      id: "witch_bones",
      type: "kill_type",
      need: 2,
      progress: 0,
      targetType: "minecraft:skeleton",
      text: "Принеси тишину: уничтожь 2 скелета у границ.",
      objective: "убить скелетов 0/2",
      rewardText: "расположение ведьмы + слух о сокровище"
    };
  }
  if (roll === 1) {
    return {
      id: "visit_evil",
      type: "visit_settle",
      side: "evil",
      text: "Разведка: дойди до города монстров и вернись с вестью.",
      objective: "посетить город монстров",
      rewardText: "староста откроет дружбу стражей"
    };
  }
  return {
    id: "defend",
    type: "kill_type",
    need: 3,
    progress: 0,
    targetType: "minecraft:zombie",
    text: "Защити деревню: порази 3 зомби.",
    objective: "убить зомби 0/3",
    rewardText: "статус друга деревни"
  };
}

function completeQuest(api, player, quest) {
  quest.done = true;
  player.sendMessage("§aКвест выполнен: " + quest.id);
  player.sendMessage("Награда: " + quest.rewardText);
  if (quest.id === "visit_evil" || quest.id === "defend") {
    var nearby = api.listNearbyMobs(player, 20);
    for (var i = 0; i < nearby.length; i += 1) {
      var mob = nearby[i].entity;
      if (mob.hasTag("neiro_side_good")) {
        api.makeFriend(mob, player);
      }
    }
  }
  delete playerQuests[player.id];
}

export function noteKillForQuests(api, killerPlayer, deadTypeId) {
  if (!killerPlayer) {
    return;
  }
  var quest = playerQuests[killerPlayer.id];
  if (!quest || quest.type !== "kill_type" || quest.done) {
    return;
  }
  if (deadTypeId !== quest.targetType) {
    return;
  }
  quest.progress += 1;
  quest.objective = "убить " + api.shortTypeId(quest.targetType) + " " + quest.progress + "/" + quest.need;
  killerPlayer.sendMessage("Квест: " + quest.objective);
  if (quest.progress >= quest.need) {
    completeQuest(api, killerPlayer, quest);
  }
}

function repairNear(api, player, settlement, builder) {
  var blockType = settlement.side === "good" ? "minecraft:oak_planks" : "minecraft:nether_bricks";
  var base = settlement.center;
  var fixed = 0;
  for (var dx = -8; dx <= 8 && fixed < 3; dx += 1) {
    for (var dz = -8; dz <= 8 && fixed < 3; dz += 1) {
      var loc = { x: Math.floor(base.x) + dx, y: Math.floor(base.y), z: Math.floor(base.z) + dz };
      try {
        var block = player.dimension.getBlock(loc);
        var below = player.dimension.getBlock({ x: loc.x, y: loc.y - 1, z: loc.z });
        if (block && isAirish(block.typeId) && below && !isAirish(below.typeId)) {
          // only repair if adjacent to settlement materials (simple heuristic)
          if (Math.abs(dx) + Math.abs(dz) < 3) {
            continue;
          }
          api.placeBlockAt(builder, loc, blockType);
          fixed += 1;
        }
      } catch (error) {
        // ignore
      }
    }
  }
  if (fixed > 0) {
    player.sendMessage("Строители чинят строения (" + fixed + ").");
  }
}

function placeSchematicAt(api, player, schematicId, x, z) {
  var schematic = getSchematic(schematicId);
  var anchor = { x: Math.floor(x), y: Math.floor(player.location.y), z: Math.floor(z) };
  for (var i = 0; i < schematic.blocks.length; i += 1) {
    var b = schematic.blocks[i];
    api.placeBlockAt(player, {
      x: anchor.x + b.x,
      y: anchor.y + b.y,
      z: anchor.z + b.z
    }, b.blockType || schematic.blockType);
  }
}

function findRoleNear(api, player, settlement, role) {
  var list = [];
  var entities = player.dimension.getEntities({
    location: settlement.center,
    maxDistance: settlement.radius
  });
  for (var i = 0; i < entities.length; i += 1) {
    var e = entities[i];
    if (hasRole(e, role) && isSettlementMember(e, settlement.side)) {
      list.push(e);
    }
  }
  return list;
}

function findHostileMembers(api, player, settlement) {
  var list = [];
  var entities = player.dimension.getEntities({
    location: settlement.center,
    maxDistance: settlement.radius
  });
  for (var i = 0; i < entities.length; i += 1) {
    var e = entities[i];
    if (e.typeId === "minecraft:player") {
      continue;
    }
    if (isSettlementMember(e, settlement.side)) {
      list.push(e);
    }
  }
  return list;
}

function findNearestEnemyOfEvil(api, player, settlement) {
  var entities = player.dimension.getEntities({
    location: settlement.center,
    maxDistance: 40
  });
  var best = null;
  var bestD = 99999;
  for (var i = 0; i < entities.length; i += 1) {
    var e = entities[i];
    if (e.hasTag("neiro_side_good") || e.typeId === "minecraft:villager" || e.typeId === "minecraft:iron_golem") {
      var d = dist(settlement.center, e.location);
      if (d < bestD) {
        best = e;
        bestD = d;
      }
    }
  }
  return best;
}

function findRaidEnemy(api, mob, side) {
  var entities = mob.dimension.getEntities({
    location: mob.location,
    maxDistance: 16
  });
  var best = null;
  var bestD = 99999;
  for (var i = 0; i < entities.length; i += 1) {
    var e = entities[i];
    if (e.id === mob.id) {
      continue;
    }
    var opposite = side === "good" ? e.hasTag("neiro_side_evil") : e.hasTag("neiro_side_good");
    if (!opposite && side === "good") {
      opposite = ["zombie", "skeleton", "creeper", "spider", "pillager"].indexOf(api.shortTypeId(e.typeId)) >= 0;
    }
    if (!opposite && side === "evil") {
      opposite = e.typeId === "minecraft:villager" || e.typeId === "minecraft:iron_golem" || e.hasTag("neiro_side_good");
    }
    if (!opposite) {
      continue;
    }
    var d = dist(mob.location, e.location);
    if (d < bestD) {
      best = e;
      bestD = d;
    }
  }
  return best;
}

function countTypeNear(player, settlement, typeId) {
  return player.dimension.getEntities({
    type: typeId,
    location: settlement.center,
    maxDistance: settlement.radius
  }).length;
}

function patrolAround(api, mob, center, radius) {
  var ang = Math.random() * Math.PI * 2;
  var target = {
    x: center.x + Math.cos(ang) * radius,
    y: center.y,
    z: center.z + Math.sin(ang) * radius
  };
  api.stepTowardWithAvoid(mob, target, 1.2);
}

function isSettlementMember(mob, side) {
  if (side === "good") {
    return mob.hasTag("neiro_side_good") || mob.hasTag("neiro_faction_good_village") || mob.typeId === "minecraft:villager" || mob.typeId === "minecraft:villager_v2" || mob.typeId === "minecraft:iron_golem";
  }
  return mob.hasTag("neiro_side_evil") || mob.hasTag("neiro_faction_evil_village") || isEvilType(mob.typeId);
}

function isEvilType(typeId) {
  var t = String(typeId || "").replace("minecraft:", "");
  return ["zombie", "husk", "skeleton", "stray", "creeper", "spider", "pillager", "vindicator", "witch", "evoker", "drowned"].indexOf(t) >= 0;
}

function setRole(mob, role) {
  clearRoleTags(mob);
  try {
    mob.addTag("neiro_role_" + role);
  } catch (error) {
    // ignore
  }
}

function clearRoleTags(mob) {
  var roles = [ROLE_ELDER, ROLE_GUARD, ROLE_BUILDER, ROLE_FRIEND, ROLE_LEADER, ROLE_RAIDER];
  for (var i = 0; i < roles.length; i += 1) {
    try {
      if (mob.hasTag("neiro_role_" + roles[i])) {
        mob.removeTag("neiro_role_" + roles[i]);
      }
    } catch (error) {
      // ignore
    }
  }
}

function hasRole(mob, role) {
  try {
    return mob.hasTag("neiro_role_" + role);
  } catch (error) {
    return false;
  }
}

function mindRank(api, mob) {
  var mind = api.getMobMindLocal(mob);
  var map = { none: 0, spark: 1, basic: 2, smart: 3, genius: 4 };
  return map[mind.intelligence] || 1;
}

function getTimeOfDay() {
  try {
    if (typeof world.getTimeOfDay === "function") {
      return world.getTimeOfDay();
    }
  } catch (error) {
    // fall through
  }
  try {
    return world.getAbsoluteTime() % 24000;
  } catch (error2) {
    return (system.currentTick * 1) % 24000;
  }
}

function dayPhase(tod) {
  // Bedrock: 0 dawn, 6000 noon, 12000 sunset, 18000 midnight
  if (tod >= 13000 && tod < 23000) {
    return "night";
  }
  if (tod >= 23000 || tod < 2000) {
    return "sleep";
  }
  if (tod >= 2000 && tod < 10000) {
    return "work";
  }
  return "patrol";
}

function dist(a, b) {
  var dx = a.x - b.x;
  var dy = (a.y || 0) - (b.y || 0);
  var dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function offset(loc, x, y, z) {
  return { x: loc.x + x, y: loc.y + y, z: loc.z + z };
}

function rnd(a, b) {
  return a + Math.floor(Math.random() * (b - a + 1));
}

function isAirish(typeId) {
  return typeId === "minecraft:air" || typeId === "minecraft:short_grass" || typeId === "minecraft:tall_grass" || typeId === "minecraft:snow_layer";
}

function isCooling(key, ms) {
  var now = Date.now();
  if (reactionCooldown[key] && now - reactionCooldown[key] < ms) {
    return true;
  }
  reactionCooldown[key] = now;
  return false;
}

function markCool(key) {
  reactionCooldown[key] = Date.now();
}

function notifyNear(entity, message) {
  var players = world.getAllPlayers();
  for (var i = 0; i < players.length; i += 1) {
    var p = players[i];
    if (p.dimension.id !== entity.dimension.id) {
      continue;
    }
    if (dist(p.location, entity.location) <= 40) {
      p.sendMessage(message);
    }
  }
}

export function getSettlements() {
  return settlements;
}

export function getPlayerQuest(playerId) {
  return playerQuests[playerId] || null;
}
