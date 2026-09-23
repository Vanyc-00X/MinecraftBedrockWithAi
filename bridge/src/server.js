import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureNpcMind,
  factionForMind,
  intelligencePromptRules,
  mindSummary,
  socialPromptRules
} from "./mind.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..", "..");
const memoryDir = path.join(rootDir, "memory");
const memoryPath = path.join(memoryDir, "neiro-memory.json");

const port = Number(process.env.NEIRO_PORT || 32145);
const ollamaUrl = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const defaultModel = process.env.OLLAMA_MODEL || "qwen3:14b";

const DEFAULT_SETTINGS = {
  language: "ru",
  model: defaultModel,
  listenRadius: 8,
  crowdMax: 4,
  aiVolume: 0.7
};

const DEFAULT_FACTIONS = {
  good_village: { id: "good_village", name: "Добрая деревня", attitude: "friendly", side: "good" },
  evil_village: { id: "evil_village", name: "Злая деревня монстров", attitude: "hostile", side: "evil" },
  village: { id: "village", name: "Деревня", attitude: "cautious", side: "good" },
  band: { id: "band", name: "Банда", attitude: "hostile", side: "evil" },
  wild: { id: "wild", name: "Дикие", attitude: "neutral", side: "none" }
};

let queueBusy = false;
const requestQueue = [];
const overhearPending = new Set();

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url || "/";

    if (req.method === "GET" && url === "/health") {
      const memory = await loadMemory();
      return sendJson(res, 200, {
        ok: true,
        bridge: "neiro-ai-mobs",
        model: memory.settings.model,
        ollamaUrl,
        queueLength: requestQueue.length,
        queueBusy
      });
    }

    if (req.method === "GET" && url === "/settings") {
      const memory = await loadMemory();
      return sendJson(res, 200, memory.settings);
    }

    if (req.method === "POST" && url === "/settings") {
      const payload = await readJson(req);
      const memory = await loadMemory();
      memory.settings = normalizeSettings({ ...memory.settings, ...payload });
      await saveMemory(memory);
      return sendJson(res, 200, memory.settings);
    }

    if (req.method === "POST" && url === "/chat") {
      const payload = await readJson(req);
      const reply = await enqueueOllama(() => handleChat(payload), null);
      return sendJson(res, 200, reply);
    }

    if (req.method === "POST" && url === "/chat/crowd") {
      const payload = await readJson(req);
      const playerId = payload?.player?.id || "";
      const isOverhear = payload?.source === "overhear";
      if (isOverhear && playerId && overhearPending.has(playerId)) {
        return sendJson(res, 429, { error: "AI занят, подожди.", busy: true });
      }
      if (isOverhear && playerId) {
        overhearPending.add(playerId);
      }
      try {
        const reply = await enqueueOllama(() => handleCrowdChat(payload), playerId);
        return sendJson(res, 200, reply);
      } finally {
        if (isOverhear && playerId) {
          overhearPending.delete(playerId);
        }
      }
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    const status = error?.statusCode || 500;
    sendJson(res, status, { error: error.message || "Internal error", busy: status === 429 });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Neiro bridge listening on http://127.0.0.1:${port}`);
  console.log(`Using Ollama-compatible API: ${ollamaUrl}, default model: ${defaultModel}`);
});

function enqueueOllama(job) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ job, resolve, reject });
    pumpQueue();
  });
}

async function pumpQueue() {
  if (queueBusy) {
    return;
  }
  const next = requestQueue.shift();
  if (!next) {
    return;
  }
  queueBusy = true;
  try {
    next.resolve(await next.job());
  } catch (error) {
    next.reject(error);
  } finally {
    queueBusy = false;
    pumpQueue();
  }
}

