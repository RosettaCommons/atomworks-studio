const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { StudioServer, serviceIsHealthy } = require('../dist/server.js');
const fixture = path.join(__dirname, 'server-fixture.cjs');
function manager(t, onExit, timeout) {
  const logs = [];
  const server = new StudioServer(message => logs.push(message), onExit, timeout);
  t.after(() => server.dispose());
  return { server, logs };
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function pidFrom(logs) {
  for (let i = 0; i < 100; i++) {
    const match = logs.join('').match(/PID=(\d+)/);
    if (match) return Number(match[1]);
    await delay(20);
  }
  throw new Error('child did not start');
}

test('concurrent Open calls reuse one backend; disposal stops only that process', async t => {
  const { server, logs } = manager(t);
  const [one, two] = await Promise.all([server.start(process.execPath,[fixture,'ready']),server.start(process.execPath,[fixture,'ready'])]);
  assert.equal(one.href, two.href);
  assert.equal((logs.join('').match(/PID=/g) ?? []).length, 1);
  assert.ok(await serviceIsHealthy(one));
  assert.equal((await server.start('unused-command')).href, one.href);
  const pid = await pidFrom(logs);
  await server.dispose();
  assert.equal(alive(pid), false);
  assert.equal(await serviceIsHealthy(one), false);
  await assert.rejects(server.start(process.execPath), /shutting down/);
});

test('missing executable fails promptly and permits a corrected retry', async t => {
  const { server } = manager(t);
  await assert.rejects(server.start(path.join(__dirname,'missing-python')), /ENOENT/);
  const url = await server.start(process.execPath,[fixture,'ready']);
  assert.ok(await serviceIsHealthy(url));
});

test('early exit reports failure and permits a corrected retry', async t => {
  const { server, logs } = manager(t);
  await assert.rejects(server.start(process.execPath,[fixture,'fail']), /Studio exited \(1\)/);
  assert.match(logs.join(''),/Missing test module/);
  assert.ok(await serviceIsHealthy(await server.start(process.execPath,[fixture,'ready'])));
});

for (const mode of ['unready','foreign']) {
  test(`${mode} service times out and the failed child is stopped`, async t => {
    const { server, logs } = manager(t, undefined, 500);
    await assert.rejects(server.start(process.execPath,[fixture,mode]), /did not become ready/);
    assert.equal(alive(await pidFrom(logs)), false);
  });
}

test('unexpected backend exit can be restarted', async t => {
  let notify;
  const exit = new Promise(resolve => { notify = resolve; });
  const { server, logs } = manager(t, notify);
  await server.start(process.execPath,[fixture,'ready']);
  const oldPid = await pidFrom(logs);
  process.kill(oldPid);
  await exit;
  logs.length = 0;
  assert.ok(await serviceIsHealthy(await server.start(process.execPath,[fixture,'ready'])));
  assert.notEqual(await pidFrom(logs), oldPid);
});

test('window closes during startup without leaving a child running', async t => {
  const { server, logs } = manager(t);
  const pending = assert.rejects(server.start(process.execPath,[fixture,'unready']), /shutting down|Studio exited/);
  const pid = await pidFrom(logs);
  await server.dispose();
  await pending;
  assert.equal(alive(pid), false);
});
