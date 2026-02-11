# 执行交接文档：CLEC 早季作物分类框架改进实验

## 实验优先级排序

| 优先级 | 实验 | 理由 |
|--------|------|------|
| 1 | E1: 预测模块替换 | 直击论文核心瓶颈（周期性模式预测不足），预期收益最大 |
| 2 | E2: 多任务平衡策略替换 | 实现成本最低，改一个组件就能验证，且对实用性提升明显 |
| 3 | E3: 物候感知数据增强 | 需要构造模拟数据集，工作量稍大，但对实际部署价值高 |

## 推荐运行顺序

### Phase 1: 复现基线（必须先做）

1. 复现原始 CLEC（AtEDLSTM + 1D-CNN + GradNorm）
2. 复现消融变体：1D-CNN、CLEC_NoGrad、CLEC_NoAtED
3. 确认复现结果与论文 Table 3-8 一致（Kappa 误差 ≤ 1%）

**预计耗时**: 1-2 天

### Phase 2: E2 — 多任务平衡策略（最低成本验证）

先跑 E2，因为只需改损失权重策略，代码改动最小：

1. 实现 Uncertainty Weighting（替换 GradNorm 的损失权重计算）
2. 实现固定权重网格搜索（w_pred:w_cls = 0.3:0.7, 0.5:0.5, 0.7:0.3, 0.9:0.1）
3. 实现 Improvable Gap Balancing
4. 对比训练时间和分类精度
5. 如果某个方案训练时间降低 ≥40% 且 Kappa 下降 ≤0.5%，锁定该方案用于后续实验

**预计耗时**: 2-3 天

### Phase 3: E1 — 预测模块替换（核心实验）

1. 实现 PatchTST 预测模块，接入 CLEC 级联框架
2. 实现 Autoformer 预测模块（自相关机制 + 序列分解）
3. 实现 Mamba-based 预测模块
4. 逐一替换 AtEDLSTM，保持其余组件不变
5. 在三种作物、10 个 DOY 时间点上全面对比
6. 绘制预测曲线 vs. 真实曲线（重点关注峰谷区域）
7. 如果 Phase 2 已锁定更优的平衡策略，此处直接使用

**预计耗时**: 5-7 天

### Phase 4: E3 — 物候感知数据增强（鲁棒性实验）

1. 构造模拟非标准条件测试集（时间偏移 +15 天 + NDVI×0.8）
2. 实现四种增强策略（时间偏移、NDVI 缩放、物候拉伸、组合）
3. 在标准和非标准测试集上分别评估
4. 分析大豆-玉米混淆率变化

**预计耗时**: 3-5 天

## 最小命令入口占位

```bash
# Phase 1: 复现基线
python train.py --model clec --config configs/northeast_china.yaml --seed 42

# Phase 2: E2 多任务平衡
python train.py --model clec --loss-balance uncertainty_weighting --seed 42
python train.py --model clec --loss-balance fixed --w-pred 0.5 --w-cls 0.5 --seed 42
python train.py --model clec --loss-balance igb --seed 42

# Phase 3: E1 预测模块替换
python train.py --model clec --predictor patchtst --seed 42
python train.py --model clec --predictor autoformer --seed 42
python train.py --model clec --predictor mamba --seed 42

# Phase 4: E3 数据增强
python train.py --model clec --augment phenology --aug-shift 15 --aug-ndvi-scale 0.7 --seed 42
```

> 注：以上命令为占位，需根据实际代码结构调整参数名和路径。

## 结果回填格式要求

每个实验完成后，在 `docs/experiments/clec-early-crop-classification/` 下创建结果文件：

```
results/
  E1_predictor_replacement/
    metrics.csv          # 各DOY时间点的Kappa和F1
    prediction_curves/   # 预测vs真实曲线图
    training_log.json    # 训练时间、收敛曲线
  E2_loss_balancing/
    metrics.csv
    efficiency.csv       # 训练时间、显存对比
  E3_augmentation/
    metrics_standard.csv
    metrics_nonstandard.csv
    confusion_matrix/    # 大豆-玉米混淆矩阵
```

每个 `metrics.csv` 格式：

```csv
model,crop,DOY,Kappa,F1,Precision,Recall
CLEC-PatchTST,soybean,140,0.xxx,0.xxx,0.xxx,0.xxx
...
```

## 产物路径汇总

所有实验设计文件位于：

```
docs/experiments/clec-early-crop-classification/
├── opportunity-map.md        # 可挖掘点地图（5个方向）
├── hypotheses.json           # 3个可证伪假设
├── literature-evidence.json  # 9篇补证文献
├── experiment-plan.yaml      # 3个实验的完整设计
└── handoff-to-exec.md        # 本文件（执行交接）
```
