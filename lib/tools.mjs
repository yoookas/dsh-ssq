/**
 * 七个模型可见的工具。
 *
 * 数据类（不依赖 schedule 服务）：
 *   ssq_latest / ssq_history / ssq_sync
 * 自动化类（依赖 Host 的 ctx.schedule 服务）：
 *   ssq_check / ssq_watch_enable / ssq_watch_status / ssq_watch_disable
 *
 * 约定：工具返回值必须是「无损 JSON」（不能有 undefined），所以可选字段统一写 null；
 * 每个工具都额外 render 一段中文 markdown，Native 模式模型直接读这段。
 */

import { mutateArchive, queryDraws, readArchive } from './archive.mjs';
import { resolveRuntime } from './runtime.mjs';
import { checkDrawNight, disableWatch, enableWatch, statusWatch } from './watch-ops.mjs';
import { weekdayName } from './time.mjs';

const numberFmt = new Intl.NumberFormat('zh-CN');

const INT = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const STR = (description, extra = {}) => ({ type: 'string', description, ...extra });
const BOOL = (description) => ({ type: 'boolean', description });
const JSON_VALUE = (description) => ({ type: 'json', description });
/** 可空字符串：缺数据时显式给 null，而不是省略字段。 */
const MAYBE_STRING = (description) => ({ type: 'json', description: `${description}（无值时为 null）` });

const clamp = (value, low, high) => Math.min(Math.max(Number.isFinite(value) ? value : low, low), high);
const nowIso = () => new Date().toISOString();
const fail = (message) => {
  throw new Error(message);
};

function requireAgent(exec, toolName) {
  const agent = exec?.agent;
  if (!agent) fail(`${toolName} 需要一个会话（Session）上下文；当前调用没有绑定 Agent。`);
  return agent;
}

function describeDraw(draw) {
  const counts = draw.tiers?.map((tier) => tier.winners) ?? [];
  return {
    issue: draw.issue,
    date: draw.date,
    weekday: draw.weekday || weekdayName(draw.date),
    red: draw.red,
    blue: draw.blue,
    sales: draw.sales,
    pool: draw.pool,
    tiers: draw.tiers,
    first_prize_winners: counts[0] ?? null,
    first_prize: draw.tiers?.[0]?.prize ?? null,
    first_prize_places: draw.firstPrizePlaces ?? null,
    notes: draw.notes ?? null,
    detail_url: draw.detailUrl ?? null,
  };
}

