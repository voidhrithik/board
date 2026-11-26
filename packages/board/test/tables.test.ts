import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { compileAccess, FULL_ACCESS, type Can } from '../src/server/access.ts'
import type { BoardEvent } from '../src/contract/events.ts'
import { foldActors, foldMessages, foldSync, type ActorsState, type Message, type MessagesState, type SyncState } from '../src/contract/folds.ts'
import { compileFilter, readableFilter, toMessageFilter } from '../src/server/feed.ts'
import type { ParsedFilters } from '../src/api/routes.ts'
import { memory } from '../src/store/memory.ts'
import { sqliteDb } from '../src/store/sqlite-db.ts'
import { sqlite } from '../src/store/sqlite.ts'
import { project } from '../src/store/project.ts'
import { sqlTables } from '../src/store/sql.ts'
import type { BoardStore, MessageTables } from '../src/store/types.ts'

/** A small seeded generator, so a failing history can be replayed. */
function random(seed: number) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!
  return { next, pick, chance: (p: number) => next() < p }
}

const AUTHORS = [
  { actor: 'vercel:user:u_ada', principal: 'vercel:user:u_ada', profile: null },
  { actor: 'vercel:user:u_ada+claude', principal: 'vercel:user:u_ada', profile: 'claude', session: 's1' },
  { actor: 'vercel:user:u_bo', principal: 'vercel:user:u_bo', profile: null },
  { actor: 'slack:user:U1', principal: 'slack:user:U1', profile: null },
] as const
const SEEN = [
  { actor: 'vercel:user:u_ada', kind: 'person', handle: 'ada', name: 'Ada', avatar: null },
  { actor: 'vercel:user:u_ada+claude', kind: 'agent', handle: 'ada/claude', name: 'Claude', avatar: null },
  { actor: 'vercel:user:u_bo', kind: 'person', handle: 'bo', name: 'Bo', avatar: null },
  { actor: 'slack:user:U1', kind: 'person', handle: 'sam', name: 'Sam', avatar: null },
  // Names every object has are handles, channels, and older logs' emoji and label keys like any other.
  { actor: 'slack:user:U2', kind: 'external', handle: '__proto__', name: 'Proto', avatar: null },
  { actor: 'slack:user:U3', kind: 'external', handle: 'constructor', name: 'Con', avatar: null },
] as const
const CHANNELS = ['dev', 'dev/sub', 'dev_x', 'ops', 'constructor']
const WORDS = ['PR', '#1', 'fix', 'Bug', 'deploy', 'ÉCLAIR', 'naïve', '100%', 'a_b', 'shipit']
/** Mentions as people write them, by handle, actor ID, or email, and one in code that doesn't count. */
const MENTIONS = ['@bo', '@ADA', '@ada/claude', '@sam', '@constructor', '@[vercel:user:u_bo]', '@[vercel:user:u_ada+claude]', '@[slack:user:U1]', '@[Bo@Vercel.com]', '`@bo`']
const FILES = ['f_one', 'f_two', 'f_three', 'f_four']
const LABELS: Record<string, string>[] = [{ kind: 'bug' }, { kind: 'feature' }, { pr: '1' }, { pr: '2' }, { 'tag.x': 'y' }, { constructor: 'x' }]

