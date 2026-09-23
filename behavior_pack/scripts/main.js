import { system, world, ItemStack } from "@minecraft/server";
import { http, HttpHeader, HttpRequest, HttpRequestMethod } from "@minecraft/server-net";
import { ModalFormData } from "@minecraft/server-ui";
import { getSchematic } from "./schematics.js";
import {
  initAutonomy,
  assignSettlementRoles,
  registerSettlement,
  offerGeniusQuest,
  onMobHurtReaction,
  tickRaidMoveTask,
  noteKillForQuests,
  getPlayerQuest,
  checkQuestProgress,
  tryAutoSeedWorld
} from "./autonomy.js";

var BRIDGE_URL = "http://127.0.0.1:32145";
var TALK_PREFIX = "!talk";
var HELP_PREFIX = "!neiro";
var TALK_RANGE = 8;
var ATTACK_RANGE = 48;
var FOLLOW_RANGE = 48;
var WORK_RANGE = 24;
var HUD_RANGE = 24;
var OVERHEAR_COOLDOWN_MS = 12000;
var handledChat = {};
var mobTasks = {};
var mobInventories = {};
var cachedSettings = {
  language: "ru",
  model: "qwen3:14b",
  listenRadius: 8,
  crowdMax: 4,
  aiVolume: 0.7
};
var lastOverhearAt = {};
var friendNameTags = {};
var hudTick = 0;
var campPlaces = {};

var autonomyApi = {
  listNearbyMobs: function (player, range) { return listNearbyMobs(player, range); },
  makeFriend: function (mob, player) { makeFriend(mob, player); },
  addTag: function (entity, tag) { addTag(entity, tag); },
  shortTypeId: function (typeId) { return shortTypeId(typeId); },
  getMobMindLocal: function (mob) { return getMobMindLocal(mob); },
  stripFriendPrefix: function (name) { return stripFriendPrefix(name); },
  stepTowardWithAvoid: function (entity, target, step) { stepTowardWithAvoid(entity, target, step); },
  mobTasks: mobTasks,
  assignMobTask: function (mob, player, task) { assignMobTask(mob, player, task); },
  clearMobTask: function (mob) { clearMobTask(mob); },
  placeBlockAt: function (entity, loc, blockType) { return placeBlockAt(entity, loc, blockType); }
};

system.runTimeout(function () {
  initAutonomy(autonomyApi);
  refreshSettings().then(function () {
    world.sendMessage("Neiro AI Mobs BDS 0.5.0 loaded. Type !neiro.");
  }).catch(function () {
    world.sendMessage("Neiro AI Mobs BDS 0.5.0 loaded (settings offline). Type !neiro.");
  });
}, 40);

if (world.afterEvents.playerSpawn) {
  world.afterEvents.playerSpawn.subscribe(function (event) {
    if (!event.initialSpawn) {
      return;
    }
    system.runTimeout(function () {
      tryAutoSeedWorld(autonomyApi, event.player);
    }, 40);
  });
}

world.beforeEvents.chatSend.subscribe(function (event) {
  if (handleCommand(event.sender, event.message)) {
    event.cancel = true;
    handledChat[event.sender.id] = Date.now();
  }
});

world.afterEvents.chatSend.subscribe(function (event) {
  var key = event.sender.id;
  if (handledChat[key] && Date.now() - handledChat[key] < 1500) {
    delete handledChat[key];
    return;
  }
  if (handleCommand(event.sender, event.message)) {
    return;
  }
  system.run(function () {
    handleOverhear(event.sender, event.message);
  });
});

if (world.beforeEvents.entityHurt) {
  world.beforeEvents.entityHurt.subscribe(function (event) {
    try {
      var hurt = event.hurtEntity;
      var damaging = event.damageSource && event.damageSource.damagingEntity;
      if (!hurt || !damaging) {
        return;
      }
      if (hurt.typeId === "minecraft:player" && shouldProtectPlayerFromMob(damaging, hurt)) {
        event.cancel = true;
      }
    } catch (error) {
      // ignore
    }
  });
}

if (world.afterEvents.entityHurt) {
  world.afterEvents.entityHurt.subscribe(function (event) {
    try {
      var hurt = event.hurtEntity;
      var damaging = event.damageSource && event.damageSource.damagingEntity;
      var cause = event.damageSource && event.damageSource.cause;
      if (!hurt) {
        return;
      }

      if (damaging && damaging.typeId === "minecraft:player" && hurt.typeId !== "minecraft:player") {
        handlePlayerHitMob(damaging, hurt);
      }

      system.run(function () {
        onMobHurtReaction(autonomyApi, hurt, damaging, cause);
      });
    } catch (error) {
      // ignore
    }
  });
}

if (world.afterEvents.entityDie) {
  world.afterEvents.entityDie.subscribe(function (event) {
    try {
      var dead = event.deadEntity;
      var killer = event.damageSource && event.damageSource.damagingEntity;
      if (!dead) {
        return;
      }
      if (killer && killer.typeId === "minecraft:player") {
        noteKillForQuests(autonomyApi, killer, dead.typeId);
      }
    } catch (error) {
      // ignore
    }
  });
}

system.runInterval(function () {
  var players = world.getAllPlayers();
  for (var i = 0; i < players.length; i += 1) {
    keepFollowersNear(players[i]);
  }
  processAttackOrders();
  processMobTasks();
  hudTick += 1;
  if (hudTick % 2 === 0) {
    updateFriendMarkersAndHud(players);
  }
}, 10);

function handleCommand(player, rawMessage) {
  var message = String(rawMessage || "").trim();

  if (message === HELP_PREFIX || message.indexOf(HELP_PREFIX + " ") === 0) {
    system.run(function () {
      handleNeiroCommand(player, message.slice(HELP_PREFIX.length).trim());
    });
    return true;
  }

  if (message === TALK_PREFIX || message.indexOf(TALK_PREFIX + " ") === 0) {
    var rest = message.slice(TALK_PREFIX.length).trim();
    system.run(function () {
      handleTalkCommand(player, rest);
    });
    return true;
  }

  return false;
}

function handleNeiroCommand(player, rest) {
  if (!rest || rest === "help") {
    player.sendMessage("Neiro BDS 0.5.0 — авто-деревни на новой карте");
    player.sendMessage("!talk / !neiro status / settings / set ...");
    player.sendMessage("!neiro village good|evil — поселение вручную");
    player.sendMessage("!neiro quest — квест от ведьмы/старосты");
    player.sendMessage("При первом входе: деревня + город монстров создаются сами");
    return;
  }

  if (rest === "status") {
    showStatus(player);
    var q = getPlayerQuest(player.id);
    if (q && !q.done) {
      player.sendMessage("Квест: " + q.objective);
    }
    return;
  }

  if (rest === "quest" || rest === "квест") {
    offerGeniusQuest(autonomyApi, player);
    return;
  }

  if (rest === "village good" || rest === "settle good" || rest === "деревня добрая") {
    createSettlement(player, "good");
    return;
  }

  if (rest === "village evil" || rest === "settle evil" || rest === "деревня злая") {
    createSettlement(player, "evil");
    return;
  }

  if (rest === "settings") {
    refreshSettings().then(function (settings) {
      player.sendMessage(
        "settings: language=" + settings.language +
        " model=" + settings.model +
        " radius=" + settings.listenRadius +
        " crowd=" + settings.crowdMax +
        " volume=" + settings.aiVolume
      );
    }).catch(function (error) {
      player.sendMessage("settings error: " + error.message);
    });
    return;
  }

  if (rest.indexOf("set ") === 0) {
    var parts = rest.slice(4).trim().split(/\s+/);
    applySettingsCommand(player, parts[0], parts.slice(1).join(" "));
    return;
  }

  player.sendMessage("Неизвестная команда. !neiro help");
}

