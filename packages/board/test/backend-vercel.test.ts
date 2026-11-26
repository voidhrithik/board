import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { board } from '../src/server/index.ts'
import { ATTACHMENT_BYTES_MAX } from '../src/contract/files.ts'
import { vercel } from '../src/backend-vercel/index.default.ts'
import { credentialSource, vercel as nodeVercel } from '../src/backend-vercel/index.ts'
import { conformance } from '../src/conformance/index.ts'
import { boardEvents } from '../src/contract/events.ts'
import { watchersHash } from '../src/server/registry.ts'
import { REGISTERED_WATCHERS_MAX } from '../src/api/routes.ts'
import type { Authenticate } from '../src/access/index.ts'
import { compileAccess } from '../src/server/access.ts'
import type { Caller } from '../src/server/backend.ts'
import type { Middleware } from '../src/server/middleware.ts'
import type { Watcher } from '../src/server/watcher.ts'
import { slack } from '../src/sync/slack.ts'
import { github, repos } from '../src/sync/github.ts'
import { channels, render } from '../src/sync/fn.ts'
import { as, fakeMessageboard } from './messageboard.ts'
import { fakePlatform, withSlackClient } from './sync-fixtures.ts'

const API = 'http://localhost'

/** A handle on the fake's board through vercel(), as `principal`. */
const handleOn = (api: ReturnType<typeof fakeMessageboard>, principal = 'user:u_jb') =>
  board({ backend: vercel({ team: 'team_test', api: API, fetch: as(api, principal), files: api.files }) })

/** The same handle, with `headers` on every request, as `vb conformance` sends them to Vercel's API. */
const withHeadersOn =
  (api: ReturnType<typeof fakeMessageboard>, principal = 'user:u_jb') =>
  (headers: Record<string, string>) =>
    board({
      backend: vercel({
        team: 'team_test',
        api: API,
        // In init, where as() reads them: a Request's own headers it would drop.
        fetch: (input, init = {}) => {
          const sent = new Headers(init.headers)
          for (const [name, value] of Object.entries(headers)) sent.set(name, value)
          return as(api, principal)(input, { ...init, headers: sent })
        },
        files: api.files,
      }),
    })

/** The checks of who writes: what a run with headers of its own checks. */
const IDENTITY = [
  'core: takes a profile and its avatar as one x-board-profile header, and shows both on what it writes',
  "core: ignores x-board-avatar, which x-board-profile's avatar parameter replaced",
  'core: ignores x-board-session: who writes is the principal and its profile',
  'core: shows no session on a message, its event, or you',
]

/** Someone a host's verifier would name: a request from her is still no one's this board serves. */
const ADA = { id: 'vercel:user:u_ada', kind: 'person', handle: 'ada' } as const

/** The project's own board on Vercel's, as its deployment runs it, with `middleware`: what board() serves is its own code. */
const PONG_URL = 'https://pong.example/api/board'
const WEB_URL = 'https://web.example/api/board'
function pongBoard(api: ReturnType<typeof fakeMessageboard>, middleware: Middleware[] = [], options: { authenticate?: Authenticate } = {}) {
  return board({ backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files }), url: PONG_URL, middleware, ...options })
}

/** Every match a handle's registration has, each acked as it's pulled: a thread's next waits for the ack before it. */
async function drain(handle: ReturnType<typeof handleOn>) {
  const all: Awaited<ReturnType<typeof handle.matches>> = []
  for (let pulled = await handle.matches({}); pulled.length > 0; pulled = await handle.matches({})) {
    for (const match of pulled) {
      await handle.ack(match.id, { lease: match.lease })
    }
    all.push(...pulled)
  }
  return all
}

