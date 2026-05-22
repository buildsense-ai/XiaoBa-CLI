import { createHash } from 'crypto';
import type { ReviewData, ReviewEntry, ReviewSession, ReviewTurn } from './catsco-review-agent-client';

export type UsageTopicId =
  | 'grades_or_exams'
  | 'course_schedule'
  | 'student_records'
  | 'notices_or_messages'
  | 'documents'
  | 'spreadsheets_or_data'
  | 'policy_or_process'
  | 'teaching_materials'
  | 'presentation_or_media'
  | 'agent_help'
  | 'general_question';

export interface ReviewUsageAnalysis {
  window: {
    uploadedFrom?: string | null;
    uploadedTo?: string | null;
  };
  target: {
    userKey?: string;
    deviceKey?: string;
    botKey?: string;
    personKey?: string;
    actorKey?: string;
  };
  totals: {
    userCount: number;
    deviceCount: number;
    botCount: number;
    personCount: number;
    actorCount: number;
    sessionCount: number;
    activeDays: number;
    turnCount: number;
    loadedTurnCount: number;
    toolCallCount: number;
    totalTokens: number;
    averageTurnsPerSession: number;
  };
  users: ReviewUsageUserSummary[];
  actors: ReviewUsageActorSummary[];
  topics: ReviewUsageTopicSummary[];
  timeBuckets: {
    byDay: ReviewUsageTimeBucket[];
    byHour: ReviewUsageTimeBucket[];
    byWeekday: ReviewUsageTimeBucket[];
  };
  toolUsage: ReviewUsageToolSummary[];
  sessionTypes: ReviewUsageNamedCount[];
  segments: {
    orgKeys: ReviewUsageNamedCount[];
    orgTypes: ReviewUsageNamedCount[];
    botKeys: ReviewUsageNamedCount[];
    personKeys: ReviewUsageNamedCount[];
    actorKeys: ReviewUsageNamedCount[];
    actorCatscoUserKeys: ReviewUsageNamedCount[];
    actorWeixinUserKeys: ReviewUsageNamedCount[];
    actorFeishuUserKeys: ReviewUsageNamedCount[];
    userRoles: ReviewUsageNamedCount[];
    deviceRoles: ReviewUsageNamedCount[];
    channelTypes: ReviewUsageNamedCount[];
    workspaceKeys: ReviewUsageNamedCount[];
  };
  questionSamples: ReviewUsageQuestionSample[];
}

export interface ReviewUsageActorSummary {
  actorKey: string;
  personKeys: ReviewUsageNamedCount[];
  botKeys: ReviewUsageNamedCount[];
  sessionCount: number;
  activeDays: number;
  firstSeenAt?: string;
  lastSeenAt?: string;
  turnCount: number;
  loadedTurnCount: number;
  toolCallCount: number;
  totalTokens: number;
  topTopics: ReviewUsageNamedCount[];
  topTools: ReviewUsageNamedCount[];
}

export interface ReviewUsageUserSummary {
  userKey: string;
  deviceCount: number;
  sessionCount: number;
  activeDays: number;
  firstSeenAt?: string;
  lastSeenAt?: string;
  turnCount: number;
  loadedTurnCount: number;
  toolCallCount: number;
  totalTokens: number;
  averageTurnsPerSession: number;
  topTopics: ReviewUsageNamedCount[];
  topTools: ReviewUsageNamedCount[];
}

export interface ReviewUsageTopicSummary {
  topic: UsageTopicId;
  label: string;
  count: number;
  userCount: number;
  sessionCount: number;
  questionHashes: string[];
}

export interface ReviewUsageTimeBucket {
  bucket: string;
  sessionCount: number;
  turnCount: number;
}

export interface ReviewUsageToolSummary {
  name: string;
  count: number;
  sessionCount: number;
  userCount: number;
  actorCount: number;
}

export interface ReviewUsageNamedCount {
  name: string;
  count: number;
}

export interface ReviewUsageQuestionSample {
  topic: UsageTopicId;
  label: string;
  questionHash: string;
  userKey: string;
  botKey?: string;
  personKey?: string;
  actorKey?: string;
  sessionKey: string;
  turnNo: number;
  timestamp?: string | null;
}

interface MutableUserUsage {
  userKey: string;
  deviceKeys: Set<string>;
  sessionIds: Set<string>;
  activeDays: Set<string>;
  firstSeenAt?: string;
  lastSeenAt?: string;
  turnCount: number;
  loadedTurnCount: number;
  toolCallCount: number;
  totalTokens: number;
  topics: Map<string, number>;
  tools: Map<string, number>;
}

