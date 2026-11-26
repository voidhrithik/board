import { describe, expect, it } from 'vitest'
import { routes, type RouteName } from '../src/api/routes.ts'
import { BOARD_URL, caller, personToken, testBoard, workflowToken } from './harness.ts'
import { fakeQueue } from './queue.ts'

/**
 * Every route, called by a workflow that reads `open` and nothing else. A
 * target in `secret` must answer as if it didn't exist (404), or the request
 * must be refused (403); a write to a target in `open`, which it reads, is a
 * 403. A new route fails the first test until it has an entry here.
 */
type Fixture = {
  secret: { root: number; reply: number; schedule: number; file: string; task: number }
  open: { root: number; schedule: number; task: number }
}
type Call = { method: 'GET' | 'POST' | 'PATCH'; path: string; body?: unknown; status: number; check?: (body: any) => void }
type Walk = 'public' | ((fixture: Fixture) => Call[])

const SLACK_USER = { id: 'slack:user:U1', handle: 'eve', name: 'Eve', avatar: null, isBot: false }

const nothingFrom = (field: string) => (body: any) => expect(JSON.stringify(body[field])).not.toContain('secret')

const WALK: Record<RouteName, Walk> = {
  // Unauthenticated: they show nothing a channel holds.
  discovery: 'public',
  avatar: 'public',
  openapi: 'public',
  webhook: 'public',
  // About the caller.
  me: () => [{ method: 'GET', path: '/me', status: 200, check: (body) => expect(body.can).toEqual({ open: ['read'] }) }],
  // Lists drop what the caller can't read.
  channels: () => [
    { method: 'GET', path: '/channels', status: 200, check: (body) => expect(body.channels.map((c: any) => c.path)).toEqual(['open']) },
  ],
  // Its answer says whether the channel was there, so one it can't read is refused whether it is or not.
  createChannel: () => [
    { method: 'POST', path: '/channels', body: { path: 'secret' }, status: 403 },
    { method: 'POST', path: '/channels', body: { path: 'secret/never-posted' }, status: 403 },
    { method: 'POST', path: '/channels', body: { path: 'open' }, status: 403 },
  ],
  actors: () => [
    { method: 'GET', path: '/actors', status: 200, check: (body) => expect(body.actors.map((a: any) => a.handle)).not.toContain('keeper') },
  ],
  // One channel by its whole name: what it can't read is as empty as what isn't there.
  channelMessages: () =>
    ['?channel=secret', '?channel=secret/never-posted', '?channel=secret&limit=1'].map((query) => ({ method: 'GET', path: `/messages${query}`, status: 200, check: nothingFrom('messages') })),
  threads: ({ secret }) =>
    ['', '?channel=secret', '?channel=secret/', `?re=${secret.root}`, '?by=keeper', '?label=private', '?text=hush', '?mentions=keeper'].map(
      (query) => ({ method: 'GET', path: `/threads${query}`, status: 200, check: nothingFrom('threads') }),
    ),
  events: () => [
    { method: 'GET', path: '/events?after=0', status: 200, check: nothingFrom('events') },
    {
      method: 'GET',
      path: '/events?after=0&all=1',
      status: 200,
      // Events about no message (who's who) reach only a reader of every channel.
      check: (body) => {
        nothingFrom('events')(body)
        expect(body.events.filter((event: any) => !event.message)).toEqual([])
        expect(JSON.stringify(body.events)).not.toContain('keeper')
      },
    },
    { method: 'GET', path: '/events?after=0&channel=secret', status: 200, check: (body) => expect(body.events).toEqual([]) },
  ],
  schedules: ({ secret }) => [
    { method: 'GET', path: '/schedules?all=1', status: 200, check: nothingFrom('schedules') },
    { method: 'GET', path: `/schedules?re=${secret.root}`, status: 404 },
  ],
  // By ID: what it can't read is 404, what it reads but can't change is 403.
  message: ({ secret }) => [
    { method: 'GET', path: `/messages/${secret.root}`, status: 404 },
    { method: 'GET', path: `/messages/${secret.reply}`, status: 404 },
  ],
  edit: ({ secret, open }) => [
    { method: 'POST', path: `/messages/${secret.root}/edit`, body: { text: 'mine now' }, status: 404 },
    { method: 'POST', path: `/messages/${open.root}/edit`, body: { text: 'mine now' }, status: 403 },
  ],
  delete: ({ secret, open }) => [
    { method: 'POST', path: `/messages/${secret.root}/delete`, body: {}, status: 404 },
    { method: 'POST', path: `/messages/${open.root}/delete`, body: {}, status: 403 },
  ],
  react: ({ secret, open }) => [
    { method: 'POST', path: `/messages/${secret.root}/reactions`, body: { emoji: 'eyes' }, status: 404 },
    { method: 'POST', path: `/messages/${open.root}/reactions`, body: { emoji: 'eyes' }, status: 403 },
  ],
  label: ({ secret, open }) => [
    { method: 'POST', path: `/messages/${secret.root}/labels`, body: { set: { seen: 'yes' } }, status: 404 },
    { method: 'POST', path: `/messages/${open.root}/labels`, body: { set: { seen: 'yes' } }, status: 403 },
  ],
  sync: ({ secret, open }) => [
    { method: 'POST', path: `/messages/${secret.root}/sync`, body: { target: 'slack:#leak' }, status: 404 },
    { method: 'POST', path: `/messages/${open.root}/sync`, body: { target: 'slack:#leak' }, status: 403 },
  ],
  typing: ({ secret, open }) => [
    { method: 'POST', path: `/messages/${secret.reply}/typing`, body: {}, status: 404 },
    { method: 'POST', path: `/messages/${open.root}/typing`, body: {}, status: 403 },
  ],
  cancelSchedule: ({ secret, open }) => [
    { method: 'POST', path: `/schedules/${secret.schedule}/cancel`, status: 404 },
    { method: 'POST', path: `/schedules/s${open.schedule}/cancel`, status: 403 },
  ],
  // Tasks are threads: one it can't read isn't there, and where it only reads, it starts, claims, and changes none.
  tasks: () =>
    ['', '?state=all', '?channel=secret', '?owner=keeper', '?label=private'].map((query) => ({ method: 'GET' as const, path: `/tasks${query}`, status: 200, check: nothingFrom('tasks') })),
  createTask: ({ secret, open }) => [
    { method: 'POST', path: '/tasks', body: { channel: 'secret', text: 'hi' }, status: 403 },
    { method: 'POST', path: '/tasks', body: { channel: 'open', text: 'hi' }, status: 403 },
    { method: 'POST', path: '/tasks', body: { re: secret.root }, status: 404 },
    { method: 'POST', path: '/tasks', body: { re: open.root }, status: 403 },
  ],
  createTasks: ({ secret }) => [
    { method: 'POST', path: '/tasks/batch', body: { channel: 'secret', tasks: [{ text: 'hi' }] }, status: 403 },
    { method: 'POST', path: '/tasks/batch', body: { channel: 'open', tasks: [{ text: 'hi' }, { text: 'and this' }] }, status: 403 },
    // What it would wait for is checked only once it may post there: a task it can't read stays out of sight.
    { method: 'POST', path: '/tasks/batch', body: { channel: 'open', tasks: [{ text: 'hi', needs: [String(secret.task)] }] }, status: 403 },
  ],
  // Only your own batch, by the id you gave it.
  createdTasks: () => [
    { method: 'GET', path: '/tasks/batch/secret-plan', status: 404 },
    { method: 'GET', path: '/tasks/batch/nothing', status: 404 },
  ],
  claimReadyTask: () => [
    { method: 'POST', path: '/tasks/claim', body: { channel: 'secret' }, status: 403 },
    { method: 'POST', path: '/tasks/claim', body: { channel: 'secret/' }, status: 403 },
    { method: 'POST', path: '/tasks/claim', body: { channel: 'open' }, status: 403 },
  ],
  claimTask: ({ secret, open }) => [
    { method: 'POST', path: `/tasks/${secret.task}/claim`, body: {}, status: 404 },
    { method: 'POST', path: `/tasks/${open.task}/claim`, body: {}, status: 403 },
  ],
  // What a claim does takes the claim: one it can't read isn't there, and one it reads is lost without the claim's secret.
  renewTask: ({ secret, open }) => [
    { method: 'POST', path: `/tasks/${secret.task}/renew`, body: { epoch: 1, token: 'guess' }, status: 404 },
    { method: 'POST', path: `/tasks/${open.task}/renew`, body: { epoch: 1, token: 'guess' }, status: 409 },
  ],
  releaseTask: ({ secret, open }) => [
    { method: 'POST', path: `/tasks/${secret.task}/release`, body: { epoch: 1, token: 'guess' }, status: 404 },
    { method: 'POST', path: `/tasks/${open.task}/release`, body: { epoch: 1, token: 'guess' }, status: 409 },
  ],
  completeTask: ({ secret, open }) => [
    { method: 'POST', path: `/tasks/${secret.task}/complete`, body: { epoch: 1, token: 'guess' }, status: 404 },
    { method: 'POST', path: `/tasks/${open.task}/complete`, body: { epoch: 1, token: 'guess' }, status: 409 },
  ],
  failTask: ({ secret, open }) => [
    { method: 'POST', path: `/tasks/${secret.task}/fail`, body: { epoch: 1, token: 'guess', reason: 'mine now' }, status: 404 },
    { method: 'POST', path: `/tasks/${open.task}/fail`, body: { epoch: 1, token: 'guess', reason: 'mine now' }, status: 409 },
  ],
  blockTask: ({ secret, open }) => [
    { method: 'POST', path: `/tasks/${secret.task}/block`, body: { reason: 'mine now' }, status: 404 },
    { method: 'POST', path: `/tasks/${open.task}/block`, body: { reason: 'mine now' }, status: 403 },
    { method: 'POST', path: `/tasks/${open.task}/block`, body: { reason: 'mine now', epoch: 1, token: 'guess' }, status: 409 },
  ],
  unblockTask: ({ secret, open }) => [
    { method: 'POST', path: `/tasks/${secret.task}/unblock`, status: 404 },
    { method: 'POST', path: `/tasks/${open.task}/unblock`, status: 403 },
  ],
  reopenTask: ({ secret, open }) => [
    { method: 'POST', path: `/tasks/${secret.task}/reopen`, status: 404 },
    { method: 'POST', path: `/tasks/${open.task}/reopen`, status: 403 },
  ],
  assignTask: ({ secret, open }) => [
    { method: 'POST', path: `/tasks/${secret.task}/assign`, body: { for: null }, status: 404 },
    { method: 'POST', path: `/tasks/${open.task}/assign`, body: { for: null }, status: 403 },
  ],
  setTaskNeeds: ({ secret, open }) => [
    { method: 'POST', path: `/tasks/${secret.task}/needs`, body: { needs: [] }, status: 404 },
    { method: 'POST', path: `/tasks/${open.task}/needs`, body: { needs: [] }, status: 403 },
    // What it would wait for is checked only once it's the caller's to change: a task it can't read stays out of sight.
    { method: 'POST', path: `/tasks/${open.task}/needs`, body: { needs: [secret.task] }, status: 403 },
  ],
  setTaskDue: ({ secret, open }) => [
    { method: 'POST', path: `/tasks/${secret.task}/due`, body: { due: null }, status: 404 },
    { method: 'POST', path: `/tasks/${open.task}/due`, body: { due: null }, status: 403 },
  ],
  cancelTask: ({ secret, open }) => [
    { method: 'POST', path: `/tasks/${secret.task}/cancel`, body: { reason: 'mine now' }, status: 404 },
    { method: 'POST', path: `/tasks/${open.task}/cancel`, body: { reason: 'mine now' }, status: 403 },
  ],
  // Listing grants takes manage at *, and changing one manage at each pattern it names: g1 names *.
  grants: () => [{ method: 'GET', path: '/grants', status: 403 }],
  createGrant: () => [
    { method: 'POST', path: '/grants', body: { principals: [{ kind: 'github', repository: 'acme/web' }], can: { '*': 'all' } }, status: 403 },
    { method: 'POST', path: '/grants', body: { principals: [{ kind: 'everyone' }], can: { open: ['read', 'post'] } }, status: 403 },
    // Saying to go ahead with a lockout is no way past what it may not do.
    { method: 'POST', path: '/grants', body: { principals: [{ kind: 'everyone' }], can: { open: ['read', 'post'] }, lockMeOut: true }, status: 403 },
  ],
  // A batch is judged grant by grant: one it may not make refuses them all.
  createGrants: () => [
    { method: 'POST', path: '/grants/batch', body: { grants: [{ principals: [{ kind: 'github', repository: 'acme/web' }], can: { '*': 'all' } }] }, status: 403 },
    { method: 'POST', path: '/grants/batch', body: { grants: [{ principals: [{ kind: 'everyone' }], can: { open: ['read', 'post'] } }], lockMeOut: true }, status: 403 },
  ],
  updateGrant: () => [{ method: 'PATCH', path: '/grants/g1', body: { can: { '*': 'all' } }, status: 403 }],
  // What it may do itself, anywhere, without the grants that decide it; anyone else's only with manage at *.
  explain: () => [
    { method: 'GET', path: '/grants/explain?channel=secret', status: 200, check: (body) => expect(body).toMatchObject({ channel: 'secret', can: [], grants: [] }) },
    { method: 'GET', path: '/grants/explain?channel=open', status: 200, check: (body) => expect(body).toMatchObject({ can: ['read'], grants: [] }) },
    { method: 'GET', path: '/grants/explain?channel=open&user=u_julian', status: 403 },
  ],
  revokeGrant: () => [{ method: 'POST', path: '/grants/g1/revoke', status: 403 }],
  // Schemas are the whole board's and hold no channel's messages: anyone the board let in reads them, and only manage at * registers one.
  schemas: () => [{ method: 'GET', path: '/schemas', status: 200, check: (body) => expect(body.schemas.map((schema: any) => schema.id)).toEqual(['git-commit@1', 'vercel-deployment@1']) }],
  schema: () => [{ method: 'GET', path: '/schemas/git-commit@1', status: 200 }],
  createSchema: () => [{ method: 'POST', path: '/schemas', body: { name: 'walker', version: 1, schema: { type: 'object' } }, status: 403 }],
  attachment: ({ secret }) => [{ method: 'GET', path: `/attachments/${secret.file}`, status: 404 }],
  // Only your own post, by the client ID you gave it.
  posted: () => [
    { method: 'GET', path: '/posts/secret-one', status: 404 },
    { method: 'GET', path: '/posts/nothing', status: 404 },
  ],
  // Writes: a reply's channel is its root's, so an unreadable root is 404; a channel the request names is 403.
  post: ({ secret, open }) => [
    { method: 'POST', path: '/messages', body: { channel: 'secret', text: 'hi' }, status: 403 },
    { method: 'POST', path: '/messages', body: { re: secret.root, text: 'hi' }, status: 404 },
    { method: 'POST', path: '/messages', body: { re: secret.reply, text: 'hi' }, status: 404 },
    { method: 'POST', path: '/messages', body: { re: open.root, text: 'hi' }, status: 403 },
  ],
  schedule: ({ secret, open }) => [
    { method: 'POST', path: '/schedules', body: { channel: 'secret', text: 'hi', in: '1h' }, status: 403 },
    { method: 'POST', path: '/schedules', body: { re: secret.root, text: 'hi', in: '1h' }, status: 404 },
    { method: 'POST', path: '/schedules', body: { re: open.root, text: 'hi', in: '1h' }, status: 403 },
  ],
  upload: () => [{ method: 'POST', path: '/attachments', status: 403 }],
  uploadStart: () => [{ method: 'POST', path: '/attachments/uploads', body: { name: 'big.mp4', type: 'video/mp4', size: 10_000_000 }, status: 403 }],
  // Only its uploader finishes an upload: anyone else's is as if it didn't exist.
  uploadFinish: () => [{ method: 'POST', path: '/attachments/uploads/AAAAAAAAAAAAAAAAAAAAAA', body: {}, status: 404 }],
  // The board's own bookkeeping spans every channel.
  inbox: () => [{ method: 'GET', path: '/inbox/slack', status: 403 }],
  // Only the board that runs a sync entry reads its source: this one runs none.
  readSource: () => [{ method: 'GET', path: '/sources/slack/read?target=C0123', status: 404 }],
  joinSource: () => [{ method: 'POST', path: '/sources/slack/join', body: { target: 'C0123' }, status: 404 }],
  synced: ({ secret, open }) => [
    { method: 'GET', path: `/messages/${secret.root}/sync`, status: 404 },
    { method: 'GET', path: `/messages/${secret.reply}/sync`, status: 404 },
    { method: 'GET', path: `/messages/${open.root}/sync`, status: 200 },
  ],
  // A link this board synced nothing for, as any it can't show: 404.
  linked: () => [{ method: 'GET', path: `/links?url=${encodeURIComponent('https://acme.slack.com/archives/C0123ABC/p1727000000123456')}`, status: 404 }],
  // Sync's records: a caller speaks for platform users only where it may sync.
  syncImport: () => [
    { method: 'POST', path: '/sync/imports', body: { op: 'post', author: SLACK_USER, from: 'slack', channel: 'secret', text: 'hi' }, status: 403 },
    { method: 'POST', path: '/sync/imports', body: { op: 'post', author: SLACK_USER, from: 'slack', channel: 'open', text: 'hi' }, status: 403 },
  ],
  syncReceipt: ({ secret, open }) => [
    { method: 'POST', path: '/sync/receipts', body: { kind: 'failed', message: String(secret.root), target: 'slack:C1', error: 'gone' }, status: 404 },
    { method: 'POST', path: '/sync/receipts', body: { kind: 'thread', message: String(open.root), target: 'slack:C1', targetKind: 'channel', cause: 'request' }, status: 403 },
  ],
  syncThread: () => [{ method: 'GET', path: '/sync/threads/t1', status: 403 }],
  syncFind: () => [{ method: 'GET', path: '/sync/find?thread=slack:C1:1&message=1', status: 403 }],
  syncCopies: ({ secret }) => [{ method: 'GET', path: `/sync/copies?message=${secret.root}`, status: 403 }],
  inboxPush: () => [
    {
      method: 'POST',
      path: '/inbox/slack',
      body: { events: [{ id: 'e1', raw: {}, event: { kind: 'message', channel: 'slack:C1', thread: 'slack:C1:1', subthread: null, message: '1', isRoot: true, text: 'hi', context: null, author: SLACK_USER } }] },
      status: 403,
    },
  ],
  inboxNext: () => [{ method: 'GET', path: '/inbox/slack/next', status: 403 }],
  inboxAck: () => [{ method: 'POST', path: '/inbox/slack/e1/ack', body: { lease: 'l1' }, status: 403 }],
  // Registered watchers: each sees only what its registrant reads, and pulls only its own.
  watchers: () => [{ method: 'GET', path: '/watchers', status: 200, check: (body) => expect(body.watchers).toEqual([]) }],
  register: () => [{ method: 'POST', path: '/watchers', body: { watch: { fix: { tail: 'secret' } } }, status: 200 }],
  matches: () => [{ method: 'GET', path: '/watchers/matches', status: 200, check: (body) => expect(body.matches).toEqual([]) }],
  ack: () => [{ method: 'POST', path: '/watchers/matches/m1/ack', body: { lease: 'l1' }, status: 404 }],
  wake: () => [{ method: 'POST', path: '/wake', status: 404 }],
}

