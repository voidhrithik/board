import { describe, expect, it, vi } from 'vitest'
import type { BoardEventView, MessageView } from '../src/api/routes.ts'
import type { Middleware, Watcher } from '../src/server/index.ts'
import { block } from '../src/contract/blocks.ts'
import { http } from '../src/backend-http/index.ts'
import { board as projectBoard, BOARD_URL, caller, personToken, testBoard, workflowToken } from './harness.ts'
import { fakeQueue } from './queue.ts'

// Several tasks made in one write, on a local board: `POST /tasks/batch`, and `tasks.createMany` on a handle.

const ADA = 'vercel:user:u_ada'
/** acme/web's workflows: let in only where a test grants them. */
const CI = 'github:repo:123456'

type Call = ReturnType<typeof caller>
type Asked = { key?: string; text: string; labels?: Record<string, string>; noSync?: boolean; attachments?: string[]; needs?: (string | { key: string })[]; for?: string | null; priority?: number }

async function setup(options: Parameters<typeof testBoard>[0] = {}) {
  const board = testBoard({ scheduler: fakeQueue().scheduler, ...options })
  return { board, ada: caller(board.fetch, await personToken('u_ada')), bo: caller(board.fetch, await personToken('u_bo')) }
}

const code = (answer: { status: number; body: any }) => [answer.status, answer.body?.error?.code]
/** A handle on `board` as a person, to upload as the CLI and agents do: a board of its own in front of it, with `middleware` when it has any. */
const handleAs = (board: ReturnType<typeof testBoard>, user: string, middleware: Middleware[] = []) =>
  projectBoard({
    middleware,
    backend: http(BOARD_URL, {
      fetch: async (input, init) => {
        const request = new Request(input, init)
        request.headers.set('authorization', `Bearer ${await personToken(user)}`)
        return board.fetch(request)
      },
    }),
  }).as(null)
const batch = (call: Call, tasks: Asked[], more: Record<string, unknown> = {}) => call('POST', '/tasks/batch', { channel: 'work', tasks, ...more })
const listed = async (call: Call, query = 'channel=work&state=all&limit=500'): Promise<MessageView[]> => (await call('GET', `/tasks?${query}`)).body.tasks.map((task: { message: MessageView }) => task.message)
const events = async (call: Call, after: string): Promise<BoardEventView[]> => (await call('GET', `/events?after=${after}`)).body.events
const cursorOf = async (call: Call): Promise<string> => (await call('GET', '/events')).body.cursor
/** A task that was there and has completed. */
async function completed(call: Call, text: string): Promise<MessageView> {
  const made = (await call('POST', '/tasks', { channel: 'work', text, claim: true })).body
  return (await call('POST', `/tasks/${made.task.id}/complete`, { epoch: made.claim.epoch, token: made.claim.token })).body.task
}

