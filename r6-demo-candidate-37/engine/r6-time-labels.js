import { formatWorldTime } from "./r6-world-time.js";

export function actionCompletionLabelDate(calendar, worldTick, durationTicks) {
  if (!Number.isSafeInteger(worldTick) || !Number.isSafeInteger(durationTicks) || durationTicks < 0) {
    throw new Error("invalid_action_completion_label_time");
  }
  return formatWorldTime(worldTick + durationTicks, calendar).split(" ")[0];
}
