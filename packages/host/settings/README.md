# @mediabase/settings

Host plugin:`ctx.settings`——持久化的扁平 key→JSON 配置(默认
`~/.avstudio/settings.json`,可用 `config.file` 覆盖)。用于 AI 助手 key/base/
model 等可写配置;消费者**每次使用时现读**,改完立即生效、无需重启。

⚠️ 明文存本地文件;这只是便捷配置,不是密钥保险库(生产级应走系统钥匙串)。
