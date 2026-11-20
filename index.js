/**
 * @local/dsh-ssq —— 双色球开奖数据插件（Cordis 插件入口）。
 *
 * 数据层直接复用同仓库 ssq-cwl 项目的 src/*.mjs（fetchRecent / fetchAll /
 * normalizeDraws / toCsv / toJsonl / summarize），插件自己不复制一份抓取逻辑。
 *
 * 三个入口：
 *   · 数据工具：ssq_latest / ssq_history / ssq_sync —— 只依赖 tools 服务；
 *   · 自动化工具：ssq_check / ssq_watch_enable / ssq_watch_status / ssq_watch_disable
 *     —— 额外要求 Host 的 ctx.schedule 服务（durable reminders）；
 *   · 斜杠命令：/ssq-watch on|off|status —— 人直接敲，不经过模型。
 *
 * 缺少某个服务的组合里，只跳过对应的一组入口，数据工具始终可用。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { registerWatchCommand } from './lib/command.mjs';
import { Config, resolveConfig } from './lib/config.js';
import { registerAutomationTools, registerDataTools } from './lib/tools.mjs';

/** Loader 里的插件名。 */
export const name = 'ssq-draws';

/** 没有工具注册表就不激活。 */
export const inject = ['tools'];

export { Config };

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config Loader 传入的 config（cordis.patch.yml 里那一行）
 */
export function apply(ctx, config) {
  const logger = typeof ctx.logger === 'function' ? ctx.logger('ssq-draws') : console;
  const log = (message) => {
    try {
      logger.info(message);
    } catch {
      /* 日志失败不影响工具 */
    }
  };

  // 每次调用都重新解析一次：面板/配置热更新后，下一次调用立即生效。
  const getConfig = () => resolveConfig(config);

  registerDataTools(ctx, getConfig, defineTool);

  // 自动化工具需要 Host 的 schedule 服务：没有它就不注册，而不是让整个插件加载失败。
  ctx.inject(['schedule'], (scheduleCtx) => {
    registerAutomationTools(scheduleCtx, getConfig, defineTool);
  });

  // 人类侧的斜杠命令：额外要求 commands 服务。
  ctx.inject(['schedule', 'commands'], (commandCtx) => {
    registerWatchCommand(commandCtx, getConfig);
  });

  log(
    '双色球插件已加载：ssq_latest / ssq_history / ssq_sync，' +
      '开奖夜自动化 ssq_check / ssq_watch_enable / ssq_watch_status / ssq_watch_disable，' +
      '以及斜杠命令 /ssq-watch on|off|status',
  );
}
