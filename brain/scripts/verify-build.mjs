// Static production verification for this dependency-free PWA. Brain ships its
// source modules directly; this script validates the deployable app shell rather
// than creating a misleading bundled artifact.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const required = [
  'index.html', 'manifest.webmanifest', 'sw.js', 'css/app.css',
  'js/app.js', 'js/caps.js', 'js/install.js', 'js/notify.js',
  'js/actions/external.js', 'js/actions/system.js',
  'js/store/db.js', 'js/store/store.js', 'js/store/validate.js', 'js/store/migrate.js',
  'js/engine/actions.js', 'js/engine/context.js', 'js/engine/intent.js', 'js/engine/search.js',
  'js/ui/cards.js', 'js/util/constants.js', 'js/util/date.js', 'js/util/util.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'
];

const failures = [];
for (const file of required) if (!fs.existsSync(path.join(root, file))) failures.push(`Missing production asset: ${file}`);
for (const file of required.filter(file => file.endsWith('.js'))) {
  const checked = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
  if (checked.status !== 0) failures.push(`Syntax failure in ${file}: ${checked.stderr || checked.stdout}`);
}
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
if (!html.includes('js/app.js') || !html.includes('manifest.webmanifest')) failures.push('The app shell must reference its module entry point and manifest.');
const worker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
for (const module of required.filter(file => file.startsWith('js/'))) {
  if (!worker.includes(`./${module}`)) failures.push(`Service worker does not precache ${module}.`);
}
if (!worker.includes('notificationclick')) failures.push('Service worker must handle genuine notification interactions.');
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`Production app shell verified (${required.length} required assets).`);
