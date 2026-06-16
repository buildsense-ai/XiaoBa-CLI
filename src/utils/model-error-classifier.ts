export const MODEL_IMAGE_SAFETY_MESSAGE =
  '模型拒绝了当前对话里的某张图片，可能触发了上游图片安全策略。本轮已停止；请删除或更换这张图片，或新开对话后继续。';

export function isModelImageSafetyError(error: unknown): boolean {
  const text = String(
    error instanceof Error ? error.message : error ?? '',
  );

  const hasSafetyCode = /input[\s_-]*new[\s_-]*sensitive/i.test(text)
    || /sensitive/i.test(text);
  const hasImageEvidence = /image\s+is\s+sensitive/i.test(text)
    || /content\[\d+\][^{}]{0,120}image[^{}]{0,120}sensitive/i.test(text)
    || /messages\[\d+\][^{}]{0,180}content\[\d+\][^{}]{0,180}image/i.test(text);

  return hasSafetyCode && hasImageEvidence;
}