async function handleChat(payload) {
  validateChatPayload(payload);

  const memory = await loadMemory();
  const npcKey = makeNpcKey(payload);
  const npc = memory.npcs[npcKey] || createNpcMemory(payload, memory);
  ensureNpcProfile(memory, payload, npc);
  const conversation = npc.conversations[payload.player.id] || createConversationMemory(payload.player);

  if (npc.intelligence === "none") {
    const reply = buildDumbReply(payload, npc, memory);
    updateMemory(memory, npcKey, npc, conversation, payload, reply);
    await saveMemory(memory);
    reply.inventory = getInventory(memory, npcKey);
    reply.factionId = npc.factionId;
    reply.mind = mindSummary(npc);
    return reply;
  }

  const contextExtras = buildWorldContext(memory, payload, [payload.mob.id]);
  const prompt = buildNpcPrompt(payload, npc, conversation, memory, contextExtras);
  const llmResult = await callOllama(memory, prompt, numPredictForIntel(npc.intelligence));
  const reply = normalizeNpcReply(llmResult, payload, npc, conversation);
  clampReplyToIntelligence(reply, npc);

  updateMemory(memory, npcKey, npc, conversation, payload, reply);
  applySocialSideEffects(memory, payload, reply, [payload.mob.id]);
  await saveMemory(memory);

  reply.inventory = getInventory(memory, npcKey);
  reply.factionId = npc.factionId;
  reply.mind = mindSummary(npc);
  return reply;
}

async function handleCrowdChat(payload) {
  validateCrowdPayload(payload);

  const memory = await loadMemory();
  const crowdMax = clampNumber(memory.settings.crowdMax, 1, 8, 4);
  const mobs = payload.mobs.slice(0, crowdMax);
  const crowdContext = [];
  const mobIds = mobs.map((m) => m.id);

  for (const mob of mobs) {
    const singlePayload = {
      player: payload.player,
      mob,
      world: payload.world,
      nearbyPlayers: payload.nearbyPlayers || [],
      nearbyEntities: payload.nearbyEntities || [],
      message: payload.message,
      source: payload.source
    };
    const npcKey = makeNpcKey(singlePayload);
    const npc = memory.npcs[npcKey] || createNpcMemory(singlePayload, memory);
    ensureNpcProfile(memory, singlePayload, npc);
    const conversation = npc.conversations[payload.player.id] || createConversationMemory(payload.player);
    const mind = mindSummary(npc);
    crowdContext.push({
      singlePayload,
      npcKey,
      npc,
      conversation,
      summary: {
        id: mob.id,
        typeId: mob.typeId,
        name: mob.nameTag || npc.name || defaultMobName(mob.typeId),
        relation: mob.relation || "neutral",
        factionId: npc.factionId,
        mind,
        personality: describeMobPersonality(mob.typeId),
        relationship: conversation.relationship,
        mood: conversation.mood,
        inventory: getInventory(memory, npcKey),
        knownFacts: conversation.facts.slice(-4),
        recentHistory: conversation.history.slice(-3)
      }
    });
  }

  const contextExtras = buildWorldContext(memory, payload, mobIds);
  const llmResult = await callOllama(memory, buildCrowdPrompt(payload, crowdContext, memory, contextExtras), 560);
  const parsed = parseJsonFromText(llmResult);
  const rawReplies = Array.isArray(parsed.replies) ? parsed.replies : [];
  const replies = [];

  for (let i = 0; i < crowdContext.length; i += 1) {
    const ctx = crowdContext[i];
    let reply;
    if (ctx.npc.intelligence === "none") {
      reply = buildDumbReply(ctx.singlePayload, ctx.npc, memory);
    } else {
      const raw =
        rawReplies.find((item) => String(item?.mobId || "") === String(ctx.summary.id)) ||
        rawReplies[i] ||
        {};
      reply = normalizeNpcReply(JSON.stringify(raw), ctx.singlePayload, ctx.npc, ctx.conversation);
      clampReplyToIntelligence(reply, ctx.npc);
    }
    reply.mobId = ctx.summary.id;
    updateMemory(memory, ctx.npcKey, ctx.npc, ctx.conversation, ctx.singlePayload, reply);
    applySocialSideEffects(memory, ctx.singlePayload, reply, mobIds);
    reply.inventory = getInventory(memory, ctx.npcKey);
    reply.factionId = ctx.npc.factionId;
    reply.mind = mindSummary(ctx.npc);
    replies.push(reply);
  }

  maybeSeedRumorFromCrowd(memory, payload, replies);
  await saveMemory(memory);
  return { replies, settings: memory.settings };
}

function validateChatPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Expected JSON object.");
  }
  if (!payload.player?.id || !payload.player?.name) {
    throw new Error("Missing player data.");
  }
  if (!payload.mob?.id || !payload.mob?.typeId) {
    throw new Error("Missing mob data.");
  }
  if (!payload.message || typeof payload.message !== "string") {
    throw new Error("Missing message.");
  }
}

function validateCrowdPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Expected JSON object.");
  }
  if (!payload.player?.id || !payload.player?.name) {
    throw new Error("Missing player data.");
  }
  if (!Array.isArray(payload.mobs) || payload.mobs.length === 0) {
    throw new Error("Missing mobs array.");
  }
  for (const mob of payload.mobs) {
    if (!mob?.id || !mob?.typeId) {
      throw new Error("Each mob needs id and typeId.");
    }
  }
  if (!payload.message || typeof payload.message !== "string") {
    throw new Error("Missing message.");
  }
}

function actionList() {
  return [
    "none",
    "befriend",
    "stand_down",
    "hostile",
    "follow",
    "stop_follow",
    "follow_group",
    "guard_camp",
    "attack",
    "attack_player",
    "attack_entity",
    "mine_blocks",
    "place_blocks",
    "build_schematic",
    "deposit_to_player",
    "remember_place",
    "join_faction",
    "spread_rumor",
    "stop_attack",
    "stop_task",
    "trade"
  ].join("|");
}

function languageInstruction(settings) {
  if (settings.language === "en") {
    return 'CRITICAL: the dialogue field "text" MUST be written in English.';
  }
  return 'CRITICAL: the dialogue field "text" MUST be written in Russian, always. Even if the player writes in English, answer in Russian.';
}

function buildCrowdPrompt(payload, crowdContext, memory, contextExtras) {
  const lang = memory.settings.language === "en" ? "en" : "ru";
  return [
    {
      role: "system",
      content: [
        "You simulate a crowd of Minecraft Bedrock mobs hearing one player speech.",
        "Each mob replies in its own intelligence and social tier from input.",
        "none-intellect mobs should barely speak; genius mobs can lead.",
        "Good villages are peaceful/trade; evil monster towns are hostile/raid-minded.",
        languageInstruction(memory.settings),
        "Keep each reply short: 1-2 sentences.",
        "Return only valid JSON, no markdown.",
        `Allowed actions per mob: ${actionList()}.`,
        "follow_group / guard_camp / build_schematic / deposit_to_player / remember_place / join_faction good_village|evil_village|band|wild.",
        "Schema:",
        `{"replies":[{"mobId":"exact-id","mobName":"name","text":"line","action":"none","targetPlayer":"","targetType":"minecraft:chicken","blockType":"minecraft:dirt","schematicId":"wall","placeName":"лагерь","factionId":"evil_village","count":1,"mood":"neutral","relationshipDelta":0,"facts":[],"mobRelationDelta":[],"rumorText":""}]}`
      ].join(" ")
    },
    {
      role: "user",
      content: JSON.stringify({
        language: lang,
        source: payload.source || "talk",
        player: payload.player,
        nearbyPlayers: payload.nearbyPlayers || [],
        nearbyEntities: payload.nearbyEntities || [],
        placesNearby: contextExtras.places,
        rumorsAboutPlayer: contextExtras.rumors,
        mobRelations: contextExtras.mobRelations,
        factions: Object.values(memory.factions),
        playerMessageToCrowd: payload.message,
        crowd: crowdContext.map((ctx) => ctx.summary)
      })
    }
  ];
}

