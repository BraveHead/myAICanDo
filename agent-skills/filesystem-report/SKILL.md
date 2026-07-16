---
id: filesystem-report
name: filesystem-report
description: 读取当前线程 sandbox 文件并生成结构化中文报告。
agents:
  - coordinator
  - filesystem
triggers:
  - 总结文件
  - 生成报告
  - 分析目录
---

# Filesystem Report

## When to use

当用户要求基于当前线程 sandbox 中的文件生成报告、摘要、盘点或分析时使用。

## Steps

1. 先用 `list_filesystem_directory` 或 `glob_files` 定位候选文件。
2. 只读取完成任务所需的文件，不要无差别读取整个目录。
3. 对每个关键结论保留可复查依据，包括相对文件路径和必要的原文摘要。
4. 如果文件不存在、目录为空或工具返回错误，直接说明限制和下一步可执行建议。
5. 输出中文报告，包含“结论”“关键依据”“涉及文件”三个部分。

## Output requirements

- 回答必须包含读取过的相对文件路径。
- 不要引用工具没有返回的文件内容。
- 不要执行写文件、编辑文件或删除文件操作，除非用户后续明确要求。
