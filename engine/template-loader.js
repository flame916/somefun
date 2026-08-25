"use strict";

/**
 * 模板加载器：负责配置与内容包的装配、基础校验、占位标记检查。
 * 引擎不关心内容包来自 JSON 文件、网络还是后续数据库。
 */

function assertRequired(value, message) {
  if (value == null || value === "") throw new Error(message);
  return value;
}

function loadTemplate(templateConfig) {
  const config = templateConfig;
  assertRequired(config.id, "template.id is required");
  assertRequired(config.engine?.mode, "template.engine.mode is required");
  assertRequired(config.engine?.stageSequence?.length, "template.engine.stageSequence is required");
  assertRequired(config.attributes, "template.attributes is required");
  assertRequired(config.endings, "template.endings is required");
  return config;
}

function loadContent(content) {
  assertRequired(content.events, "content.events is required");
  assertRequired(content.endingCards, "content.endingCards is required");
  const eventIds = new Set();
  for (const event of content.events) {
    if (eventIds.has(event.id)) throw new Error(`duplicate event id: ${event.id}`);
    eventIds.add(event.id);
    if (!event.options?.length) throw new Error(`event ${event.id} has no options`);
  }
  return content;
}

function placeholderReport(content) {
  const placeholders = (content.events || []).filter((event) => event.isPlaceholder);
  const endingPlaceholders = (content.endingCards || []).filter((card) => card.isPlaceholder);
  return {
    eventPlaceholderCount: placeholders.length,
    endingPlaceholderCount: endingPlaceholders.length,
    isPlaceholder: content.meta?.isPlaceholder !== false
  };
}

module.exports = { loadTemplate, loadContent, placeholderReport };
