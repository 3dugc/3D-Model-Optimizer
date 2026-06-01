import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const timeZone = 'Asia/Shanghai';
const targetPath = resolve(process.argv[2] || 'dist/build-info.json');
const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
const now = new Date();

const parts = Object.fromEntries(
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now).map((part) => [part.type, part.value])
);

const stamp = `${parts.year}${parts.month}${parts.day}.${parts.hour}${parts.minute}${parts.second}`;
const builtAtBeijing = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} 北京时间`;

const buildInfo = {
  version: `v${stamp}`,
  packageVersion: packageJson.version,
  builtAtIso: now.toISOString(),
  builtAtBeijing,
  timeZone,
};

mkdirSync(dirname(targetPath), { recursive: true });
writeFileSync(targetPath, `${JSON.stringify(buildInfo, null, 2)}\n`, 'utf8');
console.log(`Build info written to ${targetPath}: ${buildInfo.version}`);
