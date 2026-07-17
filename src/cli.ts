import { ADAPTERS } from './adapters/index.js';
import { runInstall } from './commands/install.js';
import { runStatus } from './commands/status.js';
import { runUninstall } from './commands/uninstall.js';
import type { Deps } from './commands/types.js';
import { envFromProcess } from './io/env.js';
import { fsIo } from './io/fs-io.js';
import { printResult, printStatus } from './ui/output.js';
import { wizardUi } from './ui/wizard.js';
import { TOOL_VERSION } from './version.js';

const HELP = `let-me-explain v${TOOL_VERSION}
Teach your AI coding assistants to teach you.

Usage:
  npx let-me-explain            run the setup wizard (also updates an existing setup)
  npx let-me-explain status     show current config and installed blocks
  npx let-me-explain uninstall  remove all managed blocks and config
  npx let-me-explain --help     this help
  npx let-me-explain --version  print version
`;

function needsTty(command: string): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      `let-me-explain ${command} is interactive and needs a terminal (TTY).`,
    );
    process.exit(2);
  }
}

async function main(): Promise<number> {
  const arg = process.argv[2];

  if (arg === '--version' || arg === '-v') {
    console.log(TOOL_VERSION);
    return 0;
  }
  if (arg === '--help' || arg === '-h' || arg === 'help') {
    console.log(HELP);
    return 0;
  }

  const deps: Deps = {
    env: envFromProcess(),
    io: fsIo,
    adapters: ADAPTERS,
    now: () => new Date().toISOString(),
  };

  switch (arg) {
    case undefined:
    case 'install': {
      needsTty('install');
      const result = await runInstall(deps, wizardUi);
      printResult(result);
      return result.exitCode;
    }
    case 'uninstall': {
      needsTty('uninstall');
      const result = await runUninstall(deps, wizardUi);
      printResult(result);
      return result.exitCode;
    }
    case 'status': {
      printStatus(await runStatus(deps));
      return 0;
    }
    default:
      console.error(`Unknown command: ${arg}\n`);
      console.log(HELP);
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