async function setup() {
  const board = testBoard({ scheduler: fakeQueue().scheduler })
  await board.createGrant({ principals: [{ kind: 'github', repository: 'acme/web' }], can: { open: ['read'] } })
  const keeper = caller(board.fetch, await personToken('u_keeper'), {})
  const host = caller(board.fetch, await personToken('u_host'), {})
  const upload = await board.fetch(
    new Request(`${BOARD_URL}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await personToken('u_keeper')}`, 'content-type': 'text/plain', 'x-board-filename': 'plan.txt' },
      body: 'the plan',
    }),
  )
  const file = ((await upload.json()) as { attachment: { id: string } }).attachment.id
  const root = (await keeper('POST', '/messages', { channel: 'secret', text: 'hush @keeper', labels: { private: 'yes' }, attachments: [file], id: 'secret-one' })).body.message.id
  const reply = (await keeper('POST', '/messages', { re: root, text: 'still hush' })).body.message.id
  await keeper('POST', `/messages/${root}/reactions`, { emoji: 'eyes' })
  const schedule = (await keeper('POST', '/schedules', { channel: 'secret', text: 'hush later', in: '1d' })).body.schedule.id
  // A channel made before anything posted to it: an event that names no message.
  expect((await keeper('POST', '/channels', { path: 'secret/empty' })).body).toMatchObject({ created: true })
  // A grant decides open for the walker too, beside its rule: one it may not see when it asks what decides.
  await keeper('POST', '/grants', { principals: [{ kind: 'github', repository: 'acme/web' }], can: { open: ['read'] } })
  const openRoot = (await host('POST', '/messages', { channel: 'open', text: 'hello' })).body.message.id
  const openSchedule = (await host('POST', '/schedules', { re: openRoot, text: 'hello later', in: '1d' })).body.schedule.id
  // A task in each, in a thread of its own, held by a claim: what the walker must neither see, take, nor settle.
  const task = (await keeper('POST', '/tasks', { channel: 'secret', text: 'hush, a task', labels: { private: 'yes' }, claim: true })).body.task.id
  const openTask = (await host('POST', '/tasks', { channel: 'open', text: 'hello, a task', claim: true })).body.task.id
  // And a batch of them under an id, which finds it again for whoever made it, and no one else.
  expect((await keeper('POST', '/tasks/batch', { channel: 'secret', id: 'secret-plan', tasks: [{ text: 'hush, a plan', labels: { private: 'yes' } }] })).status).toBe(201)
  expect((await keeper('GET', '/tasks/batch/secret-plan')).body.tasks).toMatchObject([{ text: 'hush, a plan' }])
  const fixture: Fixture = { secret: { root, reply, schedule, file, task }, open: { root: openRoot, schedule: openSchedule, task: openTask } }
  return { board, fixture, outsider: caller(board.fetch, await workflowToken()) }
}

describe('every route', () => {
  it('is classified', () => {
    expect(Object.keys(WALK).sort()).toEqual(Object.keys(routes).sort())
  })

  it('shows nothing of a channel the caller can’t read, and refuses writes where it only reads', async () => {
    const { board, fixture, outsider } = await setup()
    for (const [name, walk] of Object.entries(WALK) as [RouteName, Walk][]) {
      if (walk === 'public') continue
      for (const call of walk(fixture)) {
        const { status, body } = await outsider(call.method, call.path, call.body)
        expect(status, `${name}: ${call.method} ${call.path} ${JSON.stringify(call.body ?? '')}`).toBe(call.status)
        // A 404 says nothing more than that it isn't there.
        if (status === 404) expect(JSON.stringify(body)).not.toMatch(/hush|keeper|plan\.txt/)
        call.check?.(body)
      }
    }
    // None of it changed a task: each is still held by the claim it was made with.
    for (const id of [fixture.secret.task, fixture.open.task]) expect((await board.thread(String(id))).message.task).toMatchObject({ state: 'claimed', epoch: 1, for: null })
  })
})
