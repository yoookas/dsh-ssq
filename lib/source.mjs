/**
 * 包内自包含：数据层就是本包的 `src/*.mjs`，不再依赖外部「项目目录」配置。
 *
 * 存档目录（唯一需要落盘的地方）按下面的顺序决定，正常情况下不需要任何配置：
 *   1. 环境变量 SSQ_DATA_DIR（测试 / 高级用法）；
 *   2. 包目录可写时：<包目录>/data —— 与 CLI（`node bin/ssq.mjs fetch`）共用同一份；
 *   3. 包目录不可写（例如被只读挂载）：$DSH_HOME/ssq（默认 ~/.dsh/ssq）。
 */

import { accessSync, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 本包根目录（lib/ 的上一级）。 */
export const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));

let ssqModule;

/** 加载包内的数据层（ESM，进程内缓存）。 */
export async function loadSsq() {
  if (!ssqModule) {
    ssqModule = await import(pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'index.mjs')).href);
  }
  return ssqModule;
}

/** 存档目录。 */
export function resolveDataDir() {
  const override = String(process.env.SSQ_DATA_DIR ?? '').trim();
  if (override) return path.resolve(override);

  try {
    accessSync(PACKAGE_ROOT, constants.W_OK);
    return path.join(PACKAGE_ROOT, 'data');
  } catch {
    const home = String(process.env.DSH_HOME ?? '').trim() || path.join(os.homedir(), '.dsh');
    return path.join(home, 'ssq');
  }
}
