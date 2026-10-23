const QA_SLOT_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function resolveCandidateQaSlot({ hostname, search, saveNamespace }) {
  const params = new URLSearchParams(search);
  if (!params.has("qaSlot")) {
    return {
      databaseName: "qingxu-r5-local",
      slotId: `${saveNamespace}:r6-mobile-active`,
      legacySlotId: "r5-qingxu-v1:r6-mobile-active",
      qaSlot: null,
      worldId: null,
      qaSeed: null
    };
  }
  const qaSlot = params.get("qaSlot") || "";
  if (!LOOPBACK_HOSTS.has(String(hostname).toLowerCase()) || !QA_SLOT_PATTERN.test(qaSlot)) {
    throw new Error("candidate_qa_slot_requires_loopback_and_safe_name");
  }
  const seedValue = params.get("qaSeed");
  let worldId = null;
  let qaSeed = null;
  if (seedValue != null) {
    if (!/^\d{1,10}$/.test(seedValue)) throw new Error("candidate_qa_seed_must_be_uint32");
    const seed = Number(seedValue);
    if (!Number.isSafeInteger(seed) || seed < 1 || seed > 0xffffffff) throw new Error("candidate_qa_seed_must_be_uint32");
    qaSeed = seed;
    worldId = `world-${seed.toString(36)}`;
  }
  return {
    databaseName: `qingxu-r5-local-qa-${qaSlot}`,
    slotId: `${saveNamespace}:qa:${qaSlot}:r6-mobile-active`,
    legacySlotId: `r5-qingxu-v1:qa:${qaSlot}:r6-mobile-active`,
    qaSlot,
    worldId,
    qaSeed
  };
}