/** A random board history: every event type the messages fold handles, and some it ignores. */
function history(seed: number, length: number): BoardEvent[] {
  const r = random(seed)
  const events: BoardEvent[] = []
  const posted: { id: number; re: number | null; channel: string; thread: string }[] = []
  /** Where each task stood when the generator last wrote to it, to pick what comes next. */
  const tasks = new Map<number, { state: string; epoch: number }>()
  let at = Date.parse('2026-10-01T00:00:00Z')
  const push = (type: string, payload: unknown, id = `e${events.length + 1}`) => {
    at += 1000
    events.push({ index: events.length + 1, id, type, payload, createdAt: new Date(at).toISOString() } as unknown as BoardEvent)
  }
  for (const seen of SEEN) push('actor.seen', seen)
  const text = () => Array.from({ length: 1 + Math.floor(r.next() * 4) }, () => (r.chance(0.15) ? r.pick(MENTIONS) : r.pick(WORDS))).join(' ')
  const labels = () => (r.chance(0.5) ? { ...r.pick(LABELS), ...(r.chance(0.3) ? r.pick(LABELS) : {}) } : {})
  // A log from before mentions were text alone has the actor IDs they resolved to: nothing reads them now.
  const mentions = () => (r.chance(0.3) ? [r.pick(AUTHORS).actor] : [])
  const files = () => [...new Set([r.pick(FILES), r.pick(FILES)])].map((id) => ({ id, name: `${id}.png`, type: 'image/png', size: 1 }))
  while (events.length < length) {
    const author = r.pick(AUTHORS)
    const target = posted.length ? r.pick(posted) : null
    const roll = r.next()
    if (!target || roll < 0.25) {
      const id = `e${events.length + 1}`
      const channel = r.pick(CHANNELS)
      // Some come in from a platform thread, which the root then lives in.
      const imported = r.chance(0.3)
      const n = events.length + 1
      push('message.posted', {
        channel, text: text(), re: null, replyTo: null, thread: id, labels: labels(), noSync: r.chance(0.1),
        ...(r.chance(0.3) ? { attachments: files() } : {}),
        mentions: mentions(), by: author,
        origin: imported ? { channel: 'slack:C9', thread: `slack:C9:${n}`, subthread: null, message: `${n}.0`, context: null } : null,
        from: imported ? 'slack' : null,
      }, id)
      posted.push({ id: events.length, re: null, channel, thread: id })
    } else if (roll < 0.5) {
      const root = target.re ?? target.id
      const rootPost = posted.find((p) => p.id === root)!
      const imported = r.chance(0.2)
      const n = events.length + 1
      push('message.posted', {
        channel: rootPost.channel, text: text(), re: root, replyTo: target.re === null ? null : target.id, thread: rootPost.thread,
        labels: r.chance(0.2) ? labels() : {}, noSync: false, mentions: mentions(), by: author,
        origin: imported ? { channel: 'slack:C9', thread: `slack:C9:${root}`, subthread: r.chance(0.3) ? `slack:C9:${root}:s` : null, message: `${n}.0`, context: null } : null,
        from: imported ? 'slack' : null,
      })
      posted.push({ id: events.length, re: root, channel: rootPost.channel, thread: rootPost.thread })
    } else if (roll < 0.68) {
      // What happens to tasks. Most of it follows a task along, so histories reach every state:
      // `tasks` only steers which event comes next, and what's expected is still the fold's word.
      // The rest lands anywhere, at any epoch, on replies too: writes a task has moved on from,
      // which the fold lets change nothing.
      const until = new Date(at + 60_000).toISOString()
      const stale = (root: { id: number; thread: string }) => {
        const about = { id: root.id, thread: root.thread }
        const epoch = r.pick([1, 2, 3])
        const kind = r.pick(['created', 'ready', 'claimed', 'renewed', 'released', 'expired', 'completed', 'failed', 'blocked', 'unblocked', 'canceled', 'reopened', 'assigned', 'needs'] as const)
        if (kind === 'created') push('task.created', { ...about, needs: [], for: null, by: author })
        else if (kind === 'needs') push('task.needs_changed', { ...about, needs: r.chance(0.5) ? [] : [r.pick(posted).id], by: author })
        else if (kind === 'ready') push('task.ready', about)
        else if (kind === 'claimed') push('task.claimed', { ...about, epoch, until, token: 'b'.repeat(64), by: author })
        else if (kind === 'renewed') push('task.renewed', { ...about, epoch, until, by: author })
        else if (kind === 'released') push('task.released', { ...about, epoch, by: author })
        else if (kind === 'expired') push('task.expired', { ...about, epoch })
        else if (kind === 'completed') push('task.completed', { ...about, epoch, result: null, by: author })
        else if (kind === 'failed') push('task.failed', { ...about, epoch, reason: text(), by: author })
        else if (kind === 'blocked') push('task.blocked', { ...about, kind: null, reason: text(), by: author })
        else if (kind === 'unblocked') push('task.unblocked', { ...about, by: author })
        else if (kind === 'canceled') push('task.canceled', { ...about, reason: text(), by: author })
        else if (kind === 'reopened') push('task.reopened', { ...about, by: author })
        else push('task.assigned', { ...about, for: r.pick(AUTHORS).actor, by: author })
      }
      const roots = posted.filter((p) => p.re === null)
      const known = roots.filter((p) => tasks.has(p.id))
      if (r.chance(0.2)) stale(target)
      else {
        const root = known.length && r.chance(0.75) ? r.pick(known) : r.pick(roots)
        const about = { id: root.id, thread: root.thread }
        const task = tasks.get(root.id)
        const others = known.filter((p) => p.id !== root.id)
        /** What it waits for changes, to another task or to none: it waits again with any, as the fold has it, unless it's held. */
        const rewire = (held = false) => {
          const needs = others.length && r.chance(0.6) ? [r.pick(others).id] : []
          push('task.needs_changed', { ...about, needs, by: author })
          return held ? ('blocked' as const) : needs.length ? ('waiting' as const) : ('ready' as const)
        }
        if (!task) {
          const needs = others.length && r.chance(0.3) ? [r.pick(others).id] : []
          // A time, with no draw of its own: the history stays the one its seed makes.
          const timed = root.id % 3 === 0
          push('task.created', { ...about, needs, for: r.chance(0.2) ? r.pick(AUTHORS).actor : null, ...(timed ? { notBefore: until } : {}), by: author })
          tasks.set(root.id, { state: needs.length || timed ? 'waiting' : 'ready', epoch: 0 })
        } else if (task.state === 'waiting') {
          const kind = r.pick(['ready', 'ready', 'blocked', 'canceled', 'needs'] as const)
          if (kind === 'ready') {
            // Its time taken off first, every other time: one that needs others still waits until its task.ready.
            if (events.length % 2) push('task.not_before_changed', { ...about, notBefore: null, by: author })
            push('task.ready', about)
          } else if (kind === 'blocked') push('task.blocked', { ...about, kind: 'needs_input', reason: text(), by: author })
          else if (kind === 'canceled') push('task.canceled', { ...about, reason: text(), by: author })
          task.state = kind === 'needs' ? rewire() : kind
        } else if (task.state === 'ready') {
          const kind = r.pick(['claimed', 'claimed', 'claimed', 'claimed', 'blocked', 'canceled', 'assigned', 'needs'] as const)
          if (kind === 'claimed') push('task.claimed', { ...about, epoch: ++task.epoch, until, token: 'a'.repeat(64), by: author })
          else if (kind === 'blocked') push('task.blocked', { ...about, kind: null, reason: text(), by: author })
          else if (kind === 'canceled') push('task.canceled', { ...about, reason: text(), by: author })
          else if (kind === 'assigned') {
            push('task.assigned', { ...about, for: r.chance(0.5) ? r.pick(AUTHORS).actor : null, by: author })
            // A time ahead, every other time, with no draw of its own: it waits for it.
            if (events.length % 2 === 0) {
              push('task.not_before_changed', { ...about, notBefore: until, by: author })
              task.state = 'waiting'
            }
          }
          if (kind === 'needs') task.state = rewire()
          else if (kind !== 'assigned') task.state = kind
        } else if (task.state === 'claimed') {
          const { epoch } = task
          const kind = r.pick(['renewed', 'released', 'expired', 'completed', 'completed', 'failed', 'failed', 'blocked', 'canceled'] as const)
          if (kind === 'renewed') push('task.renewed', { ...about, epoch, until, by: author })
          else if (kind === 'released') push('task.released', { ...about, epoch, by: author })
          else if (kind === 'expired') push('task.expired', { ...about, epoch })
          else if (kind === 'completed') push('task.completed', { ...about, epoch, result: r.chance(0.5) ? text() : null, by: author })
          else if (kind === 'failed') push('task.failed', { ...about, epoch, reason: text(), by: author })
          else if (kind === 'blocked') push('task.blocked', { ...about, kind: 'edited', reason: text(), by: author })
          else push('task.canceled', { ...about, reason: text(), by: author })
          if (kind !== 'renewed') task.state = kind === 'released' || kind === 'expired' ? 'ready' : kind
        } else if (task.state === 'blocked') {
          if (r.chance(0.2)) task.state = rewire(true)
          else if (r.chance(0.7)) {
            push('task.unblocked', { ...about, by: author })
            task.state = 'ready'
          } else {
            push('task.canceled', { ...about, reason: text(), by: author })
            task.state = 'canceled'
          }
        } else if (task.state === 'failed') {
          if (r.chance(0.7)) {
            push('task.reopened', { ...about, by: author })
            task.state = 'ready'
          } else {
            push('task.canceled', { ...about, reason: text(), by: author })
            task.state = 'canceled'
          }
        } else stale(root)
      }
    } else {
      const base = { id: target.id, thread: target.thread, by: author, from: null }
      const kind = r.pick(['edit', 'delete', 'react', 'unreact', 'labels', 'linked', 'synced', 'synced', 'files', 'failed', 'attach', 'attach'] as const)
      if (kind === 'edit') push('message.edited', { ...base, text: text(), mentions: mentions() })
      else if (kind === 'delete') push('message.deleted', base)
      else if (kind === 'react') push('reaction.added', { ...base, emoji: r.pick(['eyes', '+1', 'thumbs_up', 'constructor', '__proto__']) })
      else if (kind === 'unreact') push('reaction.removed', { ...base, emoji: r.pick(['eyes', 'thumbs_up', 'constructor', '__proto__']) })
      else if (kind === 'labels') push('labels.changed', { id: target.id, thread: target.thread, by: author, set: labels(), unset: r.chance(0.5) ? [r.pick(['kind', 'pr', 'tag.x', 'constructor'])] : [] })
      else if (kind === 'linked') push('message.linked', { ...base, links: [{ url: 'https://example.com', message: null, snapshot: null, unavailable: null }] })
      else if (kind === 'failed') push('message.sync_failed', { id: target.id, thread: target.thread, target: 'slack:C1', error: 'not_in_channel' })
      else if (kind === 'synced') {
        // A root's receipt in a channel target says which platform thread it started.
        const to = r.pick(['slack:C1', 'github:o/r:7'])
        const external = target.re === null && to === 'slack:C1' ? `slack:C1:${target.id}` : to === 'slack:C1' ? `slack:C1:${target.re}` : to
        push('message.synced', { id: target.id, thread: target.thread, target: to, external: { thread: external, message: `${target.id}.9` } })
      } else if (kind === 'files') push('message.files_synced', { id: target.id, thread: target.thread, target: r.pick(['slack:C1', 'slack:C9']), files: r.chance(0.2) ? null : ['F1'] })
      else {
        const to = r.pick(['slack:C1', 'github:o/r:7', 'slack:C1'])
        push('thread.synced', { thread: target.thread, target: to, cause: 'request', by: author, ...(r.chance(0.5) ? { kind: to.split(':').length > 2 ? 'thread' : 'channel' } : {}) })
      }
    }
  }
  return events
}

