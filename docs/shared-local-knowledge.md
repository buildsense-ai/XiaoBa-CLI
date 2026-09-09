# 本地共享知识库

同一 XiaoBa 用户数据根目录下运行的 bot 共用 `<userData>/knowledge/`。根目录遵循 `PathResolver.getRuntimeDataRoot()`：优先使用 `XIAOBA_USER_DATA_DIR` 等已有运行时配置，未配置的 CLI 使用 cwd。独立 CLI 进程如需共享，应显式配置同一用户数据目录。

默认系统提示词按需引导 Agent 使用内置 `xiaoba-knowledge` Skill。用户也可以说“记到知识库”“更新这个流程”。没有定时任务、强制收尾钩子或停止后的维护任务；自动触发由模型判断，不保证每轮执行。自定义系统提示词不会被覆盖，可自行加入相关引导。

默认引导还要求：涉及项目、环境、负责人或已有约定时，回答“不知道”“没有记录”或要求用户重给资料前，先调用 Skill 搜索；没有实际搜索不能声称查过。闲聊和无关问题不必检索。已有自定义提示词需要手动补上这条及 Skill 入口。

“以后都按这个”“以后别忘了”等明确要求今后沿用的约定也应进入更新流程。只有实际保存并核验后才能声称已记录；仅在当前会话参考不能承诺跨会话记忆。

## 文件与生命周期

Skill 包跟随现有仓库资源布局，位于 `skills/xiaoba-knowledge/`，与 `skills/catsco-prompt-editor/` 同级；`prompts/` 只保留系统提示及压缩提示。Electron 和 Worker 发布配置均已包含根目录 `skills/`。

这里有三个不同用途的目录：安装目录 `skills/xiaoba-knowledge/` 是程序提供的指导和 helper；`<userData>/skills/` 是当前 bot 的可变 Skill 工作区，受 CatsCompany 的 BotDefinition、SkillHub 安装和同步流程管理；`<userData>/knowledge/` 是同实例共享的持久知识正文。

当前知识库 Skill 由 SkillManager 在工作区没有同名 Skill 时补入，保障同一实例各 bot 默认可用；它没有注册成云端 SkillHub 包，也不属于 BotDefinition 的 Skill 清单。CatsCompany 网页对 bot Skill 的安装、删除和版本控制不会关闭这个内置回退。若以后要纳入云端开关，需另外实现实例能力配置或改变安装策略，单纯移动源码目录不能完成。既有 prompt-editor 是按需复制到 bot 工作区的 seed，三个 PDF/图片默认 Skill 则由 SkillHub 安装，两者与知识库的加载策略不同。

这是实例级产品策略：同一用户数据目录内各 bot 和能够操作该目录的本机用户处于同一知识信任范围，没有 bot/操作者 ACL，也没有 Dashboard、BotDefinition 或 SkillHub 禁用开关。不应在同一实例存放需要按 bot 或公司隔离的知识；需要隔离时使用独立实例和不同用户数据目录。是否检索、保存仍由模型按 system prompt 和 Skill 描述判断。

- `documents/KB-<uuid>.md`：文档正文和单行 JSON/YAML frontmatter，包含固定 ID、标题、摘要、分类、来源、更新时间、修改原因。
- `index.md`：面向阅读的分类/摘要索引，可重建。
- `changes.md`：根据当前文档与历史版本生成的修改记录，可重建。
- `.history/<ID>/<sha256>.md`：更新前的完整文档版本。
- `.write.lock`：仅写入期间存在，记录维护进程 PID 和开始时间。

知识文件位于持久化用户数据目录，独立于安装包、bot Skill 工作区及其云同步、Turn Skill 快照。没有 bot 私有权限或跨 XiaoBa 同步。同名用户 Skill 可以覆盖内置 Skill；内置默认版本不需要联网安装。
内置版本在 Dashboard 中标记为系统 Skill，不能通过管理入口禁用、删除或分享安装包中的文件；CLI 同样拒绝移除内置文件。用户目录的同名自定义版本仍按普通用户 Skill 管理。

## 使用与维护

通过 `skill` 工具加载 `xiaoba-knowledge`，工具结果会提供知识目录、脚本和 Node 绝对路径。按 SKILL.md 操作即可；脚本仅使用 Node 标准库，复用 `execute_shell` 的本机路由和既有权限流程。

