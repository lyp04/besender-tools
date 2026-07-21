# besender-tools

`bms.besender.com` 的 Tampermonkey 用户脚本：型号良品/不良品聚合统计、头程入库物料反查、DOA/RP 完成订单统计。

## 安装

1. 装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展（如果还没装）
2. 点这个链接：

   <https://raw.githubusercontent.com/lyp04/besender-tools/raw/main/besender-aggregate.user.js>

   备用 raw URL（同一份内容）：
   <https://github.com/lyp04/besender-tools/raw/main/besender-aggregate.user.js>

3. Tampermonkey 弹安装对话框 → 点「Install」
4. 打开 `https://bms.besender.com/bsd-warehouse/...` 任一页面，右下角出现 📊 FAB 即成功

以后 Tampermonkey 会自动检查更新（默认每天）。要立即更新：Tampermonkey 控制台 → 该脚本 → 「Check for userscript updates」。

## 功能

- **型号列表页** (`/single/refurbish`)：勾选多个型号 → 汇总良品 / 不良品 / 总和 / 报废率（单日或日期区间）；点良品数字旁的 ▶ 展开该型号（或合计）的 A类/B类/C类 等级明细（数量 + 占良品比例）；单个型号查询失败不影响其余型号的统计，悬停 ⚠ 查看失败原因
- **详情页** (`/single/retreadDetail`)：单个型号的当日 / 区间统计，良品同样可展开 A/B/C 类明细
- **头程入库列表页** (`/in_order/head_entry`)：按公司 + 预计到达时间窗（默认一周内）+ 机型（2080/2280/2351/2353，2352 计入 2353）或 SKU/产品名，反查在途/入库中订单命中的物料；命中的 SKU 可展开查看每张来源订单的预计到达时间，订单号点击直接跳转详情页
- **DOA 管理页** (`/engineerDoa`) **/ 维修 RP 管理页** (`/engineerRepair`)：按日期（单日/区间）统计「完成」状态订单数量，口径固定为完成时间；公司等筛选条件沿用页面顶部自带的筛选；DOA 页可勾选「同时统计 RP」、RP 页可勾选「同时统计 DOA」，给出 DOA + RP 合计
- **时区**：型号列表/详情/头程入库页面的时间是中国时间，可切换为本地时区查看（美东/美中/美西/德国/澳大利亚/中国或系统时区），鼠标悬停时间戳显示中国时间原文；DOA/RP 页面本身展示的就是本地时间，不做换算也不装饰
- **面板保活**：站内切换 SPA 小标签页时，已打开的面板与查询结果保留在内存中，只有手动关闭面板（✕）或刷新页面才会清空

## 开发

```bash
git clone https://github.com/lyp04/besender-tools.git
cd besender-tools
# 改 besender-aggregate.user.js，记得 bump @version
node --check besender-aggregate.user.js
node --test test/besender-aggregate.test.js
git add besender-aggregate.user.js README.md test/
git commit -m "..."
git push
```

下次任何安装了本脚本的浏览器检查更新时就拿到新版本。

## 历史

- v1.9.1 — 修复 DOA/RP 默认日期受其它面板已保存时区影响、站内切换 DOA/RP 后按钮与结果面板不更新的问题；接口异常不再静默显示为 0/1
- v1.9.0 — 良品数字旁加 ▶ 下拉箭头，展开显示 A类/B类/C类 等级明细（数量 + 占良品比例）
- v1.8.4 — 站内切换小标签页时面板及查询结果保留（内存保活），仅手动关闭或刷新才清空
- v1.8.3 — DOA/RP 时间本就是本地时间，统计不再做时区换算，也不装饰其时间戳
- v1.8.2 — DOA/RP 完成统计恢复时区下拉（日期随所选时区换算），口径固定为完成时间
- v1.8.1 — DOA/RP 完成统计日期改按中国时间直接解释，修复非中国时区统计恒为 0
- v1.8.0 — DOA / 维修(RP) 管理页新增按日期统计「完成」订单数量
- v1.7.3 — 头程入库 SKU 行可展开查看每单 ETA，订单号点击跳转详情
- v1.7.2 — 头程入库搜索加预计到达时间窗（默认一周内，无预计时按创建时间 + 40 天估算）
- v1.7.1 — 头程入库加公司下拉、服务端 user_id 筛选、强制在途/入库中状态、修复重复计数
- v1.7.0 — 新增头程入库列表页物料/机型搜索面板
- v1.6.0 — 新增时区选择器（美东/美中/美西/德国/澳大利亚/中国 + 系统）
- v1.5.3 — 合并「不良品」与「报废」（同一含义），报废率改为 不良品/总和
- v1.5.2 — 型号列表页型号列显示型号代码；隐藏零产出的行
- v1.5.1 — 修复静默失败：成功响应也带 code: 200，之前误判为失败
- v1.5.0 — 新增报废率指标 + 单行级错误处理
- v1.4.0 — 仓库公开，去掉 PAT，一键安装
- v1.3.0 — 回到 Tampermonkey，PAT 烤进 @updateURL（已废弃）
- v1.2.x — 试过包成 MV3 Chrome 扩展，被页面 CSP 拦下
- v1.1.0 — 修了页面 1 组件识别 bug + 不良品判定逻辑
- v1.0.0 — 初版
