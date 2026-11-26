import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { MessageView, ScheduleView } from '../src/api/routes.ts'

// The page's data module, as the page runs it: one handle on the inspector's proxy, which is
// faked here. What the page asks the board, and what it keeps, are what a person at it sees.

type Asked = { method: string; path: string; query: Record<string, string>; body: unknown }
const asked: Asked[] = []
/** What the board answers next for a route, by `METHOD /path`: each is used once, then the route's usual answer. */
const next = new Map<string, (() => Response)[]>()
const refuse = (status: number, code: string, message: string) => () => Response.json({ error: { code, message } }, { status })

const schedule = (text: string): ScheduleView =>
  ({ id: 's1', channel: 'dev', re: null, text, labels: {}, noSync: false, attachments: [], first: '2026-10-01T12:00:00.000Z', every: null, until: null, times: null, sent: 0, next: '2026-10-01T12:00:00.000Z', last: null, state: 'pending', canceled: null, createdAt: '2026-10-01T10:00:00.000Z' }) as unknown as ScheduleView

/** A new task's root, as the board answers it. */
const taskRoot = (body: { channel: string; text: string; needs?: string[] }): MessageView =>
  ({
    id: '50',
    version: 50,
    revision: 50,
    channel: body.channel,
    text: body.text,
    re: null,
    replyTo: null,
    thread: 't50',
    labels: { 'board.task': 'waiting' },
    reactions: {},
    by: { actor: 'local:user:julian', principal: 'local:user:julian', profile: null },
    noSync: false,
    origin: null,
    from: null,
    blocks: [],
    createdAt: '2026-10-01T10:00:00.000Z',
    editedAt: null,
    deleted: false,
    undelivered: {},
    attachments: [],
    links: [],
    author: null,
    task: { state: 'waiting', owner: 'local:user:julian', by: 'local:user:julian', for: null, needs: body.needs ?? [], epoch: 0, claim: null, blocked: null, result: null, reason: null, due: null },
  }) as MessageView

const usual: Record<string, (body: unknown) => Response> = {
  // Who the page is, which the handle asks before it makes a task.
  'GET /me': () => Response.json({ actor: 'local:user:julian', principal: 'local:user:julian', kind: 'person', handle: 'julian', name: 'julian', avatar: null, profile: null, expiresAt: null, can: { '*': ['read', 'post', 'react', 'label', 'sync', 'manage'] } }),
  'POST /tasks': (body) => Response.json({ task: taskRoot(body as Parameters<typeof taskRoot>[0]) }, { status: 201 }),
  'POST /attachments': () => Response.json({ attachment: { id: 'a'.repeat(22), name: 'trace.log', type: 'text/plain', size: 5 } }, { status: 201 }),
  'POST /schedules': (body) => Response.json({ schedule: schedule((body as { text: string }).text) }, { status: 201 }),
  'GET /schedules': () => Response.json({ schedules: [] }),
}

let page: typeof import('../src/inspect/app/board.ts')

beforeAll(async () => {
  // What a browser gives the page: where it is, its document, and a fetch, which here is the proxy.
  vi.stubGlobal('document', { querySelector: () => null })
  vi.stubGlobal('location', { origin: 'http://127.0.0.1:4747' })
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => setTimeout(run, 0))
  vi.stubGlobal('addEventListener', () => {})
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const path = url.pathname.slice('/board'.length)
    const method = request.method
    // What it carries, when that's JSON: a file's bytes are not.
    const body = await request
      .text()
      .then((text) => (text ? (JSON.parse(text) as unknown) : null))
      .catch(() => null)
    asked.push({ method, path, query: Object.fromEntries(url.searchParams), body })
    const route = `${method} ${path}`
    return next.get(route)?.shift()?.() ?? usual[route]?.(body) ?? Response.json({ error: { code: 'not_found', message: `no ${route} here` } }, { status: 404 })
  })
  page = await import('../src/inspect/app/board.ts')
})

const posts = (path: string) => asked.filter((request) => request.method === 'POST' && request.path === path).map((request) => request.body)

