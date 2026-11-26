import { describe, expect, it } from 'vitest'
import type { BoardEventView, MessageView, ScheduleView, SchemaView, TaskView } from '../src/api/routes.ts'
import { block } from '../src/contract/blocks.ts'
import * as store from '../src/inspect/app/store.ts'
import { continues } from '../src/inspect/app/store.ts'
import { boardWords, cadence, clock, laterFields, localInput, principalName, refusal, span, timingWords, until } from '../src/inspect/app/words.ts'

const ME = 'vercel:user:u_julian'

function message(id: number, overrides: Partial<MessageView> = {}): MessageView {
  return {
    id: String(id),
    version: id,
    revision: id,
    channel: 'ops',
    text: `message ${id}`,
    re: null,
    replyTo: null,
    thread: `t${id}`,
    labels: {},
    reactions: {},
    by: { actor: ME, principal: 'vercel:user:u_julian', profile: null },
    noSync: false,
    origin: null,
    from: null,
    blocks: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    editedAt: null,
    deleted: false,
    undelivered: {},
    attachments: [],
    links: [],
    author: { kind: 'person', handle: 'julian', name: 'julian', avatar: null },
    ...overrides,
  }
}

/** A message.posted event as the stream sends it: its payload mirrors the message. */
const postedEvent = (m: MessageView): BoardEventView => ({
  cursor: String(m.version),
  type: 'message.posted',
  createdAt: '',
  payload: {
    channel: m.channel,
    text: m.text,
    re: m.re,
    replyTo: m.replyTo,
    thread: m.thread,
    labels: m.labels,
    noSync: m.noSync,
    by: m.by,
    origin: m.origin,
    from: m.from,
  },
  message: m,
})

const start: store.State = { ...store.initialState, me: { actor: ME } as store.State['me'] }

