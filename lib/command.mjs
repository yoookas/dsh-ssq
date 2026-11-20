/**
 * 人类侧入口：`/ssq-watch on|off|status`。
 *
 * 和模型侧工具共用 lib/watch-ops.mjs，所以在哪个会话敲命令，
 * 周期任务就绑在哪个会话，抓到的数据也回到那个会话。
 * 命令不经过模型，直接返回一张结果卡片。
 */

import { disableWatch, enableWatch, statusWatch } from './watch-ops.mjs';

const USAGE = '用法：/ssq-watch on | off | status（默认 status）';

export const COMMAND_NAME = 'ssq-watch';
export const COMMAND_DESCRIPTION = '双色球开奖夜自动抓取：on 启用、off 停用、status 查看当前任务与补抓计划。';

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx 已解析 schedule + commands 的作用域
 * @param {() => object} getConfig 配置读取器
 */
export function registerWatchCommand(ctx, getConfig) {
  ctx.commands.register({
    name: COMMAND_NAME,
    description: COMMAND_DESCRIPTION,
    input: { hint: 'on | off | status' },
    async handler({ agent, rawInput, signal }) {
      const action = String(rawInput ?? '').trim().toLowerCase() || 'status';
      const sessionId = agent.session.id;

      try {
        if (action === 'on' || action === 'enable' || action === 'start') {
          const value = await enableWatch({ schedule: ctx.schedule, getConfig, sessionId, signal });
          return {
            kind: 'success',
            text: [
              `${value.created ? '已启用' : '已经在运行'}：${value.title}（id ${value.id ?? '-'}）`,
              `每周 ${value.weekdays.map((day) => `周${'一二三四五六日'[day - 1]}`).join('、')} ${String(value.time ?? '').slice(0, 5)}（${value.time_zone}）`,
              value.scheduled_at
                ? `下次触发：${new Date(value.scheduled_at).toLocaleString('zh-CN', { timeZone: value.time_zone, hour12: false })}`
                : '',
              '抓到的开奖数据会写回本会话；没抓到就按补抓阶梯重试。',
            ]
              .filter(Boolean)
              .join('\n'),
          };
        }

        if (action === 'off' || action === 'disable' || action === 'stop') {
          const value = await disableWatch({ schedule: ctx.schedule, getConfig, sessionId });
          return {
            kind: 'success',
            text: value.deleted.length
              ? `已停用，删除了 ${value.deleted.length} 个任务：\n${value.deleted.map((item) => `- ${item.title}（${item.id}）`).join('\n')}`
              : '本会话没有本插件创建的定时任务。',
          };
        }

        if (action === 'status' || action === 'list' || action === 'ls') {
          const value = await statusWatch({ schedule: ctx.schedule, getConfig, sessionId });
          const lines = ['双色球自动化（本会话）'];
          if (value.weekly) {
            lines.push(
              `- 周期任务：${value.weekly.title}，每周 ${(value.weekly.weekdays ?? []).join('/')} ${String(value.weekly.time ?? '').slice(0, 5)}（${value.weekly.time_zone ?? value.time_zone}）`,
              `- 下次触发：${value.weekly.scheduled_at ? new Date(value.weekly.scheduled_at).toLocaleString('zh-CN', { hour12: false }) : '-'}`,
            );
          } else {
            lines.push('- 周期任务：未启用（/ssq-watch on 启用）');
          }
          lines.push(`- 待补抓：${value.retries.length} 个`);
          for (const item of value.retries) {
            lines.push(`  · ${new Date(item.at).toLocaleString('zh-CN', { hour12: false })}`);
          }
          if (value.nights.length) {
            lines.push('- 最近检查：');
            for (const night of value.nights.slice(0, 5)) {
              lines.push(`  · ${night.night} → 期号 ${night.expected_issue ?? '-'}，${night.status}`);
            }
          }
          return { kind: 'success', text: lines.join('\n') };
        }

        return { kind: 'error', text: USAGE };
      } catch (error) {
        return { kind: 'error', text: `双色球自动化失败：${error?.message ?? String(error)}` };
      }
    },
  });
}
