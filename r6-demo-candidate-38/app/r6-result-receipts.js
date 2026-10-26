export function runtimeResultIdentity(state) {
  const result = state?.pendingResult;
  if (!result || typeof result !== "object") return null;
  const eventId = result.eventId || result.actionId || null;
  const outcome = result.outcome || "completed";
  const actionLog = [...(state.character?.actionLog || [])].reverse().find((row) =>
    row.actionId === result.actionId && row.outcome === result.outcome
    && (result.time?.to == null || Number(row.worldDay) === Number(result.time.to)));
  const transactionId = result.transactionId || result.transaction?.transactionId
    || result.causeLogEntry?.transactionId || actionLog?.transactionId || null;
  const worldDay = Number(result.time?.to ?? result.completedDay ?? state.worldDay);
  return { eventId, outcome, transactionId, worldDay };
}

export function runtimeResultReceiptKey(state) {
  const identity = runtimeResultIdentity(state);
  return identity ? JSON.stringify(identity) : null;
}

export function presentationMatchesRuntimeResult(presentation, state) {
  const identity = runtimeResultIdentity(state);
  if (!identity || !presentation || presentation.eventId !== identity.eventId) return false;
  if (presentation.runtimeReceiptKey) return presentation.runtimeReceiptKey === JSON.stringify(identity);
  if (!identity.transactionId || presentation.transactionId !== identity.transactionId) return false;
  const suffix = String(presentation.outcomeId || "").split(".").at(-1);
  return !suffix || suffix === identity.outcome;
}

export function recoverRuntimeResultPresentation(state, instanceId) {
  const identity = runtimeResultIdentity(state);
  if (!identity) return null;
  const runtimeReceiptKey = JSON.stringify(identity);
  const transactionId = identity.transactionId || `recovered:${runtimeReceiptKey}`;
  const outcomeId = `${identity.eventId}.${identity.outcome}`;
  return {
    resultId: `${instanceId}:${outcomeId}:${transactionId}`,
    eventId: identity.eventId,
    instanceId,
    outcomeId,
    transactionId,
    runtimeReceiptKey,
    readState: "unread"
  };
}

export function reconcileRuntimeResult(presentation, state) {
  if (!state?.pendingResult) return { action: "none", presentation };
  if (presentation?.readState === "unread") {
    return presentationMatchesRuntimeResult(presentation, state)
      ? { action: "preserve", presentation }
      : { action: "conflict", presentation };
  }
  if (presentation?.readState === "read" && presentationMatchesRuntimeResult(presentation, state)) {
    return { action: "clear_acknowledged", presentation };
  }
  const identity = runtimeResultIdentity(state);
  return {
    action: "recover_unread",
    presentation: recoverRuntimeResultPresentation(state, `${state.worldId}:${state.character?.lifeIndex}:${identity?.eventId}`)
  };
}
