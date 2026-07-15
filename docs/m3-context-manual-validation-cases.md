# M3 Context v1 人工验证 Case

> 目标：人工确认 M3 的 prompt 分层、工具结果 offload、`.context/offloads` artifact、SSE 轻量结果、filesystem 边界和线程隔离行为。

## 0. 准备环境

1. 确认 `.env.local` 中有数据库和 sandbox 根目录。

```bash
grep -E '^(DATABASE_URL|FILESYSTEM_SANDBOX_ROOT)=' .env.local
```

当前本地默认应类似：

```text
FILESYSTEM_SANDBOX_ROOT=/Users/zhangshun/data/my-ai/agent-files
```

2. 初始化 demo 账号。

```bash
fnm exec --using .node-version bun run seed:saas
```

默认账号：

```text
账号：demo
密码：demo123456
租户：tenant_demo
用户：user_demo
```

3. 启动 dev server。

```bash
fnm exec --using .node-version bun run dev
```

4. 打开浏览器访问：

```text
http://localhost:3000/login
```

登录后进入类似：

```text
http://localhost:3000/tenant_demo/chat/<threadId>
```

后续 shell 中把 `<threadId>` 替换成 URL 里的真实 thread id。

```bash
ROOT=$(grep '^FILESYSTEM_SANDBOX_ROOT=' .env.local | cut -d= -f2-)
THREAD_ID=<从浏览器 URL /chat/ 后复制>
SANDBOX="$ROOT/tenant_demo/user_demo/$THREAD_ID"
mkdir -p "$SANDBOX/workspace"
```

## Case 1：大文件读取触发 offload

### 准备数据

```bash
node -e 'const fs=require("fs"); fs.writeFileSync(process.argv[1], ["M3_OFFLOAD_BEGIN","x".repeat(9000),"M3_OFFLOAD_END"].join("\n"))' "$SANDBOX/workspace/m3-large.txt"
```

### UI 操作

1. 打开浏览器 DevTools 的 Network 面板。
2. 点击页面下方的 `Files` suggestion，确保当前线程使用 filesystem agent。
3. 在输入框发送：

```text
请读取 workspace/m3-large.txt。只说明是否读取成功、文件路径和大小，不要复述文件全文。
```

### 预期结果

- 页面回答不应展示 9000 个 `x` 的原文。
- Network 中 `/api/tenants/tenant_demo/chat` 的 SSE 响应里，应能搜索到：

```text
"offloaded":true
".context/offloads/
"originalSizeBytes"
```

- SSE 响应里不应出现：

```text
M3_OFFLOAD_BEGIN
M3_OFFLOAD_END
```

- sandbox 下应生成 artifact：

```bash
find "$SANDBOX/.context/offloads" -type f -name '*.json' | sort
```

- artifact 中应保存原始内容和工具元数据：

```bash
OFFLOAD_FILE=$(find "$SANDBOX/.context/offloads" -type f -name '*.json' | sort | tail -1)
node -e 'const fs=require("fs"); const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log({artifactPath:a.artifactPath, toolName:a.toolName, toolCallId:a.toolCallId, originalSizeBytes:a.originalSizeBytes, hasBegin:JSON.stringify(a.originalResult).includes("M3_OFFLOAD_BEGIN"), hasEnd:JSON.stringify(a.originalResult).includes("M3_OFFLOAD_END")})' "$OFFLOAD_FILE"
```

预期输出：

```text
toolName: read_filesystem_file
hasBegin: true
hasEnd: true
originalSizeBytes: 大于 12000 或接近大文件结果体积
```

## Case 2：小文件读取保持 inline，不生成 offload

### 准备数据

```bash
printf 'M3_SMALL_INLINE_CONTENT\n' > "$SANDBOX/workspace/m3-small.txt"
BEFORE_COUNT=$(find "$SANDBOX/.context/offloads" -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
```

### UI 操作

发送：

```text
请读取 workspace/m3-small.txt，并告诉我文件内容。
```

### 预期结果

- 页面可以看到 `M3_SMALL_INLINE_CONTENT`。
- Network SSE 中这次工具结果不应包含新的 `"offloaded":true`。
- artifact 数量不增加：

```bash
AFTER_COUNT=$(find "$SANDBOX/.context/offloads" -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
test "$BEFORE_COUNT" = "$AFTER_COUNT" && echo "PASS: no new offload artifact"
```

## Case 3：默认 list/search/glob 隐藏 `.context`

### 准备状态

确保 Case 1 已经生成 artifact，然后删除原始 workspace 大文件，只保留 artifact 中的 marker。

```bash
rm -f "$SANDBOX/workspace/m3-large.txt"
```

### UI 操作 A：列根目录