function applySettingsCommand(player, key, value) {
  var patch = {};
  if (key === "language" || key === "lang") {
    patch.language = value === "en" ? "en" : "ru";
  } else if (key === "model") {
    patch.model = value;
  } else if (key === "radius" || key === "listenRadius") {
    patch.listenRadius = Number(value);
  } else if (key === "crowd" || key === "crowdMax") {
    patch.crowdMax = Number(value);
  } else if (key === "volume" || key === "aiVolume") {
    patch.aiVolume = Number(value);
  } else {
    player.sendMessage("Ключи: language, model, radius, crowd, volume");
    return;
  }

  postJson(BRIDGE_URL + "/settings", patch)
    .then(function (settings) {
      cachedSettings = settings;
      TALK_RANGE = settings.listenRadius || TALK_RANGE;
      player.sendMessage("OK: " + JSON.stringify(settings));
    })
    .catch(function (error) {
      player.sendMessage("set error: " + error.message);
    });
}

function refreshSettings() {
  return getJson(BRIDGE_URL + "/settings").then(function (settings) {
    cachedSettings = settings || cachedSettings;
    TALK_RANGE = cachedSettings.listenRadius || TALK_RANGE;
    return cachedSettings;
  });
}

function showStatus(player) {
  var nearby = listNearbyMobs(player, Math.max(TALK_RANGE, 12)).slice(0, 12);
  if (nearby.length === 0) {
    player.sendMessage("Рядом нет мобов.");
    return;
  }
  player.sendMessage("=== Neiro status ===");
  for (var i = 0; i < nearby.length; i += 1) {
    var item = nearby[i];
    var mob = item.entity;
    var task = mobTasks[mob.id];
    var inv = getMobInventory(mob);
    var invText = inv.length ? inv.map(function (s) { return shortTypeId(s.itemId) + "x" + s.count; }).join(",") : "-";
    var taskText = task ? (task.type + (task.done != null ? (" " + task.done + "/" + (task.count || task.blocks?.length || "?")) : "")) : "-";
    var follow = mob.hasTag("neiro_follow") ? "follow" : "-";
    var mind = getMobMindLocal(mob);
    var role = getRoleLabel(mob);
    player.sendMessage(
      (i + 1) + ") " + item.label +
      " | " + mind.intelligenceLabel + "/" + mind.socialLabel +
      (role ? (" | " + role) : "") +
      " | " + follow + " | task:" + taskText + " | inv:" + invText
    );
  }
}

function createSettlement(player, side) {
  var isGood = side === "good";
  var schematicId = isGood ? "good_house" : "evil_house";
  var placeName = isGood ? "добрая деревня" : "город монстров";
  var center = {
    x: Math.floor(player.location.x),
    y: Math.floor(player.location.y),
    z: Math.floor(player.location.z)
  };
  var offsets = [
    { x: 2, z: 2 },
    { x: 10, z: 2 },
    { x: 2, z: 10 }
  ];

  rememberCamp(player, placeName);
  registerSettlement(side, center, player.dimension.id);

  for (var i = 0; i < offsets.length; i += 1) {
    placeSchematicInstant(player, schematicId, offsets[i].x, offsets[i].z);
  }

  var result = assignSettlementRoles(autonomyApi, player, side, center);
  player.sendMessage(
    (isGood ? "Добрая деревня" : "Злой город монстров") +
    " готова. Домов: " + offsets.length +
    ", ролей выдано: " + result.members +
    " (староста/лидер, стражи, строители" + (isGood ? ", друзья людей" : ", рейдеры") + ")."
  );
  if (isGood) {
    player.sendMessage("Жители могут создать голема, чинить дома и ставить стены. Ночью жди рейдов.");
  } else {
    player.sendMessage("Лидер банды сам раздаёт приказы. Ночью возможны рейды на добрую деревню.");
  }
}

function placeSchematicInstant(player, schematicId, ox, oz) {
  var schematic = getSchematic(schematicId);
  var anchor = {
    x: Math.floor(player.location.x) + ox,
    y: Math.floor(player.location.y),
    z: Math.floor(player.location.z) + oz
  };
  for (var i = 0; i < schematic.blocks.length; i += 1) {
    var b = schematic.blocks[i];
    var loc = { x: anchor.x + b.x, y: anchor.y + b.y, z: anchor.z + b.z };
    placeBlockAt(player, loc, b.blockType || schematic.blockType);
  }
}

var mobMindCache = {};

function getRoleLabel(mob) {
  var roles = [
    ["neiro_role_elder", "староста"],
    ["neiro_role_leader", "лидер"],
    ["neiro_role_guard", "страж"],
    ["neiro_role_builder", "строитель"],
    ["neiro_role_friend_people", "друг людей"],
    ["neiro_role_raider", "рейдер"]
  ];
  for (var i = 0; i < roles.length; i += 1) {
    if (mob.hasTag(roles[i][0])) {
      return roles[i][1];
    }
  }
  return "";
}

function getMobMindLocal(mob) {
  if (mobMindCache[mob.id]) {
    return mobMindCache[mob.id];
  }
  // provisional local guess until bridge replies
  var type = shortTypeId(mob.typeId);
  var mind = {
    intelligence: "basic",
    social: "hermit",
    intelligenceLabel: "с интеллектом",
    socialLabel: "отшельник"
  };
  if (type === "witch" || type === "evoker" || type === "enderman") {
    mind = { intelligence: "genius", social: type === "witch" ? "hermit" : "village", intelligenceLabel: "очень умный", socialLabel: type === "witch" ? "отшельник" : "деревня" };
  } else if (type === "villager") {
    mind = { intelligence: "smart", social: "village", intelligenceLabel: "умный", socialLabel: "деревня" };
  } else if (["chicken", "cow", "pig", "sheep"].indexOf(type) >= 0) {
    mind = { intelligence: "none", social: "pack", intelligenceLabel: "без интеллекта", socialLabel: "стая" };
  } else if (mob.hasTag("neiro_social_village")) {
    mind.social = "village";
    mind.socialLabel = "деревня";
  }
  mobMindCache[mob.id] = mind;
  return mind;
}

function cacheMindFromReply(mob, reply) {
  if (!reply || !reply.mind) {
    return;
  }
  mobMindCache[mob.id] = {
    intelligence: reply.mind.intelligence || "basic",
    social: reply.mind.social || "hermit",
    intelligenceLabel: reply.mind.intelligenceLabel || reply.mind.intelligence,
    socialLabel: reply.mind.socialLabel || reply.mind.social
  };
  addTag(mob, "neiro_intel_" + (reply.mind.intelligence || "basic"));
  addTag(mob, "neiro_social_" + (reply.mind.social || "hermit"));
}

function handleTalkCommand(player, rest) {
  var nearby = listNearbyMobs(player, TALK_RANGE);
  if (nearby.length === 0) {
    player.sendMessage("Рядом нет мобов в радиусе " + TALK_RANGE + " блоков.");
    return;
  }

  if (!rest) {
    openTalkForm(player, nearby, "");
    return;
  }

  if (maybeApplyKeywordOrders(player, rest)) {
    return;
  }

  var parsed = parseTalkArgs(rest, nearby);
  if (parsed.mode === "single") {
    if (!parsed.text) {
      openTalkForm(player, nearby, "", parsed.mob.id);
      return;
    }
    talkToMob(player, parsed.mob, parsed.text);
    return;
  }

  talkToCrowd(player, nearby, parsed.text, "talk");
}

function handleOverhear(player, message) {
  var text = String(message || "").trim();
  if (!text || text.charAt(0) === "!") {
    return;
  }

  var now = Date.now();
  if (lastOverhearAt[player.id] && now - lastOverhearAt[player.id] < OVERHEAR_COOLDOWN_MS) {
    return;
  }

  var radius = cachedSettings.listenRadius || TALK_RANGE;
  var nearby = listNearbyMobs(player, radius);
  if (nearby.length === 0) {
    return;
  }

  var friends = nearby.filter(function (item) {
    return canGiveOrders(item.entity, player) || item.entity.hasTag("neiro_follow");
  });
  var smartish = nearby.filter(function (item) {
    var mind = getMobMindLocal(item.entity);
    return mind.intelligence !== "none";
  });
  var crowdMax = cachedSettings.crowdMax || 4;
  var pool = friends.length ? friends : (smartish.length ? smartish : nearby);
  var crowd = pool.slice(0, crowdMax);
  lastOverhearAt[player.id] = now;
  player.sendMessage("Neiro: мобы рядом подслушивают...");
  talkToCrowd(player, crowd, text, "overhear");
}

