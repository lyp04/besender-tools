# besender-tools

BESENDER 系统（`bms.besender.com`）的浏览器辅助工具。

## 当前脚本

### `besender-aggregate.user.js` — 良品/不良品聚合统计

- 在 `/single/refurbish`（型号列表页）：勾选多个型号 → 一键汇总良品 / 不良品 / 总和
- 在 `/single/retreadDetail`（型号详情页）：自动显示当天该型号的统计
- 系统里的中国时间会自动换算成你本地时区，鼠标悬停显示原始中国时间

## 安装（含 Tampermonkey 自动更新）

仓库是 private，所以需要一个**只读** GitHub PAT 来让 Tampermonkey 拉脚本。

### 一次性设置

1. **生成只读 fine-grained PAT**：

   打开 https://github.com/settings/personal-access-tokens/new

   - **Token name**: `tampermonkey-besender-tools`（随便）
   - **Expiration**: 选 90 天 / 365 天 / `No expiration`（看你心情）
   - **Repository access** → `Only select repositories` → 选 `lyp04/besender-tools`
   - **Repository permissions** → `Contents`: **Read-only**
   - 点 `Generate token`，复制出来的 `github_pat_...`

2. **本地烤一份装好的脚本**（自动把 PAT 嵌进 `@updateURL` / `@downloadURL`）：

   ```bash
   cd ~/Code/besender-tools
   ./install.sh github_pat_xxxxx
   ```

   这会：
   - 把 PAT 嵌进脚本，复制到 macOS 剪贴板
   - 打开 Tampermonkey 控制台等你粘贴

3. **粘贴到 Tampermonkey**：
   - Chrome 工具栏 Tampermonkey 图标 → 「管理面板」
   - 点「添加新脚本」（`+` 图标）
   - ⌘+A 清掉模板 → ⌘+V 粘贴 → ⌘+S 保存

完成。Tampermonkey 会自动定时检查 GitHub raw 上的版本，比本地高就提示更新。

### 后续更新

我推新版到 GitHub → 你下次刷新 BESENDER → Tampermonkey 弹窗「检测到新版本」→ 点确认。无需任何手动操作。

## 开发

直接改 `besender-aggregate.user.js`，bump `@version`，commit + push。

```bash
git add besender-aggregate.user.js
git commit -m "..."
git push
```
