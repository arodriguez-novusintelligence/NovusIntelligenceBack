// Claude Code en modo headless: desarrolla en el repo y transmite su trabajo a la consola del portal.
import { run } from './sh.mjs';

const ALLOWED_TOOLS = [
  'Read',
  'Edit',
  'MultiEdit',
  'Write',
  'Glob',
  'Grep',
  'LS',
  'TodoWrite',
  'Task',
  'Bash(npm run lint:*)',
  'Bash(npm run build:prod)',
  'Bash(npm run build:prod:*)',
  'Bash(npx tsc:*)',
  'Bash(npx eslint:*)',
  'Bash(npx vitest:*)',
  'Bash(node --test:*)',
  'Bash(git diff:*)',
  'Bash(git status:*)',
  'Bash(git log:*)',
  'Bash(ls:*)',
];

const DISALLOWED_TOOLS = ['WebFetch', 'WebSearch', 'Bash(git push:*)', 'Bash(git commit:*)', 'Bash(npm run deploy:*)', 'Bash(aws:*)', 'Bash(curl:*)'];

function short(path) {
  return String(path ?? '').replace(/^.*?\/repo\//, '');
}

function describeTool(name, input = {}) {
  switch (name) {
    case 'Read':
      return `Leyendo ${short(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
      return `Editando ${short(input.file_path)}`;
    case 'Write':
      return `Escribiendo ${short(input.file_path)}`;
    case 'Glob':
      return `Buscando archivos ${input.pattern ?? ''}`;
    case 'Grep':
      return `Buscando "${String(input.pattern ?? '').slice(0, 80)}" en el código`;
    case 'LS':
      return `Revisando la carpeta ${short(input.path)}`;
    case 'Bash':
      return `Ejecutando: ${String(input.command ?? '').slice(0, 160)}`;
    case 'TodoWrite':
      return null;
    case 'Task':
      return `Delegando una revisión: ${String(input.description ?? '').slice(0, 120)}`;
    default:
      return `Usando ${name}`;
  }
}

export async function runClaude({ cwd, prompt, system, model, budgetUsd, apiKey, emit, timeoutMs = 50 * 60 * 1000 }) {
  let result = null;
  let lastPlan = '';
  const pending = [];
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    model,
    '--permission-mode',
    'acceptEdits',
    '--max-budget-usd',
    String(budgetUsd),
    '--append-system-prompt',
    system,
    '--allowedTools',
    ...ALLOWED_TOOLS,
    '--disallowedTools',
    ...DISALLOWED_TOOLS,
  ];

  const onLine = (line) => {
    if (!line.startsWith('{')) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === 'assistant') {
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text' && block.text?.trim()) {
          pending.push(emit('thought', block.text.trim().slice(0, 1500)));
        } else if (block.type === 'tool_use') {
          if (block.name === 'TodoWrite' && Array.isArray(block.input?.todos)) {
            const plan = block.input.todos
              .map((t) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '→' : '·'} ${t.content}`)
              .join('\n');
            if (plan !== lastPlan) {
              lastPlan = plan;
              pending.push(emit('plan', plan));
            }
          } else {
            const text = describeTool(block.name, block.input);
            if (text) pending.push(emit('tool', text));
          }
        }
      }
    } else if (msg.type === 'result') {
      result = msg;
    }
  };

  const res = await run('claude', args, {
    cwd,
    env: {
      ANTHROPIC_API_KEY: apiKey,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      CI: '1',
    },
    onLine,
    timeoutMs,
    quiet: true,
  });
  await Promise.allSettled(pending);
  return {
    exitCode: res.code,
    ok: res.code === 0 && result && !result.is_error,
    subtype: result?.subtype,
    text: result?.result ?? '',
    costUsd: result?.total_cost_usd ?? null,
    turns: result?.num_turns ?? null,
    tail: res.out.split('\n').slice(-15).join('\n'),
  };
}