function parseTalkArgs(rest, nearby) {
  var parts = String(rest || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { mode: "crowd", mob: null, text: "" };
  }

  var target = parts[0];
  var mob = findMobBySelector(target, nearby);
  if (mob) {
    return {
      mode: "single",
      mob: mob,
      text: parts.slice(1).join(" ").trim()
    };
  }

  return {
    mode: "crowd",
    mob: null,
    text: parts.join(" ").trim()
  };
}

function findMobBySelector(selector, nearby) {
  var raw = String(selector || "").trim().toLowerCase();
  if (!raw) {
    return null;
  }

  if (/^\d+$/.test(raw)) {
    var index = Number(raw) - 1;
    if (index >= 0 && index < nearby.length) {
      return nearby[index].entity;
    }
  }

  for (var i = 0; i < nearby.length; i += 1) {
    var item = nearby[i];
    var shortType = item.shortType.toLowerCase();
    var label = item.label.toLowerCase();
    var nameTag = (item.entity.nameTag || "").toLowerCase();
    if (raw === shortType || raw === label || raw === nameTag || nameTag.indexOf(raw) === 0 || shortType.indexOf(raw) === 0) {
      return item.entity;
    }
  }

  return null;
}

function openTalkForm(player, nearby, presetText, preferredMobId) {
  var options = ["0) Вся толпа (" + nearby.length + ")"];
  var defaultIndex = 0;

  for (var i = 0; i < nearby.length; i += 1) {
    var item = nearby[i];
    options.push((i + 1) + ") " + item.label + " · " + item.distance.toFixed(1) + "м");
    if (preferredMobId && item.entity.id === preferredMobId) {
      defaultIndex = i + 1;
    }
  }

  var form = new ModalFormData()
    .title("Neiro: поговорить")
    .dropdown("Кому сказать", options, { defaultValue: defaultIndex })
    .textField("Сообщение", "Напиши, что сказать", { defaultValue: presetText || "" });

  form.show(player).then(function (response) {
    if (response.canceled) {
      return;
    }

    var values = response.formValues || [];
    var selectedIndex = Number(values[0] || 0);
    var text = String(values[1] || "").trim();

    if (!text) {
      player.sendMessage("Нужно написать сообщение.");
      return;
    }

    if (selectedIndex <= 0) {
      talkToCrowd(player, nearby, text, "talk");
      return;
    }

    var selected = nearby[selectedIndex - 1];
    if (!selected) {
      player.sendMessage("Выбранный моб недоступен.");
      return;
    }

    var liveMob = findEntityById(player, selected.entity.id, TALK_RANGE + 4);
    if (!liveMob) {
      player.sendMessage("Этот моб уже ушёл слишком далеко.");
      return;
    }

    talkToMob(player, liveMob, text);
  }).catch(function (error) {
    player.sendMessage("Не удалось открыть меню: " + error.message);
  });
}

function talkToMob(player, mob, prompt) {
  player.sendMessage("Neiro: отправляю сообщение локальному AI...");

  postJson(BRIDGE_URL + "/chat", {
    player: {
      id: player.id,
      name: player.name,
      location: roundLocation(player.location)
    },
    mob: {
      id: mob.id,
      typeId: mob.typeId,
      nameTag: stripFriendPrefix(mob.nameTag || ""),
      location: roundLocation(mob.location),
      relation: getRelationState(mob, player)
    },
    world: {
      dimension: player.dimension.id
    },
    nearbyPlayers: listNearbyPlayerNames(player, 32),
    nearbyEntities: listNearbyEntityTypes(player, 16),
    message: prompt
  })
    .then(function (reply) {
      var name = reply.mobName || stripFriendPrefix(mob.nameTag || "") || shortTypeId(mob.typeId);
      player.sendMessage("<" + name + "> " + (reply.text || "..."));
      cacheMindFromReply(mob, reply);
      if (reply.mobName) {
        setMobDisplayName(mob, reply.mobName, player);
      }
      applySimpleAction(player, mob, reply, prompt);
    })
    .catch(function (error) {
      if (error && error.busy) {
        player.sendMessage("Neiro: AI занят, подожди.");
        return;
      }
      player.sendMessage("Neiro bridge error: " + error.message);
    });
}

function talkToCrowd(player, nearby, prompt, source) {
  var crowdMax = cachedSettings.crowdMax || 4;
  var crowd = nearby.slice(0, source === "overhear" ? crowdMax : Math.min(8, Math.max(crowdMax, nearby.length)));
  if (crowd.length === 0) {
    player.sendMessage("Рядом нет мобов для толпы.");
    return;
  }

  if (source !== "overhear") {
    player.sendMessage("Neiro: говоришь толпе (" + crowd.length + ")...");
  }

  var mobs = [];
  for (var i = 0; i < crowd.length; i += 1) {
    var entity = crowd[i].entity;
    mobs.push({
      id: entity.id,
      typeId: entity.typeId,
      nameTag: stripFriendPrefix(entity.nameTag || ""),
      location: roundLocation(entity.location),
      relation: getRelationState(entity, player)
    });
  }

  postJson(BRIDGE_URL + "/chat/crowd", {
    player: {
      id: player.id,
      name: player.name,
      location: roundLocation(player.location)
    },
    mobs: mobs,
    world: {
      dimension: player.dimension.id
    },
    nearbyPlayers: listNearbyPlayerNames(player, 32),
    nearbyEntities: listNearbyEntityTypes(player, 16),
    message: prompt,
    source: source || "talk"
  })
    .then(function (reply) {
      if (reply.settings) {
        cachedSettings = reply.settings;
        TALK_RANGE = cachedSettings.listenRadius || TALK_RANGE;
      }
      var replies = reply && reply.replies ? reply.replies : [];
      if (replies.length === 0) {
        player.sendMessage("Толпа молчит...");
        return;
      }

      for (var r = 0; r < replies.length; r += 1) {
        var item = replies[r];
        player.sendMessage("<" + (item.mobName || "Моб") + "> " + (item.text || "..."));
        var liveMob = findEntityById(player, item.mobId, TALK_RANGE + 16);
        if (liveMob) {
          cacheMindFromReply(liveMob, item);
          if (item.mobName) {
            setMobDisplayName(liveMob, item.mobName, player);
          }
          applySimpleAction(player, liveMob, item, prompt);
        }
      }
    })
    .catch(function (error) {
      if (error && (error.busy || String(error.message || "").indexOf("429") >= 0 || String(error.message || "").indexOf("занят") >= 0)) {
        player.sendMessage("Neiro: AI занят, подожди.");
        return;
      }
      player.sendMessage("Neiro bridge error: " + error.message);
    });
}

function maybeApplyKeywordOrders(player, text) {
  var lower = String(text || "").toLowerCase();
  if (!lower) {
    return false;
  }

  if ((lower.indexOf("все друзья") >= 0 || lower.indexOf("все за мной") >= 0 || lower.indexOf("за мной") >= 0) &&
      (lower.indexOf("друг") >= 0 || lower.indexOf("за мной") >= 0)) {
    followGroup(player, null);
    return true;
  }

  if (lower.indexOf("охран") >= 0 && (lower.indexOf("лагер") >= 0 || lower.indexOf("camp") >= 0)) {
    var typeFilter = null;
    if (lower.indexOf("волк") >= 0 || lower.indexOf("wolf") >= 0) {
      typeFilter = "minecraft:wolf";
    }
    guardCamp(player, typeFilter, "лагерь");
    return true;
  }

  if (lower.indexOf("отдай") >= 0 || lower.indexOf("сдай") >= 0 || lower.indexOf("inventory") >= 0) {
    depositNearbyFriends(player);
    return true;
  }

  if (lower.indexOf("построй") >= 0 || lower.indexOf("стен") >= 0 || lower.indexOf("дом") >= 0 || lower.indexOf("хижин") >= 0 || lower.indexOf("логово") >= 0) {
    var schematicId = "wall";
    if (lower.indexOf("логово") >= 0 || lower.indexOf("зл") >= 0) {
      schematicId = "evil_house";
    } else if (lower.indexOf("дом") >= 0 || lower.indexOf("хижин") >= 0 || lower.indexOf("hut") >= 0) {
      schematicId = "good_house";
    }
    buildSchematicWithFriends(player, schematicId);
    return true;
  }

  return false;
}

