import { afterEach, describe, expect, it, vi } from 'vitest'
import { board, type Middleware } from '../src/server/index.ts'
import { vercel } from '../src/backend-vercel/index.default.ts'
import { conformance } from '../src/conformance/index.ts'
import type { Caller } from '../src/server/backend.ts'
import { block } from '../src/contract/blocks.ts'
import { vb } from '../src/cli/embedded.ts'
import { as, fakeMessageboard } from './messageboard.ts'

// Tasks on Vercel's board: vercel()'s task methods on the fake API's task routes, through the handle.

const API = 'http://localhost'
type Api = ReturnType<typeof fakeMessageboard>
type Sent = { method: string; version: number; path: string; query: Record<string, string[]>; body: Record<string, any> | undefined }

/**
 * A handle on the fake's board through vercel(), as `principal`, and every request it sent the API: its version, and
 * its path under the board. `can` narrows it with `x-board-can`, as a proxy that holds its credential does.
 */
function handleOn(api: Api, principal = 'user:u_jb', { answered: hook, can }: { can?: string | (() => string | undefined); answered?: (request: Sent, response: Response) => Response | Promise<Response> } = {}) {
  const sent: Sent[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const query: Record<string, string[]> = {}
    for (const [name, value] of url.searchParams) if (name !== 'teamId') (query[name] ??= []).push(value)
    const asked: Sent = {
      method: request.method,
      version: Number(/^\/v(\d+)\//.exec(url.pathname)?.[1]),
      path: url.pathname.replace(/^\/v\d+\/messageboard\/boards\/[^/]+/, ''),
      query,
      body: request.method === 'GET' ? undefined : ((await request.clone().json().catch(() => undefined)) as Sent['body']),
    }
    sent.push(asked)
    // As it was sent, its headers among it: who it's from beside its credentials. `answered` sees what came back, and may lose it.
    // In init, where as() reads them: a Request's own headers it would drop.
    const headers = new Headers(init?.headers)
    const narrowed = typeof can === 'function' ? can() : can
    if (narrowed !== undefined) headers.set('x-board-can', narrowed)
    const answered = as(api, principal)(input, { ...init, headers }).then((response) => (hook ? hook(asked, response) : response))
    // A request its caller stops ends there, as fetch ends one: the fake goes on with what it was sent.
    const stopped = new Promise<never>((_, reject) => request.signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), { once: true }))
    return Promise.race([answered, stopped])
  }
  const handle = board({ backend: vercel({ team: 'team_test', api: API, fetch, files: api.files }) })
  /** The last write it sent: a read of names or channels may follow it. */
  const wrote = () => sent.filter((request) => request.method !== 'GET').at(-1)!
  return Object.assign(handle, { sent, wrote, fetchAs: fetch })
}

const threadOf = (id: string) => `thr_${/^msg_(.+)_1$/.exec(id)![1]}`
/** An operation ID as the API takes one, a UUIDv7 made at `at`: its first 48 bits are that time, which the API reads. */
const operationAt = (at = Date.now()) => {
  const time = Math.floor(at).toString(16).padStart(12, '0')
  const rest = crypto.randomUUID().replaceAll('-', '')
  return `${time.slice(0, 8)}-${time.slice(8)}-7${rest.slice(13, 16)}-a${rest.slice(17, 20)}-${rest.slice(20)}`
}
/** When an operation ID says it was made. */
const madeAt = (operationId: string) => Number.parseInt(operationId.replaceAll('-', '').slice(0, 12), 16)
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const JULIAN = 'vercel:user:u_jb'
const ADA = 'vercel:user:u_ada'
const MINUTE = 60_000

afterEach(() => {
  vi.useRealTimers()
})

