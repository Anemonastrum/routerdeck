import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const roots = ['server.js', 'src', 'public', 'scripts'];
const files = [];

function collect(entry) {
  const stat = statSync(entry);
  if (stat.isDirectory()) {
    for (const name of readdirSync(entry)) collect(path.join(entry, name));
    return;
  }
  if (/\.(?:js|mjs)$/.test(entry)) files.push(entry);
}

for (const root of roots) collect(root);

let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) failed = true;
}

const moduleFiles = files.filter(file => file === 'server.js' || file.startsWith(`src${path.sep}`));
for (const file of moduleFiles) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const specifier = match[1];
    const target = path.resolve(path.dirname(file), specifier);
    if (!existsSync(target)) {
      console.error(`Missing relative import: ${file} -> ${specifier}`);
      failed = true;
    }
  }
}

const publicSources = [
  'public/index.html',
  'public/app.js',
  'public/styles.css',
  'public/login.css',
  ...readdirSync('public/js').map(name => path.join('public/js', name)),
].filter(existsSync);

for (const file of publicSources) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/["'](\/img\/[^"'?#]+)["']/g)) {
    const target = path.join('public', match[1]);
    if (!existsSync(target)) {
      console.error(`Missing public image: ${file} -> ${match[1]}`);
      failed = true;
    }
  }
}

const requiredDirs = ['src/services', 'src/configs', 'src/db', 'src/etc', 'public/img'];
for (const dir of requiredDirs) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`Required project directory is missing: ${dir}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`Project check passed for ${files.length} JavaScript files, relative imports, public images, and required directories.`);