describe("the inspector's page, sending later", () => {
  it('keeps a schedule the board refused, with everything typed, and schedules it again on retry', async () => {
    next.set('POST /schedules', [refuse(403, 'forbidden', "this token can't post in dev")])
    const file = new File(['trace'], 'trace.log', { type: 'text/plain' })
    await page.send({ channel: 'dev', re: null, text: 'Morning recap', noSync: true, labels: { kind: 'recap' }, files: [file], later: { in: '2h', every: '1d' } })

    // Nothing is lost: it's a post that didn't go, as a refused send is, with why and what it would have sent.
    const [kept] = page.getState().pending
    expect(kept).toMatchObject({
      channel: 'dev',
      re: null,
      text: 'Morning recap',
      noSync: true,
      labels: { kind: 'recap' },
      files: [{ name: 'trace.log', size: 5 }],
      later: { in: '2h', every: '1d' },
      error: "this token can't post in dev",
    })
    expect(page.getState().pending).toHaveLength(1)

    await page.retry(kept!)
    // The retry asked for the same schedule, its file with it, and the board kept it: nothing is pending.
    expect(page.getState().pending).toEqual([])
    const wanted = { channel: 'dev', text: 'Morning recap', noSync: true, labels: { kind: 'recap' }, attachments: ['a'.repeat(22)], in: '2h', every: '1d' }
    expect(posts('/schedules')).toEqual([wanted, wanted])
    // A schedule is not a post: nothing was sent to the channel on the way.
    expect(posts('/messages')).toEqual([])
  })

  it('leaves no pending post behind a schedule the board kept, and a reply later names its thread', async () => {
    asked.length = 0
    await page.send({ channel: 'dev', re: '812', text: 'Still broken?', noSync: false, labels: {}, later: { at: '2026-10-02T09:00:00.000Z' } })
    expect(page.getState().pending).toEqual([])
    expect(posts('/schedules')).toEqual([{ re: '812', text: 'Still broken?', at: '2026-10-02T09:00:00.000Z' }])
  })

  it('discards one you give up on', async () => {
    next.set('POST /schedules', [refuse(400, 'invalid_request', 'durations look like 30s, 30m, 12h, or 1d')])
    await page.send({ channel: 'dev', re: null, text: 'Typo', noSync: false, labels: {}, later: { in: '2h' } })
    const [kept] = page.getState().pending
    expect(kept).toMatchObject({ text: 'Typo', error: 'durations look like 30s, 30m, 12h, or 1d' })
    page.discard(kept!.key)
    expect(page.getState().pending).toEqual([])
  })
})

describe("the inspector's page, starting a task", () => {
  it('keeps a task the board refused, with what it needs, and starts it again on retry', async () => {
    next.set('POST /tasks', [refuse(400, 'invalid_needs', "needs: #9999 isn't a task")])
    const file = new File(['trace'], 'trace.log', { type: 'text/plain' })
    await page.send({ channel: 'work', re: null, text: 'publish the release', noSync: false, labels: { step: 'ship' }, files: [file], task: { needs: ['9999'], for: null } })

    // As a refused send: the post stays, with why, and with what made it a task.
    const [kept] = page.getState().pending
    expect(kept).toMatchObject({ channel: 'work', text: 'publish the release', labels: { step: 'ship' }, files: [{ name: 'trace.log', size: 5 }], task: { needs: ['9999'], for: null }, error: "needs: #9999 isn't a task" })

    await page.retry(kept!)
    expect(page.getState().pending).toEqual([])
    // Its file goes with it, in the one write that makes the task.
    const wanted = { channel: 'work', text: 'publish the release', labels: { step: 'ship' }, attachments: ['a'.repeat(22)], needs: ['9999'], for: null }
    expect(posts('/tasks')).toMatchObject([wanted, wanted])
    // The task the board answered is the page's now.
    expect(page.getState().messages['50']).toMatchObject({ text: 'publish the release', task: { state: 'waiting', needs: ['9999'] } })
  })
})

describe("the inspector's page, working a task it claimed", () => {
  it('keeps a claim it made while the page changed under it, and completes with it', async () => {
    const claimed = { ...taskRoot({ channel: 'work', text: 'fix the export' }), id: '70', version: 71, revision: 71, thread: 't70', labels: { 'board.task': 'claimed' } }
    claimed.task = { ...claimed.task!, state: 'claimed', epoch: 1, claim: { actor: 'local:user:julian', until: '2099-01-01T00:00:00.000Z' } }
    next.set('POST /tasks/70/claim', [() => Response.json({ task: claimed, claim: { epoch: 1, token: 'secret-token', until: '2099-01-01T00:00:00.000Z' } })])
    next.set('POST /tasks/70/complete', [() => Response.json({ task: { ...claimed, labels: { 'board.task': 'completed' }, task: { ...claimed.task, state: 'completed', claim: null, result: 'done' } } })])

    // While the claim is on its way back, the page keeps changing: something else in it settles on every turn.
    const claiming = page.claimTask('70')
    let turns = Promise.resolve()
    for (let n = 0; n < 200; n++) turns = turns.then(() => page.discard(`nothing-${n}`))
    expect(await claiming).toBe(true)
    await turns

    // The claim is still this tab's: completing sends its epoch and token to the board.
    expect(await page.completeTask('70', 'done')).toBe(true)
    expect(posts('/tasks/70/complete')).toEqual([{ epoch: 1, token: 'secret-token', result: 'done' }])
  })
})