function getJson(url) {
  var request = new HttpRequest(url);
  request.method = HttpRequestMethod.Get;
  return http.request(request).then(function (response) {
    if (response.status < 200 || response.status >= 300) {
      throw new Error("HTTP " + response.status + ": " + response.body);
    }
    return JSON.parse(response.body);
  });
}

function postJson(url, payload) {
  var request = new HttpRequest(url);
  request.method = HttpRequestMethod.Post;
  request.headers = [new HttpHeader("Content-Type", "application/json")];
  request.body = JSON.stringify(payload);

  return http.request(request).then(function (response) {
    var body = {};
    try {
      body = JSON.parse(response.body || "{}");
    } catch (error) {
      body = { error: response.body };
    }
    if (response.status === 429 || body.busy) {
      var busyError = new Error(body.error || "AI busy");
      busyError.busy = true;
      throw busyError;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error("HTTP " + response.status + ": " + response.body);
    }
    return body;
  });
}

function applySimpleAction(player, mob, reply, promptText) {
  var action = reply && reply.action ? reply.action : "none";
  var combined = (promptText || "") + " " + (reply.text || "");

  if (action === "befriend" || action === "stand_down") {
    makeFriend(mob, player);
    clearEnemyTag(mob, player);
    clearAttackOrders(mob);
    player.sendMessage(shortTypeId(mob.typeId) + " больше не будет тебя атаковать.");
    return;
  }

  if (action === "hostile" || action === "attack") {
    makeEnemy(mob, player, "Моб решил напасть на тебя.");
    startAttackingPlayer(mob, player);
    return;
  }

  if (action === "follow") {
    makeFriend(mob, player);
    addTag(mob, "neiro_follow");
    player.sendMessage(shortTypeId(mob.typeId) + " будет стараться идти за тобой.");
    return;
  }

  if (action === "follow_group") {
    followGroup(player, null);
    return;
  }

  if (action === "stop_follow") {
    removeTag(mob, "neiro_follow");
    player.sendMessage(shortTypeId(mob.typeId) + " больше не следует за тобой.");
    return;
  }

  if (action === "guard_camp") {
    var typeFilter = null;
    if (/wolf|волк/i.test(combined)) {
      typeFilter = "minecraft:wolf";
    }
    guardCamp(player, typeFilter, reply.placeName || "лагерь");
    return;
  }

  if (action === "attack_player") {
    if (!canGiveOrders(mob, player)) {
      player.sendMessage(shortTypeId(mob.typeId) + " тебя не слушается.");
      return;
    }
    var targetName = reply.targetPlayer || extractTargetFromText(reply.text || "");
    var target = findPlayerByName(targetName);
    if (!target) {
      player.sendMessage("Не нашёл игрока для атаки: " + (targetName || "?"));
      return;
    }
    if (target.id === player.id) {
      player.sendMessage("Моб отказывается атаковать хозяина.");
      return;
    }
    clearAttackOrders(mob);
    addTag(mob, attackTagFor(target));
    addTag(mob, "neiro_on_order");
    player.sendMessage(shortTypeId(mob.typeId) + " атакует " + target.name);
    return;
  }

  if (action === "attack_entity") {
    if (!canGiveOrders(mob, player)) {
      player.sendMessage(shortTypeId(mob.typeId) + " тебя не слушается.");
      return;
    }
    var targetType = normalizeGameTypeId(reply.targetType || guessEntityFromText(combined), "minecraft:chicken");
    assignMobTask(mob, player, {
      type: "attack_entity",
      targetType: targetType,
      ownerId: player.id,
      ownerName: player.name
    });
    player.sendMessage(shortTypeId(mob.typeId) + " идёт убивать: " + shortTypeId(targetType));
    return;
  }

  if (action === "mine_blocks") {
    if (!canGiveOrders(mob, player)) {
      player.sendMessage(shortTypeId(mob.typeId) + " тебя не слушается.");
      return;
    }
    var mineType = normalizeGameTypeId(reply.blockType || guessBlockFromText(combined), "minecraft:dirt");
    var mineCount = clampCount(reply.count, 1, 16, 4);
    assignMobTask(mob, player, {
      type: "mine_blocks",
      blockType: mineType,
      count: mineCount,
      done: 0,
      ownerId: player.id,
      ownerName: player.name
    });
    player.sendMessage(shortTypeId(mob.typeId) + " добывает " + shortTypeId(mineType) + " x" + mineCount);
    return;
  }

  if (action === "place_blocks") {
    if (!canGiveOrders(mob, player)) {
      player.sendMessage(shortTypeId(mob.typeId) + " тебя не слушается.");
      return;
    }
    var placeType = normalizeGameTypeId(reply.blockType || guessBlockFromText(combined), "minecraft:cobblestone");
    var placeCount = clampCount(reply.count, 1, 16, 4);
    assignMobTask(mob, player, {
      type: "place_blocks",
      blockType: placeType,
      count: placeCount,
      done: 0,
      ownerId: player.id,
      ownerName: player.name
    });
    player.sendMessage(shortTypeId(mob.typeId) + " строит из " + shortTypeId(placeType) + " x" + placeCount);
    return;
  }

  if (action === "build_schematic") {
    if (!canGiveOrders(mob, player)) {
      player.sendMessage(shortTypeId(mob.typeId) + " тебя не слушается.");
      return;
    }
    startBuildSchematic(mob, player, reply.schematicId || "wall");
    return;
  }

  if (action === "deposit_to_player") {
    if (!canGiveOrders(mob, player)) {
      player.sendMessage(shortTypeId(mob.typeId) + " тебя не слушается.");
      return;
    }
    depositMobToPlayer(mob, player);
    return;
  }

  if (action === "remember_place") {
    rememberCamp(player, reply.placeName || "место");
    player.sendMessage("Место запомнено: " + (reply.placeName || "место"));
    return;
  }

  if (action === "join_faction") {
    var factionId = reply.factionId || "wild";
    addTag(mob, "neiro_faction_" + factionId);
    if (factionId === "good_village" || factionId === "evil_village") {
      addTag(mob, "neiro_social_village");
      addTag(mob, factionId === "good_village" ? "neiro_side_good" : "neiro_side_evil");
    }
    player.sendMessage(shortTypeId(mob.typeId) + " во фракции " + factionId);
    return;
  }

  if (action === "stop_attack" || action === "stop_task") {
    clearAttackOrders(mob);
    clearMobTask(mob);
    player.sendMessage(shortTypeId(mob.typeId) + " прекратил текущую задачу.");
    return;
  }

  if (action === "trade") {
    player.sendMessage(shortTypeId(mob.typeId) + " предлагает обмен, но GUI обмена пока нет.");
  }
}

function followGroup(player, typeFilter) {
  var nearby = listNearbyMobs(player, FOLLOW_RANGE);
  var count = 0;
  for (var i = 0; i < nearby.length; i += 1) {
    var mob = nearby[i].entity;
    if (typeFilter && mob.typeId !== typeFilter) {
      continue;
    }
    if (!canGiveOrders(mob, player)) {
      continue;
    }
    makeFriend(mob, player);
    addTag(mob, "neiro_follow");
    count += 1;
  }
  player.sendMessage("За тобой идут союзники: " + count);
}