describe('vercel()', () => {
  it("passes the conformance kit's core, schedules, grants, and attachments for a person, and skips what Vercel's API takes only from a deployment", async () => {
    const api = fakeMessageboard()
    // The API looks names up, so the grants checks name a project, a repository, a viewer, and an app its team has.
    const report = await conformance(handleOn(api), { withHeaders: withHeadersOn(api), principals: { project: 'prj_web', repository: 'acme/api', viewer: 'val@acme.com', app: 'ship' } })
    const statuses = Object.fromEntries(report.checks.map((check) => [`${check.group}: ${check.name}`, check.status]))
    expect(statuses).toEqual({
      'core: says in its discovery where it is': 'passed',
      'core: posts a message, and reads it back by its ID': 'passed',
      "core: puts a reply in its root's thread": 'passed',
      'core: posts a reply with its labels, so its message.posted event carries them': 'passed',
      'core: labels a message only while its labels are as the write says, one of any that race': 'passed',
      'core: edits and deletes a message only at the revision it was read at, which only edits and deletes change': 'passed',
      "core: replies after a message only while it's the thread's newest, one of any that race": 'passed',
      'core: posts once for a client ID, however many times it is sent': 'passed',
      'core: raises the version with each edit, reaction, and label': 'passed',
      'core: drops a deleted message from what its labels find': 'passed',
      "core: reads one channel's messages after a cursor of its own, oldest first, and on from where it stopped": 'passed',
      'core: lists channels a page at a time, and the ones under a prefix': 'passed',
      "core: reads a thread's replies after one of its messages, and as many of its newest as it's asked for": 'passed',
      "core: reads one channel's newest messages, as many as it's asked for": 'passed',
      'core: lists threads, each with its reply count and latest reply': 'passed',
      // Vercel's API keeps no index to find threads by what they say, or across channels.
      'search: finds threads by text anywhere in a message of theirs, in any case, as it reads now': 'skipped',
      'search: lists the threads of every channel under a pattern at once': 'skipped',
      'core: reads events after a cursor, each with a cursor of its own': 'passed',
      "core: reads a channel's newest events, oldest first, and goes on from their cursor": 'skipped',
      'core: holds a long-poll open until the next event': 'passed',
      'core: deletes a message, leaving a tombstone': 'passed',
      'core: lists the channel and you in it': 'passed',
      'core: narrows a caller to what its x-board-can says': 'passed',
      // It reads x-board-profile as a name alone, and an avatar from x-board-avatar.
      [IDENTITY[0]!]: 'failed',
      'core: lets a profile change only its own messages, and its principal all of them': 'passed',
      [IDENTITY[1]!]: 'failed',
      // It keeps a session on actors, which vercel() maps no view of.
      [IDENTITY[2]!]: 'passed',
      [IDENTITY[3]!]: 'passed',
      "watchers: refuses a caller narrowed with x-board-can its principal's watchers: registering, pulling, and acking": 'passed',
      // A person keeps no sync's records, narrowed or not.
      "sync: refuses a caller narrowed with x-board-can sync's records: imports, receipts, and the inbox": 'skipped',
      'core: creates a channel only once: one a post made is there already': 'passed',
      'core: answers 404 for an ID that names nothing': 'passed',
      'core: stores a handle one actor has as a mention of them, and keeps one no one has as typed': 'passed',
      'core: answers 400 for a request that does not validate': 'passed',
      'schedules: schedules a reply, lists it, and cancels it': 'passed',
      'schedules: keeps noSync on a schedule, so its sends stay off every platform': 'passed',
      // Tasks are the API's threads': vercel() maps each task method onto their routes.
      'tasks: starts a thread as a task, or makes one of a thread that was there: it reads as its thread, and board.task finds it': 'passed',
      'tasks: makes a task once for a client ID, and none under an ID a reply or a plain thread landed with': 'passed',
      'tasks: gives a task to one of the claims that race for it, and takes its result': 'passed',
      'tasks: gives a claim the lease it asks for, up to 5 minutes, and says when it ends': 'passed',
      "tasks: fences what a claim does: once it's over, its writes are lost and change nothing": 'passed',
      'tasks: holds a task until the tasks it needs complete, which a failed or canceled one never does': 'passed',
      'tasks: refuses a prerequisite that was canceled, which can never complete, and takes one that failed': 'passed',
      'tasks: lists the tasks that wait for one in the channel a list names, or its subtree, and no other': 'passed',
      'tasks: lists the last active tasks with latest, wherever they come in the order they were made': 'passed',
      'tasks: says task.ready each time a task that needs others becomes ready: right after it is made or unblocked, once they have completed': 'passed',
      'tasks: changes what a task needs: it waits for the new ones, is ready once they have completed, and at once with none': 'passed',
      'tasks: refuses a change of needs that would make a task wait for itself, straight back or through others': 'passed',
      'tasks: changes what a task needs only while no one holds it and it has not finished': 'passed',
      'tasks: holds a task until its not-before time, readies it once its time has come and what it needs has completed, and lets its owner change it while no one holds it': 'passed',
      'tasks: makes several tasks in one write, in the order given: each waits for the ones it names, of the batch or there already, and an id makes them once': 'passed',
      'tasks: makes none of a batch when one of its tasks can not be made, wherever it comes in it': 'passed',
      'tasks: holds a task for a person, by its owner or its claim, and gives it back when unblocked': 'passed',
      'tasks: keeps a task assigned to a profile for that actor alone': 'passed',
      'tasks: lets a profile change only the tasks it made, and its principal all of them': 'passed',
      'tasks: takes label in its channel to claim a task: a caller narrowed to reading and posting claims none': 'passed',
      "tasks: takes read in a prerequisite's channel to wait for it: a caller narrowed out of it makes no task that needs it": 'passed',
      'tasks: claims the oldest ready task in a channel or its subtree that has the labels asked for, and waits for one': 'passed',
      'tasks: shows a feed that filters on board.task=ready a task becoming ready and being claimed, and never a token': 'passed',
      'tasks: keeps labels under board. its own: a label write or a post that sets one is refused': 'passed',
      // Its other author is a platform's, imported by a sync, which only a deployment runs.
      'tasks: holds a task when anyone but its owner edits its root, which ends its claim': 'skipped',
      'grants: grants a principal, lists it, and revokes it': 'passed',
      'grants: makes another grant for the same principals, and changes one by its ID': 'passed',
      "grants: keeps a grant's can as written, a pattern with no permissions included": 'passed',
      'grants: lets the most specific pattern decide, then the closest principal there, and adds up ties': 'passed',
      'grants: lets everyone narrow what something else lets in, and lets no one in itself': 'passed',
      'grants: caps a person by their team role, so a viewer reads but neither posts nor manages': 'passed',
      'grants: names an app by its slug or client ID, keeps it by client ID, and every app as a group': 'passed',
      'grants: takes manage at each pattern a grant names to change it, and at * to list them': 'passed',
      "paging: pages back through a channel's threads by their `older`, each thread once": 'passed',
      'paging: refuses to page threads back and forward at once': 'passed',
      "grants: lets no caller narrowed with x-board-can grant past its can, even where everyone's grant closes it": 'passed',
      'grants: lets no caller narrowed with x-board-can let anyone in where everyone gets more than it has': 'passed',
      // The run is a team owner, whom nothing locks out.
      "grants: refuses a grant its maker couldn't take back, unless it says lockMeOut": 'skipped',
      'grants: makes several grants in one write, or none of them, a lock with the grant that keeps its maker in': 'passed',
      'grants: lets a member grant on a pattern after a lock under it': 'skipped',
      'grants: lets a project on another team in, in its environments': 'skipped',
      'schemas: lists the built-in schemas first, and reads a schema by its ID': 'passed',
      'schemas: registers a schema version once: the same definition again changes nothing, and another is refused': 'passed',
      "schemas: refuses a built-in's name, and a definition it couldn't check a value against": 'passed',
      'schemas: carries a block in a message, checked against the schema its fence names': 'passed',
      'schemas: refuses a caller narrowed with x-board-can a schema, and lets it read them': 'passed',
      'attachments: takes a file, posts it, and gives it back': 'passed',
      'attachments: refuses a name that would download as a dotfile': 'passed',
      'attachments: starts a task with a file, which its root carries': 'passed',
      'watchers: matches a registered tail, hands the match to a pull, and takes its ack': 'skipped',
      'watchers: wakes by path only where its discovery says so, and only a Vercel project': 'skipped',
      "sync: keeps sync's records: an import as a profile of its importer, its lookups by platform ID, a receipt, and where it's synced": 'skipped',
      "sync: meets a platform user an import's text mentions: an actor as one who wrote would be, whom the text names by that actor's ID": 'skipped',
      "sync: queues a platform thread's events in its sync's inbox once, and leases each after the one before is acked": 'skipped',
      "sync: takes an edit of a long message in its sync's inbox, under the longest event ID the protocol allows, and refuses a longer one": 'skipped',
      'sync: hands a sync each message change as a match of its @sync watcher': 'skipped',
      'sync: keeps noSync on a post and a reply, so sync sends neither': 'passed',
    })
    // It leaves the grants as it found them.
    expect([...api.grants.keys()]).toEqual(['g1', 'g2', 'g3'])
  }, 30_000)

  it("refuses a label under board. before it reaches Vercel's API, as on any backend", async () => {
    const api = fakeMessageboard()
    const handle = handleOn(api)
    const root = await handle.post('dev', 'fix CVE-123')
    api.requests.length = 0
    // The board's own labels are board()'s to keep, on every backend.
    await expect(handle.label(root.id, { set: { 'board.task': 'ready' } })).rejects.toMatchObject({ status: 400, code: 'reserved_label' })
    await expect(handle.post('dev', { text: 'looks ready', labels: { 'board.task': 'ready' } })).rejects.toMatchObject({ status: 400, code: 'reserved_label' })
    expect(api.requests).toEqual([])
    // Any other label still goes through.
    await handle.label(root.id, { set: { step: 'fix' } })
    expect((await handle.thread(root.id)).message.labels).toEqual({ step: 'fix' })
  })

  it("passes the conformance kit's checks of who writes against an API that reads them as board's protocol has it, and says how today's fails", async () => {
    const statuses = (report: Awaited<ReturnType<typeof conformance>>) =>
      report.checks.filter((check) => IDENTITY.includes(`${check.group}: ${check.name}`)).map((check) => [check.status, check.detail ?? null])
    const conforming = fakeMessageboard({ protocolProfile: true })
    expect(statuses(await conformance(handleOn(conforming), { withHeaders: withHeadersOn(conforming) }))).toEqual(IDENTITY.map(() => ['passed', null]))
    const today = fakeMessageboard()
    expect(statuses(await conformance(handleOn(today), { withHeaders: withHeadersOn(today) }))).toEqual([
      // It takes the whole header as the profile's name.
      ['failed', expect.stringMatching(/^the profile its header names: expected "conformance-[0-9a-f]{8}", got "conformance-[0-9a-f]{8}; avatar=\\"https:\/\/example\.com\/conformance\.png\\""$/)],
      // It shows the avatar x-board-avatar names, which board's protocol reads from the profile's header alone.
      ['failed', `the avatar of a profile whose header names none, whatever x-board-avatar says: expected null, got "https://example.com/conformance.png"`],
      // It keeps a session, which vercel() maps no view of.
      ['passed', null],
      ['passed', null],
    ])
  }, 30_000)

  it('answers only wake-ups and webhooks: it verifies no request, and none reaches the API, while its own code writes as the project', async () => {
    const api = fakeMessageboard()
    const authenticate = vi.fn(async () => ADA)
    const pong = pongBoard(api, [], { authenticate })
    const nothing = { error: { code: 'not_found', message: `${PONG_URL} answers only wake-ups and webhooks` } }
    for (const [method, path, body] of [
      ['GET', '/', undefined],
      ['GET', '/me', undefined],
      ['GET', '/messages', undefined],
      ['POST', '/messages', { channel: 'dev', text: 'hi' }],
      ['POST', '/attachments/uploads', { name: 'big.mp4', type: 'video/mp4', size: 10_000_000 }],
      ['POST', '/grants', { principals: [{ kind: 'github', repository: 'acme/web' }] }],
      ['POST', '/inbox/slack', { events: [] }],
    ] as const) {
      const response = await pong.fetch(
        new Request(`${PONG_URL}${path}`, {
          method,
          headers: { authorization: 'Bearer ada', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
      expect([`${method} ${path}`, response.status, await response.json()]).toEqual([`${method} ${path}`, 404, nothing])
    }
    expect(authenticate).not.toHaveBeenCalled()
    expect(api.requests).toEqual([])
    expect((await pong.post('dev', 'from the app')).by.principal).toBe('vercel:project:prj_pong:production')
  })

  it("refuses a reply after a message in another thread, which as a sequence would name one in its own", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const { id: root } = await julian.post('dev', { text: 'hi' })
    const { id: other } = await julian.post('dev', { text: 'another' })
    await expect(julian.reply(root, { text: 'hello', after: other })).rejects.toMatchObject({ status: 400, code: 'invalid_after' })
    expect((await julian.thread(root)).replies).toEqual([])
    // A retry of one that landed gets it back, whatever its `after` says now.
    const landed = await julian.reply(root, { text: 'hello', id: 'hello-1', after: root })
    expect((await julian.reply(root, { text: 'hello', id: 'hello-1', after: other })).id).toBe(landed.id)
    expect((await julian.thread(root)).replies.map((m) => m.id)).toEqual([landed.id])
  })

  it("leaves a channel path's length to Vercel's API: a path the board takes but the API doesn't fails with the API's error", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    await julian.post(`ops/${'a'.repeat(76)}`, 'fits')
    await expect(julian.post(`ops/${'a'.repeat(77)}`, 'too long for the API')).rejects.toMatchObject({ status: 400, code: 'invalid_channel_name' })
  })

  it("leaves a message's length to Vercel's API: text over its limit fails with the API's error, on a post, a reply, and an edit", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const tooLong = { status: 400, code: 'invalid_message' }
    await expect(julian.post('dev', 'x'.repeat(10_001))).rejects.toMatchObject(tooLong)
    const { id: root } = await julian.post('dev', 'hi')
    await expect(julian.reply(root, 'x'.repeat(10_001))).rejects.toMatchObject(tooLong)
    await expect(julian.edit(root, 'x'.repeat(10_001))).rejects.toMatchObject(tooLong)
    const thread = await julian.thread(root)
    expect([thread.message.text, thread.replies]).toEqual(['hi', []])
  })

  it("names a person by their Vercel username and name, and an agent by its profile under them, as the API does", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const { id } = await julian.post('dev', { text: 'hi' })
    await julian.as('claude').reply(id, { text: 'hello' })
    const { message, replies } = await julian.thread(id)
    expect(message.author).toMatchObject({ kind: 'person', handle: 'julian', name: 'Ada Lovelace' })
    expect(replies[0]!.author).toMatchObject({ kind: 'agent', handle: 'julian/claude', name: 'claude' })
    // Someone who first writes after the names were read is named too.
    await handleOn(api, 'user:u_ada').reply(id, { text: 'me too' })
    expect((await julian.thread(id)).replies[1]!.author).toMatchObject({ handle: 'ada', name: 'Ada Lovelace' })
  })

  it("sends an agent's avatar as Vercel's API reads it today: its name alone in x-board-profile, and the avatar in x-board-avatar", async () => {
    const api = fakeMessageboard()
    const sent: Headers[] = []
    const recording: typeof fetch = async (input, init) => {
      sent.push(new Headers(init?.headers))
      return as(api, 'user:u_jb')(input, init)
    }
    const julian = board({ backend: vercel({ team: 'team_test', api: API, fetch: recording, files: api.files }) })
    const fixer = await julian.as({ name: 'fixer', avatar: 'https://example.com/fixer.png' }).post('dev', { text: 'on it' })
    expect(fixer.by.actor).toBe('vercel:user:u_jb+fixer')
    expect(sent.at(-1)!.get('x-board-profile')).toBe('fixer')
    expect(sent.at(-1)!.get('x-board-avatar')).toBe('https://example.com/fixer.png')
    expect(sent.some((headers) => headers.has('x-board-session'))).toBe(false)
  })

  it("shows no session where the API keeps one, as it did for clients that sent it", async () => {
    const api = fakeMessageboard()
    // An older client, which sent its session with every request.
    const older: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('x-board-session', 'claude-1')
      return as(api, 'user:u_jb')(input, { ...init, headers })
    }
    const root = await board({ backend: vercel({ team: 'team_test', api: API, fetch: older, files: api.files }) }).as('claude').post('dev', { text: 'from a session' })
    const julian = handleOn(api)
    const { message } = await julian.thread(root.id)
    expect(message.by).toEqual({ actor: 'vercel:user:u_jb+claude', principal: 'vercel:user:u_jb', profile: 'claude' })
    expect((await julian.as('claude').me())).not.toHaveProperty('session')
  })

  it('names someone after a read of the names fails, and every message of someone new in one read', async () => {
    const api = fakeMessageboard()
    let failing = true
    // The list of names fails once.
    const flaky: typeof fetch = async (input, init) => {
      if (failing && new URL(String(input)).pathname.endsWith('/actors')) {
        failing = false
        return Response.json({ error: { code: 'internal', message: 'boom' } }, { status: 500 })
      }
      return as(api, 'user:u_jb')(input, init)
    }
    const julian = board({ backend: vercel({ team: 'team_test', api: API, fetch: flaky }) })
    const { id } = await julian.post('dev', { text: 'hi' })
    expect(failing).toBe(false)
    expect((await julian.thread(id)).message.author).toMatchObject({ handle: 'julian', name: 'Ada Lovelace' })
    // Someone new, several times: each of their messages, read side by side, is named.
    const ada = handleOn(api, 'user:u_ada')
    for (const text of ['one', 'two', 'three']) await ada.post('dev', { text })
    const { messages } = await julian.channel('dev').messages()
    expect(messages.filter((message) => message.by.principal === 'vercel:user:u_ada').map((message) => message.author?.handle)).toEqual(['ada', 'ada', 'ada'])
  })

  it('shows a renamed person by their new name once they write again and a few minutes pass', async () => {
    const accounts = { u_jb: { username: 'julian', name: 'Ada Lovelace' } }
    const api = fakeMessageboard({ accounts })
    const julian = handleOn(api)
    const { id } = await julian.post('dev', { text: 'hi' })
    expect((await julian.thread(id)).message.author).toMatchObject({ handle: 'julian' })
    // The API records the new name when they next write.
    accounts.u_jb = { username: 'jules', name: 'Jules Verne' }
    await julian.reply(id, { text: 'renamed' })
    const clock = vi.spyOn(Date, 'now')
    try {
      clock.mockReturnValue(Date.now() + 6 * 60_000)
      expect((await julian.thread(id)).message.author).toMatchObject({ handle: 'jules', name: 'Jules Verne' })
    } finally {
      clock.mockRestore()
    }
  })

  it("writes as the project a deployment is, per environment, and as an agent with its profile, each shown by the project's name or its ID", async () => {
    for (const [projectIdHandles, production, preview] of [
      [false, { handle: 'pong', name: 'pong' }, { handle: 'pong', name: 'pong (preview)' }],
      // An API that names a deployment by its ID names pong nowhere.
      [true, { handle: 'prj_pong', name: 'prj_pong' }, { handle: 'prj_pong@preview', name: 'prj_pong@preview' }],
    ] as const) {
      const api = fakeMessageboard({ projectIdHandles })
      const pong = handleOn(api, 'project:prj_pong:production')
      const { cursor: start } = await pong.channel('pings').messages()
      const { id } = await pong.post('pings', { text: 'ping' })
      const reply = await pong.as('claude').reply(id, { text: 'pong', labels: { kind: 'task' } })
      // A preview is someone else, of the same project.
      const previewed = handleOn(api, 'project:prj_pong:preview')
      expect(await previewed.me()).toMatchObject({ principal: 'vercel:project:prj_pong:preview', kind: 'deployment', ...preview })
      await previewed.reply(id, { text: 'from a preview' })
      const { message, replies } = await handleOn(api).thread(id)
      expect(message).toMatchObject({ channel: 'pings', by: { principal: 'vercel:project:prj_pong:production', profile: null }, author: { kind: 'deployment', ...production } })
      expect(replies).toMatchObject([
        { id: reply.id, re: id, labels: { kind: 'task' }, by: { actor: 'vercel:project:prj_pong:production+claude', profile: 'claude' }, author: { kind: 'agent', handle: 'claude', via: { name: production.handle, environment: 'production' } } },
        { text: 'from a preview', author: { kind: 'deployment', ...preview } },
      ])
      const actors = await handleOn(api).actors()
      expect(['vercel:project:prj_pong:production', 'vercel:project:prj_pong:preview'].map((at) => actors.find((actor) => actor.id === at))).toMatchObject([production, preview])
      // `me` is who the handle writes as, its profile included: the feed, from before the channel had anything, by each.
      const mine = async (handle: typeof pong) => (await handle.poll({ channel: 'pings', by: 'me', after: start })).events.filter((event) => event.type === 'message.posted').map((event) => event.message?.id)
      expect(await mine(pong.as('claude'))).toEqual([reply.id])
      expect(await mine(pong)).toEqual([id])
    }
  })

  it('follows the feed and lists schedules by a handle as the board shows it, a person covering their agents', async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const ada = handleOn(api, 'user:u_ada')
    const { cursor: start } = await ada.channel('dev').messages()
    const root = await julian.post('dev', { text: 'mine' })
    const claude = await julian.as('claude').reply(root.id, { text: 'from claude' })
    const hers = await ada.reply(root.id, { text: 'from ada' })
    const scheduled = await julian.as('claude').schedule({ re: root.id }, { text: 'later', in: '1h' })
    await ada.schedule({ re: root.id }, { text: 'hers later', in: '1h' })
    const posted = (events: { type: string; message?: { id: string } }[]) => events.filter((event) => event.type === 'message.posted').map((event) => event.message?.id)
    const ids = async (by: string) => posted((await ada.poll({ channel: 'dev', by, after: start })).events)
    expect(await ids('julian')).toEqual([root.id, claude.id])
    expect(await ids('julian/claude')).toEqual([claude.id])
    expect(await ids('Ada')).toEqual([hers.id])
    expect(await ids('nobody')).toEqual([])
    expect(posted((await ada.poll({ by: 'julian/claude', after: start })).events)).toEqual([claude.id])
    expect((await ada.schedules({ by: 'julian/claude' })).map((s) => s.id)).toEqual([scheduled.id])
  })

  it("reads the names again at most once for a `--by` value nobody goes by, until they're read anyway", async () => {
    const api = fakeMessageboard()
    const reads: string[] = []
    const fetch = as(api, 'user:u_jb')
    const counted = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (request.method === 'GET' && new URL(request.url).pathname.endsWith('/actors')) reads.push(request.url)
      return fetch(input, init)
    }) as typeof globalThis.fetch
    const julian = board({ backend: vercel({ team: 'team_test', api: API, fetch: counted, files: api.files }) })
    const { cursor: start } = await julian.channel('dev').messages()
    const root = await julian.as('claude').post('dev', { text: 'from claude' })
    const by = async (who: string) => (await julian.poll({ channel: 'dev', by: who, after: start })).events.map((event) => event.message?.id)
    expect(await by('julian/claude')).toEqual([root.id])
    const before = reads.length
    // A profile name isn't a handle: it matches without the names, read again once.
    for (let i = 0; i < 3; i++) expect(await by('claude')).toEqual([root.id])
    expect(reads.length - before).toBe(1)
  })

  it("reads one channel by its whole name, its messages and its threads by a label, and refuses every channel at once without a request", async () => {
    const api = fakeMessageboard()
    const team = handleOn(api)
    await team.post('dev', { text: 'one' })
    const two = await team.post('dev/web', { text: 'two', labels: { state: 'open' } })
    await team.post('ops', { text: 'three' })
    expect((await team.channel('dev').messages()).messages.map((m) => m.text)).toEqual(['one'])
    expect((await team.threads({ channel: 'dev/web', label: { state: 'open' } })).threads.map((t) => t.message.id)).toEqual([two.id])
    api.requests.length = 0
    // A pattern, or no channel: the API lists threads a channel at a time, and this reads none of them to answer.
    await expect(team.threads({ channel: 'dev/' })).rejects.toMatchObject({
      status: 501,
      code: 'not_supported',
      message: "Vercel's boards don't support reading every channel under dev/ at once yet: name one channel, and read the others one at a time. The channel list has their names",
    })
    await expect(team.threads({ channel: 'dev/', label: { state: 'open' } })).rejects.toMatchObject({ status: 501, code: 'not_supported' })
    await expect(team.threads()).rejects.toMatchObject({ status: 501, code: 'not_supported', message: expect.stringContaining('reading every channel at once') })
    // One channel's messages are by its whole name on any board: a pattern never reaches the API.
    await expect(team.channel('dev/').messages()).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
    expect(api.requests).toEqual([])
    // A thread is one channel's, whatever pattern the read names with it.
    expect((await team.threads({ channel: 'dev/', re: two.id })).threads.map((t) => t.message.id)).toEqual([two.id])
    expect((await team.threads({ channel: 'ops/', re: two.id })).threads).toEqual([])
  })

  it("lists channels by path, sorted, with none of the counts the API doesn't keep", async () => {
    const api = fakeMessageboard()
    const team = handleOn(api)
    await team.post('ops', { text: 'one' })
    await team.post('dev/web', { text: 'two' })
    await team.reply((await team.post('dev/web', { text: 'three' })).id, { text: 'four' })
    expect((await team.channels()).channels).toEqual([{ path: 'dev/web' }, { path: 'general' }, { path: 'ops' }])
  })

  /** A handle on the fake whose reads of the board's whole channel list are kept: the tag each sent, and the status and tag it was answered with. */
  const listingOn = (api: ReturnType<typeof fakeMessageboard>) => {
    const listed: { sent: string | null; status: number; etag: string | null }[] = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const response = await as(api, 'user:u_jb')(input, init)
      const url = new URL(String(input))
      if (init?.method === 'GET' && url.pathname.endsWith('/channels') && !url.searchParams.has('name'))
        listed.push({ sent: new Headers(init.headers).get('if-none-match'), status: response.status, etag: response.headers.get('etag') })
      return response
    }
    return { team: board({ backend: vercel({ team: 'team_test', api: API, fetch, files: api.files }) }), listed }
  }

  it("lists the board's channels again with the tag the API answered them with, and shows what it answered while the API says it holds", async () => {
    const api = fakeMessageboard({ channelPages: true })
    const { team, listed } = listingOn(api)
    await team.post('ops', { text: 'one' })
    await team.post('dev/web', { text: 'two' })
    listed.length = 0
    // In the API's own order, which a list of every channel keeps where the API pages them.
    expect((await team.channels()).channels).toEqual([{ path: 'general' }, { path: 'ops' }, { path: 'dev/web' }])
    expect((await team.channels()).channels).toEqual([{ path: 'general' }, { path: 'ops' }, { path: 'dev/web' }])
    const [first, second] = listed
    expect(first).toMatchObject({ sent: null, status: 200, etag: expect.any(String) })
    expect(second).toEqual({ sent: first!.etag, status: 304, etag: first!.etag })
  })

  it('keeps the tag of the newest list the API answered, and sends that one next', async () => {
    const api = fakeMessageboard({ channelPages: true })
    const { team, listed } = listingOn(api)
    await team.post('ops', { text: 'one' })
    await team.channels()
    await team.createChannel('ops/alerts')
    expect((await team.channels()).channels).toEqual([{ path: 'general' }, { path: 'ops' }, { path: 'ops/alerts' }])
    expect((await team.channels()).channels).toEqual([{ path: 'general' }, { path: 'ops' }, { path: 'ops/alerts' }])
    const [before, changed, again] = listed
    expect(changed).toMatchObject({ sent: before!.etag, status: 200 })
    expect(changed!.etag).not.toBe(before!.etag)
    expect(again).toEqual({ sent: changed!.etag, status: 304, etag: changed!.etag })
  })

  it('keeps a tag for each caller the API answers apart: a profile narrowed to some channels sends none of its principal\'s', async () => {
    const api = fakeMessageboard({ channelPages: true })
    const { team, listed } = listingOn(api)
    await team.post('ops', { text: 'one' })
    await team.post('dev/web', { text: 'two' })
    const fixer = team.as('fixer', { can: { 'dev/': ['read'] } })
    listed.length = 0
    for (let round = 0; round < 2; round++) {
      expect((await team.channels()).channels).toEqual([{ path: 'general' }, { path: 'ops' }, { path: 'dev/web' }])
      expect((await fixer.channels()).channels).toEqual([{ path: 'dev/web' }])
    }
    expect(listed.map(({ sent, status }) => [sent === null ? null : listed.findIndex((one) => one.etag === sent), status])).toEqual([
      [null, 200],
      [null, 200],
      [0, 304],
      [1, 304],
    ])
  })

  it('makes a channel in the API before anything posts to it, once', async () => {
    const api = fakeMessageboard()
    const team = handleOn(api)
    expect(await team.createChannel('dev/alerts')).toEqual({ channel: { path: 'dev/alerts' }, created: true })
    expect(await team.createChannel('dev/alerts')).toMatchObject({ created: false })
    // One a post made, or another handle, is there already.
    await team.post('ops', { text: 'hi' })
    expect(await team.createChannel('ops')).toMatchObject({ created: false })
    expect(await handleOn(api, 'user:u_ada').createChannel('dev/alerts')).toMatchObject({ created: false })
    // The board's own general, and what it made: each once.
    expect((await team.channels()).channels.map((c) => c.path).sort()).toEqual(['dev/alerts', 'general', 'ops'])
  })

  it("shows a channel's threads from the thread list alone where the API lists them with their messages, and reads each by ID where it doesn't, asking it once", async () => {
    const shown = async (inlineThreadMessages: boolean) => {
      const api = fakeMessageboard({ inlineThreadMessages })
      const team = handleOn(api)
      const roots = []
      for (let i = 0; i < 20; i++) roots.push(await team.post('busy', { text: `thread ${i}` }))
      for (const root of roots.slice(0, 10)) await team.reply(root.id, { text: `reply to ${root.text}` })
      const count = async () => {
        api.requests.length = 0
        const { threads } = await team.threads({ channel: 'busy' })
        return { threads, listed: api.requests.filter((r) => /\/threads$/.test(r)).length, byId: api.requests.filter((r) => /\/messages\/msg_/.test(r)).length }
      }
      const first = await count()
      // An edit since the first listing: the next one shows the root as it is now.
      await team.edit(roots[0]!.id, 'thread 0, edited')
      return { first, again: await count() }
    }
    const inline = await shown(true)
    const today = await shown(false)
    // The same summaries either way: a root for each, and a latest reply for the ten with one.
    const summaries = (threads: { message: { text: string }; last: { text: string } | null }[]) => threads.map((t) => [t.message.text, t.last?.text ?? null])
    expect(summaries(inline.first.threads)).toEqual(summaries(today.first.threads))
    expect(inline.first.threads.filter((t) => t.last)).toHaveLength(10)
    // With them, the list is the only request, and an edit since shows: they come as they are now.
    expect(inline.first).toMatchObject({ listed: 1, byId: 0 })
    expect(inline.again).toMatchObject({ listed: 1, byId: 0 })
    expect(summaries(inline.again.threads)).toContainEqual(['thread 0, edited', 'reply to thread 0'])
    expect(summaries(inline.again.threads)).toEqual(summaries(today.again.threads))
    // Vercel's API today refuses the parameter: the list is read again without it, each message by ID as before,
    expect(today.first).toMatchObject({ listed: 2, byId: 30 })
    // and it isn't asked again.
    expect(today.again).toMatchObject({ listed: 1, byId: 30 })
  })

  it('finds who a message mentions from its text, in the feed: you by your handle or ID, and anyone else by name with what is under it', async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const val = handleOn(api, 'user:u_val')
    const claude = julian.as('claude')
    const me = await claude.me()
    const mine = await julian.me()
    const { cursor: start } = await val.channel('dev').messages()
    await val.post('dev', { text: `@${me.handle}: can you look?` })
    await val.post('dev', { text: `cc @[${me.actor}]` })
    await val.post('dev', { text: `@${mine.handle} and nobody else` })
    await val.post('dev', { text: 'no one is named here, and `@' + me.handle + '` in code is not a mention' })
    const texts = async (as: typeof julian, mentions: string) =>
      (await as.poll({ channel: 'dev', mentions, after: start })).events.map((event) => event.message!.text.slice(0, 12)).sort()
    // The agent is found by its own handle and by its ID, and not where only its person is named.
    expect(await texts(claude, 'me')).toEqual([`@${me.handle}`.slice(0, 12), 'cc @[vercel:'].sort())
    // The person's name finds them and their agents', as on any board.
    expect(await texts(val, mine.handle)).toHaveLength(2)
    // A wait for a mention of you wakes on one.
    const waiting = claude.poll({ channel: 'dev', mentions: 'me', wait: 5 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await val.post('dev', { text: 'not this one' })
    await val.post('dev', { text: `@${me.handle} this one` })
    expect((await waiting).events.map((event) => event.message?.text)).toEqual([`@${me.handle} this one`])
  }, 15_000)

  it('finds a mention board() settled to an actor ID by the handle it was written as, in the feed, naming the mentioned in one request', async () => {
    const api = fakeMessageboard({ inlineThreadMessages: true, inlineActors: true })
    const julian = handleOn(api)
    // Two actors who wrote somewhere else, so nothing a read of dev answers names them.
    await julian.as('claude').post('other', { text: 'hi' })
    await handleOn(api, 'user:u_ada').post('other', { text: 'hi' })
    // And a project's agent, whom the API names under the project (`pong/claude`).
    await pongBoard(api).as('claude').post('other', { text: 'hi' })
    const val = handleOn(api, 'user:u_val')
    const { cursor: start } = await val.channel('dev').messages()
    const asking = await val.post('dev', { text: '@julian/claude can you look?' })
    await val.post('dev', { text: 'and @ada, can you?' })
    await val.post('dev', { text: '@nobody-here, anyone?' })
    await val.post('dev', { text: '@[vercel:user:u_zed+claude] are you there?' })
    const pinging = await val.post('dev', { text: '@pong/claude ping' })
    // What's stored is the ID each handle settled to.
    expect(asking.text).toBe('@[vercel:user:u_jb+claude] can you look?')
    expect(pinging.text).toBe('@[vercel:project:prj_pong:production+claude] ping')
    const inner = as(api, 'user:u_val')
    const asked: string[][] = []
    const lists: number[] = []
    let failing = false
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/actors')) (url.searchParams.has('id') ? asked.push(url.searchParams.getAll('id').sort()) : lists.push(1))
      if (failing && url.pathname.endsWith('/actors')) return Response.json({ error: { code: 'internal_error', message: 'Something went wrong.' } }, { status: 500 })
      return inner(input, init)
    }) as typeof globalThis.fetch
    /** The messages the feed has that mention someone, read in a process of its own, as each `vb wait --mentions` is. */
    const mentioning = async (mentions: string, channel: string | undefined = 'dev') =>
      (await board({ backend: vercel({ team: 'team_test', api: API, fetch }) }).poll({ ...(channel ? { channel } : {}), mentions, after: start })).events.map((event) => event.message?.text)
    const fresh = () => board({ backend: vercel({ team: 'team_test', api: API, fetch }) })
    // By the handle as written, by the person it's under, and by its ID: the same message.
    expect(await mentioning('julian/claude')).toEqual([asking.text])
    expect(asked).toEqual([['vercel:project:prj_pong:production+claude', 'vercel:user:u_ada', 'vercel:user:u_jb+claude', 'vercel:user:u_zed+claude']])
    expect(await mentioning('julian')).toEqual([asking.text])
    expect(await mentioning('vercel:user:u_jb+claude')).toEqual([asking.text])
    expect(await mentioning('ada', undefined)).toEqual(['and @[vercel:user:u_ada], can you?'])
    // A handle that settled to no one is still matched as written.
    expect(await mentioning('nobody-here')).toEqual(['@nobody-here, anyone?'])
    // A project's agent by the API's handle for it, and by its project; neither it nor an ID the API names no one by is a bare `claude`.
    expect(await mentioning('pong/claude')).toEqual([pinging.text])
    expect(await mentioning('pong')).toEqual([pinging.text])
    expect(await mentioning('claude')).toEqual([])
    // An ID asks for no one: it matches as written.
    asked.length = 0
    expect(await mentioning('vercel:user:u_jb+claude')).toEqual([asking.text])
    expect(asked).toEqual([])
    // A wait for a mention wakes on one settled to an ID.
    const waiting = fresh().poll({ channel: 'dev', mentions: 'julian/claude', wait: 5 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await val.post('dev', { text: '@ada not this one' })
    await val.post('dev', { text: '@julian/claude this one' })
    expect((await waiting).events.map((event) => event.message?.text)).toEqual(['@[vercel:user:u_jb+claude] this one'])
    // Never the whole list: the mentioned are asked for by ID.
    expect(lists).toEqual([])
    // A read of the actors that fails fails the poll, which reads the same change again and finds the mention.
    const { cursor } = await fresh().poll({ channel: 'dev' })
    await val.post('dev', { text: '@pong/claude again' })
    const later = fresh()
    failing = true
    await expect(later.poll({ channel: 'dev', mentions: 'pong', after: cursor })).rejects.toMatchObject({ status: 500 })
    failing = false
    expect((await later.poll({ channel: 'dev', mentions: 'pong', after: cursor })).events.map((event) => event.message?.text)).toEqual(['@[vercel:project:prj_pong:production+claude] again'])
  }, 15_000)

  it('refuses to find threads by who wrote them or where they came from, without a request', async () => {
    const api = fakeMessageboard({ inlineThreadMessages: true })
    const team = handleOn(api)
    const root = await team.post('archive', { text: 'osprey nests here' })
    await team.reply(root.id, { text: 'osprey, seen today' })
    await team.label(root.id, { set: { kind: 'sighting' } })
    await team.threads({ channel: 'archive', limit: 1 })
    api.requests.length = 0
    // The API keeps no index for either: answering would read every thread of the channel, a request each.
    for (const [filter, named] of [[{ by: 'julian' }, 'author'], [{ from: 'slack' }, 'source']] as const) {
      await expect(team.threads({ channel: 'archive', ...filter }), named).rejects.toMatchObject({
        status: 501,
        code: 'not_supported',
        message: `Vercel's boards don't support reading threads by ${named} yet: they keep no search index. Read one channel's threads, or one thread, and look through what it answers`,
      })
      // In one thread too: it's read whole, and whoever reads it looks through it.
      await expect(team.threads({ re: root.id, ...filter }), named).rejects.toMatchObject({ status: 501, code: 'not_supported' })
    }
    await expect(team.threads({ channel: 'archive', text: 'osprey', by: 'julian' })).rejects.toMatchObject({ message: expect.stringContaining('reading threads by author yet') })
    // Mentions and text are looked for in one page of one channel's threads: nothing that would read on past it.
    for (const [filter, named] of [[{ mentions: 'me' }, 'mention'], [{ text: 'osprey' }, 'text']] as const) {
      await expect(team.threads({ re: root.id, ...filter }), named).rejects.toMatchObject({ status: 501, message: expect.stringContaining(`reading threads by ${named} in one thread yet`) })
      await expect(team.threads({ channel: 'archive', label: { kind: 'sighting' }, ...filter }), named).rejects.toMatchObject({ status: 501, message: expect.stringContaining('and a label yet') })
      await expect(team.threads({ channel: 'archive', after: '0', ...filter }), named).rejects.toMatchObject({ status: 501, message: expect.stringContaining('after a cursor yet') })
      await expect(team.threads({ channel: 'archive/', ...filter }), named).rejects.toMatchObject({ status: 501, message: expect.stringContaining('reading every channel under archive/ at once') })
    }
    expect(api.requests).toEqual([])
    // What it does index still narrows a read: a root's label, in one request for the list.
    expect((await team.threads({ channel: 'archive', label: { kind: 'sighting' } })).threads.map((thread) => thread.message.id)).toEqual([root.id])
    expect(api.requests.filter((request) => /\/threads\/[^/]+\/messages$/.test(request))).toEqual([])
  })

  it("finds threads by mention or text in one page of a channel's threads, by each one's first and newest message, in the requests a plain read sends and one more", async () => {
    const api = fakeMessageboard({ inlineThreadMessages: true, inlineActors: true })
    const julian = handleOn(api)
    const val = handleOn(api, 'user:u_val')
    // A question to julian's agent as a thread of its own, one as the newest reply, and one a later reply buried.
    const asked = await val.post('dev', { text: '@julian/claude what is the cache key?' })
    const replied = await val.post('dev', { text: 'deploy failed' })
    await val.reply(replied.id, { text: '@julian/claude can you look?' })
    const buried = await val.post('dev', { text: 'flaky test' })
    await val.reply(buried.id, { text: '@julian/claude seen this?' })
    await val.reply(buried.id, { text: 'never mind' })
    for (let n = 0; n < 3; n++) await val.post('dev', { text: `noise ${n}` })
    const claude = () => handleOn(api).as('claude')
    const ids = (page: { threads: { message: { id: string } }[] }) => page.threads.map((thread) => thread.message.id)
    // A plain read of the channel, for what it costs.
    let reader = claude()
    api.requests.length = 0
    await reader.threads({ channel: 'dev' })
    const plain = api.requests.length
    reader = claude()
    api.requests.length = 0
    const mine = await reader.threads({ channel: 'dev', mentions: 'me' })
    // The thread that asks, and the one whose newest reply does; the buried mention isn't on either end.
    expect(ids(mine)).toEqual([asked.id, replied.id])
    expect(mine.scanned).toBe(6)
    expect(mine.older).toBeNull()
    // One more than a plain read: who `me` is. No thread is read for it.
    expect(api.requests.length).toBe(plain + 1)
    expect(api.requests.filter((request) => /\/threads\/[^/]+\/messages|\/messages\//.test(request))).toEqual([])
    // By handle: the mentioned are named by ID, together, in one request at most.
    reader = claude()
    api.requests.length = 0
    expect(ids(await reader.threads({ channel: 'dev', mentions: 'julian/claude' }))).toEqual([asked.id, replied.id])
    expect(api.requests.length).toBeLessThanOrEqual(plain + 1)
    // Text, on the same two ends, case aside.
    expect(ids(await julian.threads({ channel: 'dev', text: 'CACHE KEY' }))).toEqual([asked.id])
    // A page at a time: each says how many it looked through, and its `older` pages back the same way.
    const newest = await julian.threads({ channel: 'dev', mentions: 'julian/claude', limit: 4 })
    expect([ids(newest), newest.scanned]).toEqual([[], 4])
    const back = await julian.threads({ channel: 'dev', mentions: 'julian/claude', limit: 4, before: newest.older! })
    expect([ids(back), back.scanned, back.older]).toEqual([[asked.id, replied.id], 2, null])
  })

  it('reads each thread of the page for its first and newest message once, on an API that lists threads without them', async () => {
    const api = fakeMessageboard()
    const val = handleOn(api, 'user:u_val')
    const asked = await val.post('dev', { text: '@julian/claude what is the cache key?' })
    const replied = await val.post('dev', { text: 'deploy failed' })
    await val.reply(replied.id, { text: '@julian/claude can you look?' })
    await val.post('dev', { text: 'noise' })
    const byRef = () => api.requests.filter((request) => /^GET .*\/messages\/[^/]+$/.test(request)).length
    const reader = handleOn(api).as('claude')
    await reader.threads({ channel: 'dev' })
    api.requests.length = 0
    await reader.threads({ channel: 'dev' })
    const plain = byRef()
    api.requests.length = 0
    expect((await reader.threads({ channel: 'dev', mentions: 'me' })).threads.map((thread) => thread.message.id)).toEqual([asked.id, replied.id])
    // The ends it matched on are the ones its summaries show: no thread is read for them twice.
    expect(byRef()).toBe(plain)
  })

  it("names a message's channel by its ID, without listing the board's channels", async () => {
    const api = fakeMessageboard()
    const team = handleOn(api)
    for (const channel of ['dev', 'ops', 'web']) await team.post(channel, { text: `hi ${channel}` })
    const root = await team.post('questions', { text: 'anyone?' })
    // A process that has listed nothing, as each `vb` run is: a reply, then the thread.
    const fresh = handleOn(api)
    api.requests.length = 0
    expect(await fresh.reply(root.id, { text: 'me!' })).toMatchObject({ channel: 'questions', re: root.id })
    expect((await fresh.thread(root.id)).message.channel).toBe('questions')
    // One request for the one channel, asked once: the list is a page of the API's at a time, however many the board has.
    expect(api.requests.filter((r) => /^GET .*\/channels$/.test(r))).toEqual([])
    expect(api.requests.filter((r) => /^GET .*\/channels\/[^/]+$/.test(r))).toHaveLength(1)
    // Where the API won't show a channel by its ID, it's looked for in the list, as before, and still named.
    const fetching = as(api, 'user:u_jb')
    const refused = (async (input: RequestInfo | URL, init?: RequestInit) =>
      /\/channels\/[^/]+$/.test(new URL(String(input instanceof Request ? input.url : input)).pathname)
        ? Response.json({ error: { code: 'not_found', message: 'Channel not found.' } }, { status: 404 })
        : fetching(input, init)) as typeof fetch
    const older = board({ backend: vercel({ team: 'team_test', api: API, fetch: refused, files: api.files }) })
    api.requests.length = 0
    expect((await older.thread(root.id)).message.channel).toBe('questions')
    expect(api.requests.filter((r) => /^GET .*\/channels$/.test(r))).toHaveLength(1)
  })

  it("lists a busy channel's threads from the API's thread list, reading only the roots and latest replies it shows", async () => {
    const api = fakeMessageboard()
    const team = handleOn(api)
    const roots = []
    for (let i = 0; i < 60; i++) roots.push(await team.post('busy', { text: `thread ${i}` }))
    await team.reply(roots[59]!.id, { text: 'latest' })
    // A first listing finds this API lists threads without their messages (below), and no later one asks.
    await team.threads({ channel: 'busy', limit: 1 })
    api.requests.length = 0
    const { threads, cursor } = await team.threads({ channel: 'busy', limit: 5 })
    expect(threads.map((t) => t.message.text)).toEqual(['thread 55', 'thread 56', 'thread 57', 'thread 58', 'thread 59'])
    expect(threads.at(-1)).toMatchObject({ replies: 1, last: { text: 'latest' } })
    // One page of the thread list, and a root (and the one latest reply) for each thread it shows.
    expect(api.requests.filter((r) => /\/threads$/.test(r))).toHaveLength(1)
    expect(api.requests.filter((r) => /\/threads\/[^/]+\/messages$/.test(r))).toEqual([])
    expect(api.requests.filter((r) => /\/messages\/msg_/.test(r))).toHaveLength(6)
    // Read on from the cursor, it stops at the first thread that hasn't moved since.
    const later = await team.post('busy', { text: 'thread 60' })
    api.requests.length = 0
    expect((await team.threads({ channel: 'busy', after: cursor })).threads.map((t) => t.message.id)).toEqual([later.id])
    expect(api.requests.filter((r) => /\/threads$/.test(r))).toHaveLength(1)
  })

  /** A handle on the fake through vercel(), with every request it sends to the API, in order: `METHOD /path?query`. */
  const recording = (api: ReturnType<typeof fakeMessageboard>, before?: (url: URL) => Promise<void>) => {
    const sent: URL[] = []
    const fetch = as(api, 'user:u_jb')
    const team = board({
      backend: vercel({
        team: 'team_test',
        api: API,
        files: api.files,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(input instanceof Request ? input.url : input))
          if ((init?.method ?? 'GET') === 'GET') {
            sent.push(url)
            await before?.(url)
          }
          return fetch(input, init)
        }) as typeof globalThis.fetch,
      }),
    })
    return { team, sent }
  }

  it("reads one channel by the name it was given where the API takes one, and looks its ID up first where it doesn't, asking once", async () => {
    const run = async (channelNames: boolean) => {
      const api = fakeMessageboard({ channelNames, inlineThreadMessages: true })
      const seed = handleOn(api)
      for (const channel of ['dev', 'ops']) await seed.post(channel, { text: `hi ${channel}` })
      const root = await seed.post('dev/web', { text: 'first' })
      const { cursor } = await seed.channel('dev/web').messages()
      await seed.reply(root.id, { text: 'second' })
      await seed.schedule('dev/web', { text: 'later', in: '1h' })
      type Team = ReturnType<typeof handleOn>
      const reads: Record<string, (team: Team) => Promise<unknown>> = {
        threads: async (team) => (await team.threads({ channel: 'dev/web' })).threads.map((t) => [t.message.channel, t.message.text, t.last?.text]),
        messages: async (team) => (await team.channel('dev/web').messages()).messages.map((m) => [m.channel, m.text]),
        poll: async (team) => (await team.poll({ channel: 'dev/web', after: cursor })).events.map((e) => [e.type, e.message?.channel, e.message?.text]),
        schedules: async (team) => (await team.schedules({ channel: 'dev/web' })).map((s) => [s.channel, s.text]),
      }
      const out: Record<string, { answer: unknown; lookups: number; byName: number; lookupsAgain: number; byNameAgain: number }> = {}
      for (const [name, read] of Object.entries(reads)) {
        // Each read as a process that has read nothing, as each `vb` run is.
        const { team, sent } = recording(api)
        const count = () => ({
          lookups: sent.filter((url) => /\/channels(\/[^/]+)?$/.test(url.pathname)).length,
          byName: sent.filter((url) => url.searchParams.has('channel')).length,
        })
        const answer = await read(team)
        const first = count()
        sent.length = 0
        expect(await read(team)).toEqual(answer)
        out[name] = { answer, ...first, lookupsAgain: count().lookups, byNameAgain: count().byName }
      }
      return out
    }
    const named = await run(true)
    const today = await run(false)
    expect(named.threads!.answer).toEqual([['dev/web', 'first', 'second']])
    expect(named.messages!.answer).toEqual([['dev/web', 'first'], ['dev/web', 'second']])
    expect(named.poll!.answer).toEqual([['message.posted', 'dev/web', 'second']])
    expect(named.schedules!.answer).toEqual([['dev/web', 'later']])
    for (const read of ['threads', 'messages', 'poll', 'schedules']) {
      // The same answer either way.
      expect([read, today[read]!.answer]).toEqual([read, named[read]!.answer])
      // Where the API takes the name, nothing asks for the channel: not by its name, and not by the ID a schedule or a thread names.
      expect([read, named[read]!.lookups, named[read]!.lookupsAgain]).toEqual([read, 0, 0])
      // Vercel's API today refuses the name once: the channel is looked up, as before, and the name isn't sent again. A read
      // that also asks for its actors is refused those first, then the name: one request for each parameter it doesn't take.
      const refused = read === 'messages' || read === 'poll' ? 2 : 1
      expect([read, today[read]!.byName, today[read]!.lookups, today[read]!.byNameAgain, today[read]!.lookupsAgain]).toEqual([read, refused, 1, 0, 0])
    }
  })

  it("answers for a channel that isn't there, or one it can't read, as it did when it looked the name up", async () => {
    const run = async (channelNames: boolean) => {
      const api = fakeMessageboard({ channelNames })
      const seed = handleOn(api)
      await seed.post('dev', { text: 'hi dev' })
      const secret = await seed.post('secret', { text: 'shh' })
      await seed.schedule('secret', { text: 'later', in: '1h' })
      const { cursor } = await seed.channel('dev').messages()
      const fixer = handleOn(api).as('fixer', { can: { 'dev/': ['read'] } })
      const out: unknown[] = []
      for (const [team, channel] of [[handleOn(api), 'nope'], [fixer, 'secret'], [fixer, 'nope']] as const) {
        out.push([
          channel,
          (await team.threads({ channel })).threads,
          (await team.channel(channel).messages()).messages,
          await team.schedules({ channel }),
          (await team.poll({ channel })).events,
          // Another channel's cursor isn't this one's to read on from.
          await team.channel(channel).messages({ after: cursor }).then(() => 'read', (error: { status?: number; code?: string }) => [error.status, error.code]),
          // The cursor it answered itself, from before it had anything, is.
          (await team.channel(channel).messages({ after: (await team.channel(channel).messages()).cursor })).messages,
        ])
      }
      // A read makes no channel.
      out.push((await seed.channels()).channels.map((channel) => channel.path).sort())
      // What it can read still reads, and a message in a channel it can't read names none.
      out.push((await fixer.channel('dev').messages()).messages.map((m) => m.text))
      out.push(await fixer.thread(secret.id).then((thread) => thread.message.channel, () => null))
      return out
    }
    const named = await run(true)
    expect(named).toEqual(await run(false))
    expect(named.slice(0, 3)).toEqual(['nope', 'secret', 'nope'].map((channel) => [channel, [], [], [], [], [400, 'invalid_cursor'], []]))
    expect(named.slice(3)).toEqual([['dev', 'general', 'secret'], ['hi dev'], null])
  })

  it("reads a channel by its name with its authors in the same answer, and is refused each parameter an older API doesn't take once", async () => {
    const run = async (options: Parameters<typeof fakeMessageboard>[0]) => {
      const api = fakeMessageboard(options)
      const seed = handleOn(api, 'user:u_ada')
      const root = await seed.post('dev/web', { text: 'first' })
      await seed.reply(root.id, { text: 'second' })
      const reads: Record<string, (team: ReturnType<typeof handleOn>) => Promise<unknown>> = {
        threads: async (team) => (await team.threads({ channel: 'dev/web' })).threads.map((t) => [t.message.channel, t.message.text, t.message.author?.handle, t.last?.text]),
        messages: async (team) => (await team.channel('dev/web').messages()).messages.map((m) => [m.channel, m.text, m.author?.handle]),
        thread: async (team) => [(await team.thread(root.id)).message].map((m) => [m.channel, m.text, m.author?.handle]),
      }
      const out: Record<string, { answer: unknown; sent: string[]; refused: string[] }> = {}
      for (const [name, read] of Object.entries(reads)) {
        // Each read as a process that has read nothing, as each `vb` run is.
        const fetching = as(api, 'user:u_jb')
        const sent: string[] = []
        const refused: string[] = []
        const counting = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(input instanceof Request ? input.url : input))
          const response = await fetching(input, init)
          const last = url.pathname.replace(/^.*\/boards\/[^/]+/, '').replace(/(msg|thr|chn)_[^/]+/, ':id')
          sent.push(last)
          if (response.status === 400) refused.push(`${last} ${((await response.clone().json()) as { error: { message: string } }).error.message.match(/`(\w+)`/)?.[1]}`)
          return response
        }) as typeof fetch
        const answer = await read(board({ backend: vercel({ team: 'team_test', board: 'brd_test', api: API, fetch: counting, files: api.files }) }))
        out[name] = { answer, sent, refused }
      }
      return out
    }
    const all = await run({ channelNames: true, inlineActors: true, inlineThreadMessages: true })
    const today = await run({})
    expect(all.threads!.answer).toEqual([['dev/web', 'first', 'ada', 'second']])
    expect(all.messages!.answer).toEqual([['dev/web', 'first', 'ada'], ['dev/web', 'second', 'ada']])
    expect(all.thread!.answer).toEqual([['dev/web', 'first', 'ada']])
    // With the name, the channel, and the authors all in the read's own answers, nothing else is asked.
    expect(all.threads).toMatchObject({ sent: ['/changes', '/threads'], refused: [] })
    expect(all.messages).toMatchObject({ sent: ['/messages'], refused: [] })
    expect(all.thread).toMatchObject({ sent: ['/messages/:id', '/threads/:id/messages'], refused: [] })
    // An API that takes none of them answers the same, and refuses each parameter once, not once for each of the others.
    for (const read of ['threads', 'messages', 'thread']) expect([read, today[read]!.answer]).toEqual([read, all[read]!.answer])
    expect([...today.threads!.refused].sort()).toEqual(['/changes channel', '/threads include', '/threads with'])
    expect([...today.messages!.refused].sort()).toEqual(['/messages channel', '/messages with'])
    expect([...today.thread!.refused].sort()).toEqual(['/messages/:id include', '/messages/:id with'])
  })

  it("reads as it did before names whatever the API refuses a name or a message's channel with", async () => {
    // What an API might answer the new parameters, beside the 400 Vercel's gives today: each read is the one `main` made.
    for (const [status, code, message] of [[403, 'forbidden', "You can't read `dev/web`."], [400, 'bad_request', 'Invalid request: missing required property `channelId`.'], [400, 'bad_request', 'Invalid request: `include` should be equal to one of the allowed values "messages".']] as const) {
      const api = fakeMessageboard({ inlineThreadMessages: true })
      const seed = handleOn(api)
      const root = await seed.post('dev/web', { text: 'first' })
      await seed.schedule('dev/web', { text: 'later', in: '1h' })
      const fetching = as(api, 'user:u_jb')
      const refusing = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input))
        return url.searchParams.has('channel') || url.searchParams.get('include') === 'channel' ? Response.json({ error: { code, message } }, { status }) : fetching(input, init)
      }) as typeof fetch
      const team = board({ backend: vercel({ team: 'team_test', api: API, fetch: refusing, files: api.files }) })
      expect([status, (await team.threads({ channel: 'dev/web' })).threads.map((t) => t.message.text)]).toEqual([status, ['first']])
      expect((await team.channel('dev/web').messages()).messages.map((m) => m.text)).toEqual(['first'])
      expect((await team.poll({ channel: 'dev/web' })).events).toEqual([])
      expect((await team.schedules({ channel: 'dev/web' })).map((s) => s.channel)).toEqual(['dev/web'])
      expect((await team.thread(root.id)).message.channel).toBe('dev/web')
      // And a channel that isn't there is still nothing, not the refusal.
      expect((await team.threads({ channel: 'nope' })).threads).toEqual([])
      expect((await team.channel('nope').messages()).messages).toEqual([])
    }
  })

  it("says a lapsed SAML session needs a new login, as Vercel's API refuses a SAML team with, not a grant", async () => {
    const lapsed = (async () =>
      Response.json({ error: { code: 'forbidden', message: 'Not authorized', saml: true, teamId: 'team_test', scope: 'test', enforced: true } }, { status: 403 })) as typeof fetch
    const team = board({ backend: vercel({ team: 'team_test', api: API, fetch: lapsed, files: fakeMessageboard().files }) })
    await expect(team.me()).rejects.toMatchObject({ status: 403, code: 'reauthentication_required' })
  })

  it("names a message's channel from the message's own answer where the API sends it, asking for no channel", async () => {
    const api = fakeMessageboard({ channelNames: true })
    const team = handleOn(api)
    const root = await team.post('questions', { text: 'anyone?' })
    // A process that has listed nothing, as each `vb` run is: a reply, then the thread.
    const fresh = handleOn(api)
    api.requests.length = 0
    expect(await fresh.reply(root.id, { text: 'me!' })).toMatchObject({ channel: 'questions', re: root.id })
    expect((await fresh.thread(root.id)).message.channel).toBe('questions')
    expect(api.requests.filter((r) => /\/channels(\/[^/]+)?$/.test(r))).toEqual([])
  })

  it("pages a channel's threads back with the API's own cursor, each of its pages in one read", async () => {
    const api = fakeMessageboard({ inlineThreadMessages: true, inlineActors: true })
    const { team, sent } = recording(api)
    for (let i = 0; i < 60; i++) await team.post('busy', { text: `thread ${i}` })
    const listed = () => sent.filter((url) => url.pathname.endsWith('/threads'))
    const read = async (query: { before?: string; limit?: number }) => {
      sent.length = 0
      const page = await team.threads({ channel: 'busy', ...query })
      return { texts: page.threads.map((t) => t.message.text), older: page.older, sent: listed().map((url) => [url.searchParams.get('cursor'), url.searchParams.get('limit')]) }
    }
    const texts = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `thread ${from + i}`)
    // The API's cursor goes out as it came, for a page as long as the read asks, the newest first.
    const first = await read({ limit: 30 })
    expect(first).toEqual({ texts: texts(30, 60), older: expect.any(String), sent: [[null, '30']] })
    const second = await read({ before: first.older!, limit: 25 })
    expect(second).toEqual({ texts: texts(5, 30), older: expect.any(String), sent: [[first.older, '25']] })
    // One of its pages with `before`, however few are left.
    expect(await read({ before: second.older!, limit: 100 })).toEqual({ texts: texts(0, 5), older: null, sent: [[second.older, '100']] })
    // A read longer than the API's longest page reads on to its limit.
    const all = await read({ limit: 150 })
    expect(all).toEqual({ texts: texts(0, 60), older: null, sent: [[null, '100']] })
    expect(listed().every((url) => url.searchParams.get('include') === 'messages')).toBe(true)
    // Only one channel's threads, unfiltered, page this way.
    await expect(team.threads({ channel: 'busy', label: ['kind'], before: first.older! })).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
  })

  it("pages a channel's threads back on an API whose pages are always 25, a page cut short at `limit` included", async () => {
    const api = fakeMessageboard({ inlineThreadMessages: true, inlineActors: true, threadsLimit: false })
    const { team } = recording(api)
    for (let i = 0; i < 60; i++) await team.post('busy', { text: `thread ${i}` })
    const read = async (query: { before?: string; limit?: number }) => {
      const page = await team.threads({ channel: 'busy', ...query })
      return { texts: page.threads.map((t) => t.message.text), older: page.older }
    }
    const texts = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `thread ${from + i}`)
    const first = await read({ limit: 25 })
    expect(first).toEqual({ texts: texts(35, 60), older: expect.any(String) })
    // One of its pages with `before`, whatever the limit.
    expect(await read({ before: first.older!, limit: 100 })).toEqual({ texts: texts(10, 35), older: expect.any(String) })
    // A page cut short at `limit` says how far into the API's it got, and the next starts there.
    expect(await read({ limit: 4 })).toEqual({ texts: texts(56, 60), older: '~4' })
    expect(await read({ before: '~4', limit: 25 })).toEqual({ texts: texts(35, 56), older: first.older })
  })

  it("lists a long channel 100 threads to a request, where the API takes a page's limit", async () => {
    const api = fakeMessageboard({ inlineThreadMessages: true, inlineActors: true })
    const author = handleOn(api, 'user:u_ada')
    for (let i = 0; i < 280; i++) await author.post('queue', { text: `task ${i}`, labels: { kind: 'task' } })
    for (const channel of ['dev', 'ops', 'ci']) for (let i = 0; i < 60; i++) await author.post(channel, { text: `${channel} ${i}` })
    const inner = as(api, 'user:u_jb')
    /** The thread list's pages a read takes, in a process of its own that has already read once, on the API or on one from before `limit`. */
    const pages = async (threadsLimit: boolean, query: Parameters<ReturnType<typeof handleOn>['threads']>[0]) => {
      let listed = 0
      const team = board({
        backend: vercel({
          team: 'team_test',
          api: API,
          fetch: async (input, init) => {
            const url = new URL(String(input))
            if (!url.pathname.endsWith('/threads')) return inner(input, init)
            listed++
            if (!threadsLimit && url.searchParams.has('limit')) return Response.json({ error: { code: 'bad_request', message: 'Invalid request: should NOT have additional property `limit`.' } }, { status: 400 })
            return inner(input, init)
          },
        }),
      })
      await team.threads({ channel: 'queue', limit: 1 })
      listed = 0
      const { threads } = await team.threads(query)
      return { threads: threads.length, pages: listed }
    }
    // Every thread of the channel, newest first.
    expect(await pages(true, { channel: 'queue', limit: 280 })).toEqual({ threads: 280, pages: 3 })
    expect(await pages(false, { channel: 'queue', limit: 280 })).toEqual({ threads: 280, pages: 12 })
    // Filtered by a label, which lists every page.
    expect(await pages(true, { channel: 'queue', label: ['kind=task'], limit: 280 })).toEqual({ threads: 280, pages: 3 })
    expect(await pages(false, { channel: 'queue', label: ['kind=task'], limit: 280 })).toEqual({ threads: 280, pages: 12 })
  })

  it("is refused a page's limit once by an API that doesn't take it, however many channels are read at once, and still asks for the messages", async () => {
    const channels = ['dev', 'ops', 'ci', 'docs']
    /** A process of its own on `api`, with each thread list read it sent and the parameters it was refused. */
    const process = (api: ReturnType<typeof fakeMessageboard>) => {
      const inner = as(api, 'user:u_jb')
      const refused: string[] = []
      const sent: URL[] = []
      const julian = board({
        backend: vercel({
          team: 'team_test',
          api: API,
          fetch: async (input, init) => {
            const url = new URL(String(input))
            const response = await inner(input, init)
            if (!url.pathname.endsWith('/threads') || (init?.method ?? 'GET') !== 'GET') return response
            sent.push(url)
            if (response.status === 400) refused.push(/`(\w+)`/.exec(((await response.clone().json()) as { error: { message: string } }).error.message)?.[1] ?? '?')
            return response
          },
        }),
      })
      return { julian, refused, sent }
    }
    const asked = (sent: URL[]) => [...new Set(sent.slice(-1).flatMap((url) => ['include', 'limit'].filter((name) => url.searchParams.has(name))))]
    for (const [options, refused, kept] of [
      [{ threadsLimit: false, inlineThreadMessages: true }, ['limit'], ['include']],
      [{ inlineThreadMessages: false }, ['include'], ['limit']],
      [{ threadsLimit: false, inlineThreadMessages: false }, ['include', 'limit'], []],
    ] as const) {
      const api = fakeMessageboard({ ...options, inlineActors: true })
      for (const channel of channels) await handleOn(api, 'user:u_ada').post(channel, { text: `in ${channel}`, labels: { kind: 'note' } })
      // Each channel's threads by a label, all at once: a read a channel, none of them answered yet.
      const { julian, refused: was, sent } = process(api)
      const pages = await Promise.all(channels.map((channel) => julian.threads({ channel, label: ['kind'] })))
      expect(pages.flatMap((page) => page.threads.map((thread) => thread.message.text)).sort()).toEqual(channels.map((channel) => `in ${channel}`).sort())
      expect(was.sort(), JSON.stringify(options)).toEqual(refused)
      // What it doesn't refuse it's still asked, and what it refused never is again.
      expect(asked(sent), JSON.stringify(options)).toEqual(kept)
      await julian.threads({ channel: 'dev', label: ['kind'] })
      expect(was.sort(), JSON.stringify(options)).toEqual(refused)
    }
  })

  it("lists a channel it reads by name 100 threads to a request, and is refused a page's limit once however many it reads by name at once", async () => {
    const channels = ['dev', 'ops', 'ci', 'docs']
    for (const options of [{ channelNames: true }, { channelNames: false }, { channelNames: true, threadsLimit: false }, { channelNames: false, threadsLimit: false }]) {
      const api = fakeMessageboard({ ...options, inlineThreadMessages: true, inlineActors: true })
      const author = handleOn(api, 'user:u_ada')
      for (let i = 0; i < 120; i++) await author.post('queue', { text: `task ${i}` })
      for (const channel of channels) await author.post(channel, { text: `in ${channel}` })
      const inner = as(api, 'user:u_jb')
      const listed: URL[] = []
      const refused: string[] = []
      const julian = board({
        backend: vercel({
          team: 'team_test',
          api: API,
          fetch: async (input, init) => {
            const url = new URL(String(input))
            const response = await inner(input, init)
            if (!url.pathname.endsWith('/threads') || (init?.method ?? 'GET') !== 'GET') return response
            listed.push(url)
            if (response.status === 400) refused.push(/`(\w+)`/.exec(((await response.clone().json()) as { error: { message: string } }).error.message)?.[1] ?? '?')
            return response
          },
        }),
      })
      const label = JSON.stringify(options)
      // Each channel by its name, all at once: an API that refuses `limit` refuses it once, and each reads its own threads.
      const read = await Promise.all(channels.map((channel) => julian.threads({ channel })))
      expect(read.map(({ threads }) => threads.map((thread) => thread.message.text)), label).toEqual(channels.map((channel) => [`in ${channel}`]))
      expect(refused.filter((name) => name === 'limit'), label).toHaveLength(options.threadsLimit === false ? 1 : 0)
      // A long one, by its name where the API takes it, a page of 100 where it takes `limit`.
      listed.length = 0
      expect((await julian.threads({ channel: 'queue', limit: 120 })).threads, label).toHaveLength(120)
      const sent = listed.map((url) => [url.searchParams.has('channel') ? 'channel' : 'channelId', url.searchParams.get('limit')])
      if (options.threadsLimit === false) expect(sent, label).toEqual(Array(5).fill([options.channelNames ? 'channel' : 'channelId', null]))
      else expect(sent, label).toEqual([[options.channelNames ? 'channel' : 'channelId', '100'], [options.channelNames ? 'channel' : 'channelId', '20']])
    }
  })

  it("refuses a before that was never one of the channel's pages, as invalid_cursor, without asking the API with it", async () => {
    const api = fakeMessageboard({ inlineThreadMessages: true })
    const { team, sent } = recording(api)
    for (let i = 0; i < 30; i++) for (const channel of ['busy', 'quiet']) await team.post(channel, { text: `thread ${i}` })
    const busy = (await team.threads({ channel: 'busy', limit: 25 })).older!
    const quiet = (await team.threads({ channel: 'quiet', limit: 25 })).older!
    // The busy channel's own cursor, at a place the API never gave.
    const { scope } = JSON.parse(Buffer.from(busy, 'base64url').toString()) as { scope: string }
    const stale = Buffer.from(JSON.stringify({ scope, value: 'x' })).toString('base64url')
    sent.length = 0
    for (const before of ['not-a-page', '~', 'abc~', `${busy}~x`, quiet])
      await expect(team.threads({ channel: 'busy', before }), before).rejects.toMatchObject({ status: 400, code: 'invalid_cursor' })
    expect(sent.filter((url) => url.pathname.endsWith('/threads'))).toEqual([])
    // One the API refuses itself is refused the same way.
    await expect(team.threads({ channel: 'busy', before: stale })).rejects.toMatchObject({ status: 400, code: 'invalid_cursor' })
  })

  it("answers a page's cursor at or behind what its threads saw, so a poll after it gets a post that landed while it read", async () => {
    const api = fakeMessageboard({ inlineThreadMessages: true, inlineActors: true })
    const other = handleOn(api)
    let landing = false
    const { team, sent } = recording(api, async (url) => {
      if (landing && url.pathname.endsWith('/threads')) {
        landing = false
        await other.post('busy', { text: 'landed in between' })
      }
    })
    await team.post('busy', { text: 'before' })
    sent.length = 0
    landing = true
    const page = await team.threads({ channel: 'busy', limit: 25 })
    const order = sent.map((url) => url.pathname.split('/').at(-1)).filter((last) => last === 'changes' || last === 'threads')
    // The head asked for by the channel's name, which Vercel's API today refuses, then the feed's head, then the list.
    expect(order).toEqual(['changes', 'changes', 'threads'])
    // The page may show it too: a cursor behind the page reads it again rather than past it.
    const { events } = await team.poll({ channel: 'busy', after: page.cursor })
    expect(events.filter((event) => event.type === 'message.posted').map((event) => event.message?.text)).toEqual(['landed in between'])
  })

  it("uploads its own code's files, one bigger than a request straight to Vercel's storage, and posts them through board()'s middleware", async () => {
    const api = fakeMessageboard()
    // Any middleware has board() look up a post's files first, before they're posted.
    const screened: string[][] = []
    const pong = pongBoard(api, [
      async ({ write, next }) => {
        if (write.kind === 'post') screened.push(write.attachments.map((file) => file.name))
        await next()
      },
    ])
    // The handle sends a file bigger than a request takes to the URL the API signs, with plain fetch.
    vi.stubGlobal('fetch', api.files)
    try {
      const log = await pong.upload({ data: new TextEncoder().encode('log'), name: 'a.log' })
      const video = new Uint8Array(ATTACHMENT_BYTES_MAX + 1).fill(7)
      const after = await pong.upload({ data: video, name: 'after.mp4', type: 'video/mp4' })
      expect(api.requests.filter((r) => r.endsWith('/complete'))).toHaveLength(2)
      const posted = await pong.post('dev', { text: 'before and after', attachments: [log.id, after.id] })
      expect(posted.attachments.map((file) => file.id)).toEqual([log.id, after.id])
      expect(screened).toEqual([['a.log', 'after.mp4']])
      expect(Buffer.from(await (await pong.download(after.id)).arrayBuffer()).equals(Buffer.from(video))).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('refuses an empty file as invalid_request, as every board does, and asks the API nothing', async () => {
    const api = fakeMessageboard()
    const pong = pongBoard(api)
    await pong.discovery()
    api.requests.length = 0
    await expect(pong.upload({ data: new Uint8Array(0), name: 'empty.log' })).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
    expect(api.requests.filter((r) => r.includes('/attachments'))).toEqual([])
  })

  it("refuses a direct upload without its bytes' SHA-256, which Vercel's API signs the upload for", async () => {
    const backend = vercel({ team: 'team_test', api: API, fetch: as(fakeMessageboard(), 'project:prj_pong:production') })
    const project = { self: null, origin: { via: { kind: 'client', name: null } } } as Caller
    const signal = new AbortController().signal
    const file = { name: 'big.mp4', type: 'video/mp4', size: 5 * 1024 * 1024 }
    await expect(backend.uploadStart(project, file, signal)).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
    expect(await backend.uploadStart(project, { ...file, sha256: `${'A'.repeat(43)}=` }, signal)).toMatchObject({ id: expect.any(String), url: expect.any(String) })
  })

  it("reads one channel from the API's message list and feed, with cursors another process resumes", async () => {
    const api = fakeMessageboard()
    const team = handleOn(api)
    const first = await team.post('busy', { text: 'one' })
    await team.reply(first.id, { text: 'two' })
    await team.post('busy', { text: 'three' })
    // A first read finds this API reads no channel by its name (below), and no later one asks.
    await team.channel('busy').messages({ limit: 1 })
    api.requests.length = 0
    const latest = await team.channel('busy').messages({ limit: 2 })
    expect(latest.messages.map((m) => m.text)).toEqual(['two', 'three'])
    expect(latest.cursor).toMatch(/^c1\./)
    // One page of the channel's messages: no thread is read message by message.
    expect(api.requests.filter((r) => r.endsWith('/messages'))).toEqual(['GET /boards/brd_test/messages'])
    // A cursor is the API's, so a handle in another process, which keeps no positions, goes on from it.
    const other = handleOn(api)
    await other.post('busy', { text: 'four' })
    expect((await other.channel('busy').messages({ after: latest.cursor })).messages.map((m) => m.text)).toEqual(['four'])
    const events = await other.poll({ channel: 'busy', after: latest.cursor })
    expect(events.events.map((e) => [e.type, e.message?.text])).toEqual([['message.posted', 'four']])
    expect((await other.poll({ channel: 'busy', after: events.cursor })).events).toEqual([])
  })

  it("reads one channel's newest messages in one request, with a cursor its messages and its feed go on from", async () => {
    const api = fakeMessageboard()
    const team = handleOn(api)
    const first = await team.post('dev', { text: 'dev one' })
    await team.post('ops', { text: 'ops one' })
    await team.reply(first.id, { text: 'dev reply' })
    await team.post('dev', { text: 'dev two' })
    await team.channel('dev').messages({ limit: 1 })
    api.requests.length = 0
    const latest = await team.channel('dev').messages({ limit: 2 })
    // Across its threads, oldest first, and nothing of another channel.
    expect(latest.messages.map((m) => [m.channel, m.text])).toEqual([['dev', 'dev reply'], ['dev', 'dev two']])
    // One page of the channel's messages: no thread is read message by message, and no other channel is asked for.
    expect(api.requests).toEqual(['GET /boards/brd_test/messages'])
    // Both go on from what it read: the next post there, and nothing it already had.
    await team.post('ops', { text: 'ops later' })
    await team.post('dev', { text: 'later' })
    expect((await team.channel('dev').messages({ after: latest.cursor })).messages.map((m) => m.text)).toEqual(['later'])
    expect((await team.poll({ channel: 'dev', after: latest.cursor })).events.map((e) => e.message?.text)).toEqual(['later'])
  })

  it("reads a channel's messages on from a cursor a page of the API's at a time, up to its limit, and from its first message after the cursor it answered before the channel was there", async () => {
    const api = fakeMessageboard()
    const team = handleOn(api)
    const texts = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `m${from + i}`)
    // Before the channel is there: nothing, and a cursor from before it had anything.
    const nothing = await team.channel('busy').messages()
    expect(nothing.messages).toEqual([])
    for (let i = 1; i <= 130; i++) {
      const posted = await team.post('busy', { text: `m${i}` })
      // What isn't a post is in the feed too, and is no message of the list's.
      if (i % 40 === 0) await team.react(posted.id, 'eyes')
    }
    api.requests.length = 0
    const start = await team.channel('busy').messages({ after: nothing.cursor, limit: 60 })
    expect(start.messages.map((m) => m.text)).toEqual(texts(1, 60))
    // Read from the feed's oldest change, never a thread at a time.
    expect(api.requests.filter((r) => r.includes('/threads'))).toEqual([])
    // Its cursor is one of the channel's own: the list goes on from it, 100 to a request, up to the read's limit.
    api.requests.length = 0
    const next = await team.channel('busy').messages({ after: start.cursor, limit: 150 })
    expect(next.messages.map((m) => m.text)).toEqual(texts(61, 130))
    // One page has them all, and the API says it caught up: no page is asked for past it.
    expect(api.requests).toEqual(['GET /boards/brd_test/messages'])
    const some = await team.channel('busy').messages({ after: start.cursor, limit: 30 })
    expect(some.messages.map((m) => m.text)).toEqual(texts(61, 90))
    expect((await team.channel('busy').messages({ after: some.cursor, limit: 500 })).messages.map((m) => m.text)).toEqual(texts(91, 130))
    // The newest are 100 at most, however many the read asks for: the API lists no more at once.
    expect((await team.channel('busy').messages({ limit: 500 })).messages.map((m) => m.text)).toEqual(texts(31, 130))
    // A cursor that isn't one of its messages' reads nothing on: a message's ID, or a read of threads'.
    const threads = await team.threads({ channel: 'busy', limit: 1 })
    for (const after of [next.messages[0]!.id, threads.cursor])
      await expect(team.channel('busy').messages({ after })).rejects.toMatchObject({ status: 400, code: 'invalid_cursor' })
  }, 30_000)

  it("makes the team's board the first time a person uses it, and tells a project it needs a grant", async () => {
    const pong = handleOn(fakeMessageboard({ boardId: null }), 'project:prj_pong:production')
    await expect(pong.post('dev', { text: 'hello' })).rejects.toMatchObject({
      status: 403,
      code: 'board_not_granted',
      message: "this project has no access to the team's board (prj_pong, production).",
      hint: "Grant it: vb grants create --project prj_pong --environment production --scope team_test --can '*=read,post,react,label'",
    })
    const api = fakeMessageboard({ boardId: null })
    await handleOn(api).post('dev', { text: 'hello' })
    expect(api.requests.filter((r) => r === 'POST /boards/default')).toHaveLength(1)
    expect((await handleOn(api).channel('dev').messages()).messages.map((m) => m.text)).toEqual(['hello'])
  })

  it('says what the API says its credentials may do, and until when, and what any it lets in may when it says neither', async () => {
    const said = async (handle: ReturnType<typeof handleOn>) => {
      const { can, expiresAt } = await handle.me()
      return { can, expiresAt }
    }
    const everything = { can: { '*': ['read', 'post', 'react', 'label', 'sync', 'manage'] }, expiresAt: null }
    // A person may do what their team role lets them; a project, what any credentials the API lets in may.
    const api = fakeMessageboard({ roles: { u_jb: 'owner', u_ada: 'viewer' } })
    expect(await said(handleOn(api, 'user:u_jb'))).toEqual(everything)
    expect(await said(handleOn(api, 'user:u_ada'))).toEqual({ can: { '*': ['read', 'react'] }, expiresAt: null })
    expect(await said(handleOn(api, 'project:prj_pong:production'))).toEqual({ can: { '*': ['read', 'post', 'react', 'label', 'sync'] }, expiresAt: null })
    for (const role of ['member', 'developer'] as const) expect(await said(handleOn(fakeMessageboard({ roles: { u_jb: role } })))).toEqual(everything)
    // Credentials it says less of, and until when: board's own permissions, as it gives them.
    const expiresAt = Date.now() + 59 * 60_000
    const narrowed = fakeMessageboard({ me: { 'user:u_jb': { can: { 'pings/': ['read', 'post'], 'dev/': ['read', 'fly'] }, expiresAt } } })
    expect(await said(handleOn(narrowed))).toEqual({ can: { 'pings/': ['read', 'post'], 'dev/': ['read'] }, expiresAt: new Date(expiresAt).toISOString() })
    // As board's own me says it: a pattern board can't read dropped, so the summary compiles, what
    // each permission implies, as label does read, and a pattern left with nothing left out.
    const odd = fakeMessageboard({ me: { 'user:u_jb': { can: { 'dev*': ['label'], ops: ['label'], 'ci/': ['fly'] }, expiresAt: null } } })
    const { can } = await said(handleOn(odd))
    expect(can).toEqual({ ops: ['read', 'label'] })
    expect(compileAccess(can).summary()).toEqual(can)
    // Epoch seconds, as a JWT's exp, aren't 1970: under 10^12, a number is read as seconds.
    const seconds = Math.floor(expiresAt / 1000)
    const jwtStyle = fakeMessageboard({ me: { 'user:u_jb': { can: { '*': ['read'] }, expiresAt: seconds } } })
    expect((await said(handleOn(jwtStyle))).expiresAt).toBe(new Date(seconds * 1000).toISOString())
    // An API that says neither, as before it sent them: what any credentials it lets in may do, with no expiry.
    expect(await said(handleOn(fakeMessageboard({ me: false }), 'user:u_jb'))).toEqual({ can: { '*': ['read', 'post', 'react', 'label'] }, expiresAt: null })
  })

  it("says what the board's grants leave its credentials there, a channel they close included", async () => {
    const api = fakeMessageboard()
    const jb = handleOn(api, 'user:u_jb')
    const all = ['read', 'post', 'react', 'label', 'sync', 'manage']
    await jb.createGrant({ principals: [{ kind: 'everyone' }], can: { 'security/': [] } })
    await jb.createGrant({ principals: [{ kind: 'project', project: 'pong', environments: ['production'] }], can: { 'ci/': ['read', 'post'] } })
    expect((await jb.me()).can).toEqual({ '*': all, 'security/': [] })
    expect((await handleOn(api, 'project:prj_pong:production').me()).can).toEqual({
      '*': ['read', 'post', 'react', 'label', 'sync'],
      'ci/': ['read', 'post'],
      'security/': [],
    })
  })

  it('asks its board what its credentials may do there, and tells a project the board shuts out that it needs a grant', async () => {
    const api = fakeMessageboard()
    await handleOn(api, 'user:u_jb').me()
    expect(api.requests.filter((request) => request.endsWith('/me'))).toEqual(['GET /boards/brd_test/me'])
    await expect(handleOn(fakeMessageboard({ boardId: null }), 'project:prj_pong:production').me()).rejects.toMatchObject({ status: 403, code: 'board_not_granted' })
  })

  it("never sends VERCEL_TOKEN: a deployment sends its own OIDC token, so its watchers register as its project, and anyone else BOARD_TOKEN or their login", async () => {
    for (const key of Object.keys(process.env)) if (/^(BOARD|VERCEL|CLAUDE|CODEX|GROK|CURSOR|PI_|AI_AGENT)/.test(key)) vi.stubEnv(key, '')
    onTestFinished(() => {
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
    })
    // The deployment's OIDC token, a JWT that names its own team, as Vercel's does.
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const oidc = `${part({ alg: 'none' })}.${part({ owner_id: 'team_test', exp: Math.floor(Date.now() / 1000) + 3600 })}.`
    const api = fakeMessageboard({ tokens: { [oidc]: 'project:prj_pong:production', k7Qe2mXa9vLp: 'user:u_bo' } })
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => api.fetch(input, init))
    // Someone set VERCEL_TOKEN so the app could call Vercel's API: a person's. BOARD_TOKEN is for a board at a URL.
    for (const [key, set] of Object.entries({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_OIDC_TOKEN: oidc, VERCEL_TOKEN: 'user:u_jb', BOARD_TOKEN: 'k7Qe2mXa9vLp' })) vi.stubEnv(key, set)
    const backend = nodeVercel()
    onTestFinished(() => backend.close())
    const pong = board({ backend, url: 'https://pong.vercel.app/api/board', watch: { pings: { tail: 'pings', run: async () => {} } } })
    expect((await pong.me()).principal).toBe('vercel:project:prj_pong:production')
    await vi.waitFor(() => expect(api.registrations.get('vercel:project:prj_pong:production')).toMatchObject({ path: '/api/board' }))
    expect(credentialSource()).toBe('Vercel OIDC')
    // Off a deployment, in a terminal, CI or a sandbox: BOARD_TOKEN, then the login a CLI hands it, and never VERCEL_TOKEN.
    for (const [key, set] of Object.entries({ VERCEL: '', VERCEL_OIDC_TOKEN: '', VERCEL_ORG_ID: 'team_test', VERCEL_AUTH_TOKEN: 'user:u_ada' })) vi.stubEnv(key, set)
    expect((await board({ backend: nodeVercel() }).me()).principal).toBe('vercel:user:u_bo')
    expect(credentialSource()).toBe('BOARD_TOKEN')
    vi.stubEnv('BOARD_TOKEN', '')
    expect((await board({ backend: nodeVercel() }).me()).principal).toBe('vercel:user:u_ada')
    expect(credentialSource()).toBe('the Vercel CLI')
  })

  describe('a board by its name', () => {
    /** A handle on the team's board named `name`, through vercel(), as `principal`. */
    const named = (api: ReturnType<typeof fakeMessageboard>, name: string, principal = 'user:u_jb') =>
      board({ name, backend: vercel({ team: 'team_test', api: API, fetch: as(api, principal) }) })
    const lookups = (api: ReturnType<typeof fakeMessageboard>, request: string) => api.requests.filter((made) => made === request).length

    it('uses the board with that name, whatever its case, apart from the default board, and looks it up once', async () => {
      const api = fakeMessageboard({ boards: [{ name: 'Security', id: 'brd_sec' }] })
      const security = named(api, 'security')
      await security.post('dev', { text: 'rotate the keys' })
      await security.post('dev', { text: 'done' })
      expect(lookups(api, 'GET /boards')).toBe(1)
      expect((await named(api, 'SECURITY').channel('dev').messages()).messages.map((m) => m.text)).toEqual(['rotate the keys', 'done'])
      expect((await handleOn(api).channel('dev').messages()).messages).toEqual([])
      expect(await security.discovery()).toMatchObject({ url: `${API}/v1/messageboard/boards/brd_sec?teamId=team_test` })
      // The default board is named General, so its name finds it too.
      expect(await named(api, 'general').discovery()).toMatchObject({ url: `${API}/v1/messageboard/boards/brd_test?teamId=team_test` })
    })

    it('makes the board the first time its project uses it, granted to that project in its environment', async () => {
      const api = fakeMessageboard()
      await named(api, 'security', 'project:prj_pong:production').post('dev', { text: 'from pong' })
      expect(lookups(api, 'POST /boards/ensure')).toBe(1)
      // Another process of the project finds it, and makes nothing.
      await named(api, 'security', 'project:prj_pong:production').post('dev', { text: 'again' })
      expect(lookups(api, 'POST /boards/ensure')).toBe(1)
      // It's the team's: a person reads it.
      expect((await named(api, 'security').channel('dev').messages()).messages.map((m) => m.text)).toEqual(['from pong', 'again'])
      // The project's preview isn't granted it, and is told who fixes that.
      await expect(named(api, 'security', 'project:prj_pong:preview').post('dev', { text: 'from a preview' })).rejects.toMatchObject({
        status: 403,
        code: 'board_not_granted',
        origin: 'handle',
        message: 'this project has no access to board security (prj_pong, preview).',
        hint: "Grant it: vb grants create --project prj_pong --environment preview --name security --scope team_test --can '*=read,post,react,label'",
      })
    })

    it('makes the board for a person too, by default, once, as the team sees it', async () => {
      const api = fakeMessageboard()
      await named(api, 'security').post('dev', { text: 'rotate the keys' })
      // Another process finds it by its name, and makes nothing more.
      await named(api, 'security').post('dev', { text: 'done' })
      expect(lookups(api, 'POST /boards/ensure')).toBe(1)
      // It's the team's: someone else reads it by its name.
      expect((await named(api, 'security', 'user:u_ada').channel('dev').messages()).messages.map((m) => m.text)).toEqual(['rotate the keys', 'done'])
    })

    it('makes none for a caller that says ensure: false, and says there is none it can see', async () => {
      const api = fakeMessageboard()
      const found = (principal: string) => board({ name: 'security', ensure: false, backend: vercel({ team: 'team_test', api: API, fetch: as(api, principal) }) })
      for (const principal of ['user:u_jb', 'project:prj_pong:production'])
        await expect(found(principal).post('dev', { text: 'hi' })).rejects.toMatchObject({
          status: 404,
          code: 'no_board',
          origin: 'handle',
          message: 'no board named security on this team, or none you can see.',
        })
      expect(lookups(api, 'POST /boards/ensure')).toBe(0)
    })

    it("says a name is another board's that you can't see, and makes none", async () => {
      const api = fakeMessageboard({ boards: [{ name: 'vault', id: 'brd_vault', members: ['u_ada'] }] })
      const ensured = board({ name: 'Vault', ensure: true, backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'user:u_jb') }) })
      await expect(ensured.post('dev', { text: 'hi' })).rejects.toMatchObject({
        status: 409,
        code: 'board_name_taken',
        origin: 'handle',
        message: 'the board name Vault is taken.',
        hint: 'Pick another name, or ask whoever can see it for access.',
      })
      // Its member still reads it, and nothing was posted there.
      expect((await named(api, 'vault', 'user:u_ada').channel('dev').messages()).messages).toEqual([])
    })

    it('finds a board by a name that fits in 64 characters once trimmed and NFC-normalized, as the API counts it', async () => {
      const long = 'é'.repeat(64)
      const api = fakeMessageboard({ boards: [{ name: long, id: 'brd_long' }] })
      for (const name of [long.normalize('NFD'), ` ${long} `])
        expect(await named(api, name).discovery()).toMatchObject({ url: `${API}/v1/messageboard/boards/brd_long?teamId=team_test` })
      expect(lookups(api, 'POST /boards/ensure')).toBe(0)
    })

    it('takes ensure only with a name', () => {
      expect(() => board({ ensure: true, backend: vercel({ team: 'team_test', api: API, fetch: as(fakeMessageboard(), 'user:u_jb') }) })).toThrow('ensure makes the board `name` names: pass name too')
    })

    it('takes the first board the API lists for a name an older board shares, and makes none', async () => {
      // The API lists the oldest first: here the default board, General, made before brd_old.
      const api = fakeMessageboard({ boards: [{ name: 'general', id: 'brd_old', granted: ['prj_pong:production'] }] })
      for (const principal of ['user:u_jb', 'project:prj_pong:production']) await named(api, 'General', principal).post('dev', { text: `from ${principal}` })
      expect((await handleOn(api).channel('dev').messages()).messages.map((m) => m.text)).toEqual(['from user:u_jb', 'from project:prj_pong:production'])
      expect(lookups(api, 'POST /boards/ensure')).toBe(0)
    })

    it("takes another team's board by its team and name, or that team's default board by its team alone", async () => {
      const api = fakeMessageboard({ slug: 'acme', boards: [{ name: 'security' }] })
      const teams: (string | null)[] = []
      const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const { searchParams } = new URL(String(input instanceof Request ? input.url : input))
        teams.push(searchParams.get('slug') ?? searchParams.get('teamId'))
        return as(api, 'user:u_jb')(input, init)
      }) as typeof globalThis.fetch
      await board({ team: 'acme', name: 'security', backend: vercel({ api: API, fetch }) }).post('dev', { text: 'for acme security' })
      await board({ team: 'acme', backend: vercel({ api: API, fetch }) }).post('dev', { text: "on acme's default board" })
      expect(new Set(teams)).toEqual(new Set(['acme']))
      expect((await handleOn(api).channel('dev').messages()).messages.map((m) => m.text)).toEqual(["on acme's default board"])
      expect((await named(api, 'security').channel('dev').messages()).messages.map((m) => m.text)).toEqual(['for acme security'])
      // vercel()'s own team is board()'s, or nothing binds.
      board({ team: 'acme', backend: vercel({ team: 'acme', api: API, fetch }) })
      expect(() => board({ team: 'acme', backend: vercel({ team: 'team_test', api: API, fetch }) })).toThrow('name the team once')
      // Its own board ID wins over the name, as the CLI's URL form passes it.
      const byId = board({ name: 'nope', backend: vercel({ board: 'brd_test', team: 'acme', api: API, fetch }) })
      expect((await byId.channel('dev').messages()).messages.map((m) => m.text)).toEqual(["on acme's default board"])
    })
  })

  it("says the team's ID in its discovery, though it's named by its slug", async () => {
    const api = fakeMessageboard({ slug: 'acme' })
    const team = board({ backend: vercel({ team: 'acme', api: API, fetch: as(api, 'user:u_jb') }) })
    expect(await team.discovery()).toMatchObject({ team_id: 'team_test' })
  })

  it("says the board's name in its discovery, and none to a caller who may not read the board", async () => {
    const api = fakeMessageboard({ boards: [{ name: 'Security', id: 'brd_sec' }] })
    expect(await handleOn(api).discovery()).toMatchObject({ name: 'General' })
    const security = board({ name: 'security', backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'user:u_jb') }) })
    expect(await security.discovery()).toMatchObject({ name: 'Security' })
    // Found as the team's default, by a caller who only posts: where it is, and no name.
    const poster = await withHeadersOn(api)({ 'x-board-can': 'dev/=post' }).discovery()
    expect(poster).toMatchObject({ url: `${API}/v1/messageboard/boards/brd_test?teamId=team_test` })
    expect(poster).not.toHaveProperty('name')
    // A handle narrowed with a can asks as it's narrowed: the name is for one that reads somewhere.
    const team = handleOn(api)
    expect(await team.as('fixer', { can: { 'dev/': ['read'] } }).discovery()).toMatchObject({ name: 'General' })
    // One that reads nowhere gets none, whatever the API would answer: the board isn't read for it.
    const reads = () => api.requests.filter((made) => made === 'GET /boards/brd_test').length
    const asked = reads()
    expect(await team.as('fixer', { can: { 'dev/': ['post'] } }).discovery()).not.toHaveProperty('name')
    expect(await team.as('fixer', { can: {} }).discovery()).not.toHaveProperty('name')
    expect(reads()).toBe(asked)
    // One on a board named by its ID still learns where it is, and no name it may not read.
    const onSecurity = board({ backend: vercel({ team: 'team_test', board: 'brd_sec', api: API, fetch: as(api, 'user:u_jb') }) })
    expect(await onSecurity.discovery()).toMatchObject({ name: 'Security' })
    const posting = await onSecurity.as('fixer', { can: { 'dev/': ['post'] } }).discovery()
    expect(posting).toMatchObject({ url: `${API}/v1/messageboard/boards/brd_sec?teamId=team_test` })
    expect(posting).not.toHaveProperty('name')
    // Named by its ID, it's read either way, so a credential that's narrowed itself is told it can't.
    const byId = board({ backend: vercel({ team: 'team_test', board: 'brd_sec', api: API, fetch: (input, init = {}) => as(api, 'user:u_jb')(input, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), 'x-board-can': 'dev/=post' } }) }) })
    await expect(byId.discovery()).rejects.toMatchObject({ status: 403 })
  })

  it("reads on from a cursor as the API's cursor, and asks for no page past one the API says caught up", async () => {
    const api = fakeMessageboard()
    const asked: URL[] = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/messages')) asked.push(url)
      return as(api, 'user:u_jb')(input, init)
    }
    const team = board({ backend: vercel({ team: 'team_test', api: API, fetch, files: api.files }) })
    await team.post('busy', { text: 'm0' })
    const { cursor } = await team.channel('busy').messages()
    for (let i = 1; i <= 3; i++) await team.post('busy', { text: `m${i}` })
    asked.length = 0
    expect((await team.channel('busy').messages({ after: cursor })).messages.map((m) => m.text)).toEqual(['m1', 'm2', 'm3'])
    expect(asked.map((url) => [url.searchParams.get('cursor'), url.searchParams.has('after')])).toEqual([[cursor, false]])
    // A read that finds fewer than it asks for stops there too.
    asked.length = 0
    expect((await team.channel('busy').messages({ after: cursor, limit: 10 })).messages.map((m) => m.text)).toEqual(['m1', 'm2', 'm3'])
    expect(asked).toHaveLength(1)
  })

  it("reads past the API's page of 100 after a cursor, as many as a read asks for", async () => {
    const api = fakeMessageboard()
    const team = handleOn(api)
    await team.post('busy', { text: 'm0' })
    const { cursor } = await team.channel('busy').messages()
    // The API's own cursor, so the read is the one-channel one.
    expect(cursor).toMatch(/^c1\./)
    for (let i = 1; i <= 130; i++) await team.post('busy', { text: `m${i}` })
    const after = await team.channel('busy').messages({ after: cursor, limit: 120 })
    expect(after.messages.map((m) => m.text)).toEqual(Array.from({ length: 120 }, (_, i) => `m${i + 1}`))
    // From the newest, it's the API's one page: it lists no further back.
    expect((await team.channel('busy').messages({ limit: 120 })).messages).toHaveLength(100)
  }, 30_000)

  it("waits on every channel's feed at once for a read across channels, asking nothing more until one answers", async () => {
    const api = fakeMessageboard()
    const changes: number[] = []
    const fetching = as(api, 'user:u_jb')
    const counted = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input instanceof Request ? input.url : input)).pathname.endsWith('/changes')) changes.push(Date.now())
      return fetching(input, init)
    }) as typeof fetch
    const team = board({ backend: vercel({ team: 'team_test', api: API, fetch: counted, files: api.files }) })
    for (const channel of ['dev', 'ops', 'web']) await team.post(channel, { text: `hi ${channel}` })
    const { cursor } = await team.poll({})
    const waiting = team.poll({ after: cursor, wait: 5 })
    await new Promise((resolve) => setTimeout(resolve, 500))
    const settled = changes.length
    // Idle, the API hears nothing more: each channel's long-poll holds.
    await new Promise((resolve) => setTimeout(resolve, 2000))
    expect(changes.length).toBe(settled)
    const posted = Date.now()
    await team.post('ops', { text: 'later' })
    const page = await waiting
    expect(page.events.map((event) => event.message?.text)).toEqual(['later'])
    expect(Date.now() - posted).toBeLessThan(1000)
  }, 15_000)

  it('reads every channel at most once a second across channels, however busy the board, when the filter matches nothing', async () => {
    const api = fakeMessageboard()
    let changes = 0
    const fetching = as(api, 'user:u_jb')
    const counted = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input instanceof Request ? input.url : input)).pathname.endsWith('/changes')) changes++
      return fetching(input, init)
    }) as typeof fetch
    const team = board({ backend: vercel({ team: 'team_test', api: API, fetch: counted, files: api.files }) })
    for (const channel of ['dev', 'ops', 'web']) await team.post(channel, { text: `hi ${channel}` })
    const channels = (await team.channels()).channels.length
    const { cursor } = await team.poll({})
    const before = changes
    // No one by this name posts, so every change wakes the wait and the read finds nothing.
    const waiting = team.poll({ after: cursor, by: 'nobody', wait: 5 })
    const busy = setInterval(() => void team.post('ops', { text: 'busy' }), 50)
    const page = await waiting.finally(() => clearInterval(busy))
    expect(page.events).toEqual([])
    // A wait on each channel, which wakes at once, then a read of each every second for 5 seconds:
    // 1 + 6, and 1 to spare for a slow runner, where the first wake can miss its second. Waiting at
    // every wake, as each second's read did before it fell back, is 5 + 6.
    expect(changes - before).toBeLessThanOrEqual(channels * (1 + 6 + 1))
  }, 15_000)

  it("waits in a thread on its channel's feed alone, and reads no message a feed brought", async () => {
    const api = fakeMessageboard()
    const team = handleOn(api)
    for (const channel of ['dev', 'ops', 'web', 'docs']) await team.post(channel, { text: `hi ${channel}` })
    const root = await team.post('questions', { text: 'anyone?' })
    const count = () => ({
      feeds: api.requests.filter((r) => /\/changes$/.test(r)).length,
      byId: api.requests.filter((r) => /\/messages\/msg_/.test(r)).length,
    })
    // A wait in the thread: only `questions` has its messages, whatever else the board holds.
    api.requests.length = 0
    const waiting = team.poll({ re: root.id, wait: 5 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await team.reply(root.id, { text: 'me!' })
    expect((await waiting).events.map((event) => event.message?.text)).toEqual(['me!'])
    // Its channel's feed alone: where it is now, a read, the wait, and the read once it wakes. With the
    // other four channels' feeds it is five times that.
    expect(count().feeds).toBeLessThanOrEqual(5)
    // Across the board, each change comes with its message: 20 posts cost no read by ID to show.
    const { cursor } = await team.poll({})
    for (let i = 0; i < 20; i++) await team.post(['dev', 'ops', 'web', 'docs'][i % 4]!, { text: `post ${i}` })
    api.requests.length = 0
    const everything = await team.poll({ after: cursor })
    expect(everything.events.map((event) => event.message?.text)).toEqual(Array.from({ length: 20 }, (_, i) => `post ${i}`))
    expect(count().byId).toBe(0)
  }, 15_000)

  it('waits after a message for what comes after it: not its own posting, and nothing older from a feed that runs past a page', async () => {
    const api = fakeMessageboard()
    const team = handleOn(api)
    // In its thread, from the message itself, as `vb wait --re 812 --after 812` asks.
    const root = await team.post('questions', { text: 'anyone?' })
    expect((await team.poll({ re: root.id, after: root.id, wait: 1 })).events).toEqual([])
    const waiting = team.poll({ re: root.id, after: root.id, wait: 5 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await team.reply(root.id, { text: 'me!' })
    expect((await waiting).events.map((event) => event.message?.text)).toEqual(['me!'])
    // The API's feed comes a page at a time from its oldest change: 60 older posts are two pages before it.
    for (let i = 0; i < 60; i++) await team.post('busy', { text: `old ${i}` })
    const newest = await team.post('busy', { text: 'newest' })
    expect((await team.poll({ channel: 'busy', after: newest.id, wait: 2 })).events).toEqual([])
    const later = team.poll({ channel: 'busy', after: newest.id, wait: 5 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await team.post('busy', { text: 'after it' })
    const [event] = (await later).events
    expect(event?.message?.text).toBe('after it')
    // The cursor it came with goes on from there, as the `next:` a wait prints does: in another process, which holds
    // only its time, and in this one, where a second channel with pages of history hasn't caught up yet.
    for (let i = 0; i < 60; i++) await team.post('other', { text: `other ${i}` })
    const question = await team.post('busy', { text: 'q' })
    await team.reply(question.id, { text: 'answer' })
    const [answer] = (await team.poll({ after: question.id, wait: 5 })).events
    expect(answer?.message?.text).toBe('answer')
    expect((await handleOn(api).poll({ after: answer!.cursor, wait: 2 })).events).toEqual([])
    expect((await team.poll({ after: answer!.cursor, wait: 2 })).events).toEqual([])
  }, 30_000)

  it('finds an older thread by labels the API can only filter after it lists, and refuses a cursor it can’t read', async () => {
    const api = fakeMessageboard()
    const team = handleOn(api)
    await team.post('dev', { text: 'open one', labels: { state: 'open' } })
    for (let i = 0; i < 5; i++) await team.post('dev', { text: `plain ${i}` })
    const { threads } = await team.threads({ channel: 'dev', label: { state: 'open|wip' }, limit: 2 })
    expect(threads.map((thread) => thread.message.text)).toEqual(['open one'])
    await expect(team.channel('dev').messages({ after: '!!' })).rejects.toMatchObject({ status: 400, code: 'invalid_cursor' })
  })

  it('leaves a deleted root out of every read by its labels, though the API still lists it by them', async () => {
    const api = fakeMessageboard()
    const team = handleOn(api)
    const open = { state: 'open' }
    const kept = await team.post('dev', { text: 'kept', labels: open })
    const keptReply = await team.reply(kept.id, { text: 'under kept' })
    const gone = await team.post('dev', { text: 'gone', labels: open })
    const goneReply = await team.reply(gone.id, { text: 'under gone' })
    const { cursor } = await team.poll({ label: open })
    await team.delete(gone.id)
    // The newest thread its labels find is the deleted one: a page of one fills past it.
    expect((await team.threads({ channel: 'dev', label: open, limit: 1 })).threads.map((t) => t.message.text)).toEqual(['kept'])
    await team.edit(goneReply.id, 'under gone, edited')
    await team.edit(keptReply.id, 'under kept, edited')
    const { events } = await team.poll({ label: open, after: cursor })
    expect(events.filter((event) => event.type === 'message.edited').map((event) => event.message?.text)).toEqual(['under kept, edited'])
  })

  // On Vercel's board the match happens in Vercel's API, and nothing in vercel() filters a watcher's
  // own events: this pins the API's fake to the rule the API follows, and that a match it hands out runs.
  it("runs a watcher on the check-in it scheduled itself, which the API's fake matches as Vercel's API should", async () => {
    for (const [name, value] of Object.entries({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_TARGET_ENV: '', VERCEL_GIT_COMMIT_REF: '' })) vi.stubEnv(name, value)
    onTestFinished(() => void vi.unstubAllEnvs())
    const api = fakeMessageboard()
    const ran: string[] = []
    const pong = board({
      backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production') }),
      url: 'https://pong.example/api/board',
      basePath: '/api/board',
      watch: {
        ci: {
          tail: 'builds',
          run: async ({ event, board: own }) => {
            if (event.type !== 'message.posted') return
            ran.push(event.message!.text)
            if (event.message!.schedule) await own.reply(event.message!.id, { text: 'still red' })
            else await own.schedule({ re: event.message!.id }, { text: 'check on CI', in: '5m' })
          },
        },
      },
    })
    await pong.me()
    while (!api.registrations.has('vercel:project:prj_pong:production')) await new Promise((resolve) => setTimeout(resolve, 5))
    const root = await handleOn(api).post('builds', { text: 'the build is red' })
    const wake = () => pong.fetch(new Request('https://pong.example/api/board/wake', { method: 'POST' })).then((response) => response.json())
    await expect(wake()).resolves.toEqual({ ran: 1 })
    // The API posts the check-in when it's due, as the watcher that scheduled it: its own write, and it still wakes it.
    const [schedule] = await pong.schedules({ re: root.id })
    api.send(schedule!.id)
    await expect(wake()).resolves.toEqual({ ran: 1 })
    expect(ran).toEqual(['the build is red', 'check on CI'])
    const { replies } = await pong.thread(root.id)
    expect(replies.map((reply) => [reply.text, reply.by.actor])).toEqual([
      ['check on CI', 'vercel:project:prj_pong:production+ci'],
      ['still red', 'vercel:project:prj_pong:production+ci'],
    ])
    // The reply it then wrote is its own too, and wakes nothing.
    await expect(wake()).resolves.toEqual({ ran: 0 })
  })

  it("registers a production deployment's watchers by its path, and runs what they matched when it's woken", async () => {
    for (const [name, value] of Object.entries({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_TARGET_ENV: '', VERCEL_GIT_COMMIT_REF: '' })) vi.stubEnv(name, value)
    onTestFinished(() => void vi.unstubAllEnvs())
    const api = fakeMessageboard()
    const ran: string[] = []
    const pong = board({
      backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production') }),
      url: 'https://pong.example/api/board',
      basePath: '/api/board',
      watch: {
        pings: {
          tail: 'pings',
          run: async ({ event, board: own }) => {
            ran.push(event.message!.text)
            await own.reply(event.message!.id, { text: 'pong' })
          },
        },
      },
    })
    await pong.me()
    while (!api.registrations.has('vercel:project:prj_pong:production')) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(api.registrations.get('vercel:project:prj_pong:production')).toMatchObject({ path: '/api/board' })
    await handleOn(api).post('pings', { text: 'ping' })
    const wake = () => pong.fetch(new Request('https://pong.example/api/board/wake', { method: 'POST' })).then((response) => response.json())
    await expect(wake()).resolves.toEqual({ ran: 1 })
    expect(ran).toEqual(['ping'])
    // Its reply is its own watcher's, which never wakes it.
    await expect(wake()).resolves.toEqual({ ran: 0 })
    // A wake-up carries back the hash it registered with: with the current one, nothing registers again.
    const registered = () => api.requests.filter((request) => request.startsWith('PUT ') && request.endsWith('/watchers')).length
    const before = registered()
    const { hash } = api.registrations.get('vercel:project:prj_pong:production')!
    await pong.fetch(new Request('https://pong.example/api/board/wake', { method: 'POST', headers: { 'x-board-watchers': hash } }))
    expect(registered()).toBe(before)
  })

  it("keeps the registration a call starts running after the response, through Vercel's waitUntil", async () => {
    for (const [name, value] of Object.entries({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_TARGET_ENV: '', VERCEL_GIT_COMMIT_REF: '' })) vi.stubEnv(name, value)
    onTestFinished(() => void vi.unstubAllEnvs())
    const kept: Promise<unknown>[] = []
    const context = Symbol.for('@vercel/request-context')
    Reflect.set(globalThis, context, { get: () => ({ waitUntil: (task: Promise<unknown>) => void kept.push(task) }) })
    onTestFinished(() => void Reflect.deleteProperty(globalThis, context))
    const api = fakeMessageboard()
    const pong = board({
      backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production') }),
      url: 'https://pong.example/api/board',
      basePath: '/api/board',
      watch: { pings: { tail: 'pings', run: async () => {} } },
    })
    await pong.me()
    // A function can freeze once it answers, so what the call started is handed to the platform to finish.
    expect(kept.length).toBeGreaterThan(0)
    await Promise.all(kept)
    expect(api.registrations.get('vercel:project:prj_pong:production')).toMatchObject({ path: '/api/board' })
  })

  it('registers a deployment off Vercel with no url, and pulls what its watchers match, with its env pulled too', async () => {
    // What `vercel env pull` writes to .env.local, and `vercel dev` sets: a dev server, which stays up.
    for (const [name, value] of Object.entries({ VERCEL: '1', VERCEL_ENV: 'development', VERCEL_TARGET_ENV: 'development', VERCEL_GIT_COMMIT_REF: '' })) vi.stubEnv(name, value)
    onTestFinished(() => void vi.unstubAllEnvs())
    const api = fakeMessageboard()
    const ran: string[] = []
    const backend = vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:development') })
    onTestFinished(() => backend.close())
    const pong = board({
      backend,
      url: 'https://pong.example/api/board',
      watch: {
        pings: {
          tail: 'pings',
          run: async ({ event, board: own }) => {
            if (event.type !== 'message.posted') return
            ran.push(event.message!.text)
            await own.reply(event.message!.id, 'pong')
          },
        },
      },
    })
    await pong.me()
    // With no path, and no url, which the API refuses: it pulls.
    await vi.waitFor(() => expect(api.registrations.has('vercel:project:prj_pong:development')).toBe(true))
    expect(api.registrations.get('vercel:project:prj_pong:development')!.path).toBeUndefined()
    // Nothing wakes it: it pulls the match itself.
    const ping = await handleOn(api, 'user:u_ada').post('pings', 'ping')
    await vi.waitFor(() => expect(ran).toEqual(['ping']))
    await vi.waitFor(async () => expect((await pong.thread(ping.id)).replies.map((reply) => [reply.text, reply.by.actor])).toEqual([['pong', 'vercel:project:prj_pong:development+pings']]))
  })

  it('hands out each match with the message the pull brought, and reads one by ID only where the pull brought none', async () => {
    for (const [name, value] of Object.entries({ VERCEL: '1', VERCEL_ENV: 'development', VERCEL_TARGET_ENV: 'development', VERCEL_GIT_COMMIT_REF: '' })) vi.stubEnv(name, value)
    onTestFinished(() => void vi.unstubAllEnvs())
    const handedOut = async (matchMessages: boolean) => {
      const api = fakeMessageboard({ matchMessages, channelNames: true })
      const ran: string[] = []
      const backend = vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:development') })
      onTestFinished(() => backend.close())
      const pong = board({ backend, url: 'https://pong.example/api/board', watch: { pings: { tail: 'pings', run: async ({ event }) => void ran.push(event.message!.text) } } })
      await pong.me()
      await vi.waitFor(() => expect(api.registrations.has('vercel:project:prj_pong:development')).toBe(true))
      const ada = handleOn(api, 'user:u_ada')
      api.requests.length = 0
      for (let i = 0; i < 5; i++) await ada.post('pings', `ping ${i}`)
      await vi.waitFor(() => expect(ran).toHaveLength(5))
      // Which messages were read by ID: the fallback reads each match's, the first sometimes twice.
      return { ran, byId: new Set(api.requests.filter((request) => /^GET .*\/messages\/msg_[^/]*$/.test(request))).size }
    }
    const pings = ['ping 0', 'ping 1', 'ping 2', 'ping 3', 'ping 4']
    expect(await handedOut(true)).toEqual({ ran: pings, byId: 0 })
    expect(await handedOut(false)).toEqual({ ran: pings, byId: 5 })
  })

  it('registers its path from a custom environment and a preview with no branch, and never pulls on its own there', async () => {
    onTestFinished(() => void vi.unstubAllEnvs())
    for (const [environment, env] of [
      ['staging', { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'staging', VERCEL_GIT_COMMIT_REF: '' }],
      // A `vercel deploy` preview: it names no branch, and the API wakes that deployment itself.
      ['preview', { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: '', VERCEL_GIT_COMMIT_REF: '' }],
    ] as const) {
      for (const [name, value] of Object.entries({ VERCEL: '1', ...env })) vi.stubEnv(name, value)
      const api = fakeMessageboard()
      const ran: string[] = []
      const backend = vercel({ team: 'team_test', api: API, fetch: as(api, `project:prj_pong:${environment}`) })
      onTestFinished(() => backend.close())
      const pong = board({ backend, url: 'https://pong-abc123.vercel.app/api/board', watch: { pings: { tail: 'pings', run: async ({ event }) => void ran.push(event.message!.text) } } })
      await pong.me()
      await vi.waitFor(() => expect(api.registrations.has(`vercel:project:prj_pong:${environment}`)).toBe(true))
      expect(api.registrations.get(`vercel:project:prj_pong:${environment}`)).toMatchObject({ path: '/api/board' })
      expect(api.registrations.get(`vercel:project:prj_pong:${environment}`)!.branch).toBeUndefined()
      await handleOn(api, 'user:u_ada').post('pings', 'ping')
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect([environment, ran, api.requests.filter((request) => request.includes('/watchers/matches'))]).toEqual([environment, [], []])
    }
  })

  it('never pulls on its own on Vercel, even with a registration nothing wakes', async () => {
    for (const [name, value] of Object.entries({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_TARGET_ENV: '', VERCEL_GIT_COMMIT_REF: '' })) vi.stubEnv(name, value)
    onTestFinished(() => void vi.unstubAllEnvs())
    const api = fakeMessageboard()
    const ran: string[] = []
    const backend = vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production') })
    onTestFinished(() => backend.close())
    // A URL that isn't https, so no path comes of it: the registration it asks for would pull, off Vercel.
    const pong = board({ backend, url: 'http://pong.internal/api/board', watch: { pings: { tail: 'pings', run: async ({ event }) => void ran.push(event.message!.text) } } })
    const registered = await pong.fetch(new Request('http://pong.internal/api/board/watchers', { method: 'POST' }))
    expect(await registered.json()).toMatchObject({ url: null })
    await handleOn(api, 'user:u_ada').post('pings', 'ping')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(ran).toEqual([])
    expect(api.requests.filter((request) => request.includes('/watchers/matches'))).toEqual([])
  })

  it('never sends Vercel\'s API a url to wake, and the API takes none', async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    await expect(pong.register({ url: 'https://pong.example/api/board', watch: {} })).rejects.toMatchObject({ status: 400, code: 'invalid_request', origin: 'handle' })
    expect(api.requests.filter((request) => request.startsWith('PUT '))).toEqual([])
    const sent = await as(api, 'project:prj_pong:production')(`${API}/v1/messageboard/boards/brd_test/watchers?teamId=team_test`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://pong.example/api/board', watch: {} }),
    })
    expect(sent.status).toBe(400)
    expect(api.registrations.size).toBe(0)
  })

  describe("a person's watchers", () => {
    /** A board run as `principal`, as `next dev` on a laptop runs one, with its watchers in config. */
    function personal(api: ReturnType<typeof fakeMessageboard>, watch: Record<string, Watcher>, principal = 'user:u_jb') {
      const backend = vercel({ team: 'team_test', api: API, fetch: as(api, principal) })
      onTestFinished(() => backend.close())
      return { backend, team: board({ backend, url: 'http://localhost:3000/api/board', watch }) }
    }
    /** Until its tails have read the head of the feed: what's posted after that, they run. */
    // A read of the feed the API took: one it refuses for a parameter it doesn't know has read no head.
    const following = (api: ReturnType<typeof fakeMessageboard>) => vi.waitFor(() => expect(api.feedReads()).toBeGreaterThan(0))

    it('run in this process as tails from the head, registering nothing, and never on their own writes', async () => {
      const api = fakeMessageboard()
      const ada = handleOn(api, 'user:u_ada')
      await ada.post('pings', 'before it started')
      const ran: string[] = []
      const { team } = personal(api, {
        pings: {
          tail: 'pings',
          run: async ({ event, board: own }) => {
            if (event.type !== 'message.posted') return
            ran.push(event.message!.text)
            await own.reply(event.message!.id, 'pong')
          },
        },
      })
      await team.me()
      await following(api)
      const ping = await ada.post('pings', 'ping')
      await vi.waitFor(() => expect(ran).toEqual(['ping']))
      await vi.waitFor(async () => expect((await team.thread(ping.id)).replies.map((reply) => [reply.text, reply.by.actor])).toEqual([['pong', 'vercel:user:u_jb+pings']]))
      // The next post comes after its reply in the feed: by then the reply was seen, and ran nothing.
      await ada.post('pings', 'ping again')
      await vi.waitFor(() => expect(ran).toEqual(['ping', 'ping again']))
      expect(api.registrations.size).toBe(0)
      expect(api.requests.filter((request) => request.includes('/watchers'))).toEqual([])
    })

    it('run as tails in a dev server with its env pulled, which says VERCEL=1 in development', async () => {
      for (const [name, value] of Object.entries({ VERCEL: '1', VERCEL_ENV: 'development', VERCEL_TARGET_ENV: 'development', VERCEL_GIT_COMMIT_REF: '' })) vi.stubEnv(name, value)
      onTestFinished(() => void vi.unstubAllEnvs())
      const api = fakeMessageboard()
      const ada = handleOn(api, 'user:u_ada')
      await ada.post('pings', 'before it started')
      const { ran, watch } = pinger()
      const { team } = personal(api, watch)
      await team.me()
      await following(api)
      const ping = await ada.post('pings', 'ping')
      await vi.waitFor(() => expect(ran).toEqual(['ping']))
      await vi.waitFor(async () => expect((await team.thread(ping.id)).replies.map((reply) => [reply.text, reply.by.actor])).toEqual([['pong', 'vercel:user:u_jb+pings']]))
      expect(api.requests.filter((request) => request.includes('/watchers'))).toEqual([])
    })

    it('try a run that throws again, and post its reply once', async () => {
      const api = fakeMessageboard()
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      onTestFinished(() => errors.mockRestore())
      let tries = 0
      const { team } = personal(api, {
        pings: {
          tail: 'pings',
          run: async ({ event, board: own }) => {
            if (event.type !== 'message.posted') return
            await own.reply(event.message!.id, 'pong')
            if (++tries === 1) throw new Error('down')
          },
        },
      }, 'app:oac_1')
      const ada = handleOn(api, 'user:u_ada')
      await ada.post('pings', 'before it started')
      await team.me()
      await following(api)
      const ping = await ada.post('pings', 'ping')
      await vi.waitFor(() => expect(tries).toBe(2), { timeout: 5_000 })
      expect((await team.thread(ping.id)).replies.map((reply) => reply.text)).toEqual(['pong'])
    })

    /** A pings watcher that replies pong, and what it ran on. */
    const pinger = () => {
      const ran: string[] = []
      const watch: Record<string, Watcher> = {
        pings: {
          tail: 'pings',
          run: async ({ event, board: own }) => {
            if (event.type !== 'message.posted') return
            ran.push(event.message!.text)
            await own.reply(event.message!.id, 'pong')
          },
        },
      }
      return { ran, watch }
    }

    it("start no tails on a deployment whose credentials aren't its own: a fetch's that sends a person's", async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      onTestFinished(() => {
        errors.mockRestore()
        vi.unstubAllEnvs()
      })
      const api = fakeMessageboard()
      const ada = handleOn(api, 'user:u_ada')
      await ada.post('pings', 'before it started')
      for (const [key, set] of Object.entries({ VERCEL: '1', VERCEL_ENV: 'production' })) vi.stubEnv(key, set)
      const { ran, watch } = pinger()
      const backend = vercel({ team: 'team_test', api: API, fetch: as(api, 'user:u_jb') })
      onTestFinished(() => backend.close())
      const team = board({ backend, url: 'https://pong.vercel.app/api/board', watch })
      await team.me()
      await ada.post('pings', 'ping as jb')
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(ran).toEqual([])
      // It neither read the feed nor asked to register.
      expect(api.requests.filter((request) => request.endsWith('/changes') || request.includes('/watchers'))).toEqual([])
    })

    it("answer a wake-up with nothing run and a registration with watchers_need_project, asking the API nothing", async () => {
      const api = fakeMessageboard()
      const { backend, team } = personal(api, { pings: { tail: 'pings', run: async () => {} } })
      const wake = await team.fetch(new Request('http://localhost:3000/api/board/wake', { method: 'POST' }))
      expect(await wake.json()).toEqual({ ran: 0 })
      const registering = await team.fetch(new Request('http://localhost:3000/api/board/watchers', { method: 'POST' }))
      expect([registering.status, (await registering.json()).error.code]).toEqual([403, 'watchers_need_project'])
      await expect(backend.registerWatchers()).rejects.toMatchObject({ status: 403, code: 'watchers_need_project', origin: 'handle' })
      expect(api.requests.filter((request) => request.includes('/watchers'))).toEqual([])
    })
  })

  it("passes the conformance kit's sync as a project, through Vercel's API's sync routes", async () => {
    const api = fakeMessageboard()
    const report = await conformance(handleOn(api, 'project:prj_pong:production'), { withHeaders: withHeadersOn(api, 'project:prj_pong:production') })
    expect(Object.fromEntries(report.checks.filter((check) => check.group === 'sync').map((check) => [check.name, check.status]))).toEqual({
      "keeps sync's records: an import as a profile of its importer, its lookups by platform ID, a receipt, and where it's synced": 'passed',
      "meets a platform user an import's text mentions: an actor as one who wrote would be, whom the text names by that actor's ID": 'passed',
      "queues a platform thread's events in its sync's inbox once, and leases each after the one before is acked": 'passed',
      "takes an edit of a long message in its sync's inbox, under the longest event ID the protocol allows, and refuses a longer one": 'passed',
      'hands a sync each message change as a match of its @sync watcher': 'passed',
      'keeps noSync on a post and a reply, so sync sends neither': 'passed',
      "refuses a caller narrowed with x-board-can sync's records: imports, receipts, and the inbox": 'passed',
    })
  }, 30_000)

  it("passes the conformance kit's watchers as a project too, registering a path on its own project", async () => {
    const api = fakeMessageboard()
    const report = await conformance(handleOn(api, 'project:prj_pong:production'), { withHeaders: withHeadersOn(api, 'project:prj_pong:production') })
    expect(report.checks.filter((check) => check.group === 'watchers').map((check) => check.status)).toEqual(['passed', 'passed', 'passed'])
  }, 30_000)

  it('registers a path on its own project on Vercel, which the API wakes through its Deployment Protection', async () => {
    for (const [name, value] of Object.entries({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_TARGET_ENV: '', VERCEL_GIT_COMMIT_REF: '' })) vi.stubEnv(name, value)
    try {
      const api = fakeMessageboard()
      const backend = vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production') })
      board({ backend, url: 'https://pong.vercel.app/api/board', watch: { ping: { tail: 'pings', run: async () => {} } } })
      expect(await backend.registerWatchers()).toMatchObject({ path: '/api/board' })
      expect(api.registrations.get('vercel:project:prj_pong:production')).toMatchObject({ path: '/api/board' })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('registers again on a later use when its first registration fails', async () => {
    const api = fakeMessageboard()
    let failing = true
    const flaky: typeof fetch = async (input, init) => {
      if (failing && init?.method === 'PUT') {
        failing = false
        return Response.json({ error: { code: 'internal', message: 'boom' } }, { status: 500 })
      }
      return as(api, 'project:prj_pong:production')(input, init)
    }
    const pong = board({
      backend: vercel({ team: 'team_test', api: API, fetch: flaky }),
      url: 'https://pong.example/api/board',
      watch: { pings: { tail: 'pings', run: async () => {} } },
    })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const clock = vi.spyOn(Date, 'now')
    try {
      await pong.me()
      await vi.waitFor(() => expect(failing).toBe(false))
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(api.registrations.size).toBe(0)
      // Not on every request while it's failing: once the wait between tries is over.
      const at = Date.now()
      clock.mockReturnValue(at + 11_000)
      await pong.me()
      await vi.waitFor(() => expect(api.registrations.has('vercel:project:prj_pong:production')).toBe(true))
    } finally {
      clock.mockRestore()
      errors.mockRestore()
    }
  })

  it("turns a tail into the API's filter, and refuses what the API can't match", async () => {
    const api = fakeMessageboard()
    const team = handleOn(api, 'project:prj_pong:production')
    await team.register({ url: null, watch: { open: { tail: 'dev/ --label status=open|draft --text "is failing"' }, mine: { tail: 'general --by me' } } })
    expect(api.registrations.get('vercel:project:prj_pong:production')?.watch).toEqual({
      open: { filter: { channelTree: 'dev', text: 'is failing', labels: [{ key: 'status', values: ['open', 'draft'] }] } },
      mine: { filter: { channelIds: ['general'], authors: ['vercel:project:prj_pong:production'] } },
    })
    for (const tail of ['general --mentions @ada', 'general --source slack'])
      await expect(team.register({ url: null, watch: { w: { tail } } })).rejects.toMatchObject({ status: 400, code: 'bad_watcher' })
  })

  it("leaves how many watchers a registration holds to the API", async () => {
    const api = fakeMessageboard()
    const team = handleOn(api, 'project:prj_pong:production')
    const watch = Object.fromEntries(Array.from({ length: REGISTERED_WATCHERS_MAX + 1 }, (_, i) => [`w${i}`, { tail: 'general' }]))
    await team.register({ url: null, watch })
    expect(Object.keys(api.registrations.get('vercel:project:prj_pong:production')!.watch)).toHaveLength(REGISTERED_WATCHERS_MAX + 1)
  })

  it('schedules a thread and a reply in the API, in its times, and each send says which schedule posted it', async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    const root = await pong.post('pings', { text: 'root' })
    const before = Date.now()
    const reply = await pong.as('claude').schedule({ re: root.id }, { text: 'check in', in: '1h', every: '30m', for: '7d', noSync: true })
    const kept = api.schedules.get(reply.id)!
    expect(kept).toMatchObject({ threadId: root.thread, every: 30 * 60_000, text: 'check in' })
    expect(kept.firstAt).toBeGreaterThanOrEqual(before + 3_600_000)
    expect(kept.until).toBe(kept.firstAt + 7 * 86_400_000)
    expect(reply).toMatchObject({ channel: 'pings', re: root.id, every: 30 * 60_000, times: null, sent: 0, state: 'pending', canceled: null, by: { actor: 'vercel:project:prj_pong:production+claude', profile: 'claude' }, author: { kind: 'agent', handle: 'claude' } })
    expect(reply.until).toBe(new Date(kept.until!).toISOString())
    const thread = await pong.schedule('standup', { text: 'standup', every: '1d', times: 3, labels: { kind: 'standup' } })
    expect(api.schedules.get(thread.id)).toMatchObject({ labels: { kind: 'standup' }, times: 3 })
    expect(api.schedules.get(thread.id)!.firstAt).toBeGreaterThanOrEqual(before + 86_400_000)
    // A send is the creator's post, marked as the schedule's: what tells a watcher its own check-in from its other posts.
    const sent = api.send(reply.id)
    const { replies } = await pong.thread(root.id)
    expect(replies).toMatchObject([{ id: sent, text: 'check in', schedule: { id: reply.id, n: 0 }, by: { profile: 'claude' } }])
    expect((await pong.schedules({ re: root.id }))[0]).toMatchObject({ id: reply.id, sent: 1, last: sent })
    const started = api.send(thread.id)
    expect((await pong.thread(started)).message).toMatchObject({ channel: 'standup', text: 'standup', labels: { kind: 'standup' }, schedule: { id: thread.id, n: 0 } })
    expect((await pong.thread(root.id)).message.schedule).toBeUndefined()
  })

  it("lists again from the start, once, when the API says a page's cursor expired, and fails when it expires again", async () => {
    const api = fakeMessageboard()
    let expiring = 0
    let expired = 0
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/schedules') && url.searchParams.has('cursor') && expiring > 0) {
        expiring--
        expired++
        return Response.json({ error: { code: 'cursor_expired', message: 'This cursor expired: list again without one.' } }, { status: 410 })
      }
      return as(api, 'project:prj_pong:production')(input, init)
    }
    const pong = board({ backend: vercel({ team: 'team_test', api: API, fetch, files: api.files }) })
    const made: string[] = []
    // The fake API pages schedules two at a time.
    for (let n = 0; n < 5; n++) made.push((await pong.schedule('ops', { text: `ops ${n}`, in: '1h' })).id)
    expiring = 1
    expect((await pong.schedules({})).map((s) => s.id).sort()).toEqual(made.sort())
    expect(expired).toBe(1)
    expiring = 3
    expired = 0
    await expect(pong.schedules({})).rejects.toMatchObject({ status: 410, code: 'cursor_expired' })
    expect(expired).toBe(2)
  })

  it('lists pending schedules by thread, channel, and creator, across short pages, and every one with `all`', async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    const root = await pong.post('pings', { text: 'root' })
    const mine = await pong.schedule({ re: root.id }, { text: 'mine', in: '1h' })
    const claude = await pong.as('claude').schedule({ re: root.id }, { text: 'claude', in: '1h' })
    const elsewhere = await pong.schedule('ops', { text: 'ops', in: '1h' })
    const done = await pong.schedule('ops', { text: 'once', in: '1m' })
    api.send(done.id)
    const ids = async (query: object) => (await pong.schedules(query as never)).map((s) => s.id).sort()
    expect(await ids({})).toEqual([mine.id, claude.id, elsewhere.id].sort())
    expect(await ids({ re: root.id })).toEqual([mine.id, claude.id].sort())
    expect(await ids({ channel: 'ops' })).toEqual([elsewhere.id])
    expect(await ids({ channel: 'nowhere' })).toEqual([])
    expect(await ids({ by: 'claude' })).toEqual([claude.id])
    // A principal covers its agents; `me` is the actor alone.
    expect(await ids({ by: 'vercel:project:prj_pong:production' })).toEqual([mine.id, claude.id, elsewhere.id].sort())
    expect((await pong.as('claude').schedules({ by: 'me' })).map((s) => s.id)).toEqual([claude.id])
    expect(await ids({ all: true })).toEqual([mine.id, claude.id, elsewhere.id, done.id].sort())
    expect((await pong.schedules({ all: true })).find((s) => s.id === done.id)).toMatchObject({ state: 'done', next: null, sent: 1 })
  })

  it("lists the caller's own schedules without paging through everyone else's", async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    for (let n = 0; n < 9; n++) await pong.schedule('ops', { text: `ops ${n}`, in: '1h' })
    const claude = await pong.as('claude').schedule('ops', { text: 'claude', in: '1h' })
    const listing = (request: string) => request === 'GET /boards/brd_test/schedules'
    api.requests.length = 0
    expect((await pong.schedules({})).map((s) => s.id)).toHaveLength(10)
    const everyones = api.requests.filter(listing).length
    api.requests.length = 0
    expect((await pong.as('claude').schedules({ by: 'me' })).map((s) => s.id)).toEqual([claude.id])
    // The fake API reads six schedules a request, and fills a page with two.
    expect(everyones).toBe(5)
    expect(api.requests.filter(listing)).toHaveLength(2)
  })

  it('cancels a schedule once, as the API answers it, and shows who did', async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    const root = await pong.post('pings', { text: 'root' })
    const later = await pong.schedule({ re: root.id }, { text: 'later', in: '1d' })
    const first = await pong.cancelSchedule(later.id)
    expect(first).toMatchObject({ canceled: true, schedule: { state: 'canceled', next: null, canceled: { reason: 'canceled', by: { actor: 'vercel:project:prj_pong:production' } } } })
    expect(await pong.cancelSchedule(later.id)).toMatchObject({ canceled: false, schedule: { state: 'canceled' } })
    // Its team turning Messageboard off stops it as a lost grant does, by no one in particular.
    const off = await pong.schedule({ re: root.id }, { text: 'off', in: '1d' })
    Object.assign(api.schedules.get(off.id)!, { state: 'canceled', nextAt: null, canceled: { at: Date.now(), reason: 'disabled' } })
    expect((await pong.schedules({ all: true })).find((s) => s.id === off.id)?.canceled).toEqual({ reason: 'revoked', by: { actor: 'board:schedule', principal: 'board:schedule', profile: null } })
    await expect(handleOn(api, 'user:u_ada').cancelSchedule(off.id)).rejects.toMatchObject({ status: 403, code: 'schedule_not_owned' })
    await expect(pong.cancelSchedule('sch_missing')).rejects.toMatchObject({ status: 404, code: 'schedule_not_found' })
  })

  it('sends a scheduled reply its labels, and reads them back on the schedule', async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    const root = await pong.post('pings', { text: 'root' })
    const reply = await pong.schedule({ re: root.id }, { text: 'check in', in: '1h', every: '1h', times: 2, labels: { kind: 'task', check: 'in' } })
    expect(api.schedules.get(reply.id)).toMatchObject({ threadId: root.thread, labels: { kind: 'task', check: 'in' } })
    expect(reply.labels).toEqual({ kind: 'task', check: 'in' })
    expect((await pong.schedules({ re: root.id })).find((s) => s.id === reply.id)?.labels).toEqual({ kind: 'task', check: 'in' })
  })

  it("refuses what the API can't schedule: files", async () => {
    const api = fakeMessageboard()
    const backend = vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files })
    const project = { self: null, origin: { via: { kind: 'client', name: null } } } as Caller
    const signal = new AbortController().signal
    const { attachment } = await backend.upload(project, { data: new TextEncoder().encode('log'), name: 'a.log', type: 'text/plain' }, signal)
    await expect(backend.schedule(project, { channel: 'pings', text: 'file', in: '1h', attachments: [attachment.id] } as never, signal)).rejects.toMatchObject({ status: 501, code: 'not_supported' })
    expect(api.schedules.size).toBe(0)
  })

  it("runs board()'s middleware on its own code's edit", async () => {
    const api = fakeMessageboard()
    const screened: string[] = []
    const pong = pongBoard(api, [
      async ({ write, next }) => {
        screened.push(`${write.kind} ${write.text}`)
        await next({ text: write.text.toUpperCase() })
      },
    ])
    const { id } = await pong.post('dev', { text: 'hello' })
    await pong.edit(id, 'edited')
    expect(screened).toEqual(['post hello', 'edit edited'])
    expect((await pong.thread(id)).message.text).toBe('EDITED')
  })

  it("screens a sync's edit by board ID of its user's own message, from an API that names imports by the platform user alone", async () => {
    const api = fakeMessageboard({ externalImports: true })
    const screened: string[] = []
    const pong = pongBoard(api, [
      async ({ write, next }) => {
        screened.push(`${write.kind} ${write.text}`)
        await next({ text: write.text.toUpperCase() })
      },
    ])
    await pong.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const ada = { id: 'slack:user:U_ADA', handle: 'ada', name: 'Ada', avatar: null, isBot: false }
    const origin = { thread: 'slack:C1:1', subthread: null, message: '1', context: null }
    const { message } = await pong.syncImport({ op: 'post', author: ada, from: 'slack', channel: 'general', text: 'from slack', origin })
    expect((await pong.thread(message!)).message.by.actor).toBe('slack:user:U_ADA')
    await pong.syncImport({ op: 'edit', author: ada, from: null, message: message!, text: 'edited by the sync, as Ada' })
    expect(screened).toEqual(['post from slack', 'edit edited by the sync, as Ada'])
    expect((await pong.thread(message!)).message.text).toBe('EDITED BY THE SYNC, AS ADA')
  })

  it("screens a schedule's message through board()'s middleware when it's made, since Vercel's API posts its sends", async () => {
    const api = fakeMessageboard()
    const screened: string[] = []
    const pong = pongBoard(api, [
      async ({ write, respond, next }) => {
        screened.push(`${write.kind} ${write.channel} ${write.text}`)
        // As the factory's memory judge does: a note it rejects never lands.
        if (write.channel.startsWith('memory/')) return respond('Memory note not saved: rejected')
        await next({ text: write.text.toUpperCase() })
      },
    ])
    const root = await pong.post('dev', { text: 'root' })
    const own = await pong.schedule({ re: root.id }, { text: 'check in', in: '1h' })
    const agent = await pong.as('claude').schedule({ re: root.id }, { text: 'check later', in: '2h' })
    expect([own.id, agent.id].map((id) => api.schedules.get(id)?.text)).toEqual(['CHECK IN', 'CHECK LATER'])
    await expect(pong.as('claude').schedule('memory/notes', { text: 'remember this', in: '1m' })).rejects.toMatchObject({ status: 422, code: 'dropped' })
    await expect(pong.schedule('memory/notes', { text: 'and this', in: '1m' })).rejects.toMatchObject({ status: 422, code: 'dropped' })
    expect(api.schedules.size).toBe(2)
    expect(screened).toEqual(['post dev root', 'post dev check in', 'post dev check later', 'post memory/notes remember this', 'post memory/notes and this'])
  })

  it("answers the API's own sync refusals with the board's codes", async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    const ping = handleOn(api, 'project:prj_ping:production')
    const julian = handleOn(api)
    await pong.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const author = { id: 'linear:user:U1', handle: 'jb', name: 'Julián', avatar: null, isBot: false }
    const event = { kind: 'message' as const, channel: 'linear:C1', thread: 'linear:C1:1', subthread: null, message: '1', isRoot: true, text: 'hi', context: null, author }
    await expect(pong.inboxPush('slack', [{ id: 'e1', event, raw: null }])).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
    await expect(ping.syncImport({ op: 'post', author: { ...author, id: 'slack:user:U1' }, from: 'slack', channel: 'general', text: 'hi' })).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    await expect(julian.register({ url: null, watch: {}, sync: [{ key: 'linear', platform: 'linear' }] })).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    // A conflict or a write too big, on sync's routes and nowhere else.
    const refusing = (path: RegExp, status: number, code: string) =>
      handleOn({ ...api, fetch: async (input: RequestInfo | URL, init?: RequestInit) => (path.test(new URL(new Request(input, init).url).pathname) ? Response.json({ error: { code, message: code } }, { status }) : api.fetch(input, init)) }, 'project:prj_pong:production')
    const origin = { thread: 'slack:C1:1', subthread: null, message: '1', context: null }
    await expect(refusing(/\/sync\/imports$/, 413, 'mutation_too_large').syncImport({ op: 'post', author: { ...author, id: 'slack:user:U1' }, from: 'slack', channel: 'general', text: 'hi', origin })).rejects.toMatchObject({ status: 413, code: 'too_large' })
    await expect(refusing(/\/sync\/receipts$/, 409, 'operation_conflict').syncReceipt({ kind: 'thread', message: 'msg_00000000-0000-0000-0000-000000000000_1', target: 'slack:C1', targetKind: 'channel', cause: 'request' })).rejects.toMatchObject({ status: 409, code: 'conflict' })
    await expect(refusing(/\/threads$/, 403, 'foreign_author').post('general', { text: 'hi' })).rejects.toMatchObject({ status: 403, code: 'foreign_author' })
  })

  it("names the sync a platform user's edit, delete, or reaction came through as its from, and none for one a sync makes as the user", async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    await pong.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const author = { id: 'slack:user:U1', handle: 'jb', name: 'Julián', avatar: null, isBot: false }
    const origin = { thread: 'slack:C1:1', subthread: null, message: '1', context: null }
    const { message } = await pong.syncImport({ op: 'post', author, from: 'slack', channel: 'general', text: 'from slack', origin })
    await pong.syncImport({ op: 'edit', author, from: 'slack', origin, text: 'edited on slack' })
    await pong.syncImport({ op: 'react', author, from: 'slack', origin, emoji: 'eyes' })
    await handleOn(api).react(message!, 'tada')
    // A sync callback's own write as the user syncs out everywhere, Slack included.
    await pong.syncImport({ op: 'edit', author, from: null, message: message!, text: 'edited by the sync, as Julián' })
    await pong.syncImport({ op: 'delete', author, from: 'slack', origin })
    expect((await drain(pong)).map((match) => [match.event.type, (match.event.payload as { from: string | null }).from])).toEqual([
      ['message.posted', 'slack'],
      ['message.edited', 'slack'],
      ['reaction.added', 'slack'],
      ['reaction.added', null],
      ['message.edited', null],
      ['message.deleted', 'slack'],
    ])
  })

  it("shows a project's import as the platform user through that project, in its environment, with its key's platform, as the API names them", async () => {
    const api = fakeMessageboard()
    const preview = handleOn(api, 'project:prj_pong:preview')
    await preview.register({ url: null, watch: {}, sync: [{ key: 'slack-eu', platform: 'slack' }] })
    const malte = { id: 'slack-eu:user:U_MALTE', handle: 'malte', name: 'Malte', avatar: null, isBot: false }
    await preview.syncImport({ op: 'post', author: malte, from: 'slack-eu', channel: 'general', text: 'ship it', origin: { thread: 'slack-eu:C1:1', subthread: null, message: '1', context: null } })
    const julian = handleOn(api)
    await julian.post('general', { text: 'on the board' })
    const { messages } = await julian.channel('general').messages()
    expect(messages.map((message) => [message.text, message.by, message.author])).toEqual([
      [
        'ship it',
        { actor: 'vercel:project:prj_pong:preview+slack-eu:user:U_MALTE', principal: 'vercel:project:prj_pong:preview', profile: 'slack-eu:user:U_MALTE' },
        { id: 'vercel:project:prj_pong:preview+slack-eu:user:U_MALTE', kind: 'external', handle: 'pong/malte', name: 'Malte', avatar: null, via: { name: 'pong', environment: 'preview' }, platform: 'slack', verified: true },
      ],
      ['on the board', { actor: 'vercel:user:u_jb', principal: 'vercel:user:u_jb', profile: null }, expect.not.objectContaining({ via: expect.anything() })],
    ])
    expect((await julian.actors()).find((actor) => actor.id.endsWith('+slack-eu:user:U_MALTE'))).toMatchObject({ name: 'Malte', via: { name: 'pong', environment: 'preview' }, platform: 'slack' })
    // A profile name covers that agent of anyone's, but a platform user is only ever themselves: the feed, from its start, by a bare one.
    const { cursor: beginning } = await julian.channel('nowhere').messages()
    expect((await julian.poll({ channel: 'general', by: 'slack-eu:user:U_MALTE', after: beginning })).events).toEqual([])
    expect((await julian.poll({ channel: 'general', by: 'pong/malte', after: beginning })).events.length).toBeGreaterThan(0)
  })

  it("imports through a sync key not named for its platform, its users named for the key", async () => {
    const api = fakeMessageboard()
    const s = fakePlatform('slack')
    const pong = board({
      backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files }),
      url: PONG_URL,
      basePath: '/api/board',
      sync: { 'slack-eu': slack({ adapter: s.adapter }, channels({ C1: 'general' })) },
    })
    const webhook = await pong.fetch(new Request(`${PONG_URL}/webhooks/slack-eu`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'message', threadId: 'slack:C1:300', id: '300', text: 'hej', user: 'U_ADA', name: 'Ada' }) }))
    expect(webhook.status).toBe(200)
    const julian = handleOn(api)
    await vi.waitFor(async () => expect((await julian.channel('general').messages()).messages).toHaveLength(1))
    const [message] = (await julian.channel('general').messages()).messages
    expect([message!.by.actor, message!.from, message!.author?.platform]).toEqual(['vercel:project:prj_pong:production+slack-eu:user:U_ADA', 'pong/slack-eu', 'slack'])
  })

  it("shows a caller held to some channels an author the API doesn't name it by their ID: no handle made up from it, and no name a wider caller read", async () => {
    const api = fakeMessageboard({ namesNarrowed: false })
    const pong = handleOn(api, 'project:prj_pong:production')
    await pong.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    await pong.syncImport({ op: 'post', author: { id: 'slack:user:U_MALTE', handle: 'malte', name: 'Malte Ubl', avatar: null, isBot: false }, from: 'slack', channel: 'general', text: 'hi' })
    const malte = 'vercel:project:prj_pong:production+slack:user:U_MALTE'
    const author = async (handle: ReturnType<typeof handleOn>) => (await handle.channel('general').messages()).messages[0]!.author
    // The deployment reads the whole board, as its sync does, and is named everyone.
    expect(await author(pong)).toMatchObject({ id: malte, handle: 'pong/malte', name: 'Malte Ubl' })
    // Its agent, on the same handle held to one channel, is named no one: it reads the author by ID.
    const agent = pong.as(null, { can: { 'general/': ['read', 'post'] } })
    expect(await author(agent)).toMatchObject({ id: malte, handle: malte })
    // And the deployment still by name.
    expect(await author(pong)).toMatchObject({ handle: 'pong/malte', name: 'Malte Ubl' })
  })

  it("stores the handle an agent held to a channel read on a Slack user as a mention of them, which their sync delivers natively", async () => {
    const api = fakeMessageboard()
    const pongSlack = fakePlatform('slack')
    const pong = board({
      backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files }),
      url: PONG_URL,
      basePath: '/api/board',
      sync: { slack: slack({ adapter: pongSlack.adapter }, channels({ C1: 'general' })) },
    })
    // Malte asks from Slack.
    await pong.fetch(new Request(`${PONG_URL}/webhooks/slack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'message', threadId: 'slack:C1:300', id: '300', text: 'can you tag me?', user: 'U_M1', name: 'malte' }) }))
    const agent = pong.as(null, { can: { 'general/': ['read', 'post'] } })
    await vi.waitFor(async () => expect((await agent.channel('general').messages()).messages).toHaveLength(1))
    const [asked] = (await agent.channel('general').messages()).messages
    const malte = 'vercel:project:prj_pong:production+slack:user:U_M1'
    expect(asked!.author).toMatchObject({ id: malte, handle: 'pong/malte' })
    // It answers him by the handle it read: the board stores who that is, and says so.
    const reply = await agent.reply(asked!.id, `sure, @${asked!.author!.handle} and @nobody`)
    expect(reply.text).toBe(`sure, @[${malte}] and @nobody`)
    expect(reply.mentions).toEqual([
      { written: '@pong/malte', actor: { id: malte, handle: 'pong/malte', name: 'malte' }, candidates: [] },
      { written: '@nobody', actor: null, candidates: [] },
    ])
    // Slack gets its own user as a mention, and the handle no one has as it was typed.
    await pong.fetch(new Request(`${PONG_URL}/wake`, { method: 'POST' }))
    await vi.waitFor(() => expect(pongSlack.posts.map((post) => JSON.parse(post.text).markdown)).toEqual(['**pong**: sure, <@U_M1> and @nobody']))
  })

  it("meets a Slack user a message cc's, who never wrote: an agent held to the channel reads who they are and mentions them back, natively", async () => {
    const api = fakeMessageboard()
    const pongSlack = fakePlatform('slack')
    const pong = board({
      backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files }),
      url: PONG_URL,
      basePath: '/api/board',
      sync: { slack: slack({ adapter: pongSlack.adapter }, channels({ C1: 'general' })) },
    })
    await pong.fetch(new Request(`${PONG_URL}/webhooks/slack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'message', threadId: 'slack:C1:300', id: '300', text: 'who knows billing?', user: 'U_ADA', name: 'ada' }) }))
    const agent = pong.as(null, { can: { 'general/': ['read', 'post'] } })
    await vi.waitFor(async () => expect((await agent.channel('general').messages()).messages).toHaveLength(1))
    const [asked] = (await agent.channel('general').messages()).messages
    // Ada cc's Grace in the thread, as the Slack provider brings a mention in: by his ID, with who he is.
    const ada = { id: 'slack:user:U_ADA', handle: 'ada', name: 'ada', avatar: null, isBot: false }
    const cc = { id: 'slack:user:U_G1', handle: 'grace', name: 'Grace Hopper', avatar: null, isBot: false }
    await pong.syncImport({ op: 'post', author: ada, from: 'slack', re: asked!.id, text: 'cc @[slack:user:U_G1]', mentioned: [cc], origin: { thread: 'slack:C1:300', subthread: null, message: '301', context: null } })
    const grace = 'vercel:project:prj_pong:production+slack:user:U_G1'
    expect((await agent.thread(asked!.id)).replies.map((reply) => reply.text)).toEqual([`cc @[${grace}]`])
    expect((await agent.actors()).find((actor) => actor.id === grace)).toMatchObject({ handle: 'pong/grace', name: 'Grace Hopper' })
    // The agent answers him by the handle it read, and Slack gets its own user as a mention.
    const reply = await agent.reply(asked!.id, '@pong/grace, over to you')
    expect(reply.mentions).toEqual([{ written: '@pong/grace', actor: { id: grace, handle: 'pong/grace', name: 'Grace Hopper' }, candidates: [] }])
    await pong.fetch(new Request(`${PONG_URL}/wake`, { method: 'POST' }))
    await vi.waitFor(() => expect(pongSlack.posts.map((post) => JSON.parse(post.text).markdown)).toEqual(['**pong**: <@U_G1>, over to you']))
  })

  it("mentions a Slack user the board has never met from their ID alone: the short ID or this project's profile of them, never another project's", async () => {
    const api = fakeMessageboard()
    const pongSlack = fakePlatform('slack')
    const pong = board({
      backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files }),
      url: PONG_URL,
      basePath: '/api/board',
      sync: { slack: slack({ adapter: pongSlack.adapter }, channels({ C1: 'general' })) },
    })
    await pong.fetch(new Request(`${PONG_URL}/webhooks/slack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'message', threadId: 'slack:C1:300', id: '300', text: 'who knows billing?', user: 'U_ADA', name: 'ada' }) }))
    const agent = pong.as(null, { can: { 'general/': ['read', 'post'] } })
    await vi.waitFor(async () => expect((await agent.channel('general').messages()).messages).toHaveLength(1))
    const [asked] = (await agent.channel('general').messages()).messages
    // None of the three has written or been mentioned on the board.
    await agent.reply(asked!.id, 'cc @[slack:user:U_NEW], @[vercel:project:prj_pong:production+slack:user:U_KAI] and @[vercel:project:prj_other:production+slack:user:U_ZED]')
    await pong.fetch(new Request(`${PONG_URL}/wake`, { method: 'POST' }))
    await vi.waitFor(() => expect(pongSlack.posts.map((post) => JSON.parse(post.text).markdown)).toEqual(['**pong**: cc <@U_NEW>, <@U_KAI> and @[vercel:project:prj_other:production+slack:user:U_ZED]']))
  })

  it("names a mention of any key the board runs in a write its sync makes as a user, as a2() does", async () => {
    const api = fakeMessageboard()
    const pong = board({
      backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files }),
      url: PONG_URL,
      basePath: '/api/board',
      sync: { slack: slack({ adapter: fakePlatform('slack').adapter }, channels({ C1: 'general' })), 'slack-eu': slack({ adapter: fakePlatform('slack').adapter }, channels({ C9: 'general' })) },
    })
    await pong.fetch(new Request(`${PONG_URL}/webhooks/slack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'message', threadId: 'slack:C1:300', id: '300', text: 'hello', user: 'U_ADA', name: 'ada' }) }))
    await vi.waitFor(async () => expect((await pong.channel('general').messages()).messages).toHaveLength(1))
    const [asked] = (await pong.channel('general').messages()).messages
    const ada = { id: 'slack:user:U_ADA', handle: 'ada', name: 'ada', avatar: null, isBot: false }
    // A callback's own write, as Ada, mentions a user of each key.
    const { message } = await pong.syncImport({ op: 'post', author: ada, from: null, re: asked!.id, text: 'cc @[slack:user:U_G1] and @[slack-eu:user:U_G2]' })
    const owner = 'vercel:project:prj_pong:production'
    expect((await pong.thread(asked!.id)).replies.find((reply) => reply.id === message)?.text).toBe(`cc @[${owner}+slack:user:U_G1] and @[${owner}+slack-eu:user:U_G2]`)
  })

  it("keeps an import's mention as it came where naming it under its project would outgrow a message", async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    await pong.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const ada = { id: 'slack:user:U_ADA', handle: 'ada', name: 'ada', avatar: null, isBot: false }
    // 10,000 characters as it came: the project's ID in the mention would make it longer.
    const text = `${'x'.repeat(9_981)} @[slack:user:U_G1]`
    const { message } = await pong.syncImport({ op: 'post', author: ada, from: 'slack', channel: 'general', text })
    expect((await pong.thread(message!)).message.text === text).toBe(true)
  })

  it("asks an API that names a caller no one once, by ID and for its list, and not again on every page it reads", async () => {
    const api = fakeMessageboard({ namesNarrowed: false })
    const pong = handleOn(api, 'project:prj_pong:production')
    await pong.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    for (const user of ['U_ADA', 'U_BOB', 'U_MALTE'])
      await pong.syncImport({ op: 'post', author: { id: `slack:user:${user}`, handle: user.toLowerCase(), name: user, avatar: null, isBot: false }, from: 'slack', channel: 'general', text: 'hi' })
    const agent = pong.as(null, { can: { 'general/': ['read', 'post'] } })
    const asked = () => api.requests.filter((request) => /^GET \S*\/actors\b/.test(request)).length
    const before = asked()
    await agent.channel('general').messages()
    expect(asked() - before).toBe(2)
    await agent.channel('general').messages()
    await agent.channel('general').messages()
    expect(asked() - before).toBe(2)
  })

  it("puts an import's handle under its project's name, typable, from an API that names them as their platform does", async () => {
    const api = fakeMessageboard({ platformHandles: true })
    // The second project's name isn't one the API knows.
    for (const [principal, key] of [['project:prj_pong:preview', 'slack'], ['project:prj_unnamed:production', 'slack-eu']] as const) {
      const project = handleOn(api, principal)
      await project.register({ url: null, watch: {}, sync: [{ key, platform: 'slack' }] })
      const author = { id: `${key}:user:U_MALTE`, handle: 'Malte Ubl', name: 'Malte Ubl', avatar: null, isBot: false }
      await project.syncImport({ op: 'post', author, from: key, channel: 'general', text: 'hi' })
    }
    const julian = handleOn(api)
    const handles = (await julian.channel('general').messages()).messages.map((message) => message.author?.handle)
    expect(handles).toEqual(['pong/malte-ubl', 'prj_unnamed/malte-ubl'])
    expect((await julian.actors()).filter((actor) => actor.id.includes('+slack')).map((actor) => actor.handle).sort()).toEqual(['pong/malte-ubl', 'prj_unnamed/malte-ubl'])
  })

  it('fits a handle from the API in the 128 characters a handle holds, however long the API named it', async () => {
    const api = fakeMessageboard({ platformHandles: true })
    const pong = handleOn(api, 'project:prj_pong:production')
    await pong.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    // One with a slash is as the API names imports, under a project: this one ran long.
    for (const [id, handle] of [['slack:user:U_SLASH', `team/${'b'.repeat(200)}`], ['slack:user:U_PLAIN', 'c'.repeat(200)]] as const)
      await pong.syncImport({ op: 'post', author: { id, handle, name: 'Long', avatar: null, isBot: false }, from: 'slack', channel: 'general', text: 'hi' })
    const handles = (await handleOn(api).channel('general').messages()).messages.map((message) => message.author?.handle)
    expect(handles).toEqual([`team/${'b'.repeat(123)}`, `pong/${'c'.repeat(123)}`])
  })

  it('shows an import as the platform user alone, as before, from an API that names them so', async () => {
    const api = fakeMessageboard({ externalImports: true })
    const preview = handleOn(api, 'project:prj_pong:preview')
    await preview.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const malte = { id: 'slack:user:U_MALTE', handle: 'malte', name: 'Malte', avatar: null, isBot: false }
    await preview.syncImport({ op: 'post', author: malte, from: 'slack', channel: 'general', text: 'ship it' })
    const [message] = (await handleOn(api).channel('general').messages()).messages
    expect([message!.by, message!.author]).toEqual([
      { actor: 'slack:user:U_MALTE', principal: 'slack:user:U_MALTE', profile: null },
      { id: 'slack:user:U_MALTE', kind: 'external', handle: 'malte', name: 'Malte', avatar: null, verified: true },
    ])
  })

  it("mentions a platform user natively only from the sync that speaks for them, under the key it imported them through", async () => {
    const api = fakeMessageboard()
    const s = fakePlatform('slack')
    // The documented renderer: a root mentions its owner where the platform can.
    const owner = render(({ message, label, mentionOf }) => {
      const who = message.labels.owner ? mentionOf(message.labels.owner) : null
      return who ? `${message.text} · ${who}` : `**${label}**: ${message.text}`
    }, channels({ C1: 'general' }))
    const pong = board({
      backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files }),
      url: PONG_URL,
      basePath: '/api/board',
      sync: { slack: slack({ adapter: s.adapter }, owner) },
    })
    // A preview held the key first and spoke for "Ada" under it, then let it go.
    const preview = handleOn(api, 'project:prj_pong:preview')
    await preview.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    await preview.syncImport({ op: 'post', author: { id: 'slack:user:U_ADA', handle: 'ada', name: 'Ada', avatar: null, isBot: false }, from: 'slack', channel: 'random', text: 'hi' })
    await preview.register({ url: null, watch: {}, sync: [] })
    // Production's own Slack brings Ada in under the same key.
    await pong.fetch(new Request(`${PONG_URL}/webhooks/slack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'message', threadId: 'slack:C1:300', id: '300', text: 'hi', user: 'U_ADA', name: 'Ada' }) }))
    const julian = handleOn(api)
    await vi.waitFor(async () => expect((await julian.channel('general').messages()).messages).toHaveLength(1))
    expect((await julian.actors()).map((actor) => actor.id).filter((id) => id.endsWith('+slack:user:U_ADA')).sort()).toEqual([
      'vercel:project:prj_pong:preview+slack:user:U_ADA',
      'vercel:project:prj_pong:production+slack:user:U_ADA',
    ])
    await julian.post('general', { text: 'yours', labels: { owner: 'vercel:project:prj_pong:production+slack:user:U_ADA' } })
    await julian.post('general', { text: 'not yours', labels: { owner: 'vercel:project:prj_pong:preview+slack:user:U_ADA' } })
    await pong.fetch(new Request(`${PONG_URL}/wake`, { method: 'POST' }))
    await vi.waitFor(() =>
      expect(s.channelPosts.map((post) => JSON.parse(post.text).markdown).sort()).toEqual(['**Ada Lovelace**: not yours', 'yours · <@U_ADA>']),
    )
  })

  it("posts to Slack under the names the API gives, which it checked: a person as themselves", async () => {
    const api = fakeMessageboard()
    const posted: Record<string, unknown>[] = []
    const client = {
      conversations: { list: async () => ({ channels: [] }), info: async () => ({}), join: async () => ({}), replies: async () => ({ messages: [] }) },
      chat: { postMessage: async (args: Record<string, unknown>) => (posted.push(args), { ts: '1700000000.000200' }) },
      auth: { test: async () => ({ response_metadata: { scopes: ['chat:write.customize'] } }) },
      users: { info: async () => ({}) },
    }
    const s = fakePlatform('slack', (adapter) => {
      withSlackClient(client, false)(adapter)
      Object.assign(adapter, {
        formatConverter: { toSlackPayload: (message: { markdown: string }) => ({ markdown_text: message.markdown }) },
        decodeThreadId: (id: string) => ({ channel: id.split(':')[1], threadTs: id.split(':')[2] ?? '' }),
      })
    })
    const pong = board({
      backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files }),
      url: PONG_URL,
      basePath: '/api/board',
      sync: { slack: slack({ adapter: s.adapter, client: async () => client as never }, channels({ C1: 'general' })) },
    })
    // Its first request registers its sync, which sees what's posted after.
    await pong.fetch(new Request(`${PONG_URL}/wake`, { method: 'POST' }))
    await handleOn(api).post('general', { text: 'the deploy is red' })
    await pong.fetch(new Request(`${PONG_URL}/wake`, { method: 'POST' }))
    await vi.waitFor(() => expect(posted.map(({ username, markdown_text }) => [username, markdown_text])).toEqual([['Ada Lovelace', 'the deploy is red']]))
  })

  it("mentions a GitHub user a project's sync imported by their login, not by the handle the board gives them", async () => {
    const api = fakeMessageboard()
    const hub = fakePlatform('github')
    const pong = board({
      backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files }),
      url: PONG_URL,
      basePath: '/api/board',
      // It imports the repo's pull requests, and sends what's written in their threads back.
      sync: { github: github({ adapter: hub.adapter }, async (sync) => { await repos({ 'acme/www': 'prs' })(sync); if (sync.direction === 'out') await sync.deliver() }) },
    })
    await pong.fetch(new Request(`${PONG_URL}/webhooks/github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': 'd1' },
      body: JSON.stringify({ action: 'opened', repository: { full_name: 'acme/www' }, sender: { id: 42, login: 'ada' }, pull_request: { number: 7, title: 'Add sync', html_url: 'https://github.com/acme/www/pull/7', draft: false, merged: false } }),
    }))
    const julian = handleOn(api)
    await vi.waitFor(async () => expect((await julian.channel('prs').messages()).messages).toHaveLength(1))
    const [opened] = (await julian.channel('prs').messages()).messages
    // On the board she's pong's profile of her, under its name.
    expect(opened!.author).toMatchObject({ id: 'vercel:project:prj_pong:production+github:user:42', handle: 'pong/ada' })
    await julian.reply(opened!.id, `over to @[${opened!.by.actor}]`)
    await pong.fetch(new Request(`${PONG_URL}/wake`, { method: 'POST' }))
    await vi.waitFor(() => expect(hub.posts.map((post) => JSON.parse(post.text).markdown)).toEqual(['**Ada Lovelace**: over to @ada']))
  })

  it("delivers a mention natively through the sync whose user it names, and by name through any other: two syncs' Maltes, and an email its Slack knows", async () => {
    const api = fakeMessageboard()
    const lookupByEmail = vi.fn(async ({ email }: { email: string }) => {
      if (email !== 'ada@vercel.com') throw new Error('users_not_found')
      return { user: { id: 'U_ADA', name: 'ada', profile: { display_name: 'ada', real_name: 'Ada' } } }
    })
    const client = { conversations: { list: async () => ({ channels: [] }), info: async () => ({}), join: async () => ({}) }, users: { info: async () => ({}), lookupByEmail } }
    const pongSlack = fakePlatform('slack', withSlackClient(client, false))
    const webSlack = fakePlatform('slack')
    const project = (principal: string, url: string, sync: NonNullable<Parameters<typeof board>[0]>['sync']) =>
      board({ backend: vercel({ team: 'team_test', api: API, fetch: as(api, principal), files: api.files }), url, basePath: '/api/board', sync })
    const pong = project('project:prj_pong:production', PONG_URL, { slack: slack({ adapter: pongSlack.adapter, client: async () => client as never }, channels({ C1: 'general' })) })
    const web = project('project:prj_web:production', WEB_URL, { webchat: slack({ adapter: webSlack.adapter }, channels({ C9: 'general' })) })
    // Each one's Slack brings in its own Malte.
    const webhook = (deployment: typeof pong, url: string, key: string, body: object) =>
      deployment.fetch(new Request(`${url}/webhooks/${key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'message', ...body }) }))
    await webhook(pong, PONG_URL, 'slack', { threadId: 'slack:C1:300', id: '300', text: 'hi', user: 'U_M1', name: 'malte' })
    await webhook(web, WEB_URL, 'webchat', { threadId: 'slack:C9:400', id: '400', text: 'hej', user: 'U_M2', name: 'malte' })
    const julian = handleOn(api)
    await vi.waitFor(async () => expect((await julian.channel('general').messages()).messages).toHaveLength(2))
    await julian.post('general', { text: '@malte have a look, @pong/malte and @web/malte, cc @[ada@vercel.com] and @[slack:user:U_M1]' })
    await pong.fetch(new Request(`${PONG_URL}/wake`, { method: 'POST' }))
    await web.fetch(new Request(`${WEB_URL}/wake`, { method: 'POST' }))
    const posted = (platform: typeof pongSlack) => platform.channelPosts.map((post) => JSON.parse(post.text).markdown).filter((text: string) => text.includes('have a look'))
    await vi.waitFor(() => expect([posted(pongSlack), posted(webSlack)]).toEqual([
      ['**Ada Lovelace**: @malte have a look, <@U_M1> and malte, cc <@U_ADA> and <@U_M1>'],
      ['**Ada Lovelace**: @malte have a look, malte and <@U_M2>, cc ada@vercel.com and @[slack:user:U_M1]'],
    ]))
  })

  it("syncs Slack through the engine from its first webhook, a file as an attachment on the board, and a board reply back to Slack", async () => {
    const api = fakeMessageboard()
    const s = fakePlatform('slack')
    const pong = board({
      backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files }),
      url: PONG_URL,
      basePath: '/api/board',
      sync: { slack: slack({ adapter: s.adapter }, channels({ C1: 'general' })) },
    })
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    s.served.set('https://files.slack.test/shot.png', png)
    // The deployment's first request: nothing has registered its sync key with the API yet.
    const webhook = await pong.fetch(
      new Request(`${PONG_URL}/webhooks/slack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'message', threadId: 'slack:C1:300', id: '300', text: 'the export page', user: 'U_ADA',
          files: [{ name: 'shot.png', mimeType: 'image/png', url: 'https://files.slack.test/shot.png', size: png.byteLength }],
        }),
      }),
    )
    expect(webhook.status).toBe(200)
    const julian = handleOn(api)
    await vi.waitFor(async () => {
      const { messages } = await julian.channel('general').messages()
      expect(messages.map((message) => [message.from, message.text, message.attachments])).toEqual([
        ['pong/slack', 'the export page', [{ id: expect.any(String), name: 'shot.png', type: 'image/png', size: png.byteLength }]],
      ])
    })
    const [root] = (await julian.channel('general').messages()).messages
    // Anyone who reads the board reads the file, not only the project that uploaded it.
    expect(new Uint8Array(await (await julian.download(root!.attachments![0]!.id)).arrayBuffer())).toEqual(png)
    await julian.reply(root!.id, { text: 'looking' })
    await pong.fetch(new Request(`${PONG_URL}/wake`, { method: 'POST' }))
    await vi.waitFor(() => expect(s.posts.map((post) => [post.threadId, post.text])).toEqual([['slack:C1:300', expect.stringContaining('looking')]]))
  })

  it('reads, joins, and shows typing on Slack through its own sync, which has the app to do it with', async () => {
    const api = fakeMessageboard()
    const s = fakePlatform('slack')
    const web = {
      conversations: {
        list: async () => ({}),
        info: async ({ channel }: { channel: string }) => ({ channel: { id: channel, name: channel === 'C1' ? 'general' : 'random', is_member: channel === 'C1' } }),
        history: async () => ({ messages: [{ ts: '1700000000.000100', user: 'U_ADA', text: 'deploy is red' }] }),
        join: async () => ({}),
      },
      users: { info: async () => ({ user: { real_name: 'Ada' } }) },
    }
    const pong = board({
      backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files }),
      url: PONG_URL,
      basePath: '/api/board',
      sync: { slack: slack({ adapter: s.adapter, client: async () => web as never, join: true }, channels({ C1: 'general' })) },
    })
    expect(await pong.readSource('slack', 'C1')).toMatchObject({ channel: 'C1', name: 'general', messages: [{ author: 'Ada', text: 'deploy is red' }] })
    expect(await pong.joinSource('slack', 'C2')).toEqual({ channel: 'C2', name: 'random', joined: true })
    await pong.fetch(
      new Request(`${PONG_URL}/webhooks/slack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'message', threadId: 'slack:C1:300', id: '300', text: 'the export page', user: 'U_ADA' }),
      }),
    )
    const [root] = await vi.waitUntil(async () => {
      const { messages } = await handleOn(api).channel('general').messages()
      return messages.length > 0 && messages
    })
    await pong.typing(root!.id)
    expect(s.typing).toEqual(['slack:C1:300'])
  })

  it("edits a Slack copy when a label its renderer shows changes, a label taken off included", async () => {
    const api = fakeMessageboard()
    const s = fakePlatform('slack')
    const backend = vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files })
    const pong = board({
      backend,
      url: PONG_URL,
      basePath: '/api/board',
      sync: { slack: slack({ adapter: s.adapter }, render(({ message }) => `[${message.labels.state ?? '-'}] ${message.text}`, channels({ C1: 'general' }))) },
    })
    await backend.registerWatchers()
    const wake = () => pong.fetch(new Request(`${PONG_URL}/wake`, { method: 'POST' }))
    const julian = handleOn(api)
    const pr = await julian.post('general', { text: 'PR #1', labels: { state: 'draft' } })
    await wake()
    await vi.waitFor(() => expect(s.channelPosts.map((post) => post.text)).toEqual([JSON.stringify({ markdown: '[draft] PR #1' })]))
    await julian.label(pr.id, { set: { state: 'merged' } })
    await wake()
    await vi.waitFor(() => expect(s.edits.map((edit) => edit.text)).toEqual([JSON.stringify({ markdown: '[merged] PR #1' })]))
    await julian.label(pr.id, { unset: ['state'] })
    await wake()
    await vi.waitFor(() => expect(s.edits.map((edit) => edit.text)).toEqual([JSON.stringify({ markdown: '[merged] PR #1' }), JSON.stringify({ markdown: '[-] PR #1' })]))
  })

  it("hands a thread's new target to the sync that owns its key as thread.synced, about the thread's root", async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    const ping = handleOn(api, 'project:prj_ping:production')
    await pong.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    await ping.register({ url: null, watch: {}, sync: [{ key: 'linear', platform: 'linear' }] })
    const root = await pong.post('general', { text: 'sync me' })
    await pong.reply(root.id, { text: 'a reply' })
    await pong.syncReceipt({ kind: 'thread', message: root.id, target: 'slack:C1', targetKind: 'channel', cause: 'request' })
    const synced = (await drain(pong)).filter((match) => match.event.type === 'thread.synced')
    expect(synced.map((match) => [match.watcher, match.event.message?.id])).toEqual([['@sync', root.id]])
    const payload = boardEvents['thread.synced'].parse(synced[0]!.event.payload)
    expect(payload).toMatchObject({ thread: root.thread, target: 'slack:C1', kind: 'channel', cause: 'request', by: { actor: 'vercel:project:prj_pong:production' } })
    expect((await drain(ping)).filter((match) => match.event.type === 'thread.synced')).toEqual([])
  })

  it('filters its config watchers by --source, which the API can’t match, and the feed by where its messages came from', async () => {
    const api = fakeMessageboard()
    const ran: string[] = []
    const run = (watcher: string) => async ({ event }: { event: { message?: { text: string } | null } }) => {
      ran.push(`${watcher}: ${event.message!.text}`)
    }
    const pong = board({
      backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production') }),
      url: 'https://pong.example/api/board',
      basePath: '/api/board',
      watch: { imported: { tail: 'general --source slack', run: run('imported') }, written: { tail: 'general --source board', run: run('written') } },
    })
    await pong.me()
    while (!api.registrations.has('vercel:project:prj_pong:production')) await new Promise((resolve) => setTimeout(resolve, 5))
    // Its project's preview syncs Slack: a key of its own project's, which it names bare.
    const preview = handleOn(api, 'project:prj_pong:preview')
    await preview.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const author = { id: 'slack:user:U1', handle: 'jb', name: 'Julián', avatar: null, isBot: false }
    await preview.syncImport({ op: 'post', author, from: 'slack', channel: 'general', text: 'from slack', origin: { thread: 'slack:C1:1', subthread: null, message: '1', context: null } })
    await handleOn(api).post('general', { text: 'on the board' })
    await pong.fetch(new Request('https://pong.example/api/board/wake', { method: 'POST' }))
    expect(ran.sort()).toEqual(['imported: from slack', 'written: on the board'])
    // A person names it by its project, in the feed from its start.
    const person = handleOn(api)
    const { cursor: beginning } = await person.channel('nowhere').messages()
    const read = async (from: string) => (await person.poll({ channel: 'general', from, after: beginning })).events.map((event) => event.message?.text)
    expect(await read('pong/slack')).toEqual(['from slack'])
    expect(await read('board')).toEqual(['on the board'])
  })

  it("reads one channel's inbox events from as many as the API lists, so another channel's newer ones don't crowd them out", async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    await pong.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const author = { id: 'slack:user:U1', handle: 'jb', name: 'Julián', avatar: null, isBot: false }
    const pushed = (channel: string, message: string) => ({ id: `${channel}/${message}`, event: { kind: 'message' as const, channel, thread: `${channel}:1`, subthread: null, message, isRoot: true, text: 'hi', context: null, author }, raw: null })
    await pong.inboxPush('slack', [pushed('slack:C1', '1'), pushed('slack:C2', '1'), pushed('slack:C2', '2')])
    expect((await pong.inbox('slack', { channel: 'slack:C1', limit: 1 })).map((entry) => entry.id)).toEqual(['slack:C1/1'])
    expect((await pong.inbox('slack', { limit: 2 })).map((entry) => entry.id)).toEqual(['slack:C2/2', 'slack:C2/1'])
  })

  it('says when an inbox event was pushed as an ISO time, from the milliseconds the API answers', async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    await pong.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const author = { id: 'slack:user:U1', handle: 'jb', name: 'Julián', avatar: null, isBot: false }
    const before = Date.now()
    await pong.inboxPush('slack', [{ id: 'e1', event: { kind: 'message' as const, channel: 'slack:C1', thread: 'slack:C1:1', subthread: null, message: '1', isRoot: true, text: 'hi', context: null, author }, raw: null }])
    const [entry] = await pong.inbox('slack')
    expect(entry!.createdAt).toBe(new Date(entry!.createdAt).toISOString())
    expect(Date.parse(entry!.createdAt)).toBeGreaterThanOrEqual(before)
  })

  it('hashes a registration with its sync entries, as a board on http() does', async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    const watch = { w: { tail: 'general' } }
    await pong.register({ url: null, watch })
    expect(api.registrations.get('vercel:project:prj_pong:production')!.hash).toBe(watchersHash(watch))
    await pong.register({ url: null, watch, sync: [{ key: 'slack', platform: 'slack' }] })
    expect(api.registrations.get('vercel:project:prj_pong:production')!.hash).toBe(watchersHash(watch, [{ key: 'slack', platform: 'slack' }]))
  })

  it("refuses a project it names by name that turns out to be the run's own: by its handle, or after one grant it revokes where the API names it by ID", async () => {
    for (const [projectIdHandles, refusal] of [
      [false, "principals.project is this run's own project, web: "],
      // Only the API knows web is prj_web, so the kit asks it with a grant that changes nothing for the run.
      [true, "principals.project is this run's own project, web (prj_web)"],
    ] as const) {
      const api = fakeMessageboard({ projectIdHandles })
      await handleOn(api).createGrant({ principals: [{ kind: 'project', project: 'web', environments: ['production'] }], can: { '*': 'all' } })
      const before = [...api.grants.keys()]
      await expect(conformance(handleOn(api, 'project:prj_web:production'), { principals: { project: 'web', repository: 'acme/api' } })).rejects.toThrow(refusal)
      expect([...api.grants.keys()]).toEqual(before)
    }
  })

  it("fails a board whose team role lets a viewer post, in the conformance kit's viewer check", async () => {
    const api = fakeMessageboard()
    const real = as(api, 'user:u_jb')
    // The API, but its explain lets the viewer post.
    const posting: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      const response = await real(request)
      if (!new URL(request.url).pathname.endsWith('/grants/explain')) return response
      const text = (await response.text()).replace('"can":["read","react"]', '"can":["read","post","react"]')
      return new Response(text, { status: response.status, headers: response.headers })
    }
    const handle = board({ backend: vercel({ team: 'team_test', api: API, fetch: posting, files: api.files }) })
    const report = await conformance(handle, { principals: { project: 'prj_web', repository: 'acme/api', viewer: 'val@acme.com' } })
    expect(report.checks.find((check) => check.name.startsWith('caps a person by their team role'))).toMatchObject({
      status: 'failed',
      detail: 'what a viewer may do with a grant of all: expected read, and neither post nor manage, got ["read","post","react"]',
    })
  })

  it('keeps an app run in while it checks apps, so it revokes all it made', async () => {
    const api = fakeMessageboard()
    await handleOn(api).createGrant({ principals: [{ kind: 'app', app: 'deploy' }], can: { '*': 'all' } })
    const before = [...api.grants.keys()]
    const report = await conformance(handleOn(api, 'app:oac_2'), { principals: { project: 'prj_board', repository: 'acme/api', app: 'ship' } })
    expect(report.checks.find((check) => check.name.startsWith('names an app'))).toMatchObject({ status: 'passed' })
    expect([...api.grants.keys()]).toEqual(before)
  })

  it("gives back what Vercel's API refuses under the grant rules as the board's, grant_forbidden", async () => {
    const pong = handleOn(fakeMessageboard(), 'project:prj_pong:production')
    await expect(pong.grants()).rejects.toMatchObject({ status: 403, code: 'grant_forbidden', origin: 'board' })
    await expect(pong.createGrant({ principals: [{ kind: 'everyone' }], can: { 'dev/': [] } })).rejects.toMatchObject({ status: 403, code: 'grant_forbidden', message: expect.stringContaining('takes manage') })
  })

  it("gives back a lockout Vercel's API refuses as the board's, and sends lockMeOut and a batch through to it", async () => {
    const api = fakeMessageboard()
    await handleOn(api).createGrant({ principals: [{ kind: 'app', app: 'deploy' }], can: { '*': 'all' } })
    // An app is no team owner: what it manages, a grant can take from it.
    const app = handleOn(api, 'app:oac_2')
    const lock = { principals: [{ kind: 'everyone' }], can: { 'dev/': ['read'] } } as const
    await expect(app.createGrant(lock)).rejects.toMatchObject({ status: 409, code: 'grant_lockout', origin: 'board', message: expect.stringContaining('dev/') })
    const { grants } = await app.createGrants([lock, { principals: [{ kind: 'app', app: 'deploy' }], can: { 'dev/': 'all' } }])
    expect(grants.map((grant) => [grant.principals[0]?.kind, grant.can])).toEqual([
      ['everyone', { 'dev/': ['read'] }],
      ['app', { 'dev/': 'all' }],
    ])
    const [, keeps] = grants
    await expect(app.revokeGrant(keeps!.id)).rejects.toMatchObject({ status: 409, code: 'grant_lockout' })
    await expect(app.updateGrant(keeps!.id, { can: { 'dev/': ['read'] } })).rejects.toMatchObject({ status: 409, code: 'grant_lockout' })
    expect(await app.revokeGrant(keeps!.id, { lockMeOut: true })).toEqual({ revoked: true })
    await expect(app.createGrant({ principals: [{ kind: 'app', app: 'deploy' }], can: { 'dev/': 'all' } })).rejects.toMatchObject({ status: 403, code: 'grant_forbidden' })
  })

  it("sends grants to Vercel's API as people name their principals, and gives back what it answers, IDs and names", async () => {
    const api = fakeMessageboard()
    const jb = handleOn(api)
    expect(await jb.grants()).toEqual([
      { id: 'g1', principals: [{ kind: 'all-users' }], can: { '*': 'all' }, capped: true, by: null, at: null },
      { id: 'g2', principals: [{ kind: 'all-projects', environments: ['production', 'preview', 'development'] }], can: { '*': ['read', 'post', 'react', 'label', 'sync'] }, capped: false, by: null, at: null },
      { id: 'g3', principals: [{ kind: 'all-apps' }], can: { '*': ['read', 'post', 'react', 'label'] }, capped: false, by: null, at: null },
    ])
    const { grant } = await jb.createGrant({
      principals: [
        { kind: 'user', email: 'ada@acme.com' },
        { kind: 'project', project: 'web', environments: ['production'] },
        { kind: 'app', app: 'ship' },
      ],
      can: { 'security/': 'all' },
    })
    expect(grant.principals).toEqual([
      { kind: 'user', userId: 'u_ada', email: 'ada@acme.com' },
      { kind: 'project', projectId: 'prj_web', name: 'web', environments: ['production'], teamId: 'team_test' },
      { kind: 'app', clientId: 'oac_1', name: 'ship' },
    ])
    // A project it names already gets the new environments.
    const joined = await jb.updateGrant(grant.id, { add: [{ kind: 'project', project: 'prj_web', environments: ['preview'] }] })
    expect(joined.grant.principals[1]).toEqual({ kind: 'project', projectId: 'prj_web', name: 'web', environments: ['production', 'preview'], teamId: 'team_test' })
    const updated = await jb.updateGrant(grant.id, { add: [{ kind: 'user', email: 'bob@acme.com' }], remove: [{ kind: 'project', project: 'web' }, { kind: 'app', app: 'oac_1' }] })
    expect(updated.grant.principals.map((principal) => ('userId' in principal ? principal.userId : principal.kind))).toEqual(['u_ada', 'u_bob'])
    expect(await jb.explain('security/incidents', { user: 'bob@acme.com' })).toEqual({
      channel: 'security/incidents',
      pattern: 'security/',
      over: ['*'],
      level: 'principal',
      grants: [updated.grant],
      rule: null,
      capped: null,
      can: ['read', 'post', 'react', 'label', 'sync', 'manage'],
    })
    // A viewer's role caps what g1 gives them.
    expect(await jb.explain('dev', { user: 'val@acme.com' })).toMatchObject({ pattern: '*', level: 'group', grants: [{ id: 'g1' }], capped: 'viewer', can: ['read', 'react'] })
    // An app on the team, by its slug: g3 lets every one in.
    expect(await jb.explain('dev', { app: 'ship' })).toMatchObject({ pattern: '*', level: 'group', grants: [{ id: 'g3' }], can: ['read', 'post', 'react', 'label'] })
    expect((await jb.revokeGrant(grant.id)).revoked).toBe(true)
    expect(api.requests).toEqual(
      expect.arrayContaining([
        'POST /boards/brd_test/grants',
        `PATCH /boards/brd_test/grants/${grant.id}`,
        'GET /boards/brd_test/grants/explain',
        `POST /boards/brd_test/grants/${grant.id}/revoke`,
      ]),
    )
  })

  it("sends grants naming a repository's runs or an OIDC issuer to Vercel's API, made, added, and explained", async () => {
    const api = fakeMessageboard()
    const jb = handleOn(api)
    const { grant } = await jb.createGrant({ principals: [{ kind: 'github', repository: 'acme/web', branch: 'main' }], can: { 'ci/': ['post'] } })
    expect(grant.principals).toEqual([{ kind: 'github', repositoryId: '700001', repository: 'acme/web', branch: 'main' }])
    const issuer = { kind: 'oidc', issuer: 'https://gitlab.com', claims: { sub: 'project_path:acme/api:*', project_id: '42' } } as const
    const updated = await jb.updateGrant(grant.id, { add: [issuer] })
    expect(updated.grant.principals).toEqual([{ kind: 'github', repositoryId: '700001', repository: 'acme/web', branch: 'main' }, issuer])
    // The API names an issuer's caller by its sub, as a board does.
    for (const claims of [{ project_id: '42' }, { sub: 'project_path:acme*' }] as Record<string, string>[])
      await expect(jb.updateGrant(grant.id, { add: [{ kind: 'oidc', issuer: 'https://gitlab.com', claims }] })).rejects.toMatchObject({ status: 400, code: 'invalid_grant' })
    const [made] = (await jb.createGrants([{ principals: [{ kind: 'github', repository: 'acme/api', event: 'push' }], can: { 'deploys/': ['read'] } }])).grants
    expect(made?.principals).toEqual([{ kind: 'github', repositoryId: '700002', repository: 'acme/api', event: 'push' }])
    // What the API decides for a run on main, and for one on another branch, which the grant doesn't name.
    expect(await jb.explain('ci/www', { github: 'acme/web', branch: 'main' })).toMatchObject({ pattern: 'ci/', level: 'principal', grants: [{ id: grant.id }], can: ['post'] })
    expect(await jb.explain('ci/www', { github: 'acme/web', branch: 'dev' })).toMatchObject({ pattern: null, grants: [], can: [] })
    expect(await jb.explain('ci/www', { oidc: 'https://gitlab.com', claims: { sub: 'project_path:acme/api:ref_type:branch:ref:main', project_id: '42' } })).toMatchObject({ pattern: 'ci/', grants: [{ id: grant.id }], can: ['post'] })
    expect(await jb.explain('ci/www', { oidc: 'https://gitlab.com', claims: { sub: 'project_path:acme/api-evil:ref_type:branch:ref:main', project_id: '42' } })).toMatchObject({ pattern: null, grants: [], can: [] })
  })

  it("says what an API that takes no GitHub or OIDC principal answers, in its own words and nothing else", async () => {
    const api = fakeMessageboard()
    const refused = { code: 'unsupported_principal', message: 'Grants name no GitHub or OIDC principals.' }
    // An API from before it took them, which answers each with a 400 of its own.
    const older: typeof fetch = async (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const body = typeof init.body === 'string' ? init.body : ''
      if ((url.pathname.includes('/grants') && /"kind":"(github|oidc)"/.test(body)) || url.searchParams.has('github') || url.searchParams.has('oidc'))
        return Response.json({ error: refused }, { status: 400 })
      return as(api, 'user:u_jb')(input, init)
    }
    const jb = board({ backend: vercel({ team: 'team_test', api: API, fetch: older }) })
    const theirs = { status: 400, ...refused, origin: 'board', hint: undefined }
    await expect(jb.createGrant({ principals: [{ kind: 'github', repository: 'acme/web' }], can: { 'ci/': ['post'] } })).rejects.toMatchObject(theirs)
    const { grant } = await jb.createGrant({ principals: [{ kind: 'app', app: 'ship' }], can: { 'ci/': ['post'] } })
    await expect(jb.updateGrant(grant.id, { add: [{ kind: 'oidc', issuer: 'https://gitlab.com', claims: { sub: 'project_path:acme/api:*', project_id: '42' } }] })).rejects.toMatchObject(theirs)
    await expect(jb.explain('ci', { github: 'acme/web' })).rejects.toMatchObject(theirs)
  })

  it("gives back grants' times as the protocol has them, though the API answers milliseconds", async () => {
    const api = fakeMessageboard()
    const jb = handleOn(api)
    const before = Date.now()
    const { grant } = await jb.createGrant({ principals: [{ kind: 'user', email: 'ada@acme.com' }], can: { 'ci/': ['read'] } })
    expect(Date.parse(grant.at!)).toBeGreaterThanOrEqual(before)
    expect(grant.at).toBe(new Date(Date.parse(grant.at!)).toISOString())
    expect((await jb.grants()).find((listed) => listed.id === grant.id)?.at).toBe(grant.at)
    expect((await jb.explain('ci', { user: 'ada@acme.com' })).grants).toMatchObject([{ id: grant.id, at: grant.at }])
    expect((await jb.updateGrant(grant.id, { can: { 'ci/': ['read', 'post'] } })).grant.at).toMatch(/^\d{4}-\d\d-\d\dT/)
  })
})

describe("each project's sync keys on Vercel's API", () => {
  const NAMES = { prj_support: 'support', prj_www: 'www' }
  const SUPPORT_URL = 'https://support.example/api/board'
  const PREVIEW_URL = 'https://support-git-fix.example/api/board'
  const WWW_URL = 'https://www.example/api/board'

  /** A deployment of a project on the fake's board, with `options`: its board, its backend, and what it asked the API, as `METHOD /path` under its board. */
  function deployment(api: ReturnType<typeof fakeMessageboard>, principal: string, url: string, options: Pick<NonNullable<Parameters<typeof board>[0]>, 'sync' | 'watch'>) {
    const asked: string[] = []
    const fetch = as(api, principal)
    const backend = vercel({
      team: 'team_test',
      api: API,
      files: api.files,
      fetch: (input, init) => {
        const request = new Request(input, init)
        asked.push(`${request.method} ${new URL(request.url).pathname.replace(/^\/v1\/messageboard(\/boards\/[^/]+)?/, '')}`)
        return fetch(input, init)
      },
    })
    onTestFinished(() => backend.close())
    const team = board({ backend, url, basePath: '/api/board', ...options })
    const webhook = (key: string, body: object) =>
      team.fetch(new Request(`${url}/webhooks/${key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'message', ...body }) }))
    return { team, backend, asked, webhook, wake: () => team.fetch(new Request(`${url}/wake`, { method: 'POST' })) }
  }
  const markdown = (posts: { text: string }[]) => posts.map((post) => JSON.parse(post.text).markdown as string)

  it("syncs a key two projects each call slack for each, the board's posts to both Slacks, and one's import to the other's, never back", async () => {
    const api = fakeMessageboard({ projects: NAMES })
    const getPermalink = async ({ channel, message_ts }: { channel: string; message_ts: string }) => ({ permalink: `https://acme.slack.com/archives/${channel}/p${message_ts.replace('.', '')}` })
    const client = { conversations: { list: async () => ({}), info: async () => ({}), join: async () => ({}) }, chat: { getPermalink } }
    const supportSlack = fakePlatform('slack', withSlackClient(client, false))
    const wwwSlack = fakePlatform('slack', withSlackClient(client, false))
    const support = deployment(api, 'project:prj_support:production', SUPPORT_URL, { sync: { slack: slack({ adapter: supportSlack.adapter }, channels({ C_SUP: 'general' })) } })
    const www = deployment(api, 'project:prj_www:production', WWW_URL, { sync: { slack: slack({ adapter: wwwSlack.adapter }, channels({ C_WWW: 'general' })) } })
    await support.backend.registerWatchers()
    await www.backend.registerWatchers()
    const julian = handleOn(api)
    const root = await julian.post('general', { text: 'checkout is down' })
    await Promise.all([support.wake(), www.wake()])
    await vi.waitFor(() => expect([markdown(supportSlack.channelPosts), markdown(wwwSlack.channelPosts)]).toEqual([['**Ada Lovelace**: checkout is down'], ['**Ada Lovelace**: checkout is down']]))
    // Ada answers in www's Slack thread: www imports it, and support's Slack gets it.
    const webhook = await www.webhook('slack', { threadId: `slack:C_WWW:${wwwSlack.channelPosts[0]!.id}`, id: '500', text: 'on it', user: 'U_ADA', name: 'Ada' })
    expect(webhook.status).toBe(200)
    await vi.waitFor(async () => expect((await julian.thread(root.id)).replies.map((reply) => reply.text)).toEqual(['on it']))
    await Promise.all([support.wake(), www.wake()])
    await vi.waitFor(() =>
      expect(supportSlack.posts.map((post) => [post.threadId, JSON.parse(post.text).markdown])).toEqual([[`slack:C_SUP:${supportSlack.channelPosts[0]!.id}`, '**Ada via www (slack)**: on it']]),
    )
    expect(wwwSlack.posts).toEqual([])
    // Each names its own project's key bare, and the other's by its project; a person names both by theirs.
    const from = async (team: { thread(id: string): Promise<{ replies: { from: string | null }[] }> }) => (await team.thread(root.id)).replies.map((reply) => reply.from)
    expect([await from(www.team), await from(support.team), await from(julian)]).toEqual([['slack'], ['www/slack'], ['www/slack']])
    // Only its own sync, which has the app, links its copies.
    // Each binds its target as it starts the thread, so they come in whichever order the two did.
    const targets = async (team: typeof julian) => (await team.sync(root.id)).targets.map(({ key, target, url }) => [key, target, url]).sort(([a], [b]) => a!.localeCompare(b!))
    expect(await targets(support.team)).toEqual([
      ['slack', 'slack:C_SUP', `https://acme.slack.com/archives/C_SUP/p${supportSlack.channelPosts[0]!.id}`],
      ['www/slack', 'www/slack:C_WWW', null],
    ])
    // Support has imported no one, but its deployment wrote as itself, by its project's name.
    expect(await targets(julian)).toEqual([
      ['support/slack', 'support/slack:C_SUP', null],
      ['www/slack', 'www/slack:C_WWW', null],
    ])
  })

  it("names another project by the handle its deployments and their agents go by, else by what its users say, else by its ID", async () => {
    for (const [projectIdHandles, keys] of [
      [false, ['support/slack', 'www/slack']],
      // An API that names a deployment by its ID, and its profiles under that, names support nowhere, and www on the user it imported.
      [true, ['prj_support/slack', 'www/slack']],
    ] as const) {
      const api = fakeMessageboard({ projects: NAMES, projectIdHandles })
      const support = handleOn(api, 'project:prj_support:production')
      const www = handleOn(api, 'project:prj_www:production')
      for (const project of [support, www]) await project.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
      const julian = handleOn(api)
      const root = await julian.post('general', { text: 'checkout is down' })
      // Support binds the thread through its sync, as a profile of its deployment, www as its deployment, and www brings Ada's reply in.
      await support.as('sync').syncReceipt({ kind: 'thread', message: root.id, target: 'slack:C_SUP', targetKind: 'channel', cause: 'request' })
      await www.syncReceipt({ kind: 'thread', message: root.id, target: 'slack:C_WWW:1', targetKind: 'thread', cause: 'request' })
      const ada = { id: 'slack:user:U_ADA', handle: 'ada', name: 'Ada', avatar: null, isBot: false }
      await www.syncImport({ op: 'post', author: ada, from: 'slack', re: root.id, text: 'on it', origin: { thread: 'slack:C_WWW:1', subthread: null, message: '2', context: null } })
      expect((await julian.sync(root.id)).targets.map((target) => target.key)).toEqual(keys)
      expect((await julian.thread(root.id)).replies.map((reply) => reply.from)).toEqual(['www/slack'])
      expect((await support.thread(root.id)).replies.map((reply) => reply.from)).toEqual(['www/slack'])
    }
  })

  it("says another project's deployment holds a key by its project's name, where the API names it", async () => {
    for (const [projectIdHandles, holder] of [
      [false, 'www (production)'],
      [true, 'prj_www (production)'],
    ] as const) {
      const api = fakeMessageboard({ projects: NAMES, projectIdHandles })
      await handleOn(api, 'project:prj_www:production').post('general', { text: 'deployed' })
      const said = vi.spyOn(console, 'info').mockImplementation(() => {})
      const fetch = as(api, 'project:prj_support:production')
      // An API that says a key of support's is another project's deployment's.
      const backend = vercel({
        team: 'team_test',
        api: API,
        fetch: async (input, init) => {
          const request = new Request(input, init)
          const response = await fetch(input, init)
          if (request.method !== 'PUT' || !new URL(request.url).pathname.endsWith('/watchers')) return response
          const elsewhere = [{ key: 'slack', platform: 'slack', owner: 'vercel:project:prj_www:production', environment: 'production' }]
          return Response.json({ ...(await response.json()), sync: [], elsewhere })
        },
      })
      board({ backend, url: SUPPORT_URL, basePath: '/api/board', sync: { slack: slack({ adapter: fakePlatform('slack').adapter }, channels({ C_SUP: 'general' })) } })
      await backend.registerWatchers()
      backend.close()
      expect(said.mock.calls).toEqual([[`[board] slack is synced by ${holder}`]])
      said.mockRestore()
    }
  })

  it("runs nothing through a key production holds from a preview, whose watchers run, and says once who has it", async () => {
    const api = fakeMessageboard({ projects: NAMES })
    const productionSlack = fakePlatform('slack')
    const production = deployment(api, 'project:prj_support:production', SUPPORT_URL, { sync: { slack: slack({ adapter: productionSlack.adapter }, channels({ C_SUP: 'general' })) } })
    await production.backend.registerWatchers()
    const said = vi.spyOn(console, 'info').mockImplementation(() => {})
    onTestFinished(() => said.mockRestore())
    const previewSlack = fakePlatform('slack')
    const offered: string[] = []
    const ran: string[] = []
    const preview = deployment(api, 'project:prj_support:preview', PREVIEW_URL, {
      sync: {
        slack: slack({ adapter: previewSlack.adapter }, async (sync) => void offered.push(sync.direction)),
        // A key of its own, which has the API hand it every post on the board.
        alerts: slack({ adapter: fakePlatform('slack').adapter }, channels({ C_ALERTS: 'alerts' })),
      },
      watch: { seen: { tail: 'general', run: async ({ event }) => void ran.push(event.message!.text) } },
    })
    // Slack's webhook is answered, and nothing of it lands: the adapter never reads it.
    const read = vi.spyOn(previewSlack.adapter, 'handleWebhook')
    const webhook = await preview.webhook('slack', { threadId: 'slack:C_SUP:300', id: '300', text: 'to the preview', user: 'U_ADA', name: 'Ada' })
    expect(webhook.status).toBe(200)
    expect(read).not.toHaveBeenCalled()
    await handleOn(api).post('general', { text: 'deploy failed' })
    await Promise.all([production.wake(), preview.wake()])
    await vi.waitFor(() => expect(markdown(productionSlack.channelPosts)).toEqual(['**Ada Lovelace**: deploy failed']))
    await vi.waitFor(() => expect(ran).toEqual(['deploy failed']))
    // It registers again once its last registration is old: still not its key, and nothing more to say.
    const now = Date.now.bind(Date)
    vi.spyOn(Date, 'now').mockImplementation(() => now() + 60_000)
    onTestFinished(() => vi.mocked(Date.now).mockRestore())
    await preview.backend.registerWatchers()
    await preview.wake()
    expect(preview.asked.filter((asked) => asked === 'PUT /watchers').length).toBeGreaterThan(1)
    expect(offered).toEqual([])
    expect([previewSlack.channelPosts, previewSlack.posts]).toEqual([[], []])
    expect(preview.asked.filter((asked) => /\/sync\/(imports|receipts|inbox\/slack)/.test(asked))).toEqual([])
    expect((await handleOn(api).channel('general').messages()).messages.map((message) => message.text)).toEqual(['deploy failed'])
    expect(said.mock.calls).toEqual([['[board] slack is synced by production']])
  })

  it("posts a deployment to Slack under its project's name, keeping its environment whole when the name is cut to fit", async () => {
    const project = `www-${'x'.repeat(86)}`
    const api = fakeMessageboard({ projects: { ...NAMES, prj_www: project } })
    const posted: Record<string, unknown>[] = []
    const client = {
      conversations: { list: async () => ({}), info: async () => ({}), replies: async () => ({ messages: [] }) },
      chat: { postMessage: async (args: Record<string, unknown>) => (posted.push(args), { ts: `1700000000.00010${posted.length}` }) },
      auth: { test: async () => ({ response_metadata: { scopes: ['chat:write', 'chat:write.customize'] } }) },
    }
    const s = fakePlatform('slack', (adapter) => {
      withSlackClient(client, false)(adapter)
      Object.assign(adapter, {
        formatConverter: { toSlackPayload: (message: { markdown: string }) => ({ markdown_text: message.markdown }) },
        decodeThreadId: (id: string) => ({ channel: id.split(':')[1], threadTs: id.split(':')[2] ?? '' }),
      })
    })
    const support = deployment(api, 'project:prj_support:production', SUPPORT_URL, { sync: { slack: slack({ adapter: s.adapter, client: async () => client as never }, channels({ C_SUP: 'general' })) } })
    await support.backend.registerWatchers()
    for (const environment of ['preview', 'production']) await handleOn(api, `project:prj_www:${environment}`).post('general', { text: environment })
    await support.wake()
    await vi.waitFor(() => expect(posted).toHaveLength(2))
    // The two roots go out side by side: each by what it says.
    const by = Object.fromEntries(posted.map(({ username, markdown_text }) => [markdown_text as string, username as string]))
    expect(by.preview).toMatch(/^www-x+… \(preview\)$/)
    expect(by.production).toMatch(/^www-x+…$/)
    for (const username of Object.values(by)) expect(Array.from(username).length).toBeLessThanOrEqual(80)
  })

  it("stops syncing a key production takes from it moments after it registered, at the first call the API refuses", async () => {
    // On Vercel, where each registers its path and never pulls on its own: only what the test does registers.
    for (const [name, value] of Object.entries({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_TARGET_ENV: '', VERCEL_GIT_COMMIT_REF: '' })) vi.stubEnv(name, value)
    onTestFinished(() => void vi.unstubAllEnvs())
    const api = fakeMessageboard({ projects: NAMES })
    const said = vi.spyOn(console, 'info').mockImplementation(() => {})
    onTestFinished(() => said.mockRestore())
    const preview = deployment(api, 'project:prj_support:preview', PREVIEW_URL, { sync: { slack: slack({ adapter: fakePlatform('slack').adapter }, channels({ C_SUP: 'general' })) } })
    await preview.backend.registerWatchers()
    expect(api.registrations.get('vercel:project:prj_support:preview')?.sync).toEqual([{ key: 'slack', platform: 'slack' }])
    const production = deployment(api, 'project:prj_support:production', SUPPORT_URL, { sync: { slack: slack({ adapter: fakePlatform('slack').adapter }, channels({ C_SUP: 'general' })) } })
    await production.backend.registerWatchers()
    // The preview still holds slack as far as it knows: the API's refusal of its webhook's event tells it otherwise.
    const body = { threadId: 'slack:C_SUP:300', id: '300', text: 'to the preview', user: 'U_ADA', name: 'Ada' }
    expect((await preview.webhook('slack', body)).status).toBe(200)
    expect(preview.asked.filter((asked) => asked === 'PUT /watchers')).toHaveLength(2)
    expect(said.mock.calls).toEqual([['[board] slack is synced by production']])
    // From then on it asks the API nothing through the key.
    const asked = preview.asked.length
    expect((await preview.webhook('slack', { ...body, id: '301' })).status).toBe(200)
    expect(preview.asked.slice(asked).filter((call) => /\/sync\//.test(call))).toEqual([])
    expect((await handleOn(api).channel('general').messages()).messages).toEqual([])
  })

  it("takes no other project's thread an API hands it under a key of its own name", async () => {
    // An API that hands a thread's binding to every registrant of its key, and lists every target of a thread.
    const api = fakeMessageboard({ projects: NAMES, unscopedSync: true })
    const supportSlack = fakePlatform('slack')
    const support = deployment(api, 'project:prj_support:production', SUPPORT_URL, { sync: { slack: slack({ adapter: supportSlack.adapter }, channels({ C_SUP: 'general' })) } })
    await support.backend.registerWatchers()
    const www = handleOn(api, 'project:prj_www:production')
    await www.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    // A thread in a channel support doesn't mirror, which www syncs to its own Slack.
    const root = await handleOn(api).post('random', { text: 'checkout is down' })
    await www.syncReceipt({ kind: 'thread', message: root.id, target: 'slack:C_WWW', targetKind: 'channel', cause: 'request' })
    await support.wake()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect([supportSlack.channelPosts, supportSlack.posts]).toEqual([[], []])
    expect(support.asked.filter((asked) => asked === 'POST /sync/receipts')).toEqual([])
  })

  it("delivers to no target under a key another deployment holds, though an API lists it", async () => {
    const api = fakeMessageboard({ projects: NAMES, unscopedSync: true })
    const productionSlack = fakePlatform('slack')
    const production = deployment(api, 'project:prj_support:production', SUPPORT_URL, { sync: { slack: slack({ adapter: productionSlack.adapter }, channels({ C_SUP: 'general' })) } })
    await production.backend.registerWatchers()
    const previewSlack = fakePlatform('slack')
    const preview = deployment(api, 'project:prj_support:preview', PREVIEW_URL, {
      sync: {
        slack: slack({ adapter: previewSlack.adapter }, channels({ C_SUP: 'general' })),
        // A key of its own, which has the API hand it every post on the board.
        alerts: slack({ adapter: fakePlatform('slack').adapter }, channels({ C_ALERTS: 'alerts' })),
      },
    })
    await preview.backend.registerWatchers()
    const julian = handleOn(api)
    const root = await julian.post('general', { text: 'deploy failed' })
    await production.wake()
    await vi.waitFor(() => expect(markdown(productionSlack.channelPosts)).toEqual(['**Ada Lovelace**: deploy failed']))
    await julian.reply(root.id, { text: 'rolled back' })
    await Promise.all([production.wake(), preview.wake()])
    await vi.waitFor(() => expect(markdown(productionSlack.posts)).toEqual(['**Ada Lovelace**: rolled back']))
    await preview.wake()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect([previewSlack.channelPosts, previewSlack.posts]).toEqual([[], []])
  })

  it("finds another project's imports by its name, though the filter was made before the project imported anything", async () => {
    const api = fakeMessageboard({ projects: NAMES })
    const julian = handleOn(api)
    const { cursor: beginning } = await julian.channel('nowhere').messages()
    await julian.post('general', { text: 'before www syncs' })
    const read = async () => (await julian.poll({ channel: 'general', from: 'www/slack', after: beginning })).events.map((event) => event.message?.text)
    // Twice, so the names it reads are kept, and nothing in them is www.
    expect([await read(), await read()]).toEqual([[], []])
    const www = handleOn(api, 'project:prj_www:production')
    await www.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const ada = { id: 'slack:user:U_ADA', handle: 'ada', name: 'Ada', avatar: null, isBot: false }
    await www.syncImport({ op: 'post', author: ada, from: 'slack', channel: 'general', text: 'checkout is down', origin: { thread: 'slack:C1:1', subthread: null, message: '1', context: null } })
    expect(await read()).toEqual(['checkout is down'])
    // By the project's ID as by its name, and a bare key is the caller's own project's: a person has none.
    const from = async (source: string) => (await julian.poll({ channel: 'general', from: source, after: beginning })).events.map((event) => event.message?.text)
    expect(await from('prj_www/slack')).toEqual(['checkout is down'])
    expect(await from('slack')).toEqual([])
    // Inside www, its own key is as its sync names it.
    expect((await www.poll({ channel: 'general', from: 'slack', after: beginning })).events.map((event) => event.message?.text)).toEqual(['checkout is down'])
  })

  it("takes a deployment by the name it shows for --by, a watcher's included, on an API that names it by its ID too", async () => {
    for (const projectIdHandles of [false, true]) {
      const api = fakeMessageboard({ projects: NAMES, projectIdHandles })
      const www = handleOn(api, 'project:prj_www:production')
      await www.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
      // An import of www's names it, wherever the API names its deployments by their IDs.
      const ada = { id: 'slack:user:U_ADA', handle: 'ada', name: 'Ada', avatar: null, isBot: false }
      await www.syncImport({ op: 'post', author: ada, from: 'slack', channel: 'random', text: 'hi', origin: { thread: 'slack:C1:1', subthread: null, message: '1', context: null } })
      const root = await www.post('general', { text: 'deployed' })
      await handleOn(api, 'project:prj_www:preview').reply(root.id, { text: 'deployed a preview' })
      await handleOn(api).post('general', { text: 'not www' })
      const julian = handleOn(api)
      expect((await julian.thread(root.id)).message.author).toMatchObject({ handle: 'www' })
      const { cursor: beginning } = await julian.channel('nowhere').messages()
      expect((await julian.poll({ channel: 'general', by: 'www', after: beginning })).events.map((event) => event.message?.text)).toEqual(['deployed', 'deployed a preview'])
      const pong = handleOn(api, 'project:prj_pong:production')
      await pong.register({ url: null, watch: { deploys: { tail: 'general --by www' } } })
      expect(api.registrations.get('vercel:project:prj_pong:production')!.watch.deploys!.filter.authors!.sort()).toEqual(['vercel:project:prj_www:preview', 'vercel:project:prj_www:production'])
    }
  })

  it("syncs every key it registered against an API from before each project had its own, which refuses a second registrant's, and names each target its own", async () => {
    const api = fakeMessageboard({ projects: NAMES, boardWideKeys: true })
    const s = fakePlatform('slack')
    const production = deployment(api, 'project:prj_support:production', SUPPORT_URL, { sync: { slack: slack({ adapter: s.adapter }, channels({ C_SUP: 'general' })) } })
    await production.backend.registerWatchers()
    const preview = deployment(api, 'project:prj_support:preview', PREVIEW_URL, { sync: { slack: slack({ adapter: fakePlatform('slack').adapter }, channels({ C_SUP: 'general' })) } })
    await expect(preview.backend.registerWatchers()).rejects.toMatchObject({ status: 409, code: 'sync_key_taken' })
    expect((await production.webhook('slack', { threadId: 'slack:C_SUP:300', id: '300', text: 'from slack', user: 'U_ADA', name: 'Ada' })).status).toBe(200)
    const julian = handleOn(api)
    await vi.waitFor(async () => expect((await julian.channel('general').messages()).messages.map((message) => message.text)).toEqual(['from slack']))
    const root = await julian.post('general', { text: 'deploy failed' })
    await production.wake()
    await vi.waitFor(() => expect(markdown(s.channelPosts)).toEqual(['**Ada Lovelace**: deploy failed']))
    // Its targets name no project: each is the reader's own.
    expect((await julian.sync(root.id)).targets.map(({ key, target }) => [key, target])).toEqual([['slack', 'slack:C_SUP']])
  })
})

