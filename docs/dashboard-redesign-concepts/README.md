# Dashboard 视觉探索版本

这一目录用于独立探索新版 CatsCo Dashboard 的视觉和交互方向。每个版本都是静态 HTML mockup，不连接真实 API。

## 评审标准

- 普通用户是否能在首屏理解当前 Agent 是否可用。
- 是否只有一个明确主按钮。
- 是否把模型配置表达成步骤/弹层，而不是主页面。
- 是否清楚表达 WebApp、微信、飞书只是当前 Agent 的不同通道。
- 高级诊断是否被收纳，而不是污染普通流程。
- 视觉风格是否完整，包括颜色、字体、间距、按钮、状态 chip。
- 移动端是否仍然可用。
- 是否适合后续真正落地到现有 `dashboard/index.html`。

## 版本

- `version-a-ops-console.html`：专业运维控制台方向。
- `version-b-product-workbench.html`：清爽产品化工作台方向。
- `version-c-employee-cockpit.html`：虚拟员工协作驾驶舱方向。
- `version-d-shadcn-app-shell.html`：shadcn/ui app shell 方向。
- `version-e-minimal-chat.html`：极简聊天优先方向。
- `version-f-ultra-minimal-chat.html`：去掉嵌套容器后的超极简聊天方向。

## 汇总评审

- `concept-review-report.html`：四版截图对比、优缺点评审和推荐融合方案。
- `../assets/dashboard-redesign-concepts/e-desktop.png`、`e-mobile.png`：极简聊天优先方向截图。
- `../assets/dashboard-redesign-concepts/f-desktop.png`、`f-mobile.png`：超极简聊天方向截图。