describe('the inspector store', () => {
  it('keeps the newest view of a message, whatever order views arrive in', () => {
    let state = store.merge(start, [message(1, { text: 'new', version: 10 })])
    state = store.merge(state, [message(1, { text: 'old', version: 5 })])
    expect(state.messages['1']!.text).toBe('new')
    state = store.merge(state, [message(1, { text: 'newer', version: 11 })])
    expect(state.messages['1']!.text).toBe('newer')
  })

  it('folds live events in, and counts new threads', () => {
    const posted = postedEvent(message(3, { channel: 'new' }))
    let state = store.applyEvent(start, posted)
    expect(state.channels.new).toMatchObject({ threads: 1, messages: 1, lastIndex: 3 })
    expect(state.cursor).toBe('3')
    state = store.applyEvent(state, posted) // a repeat counts once
    expect(state.channels.new!.messages).toBe(1)
    state = store.applyEvent(state, {
      cursor: '4',
      type: 'actor.seen',
      createdAt: '',
      payload: { actor: ME, kind: 'person', handle: 'julian', name: 'Julian', avatar: 'https://example.com/a.png' },
    })
    expect(store.shown(state, '3')!.author).toMatchObject({ name: 'Julian', avatar: 'https://example.com/a.png' })
  })

  it("makes up no counts on a board that keeps none, as a team board in Vercel's API doesn't", () => {
    let state: store.State = { ...start, channels: { general: { path: 'general' } } }
    state = store.applyEvent(state, postedEvent(message(1, { channel: 'general' })))
    state = store.applyEvent(state, postedEvent(message(2, { channel: 'dev/web' })))
    expect(state.channels).toEqual({ general: { path: 'general' }, 'dev/web': { path: 'dev/web' } })
  })

  it('lists a channel created while it is open, and keeps the counts of one a post made first', () => {
    const created = (channel: string, cursor: string): BoardEventView => ({
      cursor,
      type: 'channel.created',
      createdAt: '',
      payload: { channel, by: { actor: ME, principal: ME, profile: null } },
    })
    let state = store.applyEvent(start, created('dev/alerts', '2'))
    expect(state.channels['dev/alerts']).toEqual({ path: 'dev/alerts', lastIndex: 0, messages: 0, threads: 0 })
    state = store.applyEvent(state, postedEvent(message(3, { channel: 'ops' })))
    state = store.applyEvent(state, created('ops', '4'))
    expect(state.channels.ops).toMatchObject({ messages: 1, threads: 1, lastIndex: 3 })
  })

  it('shows your changes at once, until the board confirms them', () => {
    let state = store.merge(start, [message(1)])
    state = store.addOp(state, '1', 'a', { kind: 'react', emoji: '+1', remove: false })
    state = store.addOp(state, '1', 'b', { kind: 'label', set: { status: 'open' }, unset: [] })
    expect(store.shown(state, '1')).toMatchObject({ reactions: { thumbs_up: [ME] }, labels: { status: 'open' } })

    // The board confirms the reaction; the label is still on its way.
    state = store.merge(state, [message(1, { reactions: { thumbs_up: [ME] }, version: 2 })])
    expect(state.ops['1']!.map((entry) => entry.id)).toEqual(['b'])
    expect(store.shown(state, '1')).toMatchObject({ reactions: { thumbs_up: [ME] }, labels: { status: 'open' } })

    state = store.dropOp(state, '1', 'b') // the write failed
    expect(store.shown(state, '1')!.labels).toEqual({})
  })

  it('removes a reaction you take back, and tombstones a delete', () => {
    let state = store.merge(start, [message(1, { reactions: { eyes: [ME, 'slack:user:U1'] } })])
    state = store.addOp(state, '1', 'a', { kind: 'react', emoji: 'eyes', remove: true })
    expect(store.shown(state, '1')!.reactions).toEqual({ eyes: ['slack:user:U1'] })
    state = store.addOp(state, '1', 'b', { kind: 'delete' })
    expect(store.shown(state, '1')).toMatchObject({ deleted: true, text: '', reactions: {} })
  })

  it('never shows a post twice when the stream beats the board\'s answer', () => {
    const post: store.Pending = { key: 'k', channel: 'ops', re: null, text: 'four', noSync: false, labels: {}, createdAt: '', error: null }
    const other: store.Pending = { ...post, key: 'k2', text: 'five' }
    let state: store.State = { ...start, pending: [post, other] }
    state = store.applyEvent(state, postedEvent(message(17, { text: 'four' })))
    expect(state.pending.map((p) => p.key)).toEqual(['k2'])
    expect(store.channelThreads(state, 'ops').threads.map((t) => t.root.text)).toEqual(['four'])
    // Someone else's identical message isn't yours.
    state = store.applyEvent(
      state,
      postedEvent(message(18, { text: 'five', by: { actor: 'slack:user:U1', principal: 'slack:user:U1', profile: null } })),
    )
    expect(state.pending.map((p) => p.key)).toEqual(['k2'])
  })

  it('filters like the board: source, text, and labels on the message or its root', () => {
    const state = store.merge(
      start,
      [
        message(1, { labels: { pr: 'x/y#1', state: 'open' }, from: 'github' }),
        message(2, { re: '1', text: 'Flaky test', from: 'slack' }),
        message(3, { labels: { state: 'draft' } }),
      ],
    )
    const ids = (filter: Partial<store.Filter>) =>
      Object.values(state.messages)
        .filter((m) => store.matches(state, m, { label: [], ...filter }))
        .map((m) => m.id)
    expect(ids({ label: ['pr'] })).toEqual(['1', '2'])
    expect(ids({ label: ['state=open|draft'] })).toEqual(['1', '2', '3'])
    expect(ids({ label: ['pr=x/y#1'], text: 'flaky' })).toEqual(['2'])
    expect(ids({ from: 'board' })).toEqual(['3'])
    expect(store.filtering({ label: [] })).toBe(false)
  })

  it("groups a thread's replies, and a channel's threads, by author and time", () => {
    const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 12, minutes)).toISOString()
    const first = message(1, { createdAt: at(0), re: '9' })
    expect(continues(first, message(2, { createdAt: at(4), re: '9' }))).toBe(true)
    expect(continues(first, message(2, { createdAt: at(6), re: '9' }))).toBe(false) // too late
    expect(continues(first, message(2, { createdAt: at(1), re: '9', channel: 'other' }))).toBe(false) // elsewhere
    expect(continues(first, message(2, { createdAt: at(1), re: '8' }))).toBe(false) // another thread
    expect(continues(first, message(2, { createdAt: at(1), re: '9' }), true)).toBe(false) // the first has replies
    expect(continues(first, message(2, { createdAt: at(1), re: '9', by: { actor: 'slack:user:U1', principal: 'slack:user:U1', profile: null } }))).toBe(false)
    // Two threads one author started a minute apart show who once, as Slack does, unless the first has replies.
    expect(continues(message(1, { createdAt: at(0) }), message(2, { createdAt: at(1) }))).toBe(true)
    expect(continues(message(1, { createdAt: at(0) }), message(2, { createdAt: at(1) }), true)).toBe(false)
    // A reply moves an older thread below a newer one by the same author: it shows who started it again.
    expect(continues(message(2, { createdAt: at(1) }), message(1, { createdAt: at(0) }))).toBe(false)
  })

  it("lists a channel by the board's thread pages: a task that came in from the task list shows there once a page has it", () => {
    const on = (day: string) => `2026-${day}T00:00:00.000Z`
    const row = (m: MessageView) => ({ message: m, replies: 0, last: null })
    // The channel's first page, then an open task from the list that is older than anything on it.
    let state = store.listing(start, 'ops')
    state = store.mergeThreads(state, 'ops', { threads: [row(message(101, { createdAt: on('10-02') })), row(message(102, { createdAt: on('10-03') }))], cursor: '102', older: 'before-101' }, 'first')
    const task = message(5, { createdAt: on('09-01'), text: 'an old task' })
    state = store.merge(state, [task])
    const roots = (s: store.State) => store.channelRows(s, 'ops').threads.map((t) => t.root.id)
    // It is held, for the Tasks view and its thread, and the channel shows no thread above ones it hasn't read.
    expect(store.thread(state, '5')!.root.text).toBe('an old task')
    expect(roots(state)).toEqual(['101', '102'])
    // Once a page further back has it, it shows in its place.
    state = store.mergeThreads(state, 'ops', { threads: [row(task)], cursor: '102', older: null }, 'older')
    expect(roots(state)).toEqual(['5', '101', '102'])
  })

  it('offers the profiles the board has seen a principal write as, then the usual agents, each once', () => {
    const actor = (handle: string): store.State['actors'][string] => ({ kind: 'agent', handle, name: handle, avatar: null })
    const state: store.State = { ...start, actors: Object.fromEntries(['vercel:user:u_julian+fixer', 'vercel:user:u_julian+claude', 'vercel:user:u_ada+scout', 'vercel:user:u_julian'].map((id) => [id, actor(id)])) }
    expect(store.profilesOf(state, 'vercel:user:u_julian')).toEqual(['fixer', 'claude', 'codex'])
    expect(store.profilesOf(state, 'vercel:user:u_ada')).toEqual(['scout', 'claude', 'codex'])
  })

  it('groups a channel into threads, with pending posts', () => {
    let state = store.merge(start, [message(1), message(2, { re: '1' }), message(3), message(4, { channel: 'other' })])
    state = { ...state, pending: [{ key: 'k', channel: 'ops', re: '3', text: 'soon', noSync: false, labels: {}, createdAt: '', error: null }] }
    const { threads } = store.channelThreads(state, 'ops')
    expect(threads.map((t) => [t.root.id, t.replies.map((r) => r.id), t.pending.length])).toEqual([
      ['1', ['2'], 0],
      ['3', [], 1],
    ])
    expect(store.thread(state, '1')!.replies.map((r) => r.id)).toEqual(['2'])
    expect(store.recent(state, 2).map((m) => m.id)).toEqual(['3', '4'])
  })

  const NOW = Date.parse('2026-10-01T12:00:00.000Z')
  const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString()
  const PRINCIPAL = 'vercel:user:u_julian'

  // --- tasks ---


  /** A root that's a task, as the board shows one. */
  const task = (id: number, overrides: Partial<TaskView> = {}, root: Partial<MessageView> = {}) =>
    message(id, {
      channel: 'work',
      labels: { 'board.task': overrides.state ?? 'ready' },
      task: { state: 'ready', owner: PRINCIPAL, by: ME, for: null, needs: [], epoch: 0, claim: null, blocked: null, result: null, reason: null, due: null, ...overrides },
      ...root,
    }) as store.TaskRoot
  const claimedBy = (actor: string, until: string, epoch = 1): Partial<TaskView> => ({ state: 'claimed', epoch, claim: { actor, until } })

  /** A viewer with what `can` lists in every channel. */
  const viewer = (can: string[], who: Partial<store.Viewer> = {}): store.Viewer => ({ actor: ME, principal: PRINCIPAL, profile: null, may: (permission) => can.includes(permission), manages: false, ...who })

  it('reads a claim past its lease as over: the task is ready, whatever the board last wrote', () => {
    const held = task(1, claimedBy('vercel:user:u_ada', at(5)))
    expect(store.stateNow(held.task, NOW)).toBe('claimed')
    expect(store.stateNow(held.task, NOW + 5 * 60_000)).toBe('ready')
    expect(store.stateNow(task(2, { state: 'blocked' }).task, NOW)).toBe('blocked')
  })

  it("keeps this tab's claim while the board shows it, and drops it once the task moves on", () => {
    const claim = { epoch: 1 }
    const mine = task(1, claimedBy(ME, at(15)), { version: 10 })
    let state = store.claimed(start, mine, claim)
    expect(store.holding(state, mine, NOW)).toEqual(claim)
    // A renewal is the same claim, later.
    const renewed = task(1, claimedBy(ME, at(30)), { version: 11 })
    state = store.merge(state, [renewed])
    expect(store.holding(state, renewed, NOW + 20 * 60_000)).toEqual(claim)
    // Past its lease it holds nothing, though the board hasn't said so yet.
    expect(store.holding(state, renewed, NOW + 31 * 60_000)).toBeUndefined()
    // An older view of the task, from before the claim, changes nothing.
    state = store.merge(state, [task(1, {}, { version: 5 })])
    expect(state.claims['1']).toEqual(claim)
    // Someone else claimed it since: the same state at another epoch isn't this tab's.
    const taken = task(1, claimedBy('vercel:user:u_ada', at(40), 2), { version: 12 })
    state = store.merge(state, [taken])
    expect(state.claims['1']).toBeUndefined()
    expect(store.holding(state, taken, NOW)).toBeUndefined()

    // Released, completed, held, or canceled: each ends it.
    for (const next of ['ready', 'completed', 'blocked', 'canceled'] as const) {
      const after = store.merge(store.claimed(start, mine, claim), [task(1, { state: next, epoch: 1 }, { version: 11 })])
      expect(after.claims['1'], next).toBeUndefined()
    }
    // A claim whose answer arrives after the board moved on is dropped as it lands.
    const late = store.claimed(store.merge(start, [taken]), mine, claim)
    expect(late.claims['1']).toBeUndefined()
    expect(store.unclaimed(store.claimed(start, mine, claim), '1').claims).toEqual({})
  })

  it('offers what the viewer can do to a task now, and nothing else', () => {
    const can = (root: store.TaskRoot, who: store.Viewer, state: store.State = start) =>
      Object.entries(store.moves(state, root, who, NOW))
        .filter(([, yes]) => yes)
        .map(([move]) => move)
    const owner = viewer(['post', 'label'])
    const teammate = viewer(['post', 'label'], { actor: 'vercel:user:u_ada', principal: 'vercel:user:u_ada' })
    const manager = viewer(['post', 'label', 'manage'], { actor: 'vercel:user:u_ada', principal: 'vercel:user:u_ada' })
    const reader = viewer([], { actor: 'vercel:user:u_ada', principal: 'vercel:user:u_ada' })

    // Ready: anyone with label claims it; its owner, or manage there, changes it.
    expect(can(task(1), owner)).toEqual(['claim', 'hold', 'assign', 'cancel'])
    expect(can(task(1), teammate)).toEqual(['claim'])
    expect(can(task(1), manager)).toEqual(['claim', 'hold', 'assign', 'cancel'])
    expect(can(task(1), reader)).toEqual([])
    // An owner narrowed to reading doesn't change its principal's tasks.
    expect(can(task(1), viewer([]))).toEqual([])

    // Of its owner's actors, the one that made it a task changes it, and the owner itself, as no profile, changes any.
    const made = task(1, { by: `${PRINCIPAL}+fixer` })
    expect(can(made, viewer(['post', 'label'], { actor: `${PRINCIPAL}+fixer`, profile: 'fixer' }))).toEqual(['claim', 'hold', 'assign', 'cancel'])
    expect(can(made, viewer(['post', 'label'], { actor: `${PRINCIPAL}+other`, profile: 'other' }))).toEqual(['claim'])
    expect(can(made, owner)).toEqual(['claim', 'hold', 'assign', 'cancel'])
    // Another principal whose own ID reads the same as `by` isn't its owner.
    expect(can(made, viewer(['post', 'label'], { actor: `${PRINCIPAL}+fixer`, principal: `${PRINCIPAL}+fixer` }))).toEqual(['claim'])

    // Assigned: only that actor of its owner's claims it.
    const assigned = task(1, { for: `${PRINCIPAL}+codex` })
    expect(can(assigned, owner)).not.toContain('claim')
    expect(can(assigned, viewer(['label'], { actor: `${PRINCIPAL}+codex` }))).toContain('claim')
    // Another principal's actor can be the same string, and isn't who it's for.
    expect(can(assigned, viewer(['label'], { actor: `${PRINCIPAL}+codex`, principal: 'vercel:user:u_ada' }))).not.toContain('claim')

    // Claimed by someone else: no one claims or holds it; its owner still assigns and cancels.
    const theirs = task(1, claimedBy('vercel:user:u_ada', at(10)))
    expect(can(theirs, owner)).toEqual(['assign', 'cancel'])
    expect(can(theirs, teammate)).toEqual(['elsewhere'])
    // Once that lease runs out, it's claimable again, and its owner can hold it.
    expect(can(task(1, claimedBy('vercel:user:u_ada', at(-1))), owner)).toEqual(['claim', 'hold', 'assign', 'cancel'])

    // Claimed from this tab: the claim's own moves. Claimed as the viewer from elsewhere: none of them.
    const mine = task(1, claimedBy(ME, at(10)))
    expect(can(mine, owner, store.claimed(start, mine, { epoch: 1 }))).toEqual(['held', 'assign', 'cancel'])
    expect(can(mine, owner)).toEqual(['elsewhere', 'assign', 'cancel'])

    expect(can(task(1, { state: 'waiting', needs: ['9'] }), owner)).toEqual(['hold', 'assign', 'cancel'])
    expect(can(task(1, { state: 'blocked', blocked: { kind: null, reason: 'why?' } }), owner)).toEqual(['unblock', 'assign', 'cancel'])
    expect(can(task(1, { state: 'failed', reason: 'exited 1' }), owner)).toEqual(['reopen', 'cancel'])
    expect(can(task(1, { state: 'completed' }), owner)).toEqual([])
    expect(can(task(1, { state: 'canceled', reason: 'no' }), owner)).toEqual([])
  })

  it('takes in a task event it has never heard of, by the root it carries', () => {
    let state = store.merge(start, [task(1, { state: 'waiting', needs: ['5'] }, { version: 3 })])
    // What a task waits for can change: the event says so with the root as it is after.
    const changed = { cursor: '9', type: 'task.needs_changed', createdAt: '', payload: { id: '1', needs: ['6', '7'] }, message: task(1, { state: 'waiting', needs: ['6', '7'] }, { version: 9 }) }
    state = store.applyEvent(state, changed as unknown as BoardEventView)
    expect((store.shown(state, '1') as store.TaskRoot).task.needs).toEqual(['6', '7'])
    expect(store.tasks(state, { state: 'waiting', label: [] }, NOW).map((t) => t.task.needs)).toEqual([['6', '7']])
    expect(state.cursor).toBe('9')
  })

  it('lists tasks like the board: oldest first, by state, place, labels, owner, and who they are for', () => {
    const state = store.merge(start, [
      task(1, {}, { createdAt: at(1), labels: { step: 'fix' } }),
      task(2, { state: 'waiting', needs: ['1'] }, { createdAt: at(2), channel: 'work/security' }),
      task(3, claimedBy(ME, at(-1)), { createdAt: at(3) }), // its lease ran out
      task(4, { state: 'completed', result: 'done' }, { createdAt: at(4) }),
      task(5, { owner: 'vercel:user:u_ada', for: 'vercel:user:u_ada+fixer' }, { createdAt: at(0), channel: 'workshop' }),
      task(6, {}, { createdAt: at(5), deleted: true }),
      message(7, { channel: 'work' }), // a thread that isn't a task
    ])
    const ids = (filter: Partial<store.TaskFilter>, through?: MessageView) => store.tasks(state, { state: 'open', label: [], ...filter }, NOW, through).map((t) => t.id)
    expect(ids({})).toEqual(['5', '1', '2', '3'])
    expect(ids({ state: 'all' })).toEqual(['5', '1', '2', '3', '4'])
    // A lapsed claim lists as ready, and not as claimed.
    expect(ids({ state: 'ready' })).toEqual(['5', '1', '3'])
    expect(ids({ state: 'claimed' })).toEqual([])
    expect(ids({ state: 'completed' })).toEqual(['4'])
    // A channel is itself; with a trailing slash, itself and what's under it, and nothing that only starts like it.
    expect(ids({ channel: 'work' })).toEqual(['1', '3'])
    expect(ids({ channel: 'work/' })).toEqual(['1', '2', '3'])
    expect(ids({ label: ['step=fix'] })).toEqual(['1'])
    expect(ids({ owner: 'vercel:user:u_ada' })).toEqual(['5'])
    expect(ids({ for: 'vercel:user:u_ada+fixer' })).toEqual(['5'])
    // While the board has more, the list ends at the last task it listed.
    expect(ids({}, state.messages['1'])).toEqual(['5', '1'])
    // They're counted only once every open one is here.
    expect(store.openTasks(state)).toBeNull()
    expect(store.openTasks({ ...state, tasksCounted: true })).toBe(4)
  })

  it('says what is left of a lease, and what a refusal means', () => {
    expect(clock(15 * 60_000)).toBe('15:00')
    expect(clock(59_400)).toBe('1:00') // rounds up, so it reads 0:00 only once it's over
    expect(clock(3_725_000)).toBe('1h 02m')
    expect(clock(-5)).toBe('0:00')
    const board = (code: string) => Object.assign(new Error('the board said so'), { code })
    // A refusal the page knows is said in its words; any other in the board's.
    expect(refusal(board('claim_lost'))).not.toContain('the board said so')
    expect(refusal(board('claim_lost'))).toMatch(/claim/)
    expect(refusal(board('invalid_needs'))).toBe('the board said so')
  })

  // --- blocks and schemas ---

  it("names an actor as the board last showed them, or by what their ID says", () => {
    const state: store.State = { ...start, actors: { [`${PRINCIPAL}+claude`]: { kind: 'agent', handle: 'julian/claude', name: 'claude', avatar: null, via: { name: 'Julian', environment: null } } } }
    expect(store.nameOf(state, `${PRINCIPAL}+claude`)).toBe('claude via Julian')
    expect(store.nameOf(state, 'local:user:ada+fixer')).toBe('fixer via ada')
    expect(store.nameOf(state, 'local:user:ada')).toBe('ada')
  })

  const schema = (name: string, version: number, overrides: Partial<SchemaView> = {}): SchemaView => ({
    id: `${name}@${version}`,
    name,
    version,
    description: null,
    schema: { type: 'object', properties: {} },
    builtIn: false,
    by: ME,
    at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  })

  it("splits a message into prose and the blocks the board lists, where their fences are", () => {
    const run = { schema: 'test-run', version: 1, data: { suite: 'unit', passed: 3 } }
    const commit = { schema: 'git-commit', version: 1, data: { sha: 'a1b2', title: 'fix' } }
    const text = `Tests pass.\n\n${block('test-run@1', run.data)}\n\nBuilt from:\n${block('git-commit@1', commit.data)}`
    expect(store.bodyParts(text, [run, commit])).toEqual([{ text: 'Tests pass.\n\n' }, { block: run }, { text: '\n\nBuilt from:\n' }, { block: commit }])
    // Prose after the last block is kept.
    expect(store.bodyParts(`${block('test-run@1', run.data)}\nDone.`, [run])).toEqual([{ block: run }, { text: '\nDone.' }])
    // A message that is only its data has no prose around it.
    expect(store.bodyParts(block('test-run@1', run.data), [run])).toEqual([{ block: run }])
    // A fence the board lists no block for stays text: a platform's text is never checked.
    expect(store.bodyParts(text, [])).toEqual([{ text }])
    expect(store.bodyParts('plain', [])).toEqual([{ text: 'plain' }])
    expect(store.bodyParts('', [])).toEqual([])
    // Blocks the text can't place still show, after it.
    expect(store.bodyParts('no fence here', [run])).toEqual([{ text: 'no fence here' }, { block: run }])
  })

  it("orders a block's fields as its schema lists them, with what it says of each", () => {
    const run = { schema: 'test-run', version: 1, data: { extra: true, passed: 3, suite: 'unit' } }
    const known = schema('test-run', 1, { schema: { type: 'object', properties: { suite: { type: 'string', description: 'The suite that ran' }, passed: { type: 'integer' }, failed: { type: 'integer' } } } })
    expect(store.blockFields(run, known)).toEqual([
      { name: 'suite', value: 'unit', description: 'The suite that ran' },
      { name: 'passed', value: 3 },
      { name: 'extra', value: true },
    ])
    // A schema the registry doesn't hold: the data as it is.
    expect(store.blockFields(run, undefined).map((field) => field.name)).toEqual(['extra', 'passed', 'suite'])
  })

  it('reads the registry by name, and takes in a new version once', () => {
    const registry = [schema('test-run', 2), schema('git-commit', 1, { builtIn: true }), schema('test-run', 1), schema('deploy', 1)]
    expect(store.schemasByName(registry).map((group) => [group.name, group.builtIn, group.versions.map((v) => v.version)])).toEqual([
      ['git-commit', true, [1]],
      ['deploy', false, [1]],
      ['test-run', false, [1, 2]],
    ])
    let state: store.State = { ...start, schemas: registry }
    expect(store.schemaOf(state, 'test-run', 2)).toBe(registry[0])
    expect(store.schemaOf(state, 'test-run', 3)).toBeUndefined()
    expect(store.schemaOf(start, 'test-run', 1)).toBeUndefined() // not read yet
    state = store.addSchema(state, schema('test-run', 3))
    expect(store.schemaOf(state, 'test-run', 3)).toBeDefined()
    expect(store.addSchema(state, schema('test-run', 3))).toBe(state)
  })

  // --- lists the board may not give, and access ---

  it("reads a grant's lines as the CLI writes them, and leaves what they mean to the board", () => {
    expect(store.canFromLines('work/=read,post\n secrets/ = none \n*=all')).toEqual({ can: { 'work/': ['read', 'post'], 'secrets/': 'none', '*': 'all' } })
    expect(store.canFromLines('ops=read; dev=post')).toEqual({ can: { ops: ['read'], dev: ['post'] } })
    // A permission it has never heard of goes as written: the board says whether there's one.
    expect(store.canFromLines('ops=shout')).toEqual({ can: { ops: ['shout'] } })
    expect(store.canFromLines('work/')).toHaveProperty('problem')
    expect(store.canFromLines('=read')).toHaveProperty('problem')
    expect(store.canFromLines('work/=')).toHaveProperty('problem')
    expect(store.canFromLines('  \n')).toHaveProperty('problem')
  })

  it('names who a grant is for', () => {
    expect(principalName({ kind: 'user', userId: 'u_1', email: 'ada@acme.com' })).toBe('ada@acme.com')
    expect(principalName({ kind: 'user', userId: 'u_1', email: null })).toBe('u_1')
    expect(principalName({ kind: 'project', projectId: 'prj_1', name: 'web', environments: ['production', 'preview'], teamId: null })).toBe('web (production, preview)')
    expect(principalName({ kind: 'github', repositoryId: null, repository: 'acme/web', workflow: 'ci.yml', branch: 'main' })).toBe('acme/web · ci.yml · main')
    expect(principalName({ kind: 'app', clientId: 'cl_1', name: null })).toBe('cl_1')
    expect(principalName({ kind: 'everyone' })).toBe('everyone')
  })

  // --- schedules ---

  it("finds a thread's pending scheduled replies, soonest first, and says when and how often each sends", () => {
    const schedule = (id: string, overrides: Partial<ScheduleView>) => ({ id, re: '17', state: 'pending', next: at(60), every: null, times: null, sent: 0, until: null, ...overrides }) as ScheduleView
    const listed = [schedule('s1', { next: at(120) }), schedule('s2', { next: at(5) }), schedule('s3', { re: '9' }), schedule('s4', { state: 'canceled', next: null }), schedule('s5', { re: null })]
    const state: store.State = { ...start, schedules: { is: 'here', items: listed } }
    expect(store.threadSchedules(state, '17').map((s) => s.id)).toEqual(['s2', 's1'])
    expect(store.threadSchedules(start, '17')).toEqual([]) // not listed yet

    expect(until(at(125), NOW)).toBe('in 2h')
    expect(until(at(59), NOW)).toBe('in 59m')
    expect(until(at(3 * 24 * 60), NOW)).toBe('in 3d')
    expect(until(at(-1), NOW)).toBe('now')
    expect(span(86_400_000)).toBe('1d')
    expect(span(90 * 60_000)).toBe('90m')
    expect(span(36 * 3_600_000)).toBe('36h')
    expect(cadence({ every: null, times: null, sent: 0, until: null })).toBe('once')
    expect(cadence({ every: 7 * 86_400_000, times: 4, sent: 1, until: null })).toBe('every 7d · 1 of 4 sent')
    expect(cadence({ every: 3_600_000, times: null, sent: 12, until: null })).toBe('every 1h · 12 sent')
  })

  it('says which board it is: its name and host where it has a name, else its host and where on it', () => {
    // A team's board in Vercel's API has a name, and every one is on the same host.
    expect(boardWords({ url: 'https://api.vercel.com/v1/messageboard/boards/brd_1?teamId=team_1', name: 'General' })).toEqual({ name: 'General', at: 'api.vercel.com' })
    // A board mounted on a deployment is known by its host, and where it's mounted there.
    expect(boardWords({ url: 'https://board.acme.com/api/board' })).toEqual({ name: 'board.acme.com', at: '/api/board' })
    expect(boardWords({ url: 'http://localhost:4000/' })).toEqual({ name: 'localhost:4000', at: null })
    // Before it has answered.
    expect(boardWords(null)).toEqual({ name: 'board', at: null })
  })

  it("keeps a post to send later through a message that lands saying the same", () => {
    const post: store.Pending = { key: 'k', channel: 'ops', re: null, text: 'standup', noSync: false, labels: {}, createdAt: '', error: null }
    const later: store.Pending = { ...post, key: 'k2', later: { in: '2h' } }
    // Yours, in the same place, saying the same: it stands for the post on its way, never for the one to send later.
    const state = store.applyEvent({ ...start, pending: [later, post] }, postedEvent(message(17, { text: 'standup' })))
    expect(state.pending.map((pending) => pending.key)).toEqual(['k2'])
  })

  it("starts the send-later form from the timing it has, the time as a datetime-local input takes it", () => {
    // Local, to the minute: built in local time here, so it reads the same in any zone.
    const nine = new Date(2026, 10, 12, 9, 5)
    expect(localInput(nine)).toBe('2026-11-12T09:05')
    expect(localInput(nine.toISOString())).toBe('2026-11-12T09:05')
    expect(localInput('not a time')).toBe('')
    // What the form sends back for it is the same instant.
    expect(new Date(localInput(nine.toISOString())).toISOString()).toBe(nine.toISOString())

    expect(laterFields({ at: nine.toISOString(), every: '1d', times: 3 })).toEqual({ after: '', at: '2026-11-12T09:05', every: '1d', times: '3' })
    expect(laterFields({ in: '2h' })).toEqual({ after: '2h', at: '', every: '', times: '' })
    expect(laterFields(null)).toEqual({ after: '', at: '', every: '', times: '' })
    expect(timingWords({ in: '2h', every: '1d' })).toBe('in 2h, every 1d')
    expect(timingWords({ every: '7d' })).toBe('every 7d')
  })

  it("reads every shape a schema's property takes, a bare true or false included", () => {
    const definition = {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'What it is called' },
        anything: true,
        nothing: false,
        when: { type: 'string', format: 'date-time' },
        size: { type: ['integer', 'null'] },
        kind: { enum: ['a', 'b'] },
        fixed: { const: 1 },
        untyped: {},
      },
    }
    expect(store.schemaFields(definition)).toEqual([
      { name: 'name', type: 'string', required: true, description: 'What it is called' },
      { name: 'anything', type: 'any', required: false, description: '' },
      { name: 'nothing', type: 'never', required: false, description: '' },
      { name: 'when', type: 'string (date-time)', required: false, description: '' },
      { name: 'size', type: 'integer | null', required: false, description: '' },
      { name: 'kind', type: 'enum', required: false, description: '' },
      { name: 'fixed', type: 'const', required: false, description: '' },
      { name: 'untyped', type: 'any', required: false, description: '' },
    ])
    // A schema with no properties, or with something else in their place, has no rows.
    expect(store.schemaFields({ type: 'object' })).toEqual([])
    expect(store.schemaFields({ properties: true })).toEqual([])
    // A block of such a schema shows its data all the same.
    const registered = { id: 'thing@1', name: 'thing', version: 1, description: null, schema: definition, builtIn: false, by: null, at: null }
    expect(store.blockFields({ schema: 'thing', version: 1, data: { anything: 1, name: 'x' } }, registered)).toEqual([
      { name: 'name', value: 'x', description: 'What it is called' },
      { name: 'anything', value: 1 },
    ])
  })

  it('offers the places one level down to list tasks from, for a board that lists them a tree at a time', () => {
    const channels = ['ops', 'work', 'work/api', 'work/web', 'v0/a/b', 'v0/c', 'solo']
    // A channel with channels under it goes with them, in its tree, which counts it.
    expect(store.placesUnder(channels)).toEqual([
      { place: 'ops', channels: 1 },
      { place: 'solo', channels: 1 },
      { place: 'v0/', channels: 2 },
      { place: 'work/', channels: 3 },
    ])
    // A tree that's still too big has places of its own: its own channel, its trees, and its channels.
    expect(store.placesUnder(channels, 'work/')).toEqual([
      { place: 'work', channels: 1 },
      { place: 'work/api', channels: 1 },
      { place: 'work/web', channels: 1 },
    ])
    expect(store.placesUnder(channels, 'v0/')).toEqual([
      { place: 'v0/a/', channels: 1 },
      { place: 'v0/c', channels: 1 },
    ])
    // A tree written without its slash is the same tree.
    expect(store.placesUnder(channels, 'v0')).toEqual(store.placesUnder(channels, 'v0/'))
  })
})