describe("callers on Vercel's API", () => {
  /** Pong's deployment, through an API that answers its posts with IDs only, as it answers a caller that may post in a channel but not read it. */
  const postOnly = (api: ReturnType<typeof fakeMessageboard>) => {
    const idsOnly = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await as(api, 'project:prj_pong:production')(input, init)
      const { pathname } = new URL(new Request(input, init).url)
      if (!response.ok || !/\/(threads|posts\/[^/]+)$/.test(pathname)) return response
      const { thread, message } = (await response.json()) as { thread: { id: string }; message: { id: string; threadId: string; sequence: number } }
      return Response.json({ thread: { id: thread.id }, message: { id: message.id, threadId: message.threadId, sequence: message.sequence } })
    }) as typeof fetch
    return board({ backend: vercel({ team: 'team_test', api: API, fetch: idsOnly, files: api.files }) })
  }

  it("answers 401 invalid_token for credentials Vercel's API doesn't take", async () => {
    await expect(handleOn(fakeMessageboard(), 'not-a-token').me()).rejects.toMatchObject({ status: 401, code: 'invalid_token' })
  })

  it("gets back a post-only caller's post and its retry as it sent them, though the API answers each with IDs only", async () => {
    const api = fakeMessageboard()
    const ci = postOnly(api)
    const first = await ci.post('ci', { id: 'run-42', text: 'build green', labels: { run: '42' } })
    const again = await ci.post('ci', { id: 'run-42', text: 'build green', labels: { run: '42' } })
    expect(again).toMatchObject({ id: first.id, thread: first.thread, channel: 'ci', text: 'build green', labels: { run: '42' }, re: null, by: first.by, author: first.author })
    // It's the one post: the retry made no other.
    expect((await handleOn(api).channel('ci').messages()).messages.map((message) => message.id)).toEqual([first.id])
  })

  it('names the channel a retried post landed in, not the one the retry names', async () => {
    const api = fakeMessageboard()
    const jb = handleOn(api)
    const first = await jb.post('dev', { id: 'once', text: 'hi' })
    expect(await jb.post('ops', { id: 'once', text: 'hi' })).toMatchObject({ id: first.id, channel: 'dev' })
  })

  it('starts a thread in one call to the API, in a channel new or not, for a reader and a post-only caller alike', async () => {
    const api = fakeMessageboard()
    const ci = postOnly(api)
    const jb = handleOn(api)
    const before = api.requests.length
    for (const [handle, channel] of [[jb, 'ops'], [jb, 'ops'], [ci, 'ci'], [ci, 'ci']] as const) expect(await handle.post(channel, { text: 'hi' })).toMatchObject({ channel })
    // Neither looks the channel up, makes it, or lists channels to name it.
    expect(api.requests.slice(before).filter((request) => /\/(channels|threads)/.test(request))).toEqual(Array(4).fill('POST /boards/brd_test/threads'))
  })

  it("says plainly that only a deployment's own credentials register watchers, to a person and an app", async () => {
    const api = fakeMessageboard()
    for (const handle of [handleOn(api), handleOn(api, 'app:oac_1')])
      await expect(handle.register({ url: null, watch: { open: { tail: 'dev/' } } })).rejects.toMatchObject({
        status: 403,
        code: 'watchers_need_project',
        origin: 'handle',
        message: "Vercel's API takes watchers only from a deployment's own credentials.",
        hint: expect.stringContaining("Watchers in board()'s config run in this process instead."),
      })
    expect(api.registrations.size).toBe(0)
    // A pull, an ack, and a listing the API refuses the same way say the same.
    const refusing = board({
      backend: vercel({
        team: 'team_test', api: API, board: 'brd_test',
        fetch: async (input, init) => (/\/watchers/.test(new URL(new Request(input, init).url).pathname) ? Response.json({ error: { code: 'watchers_need_project', message: 'no' } }, { status: 403 }) : as(api, 'user:u_jb')(input, init)),
      }),
    })
    for (const attempt of [refusing.matches({}), refusing.ack('mat_1', { lease: 'l' }), refusing.watchers()])
      await expect(attempt).rejects.toMatchObject({ status: 403, code: 'watchers_need_project', origin: 'handle', message: "Vercel's API takes watchers only from a deployment's own credentials." })
  })
})