function guardCamp(player, typeFilter, placeName) {
  rememberCamp(player, placeName || "лагерь");
  var camp = campPlaces[player.id];
  var nearby = listNearbyMobs(player, FOLLOW_RANGE);
  var count = 0;
  for (var i = 0; i < nearby.length; i += 1) {
    var mob = nearby[i].entity;
    if (typeFilter && mob.typeId !== typeFilter) {
      continue;
    }
    if (!canGiveOrders(mob, player) && !(typeFilter && mob.typeId === typeFilter)) {
      if (!(typeFilter && mob.typeId === typeFilter)) {
        continue;
      }
      makeFriend(mob, player);
    }
    removeTag(mob, "neiro_follow");
    assignMobTask(mob, player, {
      type: "guard",
      camp: { x: camp.x, y: camp.y, z: camp.z },
      ownerId: player.id,
      ownerName: player.name
    });
    count += 1;
  }
  player.sendMessage("Охраняют лагерь: " + count);
}

function rememberCamp(player, placeName) {
  campPlaces[player.id] = {
    name: placeName || "лагерь",
    x: Math.floor(player.location.x),
    y: Math.floor(player.location.y),
    z: Math.floor(player.location.z),
    dimension: player.dimension.id
  };
}

function buildSchematicWithFriends(player, schematicId) {
  var nearby = listNearbyMobs(player, WORK_RANGE).filter(function (item) {
    return canGiveOrders(item.entity, player);
  });
  if (nearby.length === 0) {
    player.sendMessage("Нет друзей рядом для стройки.");
    return;
  }
  startBuildSchematic(nearby[0].entity, player, schematicId);
}

function startBuildSchematic(mob, player, schematicId) {
  var schematic = getSchematic(schematicId);
  var anchor = {
    x: Math.floor(player.location.x) + 1,
    y: Math.floor(player.location.y),
    z: Math.floor(player.location.z) + 1
  };
  var blocks = [];
  for (var i = 0; i < schematic.blocks.length; i += 1) {
    var b = schematic.blocks[i];
    blocks.push({
      x: anchor.x + b.x,
      y: anchor.y + b.y,
      z: anchor.z + b.z,
      blockType: b.blockType || schematic.blockType
    });
  }
  assignMobTask(mob, player, {
    type: "build_schematic",
    schematicId: schematic.id,
    blocks: blocks,
    done: 0,
    ownerId: player.id,
    ownerName: player.name
  });
  player.sendMessage(shortTypeId(mob.typeId) + " строит схему " + schematic.id + " (" + blocks.length + " блоков)");
}

function depositNearbyFriends(player) {
  var nearby = listNearbyMobs(player, TALK_RANGE + 4);
  var any = false;
  for (var i = 0; i < nearby.length; i += 1) {
    var mob = nearby[i].entity;
    if (!canGiveOrders(mob, player)) {
      continue;
    }
    if (depositMobToPlayer(mob, player)) {
      any = true;
    }
  }
  if (!any) {
    player.sendMessage("Нечего сдавать.");
  }
}

function getMobInventory(mob) {
  if (!mobInventories[mob.id]) {
    mobInventories[mob.id] = [];
  }
  return mobInventories[mob.id];
}

function addToMobInventory(mob, itemId, count) {
  var inv = getMobInventory(mob);
  var add = count || 1;
  for (var i = 0; i < inv.length; i += 1) {
    if (inv[i].itemId === itemId && inv[i].count < 64) {
      var space = 64 - inv[i].count;
      var used = Math.min(space, add);
      inv[i].count += used;
      add -= used;
      if (add <= 0) {
        return true;
      }
    }
  }
  while (add > 0 && inv.length < 8) {
    var stack = Math.min(64, add);
    inv.push({ itemId: itemId, count: stack });
    add -= stack;
  }
  return add <= 0;
}

function depositMobToPlayer(mob, player) {
  var inv = getMobInventory(mob);
  if (!inv.length) {
    return false;
  }
  var container = null;
  try {
    var comp = player.getComponent("minecraft:inventory") || player.getComponent("inventory");
    container = comp && comp.container;
  } catch (error) {
    container = null;
  }
  if (!container) {
    player.sendMessage("Не удалось открыть инвентарь игрока.");
    return false;
  }

  var remaining = [];
  for (var i = 0; i < inv.length; i += 1) {
    var stack = inv[i];
    try {
      var item = new ItemStack(stack.itemId, stack.count);
      var leftover = container.addItem(item);
      if (leftover && leftover.amount > 0) {
        remaining.push({ itemId: stack.itemId, count: leftover.amount });
      }
    } catch (error2) {
      remaining.push(stack);
    }
  }
  mobInventories[mob.id] = remaining;
  player.sendMessage(shortTypeId(mob.typeId) + " сдал добычу. Осталось слотов у моба: " + remaining.length);
  return true;
}

function assignMobTask(mob, player, task) {
  clearAttackOrders(mob);
  clearMobTask(mob);
  if (!task || !task.autonomous) {
    makeFriend(mob, player);
  }
  addTag(mob, "neiro_busy");
  mobTasks[mob.id] = task;
}

function clearMobTask(mob) {
  delete mobTasks[mob.id];
  removeTag(mob, "neiro_busy");
}

function processMobTasks() {
  var ids = Object.keys(mobTasks);
  if (ids.length === 0) {
    return;
  }

  var players = world.getAllPlayers();
  for (var i = 0; i < ids.length; i += 1) {
    var mobId = ids[i];
    var task = mobTasks[mobId];
    var mob = findBusyMobNearPlayers(mobId, players);
    if (!mob) {
      continue;
    }

    var owner = findPlayerById(task.ownerId) || findPlayerByName(task.ownerName);
    if (task.type === "attack_entity") {
      tickAttackEntityTask(mob, task, owner);
    } else if (task.type === "mine_blocks") {
      tickMineTask(mob, task, owner);
    } else if (task.type === "place_blocks") {
      tickPlaceTask(mob, task, owner);
    } else if (task.type === "build_schematic") {
      tickBuildSchematicTask(mob, task, owner);
    } else if (task.type === "guard") {
      tickGuardTask(mob, task, owner);
    } else if (task.type === "raid_move") {
      tickRaidMoveTask(autonomyApi, mob, task, owner);
    }
  }
}

function findBusyMobNearPlayers(mobId, players) {
  for (var i = 0; i < players.length; i += 1) {
    var found = findEntityById(players[i], mobId, WORK_RANGE + 32);
    if (found) {
      return found;
    }
  }
  return null;
}

function findPlayerById(playerId) {
  var players = world.getAllPlayers();
  for (var i = 0; i < players.length; i += 1) {
    if (players[i].id === playerId) {
      return players[i];
    }
  }
  return null;
}

function tickAttackEntityTask(mob, task, owner) {
  var target = null;
  if (task.targetEntityId) {
    target = findEntityAround(mob, task.targetEntityId, WORK_RANGE);
  }
  if (!target) {
    target = findNearestEntityOfType(mob, task.targetType, WORK_RANGE);
    if (target) {
      task.targetEntityId = target.id;
    }
  }

  if (!target) {
    if (owner) {
      owner.sendMessage(shortTypeId(mob.typeId) + ": цель не найдена.");
    }
    clearMobTask(mob);
    return;
  }

  var distance = Math.sqrt(distanceSquared(mob.location, target.location));
  if (distance > 2.6) {
    stepTowardWithAvoid(mob, target.location, Math.min(1.5, distance - 1.2));
    return;
  }

  try {
    target.applyDamage(6, { cause: "entityAttack", damagingEntity: mob });
  } catch (error) {
    // ignore
  }

  try {
    var health = target.getComponent("minecraft:health");
    if (health && health.currentValue <= 0) {
      if (owner) {
        owner.sendMessage(shortTypeId(mob.typeId) + " убил " + shortTypeId(task.targetType) + ".");
      }
      clearMobTask(mob);
    }
  } catch (error3) {
    if (owner) {
      owner.sendMessage(shortTypeId(mob.typeId) + " выполнил приказ атаки.");
    }
    clearMobTask(mob);
  }
}