interface MutableActorUsage {
  actorKey: string;
  personKeys: Map<string, number>;
  botKeys: Map<string, number>;
  sessionIds: Set<string>;
  activeDays: Set<string>;
  firstSeenAt?: string;
  lastSeenAt?: string;
  turnCount: number;
  loadedTurnCount: number;
  toolCallCount: number;
  totalTokens: number;
  topics: Map<string, number>;
  tools: Map<string, number>;
}

interface MutableTopicUsage {
  topic: UsageTopicId;
  label: string;
  count: number;
  userKeys: Set<string>;
  actorKeys: Set<string>;
  personKeys: Set<string>;
  botKeys: Set<string>;
  sessionIds: Set<string>;
  questionHashes: string[];
}

interface MutableToolUsage {
  name: string;
  count: number;
  sessionIds: Set<string>;
  userKeys: Set<string>;
  actorKeys: Set<string>;
  personKeys: Set<string>;
  botKeys: Set<string>;
}

interface UsageSessionContext {
  session_record_id: string;
  user_key?: string | null;
  device_key?: string | null;
  bot_key?: string | null;
  person_key?: string | null;
  actor_key?: string | null;
  actor_catsco_user_key?: string | null;
  actor_weixin_user_key?: string | null;
  actor_feishu_user_key?: string | null;
  session_key?: string | null;
}

const TOPIC_LABELS: Record<UsageTopicId, string> = {
  grades_or_exams: '成绩/考试/评分',
  course_schedule: '课表/排课/教室',
  student_records: '学籍/学生信息/证明',
  notices_or_messages: '通知/公告/沟通文案',
  documents: '文档/材料/报告生成',
  spreadsheets_or_data: '表格/数据统计/导出',
  policy_or_process: '流程/制度/审批咨询',
  teaching_materials: '备课/教案/题目生成',
  presentation_or_media: 'PPT/图片/多媒体材料',
  agent_help: 'Agent 使用/配置/故障',
  general_question: '其他问答',
};

const TOPIC_KEYWORDS: Array<[UsageTopicId, string[]]> = [
  ['grades_or_exams', ['成绩', '分数', '评分', '考试', '试卷', '补考', '绩点', '查分', '及格']],
  ['course_schedule', ['课表', '排课', '调课', '教室', '上课时间', '课程安排', '时间表']],
  ['student_records', ['学籍', '学生信息', '在读证明', '毕业', '档案', '证明', '名单', '学生名单']],
  ['notices_or_messages', ['通知', '公告', '群发', '短信', '邮件', '微信', '文案', '提醒']],
  ['spreadsheets_or_data', ['excel', '表格', '数据', '统计', '汇总', 'csv', '导出', '筛选']],
  ['documents', ['文档', '材料', '报告', '申请书', '总结', '制度文件', 'word']],
  ['policy_or_process', ['流程', '规定', '办法', '审批', '请假', '选课', '报名', '政策']],
  ['teaching_materials', ['教案', '备课', '题目', '习题', '作业', '课堂', '课程内容']],
  ['presentation_or_media', ['ppt', '幻灯片', '图片', '海报', '演示', 'presentation']],
  ['agent_help', ['怎么用', '如何使用', '登录', '配置', '报错', '失败', 'agent', '小八']],
];