/** The board as the old full-state fold saw it, through `index`. */
function fold(events: readonly BoardEvent[], index = Infinity) {
  const messages: MessagesState = { byId: {}, replies: {} }
  const actors: ActorsState = { byId: {}, byHandle: {} }
  const sync: SyncState = { threads: {}, byExternalThread: {}, copies: {}, byExternalMessage: {} }
  for (const event of events) {
    if (event.index > index) break
    foldMessages(messages, event)
    foldActors(actors, event)
    foldSync(sync, event)
  }
  return { messages, actors, sync }
}

/** `/messages` and `/threads` as they were computed over the full state. */
function expectedMessages(state: MessagesState, matches: (m: Message | undefined) => boolean, page: { before?: number; after?: number; limit: number }) {
  let found = Object.values(state.byId).filter(matches).sort((a, b) => a.id - b.id)
  if (page.before !== undefined) found = found.filter((m) => m.id < page.before!)
  return page.after !== undefined ? found.filter((m) => m.id > page.after!).slice(0, page.limit) : found.slice(-page.limit)
}
/** Threads whose root matches, by the root's ID, each with its summary: what `roots` answers, over the full state. */
function expectedRoots(state: MessagesState, matches: (m: Message | undefined) => boolean, page: { before?: number; after?: number; limit: number }) {
  return expectedMessages(state, (m) => m !== undefined && m.re === null && matches(m), page).map((root) => {
    const replies = (state.replies[root.id] ?? []).map((reply) => state.byId[reply]!).filter((reply) => !reply.deleted)
    return { root, replies: replies.length, last: replies.at(-1) ?? null }
  })
}
function expectedThreads(state: MessagesState, matches: (m: Message | undefined) => boolean, page: { after?: number; limit: number }) {
  const roots = new Set<number>()
  for (const message of Object.values(state.byId)) if (matches(message)) roots.add(message.re ?? message.id)
  let found = [...roots].map((id) => {
    const replies = (state.replies[id] ?? []).map((reply) => state.byId[reply]!).filter((reply) => !reply.deleted)
    const last = replies.at(-1) ?? null
    return { root: state.byId[id]!, replies: replies.length, last, at: last?.id ?? id }
  })
  found.sort((a, b) => a.at - b.at)
  found = page.after !== undefined ? found.filter((t) => t.at > page.after!).slice(0, page.limit) : found.slice(-page.limit)
  return found.map(({ root, replies, last }) => ({ root, replies, last }))
}