describe('several tasks made at once', () => {
  it('land in one write, in the order given: each waits for the ones it names by key, wherever they come, and is ready at once only when all it needs was there and has completed', async () => {
    const { ada } = await setup()
    const cut = await completed(ada, 'cut the release branch')
    const frozen: MessageView = (await ada('POST', '/tasks', { channel: 'work', text: 'freeze the schema' })).body.task
    const before = await cursorOf(ada)
    const made = await batch(ada, [
      { key: 'review', text: 'review the fix', needs: [{ key: 'fix' }] },
      { key: 'fix', text: 'fix the export', labels: { step: 'fix' }, noSync: true },
      { text: 'announce the release', needs: [cut.id] },
      { text: 'ship it', needs: [cut.id, { key: 'review' }, { key: 'fix' }], for: `${ADA}+shipper` },
      { text: 'migrate the data', needs: [cut.id, frozen.id] },
    ])
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const [review, fix, announce, ship, migrate] = made.body.tasks as MessageView[]
    expect((made.body.tasks as MessageView[]).map((root) => [root.text, root.task?.state, root.task?.needs, root.task?.for, root.task?.owner, root.channel])).toEqual([
      ['review the fix', 'waiting', [fix!.id], null, ADA, 'work'],
      ['fix the export', 'ready', [], null, ADA, 'work'],
      // All it needs was there and done: ready in the same write.
      ['announce the release', 'ready', [cut.id], null, ADA, 'work'],
      // One of the batch's is new, so it waits, though all it needs that was there has completed.
      ['ship it', 'waiting', [cut.id, review!.id, fix!.id], `${ADA}+shipper`, ADA, 'work'],
      // And so does one that needs a task that was there and hasn't.
      ['migrate the data', 'waiting', [cut.id, frozen.id], null, ADA, 'work'],
    ])
    expect([fix!.labels, fix!.noSync, review!.noSync]).toEqual([{ step: 'fix', 'board.task': 'ready' }, true, false])
    // Each is the thread it reads as, and they list in the order given.
    for (const root of made.body.tasks as MessageView[]) expect((await ada('GET', `/messages/${root.id}`)).body.message).toMatchObject({ id: root.id, text: root.text, re: null, task: root.task })
    expect((await listed(ada, 'channel=work')).map((root) => root.text)).toEqual(['freeze the schema', 'review the fix', 'fix the export', 'announce the release', 'ship it', 'migrate the data'])
    // The feed has them one after the other, nothing between: each task's post, what makes it a task, and its ready.
    const found = await events(ada, before)
    expect(found.map((event) => [event.type, event.message?.id])).toEqual([
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
    expect(found.map((event) => Number(event.cursor))).toEqual(found.map((_, at) => Number(found[0]!.cursor) + at))
    // A task of the batch that completes readies what waited only for it, as any task does.
    const held = (await ada('POST', `/tasks/${fix!.id}/claim`, {})).body.claim
    await ada('POST', `/tasks/${fix!.id}/complete`, { epoch: held.epoch, token: held.token })
    expect((await listed(ada, 'channel=work')).map((root) => [root.text, root.task?.state])).toEqual([
      ['freeze the schema', 'ready'],
      ['review the fix', 'ready'],
      ['announce the release', 'ready'],
      ['ship it', 'waiting'],
      ['migrate the data', 'waiting'],
    ])
  })

  it("names each task by where its own post lands, for an author the board hasn't seen write too", async () => {
    // The first write by someone new carries who they are, ahead of the batch's own events.
    const { bo } = await setup()
    const made = await batch(bo, [
      { text: 'draft the plan', needs: [{ key: 'scope' }] },
      { key: 'scope', text: 'scope the work' },
    ])
    expect(made.status).toBe(201)
    const [draft, scope] = made.body.tasks as MessageView[]
    expect(draft!.task?.needs).toEqual([scope!.id])
    expect([(await bo('GET', `/messages/${draft!.id}`)).body.message.text, (await bo('GET', `/messages/${scope!.id}`)).body.message.text]).toEqual(['draft the plan', 'scope the work'])
    expect((await listed(bo)).map((root) => [root.id, root.text, root.task?.state])).toEqual([
      [draft!.id, 'draft the plan', 'waiting'],
      [scope!.id, 'scope the work', 'ready'],
    ])
  })

  it('make none of them when one of them can not be made, wherever it comes in the batch', async () => {
    const { ada } = await setup()
    const canceled: MessageView = (await ada('POST', '/tasks', { channel: 'work', text: 'an idea we dropped' })).body.task
    await ada('POST', `/tasks/${canceled.id}/cancel`, { reason: 'dropped' })
    const note: MessageView = (await ada('POST', '/messages', { channel: 'work', text: 'just a note' })).body.message
    const hidden: MessageView = (await ada('POST', '/tasks', { channel: 'elsewhere', text: 'out of sight' })).body.task
    const before = await cursorOf(ada)
    const fine: Asked[] = [{ key: 'a', text: 'first, and fine' }, { text: 'second, and fine', needs: [{ key: 'a' }] }]
    const refused = async (last: Asked[], why: RegExp, as: Call = ada, where = 'plans') => {
      const answer = await batch(as, [...fine, ...last], { channel: where })
      expect([code(answer), answer.body.error.message], JSON.stringify(last)).toEqual([[400, 'invalid_needs'], expect.stringMatching(why)])
    }
    // How its tasks wait for each other, checked from the batch alone.
    await refused([{ text: 'waits for no one here', needs: [{ key: 'nobody' }] }], /no task of the batch has the key "nobody"/)
    await refused([{ key: 'a', text: 'a second a' }], /two tasks of the batch have the key "a"/)
    await refused([{ key: 'self', text: 'waits for itself', needs: [{ key: 'self' }] }], /waits for itself/)
    await refused(
      [
        { key: 'x', text: 'x waits for z', needs: [{ key: 'z' }] },
        { key: 'y', text: 'y waits for x', needs: [{ key: 'x' }] },
        { key: 'z', text: 'z waits for y', needs: [{ key: 'y' }] },
      ],
      /"x", "z", "y" wait for each other/,
    )
    // What was there, read as the write lands: a canceled task, a thread that is no task, one that isn't there.
    await refused([{ text: 'waits for a canceled one', needs: [canceled.id] }], /was canceled/)
    await refused([{ text: 'waits for a note', needs: [note.id] }], /isn't a task/)
    await refused([{ text: 'waits for nothing there', needs: ['99999'] }], /isn't a task/)
    // One its sender can't read is as much a task as one that isn't there.
    const { board, ada: owner, bo } = await setup()
    const secret: MessageView = (await owner('POST', '/tasks', { channel: 'elsewhere', text: 'out of sight' })).body.task
    await board.createGrant({ principals: [{ kind: 'github', repository: 'acme/web' }], can: { plans: ['read', 'post'] } })
    const workflow = caller(board.fetch, await workflowToken())
    await refused([{ text: 'waits for one it can not read', needs: [secret.id] }], /isn't a task/, workflow)
    expect(await listed(bo, 'channel=plans&state=all')).toEqual([])
    // An assignee that isn't its owner's, and more than a task waits for.
    expect(code(await batch(ada, [...fine, { text: 'for someone else', for: 'vercel:user:u_bo+fixer' }], { channel: 'plans' }))).toEqual([400, 'invalid_request'])
    expect(code(await batch(ada, [...fine, { text: 'waits for 21', needs: Array.from({ length: 21 }, (_, n) => String(n + 1)) }], { channel: 'plans' }))).toEqual([400, 'invalid_request'])
    expect(code(await batch(ada, [...fine, { text: '   ' }], { channel: 'plans' }))).toEqual([400, 'invalid_request'])
    expect(hidden.id).toEqual(expect.any(String))
    // Nothing of any of them: no task, no post, no event, and not the channel they named.
    expect(await listed(ada, 'channel=plans&state=all')).toEqual([])
    expect(await events(ada, before)).toEqual([])
    expect((await ada('GET', '/channels')).body.channels.map((channel: { path: string }) => channel.path)).not.toContain('plans')
  })

  it('answer a retry with the same id with the tasks the first one made, and refuse the id for any other request', async () => {
    const { board, ada, bo } = await setup()
    const file = await handleAs(board, 'u_ada').upload({ data: new TextEncoder().encode('the plan'), name: 'plan.txt', type: 'text/plain' })
    const plan: Asked[] = [
      { key: 'fix', text: 'fix the export' },
      { text: 'review the fix', needs: [{ key: 'fix' }] },
    ]
    const first = await batch(ada, plan, { id: 'release-42' })
    expect(first.status).toBe(201)
    const ids = (first.body.tasks as MessageView[]).map((root) => root.id)
    // Someone claims one of them meanwhile: a retry answers the tasks as they are now, and makes nothing.
    await bo('POST', `/tasks/${ids[0]}/claim`, {})
    const again = await batch(ada, plan, { id: 'release-42' })
    expect([again.status, (again.body.tasks as MessageView[]).map((root) => [root.id, root.task?.state])]).toEqual([201, [[ids[0], 'claimed'], [ids[1], 'waiting']]])
    expect((await listed(ada)).map((root) => root.id)).toEqual(ids)
    // The same batch sent twice at once is made once, and both get it.
    const twice = await Promise.all([batch(ada, plan, { id: 'release-43' }), batch(ada, plan, { id: 'release-43' })])
    expect(twice.map((answer) => answer.status)).toEqual([201, 201])
    expect(twice[1]!.body.tasks.map((root: MessageView) => root.id)).toEqual(twice[0]!.body.tasks.map((root: MessageView) => root.id))
    expect(await listed(ada)).toHaveLength(4)
    // The id names that request: with fewer tasks, with more, with as many but other ones, or the same in another order,
    // in another channel, or from someone else, it's another write's.
    expect(code(await batch(ada, plan.slice(0, 1), { id: 'release-42' }))).toEqual([409, 'duplicate_id'])
    expect(code(await batch(ada, [...plan, { text: 'and one more' }], { id: 'release-42' }))).toEqual([409, 'duplicate_id'])
    for (const [what, other] of Object.entries<Asked[]>({
      'another text': [{ key: 'fix', text: 'fix the import' }, plan[1]!],
      'another key': [{ key: 'repair', text: 'fix the export' }, { text: 'review the fix', needs: [{ key: 'repair' }] }],
      'one more key': [plan[0]!, { ...plan[1]!, key: 'review' }],
      'a need less': [plan[0]!, { text: 'review the fix' }],
      'a label': [plan[0]!, { ...plan[1]!, labels: { step: 'review' } }],
      'a file': [{ ...plan[0]!, attachments: [file.id] }, plan[1]!],
      'kept off platforms': [{ ...plan[0]!, noSync: true }, plan[1]!],
      'an assignee': [{ ...plan[0]!, for: `${ADA}+fixer` }, plan[1]!],
      'a priority': [{ ...plan[0]!, priority: 2 }, plan[1]!],
      'one more need': [plan[0]!, { ...plan[1]!, needs: [{ key: 'fix' }, ids[0]!] }],
      'the other order': [plan[1]!, plan[0]!],
    }))
      expect(code(await batch(ada, other, { id: 'release-42' })), what).toEqual([409, 'duplicate_id'])
    expect(code(await batch(bo, plan, { id: 'release-42' }))).toEqual([409, 'duplicate_id'])
    expect(code(await batch(ada, plan, { id: 'release-42', channel: 'elsewhere' }))).toEqual([409, 'duplicate_id'])
    // A field left out is its empty value: the same request written out in full is the same batch.
    const full = [{ key: 'fix', text: 'fix the export', labels: {}, noSync: false, attachments: [], needs: [], for: null }, { text: 'review the fix', needs: [{ key: 'fix' }], labels: {} }]
    expect((await batch(ada, full, { id: 'release-42' })).body.tasks.map((root: MessageView) => root.id)).toEqual(ids)
    // What's happened to its tasks since is no part of what was asked: an edit, a label, what one waits for now.
    await ada('POST', `/messages/${ids[1]}/edit`, { text: 'review the fix, carefully' })
    await ada('POST', `/messages/${ids[1]}/labels`, { set: { step: 'review' } })
    await ada('POST', `/tasks/${ids[1]}/needs`, { needs: [] })
    const after = await batch(ada, plan, { id: 'release-42' })
    expect([after.status, after.body.tasks.map((root: MessageView) => [root.id, root.text, root.task?.needs])]).toEqual([201, [[ids[0], 'fix the export', []], [ids[1], 'review the fix, carefully', []]]])
    expect(await listed(ada)).toHaveLength(4)
    await ada('POST', `/tasks/${ids[1]}/needs`, { needs: [ids[0]] })
    // An id that is someone else's to write with is refused, as a post's is: the board's own, and another client's key.
    expect(code(await batch(ada, plan, { id: '0f8fad5b-d9cb-8469-a165-70867728950e' }))).toEqual([400, 'invalid_request'])
    expect(code(await batch(ada, plan, { id: 'key:vercel:user:u_bo:0123456789abcdef0123456789abcdef' }))).toEqual([400, 'invalid_request'])
    // A batch's id is its own: a task or a post made with the same one is another thing.
    expect((await ada('POST', '/tasks', { channel: 'work', text: 'a task of its own', id: 'release-42' })).status).toBe(201)
    expect(await listed(ada)).toHaveLength(5)
    // Without one, the same batch again is new tasks.
    await batch(ada, plan)
    await batch(ada, plan)
    expect(await listed(ada)).toHaveLength(9)
    // The batch made under an id is its maker's to find again, as a post is by its own: its tasks as they are now.
    const found = await ada('GET', '/tasks/batch/release-42')
    expect([found.status, found.body.tasks.map((root: MessageView) => [root.id, root.task?.state])]).toEqual([200, [[ids[0], 'claimed'], [ids[1], 'waiting']]])
    expect(code(await ada('GET', '/tasks/batch/release-41'))).toEqual([404, 'batch_not_found'])
    expect(code(await bo('GET', '/tasks/batch/release-42'))).toEqual([404, 'batch_not_found'])
    expect(code(await ada('GET', '/tasks/batch/release-42?request=another'))).toEqual([409, 'duplicate_id'])
  })

  it('answer a retry before the middleware sees it: each root is screened once, whatever it would make of the request now, and what was asked is told as it was given', async () => {
    // A middleware that is never the same twice: it counts what it sees, and stamps each root with the count.
    const saw: string[] = []
    const stamp: Middleware = async ({ write, next }) => {
      saw.push(write.text)
      await next({ text: write.text.toUpperCase(), labels: { seen: String(saw.length) } })
    }
    const { board, ada } = await setup({ middleware: [stamp] })
    const plan: Asked[] = [{ key: 'fix', text: 'fix the export' }, { text: 'review the fix', needs: [{ key: 'fix' }] }]
    const first = await batch(ada, plan, { id: 'release-42' })
    expect([first.status, first.body.tasks.map((root: MessageView) => [root.text, root.labels.seen])]).toEqual([201, [['FIX THE EXPORT', '1'], ['REVIEW THE FIX', '2']]])
    // The same request again gets the tasks that landed, as they landed, and the middleware never hears of it.
    const again = await batch(ada, plan, { id: 'release-42' })
    expect([again.status, again.body.tasks.map((root: MessageView) => [root.id, root.text, root.labels.seen])]).toEqual([201, first.body.tasks.map((root: MessageView) => [root.id, root.text, root.labels.seen])])
    expect(saw).toEqual(['fix the export', 'review the fix'])
    expect(await listed(ada)).toHaveLength(2)
    // Another request under the id is refused as it was given, before the middleware, though it would make the same of both.
    expect(code(await batch(ada, [{ key: 'fix', text: 'FIX THE EXPORT' }, plan[1]!], { id: 'release-42' }))).toEqual([409, 'duplicate_id'])
    expect(saw).toHaveLength(2)
    // One it drops landed nothing, so the same request again is screened again: there was no write to count.
    const picky: Middleware = async ({ write, next }) => void (saw.push(write.text), write.text.includes('password') ? undefined : await next())
    const strict = await setup({ middleware: [picky] })
    saw.length = 0
    const secret: Asked[] = [{ text: 'rotate the key' }, { text: 'the password is hunter2' }]
    expect(code(await batch(strict.ada, secret, { id: 'rotate-1' }))).toEqual([422, 'dropped'])
    expect(code(await batch(strict.ada, secret, { id: 'rotate-1' }))).toEqual([422, 'dropped'])
    expect(saw).toHaveLength(4)
    expect(await listed(strict.ada)).toEqual([])
    // A sender that can't read what it made gets its tasks back from a retry as the write answered them.
    const loud: Middleware = async ({ write, next }) => void (saw.push(write.text), await next({ text: write.text.toUpperCase() }))
    const shouting = await setup({ middleware: [loud] })
    await shouting.board.createGrant({ principals: [{ kind: 'github', repository: 'acme/web' }], can: { intake: ['post'] } })
    const workflow = caller(shouting.board.fetch, await workflowToken())
    saw.length = 0
    const filed = await batch(workflow, [{ text: 'triage the outage' }], { channel: 'intake', id: 'outage-1' })
    const refiled = await batch(workflow, [{ text: 'triage the outage' }], { channel: 'intake', id: 'outage-1' })
    expect([filed.status, refiled.status, refiled.body.tasks]).toEqual([201, 201, filed.body.tasks])
    expect(filed.body.tasks[0]).toMatchObject({ text: 'TRIAGE THE OUTAGE', task: { state: 'ready' } })
    expect((await listed(shouting.ada, 'channel=intake&state=all')).map((root) => root.text)).toEqual(['TRIAGE THE OUTAGE'])
    expect(saw).toEqual(['triage the outage'])
    // The board's own handle is answered the same way: its batch's retry is no second write for the middleware.
    saw.length = 0
    const mine = await board.tasks.createMany('work', plan, { id: 'handle-1' })
    expect((await board.tasks.createMany('work', plan, { id: 'handle-1' })).map((root) => root.id)).toEqual(mine.map((root) => root.id))
    expect(saw).toEqual(['fix the export', 'review the fix'])
  })

  it('are 100 at most on any board: one more is batch_too_large, and makes none', async () => {
    const { ada } = await setup()
    const many = (count: number): Asked[] => Array.from({ length: count }, (_, n) => ({ key: `step-${n}`, text: `step ${n}`, ...(n > 0 ? { needs: [{ key: `step-${n - 1}` }] } : {}) }))
    const over = await batch(ada, many(101))
    expect(over).toEqual({ status: 400, body: { error: { code: 'batch_too_large', message: 'a batch makes 100 tasks at most, and this one has 101: send it in parts' } } })
    expect(await listed(ada)).toEqual([])
    // It's said so whatever else is wrong with it: its sender splits it first.
    expect(code(await batch(ada, [...many(100), { text: '' }]))).toEqual([400, 'batch_too_large'])
    // A batch of 100 of the wrong shape is refused for that, as any request is.
    expect(code(await batch(ada, [...many(99), { text: '' }]))).toEqual([400, 'invalid_request'])
    // Of each task, what one made alone holds is this board's own to say: its text and files as a message's, 20 needs, and a key of 64 characters.
    const one = async (task: Record<string, unknown>) => {
      const answer = await batch(ada, [{ text: 'first, and fine' }, task as Asked])
      return [...code(answer), answer.body.error?.message]
    }
    expect((await one({ text: 'x'.repeat(10_001) })).slice(0, 2)).toEqual([400, 'text_too_long'])
    expect(await one({ text: 'with traces', attachments: Array.from({ length: 11 }, (_, n) => `${'A'.repeat(21)}${String.fromCharCode(65 + n)}`) })).toEqual([400, 'invalid_request', 'tasks.1.attachments: a message carries at most 10'])
    expect(await one({ text: 'after them all', needs: Array.from({ length: 21 }, (_, n) => String(9000 + n)) })).toEqual([400, 'invalid_request', 'tasks.1.needs: a task waits for at most 20 tasks'])
    expect(await one({ key: 'k'.repeat(65), text: 'a long name' })).toEqual([400, 'invalid_request', "tasks.1.key: a task's key is at most 64 characters"])
    // Twenty needs, however often each is named, and a key of 64 are within them.
    expect((await one({ key: 'k'.repeat(64), text: 'a long name', needs: Array.from({ length: 40 }, (_, n) => String(9000 + (n % 20))) })).slice(0, 2)).toEqual([400, 'invalid_needs'])
    expect(await listed(ada)).toEqual([])
    const full = await batch(ada, many(100))
    expect(full.status).toBe(201)
    const roots = full.body.tasks as MessageView[]
    expect(roots.map((root) => root.text)).toEqual(many(100).map((task) => task.text))
    expect(roots.map((root, at) => root.task?.needs)).toEqual(roots.map((_, at) => (at === 0 ? [] : [roots[at - 1]!.id])))
    expect((await listed(ada)).map((root) => [root.id, root.task?.state])).toEqual(roots.map((root, at) => [root.id, at === 0 ? 'ready' : 'waiting']))
  })

  it('never reach the middleware when there are more than any board makes: no root of a batch that can not land is screened', async () => {
    let saw = 0
    const count: Middleware = async ({ next }) => void (saw++, await next())
    const { ada } = await setup({ middleware: [count] })
    expect(code(await batch(ada, Array.from({ length: 2000 }, (_, n) => ({ text: `step ${n}` }))))).toEqual([400, 'batch_too_large'])
    expect(saw).toBe(0)
    // One it takes is screened a root at a time.
    expect(code(await batch(ada, [{ text: 'fix the export' }, { text: 'review the fix' }]))).toEqual([201, undefined])
    expect(saw).toBe(2)
  })

  it('need `post` where they land and `label` when any of them has labels, and come back to a sender that can not read them as it sent them', async () => {
    const { board, ada } = await setup()
    await board.createGrant({ principals: [{ kind: 'github', repository: 'acme/web' }], can: { intake: ['post'], work: ['read', 'post'], audit: ['read'] } })
    const workflow = caller(board.fetch, await workflowToken())
    expect(code(await batch(workflow, [{ text: 'read-only here' }], { channel: 'audit' }))).toEqual([403, 'forbidden'])
    expect(code(await batch(workflow, [{ text: 'no access here' }], { channel: 'elsewhere' }))).toEqual([403, 'forbidden'])
    // One labeled task among them takes `label`, as a labeled post does.
    expect(code(await batch(workflow, [{ text: 'plain' }, { text: 'labeled', labels: { step: 'fix' } }]))).toEqual([403, 'forbidden'])
    expect((await listed(ada)).length).toBe(0)
    expect((await batch(workflow, [{ text: 'plain' }, { text: 'and plain' }])).status).toBe(201)
    // Where it posts without reading, it gets its tasks back as it made them, on the write and on a retry.
    const filed = await batch(workflow, [{ key: 'triage', text: 'triage the outage' }, { text: 'write it up', needs: [{ key: 'triage' }] }], { channel: 'intake', id: 'outage-1' })
    expect(filed.status).toBe(201)
    const [triage, writeUp] = filed.body.tasks as MessageView[]
    expect([triage!.text, triage!.task?.state, writeUp!.text, writeUp!.task]).toEqual(['triage the outage', 'ready', 'write it up', expect.objectContaining({ state: 'waiting', needs: [triage!.id], owner: CI })])
    expect(code(await workflow('GET', `/messages/${triage!.id}`))).toEqual([404, 'message_not_found'])
    await ada('POST', `/tasks/${triage!.id}/claim`, {})
    const refiled = await batch(workflow, [{ key: 'triage', text: 'triage the outage' }, { text: 'write it up', needs: [{ key: 'triage' }] }], { channel: 'intake', id: 'outage-1' })
    expect((refiled.body.tasks as MessageView[]).map((root) => [root.id, root.text, root.task?.state, root.task?.claim])).toEqual([
      [triage!.id, 'triage the outage', 'ready', null],
      [writeUp!.id, 'write it up', 'waiting', null],
    ])
  })

  it("have each root checked as a post's is: its blocks, its length, its labels, and its files", async () => {
    const { board, ada, bo } = await setup()
    const team = (user: string) => handleAs(board, user)
    const fine: Asked = { text: 'first, and fine' }
    const sha = 'a'.repeat(40)
    expect(code(await batch(ada, [fine, { text: `revert this\n\n${block('git-commit@1', { sha })}` }]))).toEqual([400, 'invalid_block'])
    expect(code(await batch(ada, [fine, { text: 'x'.repeat(10_001) }]))).toEqual([400, 'text_too_long'])
    expect(code(await batch(ada, [fine, { text: 'wears a state', labels: { 'board.task': 'completed' } }]))).toEqual([400, 'reserved_label'])
    // A file its sender may not have is no file, and one of its own rides on the root it names.
    const mine = await team('u_ada').upload({ data: new TextEncoder().encode('mine'), name: 'plan.txt', type: 'text/plain' })
    await board.createGrant({ principals: [{ kind: 'github', repository: 'acme/web' }], can: { work: ['read', 'post'] } })
    const workflow = caller(board.fetch, await workflowToken())
    expect(code(await batch(workflow, [fine, { text: 'with a file that is not its own', attachments: [mine.id] }]))).toEqual([404, 'attachment_not_found'])
    expect(await listed(ada)).toEqual([])
    const made = await team('u_ada').tasks.createMany('work', [
      { text: 'read the plan', attachments: [mine] },
      { text: '', attachments: [mine.id] },
      { text: `revert this\n\n${block('git-commit@1', { sha, title: 'ship the index' })}` },
    ])
    expect(made.map((root) => [root.text.split('\n')[0], root.attachments.map((file) => file.name), root.task?.state, root.blocks.map((found) => found.schema)])).toEqual([
      ['read the plan', ['plan.txt'], 'ready', []],
      ['', ['plan.txt'], 'ready', []],
      ['revert this', [], 'ready', ['git-commit']],
    ])
    expect((await bo('GET', `/messages/${made[0]!.id}`)).body.message.attachments).toMatchObject([{ id: mine.id, name: 'plan.txt' }])
  })

  it('go through the middleware a root at a time, before any is written: what it changes is what lands, and a root it drops makes none', async () => {
    const saw: unknown[] = []
    const screen: Middleware = async ({ write, respond, next }) => {
      saw.push(write.kind === 'post' ? [write.channel, write.re, write.text, write.labels] : write.kind)
      if (write.text.includes('password')) return void (await respond('no secrets on the board'))
      await next({ text: write.text.replace('ASAP', 'soon'), ...(write.text.includes('urgent') ? { labels: { priority: 'high' } } : {}) })
    }
    const { ada } = await setup({ middleware: [screen] })
    const dropped = await batch(ada, [{ text: 'rotate the key ASAP' }, { text: 'urgent: page the owner', labels: { step: 'page' } }, { text: 'the password is hunter2' }])
    expect(dropped).toEqual({ status: 422, body: { error: { code: 'dropped', message: 'no secrets on the board' } } })
    expect(saw).toEqual([
      ['work', null, 'rotate the key ASAP', {}],
      ['work', null, 'urgent: page the owner', { step: 'page' }],
      ['work', null, 'the password is hunter2', {}],
    ])
    expect(await listed(ada)).toEqual([])
    const made = await batch(ada, [{ key: 'rotate', text: 'rotate the key ASAP' }, { text: 'urgent: page the owner', labels: { step: 'page' }, needs: [{ key: 'rotate' }] }])
    expect(made.status).toBe(201)
    expect((made.body.tasks as MessageView[]).map((root) => [root.text, root.labels, root.task?.needs])).toEqual([
      ['rotate the key soon', { 'board.task': 'ready' }, []],
      ['urgent: page the owner', { step: 'page', priority: 'high', 'board.task': 'waiting' }, [made.body.tasks[0].id]],
    ])
    // What it makes of a root is checked as what was sent is: a label under board. is still the board's own, and a block still fits its schema.
    const stamp: Middleware = async ({ write, next }) =>
      next(write.text.includes('stamp') ? { labels: { 'board.task': 'completed' } } : { text: `${write.text}\n\n${block('git-commit@1', { sha: 'a'.repeat(40) })}` })
    const stamped = await setup({ middleware: [stamp] })
    expect(code(await batch(stamped.ada, [{ text: 'stamp me' }]))).toEqual([400, 'reserved_label'])
    expect(code(await batch(stamped.ada, [{ text: 'revert this' }]))).toEqual([400, 'invalid_block'])
    expect(await listed(stamped.ada)).toEqual([])
  })

  it('answer a retry through a board in front that screens them too: both boards know the request as the first was given it', async () => {
    const { board, ada } = await setup()
    const saw: string[] = []
    // A board of ada's in front of the one that keeps the log, with a middleware of its own.
    const loud: Middleware = async ({ write, next }) => void (saw.push(write.text), await next({ text: write.text.toUpperCase() }))
    const front = handleAs(board, 'u_ada', [loud])
    const plan = [{ text: 'one' }, { text: 'two' }]
    const first = await front.tasks.createMany('work', plan, { id: 'plan-1' })
    expect(first.map((root) => root.text)).toEqual(['ONE', 'TWO'])
    // The same request again: the board behind kept what the front one was given, not what it sent on, so it finds the batch.
    const again = await front.tasks.createMany('work', plan, { id: 'plan-1' })
    expect(again.map((root) => [root.id, root.text])).toEqual(first.map((root) => [root.id, root.text]))
    expect(saw).toEqual(['one', 'two'])
    // Another request under the id is refused as the front one was given it, though its middleware makes the same of both.
    await expect(front.tasks.createMany('work', [{ text: 'ONE' }, { text: 'two' }], { id: 'plan-1' })).rejects.toMatchObject({ status: 409, code: 'duplicate_id' })
    await expect(front.tasks.createMany('work', [{ text: 'one' }], { id: 'plan-1' })).rejects.toMatchObject({ status: 409, code: 'duplicate_id' })
    expect(saw).toHaveLength(2)
    // A middleware that is never the same twice: the batch landed, so its retry still gets its tasks, as they landed.
    const stamp: Middleware = async ({ write, next }) => void (saw.push(write.text), await next({ text: `${write.text} (${saw.length})` }))
    const stamping = handleAs(board, 'u_ada', [stamp])
    saw.length = 0
    const stamped = await stamping.tasks.createMany('work', plan, { id: 'plan-2' })
    expect(stamped.map((root) => root.text)).toEqual(['one (1)', 'two (2)'])
    expect((await stamping.tasks.createMany('work', plan, { id: 'plan-2' })).map((root) => [root.id, root.text])).toEqual(stamped.map((root) => [root.id, root.text]))
    expect(saw).toHaveLength(2)
    expect(await listed(ada)).toHaveLength(4)
    // A request that says its own digest changes only what its own id answers: the same one again is its batch.
    const own = await batch(ada, plan, { id: 'plan-3', request: 'my own word for it' })
    expect(own.status).toBe(201)
    expect((await batch(ada, [{ text: 'anything' }], { id: 'plan-3', request: 'my own word for it' })).body.tasks.map((root: MessageView) => root.id)).toEqual(own.body.tasks.map((root: MessageView) => root.id))
    expect(code(await batch(ada, plan, { id: 'plan-3' }))).toEqual([409, 'duplicate_id'])
    expect(await listed(ada)).toHaveLength(6)
  })

  it("are a handle's own by their id, which no request takes first, and are made once for a watcher that is run again", async () => {
    const { board, ada } = await setup()
    const plan = [{ key: 'build', text: 'build a1b2c3' }, { text: 'deploy a1b2c3', needs: [{ key: 'build' }] }]
    const hook = board.as('v0-hook')
    const first = await hook.tasks.createMany('work', plan, { id: 'delivery-1' })
    expect(first.map((root) => [root.text, root.task?.state, root.task?.owner])).toEqual([
      ['build a1b2c3', 'ready', 'board:client:v0-hook'],
      ['deploy a1b2c3', 'waiting', 'board:client:v0-hook'],
    ])
    expect((await board.as('v0-hook').tasks.createMany('work', plan, { id: 'delivery-1' })).map((root) => root.id)).toEqual(first.map((root) => root.id))
    // A request that makes a batch with the same id first hasn't taken the hook's.
    expect((await batch(ada, plan, { id: 'delivery-2' })).status).toBe(201)
    const second = await hook.tasks.createMany('work', plan, { id: 'delivery-2' })
    expect(second.map((root) => root.task?.owner)).toEqual(['board:client:v0-hook', 'board:client:v0-hook'])
    expect(await listed(ada)).toHaveLength(6)

    // A watcher's batch gets an id from what triggered it, so a run that's tried again makes it once.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let runs = 0
    const intake: Watcher = {
      tail: 'intake',
      run: async ({ event, board: own }) => {
        if (event.type !== 'message.posted' || event.message?.re !== null) return
        await own.tasks.createMany('triage', [{ key: 'look', text: `look into: ${event.message.text}` }, { text: 'write it up', needs: [{ key: 'look' }] }])
        // Killed after its write, as a function that timed out is: the board runs it again.
        if (++runs === 1) throw new Error('timed out after it wrote')
      },
    }
    // No scheduler, so nothing retries on its own: each drain is the next try.
    const watched = testBoard({ watch: { intake } })
    const person = caller(watched.fetch, await personToken('u_ada'))
    await person('POST', '/messages', { channel: 'intake', text: 'export times out past 10k rows' })
    const watches = watched.servers.at(-1)!
    await vi.waitFor(async () => {
      await watched.skipHold(watches, 'watch:intake')
      await watches.drain('watch:intake')
      expect(runs).toBe(2)
    })
    expect((await listed(person, 'channel=triage&state=all')).map((root) => [root.text, root.task?.state, root.task?.owner])).toEqual([
      ['look into: export times out past 10k rows', 'ready', 'board:watch:intake'],
      ['write it up', 'waiting', 'board:watch:intake'],
    ])
    error.mockRestore()
  })
})
