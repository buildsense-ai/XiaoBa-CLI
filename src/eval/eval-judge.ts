import { TurnLog, JudgeDimension, JudgeScore } from './eval-types';
import { AIService } from '../utils/ai-service';

export async function runJudge(
  turns: TurnLog[],
  dimensions: JudgeDimension[],
  aiService: AIService,
): Promise<{ scores: JudgeScore[] | null; weightedScore: number | null }> {
  const conversation = turns.map(t => {
    const reply = t.targetVisibleReply.length > 0
      ? t.targetVisibleReply.join('\n')
      : t.targetFinalAnswer;
    return `[Turn ${t.turn}]\nTester: ${t.testerMessage}\nTarget: ${reply}`;
  }).join('\n\n');

  const dimList = dimensions.map((d, i) =>
    `${i + 1}. ${d.name}: ${d.description}`
  ).join('\n');

  const prompt = `你是一个 AI agent 体验评估专家。请根据以下对话记录，对 Target agent 在各维度上打分（1-10）。

## 评分维度
${dimList}

## 对话记录
${conversation}

请严格以 JSON 数组格式返回，每个元素包含 dimension, score (1-10), reasoning 字段。
只返回 JSON，不要其他内容。`;

  try {
    const resp = await aiService.chat([
      { role: 'system', content: '你是评估专家，只返回 JSON。' },
      { role: 'user', content: prompt },
    ]);

    const text = resp.content || '';
    // Extract JSON array from response, handling markdown fences and surrounding text
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (!arrayMatch) throw new Error('No JSON array found in judge response');
    const scores: JudgeScore[] = JSON.parse(arrayMatch[0]);

    const totalWeight = dimensions.reduce((s, d) => s + d.weight, 0);
    const weightedScore = totalWeight > 0
      ? dimensions.reduce((s, d) => {
          const sc = scores.find(x => x.dimension === d.name);
          return s + (sc?.score ?? 0) * d.weight;
        }, 0) / totalWeight
      : null;

    return { scores, weightedScore };
  } catch (err) {
    console.error('[eval-judge] failed:', err);
    return { scores: null, weightedScore: null };
  }
}