function tickMineTask(mob, task, owner) {
  var blockLoc = findNearbyBlock(mob, task.blockType, 5);
  if (!blockLoc) {
    stepTowardWithAvoid(mob, offsetLocation(mob.location, randomOffset(), 0, randomOffset()), 1.2);
    task.misses = (task.misses || 0) + 1;
    if (task.misses > 12) {
      if (owner) {
        owner.sendMessage(shortTypeId(mob.typeId) + ": не нашёл " + shortTypeId(task.blockType));
      }
      clearMobTask(mob);
    }
    return;
  }

  stepTowardWithAvoid(mob, { x: blockLoc.x + 0.5, y: blockLoc.y, z: blockLoc.z + 0.5 }, 1.4);
  var distance = Math.sqrt(distanceSquared(mob.location, { x: blockLoc.x + 0.5, y: blockLoc.y + 0.5, z: blockLoc.z + 0.5 }));
  if (distance > 3.2) {
    return;
  }

  if (breakBlockSilent(mob, blockLoc)) {
    addToMobInventory(mob, task.blockType, 1);
    task.done += 1;
    task.misses = 0;
    if (owner) {
      owner.sendMessage(shortTypeId(mob.typeId) + " добыл в инвентарь " + shortTypeId(task.blockType) + " (" + task.done + "/" + task.count + ")");
    }
  }

  if (task.done >= task.count) {
    if (owner) {
      owner.sendMessage(shortTypeId(mob.typeId) + " закончил добычу. Скажи «отдай».");
    }
    clearMobTask(mob);
  }
}

function tickPlaceTask(mob, task, owner) {
  var placeLoc = findPlaceLocation(mob);
  if (!placeLoc) {
    stepTowardWithAvoid(mob, offsetLocation(mob.location, randomOffset(), 0, randomOffset()), 1.2);
    return;
  }

  stepTowardWithAvoid(mob, placeLoc, 1.3);
  if (placeBlockAt(mob, placeLoc, task.blockType)) {
    task.done += 1;
    if (owner) {
      owner.sendMessage(shortTypeId(mob.typeId) + " поставил " + shortTypeId(task.blockType) + " (" + task.done + "/" + task.count + ")");
    }
  }

  if (task.done >= task.count) {
    if (owner) {
      owner.sendMessage(shortTypeId(mob.typeId) + " закончил строительство.");
    }
    clearMobTask(mob);
  }
}

function tickBuildSchematicTask(mob, task, owner) {
  if (!task.blocks || task.done >= task.blocks.length) {
    if (owner) {
      owner.sendMessage(shortTypeId(mob.typeId) + " закончил схему " + (task.schematicId || ""));
    }
    clearMobTask(mob);
    return;
  }

  var next = task.blocks[task.done];
  var target = { x: next.x + 0.5, y: next.y, z: next.z + 0.5 };
  var distance = Math.sqrt(distanceSquared(mob.location, target));
  if (distance > 3.5) {
    stepTowardWithAvoid(mob, target, 1.4);
    return;
  }

  if (placeBlockAt(mob, { x: next.x, y: next.y, z: next.z }, next.blockType)) {
    task.done += 1;
    if (owner && task.done % 4 === 0) {
      owner.sendMessage(shortTypeId(mob.typeId) + " схема " + task.done + "/" + task.blocks.length);
    }
  } else {
    task.done += 1;
  }
}

function tickGuardTask(mob, task, owner) {
  var camp = task.camp;
  if (!camp) {
    clearMobTask(mob);
    return;
  }

  var hostile = findNearestHostileNear(mob, camp, 10, owner);
  if (hostile) {
    var distH = Math.sqrt(distanceSquared(mob.location, hostile.location));
    if (distH > 2.6) {
      stepTowardWithAvoid(mob, hostile.location, 1.5);
    } else {
      try {
        hostile.applyDamage(4, { cause: "entityAttack", damagingEntity: mob });
      } catch (error) {
        // ignore
      }
    }
    return;
  }

  var dist = Math.sqrt(distanceSquared(mob.location, camp));
  if (dist > 4) {
    stepTowardWithAvoid(mob, camp, 1.3);
  }
}

function findNearestHostileNear(mob, camp, range, owner) {
  var entities = mob.dimension.getEntities({
    location: camp,
    maxDistance: range
  });
  var best = null;
  var bestDist = 999999;
  for (var i = 0; i < entities.length; i += 1) {
    var entity = entities[i];
    if (entity.id === mob.id || entity.typeId === "minecraft:player") {
      continue;
    }
    if (entity.hasTag("neiro_friend") || (owner && isOwnedBy(entity, owner))) {
      continue;
    }
    var shortType = shortTypeId(entity.typeId);
    var hostileTypes = ["zombie", "skeleton", "creeper", "spider", "husk", "drowned", "pillager", "vindicator"];
    if (hostileTypes.indexOf(shortType) < 0 && !entity.hasTag("neiro_hostile")) {
      continue;
    }
    var d = distanceSquared(mob.location, entity.location);
    if (d < bestDist) {
      best = entity;
      bestDist = d;
    }
  }
  return best;
}

function stepTowardWithAvoid(entity, targetLoc, step) {
  var useStep = Math.min(step || 1.4, 1.6);
  var dx = targetLoc.x - entity.location.x;
  var dz = targetLoc.z - entity.location.z;
  var len = Math.sqrt(dx * dx + dz * dz) || 1;
  var nx = dx / len;
  var nz = dz / len;
  var candidates = [
    { x: entity.location.x + nx * useStep, y: entity.location.y, z: entity.location.z + nz * useStep },
    { x: entity.location.x + nx * useStep, y: entity.location.y + 1, z: entity.location.z + nz * useStep },
    { x: entity.location.x - nz * useStep, y: entity.location.y, z: entity.location.z + nx * useStep },
    { x: entity.location.x + nz * useStep, y: entity.location.y, z: entity.location.z - nx * useStep }
  ];

  for (var i = 0; i < candidates.length; i += 1) {
    var c = candidates[i];
    if (isWalkable(entity, c)) {
      try {
        entity.teleport(c, { dimension: entity.dimension });
      } catch (error) {
        // ignore
      }
      return;
    }
  }
}

function isWalkable(entity, loc) {
  try {
    var feet = entity.dimension.getBlock({ x: Math.floor(loc.x), y: Math.floor(loc.y), z: Math.floor(loc.z) });
    var head = entity.dimension.getBlock({ x: Math.floor(loc.x), y: Math.floor(loc.y) + 1, z: Math.floor(loc.z) });
    var below = entity.dimension.getBlock({ x: Math.floor(loc.x), y: Math.floor(loc.y) - 1, z: Math.floor(loc.z) });
    if (!feet || !head) {
      return false;
    }
    if (!isAirish(feet.typeId) || !isAirish(head.typeId)) {
      return false;
    }
    if (!below || isAirish(below.typeId)) {
      return false;
    }
    return true;
  } catch (error) {
    return false;
  }
}

function isAirish(typeId) {
  return typeId === "minecraft:air" || typeId === "minecraft:short_grass" || typeId === "minecraft:tall_grass" || typeId === "minecraft:snow_layer";
}

function moveEntityToward(entity, targetLoc, step) {
  stepTowardWithAvoid(entity, targetLoc, step);
}

function findNearestEntityOfType(source, typeId, range) {
  var entities = source.dimension.getEntities({
    location: source.location,
    maxDistance: range,
    type: typeId
  });

  var best = null;
  var bestDistance = 999999;
  for (var i = 0; i < entities.length; i += 1) {
    var entity = entities[i];
    if (entity.id === source.id) {
      continue;
    }
    var distance = distanceSquared(source.location, entity.location);
    if (distance < bestDistance) {
      best = entity;
      bestDistance = distance;
    }
  }
  return best;
}

function findEntityAround(source, entityId, range) {
  var entities = source.dimension.getEntities({
    location: source.location,
    maxDistance: range
  });
  for (var i = 0; i < entities.length; i += 1) {
    if (entities[i].id === entityId) {
      return entities[i];
    }
  }
  return null;
}