`index` / `search` 每页最多 30 条，`read` 每页最多 12000 字符，返回 nextOffset。索引与搜索直接读取当前文档，避免派生 index.md 过时导致查不到更新。长文分页读取时检查 revision 是否一致。
简短引用可使用 `KB-` 加 UUID 前八位。`read` 仅在唯一匹配时接受短 ID，并返回完整 ID；多个文档共享前缀时返回 `AMBIGUOUS_ID`，需通过 search 检索完整 ID 后再读。search 同时支持正文、标题、分类和 ID/前缀。写入仍必须使用完整 ID，以避免短引用碰撞造成误更新。

写入使用 UTF-8 JSON 请求文件；创建需 `expectedRevision:null`，更新需 `id` 和 read 返回的 SHA-256 revision。脚本持有跨进程锁，检查版本，归档旧正文，再原子替换当前文档。过期版本返回 `REVISION_CONFLICT`，必须重读合并。内容未变化不会新增版本。
Skill 要求忠实区分已确认事实和建议，不把额外推断写成用户约定；更新前查重、更新后读回核对。此类内容质量约束由模型遵循，脚本负责存储一致性，不能自动判断事实真假。

正文保存后若派生索引写入失败，返回 `saved:true` 和 warning，使用 `reindex` 修复；不能将其误认为未保存而重复创建。每份文件原子替换，index.md 和 changes.md 不构成跨文件事务，helper 查询仍以正文为准。

写入进程崩溃可能留下锁或 `.tmp-*` 文件。脚本返回 `LOCK_BUSY` 而不会自动抢锁，确认锁中 PID 对应进程已退出后，才可移除该锁并运行 reindex。历史数据和正文属于长期知识，不作为测试临时文件清理。

当前明确采用人工崩溃恢复策略：时间超过某个 TTL 或 PID 查询失败均不能单独作为删锁依据（PID 可复用，权限不足也可能导致查询失败）。恢复前暂停该实例各 bot 的知识写入，确认持锁进程已退出、锁内容没有变化，再移除这个锁并执行 reindex；无法确认时保留锁。遗留锁会阻止后续写入，读取仍可使用，这是已知运维限制。锁记录包含随机归属 token；正常释放会核对文件身份及完整记录，保留已被替换的锁。这降低误删风险，不提供针对恶意本地进程的原子 compare-and-delete 或 OS 级隔离。

用户可直接编辑 Markdown 正文，保留 frontmatter 和文档 ID；直接编辑不会自动生成历史版本，可运行 reindex 更新索引。Agent 更新应使用 helper，以保留版本与冲突检查。操作不支持知识根目录及其内部的符号链接/目录联接和硬链接文件。

客户可以直接把 UTF-8 Markdown 复制到 `documents/` 或其子目录，文件名不要求 KB-ID，也不要求 frontmatter。index/search 自动全文搜索这些资料，返回 `managed:false`、相对路径 `file` 和 `file:documents/...` 形式的引用；read 接受该引用并分页返回原文与内容 revision。标题取一级 Markdown 标题或文件名，不编造来源日期。引用随路径变化，文件移动后应重新搜索。这些资料只读接入，不自动改写、改名或生成历史版本；put 仍只更新合法 KB-ID。若要整理成受版本管理的新知识，须先读取原资料、查重，并引用其路径和 revision 创建整理文档，保留原件。PDF、Word 和图片不属于本 helper 的直接检索格式，需先沿现有读取工具处理为知识。

KB-ID 文档的 frontmatter 损坏或 ID 与文件名不一致时，仍可作为只读原文搜索和读取；warnings 中的 readableAs 给出可用文件引用。超过 256 KiB、无法读取或路径不安全的文件才跳过，并返回包含相对文件路径、错误码和原因的 warnings。reindex 重建可读资料的索引，并跳过损坏历史版本；原文件保持不变。告警意味着部分资料或元数据有问题，不能据此断言完整知识库没有相关内容。根目录或 documents 目录本身无法安全访问时整体报错，不跟随链接。put 保存成功后也可能附带 warnings；这与派生文件写入失败的单条 warning 不同，不应重复创建已保存文档。

本机 `write_file` / `edit_file` 工具拒绝直接修改当前用户数据根目录下的 `knowledge/`（包括通过目录别名进入），并提示重新加载 Skill、使用 `put`。临时 JSON 请求放在知识目录之外。脚本路径错误或 `MODULE_NOT_FOUND` 时，重新加载 Skill，按本次结果的完整绝对路径重试；仍失败应报告阻碍。这是防止普通文件工具误绕过版本流程的保护，不是 OS 沙箱；不会拦截所有 shell 写文件或外部编辑器。Skill 仍明确禁止用其他写入方式绕过 helper。

