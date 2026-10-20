# 任务协议

以下是脚本内置的适配表。模型 ID、图片能力和分辨率来自现有实现；
未进行本轮真实在线生成验证，不把历史描述写成当前服务保证。

| 别名 | 模型 ID | 图片能力 |
| --- | --- | --- |
| seedance-2.0-fast | doubao-seedance-2-0-fast-260128 | 首帧、首尾帧、参考图 |
| seedance-2.0 | doubao-seedance-2-0-260128 | 首帧、首尾帧、参考图 |
| seedance-2.0-mini | doubao-seedance-2-0-mini-260615 | 无，仅文字 |
| seedance-2.5 | doubao-seedance-2-5-260628 | 无，仅文字 |
| minimax-h3-max | MiniMax-H3-Max | JPEG 首帧 |

所有模型均适配文字输入。默认 Fast、480p、5 秒；MiniMax 的分辨率默认写作 480P。
有首尾帧时 Seedance 默认 adaptive，否则 16:9；MiniMax 无首帧时默认 16:9，
有首帧时默认不传比例。正整数时长可传入，非 5 秒不代表已确认服务支持。

## 图片

Seedance 接受本机 JPEG/PNG，MiniMax 接受本机 JPEG；单张小于 30 MiB，
本机转码后的总请求体不能超过 95,000,000 字节。格式依据文件头检查。
支持链接输入时服务自行获取，客户端不能据此保证远端文件格式和大小；
优先使用用户明确提供且可信的 HTTPS 链接，不自动上传到其他站点。

首帧用 --first-frame，尾帧用 --last-frame，参考图用可重复的 --reference。
首尾帧和参考图互斥；尾帧不能单独使用；MiniMax 不接受尾帧和参考图。

## 命令

```text
node scripts/video.mjs create --model seedance-2.0-fast --prompt "画面与动作" --first-frame ./start.jpg
node scripts/video.mjs create --model seedance-2.0 --prompt "转场" --first-frame ./start.jpg --last-frame ./end.png
node scripts/video.mjs create --model seedance-2.0-fast --prompt "画面与动作" --reference ./ref.png
node scripts/video.mjs wait <task_id> --out ./output --interval 15 --timeout 1800
```

Seedance 创建 /api/v3/contents/generations/tasks，查询同路径加任务号；
MiniMax 创建 /v2/video_generation，查询 /v2/query/video_generation/<task_id>。
当前通过 video_ 前缀判断 MiniMax，服务更改任务号格式时需要更新适配。
任务号接受 A-Z、a-z、0-9、下划线、连字符及内部点号，不以点号开头。
时长、查询间隔和等待上限必须是正安全整数。

set-key seedance <Key> / set-key minimax <Key> 会更新共享密钥文件的对应分组，
可能影响其他共用该分组的工具，仅在用户授权时使用。
费用前后快照及模型信息写入密钥文件同目录的 video-tasks.json，最多保留 50 条；
完成或失败后删除相应记录。并发用量无法精确归因时如实说明。

脚本不重试创建请求。任务失败不能单靠客户端推断退款；下载文件非空也不等于内容正确。
下载先写同目录临时文件；非空后以硬链接排他发布，同名目标追加序号。
失败清理本次临时文件，保留旧成品与任务状态；输出文件系统需支持硬链接。
