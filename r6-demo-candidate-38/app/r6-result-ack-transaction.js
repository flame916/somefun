export async function commitRuntimeResultAcknowledgement({
  engine,
  envelope,
  matchesRuntimeResult,
  mutatePresentation,
  persist
}) {
  const beforeEngineDto = engine.toSaveDto();
  const beforeEnvelope = structuredClone(envelope);
  try {
    const state = engine.save();
    if (state?.pendingResult && !matchesRuntimeResult(envelope.presentation.pendingResult, state)) {
      throw new Error("result_receipt_mismatch");
    }
    if (state?.pendingResult) engine.acknowledgeResult();
    envelope.presentation.pendingResult.readState = "read";
    mutatePresentation();
    envelope.r5Save = engine.toSaveDto();
    await persist();
  } catch (error) {
    engine.restoreDto(beforeEngineDto);
    envelope.r5Save = beforeEnvelope.r5Save;
    envelope.presentation = beforeEnvelope.presentation;
    throw error;
  }
}
