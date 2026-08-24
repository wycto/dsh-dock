# 001 — 重塑桌面伙伴人物与真人化动作

- **Status**: DONE
- **Commit**: efec934
- **Severity**: HIGH
- **Category**: Purpose & frequency / Physicality & origin / Accessibility
- **Estimated scope**: 1 source file + 1 generated file，约 180–260 行调整

## Problem

桌面伙伴已经能根据 `think/search/write/code` 阶段移动，但人物仍明显像积木：头、头发、躯干全部是完整长方体，面部轮廓没有额头、下颌和发型层次；动作只旋转头组与整条手臂，肩膀、脊柱、手腕不参与，因此“思考”和“打字”看起来像机械摆动。

```jsx
// features/animation/view.jsx:239 — current
<Box3 w={15} h={19} d={11} cls="dk3-hood dk3-torso" x={12} y={37} />
<Box3 w={5} h={8} d={9} cls="dk3-hood dk3-hoodbump" x={5} y={31} />
<Box3 w={4} h={3} d={4} cls="dk3-skin" x={14} y={26} />
<div className="dk3-head3">
  <Box3 w={13} h={12} d={12} cls="dk3-skin dk3-headbox" x={8} y={10}>
    ...
  </Box3>
  <Box3 w={14} h={6} d={13} cls="dk3-hair" x={8} y={4} />
  <Box3 w={4} h={11} d={13} cls="dk3-hair" x={2} y={9} />
</div>
```

```css
/* features/animation/view.jsx:1491 — current */
.dk3-arm3{position:absolute;left:20px;top:30px;width:16px;height:16px;transform-style:preserve-3d;}
.dk3-elbow{position:absolute;left:0;top:10px;width:15px;height:5px;transform-style:preserve-3d;transform-origin:2px 2px;}

/* features/animation/view.jsx:1515 — current */
.dkan-bot-scene[data-phase=think] .dk3-head3{animation:dkan-think-head calc(1.05s / var(--dkan-speed,1)) ease-in-out infinite alternate;}
.dkan-bot-scene[data-phase=think] .dk3-arm3:not(.dk3-far){animation:dkan-think-arm calc(1.05s / var(--dkan-speed,1)) ease-in-out infinite alternate;}
```

此外，当前 reduced-motion 把所有动画和过渡压到 `0.01ms`，导致阶段切换直接跳变，连有助于理解状态的淡入反馈也消失：

```css
/* features/animation/view.jsx:1538 — current */
@media (prefers-reduced-motion:reduce){.dkan-botcard *{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;}}
```

## Target

### 1. 头型和发型

- 保留 CSS 3D 风格，但从“方块头”改成有轮廓的半写实动漫男性：额头略宽、下颌收窄、鼻梁和耳朵有侧面层次。
- 将现有单块 `dk3-headbox` 拆成：
  - `dk3-cranium`：`12 × 10 × 11`，面板圆角 `42% 46% 38% 36%`；
  - `dk3-jaw3`：`9 × 5 × 9`，下半部圆角 `30% 30% 48% 48%`，与颅骨重叠 2px，不能出现断层；
  - `dk3-neck3`：颈部从 `4 × 3 × 4` 调成 `5 × 5 × 5`，与下颌和衣领都有 1–2px 重叠。
- 发型改成短侧渐层 + 有方向的顶部碎发：
  - 后脑 `dk3-hair-back`；
  - 顶部 `dk3-hair-crown`；
  - 前额三束 `dk3-fringe3 > i`，分别旋转 `-18deg/-6deg/12deg`；
  - 右前方增加一束 2px 高的翘发，形成清晰侧影。
- 眉毛改为略向外上扬的 1px 圆角线；眼睛宽高改为 `3.5 × 2.5px`，瞳孔带 0.5px 高光；鼻梁使用 `2 × 3px` 的皮肤深色渐变；嘴宽不超过 3.5px，保持自然中性表情。
- 头部仍使用现有 `--dk3-head-turn`，不得用图片、Canvas 或新增依赖。

### 2. 人体结构

- 在躯干、肩、颈、头、手臂外增加 `.dk3-upper3` 包装层，定位仍以现有人物坐标为基准，`transform-origin: 12px 52px`。
- 肩线单独增加 `dk3-shoulders3`，宽 `18`、高 `5`、深 `12`；躯干上宽下窄，不能再是完整直筒矩形。可用两块重叠的 `Box3` 表现胸腔和腰部，面板圆角分别为 4px 和 3px。
- 上臂、前臂之间保留现有肘关节，同时在手前增加 `.dk3-wrist3`，手掌追加两条 `.dk3-fingers3 i`。所有关节旋转原点必须位于连接处，而不是元素中心。
- 近侧和远侧手臂不得只是 brightness 不同：远侧肩膀向后 `translateZ(-7px)`，肘和腕的时间相位错开 80–110ms。

### 3. 阶段动作

全部运动只使用 `transform` 和 `opacity`。人物移动/变形使用仓库现有强曲线：

```css
--dkan-human-ease: cubic-bezier(0.77, 0, 0.175, 1);
--dkan-human-enter: cubic-bezier(0.23, 1, 0.32, 1);
```

