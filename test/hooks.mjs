/**
 * 测试专用：把插件里那几个 @deepseek-ai/* 裸包名映射到当前 dsh 安装目录，
 * 模拟 Host 运行时对插件包的解析方式（Host 装了 resolver interception）。
 *
 * 用法：node --import ./test/hooks.mjs test/run.mjs
 * 安装目录不同时用 DSH_NODE_MODULES 覆盖。
 */
import { register } from 'node:module';

register(new URL('./resolve-hook.mjs', import.meta.url), import.meta.url);