function renderDrawList(draws, title) {
  const lines = [`**${title}**`, ''];
  for (const draw of draws) {
    lines.push(`${draw.issue}  ${draw.date}(${draw.weekday || weekdayName(draw.date)})  红 ${draw.red.join(' ')}  蓝 ${draw.blue}`);
    const money = [];
    if (typeof draw.sales === 'number') money.push(`销售额 ${numberFmt.format(draw.sales)} 元`);
    if (typeof draw.pool === 'number') money.push(`奖池 ${numberFmt.format(draw.pool)} 元`);
    if (money.length) lines.push(`  ${money.join('   ')}`);
    for (const tier of draw.tiers ?? []) {
      const note = tier.prizeNote ? ` ${tier.prizeNote}` : '';
      lines.push(
        `  ${tier.name}  ${String(tier.winners ?? '-').padStart(9)} 注 × ${String(tier.prize ?? '-').padStart(8)} 元${note}`,
      );
    }
    if (draw.firstPrizePlaces || draw.first_prize_places) {
      lines.push(`  一等奖分布：${draw.firstPrizePlaces ?? draw.first_prize_places}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * 注册数据类工具。
 * @param {import('@deepseek-ai/cordis').Context} ctx 已注册 tools 服务的作用域
 * @param {() => object} getConfig 每次调用时读取最新配置
 * @param {Function} defineTool 宿主提供的工具定义器
 */
export function registerDataTools(ctx, getConfig, defineTool) {
  ctx.tools.register(
    defineTool({
      name: 'ssq_latest',
      description:
        '获取双色球最近 N 期开奖数据（中国福利彩票官网实时接口）。每期包含 6 个红球、1 个蓝球、销售额、奖池，以及一～六等奖各自的 中奖注数 / 单注奖金。用户问「最新一期」「上期开奖结果」「最近几期号码」时调用。',
      parameters: {
        count: INT('返回期数，1-100，默认 5。', { default: 5 }),
        fresh: BOOL('是否强制走官网实时接口（默认 true）。false 时只读本地存档，适合离线或省流。'),
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            source: { type: 'string', required: true },
            fetched_at: { type: 'string', required: true },
            count: { type: 'integer', required: true },
            draws: { type: 'array', required: true, items: JSON_VALUE('一期完整开奖记录') },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: renderDrawList(value.draws, `最近 ${value.count} 期（${value.source}）`) },
        ],
      },
      async execute(args, exec) {
        const count = clamp(Number(args.count ?? 5), 1, 100);
        const { project, dataDir } = await resolveRuntime(getConfig);

        if (args.fresh === false) {
          const archive = await readArchive(dataDir);
          if (!archive.exists) fail('本地还没有存档，请先用 fresh=true（或调用 ssq_sync）抓一次。');
          const draws = archive.draws.slice(0, count).map(describeDraw);
          return { source: '本地存档', fetched_at: nowIso(), count: draws.length, draws };
        }

        const raw = await project.fetchRecent(count, { signal: exec.signal });
        const draws = project.normalizeDraws(raw).map(describeDraw);
        return { source: project.SOURCE_INFO?.name ?? 'cwl.gov.cn', fetched_at: nowIso(), count: draws.length, draws };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'ssq_history',
      description:
        '查询双色球「往期开奖数据」。数据来自本地存档 data/ssq_draws.jsonl（与 CLI 共用，官网口径，2013-01-01 至今），首次查询会自动从官网同步再筛选。支持按期号区间（from_issue/to_issue）、年份（year）、日期区间（from_date/to_date）过滤，并分页返回。用户问「往期」「历史某期」「2019 年的开奖」「某段时间的号码」时调用。',
      parameters: {
        from_issue: STR('起始期号（含），如 "2025001"。'),
        to_issue: STR('结束期号（含），如 "2025153"。'),
        year: INT('年份快捷筛选，如 2024（等价于期号前缀 2024）。'),
        from_date: STR('起始开奖日期（含），YYYY-MM-DD。'),
        to_date: STR('结束开奖日期（含），YYYY-MM-DD。'),
        page: INT('页码，从 1 开始，默认 1。', { default: 1 }),
        page_size: INT('每页条数，1-200，默认 20。', { default: 20 }),
        with_tiers: BOOL('是否返回 6 个奖级的明细（默认 true）。false 时只给号码，省 token。'),
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            source: { type: 'string', required: true },
            total: { type: 'integer', required: true },
            page: { type: 'integer', required: true },
            pages: { type: 'integer', required: true },
            page_size: { type: 'integer', required: true },
            returned: { type: 'integer', required: true },
            range: JSON_VALUE('筛选结果的期号/日期范围，空结果时为 null'),
            draws: { type: 'array', required: true, items: JSON_VALUE('一期完整开奖记录') },
          },
        },
        render: (args, value) => {
          const head = `**双色球往期数据**　共 ${value.total} 期，第 ${value.page}/${value.pages} 页`;
          if (value.returned === 0) return [{ type: 'text', text: `${head}\n\n没有符合条件的开奖记录，请检查筛选条件或年份范围（数据起于 2013 年）。` }];
          const range = value.range ? `　范围 ${value.range.first_issue}（${value.range.first_date}）→ ${value.range.last_issue}（${value.range.last_date}）` : '';
          const rows = value.draws.map((draw) => {
            const first = draw.tiers?.[0];
            const prize = first ? `${first.winners ?? '-'} 注 × ${first.prize ?? '-'} 元` : '-';
            return `| ${draw.issue} | ${draw.date}(${draw.weekday || weekdayName(draw.date)}) | ${draw.red.join(' ')} | ${draw.blue} | ${prize} |`;
          });
          const table = ['| 期号 | 日期 | 红球 | 蓝球 | 一等奖 |', '| --- | --- | --- | --- | --- |', ...rows].join('\n');
          return [{ type: 'text', text: `${head}${range}\n\n${table}\n\n需要其它页时把 page 换成 ${Math.min(value.page + 1, value.pages)}。` }];
        },
      },
      async execute(args, exec) {
        const page = clamp(Number(args.page ?? 1), 1, 100000);
        const pageSize = clamp(Number(args.page_size ?? 20), 1, 200);
        const { project, dataDir } = await resolveRuntime(getConfig);

        let archive = await readArchive(dataDir);
        if (!archive.exists) {
          const full = await project.fetchAll({ pageSize: 100, concurrency: 2, delayMs: 120, signal: exec.signal });
          const draws = project.normalizeDraws(project.dedupeAndSort(full.result));
          await mutateArchive(project, dataDir, draws);
          archive = await readArchive(dataDir);
        }

        const result = queryDraws(archive.draws, {
          fromIssue: args.from_issue?.trim() || null,
          toIssue: args.to_issue?.trim() || null,
          year: args.year ?? null,
          fromDate: args.from_date?.trim() || null,
          toDate: args.to_date?.trim() || null,
          page,
          pageSize,
        });

        const withTiers = args.with_tiers !== false;
        const draws = result.rows.map((draw) => {
          const shaped = describeDraw(draw);
          if (!withTiers) delete shaped.tiers;
          return shaped;
        });

        return {
          source: '本地存档 data/ssq_draws.jsonl',
          total: result.total,
          page: result.page,
          pages: result.pages,
          page_size: pageSize,
          returned: draws.length,
          range: result.first
            ? {
                first_issue: result.first.issue,
                first_date: result.first.date,
                last_issue: result.last.issue,
                last_date: result.last.date,
              }
            : null,
          draws,
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'ssq_sync',
      description:
        '把中国福利彩票官网的双色球开奖数据完整同步到本地存档（data/ssq_draws.jsonl / .csv / summary.json / latest.json）。每次都拉完整快照（约 21 页 / 2.7 秒），合并去重后整体重写，所以既不会重复也不会漏期。用户要求「更新数据」「补到最新」时调用。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            data_dir: { type: 'string', required: true },
            mode: { type: 'string', required: true },
            fetched_pages: { type: 'integer', required: true },
            added: { type: 'integer', required: true },
            archive_total: { type: 'integer', required: true },
            latest: JSON_VALUE('最新一期，空存档时为 null'),
            files: JSON_VALUE('落盘文件路径'),
            generated_at: { type: 'string', required: true },
          },
        },
        render: (_args, value) => {
          const latest = value.latest;
          const lines = [
            `**双色球数据同步完成**（${value.mode === 'full' ? '全量' : '增量'}）`,
            '',
            `存档目录：${value.data_dir}`,
            `本次抓取 ${value.fetched_pages} 页，新增 ${value.added} 期，存档共 ${value.archive_total} 期`,
          ];
          if (latest) {
            lines.push(`最新一期：${latest.issue}  ${latest.date}(${latest.weekday})  红 ${latest.red.join(' ')}  蓝 ${latest.blue}`);
          }
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute(args, exec) {
        const { project, dataDir } = await resolveRuntime(getConfig);

        // 一次完整快照：21 页、约 2.7 秒。合并去重在 mutateArchive 的写队列里完成。
        const fetched = await project.fetchAll({ pageSize: 100, concurrency: 2, delayMs: 120, signal: exec.signal });
        const incoming = project.normalizeDraws(project.dedupeAndSort(fetched.result));
        const written = await mutateArchive(project, dataDir, incoming);

        return {
          data_dir: dataDir,
          mode: 'full',
          fetched_pages: fetched.pages,
          added: written.added,
          archive_total: written.total,
          latest: written.latest ? describeDraw(written.latest) : null,
          files: written.files,
          generated_at: nowIso(),
        };
      },
    }),
  );
}

/**
 * 注册自动化工具（需要 Host 的 schedule 服务）。
 * @param {import('@deepseek-ai/cordis').Context} ctx 已解析 schedule 服务的作用域
 * @param {() => object} getConfig 配置读取器
 * @param {Function} defineTool 宿主的工具定义器
 */
/**
 * 注册自动化工具（需要 Host 的 schedule 服务）。
 *
 * 这里只负责「模型可见的 schema + 渲染」，真正的业务在 lib/watch-ops.mjs，
 * 与人类侧的 /ssq-watch 命令共用同一份实现。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 已解析 schedule 服务的作用域
 * @param {() => object} getConfig 配置读取器
 * @param {Function} defineTool 宿主的工具定义器
 */
export function registerAutomationTools(ctx, getConfig, defineTool) {
  ctx.tools.register(
    defineTool({
      name: 'ssq_check',
      description:
        '双色球开奖夜检查与自动补抓。检查某个开奖日的新一期是否已发布：已发布则把数据写入本地存档并删除本期的补抓任务；未发布则按阶梯创建一次性补抓提醒（默认 +5/+15/+45 分钟，以及次日 06:00）。通常由开奖夜周期提醒触发，也可以手动调用。同日重复调用时不会重复排任务。',
      parameters: {
        date: STR('要检查的开奖日 YYYY-MM-DD；省略时自动判断（有挂起的补抓期就查那期，否则查最近一个开奖日）。'),
        force: BOOL('即使本期补抓阶梯已经用尽，也重新排一轮（默认 false）。'),
        dry_run: BOOL('只计算不落盘、不建任务（默认 false）。'),
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true, enum: ['published', 'pending', 'gave-up'] },
            night: { type: 'string', required: true },
            expected_issue: MAYBE_STRING('本次检查的开奖日对应的期号'),
            latest_issue: MAYBE_STRING('本地存档里的最新期号'),
            latest_date: MAYBE_STRING('本地存档里的最新开奖日期'),
            added: { type: 'integer', required: true },
            retries: { type: 'array', required: true, items: JSON_VALUE('补抓任务：label / at / id / created') },
            next_attempt: MAYBE_STRING('下一次补抓的 UTC 时刻（RFC3339）'),
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderCheck(value) }],
      },
      async execute(args, exec) {
        const agent = requireAgent(exec, 'ssq_check');
        return checkDrawNight({
          schedule: ctx.schedule,
          getConfig,
          sessionId: agent.session.id,
          signal: exec.signal,
          date: args.date,
          force: args.force,
          dryRun: args.dry_run,
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'ssq_watch_enable',
      description:
        '创建双色球「开奖夜自动抓取」周期任务：默认每周二、周四、周日 21:35（Asia/Shanghai）在当前会话提醒执行 ssq_check；未抓到会自动进入 +5/+15/+45 分钟与次日 06:00 的补抓阶梯。用户说「每周二四日开奖后自动抓」「定时抓开奖数据」时调用。重复调用不会建第二个任务。',
      parameters: {
        time: STR('首次检查时间 HH:mm 或 HH:mm:ss，默认用插件配置（21:35）。'),
        weekdays: {
          type: 'array',
          description: '开奖日，ISO 星期（周一 1 … 周日 7），默认 [2,4,7] 即周二/四/日。',
          items: INT('ISO 星期 1-7'),
        },
        time_zone: STR('IANA 时区，默认 Asia/Shanghai。'),
        replace: BOOL('已有的周期任务要按新参数重建时传 true。'),
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean', required: true },
            created: { type: 'boolean', required: true },
            id: MAYBE_STRING('schedule 任务 id'),
            kind: MAYBE_STRING('任务类型，weekly 表示周期任务'),
            title: { type: 'string', required: true },
            time: MAYBE_STRING('首次检查时间 HH:mm:ss'),
            weekdays: { type: 'array', required: true, items: INT('ISO 星期') },
            time_zone: { type: 'string', required: true },
            scheduled_at: MAYBE_STRING('下一次触发的 UTC 时刻（RFC3339）'),
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: [
              `**双色球开奖夜自动抓取${value.created ? '已创建' : '已存在'}**`,
              '',
              `- 周期：每周 ${value.weekdays.map((day) => `周${'一二三四五六日'[day - 1]}`).join('、')} ${value.time?.slice(0, 5) ?? ''}（${value.time_zone}）`,
              `- 任务：${value.title}（id ${value.id ?? '-'}）`,
              `- 下次触发：${value.scheduled_at ? new Date(value.scheduled_at).toLocaleString('zh-CN', { timeZone: value.time_zone, hour12: false }) : '-'}`,
              '',
              value.message,
            ].join('\n'),
          },
        ],
      },
      async execute(args, exec) {
        const agent = requireAgent(exec, 'ssq_watch_enable');
        return enableWatch({
          schedule: ctx.schedule,
          getConfig,
          sessionId: agent.session.id,
          signal: exec.signal,
          time: args.time,
          weekdays: args.weekdays,
          timeZone: args.time_zone,
          replace: args.replace,
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'ssq_watch_status',
      description:
        '查看当前会话的双色球自动化任务：开奖夜周期任务、还在排队的补抓任务、以及每一期最近一次检查的结论。用户问「自动抓开奖的任务还在吗」「下次什么时候抓」时调用。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            session_id: { type: 'string', required: true },
            weekly: JSON_VALUE('周期任务，没有时为 null'),
            retries: { type: 'array', required: true, items: JSON_VALUE('补抓任务') },
            nights: { type: 'array', required: true, items: JSON_VALUE('每期检查结论') },
            time_zone: { type: 'string', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
      },
      async execute(_args, exec) {
        const agent = requireAgent(exec, 'ssq_watch_status');
        return statusWatch({ schedule: ctx.schedule, getConfig, sessionId: agent.session.id });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'ssq_watch_disable',
      description:
        '停用当前会话的双色球自动化任务：删除开奖夜周期任务，以及所有还没执行的补抓任务。用户说「关掉自动抓开奖」「别再提醒了」时调用。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            deleted: { type: 'array', required: true, items: JSON_VALUE('被删除的任务') },
            remaining: { type: 'integer', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: [
              '**已停用双色球自动化任务**',
              '',
              value.deleted.length
                ? value.deleted.map((item) => `- ${item.title}（id ${item.id}，原定 ${item.scheduled_at ?? '-'}）`).join('\n')
                : '- 没有找到本插件创建的任务',
              '',
              value.message,
            ].join('\n'),
          },
        ],
      },
      async execute(_args, exec) {
        const agent = requireAgent(exec, 'ssq_watch_disable');
        return disableWatch({ schedule: ctx.schedule, getConfig, sessionId: agent.session.id });
      },
    }),
  );
}

/* ------------------------------ 小工具 ------------------------------ */

function renderCheck(value) {
  const lines = [`**开奖检查：${value.night}**`, '', value.message];
  if (value.retries?.length) {
    lines.push('', '补抓计划：');
    for (const item of value.retries) {
      lines.push(`- ${item.label}：${new Date(item.at).toLocaleString('zh-CN', { hour12: false })}${item.created ? '' : '（未创建）'}`);
    }
  }
  return lines.join('\n');
}

function renderStatus(value) {
  const lines = ['**双色球自动化任务**', ''];
  if (value.weekly) {
    lines.push(`- 周期任务：${value.weekly.title}（${value.weekly.time?.slice(0, 5) ?? '-'}，周 ${(value.weekly.weekdays ?? []).join('/')}，${value.weekly.time_zone ?? '-'}）`);
    lines.push(`  下次触发：${value.weekly.scheduled_at ? new Date(value.weekly.scheduled_at).toLocaleString('zh-CN', { hour12: false }) : '-'}`);
  } else {
    lines.push('- 周期任务：无');
  }
  lines.push(`- 待补抓：${value.retries.length} 个`);
  for (const item of value.retries) {
    lines.push(`  · ${new Date(item.at).toLocaleString('zh-CN', { hour12: false })}（id ${item.id}）`);
  }
  if (value.nights.length) {
    lines.push('', '最近检查：');
    for (const night of value.nights) {
      lines.push(`- ${night.night} → 期号 ${night.expected_issue ?? '-'}，状态 ${night.status}${night.checked_at ? `，${new Date(night.checked_at).toLocaleString('zh-CN', { hour12: false })}` : ''}`);
    }
  }
  return lines.join('\n');
}