const FILTERS: ParsedFilters[] = [
  {},
  { channel: 'dev' },
  { channel: 'dev/' },
  { channel: 'dev_x' },
  { channel: 'constructor' },
  { by: 'ada' },
  { by: 'ada/claude' },
  { by: 'sam' },
  { mentions: 'bo' },
  { mentions: 'me' },
  { mentions: 'ada' },
  { mentions: 'ada/claude' },
  { mentions: 'vercel:user:u_bo' },
  { mentions: 'bo@vercel.com' },
  { mentions: 'nobody' },
  { from: 'board' },
  { from: 'slack' },
  { text: 'pr #1' },
  { text: 'éclair' },
  { text: '100%' },
  { text: 'a_b' },
  { label: [['kind', null]] },
  { label: [['kind', ['bug']]] },
  { label: [['kind', ['bug', 'feature']], ['pr', null]] },
  { label: [['tag.x', ['y']]], channel: 'dev/' },
  { label: [['constructor', null]] },
  { by: 'ada', label: [['pr', ['1']]], text: 'fix' },
  // A task's state is a label the fold writes: the tables index it as any other.
  { label: [['board.task', null]] },
  { label: [['board.task', ['ready', 'claimed']]] },
  { label: [['board.task', ['waiting', 'blocked', 'completed', 'failed', 'canceled']]], channel: 'dev/' },
]

/**
 * The conformance suite: every backend of the tables answers exactly as the
 * full-state fold does, for random histories, every filter, and every way a
 * writer and the consumer can take turns. A new backend joins `BACKENDS`.
 */
