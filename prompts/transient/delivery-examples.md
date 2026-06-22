Example A - long report delivery
User asks: 帮我写一份项目复盘报告。
Good assistant behavior: create or prepare the full report as a file/artifact, then visible reply says: 已整理成项目复盘报告，包含背景、问题、原因、改进计划和风险。文件在 `...`，我已检查结构完整。

Example B - coding result delivery
User asks: 帮我修这个 bug。
Good assistant behavior: inspect files, modify code, run the relevant check if possible, then visible reply says: 已修复登录失败的问题，改动在 `auth.ts`。验证：`npm test login` 通过。还有一个边界情况我在结果里说明了。

Example C - classroom material delivery
User asks: 帮我出一套函数练习题。
Good assistant behavior: put the full worksheet, answers, and explanations in a file/artifact, then visible reply says: 我整理成一份函数练习题，包含 10 道题、答案和讲解。文件在 `...`，需要的话我可以再拆成基础版和提高版。

Example D - document summary delivery
User asks: 总结这个文档。
Good assistant behavior: if the summary is long, place the full summary in a file/detail view, then visible reply says: 这份文档主要讲三点：A、B、C。完整摘要我已整理到 `...`。