function findNearbyBlock(mob, blockType, radius) {
  var base = mob.location;
  var bx = Math.floor(base.x);
  var by = Math.floor(base.y);
  var bz = Math.floor(base.z);
  var best = null;
  var bestDist = 999999;

  for (var x = -radius; x <= radius; x += 1) {
    for (var y = -2; y <= 2; y += 1) {
      for (var z = -radius; z <= radius; z += 1) {
        var loc = { x: bx + x, y: by + y, z: bz + z };
        try {
          var block = mob.dimension.getBlock(loc);
          if (block && block.typeId === blockType) {
            var dist = x * x + y * y + z * z;
            if (dist < bestDist) {
              best = loc;
              bestDist = dist;
            }
          }
        } catch (error) {
          // ignore
        }
      }
    }
  }
  return best;
}

function findPlaceLocation(mob) {
  var base = mob.location;
  var candidates = [
    { x: Math.floor(base.x + 1), y: Math.floor(base.y), z: Math.floor(base.z) },
    { x: Math.floor(base.x - 1), y: Math.floor(base.y), z: Math.floor(base.z) },
    { x: Math.floor(base.x), y: Math.floor(base.y), z: Math.floor(base.z + 1) },
    { x: Math.floor(base.x), y: Math.floor(base.y), z: Math.floor(base.z - 1) }
  ];

  for (var i = 0; i < candidates.length; i += 1) {
    try {
      var block = mob.dimension.getBlock(candidates[i]);
      if (block && isAirish(block.typeId)) {
        var below = mob.dimension.getBlock({ x: candidates[i].x, y: candidates[i].y - 1, z: candidates[i].z });
        if (below && !isAirish(below.typeId)) {
          return candidates[i];
        }
      }
    } catch (error) {
      // ignore
    }
  }
  return null;
}

function breakBlockSilent(mob, loc) {
  try {
    var block = mob.dimension.getBlock(loc);
    if (block && block.setType) {
      block.setType("minecraft:air");
      return true;
    }
  } catch (error) {
    // fall through
  }
  try {
    mob.dimension.runCommand("setblock " + loc.x + " " + loc.y + " " + loc.z + " air");
    return true;
  } catch (error2) {
    return false;
  }
}

function placeBlockAt(mob, loc, blockType) {
  var shortName = shortTypeId(blockType);
  try {
    var block = mob.dimension.getBlock(loc);
    if (block && block.setType) {
      block.setType(blockType);
      return true;
    }
  } catch (error) {
    // fall through
  }
  try {
    mob.dimension.runCommand("setblock " + loc.x + " " + loc.y + " " + loc.z + " " + shortName);
    return true;
  } catch (error2) {
    return false;
  }
}

function updateFriendMarkersAndHud(players) {
  for (var p = 0; p < players.length; p += 1) {
    var player = players[p];
    var nearby = listNearbyMobs(player, HUD_RANGE);
    var actionParts = [];

    for (var i = 0; i < nearby.length; i += 1) {
      var mob = nearby[i].entity;
      var relation = getRelationState(mob, player);
      if (relation === "friend" || relation === "ally_owner") {
        setMobDisplayName(mob, stripFriendPrefix(mob.nameTag || shortTypeId(mob.typeId)), player);
      }

      var task = mobTasks[mob.id];
      if (task) {
        actionParts.push(shortTypeId(mob.typeId) + ":" + task.type);
        try {
          var particle = task.type === "mine_blocks" ? "minecraft:critical_hit_emitter" : "minecraft:villager_happy";
          mob.dimension.spawnParticle(particle, mob.location);
        } catch (error) {
          // ignore particle failures
        }
      }
    }

    if (actionParts.length && player.onScreenDisplay && player.onScreenDisplay.setActionBar) {
      try {
        player.onScreenDisplay.setActionBar("Neiro: " + actionParts.slice(0, 4).join(" | "));
      } catch (error2) {
        // ignore
      }
    }
  }
}

function setMobDisplayName(mob, baseName, player) {
  var clean = stripFriendPrefix(baseName || shortTypeId(mob.typeId)).slice(0, 28);
  friendNameTags[mob.id] = clean;
  var relation = player ? getRelationState(mob, player) : "neutral";
  if (relation === "friend" || relation === "ally_owner") {
    mob.nameTag = "✦ " + clean;
  } else {
    mob.nameTag = clean;
  }
}

function stripFriendPrefix(name) {
  return String(name || "").replace(/^✦\s*/, "").trim();
}

function listNearbyEntityTypes(player, range) {
  var entities = player.dimension.getEntities({
    location: player.location,
    maxDistance: range
  });
  var seen = {};
  var list = [];
  for (var i = 0; i < entities.length; i += 1) {
    var entity = entities[i];
    if (entity.id === player.id || entity.typeId === "minecraft:player") {
      continue;
    }
    if (!seen[entity.typeId]) {
      seen[entity.typeId] = true;
      list.push(entity.typeId);
    }
  }
  return list;
}

function normalizeGameTypeId(raw, fallbackId) {
  var aliases = {
    chicken: "minecraft:chicken",
    "курица": "minecraft:chicken",
    cow: "minecraft:cow",
    "корова": "minecraft:cow",
    pig: "minecraft:pig",
    "свинья": "minecraft:pig",
    sheep: "minecraft:sheep",
    "овца": "minecraft:sheep",
    wolf: "minecraft:wolf",
    "волк": "minecraft:wolf",
    zombie: "minecraft:zombie",
    "зомби": "minecraft:zombie",
    dirt: "minecraft:dirt",
    "земля": "minecraft:dirt",
    stone: "minecraft:stone",
    "камень": "minecraft:stone",
    cobblestone: "minecraft:cobblestone",
    "булыжник": "minecraft:cobblestone",
    oak_log: "minecraft:oak_log",
    "дерево": "minecraft:oak_log",
    sand: "minecraft:sand",
    "песок": "minecraft:sand",
    grass_block: "minecraft:grass_block",
    "трава": "minecraft:grass_block"
  };

  var value = String(raw || "").trim().toLowerCase().replace(/\s+/g, "_");
  if (!value) {
    return fallbackId;
  }
  if (aliases[value]) {
    return aliases[value];
  }
  if (value.indexOf(":") < 0) {
    value = "minecraft:" + value;
  }
  if (!/^minecraft:[a-z0-9_]+$/.test(value)) {
    return fallbackId;
  }
  return value;
}

function guessEntityFromText(text) {
  var lower = String(text || "").toLowerCase();
  if (lower.indexOf("кур") >= 0 || lower.indexOf("chicken") >= 0) return "minecraft:chicken";
  if (lower.indexOf("коров") >= 0 || lower.indexOf("cow") >= 0) return "minecraft:cow";
  if (lower.indexOf("свин") >= 0 || lower.indexOf("pig") >= 0) return "minecraft:pig";
  if (lower.indexOf("овц") >= 0 || lower.indexOf("sheep") >= 0) return "minecraft:sheep";
  if (lower.indexOf("волк") >= 0 || lower.indexOf("wolf") >= 0) return "minecraft:wolf";
  if (lower.indexOf("зомб") >= 0 || lower.indexOf("zombie") >= 0) return "minecraft:zombie";
  return "minecraft:chicken";
}

function guessBlockFromText(text) {
  var lower = String(text || "").toLowerCase();
  if (lower.indexOf("булыж") >= 0 || lower.indexOf("cobble") >= 0) return "minecraft:cobblestone";
  if (lower.indexOf("камн") >= 0 || lower.indexOf("stone") >= 0) return "minecraft:stone";
  if (lower.indexOf("дерев") >= 0 || lower.indexOf("log") >= 0 || lower.indexOf("wood") >= 0) return "minecraft:oak_log";
  if (lower.indexOf("пес") >= 0 || lower.indexOf("sand") >= 0) return "minecraft:sand";
  if (lower.indexOf("земл") >= 0 || lower.indexOf("dirt") >= 0) return "minecraft:dirt";
  return "minecraft:dirt";
}

