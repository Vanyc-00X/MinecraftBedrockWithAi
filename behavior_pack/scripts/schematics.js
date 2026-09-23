function makeBoxHouse(blockType, size, height, doorX) {
  var list = [];
  for (var x = 0; x <= size; x += 1) {
    for (var z = 0; z <= size; z += 1) {
      for (var y = 0; y <= height; y += 1) {
        var edge = x === 0 || z === 0 || x === size || z === size;
        var roof = y === height;
        var floor = y === 0;
        var door = x === doorX && z === 0 && (y === 1 || y === 2);
        if (door) {
          continue;
        }
        if (floor || roof || edge) {
          list.push({ x: x, y: y, z: z, blockType: blockType });
        }
      }
    }
  }
  return list;
}

export var SCHEMATICS = {
  wall: {
    id: "wall",
    blockType: "minecraft:cobblestone",
    blocks: (function () {
      var list = [];
      for (var x = 0; x < 5; x += 1) {
        for (var y = 0; y < 3; y += 1) {
          list.push({ x: x, y: y, z: 0, blockType: "minecraft:cobblestone" });
        }
      }
      return list;
    })()
  },
  hut: {
    id: "hut",
    blockType: "minecraft:cobblestone",
    blocks: makeBoxHouse("minecraft:cobblestone", 4, 3, 2)
  },
  good_house: {
    id: "good_house",
    blockType: "minecraft:oak_planks",
    blocks: makeBoxHouse("minecraft:oak_planks", 5, 3, 2)
  },
  evil_house: {
    id: "evil_house",
    blockType: "minecraft:nether_bricks",
    blocks: makeBoxHouse("minecraft:nether_bricks", 5, 3, 2)
  }
};

export function getSchematic(id) {
  var key = String(id || "wall").toLowerCase();
  if (key === "good_house" || key === "hut" || key === "house" || key === "дом") {
    return SCHEMATICS.good_house;
  }
  if (key === "evil_house" || key === "monster_house" || key === "логово") {
    return SCHEMATICS.evil_house;
  }
  if (key === "wall" || key === "стена") {
    return SCHEMATICS.wall;
  }
  return SCHEMATICS.wall;
}
