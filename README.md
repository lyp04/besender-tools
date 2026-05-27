# besender-tools

`bms.besender.com` 的 Chrome 扩展，聚合良品/不良品/总和。

## 功能

- **型号列表页 (`/single/refurbish`)**：勾选多个型号 → 汇总良品 / 不良品 / 总和
- **详情页 (`/single/retreadDetail`)**：直接看当日 / 区间统计
- **单日 / 区间** 两种日期模式
- 中国时间自动换算到本地时区，悬停显示原始中国时间

## 架构

私库 + 真 Chrome 扩展 + 自动云端更新 —— 这三件事原生 Chrome 不支持，所以这么拆：

```
扩展本体（一次安装，几乎不再变）：
├── manifest.json      MV3
├── bootstrap.js       每次开 BESENDER 页面跑，从 GitHub 拉最新代码注入
└── README.md

GitHub 私库（频繁更新）：
└── besender-aggregate.user.js     业务逻辑，pull 后下次刷新自动生效
```

`bootstrap.js` 用 ETag 条件请求 GitHub raw —— 未变就 304 (几十毫秒)，变了
才下新代码。

`bootstrap.js` 里硬编码了一个**只读** GitHub PAT，仅作用于本私库的 Contents
读取权限。可接受的风险：泄漏了攻击者只能读这份代码，进不了 BESENDER 后台
（PAT 不是 BESENDER 凭据）。

## 安装

```bash
git clone https://github.com/lyp04/besender-tools.git ~/Code/besender-tools
```

1. Chrome 打开 `chrome://extensions/`
2. 右上角开「开发者模式」
3. 「加载已解压的扩展程序」→ 选 `~/Code/besender-tools`
4. 打开 BESENDER 页面，右下角出现 📊 FAB 即成功

控制台第一次会打印 `[BESENDER Tools] 已注入 v1.2.0`（或当前版本）。

## 更新

啥都不用做。我 push 新代码到 `main` → 你下次打开 BESENDER 页面 `bootstrap.js`
自动拉到 → 注入。

强制刷新（极少需要）：`chrome://extensions/` → 这个扩展卡片上点 🔄 reload。

## 卸载 Tampermonkey 版本

如果之前装过 Tampermonkey 版本，记得删掉，不然会有两个 FAB：

Tampermonkey 图标 → 管理面板 → 找到「BESENDER 良品/不良品聚合统计」→ 删除。

## 开发

```bash
cd ~/Code/besender-tools
# 改 besender-aggregate.user.js (顺手 bump @version)
git add besender-aggregate.user.js
git commit -m "..."
git push
```

下次任何人开 BESENDER 页面，下次刷新即生效。

## 文件

- `manifest.json` — Chrome 扩展清单 (MV3)
- `bootstrap.js` — content script，从 GitHub 拉远程业务代码
- `besender-aggregate.user.js` — 业务逻辑，顶部保留了 `==UserScript==` 头
  以便回退到 Tampermonkey 模式
- `README.md` — 本文件
