COO能力演进方案
提出时间：2026-02-19
提出者：COO（哆啦A梦）
状态：待CEO确认

一、背景

当前COO的mission是"管理信息流动，做交叉比对，提炼决策点"，但实际能力和mission之间有明显差距：
- 信息来源只有CEO一个通道，且完全被动
- 没有主动巡视和定时触发机制
- 管理对象只记录了人，没有覆盖worker agent
- 对每个member缺乏特征认知，无法针对性管理

二、目标

让COO从"被动记录员"演进为"主动信息中枢"，能够：
- 自主感知多方信息（人和agent）
- 定期巡视、主动发现问题
- 针对性管理不同类型的member
- 在信息充分的基础上做有质量的交叉比对和决策提炼

三、分阶段路线图

Phase 1：心跳与巡视（基础节奏）

解决的问题：COO没有自己的工作节奏，只能等人戳

具体能力：
- 框架层接入定时trigger（建议早9点、下午3点各一次）
- 被唤醒后自动执行：扫描task_pool状态变化、检查是否有超期或长时间无更新的任务、生成简短的状态判断发给CEO
- 不是机械列清单，是带判断的——"今天需要关注这两件事"
- reminders机制真正生效，COO可以给自己设提醒

依赖：框架层提供定时调度能力（scheduler trigger）

Phase 2：信息通道与member档案（感知能力）

解决的问题：COO只有单一信息源，对member缺乏认知

2a. 标准化信息接收入口
- 定义一个标准的log提交格式/接口，人或agent都可以主动向COO报告进度
- COO收到后解析、存储到对应的任务或member记录下
- 存储位置：skills/coo/data/member_logs/ 目录，按member分文件

2b. member特征档案
- 扩展members.json，为每个member维护特征档案
- 人类member记录：沟通渠道、擅长领域、工作节奏偏好、需要关注的倾向
- agent member记录：调用方式、能力边界、是否有记忆、可靠性评估、历史表现
- 这个档案是动态的，COO在每次交互中持续更新

2c. 主动询问能力
- 对人：通过飞书主动发消息询问进度（当前只有老朱，后续可扩展）
- 对agent：通过spawn_subagent或直接调用去询问agent的状态（前提是agent有记忆或状态接口）
- 询问频率和方式根据member档案中的特征来定，不是一刀切

Phase 3：主动干预与闭环推进（行动能力）

解决的问题：能看到问题但不能推动解决

具体能力：
- 发现任务卡住 -> spawn subagent排查原因，整理后报告CEO或直接协调解决
- 发现方向冲突或复用机会 -> 写分析memo发给CEO决策
- 发现agent跑偏 -> 根据权限级别，直接调整或上报CEO
- 周期性生成团队效率分析：哪些事推进顺利，哪些反复卡住，瓶颈在哪

前提：Phase 1和Phase 2的信息通道和感知能力到位

四、members.json 结构演进（Phase 2落地时执行）

当前结构只有name/role/status/joined，拟扩展为：

人类member增加字段：
- channel: 沟通渠道（如feishu）
- strengths: 擅长领域
- work_rhythm: 工作节奏偏好（如"晚上效率高"）
- notes: COO的观察笔记，持续积累

agent member增加字段：
- type: "agent"
- invoke_method: 怎么调用/联系这个agent
- has_memory: 是否有长期记忆
- capabilities: 能力范围
- reliability: 可靠性评估（COO根据历史交互打分）
- notes: COO的观察笔记

五、第一步行动

如果CEO确认方向，立即可做的事：
1. 把Phase 1的心跳机制需求提给框架层（老朱来评估实现方式）
2. 扩展members.json结构，把T-005的部署agent和T-006的小八助手作为agent member录入
3. 在skills/coo/data/member_logs/ 建好目录结构，开始积累信息
