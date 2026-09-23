/** Intelligence and social organization profiles for Neiro mobs. */

export const INTEL_LEVELS = ["none", "spark", "basic", "smart", "genius"];
export const SOCIAL_LEVELS = ["hermit", "pack", "gang", "village"];

const INTEL_LABELS_RU = {
  none: "без интеллекта",
  spark: "зачатки",
  basic: "с интеллектом",
  smart: "умный",
  genius: "очень умный"
};

const SOCIAL_LABELS_RU = {
  hermit: "отшельник",
  pack: "стая",
  gang: "банда",
  village: "деревня"
};

/** Always locked intelligence (cannot roll lower). */
const ALWAYS_INTEL = {
  witch: "genius",
  evoker: "genius",
  enderman: "genius",
  villager: "smart",
  wandering_trader: "smart",
  iron_golem: "basic"
};

/** Default social alignment by type. */
const TYPE_SOCIAL_BIAS = {
  villager: "village",
  wandering_trader: "hermit",
  iron_golem: "village",
  wolf: "pack",
  cat: "hermit",
  cow: "pack",
  pig: "pack",
  sheep: "pack",
  chicken: "pack",
  zombie: "gang",
  husk: "gang",
  drowned: "pack",
  skeleton: "gang",
  stray: "gang",
  creeper: "hermit",
  spider: "pack",
  cave_spider: "pack",
  pillager: "gang",
  vindicator: "gang",
  evoker: "village",
  witch: "hermit",
  enderman: "hermit"
};

/** Types that prefer evil monster towns. */
const EVIL_SETTLEMENT_TYPES = new Set([
  "zombie",
  "husk",
  "drowned",
  "skeleton",
  "stray",
  "creeper",
  "spider",
  "cave_spider",
  "pillager",
  "vindicator",
  "evoker",
  "witch"
]);

const GOOD_SETTLEMENT_TYPES = new Set(["villager", "iron_golem", "cat", "wandering_trader"]);

function shortType(typeId) {
  return String(typeId || "").replace("minecraft:", "");
}