function buildNpcPrompt(payload, npc, conversation, memory, contextExtras) {
  const personality = describeMobPersonality(payload.mob.typeId);
  const recentHistory = conversation.history.slice(-8);
  const lang = memory.settings.language === "en" ? "en" : "ru";
  const mind = mindSummary(npc);

  return [
    {
      role: "system",
      content: [
        "You are an intelligent Minecraft Bedrock mob in a Mantella-like roleplay mod.",
        "Stay in character as the mob.",
        intelligencePromptRules(npc.intelligence, memory.settings.language),
        socialPromptRules(npc.social, npc.settlementSide, memory.settings.language),
        languageInstruction(memory.settings),
        "facts must match reply language.",
        "Return only valid JSON, no markdown.",
        `Allowed actions: ${actionList()}.`,
        "Good villages (good_village): trade, protect, build homes, welcome friends.",
        "Evil monster towns (evil_village): tribute, ambush, dark houses, hostility to strangers unless bribed/feared.",
        "Hermits avoid groups; packs follow alpha; gangs raid; village citizens care about settlement places.",
        "Low intellect must NOT use complex actions (build_schematic/trade/join_faction) unless genius/smart.",
        "Schema:",
        `{"mobName":"name","text":"line","action":"none","targetPlayer":"","targetType":"minecraft:chicken","blockType":"minecraft:dirt","schematicId":"hut","placeName":"дом","factionId":"good_village","count":1,"mood":"friendly|neutral|afraid|angry|curious","relationshipDelta":0,"facts":[],"mobRelationDelta":[],"rumorText":"","trade":{"wants":{"itemId":"minecraft:wheat","count":1},"gives":{"itemId":"minecraft:emerald","count":1}}}`
      ].join(" ")
    },
    {
      role: "user",
      content: JSON.stringify({
        language: lang,
        mob: {
          typeId: payload.mob.typeId,
          currentName: payload.mob.nameTag || npc.name,
          personality,
          relation: payload.mob?.relation || "neutral",
          factionId: npc.factionId,
          mind,
          inventory: getInventory(memory, makeNpcKey(payload))
        },
        player: payload.player,
        relationship: conversation.relationship,
        mood: conversation.mood,
        nearbyPlayers: payload.nearbyPlayers || [],
        nearbyEntities: payload.nearbyEntities || [],
        placesNearby: contextExtras.places,
        rumorsAboutPlayer: contextExtras.rumors,
        mobRelations: contextExtras.mobRelations,
        knownFacts: conversation.facts.slice(-12),
        recentHistory,
        playerMessage: payload.message
      })
    }
  ];
}

async function callOllama(memory, messages, numPredict = 220) {
  const model = memory.settings.model || defaultModel;
  const response = await fetch(`${ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      think: false,
      options: {
        temperature: 0.8,
        num_predict: numPredict
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama HTTP ${response.status}: ${text}`);
  }

  const data = await response.json();
  return data.message?.content || "";
}

function normalizeNpcReply(raw, payload, npc, conversation) {
  const parsed = typeof raw === "string" ? parseJsonFromText(raw) : raw || {};
  const action = normalizeAction(parsed.action);
  const relationshipDelta = clampNumber(parsed.relationshipDelta, -10, 10, 0);
  const mood = normalizeMood(parsed.mood || conversation.mood);

  return {
    mobName: sanitizeMobName(parsed.mobName || payload.mob.nameTag || npc.name || defaultMobName(payload.mob.typeId)),
    text: sanitizeReplyText(parsed.text || fallbackReply(payload.mob.typeId, payload)),
    action,
    targetPlayer: sanitizePlayerName(parsed.targetPlayer),
    targetType: normalizeTypeId(parsed.targetType, "minecraft:chicken"),
    blockType: normalizeTypeId(parsed.blockType, "minecraft:dirt"),
    schematicId: normalizeSchematicId(parsed.schematicId),
    placeName: sanitizePlaceName(parsed.placeName),
    factionId: normalizeFactionId(parsed.factionId),
    count: clampNumber(parsed.count, 1, 16, 1),
    mood,
    relationshipDelta,
    facts: normalizeFacts(parsed.facts),
    mobRelationDelta: normalizeMobRelationDelta(parsed.mobRelationDelta),
    rumorText: sanitizeReplyText(parsed.rumorText || "").slice(0, 200),
    trade: action === "trade" ? normalizeTrade(parsed.trade) : undefined
  };
}

function parseJsonFromText(text) {
  try {
    return JSON.parse(text);
  } catch {
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch {
        // fall through
      }
    }
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        return { replies: JSON.parse(arrayMatch[0]) };
      } catch {
        // fall through
      }
    }
    return { text };
  }
}

