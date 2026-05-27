# besender-tools

`bms.besender.com` 的 Tampermonkey 用户脚本，聚合良品/不良品/总和。

## 功能

- **型号列表页 (`/single/refurbish`)**：勾选多个型号 → 汇总良品 / 不良品 / 总和
- **详情页 (`/single/retreadDetail`)**：直接看当日 / 区间统计
- **单日 / 区间** 两种日期模式（面板里切换）
- 中国时间自动换算到本地时区，鼠标悬停显示原始中国时间

## 安装

需要 Tampermonkey 扩展。然后在 Chrome 打开下面这个 URL：

```
https://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@raw.githubusercontent.com/lyp04/besender-tools/main/besender-aggregate.user.js
```

Tampermonkey 会弹安装对话框，点「Install」即完成。

PAT 已经烤进 `@updateURL` / `@downloadURL`，所以 Tampermonkey 会用同一个
URL 定时检查更新。我推新版本到 GitHub，下次 Tampermonkey 检查（默认每
天）就会自动拉到。如果想立即更新：Tampermonkey 控制台 → 该脚本 → 「检查
更新」。

## 开发

```bash
# 改 besender-aggregate.user.js，记得 bump @version
git add besender-aggregate.user.js
git commit -m "..."
git push
```

下次 Tampermonkey 检查更新（或用户手动「检查更新」）就拿到新版本。

## PAT 说明

`@updateURL` / `@downloadURL` 里包含一个只读 fine-grained PAT，仅对本私库
的 Contents 有读权限。trade-off：泄漏了攻击者只能读这份代码（这份代码本身
就是给同事看的），进不了 BESENDER 后台（PAT 不是 BESENDER 凭据）。

如果需要换 PAT：

1. <https://github.com/settings/personal-access-tokens> 撤销旧的
2. 生成新的（Repository = `lyp04/besender-tools`, Contents = Read-only, No expiration）
3. `sed -i '' 's|github_pat_old|github_pat_new|g' besender-aggregate.user.js`
4. `git commit && git push`
5. 已安装的用户在 Tampermonkey 里手动「检查更新」一次就拿到新 PAT 版本

## 历史

- v1.3.0 — 回到纯 Tampermonkey + 自动更新（PAT 烤进 @updateURL）
- v1.2.x — 试过包成 MV3 Chrome 扩展，被页面 CSP 拦下，放弃
- v1.1.0 — 修了 page-1 组件识别 bug + 不良品判定逻辑
- v1.0.0 — 初版
