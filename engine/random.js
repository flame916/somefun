/**
 * 随机数统一入口：默认真随机；测试与回放可注入固定种子。
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createRandom(seed) {
  if (seed == null) return Math.random;
  return mulberry32(seed);
}

export { createRandom };
