# API 契约

基础路径：`/api/v1`。除注册、登录和刷新外，请求使用 `Authorization: Bearer <accessToken>`。

错误统一返回：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "请求字段不合法",
    "details": [],
    "traceId": "req-..."
  }
}
```

## 认证

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/register` | 注册并返回 Access Token，同时设置 Refresh Cookie |
| POST | `/auth/login` | 登录并轮换 Refresh Cookie |
| POST | `/auth/refresh` | 使用 Cookie 轮换刷新令牌 |
| POST | `/auth/logout` | 撤销当前 Refresh Session 并清除 Cookie |

Refresh Cookie 路径为 `/api/v1/auth`，生产环境在 HTTPS 下自动使用 `Secure`。

## 用户与设置

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/users/me` | 当前用户 |
| PATCH | `/users/me` | 更新展示名、默认乐器、时区和语言 |
| POST | `/users/me/password` | 修改密码并撤销其他会话 |

## 练习

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/sessions` | 光标分页、搜索、筛选和排序 |
| POST | `/sessions` | 创建练习 |
| GET | `/sessions/:id` | 详情，包含音频、标记、目标和复盘 |
| PATCH | `/sessions/:id` | 乐观锁更新；请求必须带 `version` |
| POST | `/sessions/:id/start-review` | 存在已就绪音频时进入 `IN_REVIEW` |
| GET | `/sessions/:id/completion-check` | 返回结构化缺失项 |
| POST | `/sessions/:id/complete` | 原子完成复盘 |
| POST | `/sessions/:id/archive` | 归档已完成练习 |
| POST | `/sessions/:id/restore` | 恢复归档练习 |
| DELETE | `/sessions/:id` | 必须提交完整 `confirmationTitle` |

创建练习：

```json
{
  "title": "协奏曲第二乐章 17-24 小节",
  "instrument": "小提琴",
  "startedAt": "2026-09-29T12:00:00.000Z",
  "focus": "换把后的音准",
  "location": "琴房 A",
  "notes": "节拍器 84 BPM",
  "actualDurationMs": 1800000
}
```

## 音频上传

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/sessions/:sessionId/media/uploads` | 创建上传会话并返回预签名 PUT URL |
| POST | `/media/:mediaId/complete-upload` | 校验对象大小/SHA-256 并投递探测任务 |
| GET | `/media/:mediaId` | 状态、元数据与波形峰值 |
| GET | `/media/:mediaId/playback-url` | 获取短期私有播放地址 |
| POST | `/media/:mediaId/retry-probe` | 重试音频探测 |
| DELETE | `/media/:mediaId` | 删除对象和关联标记 |

创建上传会话：

```json
{
  "originalName": "practice.wav",
  "mimeType": "audio/wav",
  "sizeBytes": 2646000,
  "sha256": "64-hex-characters"
}
```

预签名请求的 `Content-Type` 和 `x-amz-meta-sha256` 已纳入签名，必须使用返回的 `requiredHeaders` 原样上传。

## 标记

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/sessions/:sessionId/annotations` | 标记列表 |
| POST | `/sessions/:sessionId/annotations` | 新增标记 |
| PATCH | `/annotations/:id` | 编辑标记 |
| DELETE | `/annotations/:id` | 删除标记 |

区间使用毫秒整数，最小时长 100 ms，且不能超过音频时长。问题类型为 `RHYTHM`、`FINGERING` 或 `EMOTION`。

## 复盘与目标

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/sessions/:sessionId/review` | 获取复盘 |
| PUT | `/sessions/:sessionId/review` | 保存复盘草稿 |
| POST | `/sessions/:sessionId/review/complete` | 完成复盘事务 |
| GET/POST | `/goals` | 目标列表/创建 |
| GET/PATCH | `/goals/:id` | 目标详情/更新 |
| POST | `/goals/:id/activate` | 重新激活取消或逾期目标 |
| POST | `/goals/:id/cancel` | 带原因取消 |
| POST | `/goals/:id/complete` | 用户确认完成 |
| GET/POST | `/goals/:id/progress` | 进度列表/新增 |

完成复盘请求会原子写入复盘、目标、进度并更新练习状态。任一步失败时全部回滚，返回 `REVIEW_INCOMPLETE` 且 `details` 为缺失项数组。

## 统计与导出

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/statistics/overview` | 总览指标 |
| GET | `/statistics/trends` | 按用户时区分日趋势 |
| GET | `/statistics/issues` | 问题类型、严重度和困难片段 |
| GET | `/statistics/goals` | 目标完成率和逾期 |
| GET | `/statistics/instruments` | 各乐器聚合 |
| GET | `/statistics/dashboard` | 首页聚合 |
| POST | `/exports` | 创建 JSON/CSV 用户数据导出 |
| GET | `/exports/:id` | 查询导出状态和短时下载地址 |