describe('a request the API puts off', () => {
  /** Julian on a board whose API answers `refuse(request)`'s response instead of its own, when it gives one. */
  const throttled = (refuse: (url: URL, init: RequestInit | undefined, answer: () => Promise<Response>) => Promise<Response | null> | Response | null) => {
    const api = fakeMessageboard()
    const inner = as(api, 'user:u_jb')
    const sent: { method: string; path: string; at: number }[] = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input))
      sent.push({ method: init?.method ?? 'GET', path: url.pathname, at: Date.now() })
      return (await refuse(url, init, () => inner(input, init))) ?? inner(input, init)
    }
    return { api, sent, julian: board({ backend: vercel({ team: 'team_test', api: API, fetch, files: api.files }) }) }
  }
  const tooMany = (retryAfter = '60') => Response.json({ error: { code: 'rate_limited', message: 'Too many requests' } }, { status: 429, headers: { 'retry-after': retryAfter } })
  const busy = () => Response.json({ error: { code: 'board_busy', message: 'retry shortly' } }, { status: 503, headers: { 'retry-after': '2' } })
  const posts = (sent: { method: string; path: string }[]) => sent.filter(({ method, path }) => method === 'POST' && path.endsWith('/threads'))
  const timers = () => {
    vi.useFakeTimers()
    onTestFinished(() => void vi.useRealTimers())
  }

  it('waits and posts once when the API says 429, well inside the minute it asks for', async () => {
    timers()
    let refusals = 2
    const { julian, sent } = throttled((url, init) => (init?.method === 'POST' && url.pathname.endsWith('/threads') && refusals-- > 0 ? tooMany() : null))
    const posting = julian.post('dev', { text: 'hi' })
    // A second, then two, each with up to as much again: both waits are over within six.
    await vi.advanceTimersByTimeAsync(6000)
    const { id } = await posting
    expect(posts(sent)).toHaveLength(3)
    const { threads } = await julian.threads({ channel: 'dev' })
    expect(threads.map((thread) => thread.message.id)).toEqual([id])
  })

  it("doesn't send again before a second has passed", async () => {
    timers()
    let refusals = 1
    const { julian, sent } = throttled((url, init) => (init?.method === 'POST' && url.pathname.endsWith('/threads') && refusals-- > 0 ? tooMany() : null))
    const posting = julian.post('dev', { text: 'hi' })
    await vi.advanceTimersByTimeAsync(999)
    expect(posts(sent)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1001)
    await posting
    expect(posts(sent)).toHaveLength(2)
  })

  it('posts once when the API wrote the message and then answered 503', async () => {
    timers()
    let failing = true
    const { julian } = throttled(async (url, init, answer) => {
      if (!failing || init?.method !== 'POST' || !url.pathname.endsWith('/threads')) return null
      failing = false
      // The write lands, and its answer is lost.
      await answer()
      return busy()
    })
    const posting = julian.post('dev', { text: 'once' })
    await vi.advanceTimersByTimeAsync(2000)
    const { id } = await posting
    const { threads } = await julian.threads({ channel: 'dev' })
    expect(threads.map((thread) => thread.message.id)).toEqual([id])
  })

  it("gives up with the API's own error after five tries", async () => {
    timers()
    const { julian, sent } = throttled((url, init) => (init?.method === 'POST' && url.pathname.endsWith('/threads') ? tooMany() : null))
    const posting = julian.post('dev', { text: 'hi' }).catch((error: unknown) => error)
    // 1 + 2 + 4 + 8 seconds, each with up to as much again.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await posting).toMatchObject({ status: 429, code: 'rate_limited' })
    expect(posts(sent)).toHaveLength(5)
  })

  it('spreads its tries at random between each wait and twice it, so callers put off together come back apart', async () => {
    for (const [random, waits] of [
      [0, [1000, 2000, 4000, 8000]],
      [0.999, [1999, 3998, 7996, 15992]],
    ] as const) {
      timers()
      vi.spyOn(Math, 'random').mockReturnValue(random)
      onTestFinished(() => void vi.restoreAllMocks())
      const { julian, sent } = throttled((url, init) => (init?.method === 'POST' && url.pathname.endsWith('/threads') ? tooMany() : null))
      const posting = julian.post('dev', { text: 'hi' }).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(40_000)
      await posting
      const at = sent.filter(({ method, path }) => method === 'POST' && path.endsWith('/threads')).map((post) => post.at)
      expect(at.slice(1).map((time, n) => time - at[n]!)).toEqual(waits)
      vi.useRealTimers()
    }
  })

  it('says to try again in seconds when the API asks for its whole minute, which its limit refills all through', async () => {
    timers()
    /** The API's `x-ratelimit-reset`, `seconds` after each 429 it answers. */
    const resetIn = (seconds: number) => String(Math.floor(Date.now() / 1000) + seconds)
    const limited = (headers: Record<string, string> | (() => Record<string, string>)) =>
      throttled((url, init) =>
        init?.method === 'POST' && url.pathname.endsWith('/threads')
          ? Response.json({ error: { code: 'rate_limited', message: 'Too many requests' } }, { status: 429, headers: typeof headers === 'function' ? headers() : headers })
          : null,
      )
    const refused = async (headers: Record<string, string> | (() => Record<string, string>)) => {
      const posting = limited(headers).julian.post('dev', { text: 'hi' }).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(40_000)
      return posting
    }
    for (const minute of [{ 'retry-after': '60' }, () => ({ 'retry-after': '60', 'x-ratelimit-reset': resetIn(60), 'x-ratelimit-limit': '600' })])
      expect(await refused(minute)).toMatchObject({
        status: 429,
        retryAfter: 15,
        message: expect.stringMatching(/for all its agents and profiles together, and refills as the minute goes: a try a few seconds later usually gets through\.$/),
      })
    // A wait under the whole minute is the API's own, and is what it says.
    expect(await refused({ 'retry-after': '7' })).toMatchObject({ retryAfter: 7 })
    expect(await refused(() => ({ 'retry-after': '60', 'x-ratelimit-reset': resetIn(40) }))).toMatchObject({ retryAfter: 40 })
  })

  it("waits through a gateway's 502 or 504 on a read, as a long-poll's wait sees one", async () => {
    timers()
    for (const status of [502, 504]) {
      let refusals = 0
      const { julian, sent } = throttled((url, init) => ((init?.method ?? 'GET') === 'GET' && url.pathname.endsWith('/threads') && refusals-- > 0 ? new Response('Bad Gateway', { status }) : null))
      await julian.post('dev', { text: 'hi' })
      refusals = 1
      const before = sent.length
      const reading = julian.threads({ channel: 'dev' })
      await vi.advanceTimersByTimeAsync(2000)
      const { threads } = await reading
      expect(threads).toHaveLength(1)
      // The read it refused went again a second later, and was answered.
      const [refused, again] = sent.slice(before).filter(({ method, path }) => method === 'GET' && path.endsWith('/threads'))
      expect(again!.at - refused!.at).toBeGreaterThanOrEqual(1000)
    }
  })

  it("answers a 503 at once for a write the API couldn't tell it had seen", async () => {
    const { julian, sent } = throttled((url, init) => (init?.method === 'POST' && url.pathname.endsWith('/complete') ? busy() : null))
    await expect(julian.upload({ data: new TextEncoder().encode('log'), name: 'a.log' })).rejects.toMatchObject({ status: 503 })
    expect(sent.filter(({ path }) => path.endsWith('/complete'))).toHaveLength(1)
  })
})

