import { formatWorldTime } from "./r6-world-time.js";

export function actionCompletionLabelTime(calendar, worldTick, durationTicks) {
  if (!Number.isSafeInteger(worldTick) || !Number.isSafeInteger(durationTicks) || durationTicks < 0) {
    throw new Error("invalid_action_completion_label_time");
  }
  return formatWorldTime(worldTick + durationTicks, calendar);
}

export function formatDurationShichen(durationTicks) {
  if (!Number.isSafeInteger(durationTicks) || durationTicks < 0) throw new Error("invalid_shichen_duration");
  if (durationTicks === 0) return "不耗时";
  const days = Math.floor(durationTicks / 96);
  const remainder = durationTicks % 96;
  const wholeShichen = Math.floor(remainder / 8);
  const partialTicks = remainder % 8;
  if (!days && !wholeShichen) return "不足一个时辰";
  if (partialTicks && wholeShichen === 0) return `${days}日余不足一个时辰`;
  if (partialTicks) return `${days ? `${days}日又` : ""}不足${wholeShichen + 1}个时辰`;
  return [days ? `${days}日` : "", wholeShichen ? `${wholeShichen}个时辰` : ""].filter(Boolean).join("又");
}
