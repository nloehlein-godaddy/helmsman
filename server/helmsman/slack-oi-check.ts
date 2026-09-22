import { existsSync } from 'node:fs';
import { slackOiConfiguration, SlackOiClient } from '../../src/plugins/slack-oi/transport';

if (existsSync('.env')) process.loadEnvFile('.env');

try {
  const configuration = slackOiConfiguration(process.env);
  const client = new SlackOiClient(configuration, fetch, AbortSignal.timeout(30_000));
  await client.initialize();
  process.stdout.write('Slack OI preflight passed: authenticated, Companion available, tool approvals enabled. No Slack tool was called.\n');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Slack OI preflight failed.'}\n`);
  process.exitCode = 1;
}
