{{sections}}

这些是 runtime observation，不是用户新需求。
只整合真实列出的子任务；不要编造 sub-... ID。
子 agent 是侧路加速，主 agent 仍要继续能独立推进的主线。
最终回复依赖子 agent 结果时，用 wait_subagents 等待并收集；只看状态时用 check_subagent。
需要细节时用 check_subagent；用户要求停止时用 stop_subagent。
