const ROOT =
  process.env.DSH_NODE_MODULES ??
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';

const MAP = {
  '@deepseek-ai/schemastery': `${ROOT}/schemastery/lib/index.mjs`,
  '@deepseek-ai/dsh-tools': `${ROOT}/dsh-tools/lib/index.js`,
  '@deepseek-ai/dsh-schedule': `${ROOT}/dsh-schedule/lib/index.js`,
};

export async function resolve(specifier, context, nextResolve) {
  if (Object.hasOwn(MAP, specifier)) {
    return { url: `file://${MAP[specifier]}`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