发送：

```text
请列出当前沙盒根目录。
```

预期：

- 结果可以包含 `workspace`。
- 不应列出 `.context`。

### UI 操作 B：默认搜索

发送：

```text
请在当前沙盒里搜索 M3_OFFLOAD_BEGIN。
```

预期：

- 默认搜索不应命中 `.context/offloads/*.json`。
- 如果没有其它文件包含该 marker，应返回没有匹配。

### Shell 复核

```bash
grep -R "M3_OFFLOAD_BEGIN" "$SANDBOX/.context/offloads"
```

预期：shell 能找到 marker，说明数据存在，只是默认 filesystem search 对 agent 隐藏 `.context`。

## Case 4：普通文件工具不能写 `.context`，但可以写 `workspace/**` 且仍需审批

### UI 操作 A：尝试写 `.context`

发送：

```text
请把内容 user-write-blocked 写入 .context/offloads/user-write.json。
```

预期：

- 不应出现 approval 卡片。
- agent 应报告权限限制，含义应类似：普通 filesystem mutation 只允许 `workspace/**` 和 `notes/**`。
- 文件不应存在：

```bash
test ! -f "$SANDBOX/.context/offloads/user-write.json" && echo "PASS: user write blocked"
```

### UI 操作 B：写 `workspace/**`

发送：

```text
请把内容 approved-workspace-write 写入 workspace/manual-approval.txt。
```

预期：

- 页面出现人工确认卡片。
- 卡片路径为 `workspace/manual-approval.txt`。
- 点击确认后文件存在：

```bash
cat "$SANDBOX/workspace/manual-approval.txt"
```

预期输出：

```text
approved-workspace-write
```

## Case 5：同租户同用户的新线程不会复用旧线程 sandbox

### UI 操作

1. 在页面中新建一个会话，或直接访问 `http://localhost:3000/tenant_demo` 让系统跳转到新 thread。
2. 复制新 URL 中的 `<newThreadId>`。
3. 点击 `Files` suggestion。
4. 发送：

```text
请读取 workspace/m3-small.txt。
```

### 预期结果

- 新线程应读不到旧线程的 `workspace/m3-small.txt`。
- 新 sandbox 路径应不同：

```bash
NEW_THREAD_ID=<新 URL /chat/ 后复制>
NEW_SANDBOX="$ROOT/tenant_demo/user_demo/$NEW_THREAD_ID"
test "$NEW_SANDBOX" != "$SANDBOX" && echo "PASS: thread sandbox isolated"
find "$NEW_SANDBOX" -maxdepth 3 -type f 2>/dev/null | sort
```

## Case 6：显式检查 artifact 内容可追溯

### Shell 操作

使用 Case 1 得到的 `$OFFLOAD_FILE`：

```bash
node -e 'const fs=require("fs"); const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(JSON.stringify({version:a.version, path:a.artifactPath, toolName:a.toolName, summary:a.summary, args:a.args, originalResultKeys:Object.keys(a.originalResult ?? {})}, null, 2))' "$OFFLOAD_FILE"
```

### 预期结果

artifact 至少包含：

```text
version
artifactPath
args
createdAt
originalResult
originalSizeBytes
summary
toolCallId
toolName
```

这条 case 用来确认：offload 不是丢弃原始结果，而是把原始结果转移到当前线程内部 artifact。

## Case 7：SSE 事件与 checkpoint retry 提示

### UI 操作

重复 Case 1，再看 Network SSE。如果模型在工具完成后的续跑阶段失败并触发 checkpoint 恢复，观察页面中工具卡后的提示。

### 预期结果

- offload 的工具完成结果仍然使用原有工具完成事件，可在响应中搜索：

```text
tool_call.complete.result
```

或搜索前端事件内容里的：

```text
tool_call
complete
result
```

- 如果触发 checkpoint 恢复重试，SSE 中应出现：

```text
agent_retry
reason
recovery
checkpoint
```

- 页面上应显示“已从 checkpoint 重试”，并展示具体失败原因；之前已经成功的工具卡仍显示“完成”。

- `result` 中应是轻量 reference，而不是原始大文件内容。

## 验收结论模板

```text
M3 人工验证结果：
- Case 1 大文件 offload：通过 / 不通过
- Case 2 小文件 inline：通过 / 不通过
- Case 3 .context 默认隐藏：通过 / 不通过
- Case 4 mutation 权限与 approval：通过 / 不通过
- Case 5 线程 sandbox 隔离：通过 / 不通过
- Case 6 artifact 可追溯：通过 / 不通过
- Case 7 SSE 与 checkpoint retry 提示：通过 / 不通过

阻塞项：
- 无 / 具体描述
```