describe('naming the authors on a page', () => {
  /** Julian reading a board he and Ada wrote on, and every request for actors his reads made, each answered after `latency` ms. */
  const reading = async (options: Parameters<typeof fakeMessageboard>[0] = {}, latency = 0) => {
    const api = fakeMessageboard(options)
    for (const principal of ['user:u_ada', 'user:u_jb']) await handleOn(api, principal).post('dev', { text: `from ${principal}` })
    const inner = as(api, 'user:u_jb')
    const asked: string[][] = []
    const lists: string[][] = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/actors')) (url.searchParams.has('id') ? asked : lists).push(url.searchParams.getAll('id'))
      if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency))
      return inner(input, init)
    }
    /** Julian in a process of his own, which has read nothing yet, as each run of the CLI is. */
    const fresh = () => board({ backend: vercel({ team: 'team_test', api: API, fetch }) })
    return { api, asked, lists, julian: fresh(), fresh }
  }
  const handles = (messages: { author?: { handle: string } | null }[]) => messages.map((message) => message.author?.handle).sort()

  it('asks the API for them by ID in one request, and never for its whole list', async () => {
    const { julian, asked, lists } = await reading()
    const { messages } = await julian.channel('dev').messages()
    expect(handles(messages)).toEqual(['ada', 'julian'])
    expect(asked.map((ids) => [...ids].sort())).toEqual([['vercel:user:u_ada', 'vercel:user:u_jb']])
    expect(lists).toEqual([])
    // Whom it has named, it doesn't ask for again.
    await julian.channel('dev').messages()
    expect(asked).toHaveLength(1)
  })

  it('asks once for a page of threads, and once for a thread nobody here has read with its replies, on an API that takes its time', async () => {
    const { api, julian, asked, lists } = await reading({}, 5)
    const { threads } = await julian.threads({ channel: 'dev' })
    expect(handles(threads.map((thread) => thread.message))).toEqual(['ada', 'julian'])
    expect(asked).toHaveLength(1)
    // A thread whose root and replies are all by people nothing here has named yet.
    const { id: root } = await handleOn(api, 'user:u_val').post('dev', { text: 'new here' })
    for (const principal of ['user:u_tom', 'user:u_kim']) await handleOn(api, principal).reply(root, { text: 'me too' })
    const { replies } = await julian.thread(root)
    expect(replies).toHaveLength(2)
    expect(asked).toHaveLength(2)
    expect(asked[1]!.sort()).toEqual(['vercel:user:u_kim', 'vercel:user:u_tom', 'vercel:user:u_val'])
    expect(lists).toEqual([])
  })

  it("names the project a synced message came through from its importer's own actor, without the whole list, in the page's one request", async () => {
    // An API that takes its time: naming where a message came from waits on it before its author is named.
    const { api, julian, asked, lists } = await reading({}, 5)
    const pong = pongBoard(api)
    await pong.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const author = { id: 'slack:user:U_ADA', handle: 'ada', name: 'Ada', avatar: null, isBot: false }
    await pong.syncImport({ op: 'post', author, from: 'slack', channel: 'dev', text: 'from slack', origin: { thread: 'slack:C1:1', subthread: null, message: '1', context: null } })
    const { messages } = await julian.channel('dev').messages()
    expect(messages.map((message) => message.from).filter(Boolean)).toEqual(['pong/slack'])
    expect(asked).toHaveLength(1)
    expect(lists).toEqual([])
  })

  it('names the actors asked for by ID in one request, or from the whole list on an API that answers no actors by ID', async () => {
    for (const actorsById of [true, false]) {
      const { julian, asked, lists } = await reading({ actorsById })
      const found = await julian.actors({ id: ['vercel:user:u_ada', 'vercel:user:u_nobody'] })
      expect(found.map((actor) => [actor.id, actor.handle])).toEqual([['vercel:user:u_ada', 'ada']])
      expect([asked.length, lists.length]).toEqual(actorsById ? [1, 0] : [1, 1])
    }
  })

  it('names them from the whole list on an API that answers no actors by ID, and never asks it by ID again', async () => {
    const { api, julian, asked, lists } = await reading({ actorsById: false })
    expect(handles((await julian.channel('dev').messages()).messages)).toEqual(['ada', 'julian'])
    expect(asked).toHaveLength(1)
    expect(lists).toHaveLength(1)
    // Someone new, whom nothing here has named or asked for yet: found, they go by what the API calls them, not by their principal.
    await handleOn(api, 'user:u_val').post('dev', { text: 'late' })
    expect(handles((await julian.channel('dev').messages()).messages)).toContain('u_val')
    expect(asked).toHaveLength(1)
  })

  it('names them from the list this once when the API refuses these IDs, and asks by ID again for the next', async () => {
    const { api, asked, lists } = await reading()
    const inner = as(api, 'user:u_jb')
    let refusing = true
    const refused = board({
      backend: vercel({
        team: 'team_test',
        api: API,
        fetch: async (input, init) => {
          const url = new URL(String(input))
          if (url.pathname.endsWith('/actors')) (url.searchParams.has('id') ? asked : lists).push(url.searchParams.getAll('id'))
          if (refusing && url.searchParams.has('id')) return Response.json({ error: { code: 'bad_request', message: 'Invalid request: `id` should NOT be longer than 300 characters.' } }, { status: 400 })
          return inner(input, init)
        },
      }),
    })
    expect(handles((await refused.channel('dev').messages()).messages)).toEqual(['ada', 'julian'])
    expect(lists).toHaveLength(1)
    refusing = false
    await handleOn(api, 'user:u_val').post('dev', { text: 'late' })
    expect(handles((await refused.channel('dev').messages()).messages)).toContain('u_val')
    expect(asked.at(-1)).toEqual(['vercel:user:u_val'])
  })

  /** A channel's messages, its threads, one thread, and its events, each read by a process of its own: who each shows, and the requests they made in all, the ones for actors apart. */
  const reads = async (options: Parameters<typeof fakeMessageboard>[0]) => {
    const { api, fresh, asked, lists } = await reading(options)
    const { id: root } = await handleOn(api, 'user:u_val').post('dev', { text: 'a thread' })
    for (const principal of ['user:u_tom', 'user:u_kim']) await handleOn(api, principal).reply(root, { text: 'me too' })
    const { cursor } = await fresh().poll({ channel: 'dev' })
    await handleOn(api, 'user:u_lee').post('dev', { text: 'since' })
    api.requests.length = 0
    const shown = {
      messages: handles((await fresh().channel('dev').messages()).messages),
      threads: handles((await fresh().threads({ channel: 'dev' })).threads.flatMap((thread) => [thread.message, ...(thread.last ? [thread.last] : [])])),
      thread: handles((await fresh().thread(root)).replies),
      events: handles((await fresh().poll({ channel: 'dev', after: cursor })).events.map((event) => event.message!)),
    }
    return { shown, requests: api.requests.length, actors: asked.length + lists.length }
  }

  it('names them from the read itself where the API answers a read with its actors, and asks for nobody', async () => {
    const inline = await reads({ inlineThreadMessages: true, inlineActors: true })
    const today = await reads({ inlineThreadMessages: true })
    expect(inline.shown).toEqual({
      messages: ['ada', 'julian', 'u_kim', 'u_lee', 'u_tom', 'u_val'],
      threads: ['ada', 'julian', 'u_kim', 'u_lee', 'u_val'],
      thread: ['u_kim', 'u_tom'],
      events: ['u_lee'],
    })
    // The same names either way.
    expect(inline.shown).toEqual(today.shown)
    // With them, no process asks for an actor, by ID or in the list.
    expect(inline.actors).toBe(0)
    // Vercel's API today refuses the parameter: each process reads once more without it, and asks for its authors by ID as before.
    expect(today.actors).toBe(4)
    expect(today.requests).toBe(inline.requests + 4 + 4)
  })

  it('names someone the API left out of a read\'s actors by their principal, and does not ask for them', async () => {
    const { api } = await reading({ inlineActors: true })
    const inner = as(api, 'user:u_jb')
    const asked: string[][] = []
    // An API that sends the actors of a read, but not Ada: it has no view of her yet.
    const julian = board({
      backend: vercel({
        team: 'team_test',
        api: API,
        fetch: async (input, init) => {
          const url = new URL(String(input))
          if (url.pathname.endsWith('/actors')) asked.push(url.searchParams.getAll('id'))
          const response = await inner(input, init)
          if (!url.searchParams.has('with') || !response.ok) return response
          const read = (await response.json()) as { actors: { id: string }[] }
          return Response.json({ ...read, actors: read.actors.filter(({ id }) => id !== 'vercel:user:u_ada') })
        },
      }),
    })
    // She's named by her principal, as anyone the API doesn't have, and not asked for: the read said it has no view of her.
    expect(handles((await julian.channel('dev').messages()).messages)).toEqual(['julian', 'user-u_ada'])
    expect(asked).toEqual([])
  })

  it('is refused the actors once by an API that does not send them, however many channels are read at once', async () => {
    const api = fakeMessageboard({ channelNames: true })
    const channels = ['dev', 'ops', 'ci', 'docs']
    for (const channel of channels) await handleOn(api, 'user:u_ada').post(channel, { text: `in ${channel}` })
    const inner = as(api, 'user:u_jb')
    /** A process of its own, with every read it sent with `with` and was refused, and every read of that route. */
    const process = () => {
      const refused: string[] = []
      const sent: string[] = []
      const julian = board({
        backend: vercel({
          team: 'team_test',
          api: API,
          fetch: async (input, init) => {
            const url = new URL(String(input))
            const route = url.pathname.split('/').at(-1)!
            const response = await inner(input, init)
            if ((init?.method ?? 'GET') === 'GET') sent.push(route)
            if (url.searchParams.has('with') && response.status === 400) refused.push(route)
            return response
          },
        }),
      })
      return { julian, refused, sent }
    }
    // Each channel's latest messages, all at once: a read a channel, none of them answered yet.
    const messages = process()
    const pages = await Promise.all(channels.map((channel) => messages.julian.channel(channel).messages()))
    expect(pages.flatMap((page) => page.messages.map((message) => message.text)).sort()).toEqual(channels.map((channel) => `in ${channel}`).sort())
    expect(messages.refused).toEqual(['messages'])
    // One read a channel, and the one refused.
    expect(messages.sent.filter((route) => route === 'messages')).toHaveLength(channels.length + 1)
    // The whole board's events since a cursor: each channel's feed, all at once.
    const { cursor } = await process().julian.poll({})
    for (const channel of channels) await handleOn(api, 'user:u_ada').post(channel, { text: `more in ${channel}` })
    const events = process()
    expect((await events.julian.poll({ after: cursor })).events.map((event) => event.message?.text)).toEqual(expect.arrayContaining(channels.map((channel) => `more in ${channel}`)))
    expect(events.sent.filter((route) => route === 'changes').length).toBeGreaterThan(channels.length)
    expect(events.refused).toEqual(['changes'])
  })

  it("stops a read that waits on another read's answer about the actors as soon as its own caller stops it", async () => {
    const api = fakeMessageboard()
    for (const channel of ['dev', 'ops']) await handleOn(api, 'user:u_ada').post(channel, { text: `in ${channel}` })
    const inner = as(api, 'user:u_jb')
    // An API that holds the first read sent with `with` until it's let go.
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    let out = () => {}
    const sent = new Promise<void>((resolve) => (out = resolve))
    const backend = vercel({
      team: 'team_test',
      api: API,
      fetch: async (input, init) => {
        if (new URL(String(input)).searchParams.has('with')) {
          out()
          await held
        }
        return inner(input, init)
      },
    })
    const julian = { self: null, origin: { via: { kind: 'client', name: null } } } as Caller
    const first = backend.channelMessages(julian, { channel: 'dev' }, new AbortController().signal)
    await sent
    const stop = new AbortController()
    const waiting = backend.channelMessages(julian, { channel: 'ops' }, stop.signal)
    const outcome = Promise.race([waiting.then(() => 'answered', (error: Error) => error.name), new Promise((resolve) => setTimeout(() => resolve('still waiting'), 500))])
    // The waiter has reached the wait: its own lookups are behind it.
    await new Promise((resolve) => setTimeout(resolve, 50))
    stop.abort()
    expect(await outcome).toBe('AbortError')
    // The first read is nobody's to stop but its caller's: let go, it answers.
    release()
    expect((await first).messages.map((message) => message.text)).toEqual(['in dev'])
  })

  it('keeps asking for a thread list with its messages on an API that takes that and not the actors', async () => {
    const api = fakeMessageboard({ inlineThreadMessages: true })
    const team = handleOn(api)
    for (let i = 0; i < 3; i++) await team.reply((await team.post('busy', { text: `thread ${i}` })).id, { text: 'reply' })
    // A process that has read nothing yet.
    const reader = handleOn(api)
    api.requests.length = 0
    await reader.threads({ channel: 'busy' })
    await reader.threads({ channel: 'busy' })
    // Refused once for the actors, then listed with its messages each time: no message is read by its ID.
    expect(api.requests.filter((r) => /\/threads$/.test(r))).toHaveLength(3)
    expect(api.requests.filter((r) => /\/messages\/msg_/.test(r))).toEqual([])
  })
})