function conformance(open: () => Promise<MessageTables>) {
  async function applied(events: readonly BoardEvent[]): Promise<MessageTables> {
    const tables = await open()
    for (const event of events) await tables.apply(event)
    return tables
  }

  it.each([1, 2, 3])('agree with the full-state fold on every message, thread, and version (history %i)', async (seed) => {
    const events = history(seed, 400)
    const tables = await applied(events)
    const { messages } = fold(events)
    expect(await tables.position()).toBe(events.length)
    for (const message of Object.values(messages.byId)) expect(await tables.message(message.id)).toEqual(message)
    for (const root of Object.values(messages.byId).filter((m) => m.re === null)) {
      const expected = [root, ...(messages.replies[root.id] ?? []).map((id) => messages.byId[id]!)]
      expect(await tables.thread(root.id)).toEqual(expected)
      expect(await tables.byEventId(root.thread)).toEqual(root)
    }
    for (const index of [10, 57, 200, 333]) {
      const then = fold(events, index).messages
      const ids = Object.keys(messages.byId).map(Number)
      const at = await tables.messagesAt(ids, index)
      expect(Object.fromEntries(at)).toEqual(then.byId)
    }
    await tables.close()
  })

  it.each([4, 5])('answer /messages and /threads like the in-memory filter, for every filter and page (history %i)', async (seed) => {
    const events = history(seed, 400)
    const tables = await applied(events)
    const { messages, actors } = fold(events)
    const me = { id: 'vercel:user:u_bo', handle: 'bo' }
    for (const filters of FILTERS) {
      const matches = compileFilter(filters, { me, actors, messages, access: FULL_ACCESS })
      const filter = toMessageFilter(filters, { me, actors, access: FULL_ACCESS })
      for (const page of [{ limit: 50 }, { limit: 7, after: 120 }, { limit: 7, before: 300 }, { limit: 500 }]) {
        const got = await tables.messages(filter, page)
        expect(got.messages, JSON.stringify({ filters, page })).toEqual(expectedMessages(messages, matches, page))
        expect(got.position).toBe(events.length)
        const threadPage = { limit: page.limit, ...(page.after !== undefined ? { after: page.after } : {}) }
        const threads = await tables.threads(filter, threadPage)
        expect(threads.threads, JSON.stringify({ filters, page: threadPage })).toEqual(expectedThreads(messages, matches, threadPage))
      }
    }
    await tables.close()
  })

  it.each([4, 6])('list roots that match by their own ID, each with its thread\'s summary, for every filter and page (history %i)', async (seed) => {
    const events = history(seed, 400)
    const tables = await applied(events)
    const { messages, actors } = fold(events)
    const me = { id: 'vercel:user:u_bo', handle: 'bo' }
    for (const filters of FILTERS) {
      const matches = compileFilter(filters, { me, actors, messages, access: FULL_ACCESS })
      const filter = toMessageFilter(filters, { me, actors, access: FULL_ACCESS })
      for (const page of [{ limit: 50 }, { limit: 7, after: 0 }, { limit: 7, after: 120 }, { limit: 7, before: 300 }, { limit: 500 }]) {
        const got = await tables.roots(filter, page)
        expect(got.threads, JSON.stringify({ filters, page })).toEqual(expectedRoots(messages, matches, page))
        expect(got.position).toBe(events.length)
      }
    }
    // Roots only, and enough of them with replies that a summary is more than a root.
    const all = (await tables.roots({}, { limit: 500 })).threads
    expect(all.every((thread) => thread.root.re === null)).toBe(true)
    expect(all.filter((thread) => thread.replies > 0 && thread.last !== null).length).toBeGreaterThan(10)
    await tables.close()
  })

  it('keep each task on its root as the full-state fold does, in every state a task has', async () => {
    const seen = new Set<string>()
    const timed = new Set<string>()
    // Three histories that between them leave tasks in every state: one alone reaches five or six.
    for (const seed of [2, 3, 5]) {
      const events = history(seed, 400)
      const tables = await applied(events)
      const { messages } = fold(events)
      const tasks = Object.values(messages.byId).filter((m) => m.task)
      // The history made tasks, and moved them: there's something here to disagree about.
      expect(tasks.length, `history ${seed}`).toBeGreaterThanOrEqual(8)
      expect(new Set(tasks.map((m) => m.task!.state)).size, `history ${seed}`).toBeGreaterThanOrEqual(4)
      for (const message of tasks) {
        seen.add(message.task!.state)
        expect(message.re).toBeNull()
        const stored = await tables.message(message.id)
        expect(stored?.task, `history ${seed}, #${message.id}`).toEqual(message.task)
        // The label is the state, on every root that's still there, and on none that's gone.
        expect(stored?.labels['board.task'], `history ${seed}, #${message.id}`).toBe(message.deleted ? undefined : message.task!.state)
      }
      const labeled = (await tables.roots({ labels: [{ key: 'board.task', values: null }] }, { limit: 500 })).threads.map((thread) => thread.root.id)
      expect(labeled).toEqual(tasks.filter((m) => !m.deleted).map((m) => m.id).sort((a, b) => a - b))
      // Some were claimed more than once, so a later epoch's writes were folded too.
      expect(Math.max(...tasks.map((m) => m.task!.epoch)), `history ${seed}`).toBeGreaterThanOrEqual(2)
      // And some came to wait for other tasks than they were made with, or for none.
      const made = new Map(events.flatMap((event) => (event.type === 'task.created' ? [[event.payload.id, JSON.stringify(event.payload.needs)] as const] : [])))
      expect(tasks.filter((m) => made.get(m.id) !== JSON.stringify(m.task!.needs)).length, `history ${seed}`).toBeGreaterThanOrEqual(1)
      // And some waited for a time, made with one or given one, and had it taken off.
      if (tasks.some((m) => m.task!.notBefore)) timed.add('kept')
      for (const event of events) if (event.type === 'task.not_before_changed') timed.add(event.payload.notBefore ? 'given' : 'taken off')
      await tables.close()
    }
    expect([...seen].sort()).toEqual(['blocked', 'canceled', 'claimed', 'completed', 'failed', 'ready', 'waiting'])
    expect([...timed].sort()).toEqual(['given', 'kept', 'taken off'])
  })

  it('let a writer apply only the very next event, never ahead of a gap', async () => {
    const events = history(7, 200)
    const tables = await open()
    // A fresh board has no position yet: the consumer starts it, from the first event.
    expect(await tables.applyNext(events[0]!)).toBe(false)
    for (const event of events.slice(0, 50)) await tables.apply(event)
    expect(await tables.applyNext(events[52]!)).toBe(false) // #51 isn't applied yet
    expect(await tables.position()).toBe(50)
    expect(await tables.applyNext(events[50]!)).toBe(true)
    expect(await tables.applyNext(events[50]!)).toBe(false) // already applied
    // Writers and the consumer take turns, in any mix; the tables end up the same.
    for (const event of events.slice(51)) {
      if (event.index % 3 === 0) expect(await tables.applyNext(event)).toBe(true)
      else await tables.apply(event)
      await tables.apply(event) // the consumer, after the writer: a no-op
    }
    const { messages } = fold(events)
    for (const message of Object.values(messages.byId)) expect(await tables.message(message.id)).toEqual(message)
    await tables.close()
  })

  it.each([8, 9])('keep the sync state the full-state fold keeps (history %i)', async (seed) => {
    const events = history(seed, 400)
    const tables = await applied(events)
    const { sync } = fold(events)
    expect(Object.keys(sync.threads).length).toBeGreaterThan(10)
    for (const [key, thread] of Object.entries(sync.threads)) expect(await tables.syncOf(key)).toEqual(thread)
    expect(await tables.syncOf('no-such-thread')).toBeNull()
    for (const [external, thread] of Object.entries(sync.byExternalThread)) expect(await tables.threadOf(external)).toBe(thread)
    expect((await tables.externalThreads()).sort()).toEqual(Object.keys(sync.byExternalThread).sort())
    const ids = events.filter((e) => e.type === 'message.posted').map((e) => e.index)
    const copies = await tables.copiesOf(ids)
    expect(Object.fromEntries([...copies].map(([id, byTarget]) => [String(id), byTarget]))).toEqual(sync.copies)
    for (const [key, message] of Object.entries(sync.byExternalMessage)) {
      const at = key.lastIndexOf('|')
      expect(await tables.messageOf(key.slice(0, at), key.slice(at + 1))).toBe(message)
    }
    await tables.close()
  })

  it.each([7, 8])('answer a reader of some channels only with what it reads, for every filter (history %i)', async (seed) => {
    const events = history(seed, 400)
    const tables = await applied(events)
    const { messages, actors } = fold(events)
    const known = [...new Set(Object.values(messages.byId).map((m) => m.channel))]
    const grants: Can[] = [{ dev: ['read'] }, { 'dev/': ['read'] }, { dev_x: ['read'], ops: ['read'] }, { nowhere: ['read'] }]
    for (const can of grants) {
      const access = compileAccess(can)
      for (const filters of FILTERS) {
        const matches = compileFilter(filters, { me: null, actors, messages, access })
        const filter = readableFilter(toMessageFilter(filters, { me: null, actors, access }), known, access)
        const expected = expectedMessages(messages, matches, { limit: 500 })
        const got = filter.channels?.length === 0 ? [] : (await tables.messages(filter, { limit: 500 })).messages
        expect(got, JSON.stringify({ can, filters })).toEqual(expected)
        const threads = filter.channels?.length === 0 ? [] : (await tables.threads(filter, { limit: 50 })).threads
        expect(threads, JSON.stringify({ can, filters })).toEqual(expectedThreads(messages, matches, { limit: 50 }))
      }
    }
    await tables.close()
  })

  it('find the messages that carry a file, and none once deleted', async () => {
    const events = history(9, 400)
    const tables = await applied(events)
    const { messages } = fold(events)
    for (const id of FILES) {
      const carrying = Object.values(messages.byId).filter((m) => m.attachments.some((file) => file.id === id)).sort((a, b) => a.id - b.id)
      expect(carrying.length).toBeGreaterThan(0)
      expect(await tables.withAttachment(id)).toEqual(carrying)
    }
    expect(await tables.withAttachment('f_none')).toEqual([])
    await tables.close()
  })

  it('apply a message with more labels than SQLite binds in one statement', async () => {
    const by = AUTHORS[0]
    const labels = Object.fromEntries(Array.from({ length: 11_000 }, (_, i) => [`k${i}`, 'v']))
    const events = [
      { type: 'message.posted', id: 'p', payload: { channel: 'dev', text: 'many', re: null, replyTo: null, thread: 'p', labels: {}, noSync: false, by, origin: null, from: null } },
      { type: 'labels.changed', id: 'l', payload: { id: 1, thread: 'p', by, set: labels, unset: [] } },
    ].map((event, i) => ({ ...event, index: i + 1, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString() }) as unknown as BoardEvent)
    const tables = await applied(events)
    expect(await tables.position()).toBe(2)
    expect(await tables.message(1)).toEqual(fold(events).messages.byId[1])
    expect((await tables.messages({ labels: [{ key: 'k10999', values: ['v'] }] }, { limit: 5 })).messages.map((m) => m.id)).toEqual([1])
    await tables.close()
  }, 60_000)

  it('apply an event that holds NUL or a lone surrogate, and still find it', async () => {
    // The board refuses both now; a log from before may hold them, and a script or a jsonb that can't take one would stop the tables.
    const by = AUTHORS[0]
    const odd = 'a\u0000b \ud800 c\udc00'
    const events = [
      { type: 'message.posted', id: `p${odd}`, payload: { channel: 'dev', text: `naïve ${odd}`, re: null, replyTo: null, thread: `p${odd}`, labels: { kind: odd }, noSync: false, by, origin: { channel: 'slack:C9', thread: `slack:C9:${odd}`, subthread: null, message: `${odd}.0`, context: null }, from: 'slack' } },
      { type: 'message.posted', id: 'r', payload: { channel: 'dev', text: odd, re: 1, replyTo: null, thread: `p${odd}`, labels: {}, noSync: false, by, origin: null, from: null } },
      { type: 'labels.changed', id: 'l', payload: { id: 1, thread: `p${odd}`, by, set: { tag: odd }, unset: [] } },
      { type: 'thread.synced', id: 's', payload: { thread: `p${odd}`, target: `slack:C1:${odd}`, cause: 'request', by } },
      { type: 'message.synced', id: 'd', payload: { id: 2, thread: `p${odd}`, target: `slack:C1:${odd}`, external: { thread: `slack:C1:${odd}`, message: `${odd}.9` } } },
      { type: 'message.deleted', id: 'x', payload: { id: 2, thread: `p${odd}`, by, from: null } },
    ].map((event, i) => ({ ...event, index: i + 1, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString() }) as unknown as BoardEvent)
    const tables = await applied(events)
    const { messages } = fold(events)
    expect(await tables.position()).toBe(events.length)
    for (const message of Object.values(messages.byId)) expect(await tables.message(message.id)).toEqual(message)
    expect(await tables.byEventId(`p${odd}`)).toEqual(messages.byId[1])
    expect(await tables.threadOf(`slack:C9:${odd}`)).not.toBeNull()
    expect((await tables.messages({ text: 'naïve' }, { limit: 10 })).messages.map((m) => m.id)).toEqual([1])
    expect((await tables.threads({ labels: [{ key: 'kind', values: null }] }, { limit: 10 })).threads.map((t) => t.root.id)).toEqual([1])
    await tables.close()
  })

  it('apply each event once, however many times it is handed over', async () => {
    const events = history(6, 120)
    const tables = await open()
    for (const event of events) {
      await tables.apply(event)
      await tables.apply(event)
    }
    // A stale attempt, handed an earlier event after later ones landed, changes nothing.
    await tables.apply(events[50]!)
    const { messages } = fold(events)
    for (const message of Object.values(messages.byId)) expect(await tables.message(message.id)).toEqual(message)
    await tables.close()
  })
}

