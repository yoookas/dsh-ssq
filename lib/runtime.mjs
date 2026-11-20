/**
 * 配置 + 数据层 + 存档目录。所有工具和命令都通过这一层拿依赖。
 */

import { loadSsq, resolveDataDir } from './source.mjs';

/**
 * @param {() => object} getConfig 读取最新配置
 * @returns {Promise<{cfg: object, project: object, dataDir: string}>}
 */
export async function resolveRuntime(getConfig) {
  const cfg = getConfig();
  return {
    cfg,
    project: await loadSsq(),
    dataDir: resolveDataDir(),
  };
}