统计接口必须传 `from`、`to` 和 IANA `timezone`。

## 设备保养

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/instruments` | 设备列表，含最近换弦、最近环境读数和预警计数 |
| POST | `/instruments` | 登记设备（弦寿命天数、湿度安全区间可配置） |
| GET | `/instruments/:id` | 设备详情，含生效中的预警 |
| PATCH | `/instruments/:id` | 乐观锁更新；请求必须带 `version` |
| POST | `/instruments/:id/retire` | 退役设备并解除其生效预警 |
| POST | `/instruments/:id/reactivate` | 重新启用已退役设备 |
| POST | `/instruments/:id/merge` | 把本设备历史归并到 `targetId` 设备 |
| GET/POST | `/instruments/:id/string-changes` | 换弦历史 / 记录换弦 |
| GET/POST | `/instruments/:id/environment` | 环境读数 / 记录温湿度 |
| GET/POST | `/instruments/:id/tasks` | 保养事项列表 / 创建 |
| GET/PATCH | `/maintenance-tasks/:id` | 事项详情 / 乐观锁更新 |
| POST | `/maintenance-tasks/:id/complete` | 完成事项 |
| POST | `/maintenance-tasks/:id/cancel` | 取消事项 |
| POST | `/maintenance-tasks/:id/attachments/uploads` | 创建附件上传会话（预签名 PUT） |
| POST | `/maintenance-attachments/:id/complete-upload` | 校验大小与 SHA-256 后置为就绪 |
| GET | `/maintenance-attachments/:id/download-url` | 短期私有下载地址 |
| DELETE | `/maintenance-attachments/:id` | 先清理对象存储，再删除记录 |
| GET | `/maintenance/alerts` | 预警列表（`status=ACTIVE/RESOLVED/ALL`） |
| POST | `/maintenance/alerts/:id/resolve` | 手动解除预警 |
| POST | `/maintenance/scan` | 手动触发预警扫描（幂等） |

### 归并语义

`POST /instruments/:id/merge` 在事务中把来源设备的换弦、环境和维修历史转移到目标设备：

- 与目标设备完全重复的记录（同时间同型号换弦、同时间环境读数、同 `dedupeKey` 事项）会被去除，不产生重复历史。
- 被去除事项关联的附件对象会先在对象存储清理，再删除数据库行。
- 来源设备置为 `MERGED` 并记录 `mergedIntoId`；重复调用同一归并返回 `alreadyMerged: true`，可安全重跑。

### 幂等与重跑

- 记录换弦：唯一约束 `(instrumentId, changedAt, stringSet)`，重复提交返回既有记录和 `deduplicated: true`。
- 记录环境：同一设备同一 `recordedAt` 只保留一条，重复提交覆盖更新。
- 创建事项：客户端可携带 `dedupeKey`，重复提交返回既有事项。
- 预警扫描：Worker 周期执行，也可由写操作或 `POST /maintenance/scan` 触发；扫描按 `dedupeKey` upsert 并解除失效预警，重复执行结果一致。

### 预警规则

- `STRING_AGE`：未记录换弦（INFO）、弦龄达到寿命阈值（WARNING）、达到 1.5 倍阈值（CRITICAL）。
- `ENVIRONMENT`：最新环境读数湿度超出设备安全区间（WARNING）。
- `TASK_DUE`：事项逾期（WARNING）或 7 天内到期（INFO）。

## 健康检查

| 路径 | 说明 |
|---|---|
| `/health/live` | 仅检查进程存活 |
| `/health/ready` | 检查 PostgreSQL、Redis 和对象存储 |
| `/metrics` | Prometheus 文本指标 |