/** A store's tables, which close the whole store. */
const tablesOf = (store: BoardStore): MessageTables => ({ ...store.tables, close: () => store.close() })
const dir = mkdtempSync(join(tmpdir(), 'board-tables-'))
let opened = 0

/** The tables as a local board keeps them: SQLite in a file, or `memory()`. */
const BACKENDS: { name: string; open: () => Promise<MessageTables>; enabled: boolean }[] = [
  { name: 'SQLite, in a file', open: async () => tablesOf(sqlite({ path: join(dir, `${++opened}.db`) })), enabled: true },
  { name: 'memory()', open: async () => tablesOf(memory()), enabled: true },
]

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("a message's version", () => {
  const by = AUTHORS[0]
  const event = (index: number, type: string, payload: object) =>
    ({ index, id: `e${index}`, type, createdAt: '2026-10-01T00:00:00.000Z', payload: { id: 5, thread: 'e5', ...payload } }) as unknown as BoardEvent
  const receipt = (index: number) => event(index, 'message.synced', { target: 'slack:C1', external: { thread: 'slack:C1:5', message: '5.9' } })

  it('is the last event that changed it, and an event that changes nothing writes nothing', () => {
    const state: MessagesState = { byId: {}, replies: {} }
    foldMessages(state, { ...event(5, 'message.posted', {}), payload: {
      channel: 'dev', text: 'hi', re: null, replyTo: null, thread: 'e5', labels: {}, noSync: false, by, origin: null, from: null,
    } } as BoardEvent)
    expect(state.byId[5]!.version).toBe(5)
    const react = event(6, 'reaction.added', { emoji: 'eyes', by, from: null })
    foldMessages(state, react)
    expect(state.byId[5]!.version).toBe(6)

    // Most receipts are for a delivery that never failed, and a reaction can come twice.
    for (const same of [receipt(7), { ...react, index: 8, id: 'e8' }]) {
      const before = structuredClone(state.byId[5]!)
      expect(project({ message: before, root: undefined }, same)).toEqual({})
      foldMessages(state, same)
      expect(state.byId[5]).toEqual(before)
    }

    foldMessages(state, event(9, 'message.sync_failed', { target: 'slack:C1', error: 'not_in_channel' }))
    foldMessages(state, receipt(10))
    expect(state.byId[5]).toMatchObject({ version: 10, undelivered: {} })
  })
})