function updateMemory(memory, npcKey, npc, conversation, payload, reply) {
  npc.name = reply.mobName;
  npc.typeId = payload.mob.typeId;
  npc.lastSeenAt = new Date().toISOString();
  ensureNpcMind(npc, payload.mob.typeId, payload.mob.id);
  if (!npc.factionId) {
    npc.factionId = factionForMind(payload.mob.typeId, npc);
  }

  conversation.playerName = payload.player.name;
  conversation.relationship = clampNumber(conversation.relationship + reply.relationshipDelta, -100, 100, 0);
  conversation.mood = reply.mood;
  conversation.history.push({
    at: new Date().toISOString(),
    player: payload.message.slice(0, 500),
    mob: reply.text.slice(0, 500),
    action: reply.action
  });
  conversation.history = conversation.history.slice(-30);

  for (const fact of reply.facts || []) {
    if (!conversation.facts.includes(fact)) {
      conversation.facts.push(fact);
    }
  }
  conversation.facts = conversation.facts.slice(-40);

  npc.conversations[payload.player.id] = conversation;
  memory.npcs[npcKey] = npc;
  memory.updatedAt = new Date().toISOString();
}

function applySocialSideEffects(memory, payload, reply, crowdMobIds) {
  const npcKey = makeNpcKey(payload);
  const npc = memory.npcs[npcKey];
  if (!npc) {
    return;
  }

  if (reply.action === "join_faction" && reply.factionId) {
    npc.factionId = reply.factionId;
    if (reply.factionId === "good_village") {
      npc.social = "village";
      npc.settlementSide = "good";
    } else if (reply.factionId === "evil_village") {
      npc.social = "village";
      npc.settlementSide = "evil";
    } else if (reply.factionId === "band") {
      npc.social = npc.social === "village" ? "gang" : npc.social || "gang";
      npc.settlementSide = "evil";
    }
  }

  if (reply.action === "remember_place" || reply.action === "guard_camp") {
    const placeName = reply.placeName || "лагерь";
    const placeId = makePlaceId(payload.world?.dimension, placeName, payload.player.location || payload.mob.location);
    const loc = payload.player.location || payload.mob.location || { x: 0, y: 64, z: 0 };
    let kind = reply.action === "guard_camp" ? "camp" : "landmark";
    if (npc.factionId === "good_village") {
      kind = "good_village";
    } else if (npc.factionId === "evil_village") {
      kind = "evil_village";
    }
    memory.places[placeId] = {
      id: placeId,
      name: placeName,
      kind,
      dimension: payload.world?.dimension || "unknown",
      x: Number(loc.x) || 0,
      y: Number(loc.y) || 64,
      z: Number(loc.z) || 0,
      ownerFaction: npc.factionId || factionForMind(payload.mob.typeId, npc),
      note: reply.facts?.[0] || ""
    };
    if (!Array.isArray(npc.placesKnown)) {
      npc.placesKnown = [];
    }
    if (!npc.placesKnown.includes(placeId)) {
      npc.placesKnown.push(placeId);
    }
    npc.placesKnown = npc.placesKnown.slice(-12);
  }

  for (const delta of reply.mobRelationDelta || []) {
    if (!delta.otherMobId || delta.otherMobId === payload.mob.id) {
      continue;
    }
    if (crowdMobIds && crowdMobIds.length && !crowdMobIds.includes(delta.otherMobId)) {
      continue;
    }
    const key = relationKey(payload.mob.id, delta.otherMobId);
    const prev = memory.mobRelations[key] || { score: 0, status: "neutral" };
    const score = clampNumber(prev.score + Number(delta.delta || 0), -100, 100, prev.score);
    let status = delta.status || prev.status || "neutral";
    if (!["ally", "rival", "neutral"].includes(status)) {
      status = score >= 25 ? "ally" : score <= -25 ? "rival" : "neutral";
    }
    memory.mobRelations[key] = { score, status, updatedAt: new Date().toISOString() };
  }

  if (reply.action === "spread_rumor" || reply.rumorText) {
    const text = reply.rumorText || reply.text;
    if (text) {
      memory.rumors.push({
        aboutPlayerId: payload.player.id,
        aboutPlayerName: payload.player.name,
        text: String(text).slice(0, 200),
        fromMobId: payload.mob.id,
        at: new Date().toISOString()
      });
      memory.rumors = memory.rumors.slice(-80);
    }
  }
}

