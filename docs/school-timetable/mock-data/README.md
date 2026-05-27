# School Timetable Mock Data

这是一个用于小学/初中排课 agent skill 的模拟数据集。

- 学校：小学一至六年级，每个年级6个班；初中一年级6个班；共42个班。
- 校区：东校区承载小学一至三年级，西校区承载小学四至六年级和初中一年级。
- 约束：包含课程计划禁排日、教师不可用、专用教室、连堂、隔天分布、固定升旗/班会、教师不跨校区等。
- Agentic 场景：`runtime_constraint_changes.json` 模拟运行中新增约束；`infeasible_scenarios.json` 模拟绝对矛盾。

重新生成：

```bash
node docs/school-timetable/mock-data/generate-mock-data.mjs
```

入口文件建议先看 `manifest.json`，再按需读取其他 JSON。
