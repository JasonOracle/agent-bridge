# 技术文档 — Todo App

## 1. 技术栈
Node.js 原生 ESM，无需外部依赖。测试使用 Node.js 22 内置 `node:test` 与 `node:assert`。

## 2. 核心模块结构
- `src/todo.js`: 核心业务逻辑类 `TodoList`
- `test/todo.test.js`: 原生自动化单测