/** A message as the board answers one: a root in `channel`, or a reply to `re`. */
const posted = (id: string, channel: string, text: string, re: string | null = null): MessageView => {
  const { task: _task, ...message } = taskRoot({ channel, text })
  return { ...message, id, version: Number(id), revision: Number(id), re, thread: `t${re ?? id}`, labels: {} } as MessageView
}
const gets = (path: string) => asked.filter((request) => request.method === 'GET' && request.path === path).map((request) => request.query)

describe("the inspector's page, reading", () => {
  it("fills its activity view with the feed's newest events across channels, in one read, and follows the feed from that read", async () => {
    const root = posted('60', 'dev', 'osprey nests here')
    const reply = posted('62', 'dev', 'seen today', '60')
    const event = (cursor: string, type: string, message: MessageView) => ({ cursor, type, createdAt: message.createdAt, payload: {}, message })
    usual['GET /channels'] = () => Response.json({ channels: [{ path: 'dev' }], cursor: '63' })
    // Oldest first, as the board answers them: the root, its reply, and the root's edit.
    const events = [event('60', 'message.posted', root), event('62', 'message.posted', reply), event('63', 'message.edited', { ...root, text: 'osprey nests here, still' })]
    next.set('GET /events', [() => Response.json({ events, cursor: '63' })])
    asked.length = 0
    await page.boot()
    // One read of the feed's end, across channels, and no list of threads or messages in any of them.
    expect(gets('/events')[0]).toEqual({ all: 'true', last: '100' })
    expect(gets('/threads')).toEqual([])
    expect(gets('/messages')).toEqual([])
    // Each message is as the last event about it left it.
    expect(page.getState()).toMatchObject({ activityRefused: null, cursor: '63', messages: { 60: { text: 'osprey nests here, still' }, 62: { text: 'seen today' } } })
    await vi.waitFor(() => expect(gets('/events')).toMatchObject([{ all: 'true', last: '100' }, { all: 'true', after: '63' }]))
  })

  it("says what a board that can't read its feed's newest events across channels answered, where they would be, and follows the feed from now", async () => {
    const words = "Vercel's boards don't support reading the newest events of several channels at once here yet: read one channel's, with `channel`"
    next.set('GET /events', [refuse(501, 'not_supported', words)])
    asked.length = 0
    await page.boot()
    expect(page.getState().activityRefused).toBe(words)
    // Nothing was read a channel at a time behind it: the page says so, and a channel loads when it's opened.
    expect(gets('/threads')).toEqual([])
    expect(gets('/messages')).toEqual([])
    await vi.waitFor(() => expect(gets('/events')).toHaveLength(2))
    // From now: it has no read's cursor to go on from.
    expect(gets('/events')[1]).toMatchObject({ all: 'true' })
    expect(gets('/events')[1]).not.toHaveProperty('after')
    expect(gets('/events')[1]).not.toHaveProperty('last')
  })

  it("asks the board for the threads a filter finds and reads the longer ones whole, and asks a board that can't find them that way once", async () => {
    const root = posted('80', 'ops', 'falcon on the roof')
    const last = posted('83', 'ops', 'gone again', '80')
    usual['GET /threads'] = () => Response.json({ threads: [{ message: root, replies: 3, last }], cursor: '83', older: null })
    usual['GET /messages/80'] = () => Response.json({ message: root, replies: [posted('81', 'ops', 'a falcon?', '80'), posted('82', 'ops', 'yes, a falcon', '80'), last], cursor: '83', schedules: [] })
    asked.length = 0
    await page.loadFiltered('ops', { text: 'falcon', label: [] })
    // The threads with a match, in that channel, then the one longer than its summary: the match may be any message of it.
    expect(gets('/threads')).toEqual([{ channel: 'ops', text: 'falcon', limit: '50' }])
    expect(gets('/messages/80')).toEqual([{}])
    expect(gets('/messages')).toEqual([])
    expect(Object.keys(page.getState().messages)).toEqual(expect.arrayContaining(['80', '81', '82', '83']))

    // A board with no index for it says so, and is asked once: the next filter of its kind shows what's loaded.
    next.set('GET /threads', [refuse(501, 'not_supported', "Vercel's boards don't support reading threads by text yet")])
    asked.length = 0
    await page.loadFiltered('ops', { text: 'kestrel', label: [] })
    await page.loadFiltered('ops', { text: 'merlin', label: [] })
    expect(gets('/threads')).toEqual([{ channel: 'ops', text: 'kestrel', limit: '50' }])
    // What it does find threads by is still asked: a label, there.
    await page.loadFiltered('ops', { label: ['state=open'] })
    expect(gets('/threads').at(-1)).toEqual({ channel: 'ops', label: 'state=open', limit: '50' })
  })
})
