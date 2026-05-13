"use strict";

const fs = require("fs");
const path = require("path");

const { readJsonl, storePaths } = require("./store");

function walkFiles(rootPath, predicate) {
  const root = path.resolve(rootPath);
  if (!fs.existsSync(root)) return [];
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) return [];
  if (stat.isFile()) return predicate(root) ? [root] : [];
  const out = [];
  for (const item of fs.readdirSync(root)) {
    const full = path.join(root, item);
    const itemStat = fs.lstatSync(full);
    if (itemStat.isSymbolicLink()) continue;
    if (itemStat.isDirectory()) {
      out.push(...walkFiles(full, predicate));
    } else if (predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

function normalizeTextField(value) {
  return typeof value === "string" ? value : "";
}

function conversationDoc(entry, logPath, jsonlLine, role, fieldPath, text, extra = {}) {
  return {
    id: [
      "conversation",
      logPath,
      jsonlLine,
      fieldPath,
      extra.toolCallId || "",
    ].join(":"),
    text,
    sourceRef: {
      kind: "conversation",
      agent: "xiaoba",
      sessionType: entry.session_type,
      sessionId: entry.session_id,
      turn: entry.turn,
      timestamp: entry.timestamp,
      role,
      fieldPath,
      toolCallId: extra.toolCallId,
      toolName: extra.toolName,
      logPath,
      jsonlLine,
    },
  };
}

function parseXiaoBaLogFile(filePath) {
  const docs = [];
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].trim();
    if (!raw) continue;
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    if (entry.entry_type !== "turn") continue;
    const jsonlLine = index + 1;
    const userText = normalizeTextField(entry.user?.text);
    if (userText) {
      docs.push(conversationDoc(entry, filePath, jsonlLine, "user", "user.text", userText));
    }
    const assistantText = normalizeTextField(entry.assistant?.text);
    if (assistantText) {
      docs.push(conversationDoc(entry, filePath, jsonlLine, "assistant", "assistant.text", assistantText));
    }
    const toolCalls = Array.isArray(entry.assistant?.tool_calls) ? entry.assistant.tool_calls : [];
    for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex += 1) {
      const toolCall = toolCalls[toolIndex];
      const result = normalizeTextField(toolCall.result);
      if (!result) continue;
      docs.push(conversationDoc(
        entry,
        filePath,
        jsonlLine,
        "tool",
        `assistant.tool_calls[${toolIndex}].result`,
        result,
        { toolCallId: toolCall.id, toolName: toolCall.name },
      ));
    }
  }
  return docs;
}

function loadConversationDocs(rootPaths = []) {
  const files = [];
  for (const root of rootPaths || []) {
    files.push(...walkFiles(root, (filePath) => filePath.endsWith(".jsonl")));
  }
  return Array.from(new Set(files))
    .sort()
    .flatMap(parseXiaoBaLogFile);
}

function loadAttachmentDocs(storeRoot) {
  const paths = storePaths(storeRoot);
  if (!fs.existsSync(paths.attachmentsFile)) return [];
  const textRoot = realPathIfExists(paths.attachmentTextDir);
  return readJsonl(paths.attachmentsFile)
    .filter((attachment) => isSafeAttachmentTextPath(attachment.extractedTextPath, textRoot))
    .map((attachment) => ({
      id: ["attachment", attachment.attachmentId, attachment.extractedTextPath].join(":"),
      text: fs.readFileSync(attachment.extractedTextPath, "utf8"),
      sourceRef: {
        kind: "attachment",
        agent: attachment.agent || "xiaoba",
        sessionType: attachment.sessionType,
        sessionId: attachment.sessionId,
        turn: attachment.turn,
        timestamp: attachment.timestamp,
        attachmentId: attachment.attachmentId,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        originalPath: attachment.originalPath,
        extractedTextPath: attachment.extractedTextPath,
      },
    }));
}

function isSafeAttachmentTextPath(filePath, textRoot) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) return false;
    const resolved = realPathIfExists(filePath);
    return resolved === textRoot || resolved.startsWith(`${textRoot}${path.sep}`);
  } catch {
    return false;
  }
}

function realPathIfExists(filePath) {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function loadSearchDocs(options = {}) {
  return [
    ...loadConversationDocs(options.rootPaths || options.sourceRoots || []),
    ...loadAttachmentDocs(options.storeRoot),
  ].filter((doc) => doc.text && doc.text.trim());
}

module.exports = {
  loadAttachmentDocs,
  loadConversationDocs,
  loadSearchDocs,
  parseXiaoBaLogFile,
  walkFiles,
};