function maybeSeedRumorFromCrowd(memory, payload, replies) {
  if (!replies.length || Math.random() > 0.35) {
    return;
  }
  const speaker = replies[0];
  memory.rumors.push({
    aboutPlayerId: payload.player.id,
    aboutPlayerName: payload.player.name,
    text: speaker.text.slice(0, 200),
    fromMobId: speaker.mobId,
    at: new Date().toISOString()
  });
  memory.rumors = memory.rumors.slice(-80);
}

function buildWorldContext(memory, payload, mobIds) {
  const loc = payload.player?.location || { x: 0, y: 64, z: 0 };
  const places = Object.values(memory.places || {})
    .filter((p) => !payload.world?.dimension || p.dimension === payload.world.dimension)
    .map((p) => ({
      ...p,
      dist: Math.hypot((p.x || 0) - (loc.x || 0), (p.z || 0) - (loc.z || 0))
    }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 5)
    .map(({ dist, ...rest }) => rest);

  const rumors = (memory.rumors || [])
    .filter((r) => r.aboutPlayerId === payload.player.id)
    .slice(-4);

  const mobRelations = [];
  for (let i = 0; i < mobIds.length; i += 1) {
    for (let j = i + 1; j < mobIds.length; j += 1) {
      const key = relationKey(mobIds[i], mobIds[j]);
      const rel = memory.mobRelations[key];
      if (rel) {
        mobRelations.push({ a: mobIds[i], b: mobIds[j], ...rel });
      }
    }
  }

  return { places, rumors, mobRelations };
}

function ensureNpcFaction(memory, payload) {
  const npcKey = makeNpcKey(payload);
  const npc = memory.npcs[npcKey];
  if (npc) {
    ensureNpcProfile(memory, payload, npc);
  }
}

function ensureNpcProfile(memory, payload, npc) {
  ensureNpcMind(npc, payload.mob.typeId, payload.mob.id);
  if (!npc.factionId || npc.factionId === "village") {
    npc.factionId = factionForMind(payload.mob.typeId, npc);
  }
  memory.npcs[makeNpcKey(payload)] = npc;
}

function inferFactionId(typeId) {
  return factionForMind(typeId, ensureNpcMind({}, typeId, "seed"));
}

function buildDumbReply(payload, npc, memory) {
  const ru = memory.settings.language !== "en";
  const type = defaultMobName(payload.mob.typeId);
  const gruntsRu = ["*рычит*", "*ууух*", "*хрр*", "*пялится*", "*мычит*"];
  const gruntsEn = ["*grrr*", "*uhh*", "*stares*", "*snorts*"];
  const list = ru ? gruntsRu : gruntsEn;
  const idx = Math.abs(Number(String(payload.mob.id).replace(/\D/g, "").slice(-3) || 1)) % list.length;
  return {
    mobName: sanitizeMobName(npc.name || type),
    text: list[idx],
    action: "none",
    targetPlayer: "",
    targetType: "minecraft:chicken",
    blockType: "minecraft:dirt",
    schematicId: "wall",
    placeName: "",
    factionId: npc.factionId || "",
    count: 1,
    mood: "neutral",
    relationshipDelta: 0,
    facts: [],
    mobRelationDelta: [],
    rumorText: ""
  };
}

function clampReplyToIntelligence(reply, npc) {
  const intel = npc.intelligence || "basic";
  if (intel === "none") {
    reply.action = "none";
    reply.text = String(reply.text || "").slice(0, 24);
    return;
  }
  if (intel === "spark") {
    const blocked = new Set(["build_schematic", "trade", "join_faction", "attack_player", "follow_group"]);
    if (blocked.has(reply.action)) {
      reply.action = "none";
    }
    reply.text = String(reply.text || "").split(/[.!?]/)[0].slice(0, 80);
  }
  if (intel === "basic") {
    const blocked = new Set(["join_faction", "build_schematic"]);
    if (blocked.has(reply.action) && npc.social !== "village") {
      // allow place_blocks still
    }
  }
}

function numPredictForIntel(intelligence) {
  if (intelligence === "spark") return 80;
  if (intelligence === "basic") return 160;
  if (intelligence === "smart") return 240;
  if (intelligence === "genius") return 320;
  return 200;
}

function getInventory(memory, npcKey) {
  if (!memory.inventories[npcKey]) {
    memory.inventories[npcKey] = [];
  }
  return memory.inventories[npcKey];
}

function normalizeSettings(raw) {
  return {
    language: raw.language === "en" ? "en" : "ru",
    model: String(raw.model || defaultModel).trim().slice(0, 64) || defaultModel,
    listenRadius: clampNumber(raw.listenRadius, 2, 32, 8),
    crowdMax: clampNumber(raw.crowdMax, 1, 8, 4),
    aiVolume: clampNumber(raw.aiVolume, 0, 1, 0.7)
  };
}

async function loadMemory() {
  await mkdir(memoryDir, { recursive: true });

  let memory;
  try {
    const text = await readFile(memoryPath, "utf8");
    memory = JSON.parse(text);
  } catch {
    memory = {
      version: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      npcs: {}
    };
  }

  memory.version = Math.max(Number(memory.version) || 1, 2);
  memory.settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...(memory.settings || {}), model: memory.settings?.model || defaultModel });
  memory.places = memory.places || {};
  memory.factions = { ...DEFAULT_FACTIONS, ...(memory.factions || {}) };
  memory.mobRelations = memory.mobRelations || {};
  memory.rumors = Array.isArray(memory.rumors) ? memory.rumors : [];
  memory.inventories = memory.inventories || {};
  memory.npcs = memory.npcs || {};
  return memory;
}