describe("vercel()'s tasks", () => {
  it("passes the conformance kit's tasks on Vercel's API, as a person and as a deployment", async () => {
    const statuses = async (principal: string) => {
      const handle = handleOn(fakeMessageboard(), principal)
      const report = await conformance(handle)
      // Whatever it asked of a task went to the API's task routes, version 2, and nothing else did: no thread route carries one.
      const tasks = handle.sent.filter((request) => /\/tasks?(\/|$)/.test(request.path) || request.body?.task !== undefined || 'task' in request.query)
      expect(tasks.length).toBeGreaterThan(50)
      expect(tasks.filter((request) => !(request.version === 2 && /^\/tasks(\/|$)/.test(request.path)))).toEqual([])
      expect(handle.sent.filter((request) => request.version !== 1 && !tasks.includes(request))).toEqual([])
      return Object.fromEntries(report.checks.filter((check) => check.group === 'tasks').map((check) => [check.name, check.detail === null || check.status === 'passed' ? check.status : `${check.status}: ${check.detail}`]))
    }
    const kept = {
      'starts a thread as a task, or makes one of a thread that was there: it reads as its thread, and board.task finds it': 'passed',
      'makes a task once for a client ID, and none under an ID a reply or a plain thread landed with': 'passed',
      'gives a task to one of the claims that race for it, and takes its result': 'passed',
      'gives a claim the lease it asks for, up to 5 minutes, and says when it ends': 'passed',
      "fences what a claim does: once it's over, its writes are lost and change nothing": 'passed',
      'holds a task until the tasks it needs complete, which a failed or canceled one never does': 'passed',
      'refuses a prerequisite that was canceled, which can never complete, and takes one that failed': 'passed',
      'lists the tasks that wait for one in the channel a list names, or its subtree, and no other': 'passed',
      'lists the last active tasks with latest, wherever they come in the order they were made': 'passed',
      'says task.ready each time a task that needs others becomes ready: right after it is made or unblocked, once they have completed': 'passed',
      'changes what a task needs: it waits for the new ones, is ready once they have completed, and at once with none': 'passed',
      'refuses a change of needs that would make a task wait for itself, straight back or through others': 'passed',
      'changes what a task needs only while no one holds it and it has not finished': 'passed',
      'makes several tasks in one write, in the order given: each waits for the ones it names, of the batch or there already, and an id makes them once': 'passed',
      'makes none of a batch when one of its tasks can not be made, wherever it comes in it': 'passed',
      'holds a task for a person, by its owner or its claim, and gives it back when unblocked': 'passed',
      'keeps a task assigned to a profile for that actor alone': 'passed',
      // This run sends no headers of its own: the kit's run with them, in backend-vercel.test.ts, checks it.
      'lets a profile change only the tasks it made, and its principal all of them': "skipped: this run can't call the board with headers of its own",
      // This run sends no x-board-can: the kit's run with headers, in backend-vercel.test.ts, checks it.
      'takes label in its channel to claim a task: a caller narrowed to reading and posting claims none': "skipped: this run can't call the board with an x-board-can header",
      "takes read in a prerequisite's channel to wait for it: a caller narrowed out of it makes no task that needs it": "skipped: this run can't call the board with an x-board-can header",
      'claims the oldest ready task in a channel or its subtree that has the labels asked for, and waits for one': 'passed',
      'takes the higher priority first when it claims the next ready task, then the oldest, lists in that order, and lets its owner change a priority whoever holds the task': 'passed',
      'shows a feed that filters on board.task=ready a task becoming ready and being claimed, and never a token': 'passed',
      'keeps labels under board. its own: a label write or a post that sets one is refused': 'passed',
    }
    const edited = 'holds a task when anyone but its owner edits its root, which ends its claim'
    // A person runs no sync, so nothing imports the platform user whose edit the check needs.
    expect(await statuses('user:u_jb')).toEqual({ ...kept, [edited]: "skipped: this token can't register a sync here" })
    // A deployment does: its sync's platform user is a profile of its own project, and still never the task's owner.
    expect(await statuses('project:prj_pong:production')).toEqual({ ...kept, [edited]: 'passed' })
  }, 60_000)

  it("finds no task on the thread routes that carried them before: the fake API has only version 2's task routes, as the API does", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const plain = await julian.post('work', 'just a thread')
    const { task } = await julian.tasks.create('work', { text: 'a task' })
    const ask = async (method: string, path: string, body?: Record<string, unknown>) => {
      const response = await as(api, 'user:u_jb')(`${API}${path}${path.includes('?') ? '&' : '?'}teamId=team_test`, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId: operationAt(), ...body }) } : {}) })
      return [response.status, ((await response.json()) as { error?: { code: string } }).error?.code ?? null]
    }
    const v1 = '/v1/messageboard/boards/brd_test'
    const token = 'a'.repeat(43)
    // What an adapter that still asked the old way would get: nothing made, claimed, or listed.
    expect(await ask('POST', `${v1}/threads/${threadOf(plain.id)}/task`, {})).toEqual([404, 'not_found'])
    expect(await ask('POST', `${v1}/threads/${threadOf(task.id)}/task/claim`, { claimToken: token })).toEqual([404, 'not_found'])
    expect(await ask('POST', `${v1}/threads/task/claim`, { claimToken: token, channel: 'work' })).toEqual([404, 'not_found'])
    expect(await ask('POST', `${v1}/threads`, { channel: 'work', text: 'a task, the old way', task: {} })).toEqual([400, 'invalid_request'])
    expect(await ask('GET', `${v1}/threads?task=open`)).toEqual([400, 'invalid_request'])
    const { channels } = (await (await as(api, 'user:u_jb')(`${API}${v1}/channels?name=work&teamId=team_test`)).json()) as { channels: { id: string }[] }
    expect(await ask('GET', `${v1}/threads?channelId=${channels[0]!.id}&task=open`)).toEqual([400, 'invalid_request'])
    expect(await ask('GET', `${v1}/threads?channelId=${channels[0]!.id}`)).toEqual([200, null])
    // And the new routes are version 2 alone, which has nothing else.
    expect(await ask('POST', `${v1}/tasks/${threadOf(task.id)}/claim`, { claimToken: token })).toEqual([404, 'not_found'])
    expect(await ask('GET', '/v2/messageboard/boards/brd_test/threads?channelId=x')).toEqual([404, 'not_found'])
    expect(await ask('GET', '/v2/messageboard/me')).toEqual([404, 'not_found'])
    expect((await julian.thread(task.id)).message.task).toMatchObject({ state: 'ready', epoch: 0 })
    expect((await julian.tasks.list({ state: 'all' })).tasks.map((listed) => listed.message.id)).toEqual([task.id])
    expect(await ask('POST', `/v2/messageboard/boards/brd_test/tasks/${threadOf(task.id)}/claim`, { claimToken: token })).toMatchObject([200, null])
  })

  it("keeps a task assigned to a profile for its owner's principal writing as that actor, whatever another principal's ID reads like", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const { task } = await julian.tasks.create('work', { text: 'for the fixer', for: `${JULIAN}+fixer` })
    // Someone else, whose own ID is the very string the task is for.
    const other = handleOn(api, 'user:u_jb+fixer')
    expect(await other.me()).toMatchObject({ actor: `${JULIAN}+fixer`, principal: `${JULIAN}+fixer`, profile: null })
    await expect(other.tasks.claim(task.id)).rejects.toMatchObject({ status: 409, code: 'task_assigned' })
    expect(await other.tasks.claim({ channel: 'work', from: [JULIAN] })).toBeNull()
    expect((await julian.thread(task.id)).message.task).toMatchObject({ state: 'ready', epoch: 0 })
    // Its owner, as that profile, is who it's for: by its ID, or as the next one ready for it.
    const claim = await julian.as('fixer').tasks.claim({ channel: 'work' })
    expect(claim?.task).toMatchObject({ id: task.id, task: { state: 'claimed', claim: { actor: `${JULIAN}+fixer` } } })
    await claim!.release()
    expect(await julian.as('fixer').tasks.claim(task.id)).toMatchObject({ epoch: 2 })
  })

  it("holds a profile to the tasks it made, as the API does: its principal's and another profile's are refused, and its principal changes any", async () => {
    const api = fakeMessageboard()
    // A deployment manages nothing, so what it changes is what it owns.
    const pong = handleOn(api, 'project:prj_pong:production')
    const PONG = 'vercel:project:prj_pong:production'
    const fixer = pong.as('fixer')
    const reviewer = pong.as('reviewer')
    const { task: given } = await reviewer.tasks.create('work', { text: 'review the fix', for: `${PONG}+reviewer` })
    const { task: principals } = await pong.tasks.create('work', { text: "the deployment's own" })

    // Another profile of the same deployment shares its credential, and takes neither: not by giving itself the task, nor any other owner's change.
    for (const task of [given, principals]) {
      await expect(fixer.tasks.assign(task.id, `${PONG}+fixer`), task.text).rejects.toMatchObject({ status: 403, code: 'task_not_owned' })
      await expect(fixer.tasks.block(task.id, 'mine now'), task.text).rejects.toMatchObject({ status: 403, code: 'task_not_owned' })
      await expect(fixer.tasks.cancel(task.id, 'mine now'), task.text).rejects.toMatchObject({ status: 403, code: 'task_not_owned' })
    }
    await expect(fixer.tasks.claim(given.id)).rejects.toMatchObject({ status: 409, code: 'task_assigned' })
    expect((await pong.thread(given.id)).message.task).toMatchObject({ state: 'ready', for: `${PONG}+reviewer`, owner: PONG })
    // Every view of a task says which of its owner's actors made it: its create's answer, its thread, the list, and the feed.
    expect([given.task?.by, principals.task?.by]).toEqual([`${PONG}+reviewer`, PONG])
    expect((await fixer.thread(given.id)).message.task?.by).toBe(`${PONG}+reviewer`)
    expect((await pong.tasks.list({ channel: 'work' })).tasks.map((listed) => listed.message.task?.by)).toEqual([`${PONG}+reviewer`, PONG])
    expect((await pong.poll({ channel: 'work', after: '0' })).events.filter((event) => event.type === 'task.created').map((event) => event.message?.task?.by)).toEqual([`${PONG}+reviewer`, PONG])

    // The profile that made it changes it, and so does its principal, as itself.
    await reviewer.tasks.block(given.id, 'waiting on the fix')
    expect((await reviewer.tasks.unblock(given.id)).task?.state).toBe('ready')
    expect((await pong.tasks.assign(given.id, null)).task).toMatchObject({ for: null, by: `${PONG}+reviewer` })
    expect((await pong.tasks.cancel(given.id, 'not needed')).task?.state).toBe('canceled')

    // The same owner decides whose edit changes what a task says: a profile's own thread, made a task by another, is held when it edits it.
    const note = await fixer.post('work', 'bump the base image')
    await reviewer.tasks.create({ re: note.id })
    await fixer.edit(note.id, 'bump the base image to 24')
    expect((await pong.thread(note.id)).message.task).toMatchObject({ state: 'blocked', blocked: { kind: 'edited' } })
    // And one it made a task itself stays as it is.
    const own = await fixer.post('work', 'rotate the keys')
    await fixer.tasks.create({ re: own.id })
    await fixer.edit(own.id, 'rotate the signing keys')
    expect((await pong.thread(own.id)).message.task).toMatchObject({ state: 'ready', blocked: null })
  })

  it("starts a thread as a task in the post's own write, makes one of a thread that's there, and shows each as the board does", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const { task: fix } = await julian.tasks.create('work', { text: 'fix CVE-123 in acme/web', labels: { step: 'fix' } })
    const { task: review } = await julian.tasks.create('work', { text: 'review the fix', needs: [fix.id], for: `${JULIAN}+reviewer` })

    // A task is its root: its ID is the root message's, and it reads as its thread does.
    expect(fix.id).toMatch(/^msg_[0-9a-f-]{36}_1$/)
    expect(fix).toMatchObject({ channel: 'work', text: 'fix CVE-123 in acme/web', re: null, labels: { step: 'fix', 'board.task': 'ready' } })
    expect(fix.task).toEqual({ state: 'ready', owner: JULIAN, by: JULIAN, for: null, needs: [], epoch: 0, claim: null, blocked: null, result: null, reason: null, priority: 0 })
    // What it waits for is named by its root's ID, as the board names a task, where the API names its thread.
    expect(review.task).toMatchObject({ state: 'waiting', needs: [fix.id], for: `${JULIAN}+reviewer` })
    expect(review.labels['board.task']).toBe('waiting')

    // One write each, on the API's route that makes a task: the post's own fields, with what makes it a task beside them.
    const writes = julian.sent.filter((request) => request.method === 'POST')
    expect(writes.map((request) => `v${request.version} ${request.path}`)).toEqual(['v2 /tasks', 'v2 /tasks'])
    const [first, second] = writes
    expect(first!.body).toEqual({ operationId: expect.any(String), channel: 'work', text: 'fix CVE-123 in acme/web', labels: { step: 'fix' } })
    expect(second!.body).toEqual({ operationId: expect.any(String), channel: 'work', text: 'review the fix', needs: [threadOf(fix.id)], for: `${JULIAN}+reviewer` })

    // A thread that's there becomes a task as it is, named to the same route, and its maker owns it whoever wrote it.
    const ada = handleOn(api, 'user:u_ada')
    const issue = await ada.post('issues', 'export times out past 10k rows')
    const adopted = await julian.tasks.create({ re: issue.id }, { needs: [fix.id] })
    expect(julian.wrote()).toMatchObject({ method: 'POST', version: 2, path: '/tasks' })
    expect(julian.wrote().body).toEqual({ operationId: expect.any(String), threadId: threadOf(issue.id), needs: [threadOf(fix.id)] })
    expect(adopted.task).toMatchObject({ id: issue.id, text: 'export times out past 10k rows', by: { principal: ADA }, task: { state: 'waiting', owner: JULIAN, needs: [fix.id] } })
    expect((await ada.thread(issue.id)).message.task).toMatchObject({ state: 'waiting', owner: JULIAN })

    // Its replies are its thread's, and the thread list and the task list both show it.
    const reply = await julian.reply(fix.id, 'patched, running the tests')
    julian.sent.length = 0
    const listed = (await julian.tasks.list({ channel: 'work' })).tasks
    expect(listed.map((task) => [task.message.id, task.message.text, task.message.task?.state, task.replies, task.last?.id ?? null])).toEqual([
      [fix.id, 'fix CVE-123 in acme/web', 'ready', 1, reply.id],
      [review.id, 'review the fix', 'waiting', 0, null],
    ])
    // The API's list answers each task with its root: only a latest reply is read apart.
    expect(julian.sent.filter((request) => request.path.startsWith('/messages/')).map((request) => request.path)).toEqual([`/messages/${reply.id}`])
    expect((await julian.threads({ channel: 'work', label: { 'board.task': 'waiting' } })).threads.map((thread) => thread.message.id)).toEqual([review.id])
  })

  it("makes several tasks in one call to the API's batch route, which resolves their refs: in the order given, each as the board shows a task", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const done = await julian.tasks.create('work', { text: 'cut the release branch', claim: true })
    await done.claim!.complete('cut')
    const { task: frozen } = await julian.tasks.create('work', { text: 'freeze the schema' })
    julian.sent.length = 0
    const { cursor } = await julian.poll({ channel: 'work', wait: 0 })
    const made = await julian.tasks.createMany('work', [
      { key: 'review', text: 'review the fix', needs: [{ key: 'fix' }] },
      { key: 'fix', text: 'fix the export', labels: { step: 'fix' }, noSync: true },
      { text: 'announce the release', needs: [done.task.id] },
      // A need named twice is one need, as on any board.
      { text: 'ship it', needs: [done.task.id, { key: 'review' }, { key: 'fix' }, { key: 'review' }, done.task.id], for: `${JULIAN}+shipper` },
      { text: 'migrate the data', needs: [done.task.id, frozen.id] },
    ])
    const [review, fix, announce, ship, migrate] = made
    expect(made.map((root) => [root.text, root.task?.state, root.task?.needs, root.task?.for, root.channel, root.labels])).toEqual([
      ['review the fix', 'waiting', [fix!.id], null, 'work', { 'board.task': 'waiting' }],
      ['fix the export', 'ready', [], null, 'work', { step: 'fix', 'board.task': 'ready' }],
      ['announce the release', 'ready', [done.task.id], null, 'work', { 'board.task': 'ready' }],
      ['ship it', 'waiting', [done.task.id, review!.id, fix!.id], `${JULIAN}+shipper`, 'work', { 'board.task': 'waiting' }],
      ['migrate the data', 'waiting', [done.task.id, frozen.id], null, 'work', { 'board.task': 'waiting' }],
    ])
    expect(made.every((root) => /^msg_[0-9a-f-]{36}_1$/.test(root.id) && root.re === null && root.task?.owner === JULIAN)).toBe(true)
    expect([fix!.noSync, review!.noSync]).toEqual([true, false])
    // One write, to version 2's batch route: the tasks that were there by their threads, the batch's own by their refs.
    const writes = julian.sent.filter((request) => request.method === 'POST')
    expect(writes.map((request) => `v${request.version} ${request.path}`)).toEqual(['v2 /tasks/batch'])
    expect(writes[0]!.body).toEqual({
      operationId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      channel: 'work',
      tasks: [
        { key: 'review', text: 'review the fix', needs: [{ key: 'fix' }] },
        { key: 'fix', text: 'fix the export', labels: { step: 'fix' }, noSync: true },
        { text: 'announce the release', needs: [threadOf(done.task.id)] },
        { text: 'ship it', needs: [threadOf(done.task.id), { key: 'review' }, { key: 'fix' }], for: `${JULIAN}+shipper` },
        { text: 'migrate the data', needs: [threadOf(done.task.id), threadOf(frozen.id)] },
      ],
    })
    // They list in the order given, and the feed has each task's events in it: its post, what made it a task, its ready.
    expect((await julian.tasks.list({ channel: 'work' })).tasks.map((task) => task.message.id)).toEqual([frozen.id, review!.id, fix!.id, announce!.id, ship!.id, migrate!.id])
    expect((await julian.poll({ channel: 'work', after: cursor })).events.map((event) => [event.type, event.message?.id])).toEqual([
      ['message.posted', review!.id],
      ['task.created', review!.id],
      ['message.posted', fix!.id],
      ['task.created', fix!.id],
      ['message.posted', announce!.id],
      ['task.created', announce!.id],
      ['task.ready', announce!.id],
      ['message.posted', ship!.id],
      ['task.created', ship!.id],
      ['message.posted', migrate!.id],
      ['task.created', migrate!.id],
    ])
    // One of them that completes readies what waited only for it.
    await (await julian.tasks.claim(fix!.id, { lease: 60 })).complete('fixed')
    expect((await julian.thread(review!.id)).message.task?.state).toBe('ready')
    expect((await julian.thread(ship!.id)).message.task?.state).toBe('waiting')
  })

  it("sends a batch's id as the API's idempotency key, beside an operation ID that is each attempt's own and a time the API reads: a retry gets the tasks as they are now", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const plan = [{ key: 'fix', text: 'fix the export' }, { text: 'review the fix', needs: [{ key: 'fix' }] }]
    const first = await julian.tasks.createMany('work', plan, { id: 'release-42' })
    // Someone claims one of them: the same id again answers the tasks as they are now, and makes none.
    await julian.tasks.claim(first[0]!.id, { lease: 60 })
    const again = await julian.tasks.createMany('work', plan, { id: 'release-42' })
    expect(again.map((root) => [root.id, root.task?.state])).toEqual([[first[0]!.id, 'claimed'], [first[1]!.id, 'waiting']])
    expect((await julian.tasks.list({ state: 'all' })).tasks).toHaveLength(2)
    // The id went as the batch's key, both times, each with an operation ID of its own: a UUIDv7 made just now, whose
    // time the API reads. One laid out from the id would name a time it refuses.
    const batches = () => julian.sent.filter((request) => request.path === '/tasks/batch').map((request) => request.body!)
    expect(batches()[0]!.idempotencyKey).toEqual(expect.stringMatching(/^.{1,512}$/))
    expect(batches()[1]!.idempotencyKey).toBe(batches()[0]!.idempotencyKey)
    expect(batches()[1]!.operationId).not.toBe(batches()[0]!.operationId)
    for (const { operationId } of batches()) {
      expect(operationId).toMatch(UUID_V7)
      expect(Math.abs(madeAt(operationId) - Date.now())).toBeLessThan(60_000)
    }
    // The request goes the same each time, which is what the API tells a repeat by: the channel by its name, and each task's fields as given.
    expect(batches()[1]).toEqual({ ...batches()[0], operationId: batches()[1]!.operationId })
    expect(batches()[0]).toMatchObject({ channel: 'work', tasks: [{ key: 'fix', text: 'fix the export' }, { text: 'review the fix', needs: [{ key: 'fix' }] }] })
    // Another id is another key, and a batch without one has none: the same plan again is new tasks.
    await julian.tasks.createMany('work', plan, { id: 'release-43' })
    await julian.tasks.createMany('work', plan)
    await julian.tasks.createMany('work', plan)
    expect(batches().slice(2).map((body) => typeof body.idempotencyKey)).toEqual(['string', 'undefined', 'undefined'])
    expect(batches()[2]!.idempotencyKey).not.toBe(batches()[0]!.idempotencyKey)
    expect((await julian.tasks.list({ state: 'all' })).tasks).toHaveLength(8)
    // The API's word for a key sent again with another request is a board's for an id used twice: other tasks, as many
    // or not, the same ones in another order, and another channel.
    const other: Parameters<typeof julian.tasks.createMany>[1][] = [
      [{ key: 'fix', text: 'fix the import' }, plan[1]!],
      [plan[0]!, { ...plan[1]!, labels: { step: 'review' } }],
      [plan[0]!, { text: 'review the fix' }],
      [{ ...plan[0]!, noSync: true }, plan[1]!],
      [{ ...plan[0]!, for: `${JULIAN}+fixer` }, plan[1]!],
      [...plan, { text: 'and one more' }],
      [plan[0]!],
      [plan[1]!, plan[0]!],
    ]
    for (const tasks of other) await expect(julian.tasks.createMany('work', tasks, { id: 'release-42' }), JSON.stringify(tasks)).rejects.toMatchObject({ status: 409, code: 'duplicate_id' })
    await expect(julian.tasks.createMany('elsewhere', plan, { id: 'release-42' })).rejects.toMatchObject({ status: 409, code: 'duplicate_id' })
    // A field left out is its empty value: the same request, written out in full.
    const full = [{ key: 'fix', text: 'fix the export', labels: {}, noSync: false, attachments: [], needs: [], for: null }, { text: 'review the fix', needs: [{ key: 'fix' }], labels: {} }]
    expect((await julian.tasks.createMany('work', full, { id: 'release-42' })).map((root) => root.id)).toEqual(first.map((root) => root.id))
    expect((await julian.tasks.list({ state: 'all' })).tasks).toHaveLength(8)
    // A key is its caller's: someone else's batch under the same id is their own.
    const ada = handleOn(api, 'user:u_ada')
    expect((await ada.tasks.createMany('work', plan, { id: 'release-42' })).map((root) => root.id)).not.toEqual(first.map((root) => root.id))
    // A key takes one of the items a write holds: 14 plain tasks fit with one and 15 without, and a chain of 12 and of 13.
    const plain = (count: number) => Array.from({ length: count }, (_, n) => ({ text: `step ${n}` }))
    const chain = (count: number) => Array.from({ length: count }, (_, n) => ({ key: `step-${n}`, text: `step ${n}`, ...(n > 0 ? { needs: [{ key: `step-${n - 1}` }] } : {}) }))
    await expect(julian.tasks.createMany('plans', plain(15), { id: 'fifteen' })).rejects.toMatchObject({ status: 400, code: 'batch_too_large' })
    await expect(julian.tasks.createMany('plans', chain(13), { id: 'thirteen' })).rejects.toMatchObject({ status: 400, code: 'batch_too_large' })
    expect(await julian.tasks.createMany('plans', plain(14), { id: 'fourteen' })).toHaveLength(14)
    expect(await julian.tasks.createMany('plans', chain(12), { id: 'twelve' })).toHaveLength(12)
    expect(await julian.tasks.createMany('plans', plain(15))).toHaveLength(15)
    expect(await julian.tasks.createMany('plans', chain(13))).toHaveLength(13)
  })

  it("screens a retried batch again, where the API has no read of a batch by its key: the API tells the repeat by what the middleware made of it", async () => {
    const api = fakeMessageboard()
    const saw: string[] = []
    const how = { stamps: false }
    const screen: Middleware = async ({ write, next }) => {
      saw.push(write.text)
      await next(how.stamps ? { labels: { seen: String(saw.length) } } : { text: write.text.replace('ASAP', 'soon') })
    }
    const team = board({ backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'user:u_jb'), files: api.files }), middleware: [screen] })
    const plan = [{ key: 'fix', text: 'fix the export ASAP' }, { text: 'review the fix', needs: [{ key: 'fix' }] }]
    const first = await team.tasks.createMany('work', plan, { id: 'release-42' })
    expect(first.map((root) => root.text)).toEqual(['fix the export soon', 'review the fix'])
    // A middleware that makes the same of the same request: the retry goes through it once more, and gets its tasks.
    expect((await team.tasks.createMany('work', plan, { id: 'release-42' })).map((root) => root.id)).toEqual(first.map((root) => root.id))
    expect(saw).toEqual(['fix the export ASAP', 'review the fix', 'fix the export ASAP', 'review the fix'])
    // One that isn't the same twice sends the API another request under the key, which it refuses. A local board
    // answers both before the middleware: on Vercel's it takes a read the API doesn't have.
    how.stamps = true
    await expect(team.tasks.createMany('work', plan, { id: 'release-42' })).rejects.toMatchObject({ status: 409, code: 'duplicate_id' })
    expect((await team.tasks.list({ state: 'all' })).tasks).toHaveLength(2)
  })

  it("refuses a write whose operation ID names no recent time, on every route that takes one, unless a receipt answers it: what the fake reads as the API does", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const { task } = await julian.tasks.create('work', { text: 'a task' })
    const root = await julian.post('work', 'a thread')
    const [thread, message] = [threadOf(task.id), threadOf(root.id)]
    const ask = async (method: string, path: string, body: Record<string, unknown>) => {
      const response = await as(api, 'user:u_jb')(`${API}${path}?teamId=team_test`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const answer = (await response.json()) as { error?: { code: string; maxAgeDays?: number; maxClockSkewSeconds?: number }; thread?: { id: string } }
      return { status: response.status, code: answer.error?.code ?? null, error: answer.error, thread: answer.thread?.id }
    }
    const [DAY, MINUTE] = [24 * 60 * 60 * 1000, 60 * 1000]
    const v1 = '/v1/messageboard/boards/brd_test'
    const v2 = '/v2/messageboard/boards/brd_test'
    const post = (operationId: string) => ask('POST', `${v1}/threads`, { operationId, channel: 'work', text: 'a post' })
    // Its shape first: a UUIDv7, lowercase. Then its time: within the last 7 days, and no more than 5 minutes ahead.
    expect((await post(crypto.randomUUID())).code).toBe('invalid_request')
    expect((await post(operationAt().toUpperCase())).code).toBe('invalid_request')
    expect(await post(operationAt(Date.now() - 7 * DAY - MINUTE))).toMatchObject({ status: 409, code: 'operation_expired_or_unknown', error: { maxAgeDays: 7, maxClockSkewSeconds: 300 } })
    expect((await post(operationAt(Date.now() + 6 * MINUTE))).code).toBe('operation_expired_or_unknown')
    expect((await post(operationAt(Date.now() - 7 * DAY + MINUTE))).status).toBe(200)
    expect((await post(operationAt(Date.now() + 4 * MINUTE))).status).toBe(200)
    // A caller's key laid out as a UUIDv7 names a time that's nowhere near: refused, as any stale one is.
    expect((await post('59a5499d-52bc-7c56-bdab-1704843d29cb')).code).toBe('operation_expired_or_unknown')
    // Every write that takes an operation ID, on both versions, before anything else about it is looked at.
    const stale = () => operationAt(Date.now() - 8 * DAY)
    for (const [method, path, body] of [
      ['POST', `${v1}/channels`, { name: 'elsewhere' }],
      ['POST', `${v1}/threads`, { channel: 'work', text: 'a post' }],
      ['POST', `${v1}/threads/${message}/messages`, { text: 'a reply' }],
      ['PATCH', `${v1}/threads/${message}/messages/1`, { text: 'edited' }],
      ['POST', `${v1}/threads/${message}/messages/1/delete`, {}],
      ['POST', `${v1}/threads/${message}/messages/1/reactions`, { emoji: 'eyes' }],
      ['POST', `${v1}/threads/${message}/messages/1/labels`, { set: { step: 'fix' } }],
      ['POST', `${v1}/schedules`, { channel: 'work', text: 'later', in: 60 }],
      ['POST', `${v1}/grants`, { principals: [], can: {} }],
      ['POST', '/v1/messageboard/boards/ensure', { name: 'security' }],
      ['POST', `${v2}/tasks`, { channel: 'work', text: 'a task' }],
      ['POST', `${v2}/tasks/batch`, { channel: 'work', tasks: [{ text: 'a task' }] }],
      ['POST', `${v2}/tasks/claim`, { channel: 'work', claimToken: 'a'.repeat(43) }],
      ['POST', `${v2}/tasks/${thread}/claim`, { claimToken: 'a'.repeat(43) }],
      ['POST', `${v2}/tasks/${thread}/needs`, { needs: [] }],
      ['POST', `${v2}/tasks/${thread}/cancel`, { reason: 'no' }],
    ] as const)
      expect([method, path, (await ask(method, path, { operationId: stale(), ...body })).code], `${method} ${path}`).toEqual([method, path, 'operation_expired_or_unknown'])
    // None of them wrote anything.
    expect((await julian.thread(root.id)).message).toMatchObject({ text: 'a thread', labels: {}, deleted: false })
    expect((await julian.thread(task.id)).message.task).toMatchObject({ state: 'ready', epoch: 0 })
    expect((await julian.channels()).channels.map((channel) => channel.path)).toEqual(['general', 'work'])
    // A retry finds its receipt for 8 days, however old its ID has grown: then the ID is past the 7 a new write may be.
    const kept = operationAt()
    const landed = await post(kept)
    vi.setSystemTime(Date.now() + 7 * DAY + 12 * 60 * MINUTE)
    expect(await post(kept)).toMatchObject({ status: 200, thread: landed.thread })
    vi.setSystemTime(Date.now() + DAY)
    expect((await post(kept)).code).toBe('operation_expired_or_unknown')
    // Its own writes go on landing: each carries the time it's made at.
    expect((await julian.post('work', 'eight days on')).text).toBe('eight days on')
  })

  it("makes none of a batch the API refuses, and says why in a board's codes: how its tasks wait, what it would wait for, and more than one write holds", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const { task: canceled } = await julian.tasks.create('work', { text: 'an idea we dropped' })
    await julian.tasks.cancel(canceled.id, 'dropped')
    const note = await julian.post('work', 'just a note')
    const reply = await julian.reply(note.id, 'a reply')
    const fine = [{ key: 'a', text: 'first, and fine' }, { text: 'second, and fine', needs: [{ key: 'a' }] }]
    const refused = (last: Parameters<typeof julian.tasks.createMany>[1], status: number, code: string) =>
      expect(julian.tasks.createMany('plans', [...fine, ...last]), JSON.stringify(last)).rejects.toMatchObject({ status, code })
    await refused([{ text: 'waits for no one here', needs: [{ key: 'nobody' }] }], 400, 'invalid_needs')
    await refused([{ key: 'a', text: 'a second a' }], 400, 'invalid_needs')
    await refused([{ key: 'self', text: 'waits for itself', needs: [{ key: 'self' }] }], 400, 'invalid_needs')
    await refused([{ key: 'x', text: 'x', needs: [{ key: 'y' }] }, { key: 'y', text: 'y', needs: [{ key: 'x' }] }], 400, 'invalid_needs')
    await refused([{ text: 'waits for a canceled one', needs: [canceled.id] }], 400, 'invalid_needs')
    await refused([{ text: 'waits for a note', needs: [note.id] }], 400, 'invalid_needs')
    await refused([{ text: 'for someone else', for: `${ADA}+fixer` }], 400, 'invalid_request')
    // A reply names no task: it's refused here, and the API isn't asked.
    const asked = julian.sent.filter((request) => request.path === '/tasks/batch').length
    await refused([{ text: 'waits for a reply', needs: [reply.id] }], 400, 'invalid_needs')
    expect(julian.sent.filter((request) => request.path === '/tasks/batch')).toHaveLength(asked)
    // What one of the API's writes holds, counted from the batch alone: 15 plain tasks, and fewer with labels, files, or needs.
    const { task: there } = await julian.tasks.create('work', { text: 'a task that was there' })
    const plain = (count: number) => Array.from({ length: count }, (_, n) => ({ text: `step ${n}` }))
    const chain = (count: number) => Array.from({ length: count }, (_, n) => ({ key: `step-${n}`, text: `step ${n}`, ...(n > 0 ? { needs: [{ key: `step-${n - 1}` }] } : {}) }))
    const labeled = (count: number) => Array.from({ length: count }, (_, n) => ({ text: `step ${n}`, labels: { step: 'fix' } }))
    const waiting = (count: number) => Array.from({ length: count }, (_, n) => ({ text: `step ${n}`, needs: [there.id] }))
    const file = await julian.upload({ data: new TextEncoder().encode('the plan'), name: 'plan.txt', type: 'text/plain' })
    const over = {
      '16 plain tasks': plain(16),
      'a chain of 14': chain(14),
      '12 with a label each': labeled(12),
      '15, one with a file': [...plain(14), { text: 'with a file', attachments: [file.id] }],
      '11 that wait for one that was there, one with a label': [...waiting(10), { text: 'and a label', needs: [there.id], labels: { step: 'fix' } }],
    }
    for (const [what, tasks] of Object.entries(over))
      await expect(julian.tasks.createMany('plans', tasks), what).rejects.toMatchObject({ status: 400, code: 'batch_too_large', message: expect.stringMatching(/\d+ items/) })
    // Nothing of any of them, and not the channel they named.
    expect((await julian.tasks.list({ channel: 'plans', state: 'all' })).tasks).toEqual([])
    expect((await julian.channels()).channels.map((channel) => channel.path)).not.toContain('plans')
    const fits = {
      '15 plain tasks': plain(15),
      'a chain of 13': chain(13),
      '11 with a label each': labeled(11),
      '11 that wait for one that was there': waiting(11),
      // A task that waits for one of the batch too takes nothing for being readied with it.
      '10 that wait for it and for one of the batch': [{ key: 'a', text: 'a' }, ...Array.from({ length: 10 }, (_, n) => ({ text: `step ${n}`, needs: [there.id, { key: 'a' }] }))],
    }
    for (const [what, tasks] of Object.entries(fits)) expect(await julian.tasks.createMany('plans', tasks), what).toHaveLength(tasks.length)
    // A task's file rides on its root, as a post's does.
    const [withFile] = await julian.tasks.createMany('plans', [{ text: 'read the plan', attachments: [file] }])
    expect([julian.wrote().body!.tasks, withFile!.attachments.map((attached) => attached.name)]).toEqual([[{ text: 'read the plan', attachments: [file.id] }], ['plan.txt']])
    // More bytes than one of the API's requests holds, which long texts reach first, is the same to whoever sent it: none
    // was made, and it sends less. Six tasks of 10,000 characters fit, and seven don't.
    const long = (count: number) => Array.from({ length: count }, (_, n) => ({ text: `${n}${'x'.repeat(9999)}` }))
    julian.sent.length = 0
    await expect(julian.tasks.createMany('long', long(7))).rejects.toMatchObject({ status: 400, code: 'batch_too_large', message: expect.stringContaining('bytes') })
    expect(julian.sent.filter((request) => request.method === 'POST').map((request) => request.path)).toEqual(['/tasks/batch'])
    expect((await julian.channels()).channels.map((channel) => channel.path)).not.toContain('long')
    expect(await julian.tasks.createMany('long', long(6))).toHaveLength(6)
    // More than any batch makes is board()'s own to say: the API is never asked.
    julian.sent.length = 0
    await expect(julian.tasks.createMany('plans', plain(101))).rejects.toMatchObject({ status: 400, code: 'batch_too_large', message: expect.stringContaining('100 tasks at most') })
    expect(julian.sent.filter((request) => request.method === 'POST')).toEqual([])
  })

  it("has a batch refused in the API's own order, whatever the board checked first: its shape, what the caller may, each task, the count, and then what takes a read", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const { task: there } = await julian.tasks.create('work', { text: 'a task that was there' })
    const file = await julian.upload({ data: new TextEncoder().encode('the plan'), name: 'plan.txt', type: 'text/plain' })
    const ask = async (body: Record<string, unknown>, can?: string) => {
      const response = await as(api, 'user:u_jb')(`${API}/v2/messageboard/boards/brd_test/tasks/batch?teamId=team_test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(can !== undefined ? { 'x-board-can': can } : {}) },
        body: JSON.stringify({ operationId: operationAt(), channel: 'plans', ...body }),
      })
      const answer = (await response.json()) as { error?: { code: string; items?: number; limit?: number } }
      return [response.status, answer.error?.code ?? null, ...(answer.error?.items !== undefined ? [answer.error.items, answer.error.limit] : [])]
    }
    const plain = (count: number) => Array.from({ length: count }, (_, n) => ({ text: `step ${n}` }))
    const thread = threadOf(there.id)
    expect(await ask({ operationId: 'release-42', tasks: plain(1) })).toEqual([400, 'invalid_request'])
    // A body of more than 64 KB is refused for that, whatever else it is, and says nothing of items.
    expect(await ask({ operationId: 'release-42', tasks: Array.from({ length: 101 }, () => ({ text: 'x'.repeat(700) })) })).toEqual([413, 'entity_too_large'])
    // The body's shape, before anything else.
    for (const tasks of [
      [],
      plain(101),
      [{ text: 'x', key: '' }],
      [{ text: 'x', key: 'r'.repeat(65) }],
      [{ text: 'x', clientId: 'c1' }],
      [{ text: 'x', claim: { claimToken: 'a'.repeat(43) } }],
      [{ text: 'x', needs: [thread, thread] }],
      [{ key: 'a', text: 'a' }, { text: 'x', needs: [{ key: 'a' }, { key: 'a' }] }],
      [{ text: 'x', needs: Array.from({ length: 21 }, () => `thr_${crypto.randomUUID()}`) }],
    ])
      expect(await ask({ tasks }), JSON.stringify(tasks).slice(0, 80)).toEqual([400, 'invalid_request'])
    expect(await ask({ channelId: 'general', tasks: plain(1) })).toEqual([400, 'invalid_request'])
    // Then what the caller may, each task's own fields, how they wait for each other, the count, and only then what takes a read.
    expect(await ask({ tasks: [{ text: 'x', needs: [{ key: 'nobody' }] }] }, 'plans=read')).toEqual([403, 'forbidden'])
    expect(await ask({ tasks: [{ text: 'labeled', labels: { step: 'fix' } }] }, 'plans=read,post')).toEqual([403, 'forbidden'])
    expect(await ask({ tasks: [{ text: '   ' }, { text: 'x', needs: [{ key: 'nobody' }] }] })).toEqual([400, 'invalid_message'])
    expect(await ask({ tasks: [{ text: 'x', labels: { 'board.task': 'ready' } }] })).toEqual([400, 'reserved_label'])
    expect(await ask({ tasks: [{ text: 'x', labels: Object.fromEntries(Array.from({ length: 17 }, (_, n) => [`k${n}`, 'v'])) }] })).toEqual([400, 'too_many_labels'])
    expect(await ask({ tasks: [{ text: 'x', for: `${ADA}+fixer` }] })).toEqual([400, 'invalid_for'])
    expect(await ask({ tasks: [{ text: 'one', attachments: [file.id] }, { text: 'two', attachments: [file.id] }, { text: 'x', needs: [{ key: 'nobody' }] }] })).toEqual([400, 'invalid_attachments'])
    expect(await ask({ tasks: [...plain(16), { text: 'x', needs: [{ key: 'nobody' }] }] })).toEqual([400, 'invalid_needs'])
    const wrong = `revert this\n\n${block('git-commit@1', { sha: 'a'.repeat(40) })}`
    expect(await ask({ tasks: [...plain(15), { text: wrong }] })).toEqual([400, 'batch_too_large', 106, 100])
    expect(await ask({ tasks: [{ text: wrong }, { text: 'x', needs: [`thr_${crypto.randomUUID()}`] }] })).toEqual([400, 'invalid_block'])
    // A caller narrowed to channels hears of a task it can't read there before its blocks are looked at.
    expect(await ask({ tasks: [{ text: wrong }, { text: 'x', needs: [thread] }] }, 'plans=read,post')).toEqual([400, 'invalid_needs'])
    expect(await ask({ tasks: [{ text: 'x', needs: [`thr_${crypto.randomUUID()}`] }, { text: 'with a file', attachments: ['att_nowhere'] }] })).toEqual([400, 'invalid_needs'])
    // None of it left a task, or the channel it named.
    expect((await julian.channels()).channels.map((channel) => channel.path)).not.toContain('plans')
    // A key of the caller's own: 1 to 512 characters of anything. The same request under it, a field left out being its
    // empty value, makes nothing more; a channel named another way is another request.
    expect(await ask({ idempotencyKey: '', tasks: plain(1) })).toEqual([400, 'invalid_request'])
    expect(await ask({ idempotencyKey: 'k'.repeat(513), tasks: plain(1) })).toEqual([400, 'invalid_request'])
    const keyed = { channel: 'keyed', idempotencyKey: `release 42 / the plan ${'é'.repeat(480)}` }
    expect(await ask({ ...keyed, tasks: [{ key: 'a', text: 'a' }, { text: 'b', needs: [{ key: 'a' }] }] })).toEqual([200, null])
    expect(await ask({ ...keyed, tasks: [{ key: 'a', text: 'a', labels: {}, noSync: false, attachments: [], needs: [], for: null }, { text: 'b', needs: [{ key: 'a' }] }] })).toEqual([200, null])
    expect((await julian.tasks.list({ channel: 'keyed', state: 'all' })).tasks).toHaveLength(2)
    expect(await ask({ ...keyed, tasks: [{ key: 'a', text: 'a' }, { text: 'b' }] })).toEqual([409, 'idempotency_key_reused'])
    // The key is part of what an operation ID stands for: the operation again with another key, or with none, is another body.
    const operationId = operationAt()
    const once = { operationId, channel: 'keyed', tasks: plain(1) }
    expect(await ask({ ...once, idempotencyKey: 'first' })).toEqual([200, null])
    expect(await ask({ ...once, idempotencyKey: 'first' })).toEqual([200, null])
    expect(await ask({ ...once, idempotencyKey: 'second' })).toEqual([409, 'operation_conflict'])
    expect(await ask(once)).toEqual([409, 'operation_conflict'])
    expect((await julian.tasks.list({ channel: 'keyed', state: 'all' })).tasks).toHaveLength(3)
    // A file is looked at last, once the channel a batch names is made, as for one task: a batch refused for one leaves the channel, and no task.
    expect(await ask({ channel: 'filed', tasks: [{ text: 'with a file', attachments: ['att_nowhere'] }] })).toEqual([404, 'attachment_not_found'])
    expect((await julian.channels()).channels.map((channel) => channel.path)).toContain('filed')
    expect((await julian.tasks.list({ channel: 'filed', state: 'all' })).tasks).toEqual([])
    expect(await ask({ tasks: plain(15) })).toEqual([200, null])
  })

  it("gives a caller that may post but not read its batch back as what it asked for, when a retry answers each task's ID alone", async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    // It waits only for what it reads, as anyone: a task that was there, in a channel it does.
    const { task: there } = await pong.tasks.create('work', { text: 'a task that was there' })
    const answers: Promise<{ tasks: Record<string, unknown>[] }>[] = []
    const blind = handleOn(api, 'project:prj_pong:production', {
      can: 'intake=post;work=read',
      answered: (request, response) => {
        if (request.path === '/tasks/batch') answers.push(response.clone().json())
        return response
      },
    })
    const plan = [
      { text: 'write it up', needs: [{ key: 'triage' }, there.id], noSync: true },
      { key: 'triage', text: 'triage the outage', for: 'vercel:project:prj_pong:production+triager' },
    ]
    const first = await blind.tasks.createMany('intake', plan, { id: 'outage-1' })
    const [writeUp, triage] = first
    expect(first.map((root) => [root.text, root.task?.state, root.task?.needs])).toEqual([
      ['write it up', 'waiting', [there.id, triage!.id]],
      ['triage the outage', 'ready', []],
    ])
    // Someone claims one of them: the retry isn't told, and gets its tasks as it made them.
    await pong.as('triager').tasks.claim(triage!.id, { lease: 60 })
    const again = await blind.tasks.createMany('intake', plan, { id: 'outage-1' })
    expect(again.map((root) => [root.id, root.channel, root.text, root.labels, root.task])).toEqual([
      [writeUp!.id, 'intake', 'write it up', { 'board.task': 'waiting' }, expect.objectContaining({ state: 'waiting', needs: [there.id, triage!.id], for: null, owner: 'vercel:project:prj_pong:production', claim: null })],
      [triage!.id, 'intake', 'triage the outage', { 'board.task': 'ready' }, expect.objectContaining({ state: 'ready', needs: [], for: 'vercel:project:prj_pong:production+triager', claim: null })],
    ])
    expect(again.map((root) => root.noSync)).toEqual([true, false])
    // What the API answered: the tasks whole to the call that made them, and their IDs alone to the retry.
    const [whole, alone] = await Promise.all(answers)
    expect(whole!.tasks.map((task) => [task.id, typeof task.message])).toEqual([[threadOf(writeUp!.id), 'object'], [threadOf(triage!.id), 'object']])
    expect(alone).toEqual({ tasks: [{ id: threadOf(writeUp!.id) }, { id: threadOf(triage!.id) }] })
    expect((await pong.tasks.list({ channel: 'intake', state: 'all' })).tasks).toHaveLength(2)
  })

  it("shows a task's state on its thread in a channel's thread list, whether the API lists threads with their messages or each is read by ID", async () => {
    for (const inlineThreadMessages of [true, false]) {
      const api = fakeMessageboard({ inlineThreadMessages })
      const julian = handleOn(api)
      const plain = await julian.post('work', 'just a thread')
      const { task, claim } = await julian.tasks.create('work', { text: 'fix CVE-123 in acme/web', claim: true })
      const reply = await julian.reply(task.id, 'on it')
      julian.sent.length = 0
      const { threads } = await julian.threads({ channel: 'work' })
      const byId = julian.sent.filter((request) => request.path.startsWith('/messages/')).length
      expect([inlineThreadMessages, byId]).toEqual([inlineThreadMessages, inlineThreadMessages ? 0 : 3])
      const shown = threads.map((thread) => [thread.message.id, thread.message.task?.state ?? null, thread.message.labels['board.task'] ?? null, thread.last?.id ?? null])
      expect(shown.sort()).toEqual([[plain.id, null, null, null], [task.id, 'claimed', 'claimed', reply.id]].sort())
      expect(threads.find((thread) => thread.message.id === task.id)!.message.task).toMatchObject({ owner: JULIAN, epoch: claim!.epoch, claim: { actor: JULIAN, until: claim!.until } })
    }
  })

  it("names the authors on a page of tasks, and of their latest replies, in one request, on an API that takes its time", async () => {
    const api = fakeMessageboard()
    const first = await handleOn(api, 'user:u_ada').tasks.create('work', 'one')
    const second = await handleOn(api, 'user:u_bob').tasks.create('work', 'two')
    await handleOn(api, 'user:u_tom').reply(first.task.id, 'on it')
    await handleOn(api, 'user:u_kim').reply(second.task.id, 'me too')
    // Each answer comes a moment later, so what's asked apart goes out apart.
    const julian = handleOn(api, 'user:u_jb', { answered: (_request, response) => new Promise((resolve) => setTimeout(() => resolve(response), 5)) })
    const { tasks } = await julian.tasks.list({ channel: 'work' })
    expect(tasks.map((task) => [task.message.author?.handle, task.last?.author?.handle])).toEqual([['ada', 'u_tom'], ['u_bob', 'u_kim']])
    const named = julian.sent.filter((request) => request.path === '/actors').map((request) => [...(request.query.id ?? [])].sort())
    expect(named).toEqual([[ADA, 'vercel:user:u_bob', 'vercel:user:u_kim', 'vercel:user:u_tom']])
  })

  it("has a new task's blocks checked before Vercel's API is asked, which checks them itself: a task refused for one makes no channel", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const sha = 'a'.repeat(40)
    const wrong = `revert this\n\n${block('git-commit@1', { sha })}`
    // board() refuses a block that doesn't fit its schema, as a post's: the API is asked for the schema, and to write nothing.
    await expect(julian.tasks.create('reverts', { text: wrong })).rejects.toMatchObject({ status: 400, code: 'invalid_block' })
    expect(julian.sent.filter((request) => request.method !== 'GET')).toEqual([])
    // A caller of the API itself is refused the same, as a post is, before the channel it names is made.
    const ask = async (path: string, body: Record<string, unknown>) => {
      const response = await as(api, 'user:u_jb')(`${API}${path}?teamId=team_test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId: operationAt(), ...body }) })
      return [response.status, ((await response.json()) as { error?: { code: string } }).error?.code ?? null]
    }
    expect(await ask('/v2/messageboard/boards/brd_test/tasks', { channel: 'reverts', text: wrong })).toEqual([400, 'invalid_block'])
    expect(await ask('/v1/messageboard/boards/brd_test/threads', { channel: 'reverts', text: wrong })).toEqual([400, 'invalid_block'])
    expect((await julian.channels()).channels.map((channel) => channel.path)).not.toContain('reverts')
    expect((await julian.tasks.list({ state: 'all' })).tasks).toEqual([])
    // One that fits is a task, by either way in, and its root shows the block.
    const fits = `revert this\n\n${block('git-commit@1', { sha, title: 'ship the index' })}`
    expect(await ask('/v2/messageboard/boards/brd_test/tasks', { channel: 'reverts', text: fits })).toEqual([200, null])
    expect((await julian.tasks.create('reverts', { text: fits })).task).toMatchObject({ task: { state: 'ready' }, blocks: [{ schema: 'git-commit', version: 1, data: { sha, title: 'ship the index' } }] })
    expect((await julian.channels()).channels.map((channel) => channel.path)).toContain('reverts')
  })

  it("sends a new task's files with it, as a post's go, and shows them on its root", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const shot = await julian.upload({ data: new TextEncoder().encode('pixels'), name: 'failing.png', type: 'image/png' })
    const { task } = await julian.tasks.create('work', { text: 'fix the layout', attachments: [shot] })
    expect(julian.wrote()).toMatchObject({ version: 2, path: '/tasks', body: { channel: 'work', text: 'fix the layout', attachments: [shot.id] } })
    expect(task).toMatchObject({ text: 'fix the layout', attachments: [{ id: shot.id, name: 'failing.png' }], task: { state: 'ready' } })
    expect((await julian.thread(task.id)).message.attachments.map((attached) => attached.id)).toEqual([shot.id])
    // Its text may be empty when it has one, and a task without files sends none.
    const log = await julian.upload({ data: new TextEncoder().encode('log'), name: 'build.log', type: 'text/plain' })
    expect((await julian.tasks.create('work', { text: '', attachments: [log.id] })).task).toMatchObject({ text: '', attachments: [{ id: log.id }] })
    await julian.tasks.create('work', { text: 'no files' })
    expect(julian.wrote().body).not.toHaveProperty('attachments')
    // A thread made a task keeps what it had.
    const trace = await julian.upload({ data: new TextEncoder().encode('trace'), name: 'trace.txt', type: 'text/plain' })
    const posted = await julian.post('work', { text: 'the worker crashes on start', attachments: [trace] })
    expect((await julian.tasks.create({ re: posted.id })).task.attachments.map((attached) => attached.id)).toEqual([trace.id])
  })

  it("sends a task's priority to the API, changes it on the API's route, and has a claim of the next and a list by priority take the higher first", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const start = (await julian.poll({ channel: 'work' })).cursor
    const { task: low } = await julian.tasks.create('work', { text: 'tidy the readme' })
    expect(julian.wrote().body).not.toHaveProperty('priority')
    const { task: high } = await julian.tasks.create('work', { text: 'fix the outage', priority: 2 })
    expect(julian.wrote().body).toMatchObject({ channel: 'work', text: 'fix the outage', priority: 2 })
    expect([low.task!.priority, high.task!.priority]).toEqual([0, 2])
    const [batched] = await julian.tasks.createMany('work', [{ text: 'rotate the keys', priority: 1 }])
    expect(julian.wrote().body!.tasks).toEqual([{ text: 'rotate the keys', priority: 1 }])
    const issue = await julian.post('issues', 'export times out past 10k rows')
    expect((await julian.tasks.create({ re: issue.id }, { priority: 3 })).task.task!.priority).toBe(3)
    expect(julian.wrote().body).toMatchObject({ threadId: threadOf(issue.id), priority: 3 })
    const made = (await julian.poll({ channel: 'work', after: start })).events.find((event) => event.type === 'task.created' && event.message?.id === high.id)
    expect(made?.payload).toMatchObject({ id: high.id, priority: 2 })

    // A list by priority reads every page of the API's, which lists by when each was made.
    for (let n = 0; n < 30; n++) await julian.tasks.create('work', { text: `filler ${n}` })
    const { task: last } = await julian.tasks.create('work', { text: 'page the on-call', priority: 2 })
    julian.sent.length = 0
    expect((await julian.tasks.list({ channel: 'work', order: 'priority', limit: 3 })).tasks.map((listed) => listed.message.id)).toEqual([high.id, last.id, batched!.id])
    expect(julian.sent.filter((request) => request.method === 'GET' && request.path === '/tasks').map((request) => request.query.cursor?.[0] ?? null)).toEqual([null, '25'])

    const { cursor } = await julian.poll({ channel: 'work' })
    const lowered = await julian.tasks.priority(high.id, -1)
    expect(julian.wrote()).toMatchObject({ method: 'POST', version: 2, path: `/tasks/${threadOf(high.id)}/priority` })
    expect(julian.wrote().body).toEqual({ operationId: expect.any(String), priority: -1 })
    expect(lowered.task).toMatchObject({ state: 'ready', priority: -1 })
    const changes = (await julian.poll({ channel: 'work', after: cursor })).events.filter((event) => event.message?.id === high.id)
    expect(changes.map((event) => [event.type, event.payload])).toEqual([['task.priority_changed', { id: high.id, thread: threadOf(high.id), priority: -1, by: { actor: JULIAN, principal: JULIAN, profile: null } }]])

    // The API's claim of the next ready task goes by it: the higher first, then the oldest.
    const next = async () => (await julian.tasks.claim({ channel: 'work', lease: 60 }))?.task.id
    expect([await next(), await next(), await next()]).toEqual([last.id, batched!.id, low.id])
    // What the API refuses is a board's: someone else's task, and a finished one's.
    await expect(handleOn(api, 'project:prj_web:production').tasks.priority(high.id, 1)).rejects.toMatchObject({ status: 403, code: 'task_not_owned' })
    await (await julian.tasks.claim(high.id, { lease: 60 })).complete()
    await expect(julian.tasks.priority(high.id, 1)).rejects.toMatchObject({ status: 409, code: 'task_finished' })
  })

  it("changes what a task needs on the API's route, named by their threads, and shows the change as the board's event", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const { task: fix } = await julian.tasks.create('work', { text: 'fix it' })
    const { task: docs } = await julian.tasks.create('work', { text: 'write the advisory' })
    const { task: review } = await julian.tasks.create('work', { text: 'review it', needs: [fix.id] })
    const { cursor } = await julian.poll({ channel: 'work' })

    // One write, with the tasks it waits for now by their threads, each said once.
    const moved = await julian.tasks.needs(review.id, [docs.id, fix.id, docs.id])
    expect(julian.wrote()).toMatchObject({ method: 'POST', version: 2, path: `/tasks/${threadOf(review.id)}/needs` })
    expect(julian.wrote().body).toEqual({ operationId: expect.any(String), needs: [threadOf(docs.id), threadOf(fix.id)] })
    expect(moved).toMatchObject({ id: review.id, labels: { 'board.task': 'waiting' }, task: { state: 'waiting', needs: [docs.id, fix.id] } })
    // It's ready once they have completed, in the change itself when they already have, and at once with none.
    for (const task of [fix, docs]) await (await julian.tasks.claim(task.id, { lease: 60 })).complete()
    expect((await julian.thread(review.id)).message.task?.state).toBe('ready')
    const { task: ship } = await julian.tasks.create('work', { text: 'ship it' })
    expect((await julian.tasks.needs(review.id, [ship.id])).task).toMatchObject({ state: 'waiting', needs: [ship.id] })
    expect((await julian.tasks.needs(review.id, [fix.id])).task).toMatchObject({ state: 'ready', needs: [fix.id] })
    expect((await julian.tasks.needs(review.id, [])).task).toMatchObject({ state: 'ready', needs: [] })

    const by = { actor: JULIAN, principal: JULIAN, profile: null }
    const about = { id: review.id, thread: threadOf(review.id) }
    const changes = (await julian.poll({ channel: 'work', after: cursor })).events.filter((event) => event.message?.id === review.id)
    expect(changes.map((event) => [event.type, event.message?.task?.state, event.payload])).toEqual([
      ['task.needs_changed', 'waiting', { ...about, needs: [docs.id, fix.id], by }],
      ['task.ready', 'ready', about],
      ['task.needs_changed', 'waiting', { ...about, needs: [ship.id], by }],
      ['task.needs_changed', 'waiting', { ...about, needs: [fix.id], by }],
      ['task.ready', 'ready', about],
      ['task.needs_changed', 'ready', { ...about, needs: [], by }],
    ])
    expect(changes[0]!.actor).toMatchObject({ id: JULIAN })
    // A feed that filters on ready tasks sees one leave for what it now waits for.
    const ready = (await julian.poll({ channel: 'work', label: ['board.task=ready'], after: cursor })).events.filter((event) => event.message?.id === review.id)
    expect(ready.map((event) => event.type)).toEqual(['task.ready', 'task.needs_changed', 'task.ready', 'task.needs_changed'])

    // The same set changes nothing, and what the API refuses is a board's: a cycle, a task someone holds, a finished one, someone else's.
    const before = (await julian.poll({ channel: 'work' })).cursor
    await julian.tasks.needs(review.id, [])
    expect((await julian.poll({ channel: 'work', after: before })).events).toEqual([])
    await julian.tasks.needs(ship.id, [review.id])
    await expect(julian.tasks.needs(review.id, [ship.id])).rejects.toMatchObject({ status: 400, code: 'invalid_needs' })
    await expect(julian.tasks.needs(review.id, [review.id])).rejects.toMatchObject({ status: 400, code: 'invalid_needs' })
    const reply = await julian.reply(fix.id, 'a reply')
    const asked = julian.sent.filter((request) => request.method === 'POST').length
    await expect(julian.tasks.needs(review.id, [reply.id])).rejects.toMatchObject({ status: 400, code: 'invalid_needs' })
    await expect(julian.tasks.needs(reply.id, [])).rejects.toMatchObject({ status: 404, code: 'not_a_task' })
    expect(julian.sent.filter((request) => request.method === 'POST')).toHaveLength(asked)
    const claim = await julian.tasks.claim(review.id, { lease: 60 })
    await expect(julian.tasks.needs(review.id, [fix.id])).rejects.toMatchObject({ status: 409, code: 'task_claimed' })
    await claim.complete()
    await expect(julian.tasks.needs(review.id, [fix.id])).rejects.toMatchObject({ status: 409, code: 'task_finished' })
    await expect(handleOn(api, 'project:prj_web:production').tasks.needs(ship.id, [])).rejects.toMatchObject({ status: 403, code: 'task_not_owned' })
    // What it waited for completed meanwhile, and the change that was refused left it be.
    expect((await julian.thread(ship.id)).message.task).toMatchObject({ state: 'ready', needs: [review.id] })
  })

  it("has only what a change adds looked behind for a cycle there, so one that drops a prerequisite lands whatever the task keeps", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    // A line of 501 tasks, each waiting for the one before: more than the API walks behind a prerequisite.
    let last = (await julian.tasks.create('line', { text: 'the first' })).task
    for (let n = 1; n <= 500; n++) last = (await julian.tasks.create('line', { text: `task ${n}`, needs: [last.id] })).task
    const { task: other } = await julian.tasks.create('work', { text: 'beside the line' })
    const { task: root } = await julian.tasks.create('work', { text: 'on its own' })
    await expect(julian.tasks.needs(root.id, [last.id])).rejects.toMatchObject({ status: 400, code: 'invalid_needs' })
    // A task made waiting for the line keeps it through a change that drops another, and through one that adds one.
    const { task: made } = await julian.tasks.create('work', { text: 'made waiting for the whole line', needs: [last.id, other.id] })
    expect((await julian.tasks.needs(made.id, [last.id])).task).toMatchObject({ state: 'waiting', needs: [last.id] })
    expect((await julian.tasks.needs(made.id, [last.id, other.id])).task).toMatchObject({ state: 'waiting', needs: [last.id, other.id] })
    // What it adds is still looked behind.
    const { task: waits } = await julian.tasks.create('work', { text: 'waits for the one made', needs: [made.id] })
    await expect(julian.tasks.needs(made.id, [last.id, other.id, waits.id])).rejects.toMatchObject({ status: 400, code: 'invalid_needs' })
    // The set is checked as it's given before it's found to be the same: a kept one that was canceled since is refused.
    await julian.tasks.cancel(other.id, 'not needed')
    await expect(julian.tasks.needs(made.id, [last.id, other.id])).rejects.toMatchObject({ status: 400, code: 'invalid_needs' })
    expect((await julian.thread(made.id)).message.task).toMatchObject({ state: 'waiting', needs: [last.id, other.id] })
  }, 60_000)

  it("has no completed task's needs followed for a cycle there, so finished work behind a prerequisite is never too much to check, and a cycle through unfinished tasks is still refused", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    // A line of 511 tasks, each waiting for the one before, worked from its start to its end: more than the API walks.
    let last = (await julian.tasks.create('line', { text: 'the first' })).task
    const line = [last.id]
    for (let n = 1; n <= 510; n++) line.push((last = (await julian.tasks.create('line', { text: `task ${n}`, needs: [last.id] })).task).id)
    for (const id of line) await (await julian.tasks.claim(id, { lease: 60 })).complete()
    // A task that isn't finished waits for the end of it, and another comes to wait for that one.
    const { task: recent } = await julian.tasks.create('work', { text: 'the next release', needs: [line[510]!] })
    const { task: root } = await julian.tasks.create('work', { text: 'ship it' })
    expect((await julian.tasks.needs(root.id, [recent.id])).task).toMatchObject({ state: 'waiting', needs: [recent.id] })
    const { task: other } = await julian.tasks.create('work', { text: 'on its own' })
    expect((await julian.tasks.needs(other.id, [line[510]!])).task).toMatchObject({ state: 'ready', needs: [line[510]] })
    // A cycle through tasks that aren't finished is found past a completed prerequisite beside them.
    const { task: a } = await julian.tasks.create('work', { text: 'a' })
    const { task: b } = await julian.tasks.create('work', { text: 'b', needs: [line[510]!, a.id] })
    const { task: c } = await julian.tasks.create('work', { text: 'c', needs: [line[0]!, b.id] })
    await expect(julian.tasks.needs(a.id, [line[510]!, c.id])).rejects.toMatchObject({ status: 400, code: 'invalid_needs' })
    await expect(julian.tasks.needs(recent.id, [line[510]!, root.id])).rejects.toMatchObject({ status: 400, code: 'invalid_needs' })
    // Only a completed task's needs are left alone: a canceled one may have waited for anything.
    const { task: dropped } = await julian.tasks.create('work', { text: 'dropped while it waited', needs: [a.id] })
    const { task: behind } = await julian.tasks.create('work', { text: 'waits for the dropped one', needs: [dropped.id] })
    await julian.tasks.cancel(dropped.id, 'not needed after all')
    await expect(julian.tasks.needs(a.id, [behind.id])).rejects.toMatchObject({ status: 400, code: 'invalid_needs' })
    expect((await julian.thread(a.id)).message.task).toMatchObject({ state: 'ready', needs: [] })
  }, 120_000)

  it("has a claim whose lease ran out expire before what its task needs changes, in the change's own write", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const { task: fix } = await julian.tasks.create('work', { text: 'fix it' })
    const { task: review } = await julian.tasks.create('work', { text: 'review it' })
    await julian.as('claude').tasks.claim(review.id, { lease: 30 })
    // While its claim holds it, what it needs stays.
    await expect(julian.tasks.needs(review.id, [fix.id])).rejects.toMatchObject({ status: 409, code: 'task_claimed' })
    const { cursor } = await julian.poll({ channel: 'work' })
    vi.setSystemTime(Date.now() + 31_000)
    expect((await julian.tasks.needs(review.id, [fix.id])).task).toMatchObject({ state: 'waiting', needs: [fix.id], claim: null, epoch: 1 })
    expect((await julian.poll({ channel: 'work', after: cursor })).events.map((event) => [event.type, event.message?.task?.state, event.actor?.handle ?? null])).toEqual([
      ['task.expired', 'ready', null],
      ['task.needs_changed', 'waiting', 'julian'],
    ])
  })

  it("claims on the API's routes with a token it makes, which no view and no event ever shows", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const { task } = await julian.tasks.create('work', { text: 'migrate the table' })
    const { cursor } = await julian.poll({ channel: 'work' })
    const { cursor: everywhere } = await julian.poll({})
    const claim = await julian.as('claude').tasks.claim(task.id, { lease: 60 })

    // 32 random bytes in base64url, made here: the API keeps its hash, and takes it again on what the claim does.
    expect(claim.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const asked = julian.wrote()
    expect(asked).toMatchObject({ method: 'POST', version: 2, path: `/tasks/${threadOf(task.id)}/claim`, body: { claimToken: claim.token, leaseSeconds: 60 } })
    expect(claim).toMatchObject({ epoch: 1, task: { id: task.id, labels: { 'board.task': 'claimed' }, task: { state: 'claimed', epoch: 1 } } })
    // A claim is whose it is and when it ends: no session, as on any board.
    expect(claim.task.task?.claim).toEqual({ actor: `${JULIAN}+claude`, until: claim.until })
    expect(Date.parse(claim.until) - Date.now()).toBeGreaterThan(55_000)

    const renewed = await claim.renew(120)
    expect(julian.wrote()).toMatchObject({ path: `/tasks/${threadOf(task.id)}/renew`, body: { claimToken: claim.token, epoch: 1, leaseSeconds: 120 } })
    expect(Date.parse(renewed.until) - Date.parse(claim.until)).toBeGreaterThan(55_000)
    const done = await renewed.complete('migrated')
    expect(julian.wrote()).toMatchObject({ path: `/tasks/${threadOf(task.id)}/complete`, body: { claimToken: claim.token, epoch: 1, result: 'migrated' } })
    expect(done.task).toMatchObject({ state: 'completed', result: 'migrated', claim: null, epoch: 1 })

    // Nothing a reader gets has the token: not the thread, the list, or the feed with its bookkeeping.
    const seen = JSON.stringify([await julian.thread(task.id), await julian.tasks.list({ state: 'all' }), await julian.poll({ channel: 'work', after: cursor, all: true }), await julian.poll({ after: everywhere, all: true })])
    expect(seen).toContain('"task.claimed"')
    expect(seen).not.toContain(claim.token)
    expect(seen).not.toMatch(/"token"|claimToken/)
  })

  it("asks again with the same operation and token when a write's answer is lost on the way, so a claim that landed is the caller's", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const { task } = await julian.tasks.create('work', { text: 'migrate the table' })
    let lost = false
    const cut = handleOn(api, 'user:u_jb', {
      answered: (request, response) => {
        if (!request.path.endsWith('/claim') || lost) return response
        lost = true
        throw new TypeError('fetch failed')
      },
    })
    const claim = await cut.as('claude').tasks.claim(task.id, { lease: 60 })
    const [landed, retried] = cut.sent.filter((request) => request.path === `/tasks/${threadOf(task.id)}/claim`)
    expect(retried!.body).toMatchObject({ operationId: landed!.body!.operationId, claimToken: landed!.body!.claimToken })
    expect(claim).toMatchObject({ token: landed!.body!.claimToken, epoch: 1 })
    expect((await julian.thread(task.id)).message.task).toMatchObject({ state: 'claimed', epoch: 1 })
    await claim.complete('migrated')
  })

  it("sends a token its caller chose as the claim's, by ID and for the next ready task", async () => {
    const RUN_TOKEN = 'r'.repeat(43)
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const { task } = await julian.tasks.create('work', { text: 'migrate the table' })
    const claim = await julian.tasks.claim(task.id, { token: RUN_TOKEN })
    expect(julian.wrote()).toMatchObject({ path: `/tasks/${threadOf(task.id)}/claim`, body: { claimToken: RUN_TOKEN } })
    expect(claim.token).toBe(RUN_TOKEN)
    await julian.tasks.held(task.id, { epoch: claim.epoch, token: RUN_TOKEN }).complete('migrated')

    const { task: next } = await julian.tasks.create('work', { text: 'review it' })
    const ready = await julian.tasks.claim({ channel: 'work', token: RUN_TOKEN })
    expect(ready).toMatchObject({ token: RUN_TOKEN, task: { id: next.id } })
    expect(julian.wrote()).toMatchObject({ path: '/tasks/claim', body: { claimToken: RUN_TOKEN } })

    const { claim: madeClaim } = await julian.tasks.create('work', { text: 'ship it', claim: true, token: RUN_TOKEN })
    expect(madeClaim).toMatchObject({ token: RUN_TOKEN })
  })

  it('gets the lease the API gives: 5 minutes at most, and it asks for 15 when the caller asks for none', async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const { task } = await julian.tasks.create('work', { text: 'a long build' })
    const asked = Date.now()
    const hour = await julian.tasks.claim(task.id, { lease: 3600 })
    expect(julian.wrote().body).toMatchObject({ leaseSeconds: 3600 })
    // The claim's own word for when it ends is the API's, not what was asked.
    expect(Date.parse(hour.until) - asked).toBeGreaterThanOrEqual(5 * MINUTE)
    expect(Date.parse(hour.until) - asked).toBeLessThan(5 * MINUTE + 5000)
    expect(hour.task.task?.claim?.until).toBe(hour.until)
    await hour.release()

    const unasked = await julian.tasks.claim(task.id)
    expect(julian.wrote().body).toMatchObject({ leaseSeconds: 900 })
    expect(Date.parse(unasked.until) - Date.now()).toBeLessThan(5 * MINUTE + 5000)
    const renewed = await unasked.renew()
    expect(julian.wrote().body).toMatchObject({ leaseSeconds: 900 })
    expect(Date.parse(renewed.until) - Date.now()).toBeLessThan(5 * MINUTE + 5000)
    // A task made and claimed in one write asks the same way.
    const made = await julian.tasks.create('work', { text: 'a step of my own', claim: true, lease: 45 })
    expect(julian.wrote().body!.claim).toEqual({ claimToken: made.claim!.token, leaseSeconds: 45 })
    expect(made).toMatchObject({ task: { task: { state: 'claimed', epoch: 1 } }, claim: { epoch: 1 } })
    expect(Date.parse(made.claim!.until) - Date.now()).toBeLessThan(46_000)
    expect((await julian.tasks.held(made.task.id, made.claim!).complete()).task?.state).toBe('completed')
  })

  it("takes over a claim whose lease ran out, which nothing writes until a task request sees it, and fences the claim that lost it", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const { task } = await julian.tasks.create('work', { text: 'rotate the keys' })
    const { cursor } = await julian.poll({ channel: 'work' })
    const first = await julian.as('claude').tasks.claim(task.id, { lease: 30 })
    vi.setSystemTime(Date.now() + 31_000)

    // No timer runs there: its label still says claimed, with a lease that's over.
    const lapsed = (await julian.thread(task.id)).message
    expect(lapsed).toMatchObject({ labels: { 'board.task': 'claimed' }, task: { state: 'claimed', epoch: 1 } })
    expect(Date.parse(lapsed.task!.claim!.until)).toBeLessThan(Date.now())
    // Its own claim's writes are lost all the same, and the error says why.
    await expect(first.renew()).rejects.toMatchObject({ status: 409, code: 'claim_lost', message: expect.stringContaining('(lease_expired)') })

    const second = await julian.as('codex').tasks.claim(task.id, { lease: 60 })
    expect(second).toMatchObject({ epoch: 2, task: { task: { state: 'claimed', claim: { actor: `${JULIAN}+codex` } } } })
    await expect(first.complete('too late')).rejects.toMatchObject({ status: 409, code: 'claim_lost', message: expect.stringContaining('(epoch_changed)') })
    expect((await julian.thread(task.id)).message.task).toMatchObject({ state: 'claimed', epoch: 2, result: null })

    // The takeover wrote the expiry before its own claim, as the board's events, the expiry no one's.
    const { events } = await julian.poll({ channel: 'work', after: cursor })
    expect(events.map((event) => [event.type, event.actor?.handle ?? null])).toEqual([
      ['task.claimed', 'julian/claude'],
      ['task.expired', null],
      ['task.claimed', 'julian/codex'],
    ])
    expect(events[1]!.payload).toEqual({ id: task.id, thread: task.thread, epoch: 1 })
    expect(events[2]!.payload).toEqual({ id: task.id, thread: task.thread, epoch: 2, until: second.until, by: { actor: `${JULIAN}+codex`, principal: JULIAN, profile: 'codex' } })
  })

  it("lets its owner hold a task whose claim's lease ran out: the expiry is written first, in the hold's own write", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const { task } = await julian.tasks.create('work', { text: 'deploy to prod' })
    const claim = await julian.as('claude').tasks.claim(task.id, { lease: 30 })
    // While its claim holds it, only that claim holds it for a person.
    await expect(julian.tasks.block(task.id, 'not this week')).rejects.toMatchObject({ status: 409, code: 'task_claimed' })
    const { cursor } = await julian.poll({ channel: 'work' })
    vi.setSystemTime(Date.now() + 31_000)

    // A lease that ran out leaves the task no one's, whatever its label still says: its owner holds it.
    expect((await julian.thread(task.id)).message.labels['board.task']).toBe('claimed')
    const held = await julian.tasks.block(task.id, 'not this week', { kind: 'needs_input' })
    expect(held).toMatchObject({ labels: { 'board.task': 'blocked' }, task: { state: 'blocked', claim: null, epoch: 1, blocked: { kind: 'needs_input', reason: 'not this week' } } })
    expect(julian.wrote()).toMatchObject({ path: `/tasks/${threadOf(task.id)}/block`, body: { reason: 'not this week', kind: 'needs_input' } })
    expect(Object.keys(julian.wrote().body!).sort()).toEqual(['kind', 'operationId', 'reason'])
    const { events } = await julian.poll({ channel: 'work', after: cursor })
    expect(events.map((event) => [event.type, event.message?.task?.state, event.actor?.handle ?? null])).toEqual([
      ['task.expired', 'ready', null],
      ['task.blocked', 'blocked', 'julian'],
    ])
    await expect(claim.complete('done')).rejects.toMatchObject({ status: 409, code: 'claim_lost', message: expect.stringContaining('(not_claimed)') })

    // Deleting its root does the same before it cancels the task.
    const { task: gone } = await julian.tasks.create('work', { text: 'gone soon', claim: true, lease: 30 })
    const before = (await julian.poll({ channel: 'work' })).cursor
    vi.setSystemTime(Date.now() + 31_000)
    await julian.delete(gone.id)
    expect((await julian.poll({ channel: 'work', after: before })).events.map((event) => [event.type, event.message?.task?.state])).toEqual([
      ['message.deleted', 'canceled'],
      ['task.expired', 'ready'],
      ['task.canceled', 'canceled'],
    ])
    expect((await julian.thread(gone.id)).message.task).toMatchObject({ state: 'canceled', reason: 'deleted', claim: null })
  })

  it("lists by the state the API lists by, where a claim whose lease ran out is ready and never claimed", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const api = fakeMessageboard({ inlineTaskMessages: true })
    const julian = handleOn(api)
    const { task: held } = await julian.tasks.create('work', { text: 'held' })
    // More lapsed claims than one list writes the expiry of: the rest still read claimed, with a lease that's over.
    const lapsing: string[] = []
    for (let n = 0; n < 12; n++) lapsing.push((await julian.tasks.create('work', { text: `lapsing ${n}`, claim: true, lease: 30 })).task.id)
    vi.setSystemTime(Date.now() + 31_000)
    await julian.tasks.claim(held.id, { lease: 300 })

    const listed = async (state: 'ready' | 'claimed' | 'open') => (await julian.tasks.list({ channel: 'work', state })).tasks
    const ready = await listed('ready')
    expect(ready.map((task) => task.message.id)).toEqual(lapsing)
    // The list answers each as it is once its claim is over, though a read of the last two still says claimed.
    expect(ready.map((task) => [task.message.task!.state, task.message.task!.claim, task.message.labels['board.task']])).toEqual(lapsing.map(() => ['ready', null, 'ready']))
    const unwritten = (await julian.thread(lapsing.at(-1)!)).message
    expect(unwritten).toMatchObject({ labels: { 'board.task': 'claimed' }, task: { state: 'claimed' } })
    expect(Date.parse(unwritten.task!.claim!.until)).toBeLessThan(Date.now())
    expect((await listed('claimed')).map((task) => task.message.id)).toEqual([held.id])
    expect((await listed('open')).map((task) => task.message.id)).toEqual([held.id, ...lapsing])
    // Each state is the API's to list: it's asked for as it was asked of the board.
    const lists = julian.sent.filter((request) => request.method === 'GET' && request.path === '/tasks')
    expect(lists.map((request) => [request.version, request.query.state, request.query.channel])).toEqual(['ready', 'claimed', 'open'].map((state) => [2, [state], ['work']]))
  })

  it("fills a list's limit across the API's pages, which come back short, and reads on from its cursor", async () => {
    const api = fakeMessageboard({ inlineTaskMessages: true })
    const julian = handleOn(api)
    const ada = handleOn(api, 'user:u_ada')
    // Seven tasks under queue/ among 60 on the board: the API's list of a tree reads the board's tasks, 25 a page, and keeps the tree's.
    const made: string[] = []
    for (let n = 0; n < 60; n++) {
      if (n % 9 === 0) made.push((await (n === 27 ? ada : julian).tasks.create('queue', { text: `task ${n}`, labels: { step: n < 30 ? 'fix' : 'review' } })).task.id)
      else await julian.tasks.create('elsewhere', { text: `another ${n}` })
    }
    expect(made).toHaveLength(7)

    const first = await julian.tasks.list({ channel: 'queue/', limit: 4 })
    expect(first.tasks.map((task) => task.message.id)).toEqual(made.slice(0, 4))
    // Its first page had three: it read on for the fourth, from the API's own cursor, and no further.
    const pages = (handle = julian) => handle.sent.filter((request) => request.method === 'GET' && request.path === '/tasks')
    const readFrom = (handle = julian) => pages(handle).map((request) => [request.query.after?.[0] ?? null, request.query.cursor?.[0] ?? null])
    expect(readFrom()).toEqual([[null, null], [null, '25']])
    // Its cursor is the last task it answered: a read after it, in any process, goes on after that task's thread.
    expect(first.cursor).toBe(made[3])
    const elsewhere = handleOn(api)
    const second = await elsewhere.tasks.list({ channel: 'queue/', limit: 4, after: first.cursor })
    expect(second.tasks.map((task) => task.message.id)).toEqual(made.slice(4))
    expect(readFrom(elsewhere)).toEqual([[threadOf(made[3]!), null], [null, '53']])
    // A read that finds nothing more answers the cursor it was given, and what's made later comes after it.
    const none = await julian.tasks.list({ channel: 'queue/', limit: 4, after: second.cursor })
    expect(none).toEqual({ tasks: [], cursor: made[6] })
    const { task: later } = await julian.tasks.create('queue', { text: 'made later', labels: { step: 'review' } })
    expect((await julian.tasks.list({ channel: 'queue/', after: none.cursor })).tasks.map((task) => task.message.id)).toEqual([later.id])
    await julian.tasks.cancel(later.id, 'only to read on')
    // Any message of a task's thread reads on from it, as on any board, and what names no message is no cursor.
    const note = await julian.reply(made[4]!, 'a note')
    expect((await julian.tasks.list({ channel: 'queue', after: note.id })).tasks.map((task) => task.message.id)).toEqual(made.slice(5))
    await expect(julian.tasks.list({ channel: 'queue', after: 'nonsense' })).rejects.toMatchObject({ status: 400, code: 'invalid_cursor' })
    // A list with nothing in it answers a cursor too, which reads from the start.
    const empty = await julian.tasks.list({ channel: 'nowhere' })
    expect(empty).toEqual({ tasks: [], cursor: '0' })
    expect((await julian.tasks.list({ channel: 'queue/', after: empty.cursor, limit: 1 })).tasks.map((task) => task.message.id)).toEqual([made[0]])

    // A task that has left what the list filters by still says where the list goes on.
    const ready = await julian.tasks.list({ channel: 'queue', state: 'ready', limit: 2 })
    expect(ready.tasks.map((task) => task.message.id)).toEqual(made.slice(0, 2))
    const taken = await julian.tasks.claim(made[1]!, { lease: 60 })
    expect((await julian.tasks.list({ channel: 'queue', state: 'ready', limit: 2, after: ready.cursor })).tasks.map((task) => task.message.id)).toEqual(made.slice(2, 4))
    await taken.release()
    // The API's list reads on from a task alone: a thread that isn't one is refused there, where a local board takes any message.
    const plain = await julian.post('queue', 'not a task')
    await expect(julian.tasks.list({ channel: 'queue', after: plain.id })).rejects.toMatchObject({ status: 400, code: 'invalid_request' })

    // What the API doesn't filter by is filtered here: a root's author, a handle, and a choice of a label's values.
    const ids = async (query: Parameters<typeof julian.tasks.list>[0]) => (await julian.tasks.list({ channel: 'queue', ...query })).tasks.map((task) => task.message.id)
    expect(await ids({ by: 'ada' })).toEqual([made[3]])
    expect(await ids({ owner: 'ada' })).toEqual([made[3]])
    expect(await ids({ owner: ADA })).toEqual([made[3]])
    expect(pages().at(-1)!.query.owner).toEqual([ADA])
    expect(await ids({ label: ['step=review'] })).toEqual(made.slice(4))
    expect(pages().at(-1)!.query.label).toEqual(['step=review'])
    expect(await ids({ label: ['step=review|fix', 'board.task'] })).toEqual(made)
    expect(pages().at(-1)!.query.label).toEqual(['step', 'board.task'])
    // The tasks that wait for one, and those assigned to an actor.
    const { task: after } = await julian.tasks.create('queue', { text: 'after task 0', needs: [made[0]!], for: `${JULIAN}+fixer` })
    expect(await ids({ needs: made[0]! })).toEqual([after.id])
    expect(pages().at(-1)!.query.needs).toEqual([threadOf(made[0]!)])
    expect(await ids({ for: `${JULIAN}+fixer` })).toEqual([after.id])
    expect(await ids({ needs: 'no-such-task' })).toEqual([])
    expect((await julian.tasks.list({ channel: 'nowhere' })).tasks).toEqual([])
  })

  it("claims the next ready task there: another owner's only when from names them by ID, under a prefix, as far as the API looks", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const ada = handleOn(api, 'user:u_ada')
    const { task: theirs } = await ada.tasks.create('work/web', { text: "ada's fix", labels: { step: 'fix' } })
    const { task: mine } = await julian.tasks.create('work/api', { text: 'my fix', labels: { step: 'fix' } })
    const { task: review } = await julian.tasks.create('work', { text: 'a review', labels: { step: 'review' } })

    // A handle names no owner, on any board: it's refused here, and the API isn't asked.
    const before = julian.sent.length
    await expect(julian.tasks.claim({ channel: 'work/', from: ['ada'] })).rejects.toMatchObject({ status: 400, code: 'invalid_from' })
    expect(julian.sent).toHaveLength(before)

    // The channel alone leaves out what's under it; the prefix takes its own before anyone's it didn't name.
    expect(await julian.tasks.claim({ channel: 'work', label: { step: 'fix' } })).toBeNull()
    const own = await julian.tasks.claim({ channel: 'work/', label: { step: 'fix' }, lease: 60 })
    expect(own?.task.id).toBe(mine.id)
    expect(julian.wrote()).toMatchObject({ method: 'POST', version: 2, path: '/tasks/claim', body: { channel: 'work/', labels: { step: 'fix' }, claimToken: own!.token, leaseSeconds: 60 } })
    expect(await julian.tasks.claim({ channel: 'work/', label: { step: 'fix' } })).toBeNull()
    const taken = await julian.tasks.claim({ channel: 'work/', label: { step: 'fix' }, from: [ADA] })
    expect(taken?.task).toMatchObject({ id: theirs.id, task: { state: 'claimed', owner: ADA, claim: { actor: JULIAN } } })
    expect(julian.wrote().body).toMatchObject({ from: [ADA] })
    // The claim it answers works as any: its token is the one sent.
    expect((await taken!.complete('fixed')).task?.state).toBe('completed')
    expect((await julian.tasks.claim({ channel: 'work/' }))?.task.id).toBe(review.id)

    // Past 50 channels under a prefix, the API refuses rather than look at some: its own code, as a 400.
    for (let n = 0; n < 51; n++) await julian.post(`many/c${n}`, 'x')
    await expect(julian.tasks.claim({ channel: 'many/' })).rejects.toMatchObject({ status: 400, code: 'channel_tree_too_large' })
    // It counts the channels its caller may claim in: one held to a few of them under the prefix is looked for there.
    const { task: far } = await julian.tasks.create('many/c50', { text: 'in the last of them' })
    const few = handleOn(api, 'user:u_jb', { can: 'many/c7=read,label;many/c50=read,label' })
    expect((await few.tasks.claim({ channel: 'many/', lease: 60 }))?.task.id).toBe(far.id)
  })

  it("claims its own task from behind any number of other owners', and by its labels only among the oldest 25 it may take in each place", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const ada = handleOn(api, 'user:u_ada')
    // More of someone else's ready tasks than a look reads of one owner's, all older than the caller's own.
    for (let n = 0; n < 120; n++) await ada.tasks.create('queue', { text: `ada's ${n}` })
    const { task: mine } = await julian.tasks.create('queue', { text: 'my own, last in' })
    expect((await julian.tasks.claim({ channel: 'queue', lease: 60 }))?.task.id).toBe(mine.id)
    // They're someone else's still: it takes them only when it names their owner, oldest first.
    expect(await julian.tasks.claim({ channel: 'queue' })).toBeNull()
    expect((await julian.tasks.claim({ channel: 'queue', from: [ADA], lease: 60 }))?.task.text).toBe("ada's 0")

    // What's left to look through is its own, and only labels narrow it: the API reads the 25 oldest of an owner's in a
    // channel, so a task with the labels asked for behind those isn't found until one of them is claimed.
    for (let n = 0; n < 25; n++) await julian.tasks.create('steps', { text: `review ${n}`, labels: { step: 'review' } })
    const { task: fix } = await julian.tasks.create('steps', { text: 'fix, behind 25 reviews', labels: { step: 'fix' } })
    expect(await julian.tasks.claim({ channel: 'steps', label: { step: 'fix' } })).toBeNull()
    expect((await julian.tasks.claim({ channel: 'steps', label: { step: 'review' }, lease: 60 }))?.task.text).toBe('review 0')
    expect((await julian.tasks.claim({ channel: 'steps', label: { step: 'fix' }, lease: 60 }))?.task.id).toBe(fix.id)
    // One assigned to the caller's profile is in a place of its own, so those don't hide it either.
    const { task: given } = await julian.tasks.create('steps', { text: 'for the fixer', labels: { step: 'fix' }, for: `${JULIAN}+fixer` })
    expect((await julian.as('fixer').tasks.claim({ channel: 'steps', label: { step: 'fix' }, lease: 60 }))?.task.id).toBe(given.id)
    // And what's assigned to it goes first, before older tasks of its principal's that anyone may take.
    const { task: later } = await julian.tasks.create('steps', { text: 'for the fixer too', for: `${JULIAN}+fixer` })
    expect((await julian.as('fixer').tasks.claim({ channel: 'steps', lease: 60 }))?.task.id).toBe(later.id)
    expect((await julian.as('fixer').tasks.claim({ channel: 'steps', lease: 60 }))?.task.text).toBe('review 1')
  })

  it("is told when a claim of the next task names more channels and owners than the API looks through: 200 places", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    for (let n = 0; n < 7; n++) await julian.post(`wide/c${n}`, 'x')
    const owners = Array.from({ length: 32 }, (_, n) => `vercel:user:u_owner${n}`)
    // A place is a channel it may claim in and an owner it takes from, its own among them: 7 channels and 33 owners are 231.
    await expect(julian.tasks.claim({ channel: 'wide/', from: owners })).rejects.toMatchObject({ status: 400, code: 'claim_too_wide' })
    // Fewer owners fit, and so does less of the tree. Its own principal counts once, named or not.
    expect(await julian.tasks.claim({ channel: 'wide/', from: owners.slice(0, 27) })).toBeNull()
    expect(await julian.tasks.claim({ channel: 'wide/', from: [JULIAN, ...owners.slice(0, 27)] })).toBeNull()
    expect(await julian.tasks.claim({ channel: 'wide/c3', from: owners })).toBeNull()
    // A profile looks in one more place a channel, for what's assigned to it: 7 channels and 29 are 203.
    await expect(julian.as('fixer').tasks.claim({ channel: 'wide/', from: owners.slice(0, 27) })).rejects.toMatchObject({ status: 400, code: 'claim_too_wide' })
    expect(await julian.as('fixer').tasks.claim({ channel: 'wide/', from: owners.slice(0, 26) })).toBeNull()
    // Only the channels it may claim in count: held to two of them, every owner fits.
    const few = handleOn(api, 'user:u_jb', { can: 'wide/c1=read,label;wide/c2=read,label' })
    expect(await few.tasks.claim({ channel: 'wide/', from: owners })).toBeNull()
  })

  it("leaves a claim whose lease ran out alone when its task isn't the caller's to take: whoever may take it ends it", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const ada = handleOn(api, 'user:u_ada')
    const { task: theirs } = await ada.tasks.create('queue', { text: "ada's, held by a claim that lapses", claim: true, lease: 30 })
    const { task: mine } = await julian.tasks.create('queue', { text: 'my own, held by a claim that lapses', claim: true, lease: 30 })
    vi.setSystemTime(Date.now() + 31_000)
    const { cursor } = await julian.poll({ channel: 'queue' })
    const stored = async (id: string) => (await julian.thread(id)).message.task
    // It takes over its own, and never reads the other: its expiry isn't written.
    expect((await julian.tasks.claim({ channel: 'queue', lease: 60 }))?.task.id).toBe(mine.id)
    expect(await julian.tasks.claim({ channel: 'queue' })).toBeNull()
    expect(await stored(theirs.id)).toMatchObject({ state: 'claimed', epoch: 1 })
    expect((await julian.poll({ channel: 'queue', after: cursor })).events.map((event) => [event.type, event.message?.id])).toEqual([
      ['task.expired', mine.id],
      ['task.claimed', mine.id],
    ])
    // Someone who takes from its owner does, in the claim that takes it over.
    expect((await julian.tasks.claim({ channel: 'queue', from: [ADA], lease: 60 }))?.task.id).toBe(theirs.id)
    expect(await stored(theirs.id)).toMatchObject({ state: 'claimed', epoch: 2, claim: { actor: JULIAN } })
  })

  it("leaves a task's limits to Vercel's API: what's over one reaches it, and its refusal is the one a caller gets", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    /** What `write` is refused with, once it reached the API: the request it sent there, and the API's own words. */
    const refused = async (write: () => Promise<unknown>, path: RegExp, error: { code: string; message: string }) => {
      const before = julian.sent.length
      await expect(write()).rejects.toMatchObject({ status: 400, ...error })
      expect(julian.sent.slice(before).filter((request) => request.method === 'POST').map((request) => request.path)).toEqual([expect.stringMatching(path)])
    }
    const shape = (message: string) => ({ code: 'invalid_request', message })
    // A root's text and files, as a post's.
    await refused(() => julian.tasks.create('work', { text: 'x'.repeat(10_001) }), /^\/tasks$/, { code: 'invalid_message', message: 'A message is 1 to 10000 characters.' })
    const files = Array.from({ length: 11 }, (_, n) => `att_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`)
    await refused(() => julian.tasks.create('work', { text: 'with traces', attachments: files }), /^\/tasks$/, shape('A message carries up to 10 different attachments.'))
    // How many tasks one waits for.
    const others: string[] = []
    for (let n = 0; n < 21; n++) others.push((await julian.tasks.create('work', { text: `step ${n}` })).task.id)
    await refused(() => julian.tasks.create('work', { text: 'after them all', needs: others }), /^\/tasks$/, shape('needs is at most 20 thread IDs, with no repeats.'))
    const { task: twenty } = await julian.tasks.create('work', { text: 'after twenty', needs: others.slice(0, 20) })
    expect(twenty.task?.needs).toHaveLength(20)
    // The same when what a task waits for changes: the API takes the set, and says it's too many in its own way.
    await refused(() => julian.tasks.needs(twenty.id, others), /\/needs$/, { code: 'invalid_needs', message: 'A task waits for 20 tasks at most.' })
    expect((await julian.thread(twenty.id)).message.task?.needs).toHaveLength(20)
    // A lease, wherever one is asked for.
    const { task } = await julian.tasks.create('leases', { text: 'a long build' })
    const lease = shape('leaseSeconds is 30 to 3,600.')
    await refused(() => julian.tasks.claim(task.id, { lease: 29 }), /\/claim$/, lease)
    await refused(() => julian.tasks.claim({ channel: 'leases', lease: 3601 }), /^\/tasks\/claim$/, lease)
    await refused(() => julian.tasks.create('leases', { text: 'made and claimed', claim: true, lease: 7200 }), /^\/tasks$/, lease)
    const claim = await julian.tasks.claim(task.id, { lease: 30 })
    await refused(() => claim.renew(3601), /\/renew$/, lease)
    // A result or a reason, and a hold's kind.
    const note = 'x'.repeat(1001)
    await refused(() => claim.complete(note), /\/complete$/, shape('result is 1 to 1,000 characters, not blank.'))
    await refused(() => claim.fail(note), /\/fail$/, shape('reason is 1 to 1,000 characters, not blank.'))
    await refused(() => claim.block(note), /\/block$/, shape('reason is 1 to 1,000 characters, not blank.'))
    await refused(() => claim.block('approve the deploy?', { kind: 'k'.repeat(65) }), /\/block$/, shape('kind is up to 64 lowercase letters, numbers, and _.-'))
    await refused(() => julian.tasks.cancel(task.id, note), /\/cancel$/, shape('reason is 1 to 1,000 characters, not blank.'))
    // A batch: a task's name in it, and of each task what one made alone holds.
    const batch = /^\/tasks\/batch$/
    await refused(() => julian.tasks.createMany('work', [{ key: 'k'.repeat(65), text: 'a long name' }]), batch, shape('key is 1 to 64 characters.'))
    await refused(() => julian.tasks.createMany('work', [{ text: 'fine' }, { text: 'x'.repeat(10_001) }]), batch, { code: 'invalid_message', message: 'A message is 1 to 10000 characters.' })
    await refused(() => julian.tasks.createMany('work', [{ text: 'after them all', needs: others }]), batch, shape('needs is at most 20 task IDs or keys, each named once.'))
    await refused(() => julian.tasks.createMany('work', [{ text: 'with traces', attachments: files }]), batch, shape('A message carries up to 10 different attachments.'))
    // The owners a claim takes from.
    const owners = Array.from({ length: 33 }, (_, n) => `vercel:user:u_${n}`)
    await refused(() => julian.tasks.claim({ channel: 'leases', from: owners }), /^\/tasks\/claim$/, shape('from is at most 32 owner IDs.'))
    // None of it changed the task, and what's within the API's limits lands.
    expect((await julian.thread(task.id)).message.task).toMatchObject({ state: 'claimed', epoch: 1 })
    expect((await claim.complete('x'.repeat(1000))).task?.state).toBe('completed')
  })

  it('holds a wait as long as the API holds one request, 25 seconds, and the handle asks again until its wait runs out', async () => {
    vi.useFakeTimers()
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const { task } = await julian.tasks.create('work', { text: 'held by someone', claim: true, lease: 300 })
    // The backend's own method, asked for longer than the API holds: it asks for 25 seconds, and answers after them.
    const backend = vercel({ team: 'team_test', api: API, fetch: julian.fetchAs, files: api.files })
    board({ backend })
    const started = Date.now()
    const one = backend.claimReadyTask({ self: null, origin: { via: { kind: 'client', name: null } } } as Caller, { channel: 'work', wait: 300 }, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(26_000)
    expect(await one).toEqual({ task: null })
    expect(Date.now() - started).toBeLessThan(30_000)
    expect(julian.wrote()).toMatchObject({ path: '/tasks/claim', body: { wait: 25 } })

    // The handle asks again, each time a new operation with a token of its own, until what it was asked to wait is up.
    julian.sent.length = 0
    const waiting = julian.tasks.claim({ channel: 'work', wait: 60 })
    await vi.advanceTimersByTimeAsync(61_000)
    expect(await waiting).toBeNull()
    const asks = julian.sent.filter((request) => request.path === '/tasks/claim')
    expect(asks.map((request) => request.body!.wait)).toEqual([25, 25, 10])
    expect(new Set(asks.map((request) => request.body!.operationId)).size).toBe(3)
    expect(new Set(asks.map((request) => request.body!.claimToken)).size).toBe(3)

    // One that becomes ready while it waits is the waiter's: here, a claim whose lease runs out.
    const held = (await julian.thread(task.id)).message.task!
    const next = julian.tasks.claim({ channel: 'work', wait: 60, lease: 60 })
    await vi.advanceTimersByTimeAsync(5000)
    vi.setSystemTime(Date.parse(held.claim!.until) + 1)
    await vi.advanceTimersByTimeAsync(1000)
    expect((await next)?.task).toMatchObject({ id: task.id, task: { state: 'claimed', epoch: 2 } })
  })

  it("is answered nothing before a request's wait is up where tasks change that aren't its to take, and the handle asks again until its own wait is up", async () => {
    vi.useFakeTimers()
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const web = handleOn(api, 'project:prj_web:production')
    const asks = () => julian.sent.filter((request) => request.path === '/tasks/claim')
    /** The project's tasks, one every second and a half, for `seconds`: each wakes whoever waits there, and none is julian's to take. */
    const busy = async (seconds: number) => {
      for (let passed = 0; passed < seconds; passed += 1.5) {
        await web.tasks.create('work', { text: `the project's own, ${passed}s in` })
        await vi.advanceTimersByTimeAsync(1500)
      }
    }
    // Julian waits a minute for a review. The API looks only so many times a request, so it answers that it took
    // nothing well before the 25 seconds it was asked to wait, and the handle asks again, a new operation each time.
    const waiting = julian.tasks.claim({ channel: 'work', label: { step: 'review' }, wait: 60 })
    await busy(15)
    expect(asks().length).toBeGreaterThan(2)
    expect(asks().every((request) => request.body!.wait === 25)).toBe(true)
    expect(new Set(asks().map((request) => request.body!.operationId)).size).toBe(asks().length)
    // A review made now is the one it claims, a quarter of its minute in.
    const { task } = await julian.tasks.create('work', { text: 'review the fix', labels: { step: 'review' } })
    await vi.advanceTimersByTimeAsync(1500)
    expect((await waiting)?.task).toMatchObject({ id: task.id, task: { state: 'claimed' } })

    // With nothing of its own coming, it says so only when its own wait is up: not at the API's first answer.
    julian.sent.length = 0
    const started = Date.now()
    let answered = false
    const nothing = julian.tasks.claim({ channel: 'work', label: { step: 'deploy' }, wait: 40 }).finally(() => (answered = true))
    await busy(36)
    expect(answered).toBe(false)
    expect(asks().length).toBeGreaterThan(4)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await nothing).toBeNull()
    expect(Date.now() - started).toBeGreaterThanOrEqual(40_000)
    // What it asked for each time is what was left of its wait, 25 seconds of it at most.
    expect(asks().map((request) => request.body!.wait).every((wait, n, waits) => wait <= 25 && (n === 0 || wait <= waits[n - 1]!))).toBe(true)
    expect(asks().at(-1)!.body!.wait).toBeLessThan(10)
  })

  it("takes nothing for a caller that left while it waited, and gives back a claim that landed all the same", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const { task } = await julian.tasks.create('work', { text: 'held for now' })
    const holder = await julian.tasks.claim(task.id, { lease: 60 })
    const asks = (handle: typeof julian) => handle.sent.filter((request) => request.path === '/tasks/claim')

    // It leaves while the API waits: the API stops looking there, so the task is no one's once it's ready.
    const leaving = new AbortController()
    const waiting = julian.tasks.claim({ channel: 'work', wait: 20 }, { signal: leaving.signal })
    await new Promise((resolve) => setTimeout(resolve, 100))
    leaving.abort()
    expect(await waiting.catch(() => null)).toBeNull()
    // The same operation and token are sent once more, without the wait, for a claim that may have landed: none had.
    await vi.waitFor(() => expect(asks(julian)).toHaveLength(2))
    const [first, again] = asks(julian)
    expect(first!.body).toMatchObject({ wait: 20 })
    expect(again!.body).toEqual(Object.fromEntries(Object.entries(first!.body!).filter(([name]) => name !== 'wait')))
    await holder.release()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect((await julian.thread(task.id)).message.task).toMatchObject({ state: 'ready', claim: null, epoch: 1 })
    expect(julian.sent.filter((request) => request.path.endsWith('/release'))).toHaveLength(1)

    // A claim the API was already writing when its caller left lands, its answer lost on the way.
    const gone = new AbortController()
    let lost = false
    const cut = handleOn(api, 'user:u_jb', {
      answered: (request, response) => {
        if (request.path !== '/tasks/claim' || lost) return response
        lost = true
        gone.abort()
        throw new DOMException('This operation was aborted', 'AbortError')
      },
    })
    expect(await cut.tasks.claim({ channel: 'work', wait: 5 }, { signal: gone.signal }).catch(() => null)).toBeNull()
    // The same operation and token, sent again, answers that claim, and it's given back with its token.
    await vi.waitFor(() => expect(cut.wrote()).toMatchObject({ path: `/tasks/${threadOf(task.id)}/release` }))
    const [landed, retried] = asks(cut)
    expect(retried!.body).toMatchObject({ operationId: landed!.body!.operationId, claimToken: landed!.body!.claimToken })
    expect(cut.wrote().body).toMatchObject({ claimToken: landed!.body!.claimToken, epoch: 2 })
    await vi.waitFor(async () => expect((await julian.thread(task.id)).message.task).toMatchObject({ state: 'ready', claim: null, epoch: 2 }))

    // One the API answered as its caller left is given back too: the answer came whole, and nobody was there for it.
    const late = new AbortController()
    let answered = false
    const leaver = handleOn(api, 'user:u_jb', {
      answered: async (request, response) => {
        if (request.path !== '/tasks/claim' || answered) return response
        answered = true
        // Its caller goes just as the answer has been read whole: nothing is cut off, and nobody is there for it.
        const whole = new Response(await response.text(), { status: response.status, headers: response.headers })
        const read = whole.text.bind(whole)
        whole.text = async () => {
          const text = await read()
          late.abort()
          return text
        }
        return whole
      },
    })
    expect(await leaver.tasks.claim({ channel: 'work', wait: 5 }, { signal: late.signal }).catch(() => null)).toBeNull()
    await vi.waitFor(() => expect(leaver.wrote()).toMatchObject({ path: `/tasks/${threadOf(task.id)}/release`, body: { epoch: 3 } }))
    // It was answered, so it isn't asked again.
    expect(asks(leaver)).toHaveLength(1)
    await vi.waitFor(async () => expect((await julian.thread(task.id)).message.task).toMatchObject({ state: 'ready', claim: null, epoch: 3 }))

    // One that landed for a caller that may no longer claim there isn't answered to it: nothing comes back to release,
    // and the claim runs out with its lease.
    const left = new AbortController()
    let narrowedSince: string | undefined
    const held = handleOn(api, 'user:u_jb', {
      can: () => narrowedSince,
      answered: (request, response) => {
        if (request.path !== '/tasks/claim' || narrowedSince !== undefined) return response
        narrowedSince = 'work=read;elsewhere=read,label'
        left.abort()
        throw new DOMException('This operation was aborted', 'AbortError')
      },
    })
    expect(await held.tasks.claim({ channel: 'work', wait: 5, lease: 60 }, { signal: left.signal }).catch(() => null)).toBeNull()
    await vi.waitFor(() => expect(asks(held)).toHaveLength(2))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(held.sent.filter((request) => request.method === 'POST').map((request) => request.path)).toEqual(['/tasks/claim', '/tasks/claim'])
    expect((await julian.thread(task.id)).message.task).toMatchObject({ state: 'claimed', epoch: 4 })
  })

  it("shows each task change in the feed as the board's event, built from the task right after it, a renewal only to a read of everything", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const claude = julian.as('claude')
    const { cursor } = await julian.poll({})
    const { task: fix } = await julian.tasks.create('work', { text: 'fix it' })
    const { task: review } = await julian.tasks.create('work', { text: 'review it', needs: [fix.id], for: `${JULIAN}+reviewer` })
    const claim = await claude.tasks.claim(fix.id, { lease: 60 })
    const renewed = await claim.renew(90)
    await renewed.release()
    const again = await claude.tasks.claim(fix.id, { lease: 60 })
    await again.complete('fixed in a1b2c3')
    await julian.tasks.assign(review.id, null)
    await julian.tasks.block(review.id, 'approve?', { kind: 'awaiting_approval' })
    await julian.tasks.unblock(review.id)
    await (await claude.tasks.claim(review.id, { lease: 60 })).fail('no credentials')
    await julian.tasks.reopen(review.id)
    await julian.tasks.cancel(review.id, 'not needed')

    const about = (id: string) => ({ id, thread: threadOf(id) })
    const by = { actor: JULIAN, principal: JULIAN, profile: null }
    const agent = { actor: `${JULIAN}+claude`, principal: JULIAN, profile: 'claude' }
    const expected = [
      ['message.posted', fix.id, null],
      ['task.created', fix.id, { ...about(fix.id), needs: [], for: null, by }],
      ['message.posted', review.id, null],
      ['task.created', review.id, { ...about(review.id), needs: [fix.id], for: `${JULIAN}+reviewer`, by }],
      ['task.claimed', fix.id, { ...about(fix.id), epoch: 1, until: claim.until, by: agent }],
      ['task.renewed', fix.id, { ...about(fix.id), epoch: 1, until: renewed.until, by: agent }],
      ['task.released', fix.id, { ...about(fix.id), epoch: 1, by: agent }],
      ['task.claimed', fix.id, { ...about(fix.id), epoch: 2, until: again.until, by: agent }],
      ['task.completed', fix.id, { ...about(fix.id), epoch: 2, result: 'fixed in a1b2c3', by: agent }],
      ['task.ready', review.id, about(review.id)],
      ['task.assigned', review.id, { ...about(review.id), for: null, by }],
      ['task.blocked', review.id, { ...about(review.id), kind: 'awaiting_approval', reason: 'approve?', by }],
      // What it waited for completed while it was held: it waits again as it's unblocked, and its task.ready follows.
      ['task.unblocked', review.id, { ...about(review.id), by }],
      ['task.ready', review.id, about(review.id)],
      ['task.claimed', review.id, { ...about(review.id), epoch: 1, until: expect.any(String), by: agent }],
      ['task.failed', review.id, { ...about(review.id), epoch: 1, reason: 'no credentials', by: agent }],
      ['task.reopened', review.id, { ...about(review.id), by }],
      ['task.canceled', review.id, { ...about(review.id), reason: 'not needed', by }],
    ] as const
    const everything = (await julian.poll({ after: cursor, all: true })).events
    expect(everything.map((event) => [event.type, event.message?.id, event.type === 'message.posted' ? null : event.payload])).toEqual(expected)
    const shown = (await julian.poll({ after: cursor })).events
    expect(shown.map((event) => event.type)).toEqual(expected.map(([type]) => type).filter((type) => type !== 'task.renewed'))
    // Each carries its root as the change left it, its task and its label among it, and who did it, but for what the board did itself.
    const at = (type: string, n = 0) => everything.filter((event) => event.type === type)[n]!
    expect(at('task.claimed').message).toMatchObject({ labels: { 'board.task': 'claimed' }, task: { state: 'claimed', epoch: 1, claim: { until: claim.until } } })
    expect(at('task.completed').message).toMatchObject({ labels: { 'board.task': 'completed' }, task: { state: 'completed', result: 'fixed in a1b2c3' } })
    expect(at('task.created', 1).message).toMatchObject({ labels: { 'board.task': 'waiting' }, task: { state: 'waiting', needs: [fix.id] } })
    expect(at('task.unblocked').message).toMatchObject({ labels: { 'board.task': 'waiting' }, task: { state: 'waiting', blocked: null } })
    expect(at('task.ready', 1).message).toMatchObject({ labels: { 'board.task': 'ready' }, task: { state: 'ready' } })
    expect(at('task.claimed').actor).toMatchObject({ id: `${JULIAN}+claude`, handle: 'julian/claude' })
    expect(at('task.ready').actor).toBeUndefined()
    // A read in one task's thread gets that task's changes and no other's.
    const inThread = (await julian.poll({ re: review.id, after: cursor })).events
    expect(inThread.map((event) => [event.type, event.message?.id])).toEqual(expected.filter(([, id]) => id === review.id).map(([type, id]) => [type, id]))
  })

  it("delivers a task's change to a feed whose label filter its root matched before the change or after it", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const { task: first } = await julian.tasks.create('work', { text: 'first', labels: { step: 'fix' } })
    const { task: second } = await julian.tasks.create('work', { text: 'second', labels: { step: 'fix' }, needs: [first.id] })
    await julian.tasks.create('work', { text: 'another queue', labels: { step: 'review' } })
    for (const channel of ['work', undefined]) {
      const { cursor } = await julian.poll({ ...(channel ? { channel } : {}), label: ['step=fix', 'board.task=ready'] })
      const { task: third } = await julian.tasks.create('work', { text: 'third', labels: { step: 'fix' } })
      const { task: other } = await julian.tasks.create('work', { text: 'not this queue', labels: { step: 'review' } })
      const claim = await julian.tasks.claim(third.id, { lease: 60 })
      await claim.renew()
      await claim.fail('later')
      await julian.tasks.cancel(other.id, 'no')
      const { events } = await julian.poll({ ...(channel ? { channel } : {}), label: ['step=fix', 'board.task=ready'], after: cursor })
      // It became ready as it was made a task, and was ready before its claim and not after: both show. What fails
      // it was never ready on either side, and neither was its post, which came before it was a task.
      expect(events.map((event) => [event.type, event.message?.id]), channel ?? 'every channel').toEqual([
        ['task.created', third.id],
        ['task.claimed', third.id],
      ])
    }
    // A waiting task becoming ready is one too.
    const { cursor } = await julian.poll({ channel: 'work', label: ['board.task=ready'] })
    await (await julian.tasks.claim(first.id, { lease: 60 })).complete()
    const { events } = await julian.poll({ channel: 'work', label: ['board.task=ready'], after: cursor })
    expect(events.map((event) => [event.type, event.message?.id])).toEqual([
      ['task.claimed', first.id],
      ['task.ready', second.id],
    ])
    // Deleting a ready task's root cancels it: a feed on what it wore before the delete gets the cancel, as on any board.
    const { task: dropped } = await julian.tasks.create('work', { text: 'drop me', labels: { step: 'fix' } })
    const before = (await julian.poll({ channel: 'work', label: ['step=fix', 'board.task=ready'] })).cursor
    await julian.delete(dropped.id)
    expect((await julian.poll({ channel: 'work', label: ['step=fix', 'board.task=ready'], after: before })).events.map((event) => [event.type, event.message?.id])).toEqual([['task.canceled', dropped.id]])
    // A held task that needs others waits again once its hold is lifted: its task.ready is what shows it ready, as on any board.
    await julian.tasks.block(second.id, 'approve?')
    const held = (await julian.poll({ channel: 'work', label: ['board.task=ready'] })).cursor
    await julian.tasks.unblock(second.id)
    expect((await julian.poll({ channel: 'work', label: ['board.task=ready'], after: held })).events.map((event) => [event.type, event.message?.id])).toEqual([['task.ready', second.id]])
  })

  it("wakes a deployment's watcher with a task's change, matched on its root's labels before and after it", async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    await pong.register({ watch: { ready: { tail: 'work --label board.task=ready' } } })
    const julian = handleOn(api)
    const { task } = await julian.tasks.create('work', { text: 'fix it' })
    const claim = await julian.tasks.claim(task.id, { lease: 60 })
    await claim.renew()
    await claim.complete('done')
    const seen: string[] = []
    for (let pulled = await pong.matches({}); pulled.length > 0; pulled = await pong.matches({})) {
      for (const match of pulled) {
        expect(match.event.message?.id).toBe(task.id)
        seen.push(match.event.type)
        await pong.ack(match.id, { lease: match.lease })
      }
    }
    // Made ready, and claimed away from it: a renewal wakes no one, and neither its post nor its completion was ever ready.
    expect(seen).toEqual(['task.created', 'task.claimed'])
  })

  it("says what the API refuses in a board's codes and statuses", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const web = handleOn(api, 'project:prj_web:production')
    const plain = await julian.post('work', 'just a thread')
    const reply = await julian.reply(plain.id, 'a reply')
    const { task } = await julian.tasks.create('work', { text: 'a task' })
    const missing = 'msg_00000000-0000-4000-8000-000000000000_1'
    const proof = { epoch: 1, token: 'not-a-token-this-backend-made' }

    // A thread that isn't there is a message that isn't, as the board names what it couldn't find.
    await expect(julian.tasks.claim(missing)).rejects.toMatchObject({ status: 404, code: 'message_not_found' })
    await expect(julian.tasks.claim('nonsense')).rejects.toMatchObject({ status: 404, code: 'message_not_found' })
    await expect(julian.tasks.claim(plain.id)).rejects.toMatchObject({ status: 404, code: 'not_a_task' })
    // A reply names no task: it's refused here, where the API would look for a thread by that name.
    const before = julian.sent.filter((request) => request.method === 'POST').length
    await expect(julian.tasks.cancel(reply.id, 'no')).rejects.toMatchObject({ status: 404, code: 'not_a_task' })
    await expect(julian.tasks.create({ re: reply.id })).rejects.toMatchObject({ status: 400, code: 'invalid_request', message: expect.stringContaining(plain.id) })
    await expect(julian.tasks.create('work', { text: 'waits for a reply', needs: [reply.id] })).rejects.toMatchObject({ status: 400, code: 'invalid_needs' })
    expect(julian.sent.filter((request) => request.method === 'POST')).toHaveLength(before)

    await expect(julian.tasks.create({ re: task.id })).rejects.toMatchObject({ status: 409, code: 'already_a_task' })
    await expect(julian.tasks.create('work', { text: 'waits for a thread', needs: [plain.id] })).rejects.toMatchObject({ status: 400, code: 'invalid_needs' })
    // The API's 409 for a deleted root is a board's 400.
    const gone = await julian.post('work', 'gone soon')
    await julian.delete(gone.id)
    await expect(julian.tasks.create({ re: gone.id })).rejects.toMatchObject({ status: 400, code: 'message_deleted' })
    // An assignee that isn't one of its owner's profiles is the API's invalid_for, and a board's invalid_request.
    await expect(julian.tasks.assign(task.id, `${ADA}+fixer`)).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
    expect(julian.wrote()).toMatchObject({ path: `/tasks/${threadOf(task.id)}/assign`, body: { for: `${ADA}+fixer` } })
    await expect(julian.tasks.assign(task.id, JULIAN)).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
    await expect(julian.tasks.create('work', { text: 'for someone else', for: `${ADA}+fixer` })).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
    // Whoever neither owns it nor manages there.
    await expect(web.tasks.cancel(task.id, 'mine now')).rejects.toMatchObject({ status: 403, code: 'task_not_owned' })
    await expect(web.tasks.unblock(task.id)).rejects.toMatchObject({ status: 403, code: 'task_not_owned' })

    // A token no claim here could have is a claim that's lost, never a malformed request.
    await expect(julian.tasks.held(task.id, proof).complete()).rejects.toMatchObject({ status: 409, code: 'claim_lost', message: expect.stringContaining('(not_claimed)') })
    expect(julian.wrote().body!.claimToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const claim = await julian.tasks.claim(task.id, { lease: 60 })
    await expect(julian.tasks.held(task.id, proof).release()).rejects.toMatchObject({ status: 409, code: 'claim_lost', message: expect.stringContaining('(token_mismatch)') })
    await expect(julian.tasks.claim(task.id)).rejects.toMatchObject({ status: 409, code: 'task_claimed' })
    await expect(julian.tasks.block(task.id, 'without the claim')).rejects.toMatchObject({ status: 409, code: 'task_claimed' })
    expect((await julian.thread(task.id)).message.task).toMatchObject({ state: 'claimed', epoch: 1 })
    // Once its owner cancels it, the claim is lost, which is what its holder is told by each of its own writes.
    await julian.tasks.cancel(task.id, 'superseded')
    for (const write of [() => claim.complete('done'), () => claim.renew(), () => claim.release(), () => claim.fail('no'), () => claim.block('wait')])
      await expect(write()).rejects.toMatchObject({ status: 409, code: 'claim_lost', message: expect.stringContaining('(not_claimed)') })
    await expect(julian.tasks.claim(task.id)).rejects.toMatchObject({ status: 409, code: 'task_finished' })
    await expect(julian.tasks.cancel(task.id, 'again')).rejects.toMatchObject({ status: 409, code: 'task_finished' })
    await expect(julian.tasks.block(task.id, 'hold')).rejects.toMatchObject({ status: 409, code: 'task_finished' })
    await expect(julian.tasks.reopen(task.id)).rejects.toMatchObject({ status: 409, code: 'task_finished' })
    await expect(julian.tasks.unblock(task.id)).rejects.toMatchObject({ status: 409, code: 'task_finished' })
    const { task: waiting } = await julian.tasks.create('work', { text: 'waits', needs: [(await julian.tasks.create('work', { text: 'first' })).task.id] })
    await expect(julian.tasks.claim(waiting.id)).rejects.toMatchObject({ status: 409, code: 'task_waiting' })
    await julian.tasks.block(waiting.id, 'hold')
    await expect(julian.tasks.claim(waiting.id)).rejects.toMatchObject({ status: 409, code: 'task_blocked' })
    const { task: assigned } = await julian.tasks.create('work', { text: 'for the fixer', for: `${JULIAN}+fixer` })
    await expect(julian.tasks.claim(assigned.id)).rejects.toMatchObject({ status: 409, code: 'task_assigned' })
    // A failed task is finished until it's reopened: it has no hold to lift.
    const { task: tried, claim: trying } = await julian.tasks.create('work', { text: 'tried', claim: true })
    await julian.tasks.held(tried.id, trying!).fail('could not')
    await expect(julian.tasks.unblock(tried.id)).rejects.toMatchObject({ status: 409, code: 'task_finished' })
    expect((await julian.tasks.reopen(tried.id)).task?.state).toBe('ready')
  })

  it("answers a retried create with the task and no claim: the claim was the first request's, whose token still holds it", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const first = await julian.tasks.create('work', { text: 'deploy a1b2c3', id: 'deploy-a1b2c3', claim: true, lease: 60 })
    expect(first.claim).toMatchObject({ epoch: 1 })
    const again = await julian.tasks.create('work', { text: 'deploy a1b2c3', id: 'deploy-a1b2c3', claim: true, lease: 60 })
    expect(again.task.id).toBe(first.task.id)
    expect(again.claim).toBeUndefined()
    expect(again.task.task).toMatchObject({ state: 'claimed', epoch: 1 })
    // The API says whose the claim is: each create is one request, and nothing is written to find out.
    expect(julian.sent.filter((request) => request.method === 'POST').map((request) => request.path)).toEqual(['/tasks', '/tasks'])
    expect(Date.parse(first.claim!.until)).toBe(Date.parse(again.task.task!.claim!.until))
    expect((await julian.tasks.list({ state: 'all' })).tasks).toHaveLength(1)
    expect((await julian.tasks.held(first.task.id, first.claim!).complete('deployed')).task).toMatchObject({ state: 'completed', result: 'deployed' })
    // Without a claim, a retry is the same task too.
    const plain = await julian.tasks.create('work', { text: 'lint', id: 'lint-1' })
    expect((await julian.tasks.create('work', { text: 'lint', id: 'lint-1' })).task.id).toBe(plain.task.id)
    // An ID a post landed with that was no task's is another write's, as on any board: the post stays a post.
    const note = await julian.post('work', { id: 'note-1', text: 'a note' })
    await expect(julian.tasks.create('work', { text: 'a note', id: 'note-1' })).rejects.toMatchObject({ status: 409, code: 'duplicate_id' })
    expect((await julian.thread(note.id)).message.task).toBeUndefined()
    // So is a reply's, in a task's thread too: the create doesn't answer the thread it landed in as its task.
    await julian.reply(plain.task.id, { id: 'reply-1', text: 'linted' })
    await expect(julian.tasks.create('work', { text: 'linted', id: 'reply-1' })).rejects.toMatchObject({ status: 409, code: 'duplicate_id' })
    expect((await julian.tasks.list({ channel: 'work', state: 'all' })).tasks.map((task) => task.message.text)).toEqual(['deploy a1b2c3', 'lint'])
  })

  it("gives a caller that may post but not read its task back as what it asked for, when a retry answers its ID alone: by its ID or by its operation", async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    const { task: first } = await pong.tasks.create('work', { text: 'a task to wait for' })
    const answers: Promise<unknown>[] = []
    // The same deployment, narrowed to posting where it can't read, as a sandbox's policy narrows one.
    const blind = handleOn(api, 'project:prj_pong:production', {
      can: 'intake=post;work=read',
      answered: (request, response) => {
        if (request.method === 'POST' && request.path === '/tasks') answers.push(response.clone().json())
        return response
      },
    })
    const made = await blind.tasks.create('intake', { text: 'from a form', id: 'form-1', needs: [first.id] })
    // A retry answers the ID of the task that landed, which it can't read, and nothing else: the task is as it was made.
    const again = await blind.tasks.create('intake', { text: 'from a form', id: 'form-1', needs: [first.id] })
    expect(await answers[1]).toEqual({ task: { id: threadOf(made.task.id) } })
    expect(again.task).toMatchObject({ id: made.task.id, channel: 'intake', text: 'from a form', labels: { 'board.task': 'waiting' }, task: { state: 'waiting', owner: 'vercel:project:prj_pong:production', by: 'vercel:project:prj_pong:production', needs: [first.id], epoch: 0, claim: null } })
    expect((await pong.thread(made.task.id)).message.task).toMatchObject({ state: 'waiting', needs: [first.id] })

    // A retry of the operation itself answers the same way: the API put the create off once the task was made, the
    // same operation goes again, and only the request that made the task answers it whole.
    vi.useFakeTimers()
    const retried: Promise<unknown>[] = []
    const putOff = handleOn(api, 'project:prj_pong:production', {
      can: 'intake=post;work=read',
      answered: (request, response) => {
        if (request.method !== 'POST' || request.path !== '/tasks') return response
        if (retried.push(response.clone().json()) > 1) return response
        return Response.json({ error: { code: 'board_busy', message: 'retry shortly' } }, { status: 503, headers: { 'retry-after': '1' } })
      },
    })
    const creating = putOff.tasks.create('intake', { text: 'from another form' })
    await vi.advanceTimersByTimeAsync(1500)
    const landed = await creating
    const [asked, resent] = putOff.sent.filter((request) => request.method === 'POST' && request.path === '/tasks')
    expect(resent!.body).toEqual(asked!.body)
    expect(await Promise.all(retried)).toEqual([{ task: expect.objectContaining({ id: threadOf(landed.task.id), state: 'ready' }) }, { task: { id: threadOf(landed.task.id) } }])
    expect(landed.task).toMatchObject({ channel: 'intake', text: 'from another form', labels: { 'board.task': 'ready' }, task: { state: 'ready', owner: 'vercel:project:prj_pong:production', needs: [], epoch: 0, claim: null } })
    // One task came of it, as the deployment that reads the channel sees.
    expect((await pong.tasks.list({ channel: 'intake' })).tasks.map((task) => [task.message.id, task.message.text])).toEqual([
      [made.task.id, 'from a form'],
      [landed.task.id, 'from another form'],
    ])

    // An ID a post of its own landed with that is no task names none, for it too: it isn't answered the thread's ID as if it were one.
    vi.useRealTimers()
    await blind.post('intake', { id: 'note-1', text: 'a note' })
    await expect(blind.tasks.create('intake', { text: 'a note', id: 'note-1' })).rejects.toMatchObject({ status: 409, code: 'duplicate_id' })
    await pong.reply(made.task.id, { id: 'reply-1', text: 'noted' })
    await expect(blind.tasks.create('intake', { text: 'noted', id: 'reply-1' })).rejects.toMatchObject({ status: 409, code: 'duplicate_id' })
    expect((await pong.tasks.list({ channel: 'intake', state: 'all' })).tasks.map((task) => task.message.text)).toEqual(['from a form', 'from another form'])
  })

  it("asks the API's task routes without asking it first whether it has them: where it serves none, a task call fails with the API's own refusal", async () => {
    const api = fakeMessageboard({ tasks: false })
    const julian = handleOn(api)
    const root = await julian.post('dev', 'fix CVE-123')
    julian.sent.length = 0
    // The API's answer for a route it doesn't have, as any refusal of its comes back: its status and its code.
    const refused = { status: 404, code: 'not_found' }
    await expect(julian.tasks.list()).rejects.toMatchObject(refused)
    await expect(julian.tasks.create('dev', 'a task')).rejects.toMatchObject(refused)
    await expect(julian.tasks.claim(root.id)).rejects.toMatchObject(refused)
    await expect(julian.tasks.needs(root.id, [])).rejects.toMatchObject(refused)
    // A batch under a key of its caller's, which the API has no read of: it's asked to make it.
    await expect(julian.tasks.createMany('dev', [{ key: 'a', text: 'a task' }, { text: 'another', needs: [{ key: 'a' }] }], { id: 'once' })).rejects.toMatchObject(refused)
    // One that would wait for a task fails at once, and isn't asked again.
    await expect(julian.tasks.claim({ channel: 'dev', wait: 30 })).rejects.toMatchObject(refused)
    // Each asked its route, and nothing else was asked to find out.
    expect(julian.sent.map((request) => `${request.method} v${request.version} ${request.path}`)).toEqual(['GET v2 /tasks', 'POST v2 /tasks', `POST v2 /tasks/${threadOf(root.id)}/claim`, `POST v2 /tasks/${threadOf(root.id)}/needs`, 'POST v2 /tasks/batch', 'POST v2 /tasks/claim'])
    // Its threads read as they do on any board, and none is a task.
    expect((await julian.threads({ channel: 'dev' })).threads.map((thread) => [thread.message.id, thread.message.task])).toEqual([[root.id, undefined]])
  })

  it("leaves no dependent waiting for good when a completion stops short: a claim of one, a list that shows one, and a claim of the next that finds none go on", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const { task: first } = await julian.tasks.create('repair', { text: 'everything waits for this' })
    // More dependents than a completion readies in its own write, the last four each in a channel of its own.
    const waiting: string[] = []
    for (let n = 0; n < 19; n++) waiting.push((await julian.tasks.create(n < 15 ? 'repair' : `repair/late${n}`, { text: `dependent ${n}`, needs: [first.id] })).task.id)
    const [byClaim, byList, byNext, alongside] = waiting.slice(15) as [string, string, string, string]
    const state = async (id: string) => (await julian.thread(id)).message.task?.state
    const { cursor } = await julian.poll({ channel: 'repair/' })
    api.cutNextCompletion()
    // It answers all the same: what it didn't get to stays waiting, and nothing is retried for it.
    expect((await (await julian.tasks.claim(first.id, { lease: 60 })).complete()).task?.state).toBe('completed')
    expect(julian.sent.filter((request) => request.path.endsWith('/complete'))).toHaveLength(1)
    expect(await Promise.all(waiting.map(state))).toEqual([...Array.from({ length: 15 }, () => 'ready'), 'waiting', 'waiting', 'waiting', 'waiting'])

    // A claim of one readies and claims it in one write.
    expect(await julian.tasks.claim(byClaim, { lease: 60 })).toMatchObject({ epoch: 1, task: { task: { state: 'claimed' } } })
    // A list that reads what waits writes it as it sees it. One of what's ready reads no waiting task, so it leaves it.
    expect((await julian.tasks.list({ channel: 'repair/late16', state: 'ready' })).tasks).toEqual([])
    expect(await state(byList)).toBe('waiting')
    expect((await julian.tasks.list({ channel: 'repair/late16' })).tasks.map((task) => [task.message.id, task.message.task?.state])).toEqual([[byList, 'ready']])
    expect(await state(byList)).toBe('ready')
    // A claim of the next ready one that finds none goes on with the completion itself, wherever what waited for it
    // is, and looks again: it reads no waiting task of its own.
    expect(await state(byNext)).toBe('waiting')
    expect((await julian.tasks.claim({ channel: 'repair/late17', lease: 60 }))?.task.id).toBe(byNext)
    expect(await state(alongside)).toBe('ready')
    const repaired = (await julian.poll({ channel: 'repair/', after: cursor })).events.filter((event) => waiting.slice(15).includes(event.message?.id ?? ''))
    const changes = (id: string) => repaired.filter((event) => event.message?.id === id).map((event) => event.type)
    expect([byClaim, byList, byNext, alongside].map(changes)).toEqual([['task.ready', 'task.claimed'], ['task.ready'], ['task.ready', 'task.claimed'], ['task.ready']])
  })

  it("goes on with a completion that stopped short when a list shows it, and when the API puts it off and it's sent again", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const state = async (id: string) => (await julian.thread(id)).message.task?.state
    /** A task with 18 that wait for it, completed by a request that got to 15 of them. */
    const stoppedShort = async (channel: string, handle = julian) => {
      const { task: first } = await julian.tasks.create(channel, { text: 'everything waits for this' })
      const waiting: string[] = []
      for (let n = 0; n < 18; n++) waiting.push((await julian.tasks.create(channel, { text: `dependent ${n}`, needs: [first.id] })).task.id)
      const claim = await handle.tasks.claim(first.id, { lease: 60 })
      api.cutNextCompletion()
      return { first, waiting, claim }
    }
    const left = async (waiting: string[]) => (await Promise.all(waiting.map(state))).filter((one) => one === 'waiting').length

    // A list with the completed task on its page goes on with it: one of what's open doesn't show it.
    const listed = await stoppedShort('listed')
    await listed.claim.complete()
    expect(await left(listed.waiting)).toBe(3)
    await julian.tasks.list({ channel: 'elsewhere' })
    expect(await left(listed.waiting)).toBe(3)
    expect((await julian.tasks.list({ channel: 'listed', state: 'completed' })).tasks.map((task) => task.message.id)).toEqual([listed.first.id])
    expect(await left(listed.waiting)).toBe(0)

    // A completion the API put off once it was written goes again as the same operation, which goes on with it.
    vi.useFakeTimers()
    let putOff = false
    const retrying = handleOn(api, 'user:u_jb', {
      answered: (request, response) => {
        if (putOff || !request.path.endsWith('/complete')) return response
        putOff = true
        return Response.json({ error: { code: 'board_busy', message: 'retry shortly' } }, { status: 503, headers: { 'retry-after': '1' } })
      },
    })
    const retried = await stoppedShort('retried', retrying)
    const completing = retried.claim.complete('done')
    await vi.advanceTimersByTimeAsync(1500)
    expect((await completing).task).toMatchObject({ state: 'completed', result: 'done' })
    const [asked, resent] = retrying.sent.filter((request) => request.path.endsWith('/complete'))
    expect(resent!.body).toEqual(asked!.body)
    expect(await left(retried.waiting)).toBe(0)
  })

  it('lists the last active with latest from every page of the list, and reads the latest replies of only those it answers', async () => {
    // An API that doesn't send a task's latest reply with the list, so each is read apart: after it refuses `include`, once.
    const api = fakeMessageboard()
    const julian = handleOn(api)
    // 60 tasks, more than two of the API's pages, each with a reply: the first made is the last active.
    const made: string[] = []
    for (let n = 0; n < 60; n++) made.push((await julian.tasks.create('queue', { text: `task ${n}` })).task.id)
    for (const id of [...made.slice(1), made[0]!]) await julian.reply(id, 'progress')
    julian.sent.length = 0
    const { tasks } = await julian.tasks.list({ channel: 'queue', state: 'all', latest: true, limit: 3 })
    expect(tasks.map((task) => task.message.id)).toEqual([made[58], made[59], made[0]])
    expect(tasks.map((task) => task.last?.text)).toEqual(['progress', 'progress', 'progress'])
    // Every page of the list, and a reply read for each of the three alone.
    expect(julian.sent.filter((request) => request.method === 'GET' && request.path === '/tasks' && !request.query.include).map((request) => request.query.cursor?.[0] ?? null)).toEqual([null, '25', '50'])
    expect(julian.sent.filter((request) => request.method === 'GET' && request.path.startsWith('/messages/'))).toHaveLength(3)
    // Without it, the first made.
    expect((await julian.tasks.list({ channel: 'queue', state: 'all', limit: 3 })).tasks.map((task) => task.message.id)).toEqual(made.slice(0, 3))
    await expect(julian.tasks.list({ channel: 'queue', latest: true, after: made[0]! })).rejects.toMatchObject({ status: 400, code: 'invalid_request' })

    // On an API that sends each task's reply with the list, a latest list still doesn't ask: it would be every page's.
    const inlined = handleOn(fakeMessageboard({ inlineTaskMessages: true }))
    for (let n = 0; n < 30; n++) await inlined.reply((await inlined.tasks.create('queue', { text: `task ${n}` })).task.id, 'progress')
    inlined.sent.length = 0
    expect((await inlined.tasks.list({ channel: 'queue', state: 'all', latest: true, limit: 2 })).tasks.map((task) => task.last?.text)).toEqual(['progress', 'progress'])
    expect(inlined.sent.filter((request) => request.path === '/tasks').map((request) => request.query.include ?? null)).toEqual([null, null])
    expect(inlined.sent.filter((request) => request.path.startsWith('/messages/'))).toHaveLength(2)
  })

  it("reads each task's latest reply with the list on an API that sends it, and apart, by ID, on one that doesn't", async () => {
    for (const inlineTaskMessages of [true, false]) {
      const julian = handleOn(fakeMessageboard({ inlineTaskMessages }))
      const quiet = (await julian.tasks.create('work', { text: 'no replies' })).task.id
      const ids: string[] = []
      for (const text of ['one', 'two']) {
        const { task } = await julian.tasks.create('work', { text })
        await julian.reply(task.id, `re: ${text}`)
        ids.push(task.id)
      }
      for (let n = 0; n < 2; n++) {
        julian.sent.length = 0
        const { tasks } = await julian.tasks.list({ channel: 'work' })
        expect(tasks.map((task) => [task.message.id, task.last?.text ?? null])).toEqual([
          [quiet, null],
          [ids[0], 're: one'],
          [ids[1], 're: two'],
        ])
        const lists = julian.sent.filter((request) => request.method === 'GET' && request.path === '/tasks').map((request) => request.query.include?.[0] ?? null)
        const byId = julian.sent.filter((request) => request.path.startsWith('/messages/')).length
        // One that refuses `include` is asked it once, by the first list, and never again.
        const asked = inlineTaskMessages ? ['messages'] : n === 0 ? ['messages', null] : [null]
        expect([inlineTaskMessages, n, lists, byId]).toEqual([inlineTaskMessages, n, asked, inlineTaskMessages ? 0 : 2])
      }
      // Lists that start together, before any knows what the API takes, each answer the same.
      const fresh = handleOn(fakeMessageboard({ inlineTaskMessages }), 'user:u_jb')
      await fresh.tasks.create('work', { text: 'one' })
      const together = await Promise.all([1, 2, 3].map(() => fresh.tasks.list({ channel: 'work' })))
      expect(together.map(({ tasks }) => tasks.length)).toEqual([1, 1, 1])
    }
  })

  it("lists a caller that doesn't read the whole board only the channels it reads, with no page spent on the rest, 50 channels at most", async () => {
    const api = fakeMessageboard({ inlineTaskMessages: true })
    const pong = handleOn(api, 'project:prj_pong:production')
    // More tasks than a page in a channel it can't read, older than the three it can.
    for (let n = 0; n < 30; n++) await pong.tasks.create('secret', { text: `hidden ${n}` })
    const shown: string[] = []
    for (let n = 0; n < 3; n++) shown.push((await pong.tasks.create('work', { text: `shown ${n}` })).task.id)
    const { task: waits } = await pong.tasks.create('work/sub', { text: 'waits for a shown one', needs: [shown[0]!] })
    await pong.tasks.create('secret', { text: 'waits for it too, out of sight', needs: [shown[0]!] })
    const narrowed = handleOn(api, 'project:prj_pong:production', { can: 'work=read;work/=read' })
    const lists = () => narrowed.sent.filter((request) => request.method === 'GET' && request.path === '/tasks')

    // The board, as far as it reads it: one page, and no cursor to follow past tasks it can't see.
    expect((await narrowed.tasks.list()).tasks.map((task) => task.message.id)).toEqual([...shown, waits.id])
    expect(lists().map((request) => request.query.cursor ?? null)).toEqual([null])
    // A channel it can't read lists nothing, as a name no channel has does.
    narrowed.sent.length = 0
    expect(await narrowed.tasks.list({ channel: 'secret' })).toEqual({ tasks: [], cursor: '0' })
    expect(await narrowed.tasks.list({ channel: 'nowhere' })).toEqual({ tasks: [], cursor: '0' })
    expect(lists().map((request) => request.query.cursor ?? null)).toEqual([null, null])
    // What waits for a task is, for it, what it reads of that.
    expect((await narrowed.tasks.list({ needs: shown[0]! })).tasks.map((task) => task.message.id)).toEqual([waits.id])
    // Whoever reads the whole board has them read from under the task: one page, however many tasks come before them.
    pong.sent.length = 0
    expect((await pong.tasks.list({ needs: shown[0]! })).tasks).toHaveLength(2)
    expect(pong.sent.filter((request) => request.method === 'GET' && request.path === '/tasks')).toHaveLength(1)

    // Past 50 channels it reads, on the board or under a prefix, the API refuses rather than read some: name a channel, or less of the tree.
    for (let n = 0; n < 51; n++) await pong.tasks.create(`many/c${n}`, { text: `task ${n}` })
    const wide = handleOn(api, 'project:prj_pong:production', { can: 'many/=read' })
    await expect(wide.tasks.list({ channel: 'many/' })).rejects.toMatchObject({ status: 400, code: 'channel_tree_too_large' })
    await expect(wide.tasks.list()).rejects.toMatchObject({ status: 400, code: 'channel_tree_too_large' })
    expect((await wide.tasks.list({ channel: 'many/c7' })).tasks.map((task) => task.message.text)).toEqual(['task 7'])
    // Whoever reads the whole board lists as many as there are.
    expect((await pong.tasks.list({ channel: 'many/', limit: 100 })).tasks).toHaveLength(51)
  })
})

