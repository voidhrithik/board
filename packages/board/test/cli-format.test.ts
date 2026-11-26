import { describe, expect, it } from 'vitest'
import { claimLine, formatEvent, formatMessage, formatSchedule, formatTasks, formatThreads, formatThreadSummaries, principalFlags } from '../src/cli/format.ts'
import type { BoardEventView, MessageView, ScheduleView, TaskView } from '../src/api/routes.ts'

const by = { actor: 'vercel:user:j', principal: 'vercel:user:j', profile: null }
const author = { kind: 'person', handle: 'julian', name: 'Julian', avatar: null } as unknown as MessageView['author']
const file = { id: 'nXHY', name: 'after.png', type: 'image/png', size: 17_000 }
const pictograph = /\p{Extended_Pictographic}/u

describe('CLI output has no emoji', () => {
  it('a scheduled message with a file', () => {
    const message = {
      id: 812, channel: 'dev', text: 'hi', re: null, replyTo: null, thread: 't', labels: {}, reactions: {}, by,
      noSync: false, origin: null, from: null, createdAt: new Date().toISOString(), editedAt: null, deleted: false,
      undelivered: {}, attachments: [file], links: [], schedule: { id: 's12', n: 0 }, author,
    } as unknown as MessageView
    const out = formatMessage(message)
    expect(out).not.toMatch(pictograph)
    expect(out).toMatch(/^#812  Julian · \d+s · scheduled s12\n/)
    expect(out).toContain('      file after.png · image/png · ')
  })

  it('a schedule', () => {
    const schedule = {
      id: 's12', channel: 'dev', re: null, text: 'ping', labels: {}, noSync: false, attachments: [file, file], first: '',
      every: null, until: null, times: null, sent: 0, next: new Date(Date.now() + 120_000).toISOString(), last: null,
      state: 'pending', canceled: null, by, author, createdAt: '',
    } as unknown as ScheduleView
    const out = formatSchedule(schedule)
    expect(out).not.toMatch(pictograph)
    expect(out).toMatch(/^s12  new thread in dev · once · next in 2m \(.+\) · 2 files · by Julian\n    ping$/)
    // An ID is shown as the board gave it: Vercel's are already `sch_…`.
    expect(formatSchedule({ ...schedule, id: 'sch_0eec95f5' })).toMatch(/^sch_0eec95f5  new thread in dev /)
  })
})

describe('read <channel>', () => {
  it("cuts a root's first line to fit 80 columns, and marks that more follows", () => {
    const root = (text: string) =>
      ({
        id: 812, channel: 'dev', text, re: null, labels: {}, reactions: {}, by, from: null,
        createdAt: new Date().toISOString(), deleted: false, attachments: [], author,
      }) as unknown as MessageView
    const shown = (text: string) => formatThreadSummaries([{ message: root(text), replies: 0, last: null }]).split('\n')[1]!
    for (const text of ['x'.repeat(73) + '\nmore', 'x'.repeat(74) + '\nmore', 'x'.repeat(200)]) expect(shown(text)).toBe(`      ${'x'.repeat(73)}…`)
    expect(shown('x'.repeat(74))).toBe(`      ${'x'.repeat(74)}`)
    expect(shown('flaky test\r\nsecond line')).toBe('      flaky test …')
  })

  it("counts the root's reactions under its text, and shows nothing for none", () => {
    const root = (reactions: Record<string, string[]>) =>
      ({
        id: 812, channel: 'dev', text: 'deploys are green', re: null, labels: {}, reactions, by, from: null,
        createdAt: new Date().toISOString(), deleted: false, attachments: [], author,
      }) as unknown as MessageView
    const lines = (reactions: Record<string, string[]>) => formatThreadSummaries([{ message: root(reactions), replies: 0, last: null }]).split('\n')
    expect(lines({ '+1': ['vercel:user:a', 'vercel:user:b'], eyes: ['vercel:user:a'] }).slice(1)).toEqual(['      deploys are green', '      👍 2   👀 1', '      no replies'])
    expect(lines({}).slice(1)).toEqual(['      deploys are green', '      no replies'])
  })
})

describe('reactions', () => {
  it('name the first three, count the rest, and use names from outside the thread', () => {
    const reactors = Array.from({ length: 12 }, (_, n) => `vercel:user:u${n}`)
    const message = {
      id: 812, channel: 'dev', text: 'hi', re: null, labels: {}, reactions: { eyes: reactors, tada: [by.actor] }, by,
      from: null, createdAt: new Date().toISOString(), deleted: false, attachments: [], author,
    } as unknown as MessageView
    const out = formatThreads([message], new Map([['vercel:user:u0', 'Ada'], ['vercel:user:u1', 'claude via ada']]))
    expect(out.split('\n').at(-1)).toMatch(/^      \S+ Ada, claude via ada, vercel:user:u2 \+9   \S+ Julian$/)
  })
})

describe('grants', () => {
  it("lists an app by the name the board knows it by, or else its client ID, so two apps don't look alike", () => {
    expect(principalFlags({ kind: 'app', clientId: 'oac_1', name: 'ship' })).toBe('--app ship')
    expect(principalFlags({ kind: 'app', clientId: 'cl_ship', name: null })).toBe('--app cl_ship')
  })
})

describe('tasks', () => {
  const now = Date.parse('2026-03-01T12:00:00.000Z')
  const at = (ms: number) => new Date(now + ms).toISOString()
  const holder = 'vercel:user:j+claude'
  const task = (about: Partial<TaskView>): TaskView =>
    ({ state: 'ready', owner: by.principal, for: null, needs: [], epoch: 1, claim: null, blocked: null, result: null, reason: null, due: null, ...about }) as unknown as TaskView
  const root = (text: string, about: Partial<TaskView>, labels: Record<string, string> = {}) =>
    ({
      id: 812, channel: 'work', text, re: null, labels: { ...labels, 'board.task': about.state ?? 'ready' }, reactions: {}, by, from: null,
      createdAt: at(-60_000), deleted: false, attachments: [], author, task: task(about),
    }) as unknown as MessageView
  const names = new Map([[holder, 'claude via julian']])
  const row = (about: Partial<TaskView>, when = now) => formatMessage(root('fix CVE-123 in acme/web', about), { names, now: when }).split('\n').at(-1)

  it('say how long a claim has left, to the second under a minute, and that a lease ran out once it has', () => {
    const claimed = (until: string) => ({ state: 'claimed' as const, claim: { actor: holder, until } })
    expect(row(claimed(at(12 * 60_000 + 20_000)))).toBe('      task  claimed by claude via julian · 12m left')
    expect(row(claimed(at(44_200)))).toBe('      task  claimed by claude via julian · 45s left')
    // A claim whose lease has passed is over, though the board hasn't said the task is ready yet.
    expect(row(claimed(at(-1)))).toBe('      task  claimed by claude via julian · its lease ran out')
    // Someone the reader has no name for shows by their ID, never as nobody.
    expect(formatMessage(root('x', claimed(at(60_000))), { now }).split('\n').at(-1)).toBe(`      task  claimed by ${holder} · 1m left`)
    expect(claimLine(root('fix CVE-123 in acme/web', claimed(at(900_000))), at(900_000), now + 400)).toBe('#812  yours for 15m  fix CVE-123 in acme/web')
    expect(claimLine(root('fix CVE-123 in acme/web', claimed(at(30_000))), at(30_000), now + 400)).toBe('#812  yours for 30s  fix CVE-123 in acme/web')
  })

  it('list one a row in 80 columns: a long first line is cut, and how it ended takes the place of its labels', () => {
    const long = 'fix the export that times out past ten thousand rows in acme/web'
    const listed = formatTasks([
      { message: root(long, { state: 'ready' }, { step: 'fix' }), replies: 0, last: null },
      { message: { ...root('deploy it\nto production', { state: 'failed', reason: 'no credentials\nsee the log' }, { step: 'deploy' }), id: '813' }, replies: 2, last: null },
    ]).split('\n')
    expect(listed).toEqual([
      `#812  ready      ${long.slice(0, 39)}…  step=fix`,
      // Columns line up from one row to the next, so the second is padded to the first's width.
      `#813  failed     ${'deploy it …'.padEnd(40)}  no credentials`,
    ])
    for (const line of listed) expect(line.length).toBeLessThanOrEqual(80)
    // A long account of how it ended is cut to what the row has left: the rest is in its thread.
    const reason = 'no production credentials in this sandbox, and none in the vault either'
    const [failed] = formatTasks([{ message: root('deploy acme/web to production', { state: 'failed', reason }, { step: 'deploy' }), replies: 0, last: null }]).split('\n')
    expect(failed).toBe(`#812  failed     deploy acme/web to production   ${reason.slice(0, 30)}…`)
    expect(failed).toHaveLength(80)
  })

  it('say how long until a task is due, or how late it is, while it is open, on its row and under its root', () => {
    const rows = formatTasks(
      [
        { message: root('rotate the deploy keys', { due: at(3 * 86_400_000 + 60_000) }, { step: 'ops' }), replies: 0, last: null },
        { message: { ...root('renew the cert', { state: 'waiting', needs: ['810'], due: at(-2 * 3_600_000) }), id: '813' }, replies: 0, last: null },
        { message: { ...root('ship it', { state: 'completed', due: at(-86_400_000) }), id: '814' }, replies: 0, last: null },
      ],
      now,
    ).split('\n')
    expect(rows).toEqual([
      `#812  ready      ${'rotate the deploy keys'.padEnd(30)}  step=ops  due in 3d`,
      `#813  waiting    ${'renew the cert'.padEnd(30)}  needs #810  2h late`,
      // A finished task's date says nothing any more.
      `#814  completed  ship it`,
    ])
    expect(row({ due: at(45 * 60_000) })).toBe('      task  ready · due in 45m')
    expect(row({ state: 'claimed', claim: { actor: holder, until: at(60_000) }, due: at(-30_000) })).toBe('      task  claimed by claude via julian · 1m left · 30s late')
    expect(row({ state: 'canceled', due: at(-30_000) })).toBe('      task  canceled')
  })

  it('print what the board did to one on its own, and a renewal for whoever follows receipts', () => {
    const message = root('fix CVE-123 in acme/web', { state: 'ready' })
    const actor = { id: holder, kind: 'profile', handle: 'julian/claude', name: 'claude', avatar: null, via: { name: 'julian', environment: null } }
    const event = (type: string, payload: object, who?: object) => ({ cursor: '900', type, createdAt: at(0), payload, message, ...(who ? { actor: who } : {}) }) as unknown as BoardEventView
    // No one ends a lease: the board does, when its time is up.
    expect(formatEvent(event('task.expired', { message: '812', epoch: 1 }))).toBe('#812  work  task lease ran out')
    expect(formatEvent(event('task.renewed', { message: '812', epoch: 1, until: at(900_000) }, actor))).toBe('#812  work  task renewed by claude via julian')
    // What a task waits for, changed: the ones it waits for now, or that it waits for nothing.
    expect(formatEvent(event('task.needs_changed', { id: '812', needs: ['810', '811'] }, actor))).toBe('#812  work  task needs #810 #811 by claude via julian')
    expect(formatEvent(event('task.needs_changed', { id: '812', needs: [] }, actor))).toBe('#812  work  task needs nothing by claude via julian')
    // When it's due, changed: the time, to the minute when that's all it has, or that it has none.
    expect(formatEvent(event('task.due_changed', { id: '812', due: '2026-12-01T17:00:00.000Z' }, actor))).toBe('#812  work  task due 2026-12-01T17:00Z by claude via julian')
    expect(formatEvent(event('task.due_changed', { id: '812', due: '2026-12-01T17:00:30.000Z' }, actor))).toBe('#812  work  task due 2026-12-01T17:00:30.000Z by claude via julian')
    expect(formatEvent(event('task.due_changed', { id: '812', due: null }, actor))).toBe('#812  work  task no due date by claude via julian')
  })
})