async function saveMemory(memory) {
  await mkdir(memoryDir, { recursive: true });
  await writeFile(memoryPath, `${JSON.stringify(memory, null, 2)}\n`, "utf8");
}

function createNpcMemory(payload, memory) {
  const npc = {
    id: payload.mob.id,
    typeId: payload.mob.typeId,
    name: payload.mob.nameTag || defaultMobName(payload.mob.typeId),
    placesKnown: [],
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    conversations: {}
  };
  ensureNpcMind(npc, payload.mob.typeId, payload.mob.id);
  npc.factionId = factionForMind(payload.mob.typeId, npc);
  return npc;
}

function createConversationMemory(player) {
  return {
    playerId: player.id,
    playerName: player.name,
    relationship: 0,
    mood: "neutral",
    facts: [],
    history: []
  };
}

function makeNpcKey(payload) {
  return `${payload.world?.dimension || "unknown"}:${payload.mob.id}`;
}

function makePlaceId(dimension, name, loc) {
  const safe = String(name || "place")
    .toLowerCase()
    .replace(/[^a-z0-9а-яё_]+/gi, "_")
    .slice(0, 24);
  const x = Math.floor(Number(loc?.x) || 0);
  const z = Math.floor(Number(loc?.z) || 0);
  return `${dimension || "unknown"}:${safe}:${x}:${z}`;
}

function relationKey(a, b) {
  return [String(a), String(b)].sort().join("|");
}

function describeMobPersonality(typeId) {
  const shortType = typeId.replace("minecraft:", "");
  const profiles = {
    villager: "practical, social, trade-minded, cautious around danger",
    wolf: "loyal, direct, protective, responds strongly to friendship or betrayal",
    cat: "independent, curious, playful, does not obey easily",
    creeper: "tense, unstable, lonely, tries not to explode unless threatened",
    zombie: "hungry, simple, resentful, can still form crude opinions",
    skeleton: "dry, observant, distant, likes dark humor",
    enderman: "strange, poetic, wary of eye contact, remembers insults",
    cow: "calm, gentle, food-motivated, slow to anger",
    pig: "cheerful, hungry, opportunistic, likes simple bargains",
    sheep: "nervous, soft-spoken, herd-minded"
  };

  return profiles[shortType] || `a ${shortType} with instincts, needs, fears, and a memory for how players treat it`;
}

function normalizeAction(action) {
  const allowed = new Set(actionList().split("|"));
  return allowed.has(action) ? action : "none";
}

function normalizeFactionId(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (["good_village", "evil_village", "village", "band", "wild"].includes(value)) {
    if (value === "village") {
      return "good_village";
    }
    return value;
  }
  return "";
}

function normalizeSchematicId(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "hut" || value === "дом" || value === "house" || value === "good_house") {
    return "good_house";
  }
  if (value === "evil_house" || value === "monster_house" || value === "логово") {
    return "evil_house";
  }
  if (value === "wall" || value === "стена") {
    return "wall";
  }
  return "wall";
}