export function analyzeUsageData(
  reviewData: ReviewData,
  options: {
    targetUserKey?: string;
    targetDeviceKey?: string;
    targetBotKey?: string;
    targetPersonKey?: string;
    targetActorKey?: string;
  } = {},
): ReviewUsageAnalysis {
  const sessions = reviewData.sessions || [];
  const sessionById = new Map(sessions.map(session => [session.session_record_id, session]));
  const users = new Map<string, MutableUserUsage>();
  const actors = new Map<string, MutableActorUsage>();
  const topics = new Map<UsageTopicId, MutableTopicUsage>();
  const tools = new Map<string, MutableToolUsage>();
  const dayBuckets = new Map<string, ReviewUsageTimeBucket>();
  const hourBuckets = new Map<string, ReviewUsageTimeBucket>();
  const weekdayBuckets = new Map<string, ReviewUsageTimeBucket>();
  const sessionTypes = new Map<string, number>();
  const orgKeys = new Map<string, number>();
  const orgTypes = new Map<string, number>();
  const botKeys = new Map<string, number>();
  const personKeys = new Map<string, number>();
  const actorKeys = new Map<string, number>();
  const actorCatscoUserKeys = new Map<string, number>();
  const actorWeixinUserKeys = new Map<string, number>();
  const actorFeishuUserKeys = new Map<string, number>();
  const userRoles = new Map<string, number>();
  const deviceRoles = new Map<string, number>();
  const channelTypes = new Map<string, number>();
  const workspaceKeys = new Map<string, number>();
  const questionSamples: ReviewUsageQuestionSample[] = [];
  const allDeviceKeys = new Set<string>();
  const allBotKeys = new Set<string>();
  const allPersonKeys = new Set<string>();
  const allActorKeys = new Set<string>();
  const allActiveDays = new Set<string>();
  let loadedTurnCount = 0;

  for (const session of sessions) {
    const sessionContext = sessionContextFromSession(session);
    const user = ensureUser(users, session.user_key || 'unknown');
    const actor = ensureActor(actors, resolveActorKey(sessionContext));
    user.deviceKeys.add(session.device_key || 'unknown');
    user.sessionIds.add(session.session_record_id);
    user.turnCount += Number(session.turn_count || 0);
    user.toolCallCount += Number(session.tool_call_count || 0);
    user.totalTokens += Number(session.total_tokens || 0);
    actor.sessionIds.add(session.session_record_id);
    actor.turnCount += Number(session.turn_count || 0);
    actor.toolCallCount += Number(session.tool_call_count || 0);
    actor.totalTokens += Number(session.total_tokens || 0);
    allDeviceKeys.add(session.device_key || 'unknown');
    addKnownSet(allBotKeys, sessionContext.bot_key);
    addKnownSet(allPersonKeys, sessionContext.person_key);
    addKnownSet(allActorKeys, knownActorKey(sessionContext));
    incrementKnownMap(actor.personKeys, sessionContext.person_key);
    incrementKnownMap(actor.botKeys, sessionContext.bot_key);

    incrementMap(sessionTypes, session.session_type || 'unknown', 1);
    incrementKnownMap(orgKeys, session.org_key);
    incrementKnownMap(orgTypes, session.org_type);
    incrementIdentitySegments({
      context: sessionContext,
      botKeys,
      personKeys,
      actorKeys,
      actorCatscoUserKeys,
      actorWeixinUserKeys,
      actorFeishuUserKeys,
    });
    incrementKnownMap(userRoles, session.user_role);
    incrementKnownMap(deviceRoles, session.device_role);
    incrementKnownMap(channelTypes, session.channel_type);
    incrementKnownMap(workspaceKeys, session.workspace_key);
    updateUserTime(user, session);
    updateActorTime(actor, session);
    updateTimeBuckets(dayBuckets, hourBuckets, weekdayBuckets, session);
    const sessionDay = dayKey(session.started_at || session.created_at);
    if (sessionDay) {
      user.activeDays.add(sessionDay);
      actor.activeDays.add(sessionDay);
      allActiveDays.add(sessionDay);
    }
  }

  for (const [sessionRecordId, turns] of Object.entries(reviewData.sessionTurns || {})) {
    const session = sessionById.get(sessionRecordId);
    const sessionContext = session ? sessionContextFromSession(session) : sessionContextFromTurn(sessionRecordId, turns[0]);
    const user = ensureUser(users, sessionContext.user_key || 'unknown');
    user.sessionIds.add(sessionRecordId);
    user.deviceKeys.add(sessionContext.device_key || 'unknown');
    allDeviceKeys.add(sessionContext.device_key || 'unknown');
    user.loadedTurnCount += turns.length;
    loadedTurnCount += turns.length;

    for (const turn of turns) {
      const turnContext = mergeTurnContext(sessionContext, turn);
      const actor = ensureActor(actors, resolveActorKey(turnContext));
      actor.sessionIds.add(sessionRecordId);
      actor.loadedTurnCount += 1;
      addKnownSet(allBotKeys, turnContext.bot_key);
      addKnownSet(allPersonKeys, turnContext.person_key);
      addKnownSet(allActorKeys, knownActorKey(turnContext));
      incrementKnownMap(actor.personKeys, turnContext.person_key);
      incrementKnownMap(actor.botKeys, turnContext.bot_key);
      incrementIdentitySegments({
        context: turnContext,
        botKeys,
        personKeys,
        actorKeys,
        actorCatscoUserKeys,
        actorWeixinUserKeys,
        actorFeishuUserKeys,
      });
      const turnDay = dayKey(turn.timestamp);
      if (turnDay) actor.activeDays.add(turnDay);

      const text = turn.user_text || '';
      if (!text.trim()) continue;
      const topic = classifyUsageTopic(text, extractTurnToolNames(turn));
      recordTopic(topics, topic, turnContext, questionHash(text));
      incrementMap(user.topics, topic, 1);
      incrementMap(actor.topics, topic, 1);
      if (questionSamples.length < 50) {
        questionSamples.push({
          topic,
          label: TOPIC_LABELS[topic],
          questionHash: questionHash(text),
          userKey: turnContext.user_key || 'unknown',
          botKey: stringOrUndefined(turnContext.bot_key),
          personKey: stringOrUndefined(turnContext.person_key),
          actorKey: stringOrUndefined(knownActorKey(turnContext)),
          sessionKey: turnContext.session_key || 'unknown',
          turnNo: turn.turn_no,
          timestamp: turn.timestamp,
        });
      }
    }
  }

  for (const [sessionRecordId, entries] of Object.entries(reviewData.sessionEntries || {})) {
    const session = sessionById.get(sessionRecordId);
    if (!session) continue;
    const sessionContext = sessionContextFromSession(session);
    const user = ensureUser(users, session.user_key || 'unknown');
    const actor = ensureActor(actors, resolveActorKey(sessionContext));
    for (const entry of entries) {
      const toolName = normalizeToolName(entry);
      if (!toolName) continue;
      recordTool(tools, toolName, sessionContext);
      incrementMap(user.tools, toolName, 1);
      incrementMap(actor.tools, toolName, 1);
    }
  }

  const totalTurns = sessions.reduce((sum, session) => sum + Number(session.turn_count || 0), 0);
  const totalToolCalls = sessions.reduce((sum, session) => sum + Number(session.tool_call_count || 0), 0);
  const totalTokens = sessions.reduce((sum, session) => sum + Number(session.total_tokens || 0), 0);

  return {
    window: {
      uploadedFrom: reviewData.summary?.uploaded_from,
      uploadedTo: reviewData.summary?.uploaded_to,
    },
    target: {
      userKey: options.targetUserKey,
      deviceKey: options.targetDeviceKey,
      botKey: options.targetBotKey,
      personKey: options.targetPersonKey,
      actorKey: options.targetActorKey,
    },
    totals: {
      userCount: users.size,
      deviceCount: allDeviceKeys.size,
      botCount: allBotKeys.size,
      personCount: allPersonKeys.size,
      actorCount: allActorKeys.size,
      sessionCount: sessions.length,
      activeDays: allActiveDays.size,
      turnCount: totalTurns,
      loadedTurnCount,
      toolCallCount: totalToolCalls,
      totalTokens,
      averageTurnsPerSession: sessions.length ? round(totalTurns / sessions.length) : 0,
    },
    users: Array.from(users.values())
      .map(finalizeUser)
      .sort((a, b) => b.sessionCount - a.sessionCount || b.turnCount - a.turnCount || a.userKey.localeCompare(b.userKey)),
    actors: Array.from(actors.values())
      .map(finalizeActor)
      .sort((a, b) => b.sessionCount - a.sessionCount || b.loadedTurnCount - a.loadedTurnCount || a.actorKey.localeCompare(b.actorKey)),
    topics: Array.from(topics.values())
      .map(finalizeTopic)
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    timeBuckets: {
      byDay: sortedBuckets(dayBuckets),
      byHour: sortedBuckets(hourBuckets),
      byWeekday: sortedBuckets(weekdayBuckets),
    },
    toolUsage: Array.from(tools.values())
      .map(tool => ({
        name: tool.name,
        count: tool.count,
        sessionCount: tool.sessionIds.size,
        userCount: tool.userKeys.size,
        actorCount: tool.actorKeys.size,
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    sessionTypes: namedCounts(sessionTypes),
    segments: {
      orgKeys: namedCounts(orgKeys),
      orgTypes: namedCounts(orgTypes),
      botKeys: namedCounts(botKeys),
      personKeys: namedCounts(personKeys),
      actorKeys: namedCounts(actorKeys),
      actorCatscoUserKeys: namedCounts(actorCatscoUserKeys),
      actorWeixinUserKeys: namedCounts(actorWeixinUserKeys),
      actorFeishuUserKeys: namedCounts(actorFeishuUserKeys),
      userRoles: namedCounts(userRoles),
      deviceRoles: namedCounts(deviceRoles),
      channelTypes: namedCounts(channelTypes),
      workspaceKeys: namedCounts(workspaceKeys),
    },
    questionSamples,
  };
}

export function classifyUsageTopic(text: string, toolNames: string[] = []): UsageTopicId {
  const lowered = `${text}\n${toolNames.join('\n')}`.toLowerCase();
  for (const [topic, keywords] of TOPIC_KEYWORDS) {
    if (keywords.some(keyword => lowered.includes(keyword.toLowerCase()))) {
      return topic;
    }
  }
  return 'general_question';
}

function ensureUser(users: Map<string, MutableUserUsage>, userKey: string): MutableUserUsage {
  const existing = users.get(userKey);
  if (existing) return existing;
  const next: MutableUserUsage = {
    userKey,
    deviceKeys: new Set<string>(),
    sessionIds: new Set<string>(),
    activeDays: new Set<string>(),
    turnCount: 0,
    loadedTurnCount: 0,
    toolCallCount: 0,
    totalTokens: 0,
    topics: new Map<string, number>(),
    tools: new Map<string, number>(),
  };
  users.set(userKey, next);
  return next;
}

function ensureActor(actors: Map<string, MutableActorUsage>, actorKey: string): MutableActorUsage {
  const existing = actors.get(actorKey);
  if (existing) return existing;
  const next: MutableActorUsage = {
    actorKey,
    personKeys: new Map<string, number>(),
    botKeys: new Map<string, number>(),
    sessionIds: new Set<string>(),
    activeDays: new Set<string>(),
    turnCount: 0,
    loadedTurnCount: 0,
    toolCallCount: 0,
    totalTokens: 0,
    topics: new Map<string, number>(),
    tools: new Map<string, number>(),
  };
  actors.set(actorKey, next);
  return next;
}

function updateUserTime(user: MutableUserUsage, session: ReviewSession): void {
  const timestamp = normalizeTimestamp(session.started_at || session.created_at);
  if (!timestamp) return;
  if (!user.firstSeenAt || timestamp < user.firstSeenAt) user.firstSeenAt = timestamp;
  if (!user.lastSeenAt || timestamp > user.lastSeenAt) user.lastSeenAt = timestamp;
}

function updateActorTime(actor: MutableActorUsage, session: ReviewSession): void {
  const timestamp = normalizeTimestamp(session.started_at || session.created_at);
  if (!timestamp) return;
  if (!actor.firstSeenAt || timestamp < actor.firstSeenAt) actor.firstSeenAt = timestamp;
  if (!actor.lastSeenAt || timestamp > actor.lastSeenAt) actor.lastSeenAt = timestamp;
}

function updateTimeBuckets(
  byDay: Map<string, ReviewUsageTimeBucket>,
  byHour: Map<string, ReviewUsageTimeBucket>,
  byWeekday: Map<string, ReviewUsageTimeBucket>,
  session: ReviewSession,
): void {
  const date = parseReviewDate(session.started_at || session.created_at);
  if (!date) return;
  const turnCount = Number(session.turn_count || 0);
  addBucket(byDay, date.toISOString().slice(0, 10), turnCount);
  addBucket(byHour, String(date.getUTCHours()).padStart(2, '0'), turnCount);
  addBucket(byWeekday, String(date.getUTCDay()), turnCount);
}

function addBucket(map: Map<string, ReviewUsageTimeBucket>, bucket: string, turnCount: number): void {
  const existing = map.get(bucket) || { bucket, sessionCount: 0, turnCount: 0 };
  existing.sessionCount += 1;
  existing.turnCount += turnCount;
  map.set(bucket, existing);
}

function recordTopic(
  topics: Map<UsageTopicId, MutableTopicUsage>,
  topic: UsageTopicId,
  session: UsageSessionContext,
  hash: string,
): void {
  const existing = topics.get(topic) || {
    topic,
    label: TOPIC_LABELS[topic],
    count: 0,
    userKeys: new Set<string>(),
    actorKeys: new Set<string>(),
    personKeys: new Set<string>(),
    botKeys: new Set<string>(),
    sessionIds: new Set<string>(),
    questionHashes: [],
  };
  existing.count += 1;
  existing.userKeys.add(session.user_key || 'unknown');
  existing.actorKeys.add(resolveActorKey(session));
  addKnownSet(existing.personKeys, session.person_key);
  addKnownSet(existing.botKeys, session.bot_key);
  existing.sessionIds.add(session.session_record_id);
  if (existing.questionHashes.length < 8 && !existing.questionHashes.includes(hash)) {
    existing.questionHashes.push(hash);
  }
  topics.set(topic, existing);
}

function recordTool(tools: Map<string, MutableToolUsage>, name: string, session: UsageSessionContext): void {
  const existing = tools.get(name) || {
    name,
    count: 0,
    sessionIds: new Set<string>(),
    userKeys: new Set<string>(),
    actorKeys: new Set<string>(),
    personKeys: new Set<string>(),
    botKeys: new Set<string>(),
  };
  existing.count += 1;
  existing.sessionIds.add(session.session_record_id);
  existing.userKeys.add(session.user_key || 'unknown');
  existing.actorKeys.add(resolveActorKey(session));
  addKnownSet(existing.personKeys, session.person_key);
  addKnownSet(existing.botKeys, session.bot_key);
  tools.set(name, existing);
}

function sessionContextFromSession(session: ReviewSession): UsageSessionContext {
  return {
    session_record_id: session.session_record_id,
    user_key: session.user_key || 'unknown',
    device_key: session.device_key || 'unknown',
    bot_key: session.bot_key,
    person_key: session.person_key,
    actor_key: session.actor_key,
    actor_catsco_user_key: session.actor_catsco_user_key,
    actor_weixin_user_key: session.actor_weixin_user_key,
    actor_feishu_user_key: session.actor_feishu_user_key,
    session_key: session.session_key || session.session_record_id,
  };
}

function sessionContextFromTurn(sessionRecordId: string, turn?: ReviewTurn): UsageSessionContext {
  return {
    session_record_id: sessionRecordId,
    user_key: turn?.user_key || 'unknown',
    device_key: turn?.device_key || 'unknown',
    bot_key: turn?.bot_key,
    person_key: turn?.person_key,
    actor_key: turn?.actor_key,
    actor_catsco_user_key: turn?.actor_catsco_user_key,
    actor_weixin_user_key: turn?.actor_weixin_user_key,
    actor_feishu_user_key: turn?.actor_feishu_user_key,
    session_key: turn?.session_key || sessionRecordId,
  };
}

function mergeTurnContext(base: UsageSessionContext, turn: ReviewTurn): UsageSessionContext {
  return {
    session_record_id: base.session_record_id,
    user_key: turn.user_key || base.user_key,
    device_key: turn.device_key || base.device_key,
    bot_key: turn.bot_key || base.bot_key,
    person_key: turn.person_key || base.person_key,
    actor_key: turn.actor_key || base.actor_key,
    actor_catsco_user_key: turn.actor_catsco_user_key || base.actor_catsco_user_key,
    actor_weixin_user_key: turn.actor_weixin_user_key || base.actor_weixin_user_key,
    actor_feishu_user_key: turn.actor_feishu_user_key || base.actor_feishu_user_key,
    session_key: turn.session_key || base.session_key,
  };
}

function finalizeUser(user: MutableUserUsage): ReviewUsageUserSummary {
  return {
    userKey: user.userKey,
    deviceCount: user.deviceKeys.size,
    sessionCount: user.sessionIds.size,
    activeDays: user.activeDays.size,
    firstSeenAt: user.firstSeenAt,
    lastSeenAt: user.lastSeenAt,
    turnCount: user.turnCount,
    loadedTurnCount: user.loadedTurnCount,
    toolCallCount: user.toolCallCount,
    totalTokens: user.totalTokens,
    averageTurnsPerSession: user.sessionIds.size ? round(user.turnCount / user.sessionIds.size) : 0,
    topTopics: namedCounts(user.topics, topic => TOPIC_LABELS[topic as UsageTopicId] || topic),
    topTools: namedCounts(user.tools),
  };
}

function finalizeActor(actor: MutableActorUsage): ReviewUsageActorSummary {
  return {
    actorKey: actor.actorKey,
    personKeys: namedCounts(actor.personKeys),
    botKeys: namedCounts(actor.botKeys),
    sessionCount: actor.sessionIds.size,
    activeDays: actor.activeDays.size,
    firstSeenAt: actor.firstSeenAt,
    lastSeenAt: actor.lastSeenAt,
    turnCount: actor.turnCount,
    loadedTurnCount: actor.loadedTurnCount,
    toolCallCount: actor.toolCallCount,
    totalTokens: actor.totalTokens,
    topTopics: namedCounts(actor.topics, topic => TOPIC_LABELS[topic as UsageTopicId] || topic),
    topTools: namedCounts(actor.tools),
  };
}

function finalizeTopic(topic: MutableTopicUsage): ReviewUsageTopicSummary {
  return {
    topic: topic.topic,
    label: topic.label,
    count: topic.count,
    userCount: topic.userKeys.size,
    sessionCount: topic.sessionIds.size,
    questionHashes: topic.questionHashes,
  };
}

function namedCounts(map: Map<string, number>, labelFor: (key: string) => string = key => key): ReviewUsageNamedCount[] {
  return Array.from(map.entries())
    .map(([key, count]) => ({ name: labelFor(key), count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function sortedBuckets(map: Map<string, ReviewUsageTimeBucket>): ReviewUsageTimeBucket[] {
  return Array.from(map.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));
}

function normalizeToolName(entry: ReviewEntry): string | undefined {
  const raw = String(entry.tool_name || '').trim();
  if (!raw || raw === 'none') return undefined;
  return raw.slice(0, 120);
}

function extractTurnToolNames(turn: ReviewTurn): string[] {
  if (!turn.tool_calls_json) return [];
  try {
    return extractToolNames(JSON.parse(turn.tool_calls_json));
  } catch {
    return [];
  }
}

function extractToolNames(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap(extractToolNames);
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const names: string[] = [];
    if (typeof record.name === 'string') names.push(record.name);
    if (record.function) names.push(...extractToolNames(record.function));
    if (record.tool_calls) names.push(...extractToolNames(record.tool_calls));
    return names;
  }
  return [];
}

function questionHash(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return `q_${createHash('sha256').update(normalized).digest('hex').slice(0, 12)}`;
}

function dayKey(value?: string | null): string | undefined {
  const date = parseReviewDate(value);
  return date ? date.toISOString().slice(0, 10) : undefined;
}

function normalizeTimestamp(value?: string | null): string | undefined {
  const date = parseReviewDate(value);
  return date ? date.toISOString() : undefined;
}

function parseReviewDate(value?: string | null): Date | undefined {
  if (!value) return undefined;
  const raw = String(value).trim();
  if (!raw) return undefined;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function incrementIdentitySegments(input: {
  context: UsageSessionContext;
  botKeys: Map<string, number>;
  personKeys: Map<string, number>;
  actorKeys: Map<string, number>;
  actorCatscoUserKeys: Map<string, number>;
  actorWeixinUserKeys: Map<string, number>;
  actorFeishuUserKeys: Map<string, number>;
}): void {
  incrementKnownMap(input.botKeys, input.context.bot_key);
  incrementKnownMap(input.personKeys, input.context.person_key);
  incrementKnownMap(input.actorKeys, knownActorKey(input.context));
  incrementKnownMap(input.actorCatscoUserKeys, input.context.actor_catsco_user_key);
  incrementKnownMap(input.actorWeixinUserKeys, input.context.actor_weixin_user_key);
  incrementKnownMap(input.actorFeishuUserKeys, input.context.actor_feishu_user_key);
}

function resolveActorKey(context: UsageSessionContext): string {
  return stringOrUndefined(knownActorKey(context))
    || stringOrUndefined(context.person_key)
    || stringOrUndefined(context.user_key)
    || 'unknown';
}

function knownActorKey(context: UsageSessionContext): string | undefined {
  return stringOrUndefined(context.actor_key)
    || stringOrUndefined(context.actor_catsco_user_key)
    || stringOrUndefined(context.actor_weixin_user_key)
    || stringOrUndefined(context.actor_feishu_user_key);
}

function addKnownSet(set: Set<string>, value?: string | null): void {
  const text = stringOrUndefined(value);
  if (text) set.add(text);
}

function incrementMap(map: Map<string, number>, key: string, amount: number): void {
  map.set(key, (map.get(key) || 0) + amount);
}

function incrementKnownMap(map: Map<string, number>, value?: string | null): void {
  const key = String(value || '').trim();
  if (!key) return;
  incrementMap(map, key, 1);
}

function stringOrUndefined(value?: string | null): string | undefined {
  const text = String(value || '').trim();
  return text || undefined;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