describe('the SQL tables', () => {
  it('index the mentions in a message text on a board written when they were the actor IDs a write resolved', async () => {
    const by = AUTHORS[0]
    const path = join(dir, 'mentions-before-text.db')
    const posted = (index: number, text: string) =>
      ({ index, id: `p${index}`, type: 'message.posted', createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(), payload: { channel: 'dev', text, re: null, replyTo: null, thread: `p${index}`, labels: {}, noSync: false, mentions: ['vercel:user:u_sam'], by, origin: null, from: null } }) as unknown as BoardEvent
    // Written as boards were: each mention as the actor ID it resolved to, and no record of reindexing.
    const old = sqlite({ path })
    for (const event of [posted(1, '@sam can you look?'), posted(2, 'over to @sam/claude'), posted(3, 'nothing here')]) await old.tables.apply(event)
    await old.close()
    const raw = sqliteDb(path)
    await raw.commit({ text: 'select 1 as claimed', values: [] }, [
      { text: "update board_terms set value = 'vercel:user:u_sam' where term = '@'", values: [] },
      { text: 'drop table board_meta', values: [] },
    ])
    await raw.close()

    const upgraded = sqlite({ path })
    const found = async (terms: string[], prefixes: string[] = []) => (await upgraded.tables.messages({ mentions: { terms, prefixes } }, { limit: 10 })).messages.map((m) => m.text)
    // A caller that can't read every channel matches what it names as written.
    expect(await found(['sam'], ['sam/'])).toEqual(['@sam can you look?', 'over to @sam/claude'])
    expect(await found(['vercel:user:u_sam'])).toEqual([])
    expect((await upgraded.tables.threads({ mentions: { terms: ['sam'], prefixes: [] } }, { limit: 10 })).threads.map((t) => t.root.text)).toEqual(['@sam can you look?'])
    await upgraded.close()
  })

  it("never fold a writer's event onto what it read before the event ahead of it landed", async () => {
    const by = AUTHORS[0]
    const at = (index: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString()
    const events = [
      { type: 'message.posted', id: 'p', payload: { channel: 'dev', text: 'secret', re: null, replyTo: null, thread: 'p', labels: {}, noSync: false, by, origin: null, from: null } },
      { type: 'message.deleted', id: 'd', payload: { id: 1, thread: 'p', by, from: null } },
      { type: 'labels.changed', id: 'l', payload: { id: 1, thread: 'p', by, set: { kind: 'bug' }, unset: [] } },
    ].map((event, i) => ({ ...event, index: i + 1, createdAt: at(i) }) as unknown as BoardEvent)
    const db = sqliteDb(':memory:')
    const consumer = sqlTables(db)
    await consumer.apply(events[0]!)
    // The consumer lands the delete right after the writer's first read.
    let ahead: (() => Promise<void>) | null = () => consumer.apply(events[1]!)
    const writer = sqlTables({
      ...db,
      async all(query) {
        const rows = await db.all(query)
        const land = ahead
        ahead = null
        await land?.()
        return rows
      },
    })
    if (!(await writer.applyNext(events[2]!))) await consumer.apply(events[2]!)
    expect(await consumer.message(1)).toEqual(fold(events).messages.byId[1])
    await consumer.close()
  })
})

for (const backend of BACKENDS) describe.skipIf(!backend.enabled)(`the tables on ${backend.name}`, () => conformance(backend.open))