function sanitizePlaceName(name) {
  return String(name || "")
    .replace(/[\r\n<>]/g, "")
    .trim()
    .slice(0, 32);
}

function normalizeMobRelationDelta(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map((item) => ({
      otherMobId: String(item?.otherMobId || "").slice(0, 64),
      delta: clampNumber(item?.delta, -20, 20, 0),
      status: ["ally", "rival", "neutral"].includes(item?.status) ? item.status : ""
    }))
    .filter((item) => item.otherMobId)
    .slice(0, 6);
}

function sanitizePlayerName(name) {
  const value = String(name || "").trim();
  if (!value || value.length > 32) {
    return "";
  }
  return value.replace(/[<>\r\n]/g, "");
}

function normalizeTypeId(raw, fallbackId) {
  const aliases = {
    chicken: "minecraft:chicken",
    курица: "minecraft:chicken",
    cow: "minecraft:cow",
    корова: "minecraft:cow",
    pig: "minecraft:pig",
    свинья: "minecraft:pig",
    sheep: "minecraft:sheep",
    овца: "minecraft:sheep",
    wolf: "minecraft:wolf",
    волк: "minecraft:wolf",
    zombie: "minecraft:zombie",
    зомби: "minecraft:zombie",
    skeleton: "minecraft:skeleton",
    скелет: "minecraft:skeleton",
    dirt: "minecraft:dirt",
    земля: "minecraft:dirt",
    stone: "minecraft:stone",
    камень: "minecraft:stone",
    cobblestone: "minecraft:cobblestone",
    булыжник: "minecraft:cobblestone",
    oak_log: "minecraft:oak_log",
    дерево: "minecraft:oak_log",
    wood: "minecraft:oak_log",
    sand: "minecraft:sand",
    песок: "minecraft:sand",
    grass: "minecraft:grass_block",
    grass_block: "minecraft:grass_block",
    трава: "minecraft:grass_block"
  };

  let value = String(raw || "").trim().toLowerCase();
  if (!value) {
    return fallbackId;
  }
  value = value.replace(/\s+/g, "_");
  if (aliases[value]) {
    return aliases[value];
  }
  if (!value.includes(":")) {
    value = `minecraft:${value}`;
  }
  if (!/^minecraft:[a-z0-9_]+$/.test(value)) {
    return fallbackId;
  }
  return value;
}

function normalizeMood(mood) {
  const allowed = new Set(["friendly", "neutral", "afraid", "angry", "curious"]);
  return allowed.has(mood) ? mood : "neutral";
}

function normalizeFacts(facts) {
  if (!Array.isArray(facts)) {
    return [];
  }
  return facts
    .map((fact) => String(fact).trim())
    .filter(Boolean)
    .map((fact) => fact.slice(0, 160))
    .slice(0, 5);
}

function normalizeTrade(trade) {
  const wants = normalizeItemStack(trade?.wants, "minecraft:wheat");
  const gives = normalizeItemStack(trade?.gives, "minecraft:emerald");
  return { wants, gives };
}

function normalizeItemStack(stack, fallbackItemId) {
  return {
    itemId: sanitizeItemId(stack?.itemId || fallbackItemId),
    count: clampNumber(Number(stack?.count || 1), 1, 64, 1)
  };
}

function sanitizeItemId(itemId) {
  const value = String(itemId).trim();
  return /^minecraft:[a-z0-9_]+$/.test(value) ? value : "minecraft:emerald";
}

function sanitizeMobName(name) {
  return String(name).replace(/[\r\n<>]/g, "").trim().slice(0, 32) || "Mob";
}

function sanitizeReplyText(text) {
  return String(text).replace(/[\r\n]+/g, " ").trim().slice(0, 320) || "...";
}

function defaultMobName(typeId) {
  return typeId.replace("minecraft:", "").replace(/_/g, " ");
}

function fallbackReply(typeId, payload) {
  if (payload?.message && /[\u0400-\u04FF]/.test(payload.message)) {
    return `${defaultMobName(typeId)} смотрит на тебя внимательно.`;
  }
  return `The ${defaultMobName(typeId)} watches you carefully.`;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, number));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 1024 * 64) {
        req.destroy(new Error("Request body too large."));
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(`${JSON.stringify(body)}\n`);
}