## 提示词与缓存

动态知识、索引、版本及更新时间不进入系统提示词或 Skill 列表。文档变化不会改变这些稳定内容；实际路径只在 Skill 调用结果中提供。新文档内容通过后续工具结果进入上下文，不回写旧消息。缓存效果仍由模型提供商、前缀结构和有效期决定，检索/写入也有 token 成本。

## 验证

`tests/shared-knowledge.test.ts` 覆盖独立进程共享读写、同版本并发冲突、归档、索引修复、分页、路径检查、内置发现和快照兼容，以及文档更新后提示词和 Skill 列表稳定性。实际模型是否自主调用 Skill 需要另行验收，确定性测试不能代表触发率。

`tests/knowledge-write-guard.test.ts` 验证直接写入/编辑及目录别名保护。长任务压缩将历史角色和工具调用作为待总结证据，优先保留当前用户任务及后续约束；新输入在首个主模型请求前也会检查压缩预算。空摘要、模型返回的工具调用或明显工具调用标记会重试一次，仍无效则保留原始上下文并停止；这不等于能自动验证摘要的每项事实。精确报表和配置应回读原始文件核对，不能把压缩摘要当成完整原始数据。

中途检查点保存成功后同步更新会话内存，停止/错误收尾不会再用压缩前的旧上下文覆盖磁盘。取消以及 reset/clear 会阻止迟到的摘要写回。摘要生成也能参考单独保留的用户输入，避免将已明确的输出路径或约束误写为未知；这些输入仍原样或以受限证据保留在摘要之后。

检查点明确提示恢复后的 Agent：摘要是有损参考，批量报告的精确字段必须回读原始来源，不能补零、改写标识或凭模式推算。完成前逐项比较报告与原文，不能把条数正确或无重复当作内容正确。这仍是模型执行要求，不是能自动证明任意摘要语义正确的校验器。

若只有必须保留的当前任务输入、没有其余历史，检查点不会调用摘要模型。生成后按同一估算口径比较持久消息 token 数，未缩减则保留原文并返回 compacted:false，不持久化为新检查点；同一协调器记住最近一次无收益的来源，内容不变时不会再请求摘要，新增持久证据后允许重新尝试。稳定 system prompt 和工具定义不会被摘要，因此这项保护不能消除它们本身超预算的问题。

本 PR 包含两个独立影响面：知识 Skill/存储，以及通用检查点/会话取消链路。后者影响所有使用检查点的长会话，不限于知识库用户。`XIAOBA_CHECKPOINT_COMPACTION_ENABLED=false` 可退回既有压缩实现，但不关闭知识 Skill，也不撤销 runner 的取消检查；如需完整撤销本 PR，仍应按发布流程回滚到发布前版本。验证时分别覆盖知识 CRUD 和通用会话链路。

收到停止/reset/clear 后，即使 provider 仍返回迟到的工具调用，runner 也会在处理响应及开始工具前检查取消信号；工具限流的等待与重试同样响应取消。已开始的外部操作不能据此承诺回滚，这里保证的是取消后的迟到响应和受控重试不会启动下一次工具执行。

同一批工具在取消前已完成的结果会先写入会话记录；普通停止按当前生命周期保留这些证据，避免恢复时丢失完成状态。reset/clear 改变生命周期后，不会把旧批次重新写回。该机制不提供业务操作的 exactly-once 保证；本轮没有扩展为过滤所有忽略取消信号的 provider 流式回调，也不能撤回停止前已经发送的内容。

审查补充回归：`tests/shared-knowledge.test.ts` 包含真实子进程持锁、强制退出后的遗留锁、明确恢复与替换锁保护；`tests/session-lifecycle-manager.test.ts` 使用真实 AgentSession/压缩协调器，在摘要生成中和落盘后分别覆盖继续、stop/reset/clear、timeout。模型回复由确定性 fixture 控制，非新增线上模型压力测试。`tests/checkpoint-provider-wire.test.ts` 通过本机 HTTP 服务捕获真实 OpenAI provider 的 Responses/Chat Completions 请求体，确认历史调用只作为被引用数据。`tests/bundled-knowledge-runtime.test.ts` 从隔离 CLI、桌面资源（含 macOS .app 路径结构）和 Worker 目录启动编译产物，验证资源定位及知识读写；它使用主机 Node 与依赖，不等于实际安装包或 macOS 真机验收。
