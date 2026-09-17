import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
const exec = promisify(execFile)
const executable = process.env.CLI_EXECUTABLE && path.resolve(process.env.CLI_EXECUTABLE)

// This suite runs the downloaded-style executable on each release OS, without Node in its PATH.
test('the standalone executable checks access, uploads attachments, exports a plan and reports failures', { skip: !executable }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'testspot-native-'))
  const requests = []
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer tp_test')
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    requests.push({ url: req.url, method: req.method, body: Buffer.concat(chunks).toString() })
    res.setHeader('content-type', 'application/json')
    if (req.url.endsWith('/selectors')) res.end(JSON.stringify({ items: [{ name: 'One', selector: 'suite.one' }] }))
    else if (req.url.endsWith('/attachments/batch')) res.end(JSON.stringify({ stored: 1, skipped: false }))
    else if (req.url.endsWith('/results')) res.end(JSON.stringify({ total: 1, passed: 1 }))
    else res.end(JSON.stringify({ id: 'launch', name: 'Example', status: 'running' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }) })
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TESTSPOT_|TESTPILOT_|BUN_|ALLURE_|PATH$)/i.test(key)))
  Object.assign(env, { PATH: '', TESTSPOT_URL: `http://127.0.0.1:${server.address().port}`, TESTSPOT_TOKEN: 'tp_test', TESTSPOT_PROJECT: '1', TESTSPOT_LAUNCH_ID: 'launch' })
  const run = (args, extra = {}) => exec(executable, args, { cwd: dir, env: { ...env, ...extra } })
  const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
  assert.equal((await run(['--version'])).stdout.trim(), `testspot ${version}`)
  assert.match((await run(['--help'])).stdout, /upload/)
  assert.match((await run(['doctor'])).stderr, /connection OK/)
  await writeFile(path.join(dir, 'one-result.json'), JSON.stringify({ uuid: 'one', historyId: 'one', name: 'One', fullName: 'suite.one', status: 'passed', attachments: [{ name: 'screen', source: 'screen.txt', type: 'text/plain' }] }))
  await writeFile(path.join(dir, 'screen.txt'), 'screenshot fixture')
  await run(['upload', dir, '--no-finish', '--output-file', 'summary.json'])
  assert.ok(requests.some(r => r.url.endsWith('/attachments/batch') && r.body.includes('allure-results.zip')))
  assert.ok(!requests.some(r => r.method === 'PATCH'))
  assert.equal(JSON.parse(await readFile(path.join(dir, 'summary.json'), 'utf8')).reportingFailed, false)
  await run(['plan', '--format', 'allure', '--output-file', 'testplan.json'])
  assert.equal(JSON.parse(await readFile(path.join(dir, 'testplan.json'), 'utf8')).tests[0].selector, 'suite.one')
  await run(['finish'])
  assert.ok(requests.some(r => r.method === 'PATCH' && JSON.parse(r.body).action === 'finish'))
  // A real child command, supplied by absolute path, still runs when reporting is unconfigured.
  // The CLI itself has no Node dependency: Node is only this test's portable example runner.
  await assert.rejects(run(['run', '--', process.execPath, '-e', 'process.exit(7)'], { TESTSPOT_URL: '' }), e => e.code === 7)
  await assert.rejects(run(['upload', path.join(dir, 'missing')]), e => e.code === 1)
})


test('the released executable uploads results without following environment.properties outside the report', { skip: !executable }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'testspot-native-security-'))
  const dir = path.join(root, 'results')
  await mkdir(dir)
  const secret = path.join(root, 'synthetic.properties')
  await writeFile(secret, 'SYNTHETIC_SECRET=must-not-upload\n')
  await symlink(secret, path.join(dir, 'environment.properties'), 'file')
  await writeFile(path.join(dir, 'one-result.json'), JSON.stringify({ uuid: 'one', name: 'One', fullName: 'suite.one', status: 'passed' }))
  const payloads = []
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString()
    if (req.url.endsWith('/results')) payloads.push(JSON.parse(body))
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url.endsWith('/results') ? { accepted: 1, total: 1, passed: 1 } : { id: 'launch', status: 'running' }))
  })
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TESTSPOT_|TESTPILOT_|BUN_|ALLURE_|PATH$)/i.test(key)))
  Object.assign(env, { PATH: '', TESTSPOT_URL: `http://127.0.0.1:${server.address().port}`, TESTSPOT_TOKEN: 'tp_test', TESTSPOT_PROJECT: '1', TESTSPOT_LAUNCH_ID: 'launch' })
  await exec(executable, ['upload', dir, '--no-finish'], { cwd: root, env })
  assert.ok(payloads.some(body => body.results?.length === 1), 'the report itself must still upload')
  for (const body of payloads) assert.deepEqual(body.envPairs ?? [], [], 'outside values must never enter a results request')
})
