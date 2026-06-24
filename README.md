# besender-tools

`bms.besender.com` 的 Tampermonkey 用户脚本，聚合良品/不良品/总和。

## 功能

- **型号列表页 (`/single/refurbish`)**：勾选多个型号 → 汇总良品 / 不良品 / 总和
- **详情页 (`/single/retreadDetail`)**：直接看当日 / 区间统计
- **头程入库列表页 (`/in_order/head_entry`)**：按公司 + 预计到达时间窗 + 机型/SKU 反查在途/入库中订单的物料
- **DOA 管理页 (`/engineerDoa`) / 维修 RP 管理页 (`/engineerRepair`)**：按日期统计「完成」状态的订单数量；公司沿用页面顶部自带的筛选；DOA 页可勾「同时统计 RP」、RP 页可勾「同时统计 DOA」，得到 DOA + RP 合计
- **单日 / 区间** 两种日期模式，可切「完成时间 / 下单时间」口径
- 中国时间自动换算到本地时区（可选时区），鼠标悬停显示原始中国时间

## 安装（同事看这里）

1. 装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展（如果还没装）
2. 点这个链接：

   <https://raw.githubusercontent.com/lyp04/besender-tools/raw/main/besender-aggregate.user.js>

   备用 raw URL（同一份内容）：
   <https://github.com/lyp04/besender-tools/raw/main/besender-aggregate.user.js>

3. Tampermonkey 弹安装对话框 → 点「Install」
4. 打开 `https://bms.besender.com/bsd-warehouse/...` 任一页面，右下角出现 📊 FAB 即成功

以后 Tampermonkey 会自动检查更新（默认每天）。要立即更新：Tampermonkey 控制台 → 该脚本 → 「Check for userscript updates」。

## 开发

```bash
git clone https://github.com/lyp04/besender-tools.git
cd besender-tools
# 改 besender-aggregate.user.js，记得 bump @version
git commit -am "..."
git push
```

下次任何安装了本脚本的浏览器检查更新时就拿到新版本。

## 历史

- v1.4.0 — 仓库公开，去掉 PAT，一键安装
- v1.3.0 — 回到 Tampermonkey，PAT 烤进 @updateURL（已废弃）
- v1.2.x — 试过包成 MV3 Chrome 扩展，被页面 CSP 拦下
- v1.1.0 — 修了页面 1 组件识别 bug + 不良品判定逻辑
- v1.0.0 — 初版