function clampCount(value, min, max, fallback) {
  var number = Number(value);
  if (!isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function randomOffset() {
  return Math.random() > 0.5 ? 2 : -2;
}

function makeFriend(mob, player) {
  addTag(mob, "neiro_friend");
  addTag(mob, ownerTagFor(player));
  removeTag(mob, "neiro_hostile");
  clearEnemyTag(mob, player);
  setMobDisplayName(mob, stripFriendPrefix(mob.nameTag || shortTypeId(mob.typeId)), player);
}

function makeEnemy(mob, player, reason) {
  removeTag(mob, "neiro_friend");
  removeTag(mob, ownerTagFor(player));
  removeTag(mob, "neiro_follow");
  clearAttackOrders(mob);
  addTag(mob, "neiro_hostile");
  addTag(mob, enemyTagFor(player));
  if (reason) {
    player.sendMessage(reason);
  }
  player.sendMessage(shortTypeId(mob.typeId) + " теперь враждебен к тебе.");
}

function startAttackingPlayer(mob, player) {
  clearAttackOrders(mob);
  addTag(mob, attackTagFor(player));
  addTag(mob, "neiro_on_order");
  addTag(mob, "neiro_hostile");
  addTag(mob, enemyTagFor(player));
  player.sendMessage(shortTypeId(mob.typeId) + " идёт в атаку!");
}

function handlePlayerHitMob(player, mob) {
  if (isOwnedBy(mob, player) || mob.hasTag("neiro_friend")) {
    makeEnemy(mob, player, "Ты ударил союзника. Дружба разрушена!");
    startAttackingPlayer(mob, player);
  }
}

function shouldProtectPlayerFromMob(mob, player) {
  if (mob.typeId === "minecraft:player") {
    return false;
  }
  if (isOwnedBy(mob, player)) {
    return true;
  }
  if (mob.hasTag("neiro_friend") && !isEnemyOf(mob, player) && !hasAttackOrderAgainst(mob, player)) {
    return true;
  }
  return false;
}

function canGiveOrders(mob, player) {
  return isOwnedBy(mob, player) || (mob.hasTag("neiro_friend") && !isEnemyOf(mob, player));
}

function isOwnedBy(mob, player) {
  return mob.hasTag(ownerTagFor(player));
}

function isEnemyOf(mob, player) {
  return mob.hasTag(enemyTagFor(player));
}

function hasAttackOrderAgainst(mob, player) {
  return mob.hasTag(attackTagFor(player));
}

function getRelationState(mob, player) {
  if (isOwnedBy(mob, player)) {
    return "ally_owner";
  }
  if (mob.hasTag("neiro_friend") && !isEnemyOf(mob, player)) {
    return "friend";
  }
  if (isEnemyOf(mob, player) || mob.hasTag("neiro_hostile")) {
    return "enemy";
  }
  return "neutral";
}

function keepFollowersNear(player) {
  var ownerTag = ownerTagFor(player);
  var followers = player.dimension.getEntities({
    tags: ["neiro_follow", ownerTag],
    location: player.location,
    maxDistance: FOLLOW_RANGE
  });

  for (var i = 0; i < followers.length; i += 1) {
    var follower = followers[i];
    var distance = Math.sqrt(distanceSquared(player.location, follower.location));
    if (distance > 32) {
      try {
        follower.teleport(offsetLocation(player.location, 2, 0, 2), { dimension: player.dimension });
      } catch (error) {
        // ignore
      }
    } else if (distance > 4) {
      stepTowardWithAvoid(follower, offsetLocation(player.location, 1.5, 0, 1.5), 1.4);
    }
  }
}

function processAttackOrders() {
  var players = world.getAllPlayers();
  for (var p = 0; p < players.length; p += 1) {
    var target = players[p];
    var tag = attackTagFor(target);
    var attackers = target.dimension.getEntities({
      tags: [tag],
      location: target.location,
      maxDistance: ATTACK_RANGE
    });

    for (var i = 0; i < attackers.length; i += 1) {
      chaseAndHit(attackers[i], target);
    }
  }
}

function chaseAndHit(mob, target) {
  if (!mob || !target || !mob.isValid || (target.isValid === false)) {
    return;
  }

  var distance = Math.sqrt(distanceSquared(mob.location, target.location));
  if (distance > 3.2) {
    stepTowardWithAvoid(mob, target.location, Math.min(1.5, distance - 1.5));
    return;
  }

  try {
    target.applyDamage(2, { cause: "entityAttack", damagingEntity: mob });
  } catch (error) {
    // ignore
  }
}

function listNearbyMobs(player, range) {
  var entities = player.dimension.getEntities({
    location: player.location,
    maxDistance: range
  });

  var list = [];
  for (var i = 0; i < entities.length; i += 1) {
    var entity = entities[i];
    if (entity.id === player.id || entity.typeId === "minecraft:player") {
      continue;
    }

    var distance = Math.sqrt(distanceSquared(player.location, entity.location));
    var shortType = shortTypeId(entity.typeId);
    var relation = getRelationState(entity, player);
    var mind = getMobMindLocal(entity);
    var label = stripFriendPrefix(entity.nameTag || "") ? stripFriendPrefix(entity.nameTag) + " (" + shortType + ")" : shortType;
    label = label + " [" + relation + "|" + mind.intelligenceLabel + "|" + mind.socialLabel + "]";

    list.push({
      entity: entity,
      shortType: shortType,
      label: label,
      distance: distance
    });
  }

  list.sort(function (a, b) {
    return a.distance - b.distance;
  });

  return list;
}

function listNearbyPlayerNames(player, range) {
  var names = [];
  var players = world.getAllPlayers();
  for (var i = 0; i < players.length; i += 1) {
    var other = players[i];
    if (other.id === player.id) {
      continue;
    }
    if (other.dimension.id !== player.dimension.id) {
      continue;
    }
    if (Math.sqrt(distanceSquared(player.location, other.location)) <= range) {
      names.push(other.name);
    }
  }
  return names;
}

function findPlayerByName(name) {
  var wanted = String(name || "").trim().toLowerCase();
  if (!wanted) {
    return null;
  }

  var players = world.getAllPlayers();
  for (var i = 0; i < players.length; i += 1) {
    var player = players[i];
    var pname = String(player.name || "").toLowerCase();
    if (pname === wanted || pname.indexOf(wanted) === 0) {
      return player;
    }
  }
  return null;
}

function extractTargetFromText(text) {
  var match = String(text || "").match(/(?:атак\w*|убей|напад\w*)\s+([A-Za-z0-9_]+)/i);
  return match ? match[1] : "";
}

function findEntityById(player, entityId, range) {
  var entities = player.dimension.getEntities({
    location: player.location,
    maxDistance: range
  });

  for (var i = 0; i < entities.length; i += 1) {
    if (entities[i].id === entityId) {
      return entities[i];
    }
  }

  return null;
}

function shortTypeId(typeId) {
  return String(typeId || "").replace("minecraft:", "");
}

function ownerTagFor(player) {
  return "neiro_owner_" + safeTagPart(player.id);
}

function enemyTagFor(player) {
  return "neiro_enemy_" + safeTagPart(player.id);
}

function attackTagFor(player) {
  return "neiro_atk_" + safeTagPart(player.id);
}

function clearEnemyTag(mob, player) {
  removeTag(mob, enemyTagFor(player));
}

function clearAttackOrders(mob) {
  var tags = mob.getTags();
  for (var i = 0; i < tags.length; i += 1) {
    if (tags[i].indexOf("neiro_atk_") === 0 || tags[i] === "neiro_on_order") {
      removeTag(mob, tags[i]);
    }
  }
}

function addTag(entity, tag) {
  if (!entity.hasTag(tag)) {
    entity.addTag(tag);
  }
}

function removeTag(entity, tag) {
  if (entity.hasTag(tag)) {
    entity.removeTag(tag);
  }
}

function safeTagPart(value) {
  return String(value).replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40);
}

function distanceSquared(a, b) {
  var dx = a.x - b.x;
  var dy = a.y - b.y;
  var dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function roundLocation(location) {
  return {
    x: Math.round(location.x * 10) / 10,
    y: Math.round(location.y * 10) / 10,
    z: Math.round(location.z * 10) / 10
  };
}

function offsetLocation(location, x, y, z) {
  return {
    x: location.x + x,
    y: location.y + y,
    z: location.z + z
  };
}