function hashString(value) {
  let h = 2166136261;
  const s = String(value || "");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickWeighted(seed, entries) {
  const total = entries.reduce((sum, e) => sum + e.w, 0);
  let roll = seed % Math.max(total, 1);
  for (const entry of entries) {
    if (roll < entry.w) {
      return entry.v;
    }
    roll -= entry.w;
  }
  return entries[entries.length - 1].v;
}

function defaultIntelWeights(type) {
  if (["chicken", "cow", "pig", "sheep", "cod", "salmon", "bat"].includes(type)) {
    return [
      { v: "none", w: 70 },
      { v: "spark", w: 25 },
      { v: "basic", w: 5 }
    ];
  }
  if (["zombie", "husk", "drowned", "spider", "cave_spider"].includes(type)) {
    return [
      { v: "none", w: 25 },
      { v: "spark", w: 35 },
      { v: "basic", w: 25 },
      { v: "smart", w: 12 },
      { v: "genius", w: 3 }
    ];
  }
  if (["skeleton", "stray", "creeper", "pillager", "vindicator"].includes(type)) {
    return [
      { v: "spark", w: 20 },
      { v: "basic", w: 40 },
      { v: "smart", w: 30 },
      { v: "genius", w: 10 }
    ];
  }
  if (["wolf", "cat"].includes(type)) {
    return [
      { v: "spark", w: 30 },
      { v: "basic", w: 45 },
      { v: "smart", w: 25 }
    ];
  }
  return [
    { v: "spark", w: 20 },
    { v: "basic", w: 45 },
    { v: "smart", w: 28 },
    { v: "genius", w: 7 }
  ];
}

function defaultSocialWeights(type) {
  const bias = TYPE_SOCIAL_BIAS[type] || "hermit";
  if (bias === "village") {
    return [
      { v: "village", w: 70 },
      { v: "pack", w: 15 },
      { v: "hermit", w: 10 },
      { v: "gang", w: 5 }
    ];
  }
  if (bias === "gang") {
    return [
      { v: "gang", w: 45 },
      { v: "village", w: 20 },
      { v: "pack", w: 20 },
      { v: "hermit", w: 15 }
    ];
  }
  if (bias === "pack") {
    return [
      { v: "pack", w: 55 },
      { v: "hermit", w: 25 },
      { v: "gang", w: 15 },
      { v: "village", w: 5 }
    ];
  }
  return [
    { v: "hermit", w: 55 },
    { v: "pack", w: 20 },
    { v: "gang", w: 15 },
    { v: "village", w: 10 }
  ];
}

export function rollMobMind(typeId, mobId) {
  const type = shortType(typeId);
  const seed = hashString(`${type}:${mobId || "x"}`);
  const seed2 = hashString(`${mobId || "x"}:social:${type}`);

  let intelligence = ALWAYS_INTEL[type] || pickWeighted(seed, defaultIntelWeights(type));
  if (ALWAYS_INTEL[type]) {
    intelligence = ALWAYS_INTEL[type];
  }

  let social = pickWeighted(seed2, defaultSocialWeights(type));
  // Genius witches stay hermit-capable but can still join evil village
  if (type === "witch" && seed2 % 100 < 40) {
    social = "village";
  }

  let settlementSide = "none";
  if (social === "village") {
    if (GOOD_SETTLEMENT_TYPES.has(type)) {
      settlementSide = "good";
    } else if (EVIL_SETTLEMENT_TYPES.has(type)) {
      settlementSide = "evil";
    } else {
      settlementSide = seed % 2 === 0 ? "good" : "evil";
    }
  } else if (social === "gang") {
    settlementSide = EVIL_SETTLEMENT_TYPES.has(type) || !GOOD_SETTLEMENT_TYPES.has(type) ? "evil" : "none";
  }

  return {
    intelligence,
    social,
    settlementSide,
    intelligenceLabel: INTEL_LABELS_RU[intelligence] || intelligence,
    socialLabel: SOCIAL_LABELS_RU[social] || social
  };
}

export function ensureNpcMind(npc, typeId, mobId) {
  if (!npc.intelligence || !INTEL_LEVELS.includes(npc.intelligence)) {
    const rolled = rollMobMind(typeId, mobId || npc.id);
    npc.intelligence = rolled.intelligence;
    npc.social = rolled.social;
    npc.settlementSide = rolled.settlementSide;
  }
  if (!npc.social || !SOCIAL_LEVELS.includes(npc.social)) {
    const rolled = rollMobMind(typeId, mobId || npc.id);
    npc.social = rolled.social;
    npc.settlementSide = npc.settlementSide || rolled.settlementSide;
  }
  if (!npc.settlementSide) {
    npc.settlementSide = rollMobMind(typeId, mobId || npc.id).settlementSide;
  }
  return npc;
}

export function intelligencePromptRules(intelligence, language) {
  const ru = language !== "en";
  switch (intelligence) {
    case "none":
      return ru
        ? "Этот моб БЕЗ интеллекта: только звуки/инстинкт, 1 короткое мычание/рычание, action почти всегда none, без планов и сделок."
        : "This mob has NO intellect: only instinctive sounds, 1 short grunt, action almost always none.";
    case "spark":
      return ru
        ? "Зачатки интеллекта: очень простые фразы (2-5 слов), путается, почти не понимает сложные приказы."
        : "Rudimentary intellect: very short simple phrases, confuses complex orders.";
    case "basic":
      return ru
        ? "Обычный интеллект: короткие ясные реплики, простые приказы понимает, сложные схемы — редко."
        : "Basic intellect: clear short lines, understands simple orders.";
    case "smart":
      return ru
        ? "Умный моб: осознанные цели, память, торг, тактика, может вести других."
        : "Smart mob: goals, memory, trade, tactics, can lead others.";
    case "genius":
      return ru
        ? "Очень умный: стратегия, интриги, сложные планы, лидер поселения, тонкий язык."
        : "Genius: strategy, intrigue, complex plans, settlement leader, refined speech.";
    default:
      return "";
  }
}

export function socialPromptRules(social, settlementSide, language) {
  const ru = language !== "en";
  const side =
    settlementSide === "good"
      ? ru
        ? "добрая деревня (торговля, защита, мир)"
        : "good village (trade, protection, peace)"
      : settlementSide === "evil"
        ? ru
          ? "злая деревня/город монстров (засады, дань, вражда к чужакам)"
          : "evil monster town (ambush, tribute, hostility to outsiders)"
        : ru
          ? "без постоянного города"
          : "no permanent town";

  switch (social) {
    case "hermit":
      return ru
        ? `Социум: отшельник. Живёт один, недоверчив. Поселение: ${side}.`
        : `Social: hermit. Lives alone, distrustful. Settlement: ${side}.`;
    case "pack":
      return ru
        ? `Социум: стая. Думает о группе рядом, следует сильному. Поселение: ${side}.`
        : `Social: pack. Thinks about nearby group, follows the strong. Settlement: ${side}.`;
    case "gang":
      return ru
        ? `Социум: банда. Иерархия, добыча, угрозы. Поселение: ${side}.`
        : `Social: gang. Hierarchy, loot, threats. Settlement: ${side}.`;
    case "village":
      return ru
        ? `Социум: деревня/город. Дома, роли, общие места. Поселение: ${side}.`
        : `Social: village/town. Homes, roles, shared places. Settlement: ${side}.`;
    default:
      return "";
  }
}

export function factionForMind(typeId, mind) {
  const type = shortType(typeId);
  if (mind.settlementSide === "good" || GOOD_SETTLEMENT_TYPES.has(type)) {
    if (mind.social === "village" || type === "villager" || type === "iron_golem") {
      return "good_village";
    }
  }
  if (mind.settlementSide === "evil" || EVIL_SETTLEMENT_TYPES.has(type)) {
    if (mind.social === "village") {
      return "evil_village";
    }
    if (mind.social === "gang") {
      return "band";
    }
  }
  if (mind.social === "pack") {
    return "wild";
  }
  if (GOOD_SETTLEMENT_TYPES.has(type)) {
    return "good_village";
  }
  if (EVIL_SETTLEMENT_TYPES.has(type)) {
    return "band";
  }
  return "wild";
}

export function mindSummary(npc) {
  return {
    intelligence: npc.intelligence,
    social: npc.social,
    settlementSide: npc.settlementSide,
    intelligenceLabel: INTEL_LABELS_RU[npc.intelligence] || npc.intelligence,
    socialLabel: SOCIAL_LABELS_RU[npc.social] || npc.social
  };
}

export { INTEL_LABELS_RU, SOCIAL_LABELS_RU };