- `think`：上身后靠 `rotateZ(-3deg) translateY(-1px)`；近侧肘弯到下巴，手腕再旋转 `-12deg`，远侧手自然停在桌面；头部在 `-6deg` 到 `-11deg` 间缓慢变化，周期基准 `1.6s`。禁止两只手同时抬起。
- `search`：上身向左屏转 `rotateY(-8deg)` 并前倾 `rotateZ(2deg)`；头部在目标方向做不超过 8deg 的小幅扫视；近侧手腕以 `0.72s` 周期左右移动 1.5px 模拟鼠标，远侧手保持键盘待命。
- `write/code`：上身前倾 `rotateZ(3deg) translate(1px,1px)`；肩膀上下幅度不超过 1px；两侧肘只在 `-4deg` 到 `5deg` 范围交替，主要敲击发生在手腕 `translateY(0–1.5px)`，相位差 `90ms`。头部每 `2.4s` 做一次 2deg 的轻微点头，避免高频摇头。
- 工位切换继续使用 `.dk3-person` transition，但持续时间设置为 `max(180ms, calc(.38s / var(--dkan-speed,1)))`，避免高吞吐时短到瞬移。
- 动作循环不得直接使用完全镜像的 `alternate` 造成机械节拍；关键帧加入 0/38/62/100% 停顿比例，或让左右肢体具有不同周期。

### 4. Reduced motion

不能再全局压缩为 `0.01ms`。改为：

```css
@media (prefers-reduced-motion: reduce) {
  .dk3-person,
  .dk3-upper3,
  .dk3-head3,
  .dk3-arm3,
  .dk3-elbow,
  .dk3-wrist3,
  .dk3-wheel {
    animation: none !important;
    transition: none !important;
  }
  .dk3-screen,
  .dkan-bubble {
    transition: opacity 200ms cubic-bezier(0.23, 1, 0.32, 1) !important;
  }
}
```

屏幕代码滚动可停止，阶段屏幕的亮暗变化和思考泡泡透明度反馈要保留。

## Repo conventions to follow

- 人物 DOM、全部人物 CSS 都集中在 `features/animation/view.jsx`；不要拆出新运行时依赖。
- 继续使用现有 `Box3` / `Monitor3` 生成 CSS 3D 面板，面部细节使用内部 `span/i`，参照 `features/animation/view.jsx:175`。
- 阶段状态继续由 `data-phase` 和 `data-station` 驱动，参照 `features/animation/view.jsx:203`；不要新增轮询或 host 字段。
- 动画速度继续使用 `--dkan-speed`，但人体动作必须设置最低时长，不能随速度无限缩短。
- `client.js` 是生成文件，只能通过 `npm_config_cache=/private/tmp/dsh-dock-npm-cache node scripts/build-client.mjs` 重建，禁止手工编辑。

## Steps

1. 在 `features/animation/view.jsx` 的 `RobotScene` 人物区域增加 `.dk3-upper3` 包装层，将躯干、肩颈、头组、两条手臂放入其中；桌子、显示器、椅子、腿和工位坐标保持原样。
2. 用 `dk3-cranium + dk3-jaw3 + dk3-neck3` 替换单块头部轮廓；用 `dk3-hair-back + dk3-hair-crown + dk3-fringe3` 替换两块矩形头发，增加眉、眼、鼻、嘴和耳朵的层次。
3. 给两条手臂加入腕关节与手指，重新定位肩/肘/腕旋转原点，确保手臂在静止姿态下能自然落到键鼠位置。
4. 在同文件 CSS 数组中加入人体运动曲线变量，重写 `think/search/write/code` 人物关键帧：阶段变化应先转上身，再转头，最后由手腕执行动作。
5. 将工位滑动 transition 加入 180ms 最低时长，并按 Target 重写 reduced-motion 规则。
6. 运行生成脚本更新 `client.js`，不得手改生成文件。

## Boundaries

- 不改桌面宽度、桌腿、显示器、键盘、鼠标、咖啡杯和椅子坐标。
- 不改 `features/animation/host.js`、动画配置 schema、轮询和任务阶段判定。
- 不新增图片、Canvas、Three.js、GSAP 或其他依赖。
- 不改变 `robotScale`、拖拽或尺寸调节行为。
- 当前工作区已有尚未提交的动画与模型配置改动；只编辑上述人物区域，不得覆盖或回退其他改动。
- 如果执行时上述行号或 DOM 结构已明显漂移，停止并报告，不要猜测式改写。

## Verification

- **Mechanical**:
  - `npm_config_cache=/private/tmp/dsh-dock-npm-cache node scripts/build-client.mjs`，预期输出 `built: .../client.js`。
  - `git diff --check`，预期无输出。
  - `rg -n "dk3-(upper3|cranium|jaw3|wrist3|fringe3)" features/animation/view.jsx client.js`，预期源码与生成文件均命中。
  - `rg -n "\.dkan-botcard \*\{animation-duration:\.01ms" features/animation/view.jsx client.js`，预期无命中。
- **Feel check**:
  - `think`：近侧手托下巴、远侧手留在桌面，肩颈和脊柱形成连续动作，不是两手同时摆动。
  - `search`：视线、上身和鼠标手都朝左屏，幅度克制；右手保留在键盘附近。
  - `write/code`：手腕和手指为主要动作，肩膀只有轻微跟随，头不会高频点动。
  - 以 DevTools Animations 10% 播放速度检查肩→肘→腕的运动顺序，关节连接处不能断开或穿模。
  - 切换 reduced motion 后人物不再移动，但屏幕亮暗和思考状态仍可辨认。
- **Done when**: 在默认、最小和最大机器人缩放下，头部具有清晰下颌与短侧渐层发型；四个阶段一眼可辨、动作由关节驱动且无穿模；构建和 diff 检查通过。

## Completion

- 已完成颅骨、下颌、连续颈部、衣领、短侧渐层发型和五官重塑。
- 已完成肩、肘、腕、手指分段动作，并为思考、检索、编码配置不同人体姿态。
- 已取消人物与座椅随工位整体旋转；人物始终面向桌面，仅头部观察左右屏。
- 已重建 `client.js`，通过构建、diff、浏览器运行和渲染坐标检查。
