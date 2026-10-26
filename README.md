# 视频创作 (video-gen)

英文调用标识是 `$video-gen`，界面显示为“视频创作 (video-gen)”。

根据文字或本机图片创建视频任务，支持 Seedance 和 MiniMax，随后查询、等待并下载 MP4。
Seedance 的部分模型支持首帧、首尾帧和参考图；MiniMax 支持文字和 JPEG 首帧。
模型清单描述的是脚本适配能力，不代表本次已验证在线服务可用。

## 准备与安装

需要 Node.js 18+、本地命令执行能力、对应服务分组的 API Key 和可用余额。
仅使用 Node 内置模块。将整个目录放入宿主技能目录并按宿主方式刷新，
或直接让助手读取 SKILL.md。

```text
使用 $video-gen 做一段海浪拍打沙滩的 5 秒视频。
使用 $video-gen 用我提供的两张图片分别作为首帧和尾帧，先告诉我生成设置。
```

默认 Seedance 2.0 Fast、480p、5 秒。提交前确认模型、图片用途、时长及付费意图；
已明确授权直接提交时沿用该授权。生成会向配置服务上传提示词和指定图片。

## 配置

`config/runtime.json` 中 api_base_url 指定服务根地址，credential_file 指定密钥文件。
相对配置路径以技能目录为基准，支持 `~`。HEIHUZI_BASE_URL 和 HEIHUZI_ENV_FILE
分别覆盖这两个值；已有共享密钥文件可继续使用，实际默认值见配置文件。
配置文件不能存放真实 Key；字段缺失、类型错误和未知字段会报错。

服务控制台为 `https://code.heihuzi.ai/keys`。Seedance Key 使用 Seedance 视频分组，
MiniMax Key 使用 MiniMax 视频分组。优先在本机设置 HEIHUZI_SEEDANCE_API_KEY
或 HEIHUZI_MINIMAX_API_KEY，脚本也支持共享文件内的同名变量及通用环境变量 HEIHUZI_API_KEY。
优先顺序为分组环境变量、文件内分组变量、通用环境变量。
不要把真实 Key 粘进分享文档；修改服务地址前确认其可信。

## 命令与输出

从技能目录运行，先离线检查，再根据需求创建任务：

```text
node scripts/video.mjs check
node scripts/video.mjs models
node scripts/video.mjs create --prompt "海浪拍打沙滩"
node scripts/video.mjs wait <task_id> --out ./output
node scripts/video.mjs status <task_id>
```

create 会收费，第一行 JSON 给出 task_id。wait 只查询已有任务并下载，不重新创建任务，
成功 JSON 给出绝对 file 路径。默认每 15 秒查一次，最多等 1800 秒；
超时后保留任务号继续查，不自动重交。
下载失败或空内容不会替换旧视频，同名成品追加序号；请使用支持硬链接的本机输出目录。

任务用量状态保存在密钥文件同目录的 video-tasks.json，可与旧版兼容。
费用来自累计用量差额，可能包含同一 Key 的并发任务；暂未查到不代表免费。
`--no-cost` 关闭 wait 的费用查询及摘要，create 仍会记录提交前用量。
模型和图片约束见 [任务协议](references/models.md)。

公开分享前需确认所采用实现的分发授权；本目录未附整体许可证。