describe("vb's tasks on Vercel's board", () => {
  it("says the API's own refusal under what the command was doing, where the API serves no task routes", async () => {
    const api = fakeMessageboard({ tasks: false })
    const julian = handleOn(api)
    // The board's words under the command's: it failed, and nothing says the board keeps no tasks.
    expect(await vb(julian, ['tasks'])).toEqual({ code: 1, stdout: '', stderr: expect.stringMatching(/^error: Can't list tasks\.\n  [^\n]+\n$/) })
    // For a program: the API's code to branch on, and its answer in data.
    expect(JSON.parse((await vb(julian, ['tasks', 'create', 'work', 'fix it', '--json'])).stderr)).toEqual({
      status: 'error',
      reason: 'not_found',
      message: "Can't create a task in work.",
      data: { error: { code: 'not_found', message: expect.any(String), status: 404 } },
    })
    // Each command asked its route.
    expect(julian.sent.filter((request) => request.version === 2).map((request) => `${request.method} ${request.path}`)).toEqual(['GET /tasks', 'POST /tasks'])
  })

  it("says a claim of the next task names more channels and owners than the board looks through, as the board's error, with what narrows it", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    for (let n = 0; n < 7; n++) await julian.post(`wide/c${n}`, 'x')
    await julian.tasks.create('wide/c3', { text: 'fix the build' })
    await julian.tasks.create('wide/c3', { text: 'review the fix' })
    const from = (owners: number) => Array.from({ length: owners }, (_, n) => ['--from', `vercel:user:u_owner${n}`]).flat()
    // 7 channels and 33 owners, its own among them, are 231 places: said by what the command was doing, the board's words under it.
    const wide = await vb(julian, ['tasks', 'claim', '--ready', 'wide/', ...from(32)])
    expect(wide).toEqual({
      code: 1,
      stdout: '',
      stderr: expect.stringMatching(/^error: Can't claim a task in wide\/\. That's too many channels and owners\.\n  [^\n]+\n\n  Name fewer owners with --from, or a smaller subtree\n$/),
    })
    // For a program: the board's code to branch on, and its own answer in data.
    expect(JSON.parse((await vb(julian, ['tasks', 'claim', '--ready', 'wide/', ...from(32), '--json'])).stderr)).toEqual({
      status: 'error',
      reason: 'claim_too_wide',
      message: "Can't claim a task in wide/. That's too many channels and owners.",
      hint: 'Name fewer owners with --from, or a smaller subtree',
      data: { error: { code: 'claim_too_wide', message: expect.any(String), status: 400 } },
    })
    // Each way out it names claims: fewer owners, then less of the tree.
    expect(await vb(julian, ['tasks', 'claim', '--ready', 'wide/', ...from(27)])).toMatchObject({ code: 0, stdout: expect.stringMatching(/fix the build\n$/), stderr: '' })
    expect(await vb(julian, ['tasks', 'claim', '--ready', 'wide/c3', ...from(32)])).toMatchObject({ code: 0, stdout: expect.stringMatching(/review the fix\n$/), stderr: '' })
  })

  it("says a subtree has more channels than the board reads for a claim of the next task or a list, with what narrows it", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    for (let n = 0; n < 51; n++) await julian.tasks.create(`many/c${n}`, { text: `task ${n}` })
    const refused = (doing: string) => ({
      code: 1,
      stdout: '',
      stderr: expect.stringMatching(new RegExp(`^error: Can't ${doing}\\. That's too many channels\\.\\n  [^\\n]+\\n\\n  Name a channel, or a smaller subtree\\n$`)),
    })
    // More than 50 channels it may claim in under the prefix.
    expect(await vb(julian, ['tasks', 'claim', '--ready', 'many/'])).toEqual(refused('claim a task in many/'))
    expect(await vb(julian, ['tasks', 'claim', '--ready', 'many/c7'])).toMatchObject({ code: 0, stdout: expect.stringMatching(/task 7\n$/) })
    // A caller that doesn't read the whole board lists 50 channels at most, on the board or under a prefix.
    const narrowed = handleOn(api, 'user:u_jb', { can: 'many/=read' })
    expect(await vb(narrowed, ['tasks', 'many/'])).toEqual(refused('list tasks in many/'))
    expect(await vb(narrowed, ['tasks'])).toEqual(refused('list tasks'))
    expect(JSON.parse((await vb(narrowed, ['tasks', '--json'])).stderr)).toMatchObject({ reason: 'channel_tree_too_large', hint: 'Name a channel, or a smaller subtree', data: { error: { code: 'channel_tree_too_large', status: 400 } } })
    expect(await vb(narrowed, ['tasks', 'many/c8'])).toMatchObject({ code: 0, stdout: expect.stringMatching(/ready +task 8\n$/), stderr: '' })
  })
})
