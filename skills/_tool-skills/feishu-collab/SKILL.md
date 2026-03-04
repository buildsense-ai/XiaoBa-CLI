---
name: feishu-collab
description: 飞书群协作与@人通信。用于需要在飞书群聊中@指定成员、跨群发送消息、根据 Group/*.md 查询 chat_id/open_id 的场景。
additional-tools: [feishu_mention]
---

# 飞书群协作（Feishu Collab）

当用户要求以下任务时，使用本 skill：

- 在飞书群里 @ 某个人或某个 bot
- 往指定群（非当前群）发送消息
- 根据群名查找 `chat_id` / `open_id`

## 执行流程

1. 先用 `read_file` 读取 `Group/*.md`，定位目标群的 `chat_id` 和目标成员 `open_id`。
2. 调用 `feishu_mention` 发送消息：
   - 同群发送：可不传 `chat_id`
   - 跨群发送：必须传 `chat_id`
   - `mentions` 传入 `{ open_id, name }` 数组
3. 如信息不足（找不到目标群或目标人），先用 `reply` 提一个最小澄清问题。

## 输出要求

- 消息简短、直接，避免重复发送。
- 若是代办类转达，先确认接收对象和目标群，再发送。

